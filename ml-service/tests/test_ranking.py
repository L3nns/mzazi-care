# -*- coding: utf-8 -*-
"""Location, quality, explanations, diversity re-ranking, extended metrics,
the model registry and the promotion gate. Run: pytest -q (from ml-service/)"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import HybridRecommender, EngineConfig, haversine_km   # noqa: E402
from encoders import TfidfSvdEncoder                               # noqa: E402
from registry import Registry                                      # noqa: E402
from test_engine import catalogue                                  # noqa: E402,F401

AREAS = pd.DataFrame([("Westlands", -1.2675, 36.8108), ("Kilimani", -1.2921, 36.7856),
                      ("Karen", -1.3197, 36.7073), ("Lavington", -1.2797, 36.7700)],
                     columns=["area_name", "latitude", "longitude"])
USERS = pd.DataFrame([(1, "Westlands"), (2, "Kilimani"), (3, "Karen"),
                      (4, "Westlands"), (5, "Karen"), (6, "Kilimani")],
                     columns=["user_id", "location"])


def build(catalogue, provider_areas=None, **cfg):                   # noqa: F811
    providers, interactions, categories = catalogue
    config = EngineConfig(k=3, alpha=0.5, min_interactions=2, encoder="tfidf", **cfg)
    return HybridRecommender(config, encoder=TfidfSvdEncoder(n_components=8)).fit(
        providers, interactions, categories, areas=AREAS, users=USERS,
        provider_areas=provider_areas)


# ---------------------------------------------------------------- location
def test_haversine_is_about_right():
    # Westlands to Karen is roughly 13 km as the crow flies.
    assert 11 < haversine_km((-1.2675, 36.8108), (-1.3197, 36.7073)) < 14


def test_location_weight_pulls_nearby_providers_up(catalogue):     # noqa: F811
    q = "lactation breastfeeding home visits"
    plain = build(catalogue).recommend(query=q, area="Karen", top_n=3)
    local = build(catalogue, location_weight=0.6).recommend(query=q, area="Karen", top_n=3)
    # Provider 8 (lactation, Karen) is in the area; with gamma it leads.
    assert local["results"][0]["provider_id"] == 8
    assert local["results"][0]["distance_km"] == 0.0
    assert local["weights"]["location"] == 0.6
    assert plain["weights"]["location"] == 0.0


def test_unknown_area_switches_the_location_feature_off(catalogue):  # noqa: F811
    eng = build(catalogue, location_weight=0.5)
    res = eng.recommend(query="daycare", area="Atlantis", top_n=3)
    assert res["weights"]["location"] == 0.0
    assert all(r["distance_km"] is None for r in res["results"])


def test_home_area_is_used_when_no_area_is_given(catalogue):       # noqa: F811
    eng = build(catalogue, location_weight=0.3)
    res = eng.recommend(user_id=3, top_n=5)
    assert res["area"] == "karen"


def test_hard_location_filter_uses_every_area_served(catalogue):   # noqa: F811
    extra = pd.DataFrame([(3, "Lavington")], columns=["provider_id", "area_name"])
    eng = build(catalogue, provider_areas=extra)
    ids = {r["provider_id"] for r in eng.recommend(query="daycare", location="Lavington", top_n=5)["results"]}
    assert ids == {3}, "Gamma Daycare (Karen) also serves Lavington"


# ------------------------------------------------------------ explanations
def test_reasons_come_from_real_signals(catalogue):                # noqa: F811
    eng = build(catalogue)
    res = eng.recommend(query="daycare creche", area="Karen", top_n=3)
    top = res["results"][0]
    codes = {r["code"] for r in top["reasons"]}
    assert "matches_search" in codes
    if top["location"] == "Karen":
        assert "serves_area" in codes
    assert set(top["scores"]) == {"content", "collaborative", "location", "quality", "final"}
    # Nothing in this catalogue has 3+ ratings, so nothing may claim to be well rated.
    assert all(r["code"] != "well_rated" for x in res["results"] for r in x["reasons"])


def test_popular_fallback_says_so(catalogue):                      # noqa: F811
    res = build(catalogue).recommend(top_n=3)
    assert res["strategy"] == "popularity_fallback"
    assert all(any(r["code"] == "popular" for r in x["reasons"]) for x in res["results"])


# -------------------------------------------------------------- diversity
def test_mmr_trades_some_relevance_for_variety(catalogue):          # noqa: F811
    eng = build(catalogue)
    plain = eng.recommend(query="lactation breastfeeding", top_n=4)
    varied = eng.recommend(query="lactation breastfeeding", top_n=4, overrides={"mmr_lambda": 0.3})
    cats = lambda r: len({x["category_id"] for x in r["results"]})  # noqa: E731
    assert cats(varied) >= cats(plain)
    assert varied["results"][0]["provider_id"] == plain["results"][0]["provider_id"], \
        "the best match still comes first"


def test_mmr_at_one_is_the_plain_ranking(catalogue):                # noqa: F811
    eng = build(catalogue)
    a = [r["provider_id"] for r in eng.recommend(query="daycare", top_n=5)["results"]]
    b = [r["provider_id"] for r in eng.recommend(query="daycare", top_n=5,
                                                  overrides={"mmr_lambda": 1.0})["results"]]
    assert a == b


# ---------------------------------------------------------------- metrics
def test_evaluate_reports_ranking_and_catalogue_metrics(catalogue):  # noqa: F811
    eng = build(catalogue)
    test = pd.DataFrame([(1, 7), (4, 9), (2, 2)], columns=["user_id", "provider_id"])
    m = eng.evaluate(test, top_n=5, per_user=True)
    for key in ("precision", "recall", "ndcg", "mrr", "coverage", "diversity", "hit_rate"):
        assert 0.0 <= m[key] <= 1.0, key
    assert len(m["per_user"]["recall"]) == m["users"]
    assert m["ndcg"] <= m["hit_rate"] + 1e-9


def test_tune_ranking_prefers_no_weight_on_a_tie(catalogue):         # noqa: F811
    eng = build(catalogue)
    val = pd.DataFrame([(1, 7), (4, 9)], columns=["user_id", "provider_id"])
    best, grid = eng.tune_ranking(val, top_n=5, location_values=(0.0, 0.1), quality_values=(0.0, 0.1))
    assert len(grid) == 4
    top = grid.recall.max()
    if grid[(grid.location_weight == 0.0) & (grid.quality_weight == 0.0)].recall.iloc[0] == top:
        assert best == {"location_weight": 0.0, "quality_weight": 0.0}


# ---------------------------------------------------------------- registry
def test_registry_promotes_and_rolls_back(tmp_path):
    reg = Registry(tmp_path)
    a = reg.add_candidate({"params": {"k": 20}, "metrics": {"recall": 0.8}})
    reg.promote(a["id"], by="test")
    b = reg.add_candidate({"params": {"k": 10}, "metrics": {"recall": 0.82}})
    assert reg.production()["id"] == a["id"] and reg.get(b["id"])["status"] == "candidate"
    reg.promote(b["id"], by="test")
    assert reg.production()["id"] == b["id"] and reg.get(a["id"])["status"] == "retired"
    back = reg.rollback(by="test")
    assert back["id"] == a["id"] and reg.get(b["id"])["status"] == "rolled_back"
    with pytest.raises(LookupError):
        reg.rollback(by="test")


def test_only_the_newest_model_files_are_kept(tmp_path, monkeypatch):
    # Model files hold parents' activity; the records outlive them.
    monkeypatch.setenv("MZAZI_KEEP_MODEL_FILES", "2")

    class Saves:
        def save(self, path):
            open(path, "w").write("model")

    reg = Registry(tmp_path)
    ids = [reg.add_candidate({"params": {"k": k}, "metrics": {}}, engine=Saves())["id"] for k in range(4)]
    reg.promote(ids[0], by="test")
    files = sorted(p.name for p in (tmp_path / "versions").iterdir())
    assert files == sorted(f"{i}.joblib" for i in ids[-2:])
    old = reg.get(ids[0])
    assert "artifact" not in old and old["artifact_removed_at"] and old["params"] == {"k": 0}
    assert reg.production()["id"] == ids[0], "a version without its file can still serve"


# ------------------------------------------------------- promotion gate (app)
def test_retrain_never_replaces_production_with_a_worse_candidate(catalogue, tmp_path, monkeypatch):  # noqa: F811
    import app as service
    providers, interactions, categories = catalogue
    frames = dict(providers=providers, categories=categories, interactions=interactions,
                  service_areas=AREAS, users=USERS,
                  provider_service_areas=pd.DataFrame(columns=["provider_id", "area_name"]))
    test = pd.DataFrame([(1, 7), (4, 9), (2, 2), (5, 4)], columns=["user_id", "provider_id"])
    monkeypatch.setattr(service, "registry", Registry(tmp_path))
    monkeypatch.setattr(service, "_load", lambda: (None, frames, interactions, interactions,
                                                   test, "fixture"))
    monkeypatch.setattr(service, "MIN_REVIEW_USERS", 999)
    monkeypatch.setitem(service._state, "encoder", TfidfSvdEncoder(n_components=8))
    monkeypatch.setenv("MZAZI_ENCODER", "tfidf")
    monkeypatch.setenv("MZAZI_MIN_INTERACTIONS", "2")

    first = service._retrain(by="test")
    assert first["promoted"] and first["reason"] == "first version"
    prod_id = first["candidate"]["id"]

    # A candidate that scores worse than production by more than the tolerance.
    real_fit = service._fit
    def worse_fit(cfg, fr, inter):
        eng = real_fit(cfg, fr, inter)
        if cfg.k == 3:
            eng.evaluate = lambda *a, **k: dict(recall=0.0, precision=0.0, users=4)
        return eng
    monkeypatch.setenv("MZAZI_K", "3")
    monkeypatch.setattr(service, "_fit", worse_fit)
    second = service._retrain(by="test")
    assert not second["promoted"]
    assert service.registry.production()["id"] == prod_id
    assert service._state["version"] == prod_id, "production keeps serving"
    assert service._state["engine"].cfg.k != 3

    # An administrator can still promote it, and roll back.
    service._activate(second["candidate"]["id"], by="admin")
    assert service._state["version"] == second["candidate"]["id"]
    service._activate(None, by="admin", rollback=True)
    assert service._state["version"] == prod_id


# ------------------------------------------------------- relevance floor
def test_a_search_never_fills_the_list_with_unrelated_services(catalogue):  # noqa: F811
    eng = build(catalogue, query_relevance_ratio=0.5)   # TF-IDF fixture scale
    # Karen holds a daycare (3), a paediatric clinic (5) and a lactation consultant (8).
    res = eng.recommend(query="daycare creche full day childcare", location="Karen", top_n=5)
    cats = {r["category_id"] for r in res["results"]}
    assert cats == {23}, f"only daycare may appear, got {cats}"


def test_the_floor_is_measured_against_the_whole_catalogue(catalogue):       # noqa: F811
    # Lavington has no daycare at all; its best local match must not pass.
    extra = pd.DataFrame([(5, "Lavington")], columns=["provider_id", "area_name"])
    eng = build(catalogue, provider_areas=extra, query_relevance_ratio=0.5)
    res = eng.recommend(query="daycare creche full day childcare", location="Lavington", top_n=5)
    assert res["results"] == []


def test_the_related_category_slot_is_exempt_and_labelled(catalogue):        # noqa: F811
    eng = build(catalogue, query_relevance_ratio=0.85, diversity_share=0.34)
    res = eng.recommend(query="lactation latch milk supply", top_n=3)
    related = [r for r in res["results"] if r["basis"] == "related_highly_rated"]
    for r in related:
        assert any(x["code"] == "related_highly_rated" for x in r["reasons"])
        assert not any(x["code"] == "matches_search" for x in r["reasons"])


def test_the_floor_is_off_for_tfidf_until_calibrated(catalogue):  # noqa: F811
    eng = build(catalogue)
    assert eng.relevance_ratio == 0.0
    assert build(catalogue, query_relevance_ratio=0.7).relevance_ratio == 0.7
