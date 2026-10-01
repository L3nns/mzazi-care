# -*- coding: utf-8 -*-
"""
The hybrid recommendation engine (Section 4.8 of the proposal).

    score(u, s) = alpha * content(u, s) + (1 - alpha) * collaborative(u, s)

Content is cosine similarity between a user preference vector and the encoded
service catalogue; collaborative is k-Nearest Neighbors over the user-item
matrix. Both are normalised per user before blending, because cosine similarity
and summed neighbour weights live on different scales.

Cold-start rules, in the order they apply:
  * no usable collaborative signal   -> alpha forced to 1.0 (content only)
  * no content signal either         -> popularity fallback
  * a live search query              -> outweighs the stored preference vector
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
    alpha: float = 0.4             # weight on the content component
    min_interactions: int = 3      # below this a user has no collaborative signal
    query_weight: float = 0.75     # a live query vs the stored profile
    top_n: int = 10
    encoder: str = "auto"
    diversity_slots: int = 0       # reserve N slots for other categories
    trained_at: str = ""
    encoder_name: str = ""
    n_users: int = 0
    n_providers: int = 0
    n_interactions: int = 0
    density_pct: float = 0.0
    extra: dict = field(default_factory=dict)

    def to_dict(self):
        return asdict(self)


def _minmax(v: np.ndarray) -> np.ndarray:
    lo, hi = float(np.min(v)), float(np.max(v))
    return np.zeros_like(v) if hi - lo == 0 else (v - lo) / (hi - lo)


class HybridRecommender:
    def __init__(self, config: EngineConfig | None = None,
                 encoder: ContentEncoder | None = None):
        self.cfg = config or EngineConfig()
        self.encoder = encoder
        self.fitted = False

    # ------------------------------------------------------------------ fit
    def fit(self, providers: pd.DataFrame, interactions: pd.DataFrame,
            categories: pd.DataFrame | None = None) -> "HybridRecommender":
        """
        providers    : provider_id, provider_name, category_id, service_description,
                       service_tags, location, verification_status
        interactions : user_id, provider_id, interaction_type, interaction_weight
        Only VERIFIED providers become recommendable (Table 4.4).
        """
        t0 = time.time()

        self.providers = providers[
            providers.verification_status == "verified"
        ].reset_index(drop=True).copy()
        if self.providers.empty:
            raise ValueError("no verified providers to recommend")

        self.provider_ids = self.providers.provider_id.tolist()
        self.p_index = {p: i for i, p in enumerate(self.provider_ids)}
        self.n_items = len(self.provider_ids)

        cat_name = {}
        if categories is not None and len(categories):
            cat_name = dict(zip(categories.category_id, categories.category_name))
        self.cat_name = cat_name

        # ---- content side ------------------------------------------------
        text = (
            self.providers.category_id.map(cat_name).fillna("").astype(str) + ". " +
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

        # ---- collaborative side ------------------------------------------
        inter = interactions[interactions.provider_id.isin(self.p_index)].copy()
        if "interaction_weight" not in inter.columns:
            inter["interaction_weight"] = inter.interaction_type.map(
                INTERACTION_WEIGHTS).fillna(1.0)
        inter["interaction_weight"] = inter.interaction_weight.astype(float)

        self.user_ids = sorted(inter.user_id.unique().tolist())
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
        self.seen = inter.groupby("user_id").provider_id.apply(set).to_dict()
        self.popularity = np.asarray(self.user_item.sum(axis=0)).ravel() \
            if self.n_users else np.zeros(self.n_items)

        # user preference vectors in content space
        self.user_profiles = (self.user_item @ self.item_vectors) \
            if self.n_users else np.zeros((0, self.item_vectors.shape[1]))
        if self.n_users:
            n = np.linalg.norm(self.user_profiles, axis=1, keepdims=True)
            self.user_profiles = self.user_profiles / np.where(n == 0, 1, n)

        # neighbourhood model
        self.knn = None
        if self.n_users > 2:
            k = min(self.cfg.k + 1, self.n_users)
            self.knn = NearestNeighbors(n_neighbors=k, metric="cosine",
                                        algorithm="brute").fit(self.user_item)

        self.cfg.encoder_name = self.encoder.name
        self.cfg.n_users = self.n_users
        self.cfg.n_providers = self.n_items
        self.cfg.n_interactions = int(len(inter))
        self.cfg.density_pct = round(
            100 * self.user_item.nnz / max(1, self.n_users * self.n_items), 2)
        self.cfg.trained_at = time.strftime("%Y-%m-%d %H:%M:%S")
        self.fitted = True

        log.info("fitted in %.1fs: %d providers, %d users, %d interactions, "
                 "density %.2f%%, encoder %s", time.time() - t0, self.n_items,
                 self.n_users, len(inter), self.cfg.density_pct, self.encoder.name)
        return self

    # ------------------------------------------------- component scores
    def _content_scores(self, user_id=None, query=None):
        profile = None
        if user_id is not None and user_id in self.u_index:
            row = self.user_profiles[self.u_index[user_id]]
            if np.any(row):
                profile = row
        if query:
            qv = self.encoder.encode_one(query)
            if profile is None:
                profile = qv
            else:
                w = self.cfg.query_weight
                profile = w * qv + (1 - w) * profile
                nrm = np.linalg.norm(profile)
                profile = profile / (nrm if nrm else 1)
        if profile is None:
            return np.zeros(self.n_items), False
        return self.item_vectors @ profile, True

    def _collaborative_scores(self, user_id=None):
        if (user_id is None or self.knn is None
                or user_id not in self.u_index
                or self.interaction_counts.get(user_id, 0) < self.cfg.min_interactions):
            return np.zeros(self.n_items), False
        i = self.u_index[user_id]
        n_neighbors = min(self.cfg.k + 1, self.n_users)
        dist, idx = self.knn.kneighbors(self.user_item[i], n_neighbors=n_neighbors)
        sims, neigh = 1.0 - dist.ravel(), idx.ravel()
        acc = np.zeros(self.n_items)
        for s, j in zip(sims, neigh):
            if j == i or s <= 0:
                continue                       # never recommend from yourself
            acc += s * self.user_item[j].toarray().ravel()
        return acc, bool(np.any(acc))

    # ------------------------------------------------------------ recommend
    def recommend(self, user_id=None, query=None, top_n=None, alpha=None,
                  category_id=None, location=None, exclude_seen=True,
                  exclude_ids=None):
        if not self.fitted:
            raise RuntimeError("engine is not fitted")
        top_n = top_n or self.cfg.top_n

        cs, has_content = self._content_scores(user_id, query)
        fs, has_collab = self._collaborative_scores(user_id)

        a = self.cfg.alpha if alpha is None else float(alpha)
        if not has_collab:
            a = 1.0
        if not has_content:
            a = 0.0

        cs_n, fs_n = _minmax(cs), _minmax(fs)
        score = a * cs_n + (1 - a) * fs_n
        strategy = "hybrid"
        if not has_content and not has_collab:
            score, strategy = _minmax(self.popularity), "popularity_fallback"
        elif a >= 1.0:
            strategy = "content_only"
        elif a <= 0.0:
            strategy = "collaborative_only"

        score = score.astype(float).copy()
        mask = np.zeros(self.n_items, dtype=bool)
        if exclude_seen and user_id is not None:
            for pid in self.seen.get(user_id, ()):
                mask[self.p_index[pid]] = True
        for pid in (exclude_ids or ()):
            if pid in self.p_index:
                mask[self.p_index[pid]] = True
        if category_id is not None:
            mask |= (self.providers.category_id.to_numpy() != int(category_id))
        if location:
            mask |= (self.providers.location.astype(str).str.lower().to_numpy()
                     != str(location).lower())
        score[mask] = -np.inf

        order = [i for i in np.argsort(-score) if np.isfinite(score[i])]
        order = self._apply_diversity(order, top_n)

        results = []
        for rank, i in enumerate(order[:top_n], start=1):
            row = self.providers.iloc[i]
            results.append(dict(
                rank_position=rank,
                provider_id=int(row.provider_id),
                provider_name=row.provider_name,
                category_id=int(row.category_id),
                category_name=self.cat_name.get(row.category_id, ""),
                location=row.location,
                content_score=round(float(cs_n[i]), 4),
                collaborative_score=round(float(fs_n[i]), 4),
                hybrid_score=round(float(score[i]), 4),
            ))
        return dict(user_id=user_id, query=query, strategy=strategy,
                    alpha_used=round(float(a), 2), count=len(results),
                    results=results)

    def _apply_diversity(self, order, top_n):
        """Reserve a few slots for categories outside the top one, so the list
        does not collapse onto a single category (Section 4.8.3)."""
        slots = self.cfg.diversity_slots
        if slots <= 0 or len(order) <= top_n:
            return order
        cats = self.providers.category_id.to_numpy()
        head, reserve, seen_cats = [], [], set()
        for i in order:
            if len(head) < top_n - slots:
                head.append(i)
                seen_cats.add(cats[i])
            elif cats[i] not in seen_cats and len(reserve) < slots:
                reserve.append(i)
                seen_cats.add(cats[i])
        rest = [i for i in order if i not in set(head) | set(reserve)]
        return head + reserve + rest

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
