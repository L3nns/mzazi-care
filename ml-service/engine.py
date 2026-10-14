# -*- coding: utf-8 -*-
"""
The hybrid recommendation engine (Section 4.8 of the proposal).

    score(u, s) = alpha * content(u, s) + (1 - alpha) * collaborative(u, s)

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
            preferences: pd.DataFrame | None = None) -> "HybridRecommender":
        """
        providers    : provider_id, provider_name, category_id, service_description,
                       service_tags, location, verification_status
        interactions : user_id, provider_id, interaction_type, interaction_weight
                       [, rating_value]
        searches     : user_id, query_text [, searched_at]          (optional)
        preferences  : user_id, category_id                         (optional)
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
                  exclude_ids=None, history=None):
        """
        history: live signals for this user, read at request time (Figure 4.3,
                 step 7) - {"interactions": [(provider_id, weight), ...],
                 "queries": [...], "preferred_categories": [...]}. Without it
                 the engine uses what it saw at fit time.
        """
        if not self.fitted:
            raise RuntimeError("engine is not fitted")
        top_n = top_n or self.cfg.top_n

        cs, has_content = self._content_scores(user_id, query, history)
        fs, has_collab = self._collaborative_scores(user_id, history)

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
        if location:
            mask |= (self.providers.location.astype(str).str.lower().to_numpy()
                     != str(location).lower())
        valid = ~mask

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

        cs_n, fs_n = _minmax(cs), _minmax(fs)
        score = a * cs_n + (1 - a) * fs_n
        strategy = "hybrid"
        if not has_content and not has_collab:
            score, strategy = self.quality.copy(), "popularity_fallback"
        elif a >= 1.0:
            strategy = "content_only"
        elif a <= 0.0:
            strategy = "collaborative_only"

        score = score.astype(float).copy()
        score[mask] = -np.inf
        order = [int(i) for i in np.argsort(-score, kind="stable") if np.isfinite(score[i])]

        reserved = set()
        if strategy == "content_only" and category_id is None:
            order, reserved = self._reserve_related(order, top_n, valid)

        results = []
        for rank, i in enumerate(order[:top_n], start=1):
            row = self.providers.iloc[i]
            results.append(dict(
                rank_position=rank,
                provider_id=int(row.provider_id),
                provider_name=row.provider_name,
                category_id=int(row.category_id),
                category_name=self.cat_name.get(int(row.category_id), ""),
                location=row.location,
                content_score=round(float(cs_n[i]), 4),
                collaborative_score=round(float(fs_n[i]), 4),
                hybrid_score=round(float(np.clip(score[i], 0.0, 1.0)), 4),
                avg_rating=float(self.rating_mean[i]) if self.rating_count[i] else None,
                rating_count=int(self.rating_count[i]),
                basis=("related_highly_rated" if i in reserved
                       else "popular" if strategy == "popularity_fallback"
                       else "match"),
            ))
        return dict(user_id=user_id, query=query, strategy=strategy,
                    alpha_used=round(float(a), 2), count=len(results),
                    results=results)

    def _reserve_related(self, order, top_n, valid):
        """Section 4.8.3: until the collaborative component is available, keep
        a small share of the list for highly rated services in categories
        related to (same parent as) the top matches, but not the same ones."""
        n_reserve = int(round(top_n * self.cfg.diversity_share))
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
    def evaluate(self, test: pd.DataFrame, top_n=10, alpha=None, only_items=None):
        truth = test[test.provider_id.isin(self.p_index)] \
            .groupby("user_id").provider_id.apply(set).to_dict()
        ps, rs, hits = [], [], []
        for uid, relevant in truth.items():
            if uid not in self.u_index:
                continue
            target = relevant & only_items if only_items is not None else relevant
            if not target:
                continue
            res = self.recommend(user_id=uid, top_n=top_n, alpha=alpha)
            got = {r["provider_id"] for r in res["results"]}
            hit = len(got & target)
            ps.append(hit / top_n)
            rs.append(hit / len(target))
            hits.append(1.0 if hit else 0.0)
        if not ps:
            return dict(precision=0.0, recall=0.0, f1=0.0, hit_rate=0.0, users=0)
        p, r = float(np.mean(ps)), float(np.mean(rs))
        return dict(precision=round(p, 4), recall=round(r, 4),
                    f1=round(0.0 if p + r == 0 else 2 * p * r / (p + r), 4),
                    hit_rate=round(float(np.mean(hits)), 4), users=len(ps))

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
