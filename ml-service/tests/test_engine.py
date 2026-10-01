# -*- coding: utf-8 -*-
"""Tests for the hybrid engine. Run: pytest -q  (from ml-service/)"""
import os
import sys
import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import HybridRecommender, EngineConfig          # noqa: E402
from encoders import TfidfSvdEncoder, build_encoder          # noqa: E402
from synonyms import canonical_tags, expand                  # noqa: E402


@pytest.fixture(scope="module")
def catalogue():
    rows = [
        (1, "Alpha Lactation Studio", 12, "lactation consultant helping with latch "
         "and milk supply for new mothers", "lactation,latch", "Westlands", "verified"),
        (2, "Beta Feeding Support", 12, "breastfeeding clinic offering feeding "
         "assessment and tongue tie checks", "breastfeeding,feeding", "Kilimani", "verified"),
        (3, "Gamma Daycare", 23, "registered daycare centre with qualified minders "
         "and a structured routine", "daycare,creche", "Karen", "verified"),
        (4, "Delta Creche", 23, "full day childcare centre and creche for toddlers",
         "childcare,creche", "Westlands", "verified"),
        (5, "Epsilon Paediatrics", 17, "paediatrician running a well-baby child "
         "clinic with growth monitoring", "paediatric,clinic", "Karen", "verified"),
        (6, "Zeta Unverified", 17, "paediatric clinic awaiting verification",
         "paediatric", "Karen", "pending"),
        (7, "Eta Lactation Home Visits", 12, "lactation and breastfeeding support "
         "delivered through home visits", "lactation,home-visit", "Kilimani", "verified"),
        (8, "Theta Brand New Lactation", 12, "newly verified lactation consultant "
         "offering breastfeeding home visits", "lactation,home-visit", "Karen", "verified"),
        (9, "Iota Daycare Annex", 23, "daycare and creche annex with full day care",
         "daycare,creche", "Kilimani", "verified"),
    ]
    providers = pd.DataFrame(rows, columns=[
        "provider_id", "provider_name", "category_id", "service_description",
        "service_tags", "location", "verification_status"])
    categories = pd.DataFrame(
        [(12, "Lactation Consultation"), (23, "Daycare and Childcare Centres"),
         (17, "Pediatric Care")], columns=["category_id", "category_name"])
    # Users 1-3 favour lactation, users 4-6 favour daycare. Histories overlap but
    # differ, so every user has an unseen in-group provider a neighbour can supply.
    # Provider 8 is deliberately left with zero interactions (item cold start).
    histories = {1: [1, 2], 2: [1, 2, 7], 3: [2, 7],
                 4: [3, 4], 5: [3, 4, 9], 6: [4, 9]}
    inter = [(u, p, "save" if i == 0 else "click", 3.5 if i == 0 else 2.0)
             for u, ps in histories.items() for i, p in enumerate(ps)]
    interactions = pd.DataFrame(inter, columns=[
        "user_id", "provider_id", "interaction_type", "interaction_weight"])
    return providers, interactions, categories


@pytest.fixture(scope="module")
def engine(catalogue):
    providers, interactions, categories = catalogue
    cfg = EngineConfig(k=3, alpha=0.5, min_interactions=2, encoder="tfidf")
    return HybridRecommender(cfg, encoder=TfidfSvdEncoder(n_components=8)).fit(
        providers, interactions, categories)


# --------------------------------------------------------------- catalogue
def test_only_verified_providers_are_recommendable(engine):
    assert 6 not in engine.p_index, "a pending listing must never be recommendable"
    assert engine.n_items == 8


def test_item_vectors_are_l2_normalised(engine):
    norms = np.linalg.norm(engine.item_vectors, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-5)


# ----------------------------------------------------------------- content
def test_query_matches_semantically_not_lexically(engine):
    """'help me breastfeed' shares no term with 'lactation consultant ... latch'."""
    res = engine.recommend(query="someone to help me breastfeed", top_n=3)
    assert res["strategy"] == "content_only"
    assert {r["category_id"] for r in res["results"]} == {12}


def test_similar_providers_stay_in_category(engine):
    sims = engine.similar_providers(3, top_n=2)          # Gamma Daycare
    assert sims[0]["category_id"] == 23


# ----------------------------------------------------------- collaborative
def test_collaborative_signal_separates_the_two_user_groups(engine):
    lactation_user = engine.recommend(user_id=1, top_n=3, alpha=0.0)
    daycare_user = engine.recommend(user_id=4, top_n=3, alpha=0.0)
    assert lactation_user["results"][0]["category_id"] == 12
    assert daycare_user["results"][0]["category_id"] == 23


def test_seen_providers_are_excluded(engine):
    res = engine.recommend(user_id=1, top_n=6)
    returned = {r["provider_id"] for r in res["results"]}
    assert returned.isdisjoint({1, 2}), "must not re-recommend what the user saw"


# -------------------------------------------------------------- cold start
def test_unknown_user_with_query_falls_back_to_content(engine):
    res = engine.recommend(user_id=9999, query="daycare centre", top_n=2)
    assert res["strategy"] == "content_only"
    assert res["alpha_used"] == 1.0


def test_unknown_user_without_query_falls_back_to_popularity(engine):
    res = engine.recommend(user_id=9999, top_n=3)
    assert res["strategy"] == "popularity_fallback"
    assert len(res["results"]) == 3


def test_cold_provider_is_reachable_by_content_but_not_collaboration(engine):
    """Provider 8 has zero interactions - k-NN cannot surface it, content can."""
    content = engine.recommend(query="lactation home visit", top_n=4, alpha=1.0)
    assert 8 in {r["provider_id"] for r in content["results"]}
    collab = engine.recommend(user_id=1, top_n=8, alpha=0.0)
    scores = {r["provider_id"]: r["collaborative_score"] for r in collab["results"]}
    assert scores.get(8, 0.0) == 0.0, "no column in the user-item matrix"


# ------------------------------------------------------------------ blend
def test_alpha_shifts_the_ranking(engine):
    a0 = engine.recommend(user_id=1, top_n=5, alpha=0.0)["results"]
    a1 = engine.recommend(user_id=1, top_n=5, alpha=1.0)["results"]
    assert [r["provider_id"] for r in a0] != [r["provider_id"] for r in a1]


def test_scores_are_within_unit_range(engine):
    for r in engine.recommend(user_id=1, top_n=5)["results"]:
        assert 0.0 <= r["content_score"] <= 1.0
        assert 0.0 <= r["collaborative_score"] <= 1.0
        assert 0.0 <= r["hybrid_score"] <= 1.0


# ---------------------------------------------------------------- filters
def test_category_filter(engine):
    res = engine.recommend(user_id=4, top_n=5, category_id=23)
    assert all(r["category_id"] == 23 for r in res["results"])


def test_location_filter(engine):
    res = engine.recommend(user_id=1, top_n=5, location="Karen")
    assert all(r["location"] == "Karen" for r in res["results"])


def test_ranks_are_sequential(engine):
    res = engine.recommend(user_id=1, top_n=4)
    assert [r["rank_position"] for r in res["results"]] == [1, 2, 3, 4]


# --------------------------------------------------------------- synonyms
@pytest.mark.parametrize("query,listing", [
    ("someone to help me breastfeed", "lactation consultant latch support"),
    ("i am pregnant", "antenatal check-up for expectant mothers"),
    ("my baby needs vaccinating", "child immunisation clinic routine jabs"),
    ("natafuta yaya", "nanny placement agency vetted staff"),
])
def test_synonym_bridge_connects_query_and_listing(query, listing):
    assert set(canonical_tags(query)) & set(canonical_tags(listing))


def test_expand_is_a_noop_without_domain_terms():
    assert expand("xyzzy plugh") == "xyzzy plugh"


# --------------------------------------------------------------- encoders
def test_build_encoder_falls_back_without_sentence_transformers():
    enc = build_encoder("auto")
    assert enc.name.startswith(("sbert:", "tfidf-svd:"))


def test_forcing_sbert_without_the_library_raises():
    import encoders
    if encoders.sbert_available():
        pytest.skip("sentence-transformers is installed")
    with pytest.raises(RuntimeError, match="sentence-transformers"):
        build_encoder("sbert")


# -------------------------------------------------------------- evaluation
def test_evaluate_returns_bounded_metrics(engine, catalogue):
    _, interactions, _ = catalogue
    test = pd.DataFrame([(1, 7), (4, 9)], columns=["user_id", "provider_id"])
    m = engine.evaluate(test, top_n=3)
    for key in ("precision", "recall", "f1", "hit_rate"):
        assert 0.0 <= m[key] <= 1.0
    assert m["users"] == 2


def test_engine_round_trips_through_disk(engine, tmp_path):
    p = engine.save(str(tmp_path / "m.joblib"))
    again = HybridRecommender.load(p)
    a = engine.recommend(user_id=1, top_n=3)["results"]
    b = again.recommend(user_id=1, top_n=3)["results"]
    assert [r["provider_id"] for r in a] == [r["provider_id"] for r in b]


# ------------------------------------------------- neural encoder wrapper
class _FakeSentenceTransformer:
    """Stands in for a downloaded sentence-transformers model so the wrapper
    logic is tested even where the real weights cannot be fetched."""

    def __init__(self, name, dim=16):
        self.name, self._dim = name, dim
        self.seen = []

    def get_sentence_embedding_dimension(self):
        return self._dim

    def encode(self, texts, normalize_embeddings=False, **_):
        self.seen.append(list(texts))
        rng = np.random.default_rng(abs(hash(tuple(texts))) % (2 ** 32))
        v = rng.normal(size=(len(texts), self._dim)).astype(np.float32)
        if normalize_embeddings:
            v /= np.linalg.norm(v, axis=1, keepdims=True)
        return v


def _sbert_with_fake(monkeypatch, **kwargs):
    import encoders
    fake_module = type("m", (), {"SentenceTransformer": _FakeSentenceTransformer})
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake_module)
    return encoders.SbertEncoder(**kwargs)


def test_sbert_encoder_returns_normalised_vectors(monkeypatch):
    enc = _sbert_with_fake(monkeypatch, model_name="fake-model")
    enc.fit(["a listing", "another listing"])
    v = enc.encode(["lactation consultant", "daycare centre"])
    assert v.shape == (2, enc.dim)
    assert v.dtype == np.float32
    assert np.allclose(np.linalg.norm(v, axis=1), 1.0, atol=1e-5)
    assert enc.name == "sbert:fake-model"


def test_sbert_encoder_applies_synonym_expansion(monkeypatch):
    enc = _sbert_with_fake(monkeypatch, model_name="fake-model", expand=True)
    enc.encode(["someone to help me breastfeed"])
    sent = enc.model.seen[-1][0]
    assert "breastfeeding" in sent, "domain tags should reach the model"


def test_sbert_encoder_can_skip_expansion(monkeypatch):
    enc = _sbert_with_fake(monkeypatch, model_name="fake-model", expand=False)
    enc.encode(["someone to help me breastfeed"])
    assert enc.model.seen[-1] == ["someone to help me breastfeed"]


def test_sbert_encoder_handles_an_empty_batch(monkeypatch):
    enc = _sbert_with_fake(monkeypatch, model_name="fake-model")
    assert enc.encode([]).shape == (0, enc.dim)


def test_engine_accepts_any_encoder_implementation(monkeypatch, catalogue):
    """The engine must not care which backend produced the vectors."""
    providers, interactions, categories = catalogue
    enc = _sbert_with_fake(monkeypatch, model_name="fake-model")
    eng = HybridRecommender(EngineConfig(k=3, alpha=0.5, min_interactions=2),
                            encoder=enc).fit(providers, interactions, categories)
    res = eng.recommend(user_id=1, top_n=3)
    assert len(res["results"]) == 3
    assert eng.cfg.encoder_name == "sbert:fake-model"
