# -*- coding: utf-8 -*-
"""
The hybrid recommendation engine (Section 4.8 of the proposal).

    blend(u, s) = alpha * content(u, s) + (1 - alpha) * collaborative(u, s)
    score(u, s) = (1 - gamma - delta) * blend(u, s)
                  + gamma * location(u, s) + delta * quality(s)

gamma and delta default to 0 (the original two-part hybrid). They are chosen
on a validation split cut from the training period (tune_ranking), never on
the test interactions. location() is exp(-d / scale) for the distance d in km
between the parent's area centre and the nearest area the provider serves.

Content is cosine similarity between a user preference vector and the encoded
service catalogue; collaborative is k-Nearest Neighbors over the user-item
matrix. Both are normalised to [0, 1] before blending, because cosine similarity
and summed neighbour weights live on different scales (Section 4.8.3).

The preference vector (Section 4.8.1) aggregates everything the user has told
us: the services they viewed, clicked, saved and rated (weighted by action),
the queries they searched for, and the categories they declared on their
account page. A live search query outweighs the stored profile.

Cold-start rules, in the order they apply (Table 4.3, alternative flow):
  * no usable collaborative signal       -> alpha forced to 1.0 (content only)
  * no content signal, or no service
    above the similarity threshold       -> popular and highly rated services
                                            within the selected category
While collaborative is unavailable, a small share of the list is reserved for
highly rated services from related categories, so content-based results do
not collapse onto what the user has already seen (Section 4.8.3).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field, asdict

import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.neighbors import NearestNeighbors

from encoders import ContentEncoder, build_encoder

log = logging.getLogger(__name__)

# How strongly each interaction type pulls the preference vector (Section 4.8.1)
INTERACTION_WEIGHTS = {"view": 1.0, "click": 2.0, "save": 3.5, "rating": 4.0}


@dataclass
class EngineConfig:
    k: int = 20                    # neighbourhood size
    alpha: float = 1.0             # weight on the content component (1 at launch)
    alpha_mode: str = "auto"       # auto: schedule/review alpha | fixed: use as given
    alpha_floor: float = 0.3       # lowest alpha the density schedule will reach
    density_target: float = 10.0   # matrix density (%) at which the schedule bottoms out
    alpha_source: str = "launch default"
    min_interactions: int = 3      # below this a user has no collaborative signal
    query_weight: float = 0.75     # a live query vs the stored profile
    search_weight: float = 1.0     # one past search, relative to one view
    preference_weight: float = 2.0  # one declared category, relative to one view
    max_searches: int = 20         # most recent searches that feed the profile
    min_similarity: float | None = None  # below this nothing "matches" (Table 4.3);
                                         # None: the encoder's own default
    diversity_share: float = 0.2   # share of the list reserved while content-only
    location_weight: float = 0.0   # gamma: distance from the parent's area
    quality_weight: float = 0.0    # delta: popularity + smoothed rating
    location_scale_km: float = 5.0  # distance at which location() falls to 1/e
    mmr_lambda: float | None = None  # diversity re-ranking; None/1.0 = off
    # With a search query, a provider must reach this share of the best
    # content match in the whole catalogue to be shown at all, so a hard area
    # filter cannot fill the list with unrelated services. 0.85 is the best
    # dev-split value on the labelled search benchmark (research/, finding S4
    # in docs/research/FINDINGS.md): it lifts list precision from 0.49 to 0.77
    # at a cost in recall. 0 switches it off; None uses the encoder's own
    # default (0.85 for sentence embeddings, off for TF-IDF).
    query_relevance_ratio: float | None = None
    ranking_source: str = "default (location and quality off)"
    top_n: int = 10
    encoder: str = "auto"
    trained_at: str = ""
    encoder_name: str = ""
    n_users: int = 0
    n_providers: int = 0
    n_interactions: int = 0
    density_pct: float = 0.0
    extra: dict = field(default_factory=dict)

    def to_dict(self):
        return asdict(self)


def alpha_schedule(density_pct: float, n_users: int, cfg: EngineConfig) -> float:
    """Section 2.5.3: alpha starts at 1 and falls as the user-item matrix fills.
    Linear in density until `density_target`, never below `alpha_floor`."""
    if n_users < 3 or density_pct <= 0:
        return 1.0
    maturity = min(1.0, density_pct / max(cfg.density_target, 1e-9))
    return round(1.0 - (1.0 - cfg.alpha_floor) * maturity, 2)


def _minmax(v: np.ndarray) -> np.ndarray:
    lo, hi = float(np.min(v)), float(np.max(v))
    return np.zeros_like(v, dtype=float) if hi - lo == 0 else (v - lo) / (hi - lo)


def haversine_km(a, b) -> float:
    """Great-circle distance between (lat, lng) pairs, in km."""
    lat1, lng1, lat2, lng2 = map(np.radians, (a[0], a[1], b[0], b[1]))
    h = np.sin((lat2 - lat1) / 2) ** 2 +         np.cos(lat1) * np.cos(lat2) * np.sin((lng2 - lng1) / 2) ** 2
    return float(2 * 6371.0 * np.arcsin(np.sqrt(h)))


def _unit(v: np.ndarray | None) -> np.ndarray | None:
    if v is None:
        return None
    n = float(np.linalg.norm(v))
    return v / n if n else None


class HybridRecommender:
    def __init__(self, config: EngineConfig | None = None,
                 encoder: ContentEncoder | None = None):
        self.cfg = config or EngineConfig()
        self.encoder = encoder
        self.fitted = False

    # ------------------------------------------------------------------ fit
    def fit(self, providers: pd.DataFrame, interactions: pd.DataFrame,
            categories: pd.DataFrame | None = None,
            searches: pd.DataFrame | None = None,
            preferences: pd.DataFrame | None = None,
            areas: pd.DataFrame | None = None,
            provider_areas: pd.DataFrame | None = None,
            users: pd.DataFrame | None = None) -> "HybridRecommender":
        """
        providers    : provider_id, provider_name, category_id, service_description,
                       service_tags, location, verification_status
        interactions : user_id, provider_id, interaction_type, interaction_weight
                       [, rating_value]
        searches     : user_id, query_text [, searched_at]          (optional)
        preferences  : user_id, category_id                         (optional)
        areas        : area_name, latitude, longitude               (optional)
        provider_areas: provider_id, area_name - areas each serves  (optional)
        users        : user_id, location - the parent's home area   (optional)
        Only VERIFIED providers become recommendable (Table 4.4).
        """
        t0 = time.time()

        self.providers = providers[
            providers.verification_status == "verified"
        ].reset_index(drop=True).copy()
        if self.providers.empty:
            raise ValueError("no verified providers to recommend")
        self.providers["category_id"] = self.providers.category_id.astype(int)

        self.provider_ids = [int(p) for p in self.providers.provider_id]
        self.p_index = {p: i for i, p in enumerate(self.provider_ids)}
        self.n_items = len(self.provider_ids)
        self.item_cats = self.providers.category_id.to_numpy()

        self._index_categories(categories)
        self._fit_areas(areas, provider_areas, users)

        # ---- content side ------------------------------------------------
        text = (
            self.providers.category_id.map(self.cat_name).fillna("").astype(str) + ". " +
            self.providers.provider_name.fillna("").astype(str) + ". " +
            self.providers.service_description.fillna("").astype(str) + " " +
            self.providers.service_tags.fillna("").astype(str)
            .str.replace("-", " ").str.replace(",", " ") + " " +
            self.providers.location.fillna("").astype(str)
        ).str.strip().tolist()
        self.content_text = text

        if self.encoder is None:
            self.encoder = build_encoder(self.cfg.encoder)
        self.encoder.fit(text)
        self.item_vectors = self.encoder.encode(text)          # (n_items, dim) L2
        self.dim = self.item_vectors.shape[1]

        # One centroid per category, so a declared preference can join the
        # preference vector in the same space as everything else.
        self.cat_centroids = {}
        for c in np.unique(self.item_cats):
            v = _unit(self.item_vectors[self.item_cats == c].mean(axis=0))
            if v is not None:
                self.cat_centroids[int(c)] = v

        # ---- collaborative side ------------------------------------------
        if interactions is None or not len(interactions):
            # Launch day: no behaviour recorded yet (Section 1.8).
            inter = pd.DataFrame({c: pd.Series(dtype=t) for c, t in (
                ("user_id", int), ("provider_id", int), ("interaction_type", object),
                ("interaction_weight", float), ("rating_value", float))})
        else:
            inter = interactions.copy()
            inter["provider_id"] = inter.provider_id.astype(int)
            inter["user_id"] = inter.user_id.astype(int)
        inter = inter[inter.provider_id.isin(self.p_index)].copy()
        if "interaction_weight" not in inter.columns:
            inter["interaction_weight"] = inter.interaction_type.map(
                INTERACTION_WEIGHTS).fillna(1.0)
        inter["interaction_weight"] = inter.interaction_weight.astype(float)
        if "rating_value" in inter.columns:
            inter["rating_value"] = pd.to_numeric(inter.rating_value, errors="coerce")

        self.user_ids = sorted(int(u) for u in inter.user_id.unique())
        self.u_index = {u: i for i, u in enumerate(self.user_ids)}
        self.n_users = len(self.user_ids)

        if self.n_users:
            rows = inter.user_id.map(self.u_index).to_numpy()
            cols = inter.provider_id.map(self.p_index).to_numpy()
            vals = inter.interaction_weight.to_numpy()
            self.user_item = sparse.csr_matrix(
                (vals, (rows, cols)), shape=(self.n_users, self.n_items))
            self.user_item.sum_duplicates()
        else:
            self.user_item = sparse.csr_matrix((0, self.n_items))

        self.interaction_counts = inter.groupby("user_id").size().to_dict()
        self.seen = inter.groupby("user_id").provider_id.apply(set).to_dict() \
            if len(inter) else {}
        self.popularity = np.asarray(self.user_item.sum(axis=0)).ravel() \
            if self.n_users else np.zeros(self.n_items)
        self._fit_quality(inter)

        # neighbourhood model
        self.knn = None
        if self.n_users > 2:
            k = min(self.cfg.k + 1, self.n_users)
            self.knn = NearestNeighbors(n_neighbors=k, metric="cosine",
                                        algorithm="brute").fit(self.user_item)

        # ---- stored preference vectors (searches + declared preferences) --
        self.user_queries = self._group_searches(searches)
        self.user_prefs = self._group_preferences(preferences)
        self._fit_profiles()

        self.cfg.encoder_name = self.encoder.name
        self.cfg.n_users = self.n_users
        self.cfg.n_providers = self.n_items
        self.cfg.n_interactions = int(len(inter))
        self.cfg.density_pct = round(
            100 * self.user_item.nnz / max(1, self.n_users * self.n_items), 2)
        self.cfg.trained_at = time.strftime("%Y-%m-%d %H:%M:%S")
        self.cfg.extra["min_similarity_used"] = self.min_similarity
        self.fitted = True

        log.info("fitted in %.1fs: %d providers, %d users, %d interactions, "
                 "density %.2f%%, encoder %s", time.time() - t0, self.n_items,
                 self.n_users, len(inter), self.cfg.density_pct, self.encoder.name)
        return self

    def _index_categories(self, categories):
        self.cat_name, self.cat_parent = {}, {}
        if categories is not None and len(categories):
            for row in categories.itertuples(index=False):
                cid = int(row.category_id)
                self.cat_name[cid] = row.category_name
                parent = getattr(row, "parent_category_id", None)
                self.cat_parent[cid] = None if parent is None or pd.isna(parent) \
                    else int(parent)
        self.cat_children = {}
        for cid, parent in self.cat_parent.items():
            if parent is not None:
                self.cat_children.setdefault(parent, set()).add(cid)

    def _fit_areas(self, areas, provider_areas, users):
        """Area centres, the areas each provider serves (always including its
        own location) and each parent's home area, all keyed lower-case."""
        self.area_coords = {}
        if areas is not None and len(areas):
            for r in areas.itertuples(index=False):
                lat, lng = getattr(r, "latitude", None), getattr(r, "longitude", None)
                if lat is not None and lng is not None and not pd.isna(lat) and not pd.isna(lng):
                    self.area_coords[str(r.area_name).strip().lower()] = (float(lat), float(lng))
        served = {p: set() for p in self.provider_ids}
        for pid, loc in zip(self.providers.provider_id, self.providers.location):
            if isinstance(loc, str) and loc.strip():
                served[int(pid)].add(loc.strip().lower())
        if provider_areas is not None and len(provider_areas):
            for r in provider_areas.itertuples(index=False):
                if int(r.provider_id) in served and isinstance(r.area_name, str):
                    served[int(r.provider_id)].add(r.area_name.strip().lower())
        self.item_areas = [served[p] for p in self.provider_ids]
        self.user_home = {}
        if users is not None and len(users) and "location" in users:
            for uid, loc in zip(users.user_id, users.location):
                if isinstance(loc, str) and loc.strip():
                    self.user_home[int(uid)] = loc.strip().lower()
        self._loc_cache = {}

    def _location_scores(self, area):
        """(scores, distances_km) for a reference area, or (None, None) when the
        area is unknown. A provider serving the area itself is at distance 0;
        one with no area centre known is treated as not nearby."""
        if not area:
            return None, None
        key = str(area).strip().lower()
        if key in self._loc_cache:
            return self._loc_cache[key]
        origin = self.area_coords.get(key)
        known = origin is not None or any(key in a for a in self.item_areas)
        if not known:
            self._loc_cache[key] = (None, None)
            return None, None
        dist = np.full(self.n_items, np.nan)
        for i, served in enumerate(self.item_areas):
            if key in served:
                dist[i] = 0.0
            elif origin is not None:
                ds = [haversine_km(origin, self.area_coords[a]) for a in served if a in self.area_coords]
                if ds:
                    dist[i] = min(ds)
        scale = max(self.cfg.location_scale_km, 1e-6)
        scores = np.where(np.isnan(dist), 0.0, np.exp(-np.nan_to_num(dist, nan=0.0) / scale))
        self._loc_cache[key] = (scores, dist)
        return scores, dist

    def _fit_quality(self, inter: pd.DataFrame):
        """'Popular and highly rated' (Table 4.3): half popularity, half a
        Bayesian-smoothed mean rating, so one 5-star review cannot top the list."""
        mean = np.zeros(self.n_items)
        count = np.zeros(self.n_items)
        if len(inter) and "rating_value" in inter.columns:
            rated = inter.dropna(subset=["rating_value"])
            if len(rated):
                g = rated.groupby("provider_id").rating_value.agg(["mean", "count"])
                for pid, r in g.iterrows():
                    i = self.p_index[int(pid)]
                    mean[i], count[i] = float(r["mean"]), float(r["count"])
        m = 3.0
        overall = float((mean * count).sum() / count.sum()) if count.sum() else 3.0
        bayes = (mean * count + overall * m) / (count + m)
        self.rating_mean = np.round(mean, 2)
        self.rating_count = count.astype(int)
        self.quality = 0.5 * _minmax(np.log1p(self.popularity)) + \
            0.5 * np.clip((bayes - 1.0) / 4.0, 0.0, 1.0)

    @staticmethod
    def _group_searches(searches):
        if searches is None or not len(searches) or "query_text" not in searches:
            return {}
        s = searches.dropna(subset=["query_text"])
        s = s[s.query_text.astype(str).str.strip() != ""]
        if "searched_at" in s.columns:
            s = s.sort_values("searched_at")
        return s.groupby(s.user_id.astype(int)).query_text \
            .apply(lambda q: [str(x) for x in q]).to_dict()

    @staticmethod
    def _group_preferences(preferences):
        if preferences is None or not len(preferences):
            return {}
        p = preferences.dropna(subset=["category_id"])
        return p.groupby(p.user_id.astype(int)).category_id \
            .apply(lambda c: [int(x) for x in c]).to_dict()

    def _fit_profiles(self):
        users = sorted(set(self.u_index) | set(self.user_queries) | set(self.user_prefs))
        self.profile_index = {u: i for i, u in enumerate(users)}
        self.user_profiles = np.zeros((len(users), self.dim), dtype=np.float32)
        # Encode every distinct past query once, not once per user.
        recent = {u: q[-self.cfg.max_searches:] for u, q in self.user_queries.items()}
        distinct = sorted({q for qs in recent.values() for q in qs})
        qvec = dict(zip(distinct, self.encoder.encode_queries(distinct))) if distinct else {}
        for u, row in self.profile_index.items():
            weights = self.user_item[self.u_index[u]].toarray().ravel() \
                if u in self.u_index else None
            v = self._build_profile(weights, [qvec[q] for q in recent.get(u, [])],
                                    self.user_prefs.get(u, []))
            if v is not None:
                self.user_profiles[row] = v

    def _build_profile(self, item_weights, query_vecs, pref_cats):
        """Weighted sum of interacted items, past searches and declared
        categories, normalised to unit length."""
        acc = np.zeros(self.dim, dtype=np.float64)
        if item_weights is not None and np.any(item_weights):
            acc += item_weights @ self.item_vectors
        for qv in query_vecs:
            acc += self.cfg.search_weight * qv
        for c in pref_cats:
            for cid in self._expand_category(c):
                if cid in self.cat_centroids:
                    acc += self.cfg.preference_weight * self.cat_centroids[cid]
        return _unit(acc)

    @property
    def min_similarity(self) -> float:
        if self.cfg.min_similarity is not None:
            return float(self.cfg.min_similarity)
        return float(getattr(self.encoder, "default_min_similarity", 0.10))

    @property
    def relevance_ratio(self) -> float:
        if self.cfg.query_relevance_ratio is not None:
            return float(self.cfg.query_relevance_ratio)
        return float(getattr(self.encoder, "default_relevance_ratio", 0.0))

    def _expand_category(self, category_id) -> set:
        """A parent category ("service type") stands for all its children."""
        cid = int(category_id)
        return {cid} | self.cat_children.get(cid, set())

    # ------------------------------------------------------- live history
    def _history_weights(self, history) -> np.ndarray:
        w = np.zeros(self.n_items)
        for pid, weight in history.get("interactions", ()):
            i = self.p_index.get(int(pid))
            if i is not None:
                w[i] += float(weight)
        return w

    def _profile_for(self, user_id, history):
        if history is not None:
            weights = self._history_weights(history)
            queries = list(history.get("queries", ()))[-self.cfg.max_searches:]
            qvecs = list(self.encoder.encode_queries(queries)) if queries else []
            return self._build_profile(weights, qvecs,
                                       history.get("preferred_categories", ()))
        if user_id is not None and user_id in self.profile_index:
            row = self.user_profiles[self.profile_index[user_id]]
            return row if np.any(row) else None
        return None

    # ------------------------------------------------- component scores
    def _content_scores(self, user_id=None, query=None, history=None):
        profile = self._profile_for(user_id, history)
        if query:
            qv = self.encoder.encode_one(query)
            if profile is None:
                profile = qv
            else:
                w = self.cfg.query_weight
                profile = _unit(w * qv + (1 - w) * profile)
        if profile is None:
            return np.zeros(self.n_items), False
        return self.item_vectors @ profile, True

    def _collaborative_scores(self, user_id=None, history=None):
        if self.knn is None:
            return np.zeros(self.n_items), False
        if history is not None:
            n_rows = len(history.get("interactions", ()))
            row = sparse.csr_matrix(self._history_weights(history))
        elif user_id is not None and user_id in self.u_index:
            n_rows = self.interaction_counts.get(user_id, 0)
            row = self.user_item[self.u_index[user_id]]
        else:
            return np.zeros(self.n_items), False
        if n_rows < self.cfg.min_interactions or row.nnz == 0:
            return np.zeros(self.n_items), False

        self_row = self.u_index.get(user_id)
        n_neighbors = min(self.cfg.k + (1 if self_row is not None else 0), self.n_users)
        dist, idx = self.knn.kneighbors(row, n_neighbors=n_neighbors)
        acc = np.zeros(self.n_items)
        used = 0
        for d, j in zip(dist.ravel(), idx.ravel()):
            s = 1.0 - d
            if j == self_row or s <= 0:
                continue                       # never recommend from yourself
            acc += s * self.user_item[j].toarray().ravel()
            used += 1
            if used >= self.cfg.k:
                break
        return acc, bool(np.any(acc))

    # ------------------------------------------------------------ recommend
    def recommend(self, user_id=None, query=None, top_n=None, alpha=None,
                  category_id=None, location=None, exclude_seen=True,
                  exclude_ids=None, history=None, area=None, overrides=None):
        """
        history  : live signals for this user, read at request time (Figure 4.3,
                   step 7) - {"interactions": [(provider_id, weight), ...],
                   "queries": [...], "preferred_categories": [...]}. Without it
                   the engine uses what it saw at fit time.
        location : HARD filter - only providers serving this area.
        area     : SOFT ranking feature - the area distance is measured from.
                   Defaults to `location`, then to the user's home area.
        overrides: {"location_weight", "quality_weight", "mmr_lambda",
                   "diversity_share"} for evaluation, tuning and search (which
                   wants matches only), without touching the config.
        """
        if not self.fitted:
            raise RuntimeError("engine is not fitted")
        top_n = top_n or self.cfg.top_n
        ov = overrides or {}
        g_w = float(ov.get("location_weight", self.cfg.location_weight))
        q_w = float(ov.get("quality_weight", self.cfg.quality_weight))
        mmr = ov.get("mmr_lambda", self.cfg.mmr_lambda)
        share = float(ov.get("diversity_share", self.cfg.diversity_share))

        cs, has_content = self._content_scores(user_id, query, history)
        fs, has_collab = self._collaborative_scores(user_id, history)
        used_profile = self._profile_for(user_id, history) is not None

        # ---- which services may appear at all
        mask = np.zeros(self.n_items, dtype=bool)
        if exclude_seen:
            seen = {int(p) for p, _ in history.get("interactions", ())} \
                if history is not None else self.seen.get(user_id, ())
            for pid in seen:
                if pid in self.p_index:
                    mask[self.p_index[pid]] = True
        for pid in (exclude_ids or ()):
            if int(pid) in self.p_index:
                mask[self.p_index[int(pid)]] = True
        if category_id is not None:
            mask |= ~np.isin(self.item_cats, list(self._expand_category(category_id)))
        # A search states what is wanted: no MATCH far below the best one
        # anywhere in the catalogue may appear, however it scores otherwise.
        # (The related-category slot below is exempt; it is labelled as such.)
        hard = mask.copy()
        ratio = self.relevance_ratio
        if query and has_content and ratio > 0:
            mask |= cs < ratio * float(cs.max())
        if location:
            key = str(location).strip().lower()
            mask |= np.array([key not in a for a in self.item_areas])
        valid = ~mask
        valid_hard = ~hard

        # Table 4.3: if no candidate clears the similarity threshold the content
        # signal is not a match at all, and must not rank anything.
        if has_content and not has_collab and valid.any() \
                and float(cs[valid].max()) < self.min_similarity:
            has_content = False

        a = self.cfg.alpha if alpha is None else float(alpha)
        if not has_collab:
            a = 1.0
        if not has_content:
            a = 0.0

        ref_area = area or location or (self.user_home.get(user_id) if user_id is not None else None)
        loc, dist = self._location_scores(ref_area)
        if loc is None:
            g_w = 0.0
            loc = np.zeros(self.n_items)

        cs_n, fs_n = _minmax(cs), _minmax(fs)
        strategy = "hybrid"
        if not has_content and not has_collab:
            # Popular and highly rated, nudged towards the parent's area if known.
            base, strategy = self.quality.copy(), "popularity_fallback"
            score = (1 - g_w) * base + g_w * loc
        else:
            if a >= 1.0:
                strategy = "content_only"
            elif a <= 0.0:
                strategy = "collaborative_only"
            base = a * cs_n + (1 - a) * fs_n
            score = (1 - g_w - q_w) * base + g_w * loc + q_w * self.quality

        score = score.astype(float).copy()
        score[mask] = -np.inf
        order = [int(i) for i in np.argsort(-score, kind="stable") if np.isfinite(score[i])]
        if mmr is not None and float(mmr) < 1.0:
            order = self._mmr(order, score, top_n, float(mmr))

        reserved = set()
        if strategy == "content_only" and category_id is None:
            order, reserved = self._reserve_related(order, top_n, valid_hard, share)

        prefs = set(history.get("preferred_categories", ())) if history is not None \
            else set(self.user_prefs.get(user_id, ()))
        pref_cats = set().union(*(self._expand_category(c) for c in prefs)) if prefs else set()
        ctx = dict(query=query, strategy=strategy, has_collab=has_collab, used_profile=used_profile,
                   pref_cats=pref_cats, area=ref_area, explicit_area=bool(area or location))

        results = []
        for rank, i in enumerate(order[:top_n], start=1):
            row = self.providers.iloc[i]
            d = None if dist is None or np.isnan(dist[i]) else round(float(dist[i]), 1)
            basis = ("related_highly_rated" if i in reserved
                     else "popular" if strategy == "popularity_fallback" else "match")
            final = round(float(np.clip(score[i], 0.0, 1.0)), 4)
            results.append(dict(
                rank_position=rank,
                provider_id=int(row.provider_id),
                provider_name=row.provider_name,
                category_id=int(row.category_id),
                category_name=self.cat_name.get(int(row.category_id), ""),
                location=row.location,
                content_score=round(float(cs_n[i]), 4),
                collaborative_score=round(float(fs_n[i]), 4),
                hybrid_score=final,
                scores=dict(content=round(float(cs_n[i]), 4),
                            collaborative=round(float(fs_n[i]), 4),
                            location=round(float(loc[i]), 4) if ref_area else None,
                            quality=round(float(self.quality[i]), 4),
                            final=final),
                distance_km=d,
                avg_rating=float(self.rating_mean[i]) if self.rating_count[i] else None,
                rating_count=int(self.rating_count[i]),
                basis=basis,
                reasons=self._reasons(i, cs_n[i], fs_n[i], d, basis, ctx),
            ))
        # How well the query itself matches the best listing anywhere (raw
        # cosine). Search labels a weak best match instead of hiding it: no
        # single cut-off separates real questions from out-of-scope ones
        # (docs/research/FINDINGS.md, S5).
        q_sim = round(float((self.item_vectors @ self.encoder.encode_one(query)).max()), 4)             if query else None
        return dict(user_id=user_id, query=query, strategy=strategy,
                    query_similarity=q_sim,
                    alpha_used=round(float(a), 2),
                    weights=dict(location=round(g_w, 3), quality=round(q_w, 3),
                                 mmr_lambda=None if mmr is None else float(mmr)),
                    area=ref_area, count=len(results), results=results)

    # Thresholds on the min-max scaled scores above which a component is
    # strong enough to be named as a reason.
    STRONG = 0.6

    def _reasons(self, i, content, collab, dist, basis, ctx):
        """Why this provider is in the list, from the actual score components
        and the provider record. Never a reason the data does not support."""
        out = []
        cat = int(self.item_cats[i])
        if basis == "related_highly_rated":
            out.append(("related_highly_rated", "Highly rated in a related category"))
        elif basis == "popular":
            out.append(("popular", "Popular and well rated with parents"))
        if ctx["query"] and content >= self.STRONG and basis == "match":
            out.append(("matches_search", "Matches your search"))
        elif not ctx["query"] and ctx["used_profile"] and content >= self.STRONG and basis == "match":
            out.append(("matches_activity", "Similar to services you looked at or saved"))
        if cat in ctx["pref_cats"]:
            out.append(("matches_preferences", "In a category you chose"))
        if ctx["has_collab"] and collab >= self.STRONG:
            out.append(("similar_parents", "Parents with similar activity used this service"))
        if ctx["area"] is not None and dist is not None:
            name = str(ctx["area"]).title() if ctx["area"].islower() else ctx["area"]
            if dist == 0:
                out.append(("serves_area", f"Serves {name}"))
            elif dist <= 10:
                out.append(("nearby", f"About {dist:.0f} km from {name} (area centres)"))
        if self.rating_count[i] >= 3 and self.rating_mean[i] >= 4.0:
            out.append(("well_rated",
                        f"Rated {self.rating_mean[i]:.1f} from {int(self.rating_count[i])} ratings"))
        return [dict(code=c, text=t) for c, t in out]

    def _mmr(self, order, score, top_n, lam):
        """Maximal Marginal Relevance over the leading candidates: each pick
        trades its score against its similarity to what is already chosen.
        lam = 1 is the plain ranking; lower values favour variety."""
        pool = order[: max(top_n * 4, top_n)]
        if len(pool) <= 1:
            return order
        rel = _minmax(np.array([score[i] for i in pool]))
        vecs = self.item_vectors[pool]
        sims = vecs @ vecs.T
        chosen, left = [0], list(range(1, len(pool)))
        while left and len(chosen) < top_n:
            best = max(left, key=lambda j: lam * rel[j] - (1 - lam) * max(sims[j, c] for c in chosen))
            chosen.append(best)
            left.remove(best)
        picked = [pool[j] for j in chosen]
        rest = [i for i in order if i not in set(picked)]
        return picked + rest

    def _reserve_related(self, order, top_n, valid, share=None):
        """Section 4.8.3: until the collaborative component is available, keep
        a small share of the list for highly rated services in categories
        related to (same parent as) the top matches, but not the same ones."""
        share = self.cfg.diversity_share if share is None else share
        n_reserve = int(round(top_n * share))
        if n_reserve <= 0 or top_n < 3 or len(order) <= top_n - n_reserve:
            return order, set()
        head = order[: top_n - n_reserve]
        head_cats = {int(self.item_cats[i]) for i in head}
        parents = {self.cat_parent.get(c) for c in head_cats} - {None}
        related = {c for p in parents for c in self.cat_children.get(p, ())} - head_cats
        if not related:
            return order, set()
        head_set = set(head)
        pool = [i for i in np.argsort(-self.quality, kind="stable")
                if valid[i] and i not in head_set and int(self.item_cats[i]) in related]
        picks = [int(i) for i in pool[:n_reserve]]
        if not picks:
            return order, set()
        chosen = head_set | set(picks)
        return head + picks + [i for i in order if i not in chosen], set(picks)

    # -------------------------------------------------------------- similar
    def similar_providers(self, provider_id, top_n=5):
        if provider_id not in self.p_index:
            return []
        i = self.p_index[provider_id]
        sims = self.item_vectors @ self.item_vectors[i]
        sims[i] = -np.inf
        out = []
        for rank, j in enumerate(np.argsort(-sims)[:top_n], start=1):
            row = self.providers.iloc[j]
            out.append(dict(rank_position=rank, provider_id=int(row.provider_id),
                            provider_name=row.provider_name,
                            category_id=int(row.category_id),
                            category_name=self.cat_name.get(int(row.category_id), ""),
                            location=row.location,
                            similarity=round(float(sims[j]), 4)))
        return out

    # ------------------------------------------------------------- evaluate
    def evaluate(self, test: pd.DataFrame, top_n=10, alpha=None, only_items=None,
                 overrides=None, per_user=False, ranker=None, space=None):
        """Offline ranking metrics at top_n on held-out interactions.

        precision, recall, f1, hit_rate, ndcg, mrr: averaged over users with a
        held-out provider. coverage: share of the catalogue recommended to
        anyone. diversity: mean intra-list dissimilarity (1 - cosine between
        the recommended services' content vectors). categories: mean number of
        distinct categories in a list. per_user=True also returns each user's
        values, for paired comparisons between systems.

        ranker(user_id, top_n) -> [provider_id, ...] scores an outside system
        (a popularity or random baseline) with exactly the same code.
        space: another fitted engine whose content vectors measure diversity,
        so engines with different encoders are compared in one space.
        """
        space = space or self
        truth = test[test.provider_id.isin(self.p_index)]             .groupby("user_id").provider_id.apply(set).to_dict()
        ps, rs, hits, ndcgs, rrs, ilds, cats, users = [], [], [], [], [], [], [], []
        shown = set()
        for uid, relevant in truth.items():
            if uid not in self.u_index:
                continue
            target = relevant & only_items if only_items is not None else relevant
            if not target:
                continue
            if ranker is not None:
                ranked = [int(p) for p in ranker(uid, top_n)][:top_n]
            else:
                res = self.recommend(user_id=uid, top_n=top_n, alpha=alpha, overrides=overrides)
                ranked = [r["provider_id"] for r in res["results"]]
            shown.update(ranked)
            rel = [1.0 if p in target else 0.0 for p in ranked]
            hit = sum(rel)
            ps.append(hit / top_n)
            rs.append(hit / len(target))
            hits.append(1.0 if hit else 0.0)
            dcg = sum(r / np.log2(k + 2) for k, r in enumerate(rel))
            idcg = sum(1 / np.log2(k + 2) for k in range(min(len(target), top_n)))
            ndcgs.append(dcg / idcg if idcg else 0.0)
            rrs.append(next((1.0 / (k + 1) for k, r in enumerate(rel) if r), 0.0))
            if len(ranked) > 1:
                v = space.item_vectors[[space.p_index[p] for p in ranked]]
                sim = v @ v.T
                n = len(ranked)
                ilds.append(float(1 - (sim.sum() - np.trace(sim)) / (n * (n - 1))))
            if ranked:
                cats.append(len({int(self.item_cats[self.p_index[p]]) for p in ranked}))
            users.append(uid)
        if not ps:
            return dict(precision=0.0, recall=0.0, f1=0.0, hit_rate=0.0, ndcg=0.0, mrr=0.0,
                        coverage=0.0, diversity=0.0, categories=0.0, users=0)
        p, r = float(np.mean(ps)), float(np.mean(rs))
        out = dict(precision=round(p, 4), recall=round(r, 4),
                   f1=round(0.0 if p + r == 0 else 2 * p * r / (p + r), 4),
                   hit_rate=round(float(np.mean(hits)), 4),
                   ndcg=round(float(np.mean(ndcgs)), 4), mrr=round(float(np.mean(rrs)), 4),
                   coverage=round(len(shown) / max(1, self.n_items), 4),
                   diversity=round(float(np.mean(ilds)), 4) if ilds else 0.0,
                   categories=round(float(np.mean(cats)), 2) if cats else 0.0,
                   users=len(ps))
        if per_user:
            out["per_user"] = dict(user_id=users, recall=rs, ndcg=ndcgs, precision=ps,
                                   mrr=rrs, hit_rate=hits)
        return out

    def tune_ranking(self, validation: pd.DataFrame, top_n=10,
                     location_values=(0.0, 0.05, 0.1, 0.2, 0.3),
                     quality_values=(0.0, 0.05, 0.1, 0.2)):
        """Chooses gamma (location) then delta (quality) by validation recall@N,
        holding alpha fixed. Ties go to the smaller weight: a feature has to
        earn its place. Pass a VALIDATION split, never the test set."""
        rows = []
        def score(g, d):
            m = self.evaluate(validation, top_n=top_n,
                              overrides=dict(location_weight=g, quality_weight=d))
            rows.append(dict(location_weight=g, quality_weight=d, **m))
            return m["recall"]
        best_g = max(location_values, key=lambda g: (score(g, 0.0), -g))
        best_d = max(quality_values, key=lambda d: (score(best_g, d), -d))
        self.cfg.location_weight, self.cfg.quality_weight = float(best_g), float(best_d)
        self.cfg.ranking_source = f"validation recall@{top_n} (tune_ranking)"
        self._loc_cache = {}
        return dict(location_weight=best_g, quality_weight=best_d), pd.DataFrame(rows)

    def review_alpha(self, test: pd.DataFrame, top_n=10,
                     alpha_values=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0)):
        """Section 4.8.3: 'the weight alpha is reviewed at each retraining
        cycle'. Picks the alpha with the best held-out recall@N; ties go to the
        larger alpha, which is the safer, more content-led choice."""
        rows = [dict(alpha=a, **self.evaluate(test, top_n=top_n, alpha=a))
                for a in alpha_values]
        best = max(rows, key=lambda r: (r["recall"], r["alpha"]))
        return best["alpha"], pd.DataFrame(rows)

    def tune(self, test: pd.DataFrame, k_values=(5, 10, 20, 30),
             alpha_values=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0), top_n=10):
        """Grid search. Selects on recall@N, which is the stabler statistic when
        each user has only one or two held-out items."""
        rows, original_k = [], self.cfg.k
        for k in k_values:
            self.cfg.k = k
            if self.n_users > 2:
                self.knn = NearestNeighbors(
                    n_neighbors=min(k + 1, self.n_users),
                    metric="cosine", algorithm="brute").fit(self.user_item)
            for a in alpha_values:
                m = self.evaluate(test, top_n=top_n, alpha=a)
                rows.append(dict(k=k, alpha=a, **m))
        df = pd.DataFrame(rows)
        best = df.loc[df.recall.idxmax()]
        self.cfg.k, self.cfg.alpha = int(best.k), float(best.alpha)
        self.cfg.alpha_mode, self.cfg.alpha_source = "fixed", "grid search (train.py --tune)"
        if self.n_users > 2:
            self.knn = NearestNeighbors(
                n_neighbors=min(self.cfg.k + 1, self.n_users),
                metric="cosine", algorithm="brute").fit(self.user_item)
        log.info("tuned: k=%d alpha=%.1f recall=%.3f (was k=%d)",
                 self.cfg.k, self.cfg.alpha, best.recall, original_k)
        return df, best

    # ------------------------------------------------------------- persist
    def save(self, path: str):
        import joblib
        joblib.dump(self, path, compress=3)
        return path

    @staticmethod
    def load(path: str) -> "HybridRecommender":
        import joblib
        return joblib.load(path)


def holdout_split(interactions: pd.DataFrame, min_history: int = 3):
    """Leave-last-out split for the live MySQL data, which has no seeded test
    file: each user with more than `min_history` distinct providers has the
    provider they touched most recently held out. Returns (train, test)."""
    if not len(interactions):
        return interactions, pd.DataFrame(columns=["user_id", "provider_id"])
    df = interactions.copy()
    order = "created_at" if "created_at" in df.columns else "interaction_id"
    if order in df.columns:
        df = df.sort_values(order, kind="stable")
    held = []
    for uid, g in df.groupby("user_id"):
        if g.provider_id.nunique() > min_history:
            held.append((uid, g.provider_id.iloc[-1]))
    test = pd.DataFrame(held, columns=["user_id", "provider_id"])
    if not len(test):
        return df, test
    key = set(map(tuple, test.to_numpy().tolist()))
    keep = [(u, p) not in key for u, p in zip(df.user_id, df.provider_id)]
    return df[keep], test
