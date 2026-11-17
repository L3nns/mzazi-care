# -*- coding: utf-8 -*-
"""Tests for the FastAPI layer. Run: pytest -q  (from ml-service/)

The engine is fitted on the small catalogue from test_engine.py with the
TF-IDF encoder and injected into the app state, so no database, model file or
start-up training is involved.
"""
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as service                                        # noqa: E402
from engine import HybridRecommender, EngineConfig           # noqa: E402
from test_engine import catalogue                            # noqa: E402,F401

TOKEN = "test-service-token"


@pytest.fixture()
def client(catalogue, monkeypatch):                          # noqa: F811
    providers, interactions, categories = catalogue
    eng = HybridRecommender(EngineConfig(k=3, alpha=0.5, min_interactions=2,
                                         encoder="tfidf")).fit(
        providers, interactions, categories)
    monkeypatch.setattr(service, "SERVICE_TOKEN", TOKEN)
    monkeypatch.setitem(service._state, "engine", eng)
    monkeypatch.setitem(service._state, "source", None)
    monkeypatch.setitem(service._state, "saved", {1: [7]})
    monkeypatch.setitem(service._state, "busy", False)
    # No `with`: the lifespan hook (start-up training) must not run.
    return TestClient(service.app)


def auth(token=TOKEN):
    return {"X-Service-Token": token}


def test_health_is_open_and_reports_the_model(client):
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["model_loaded"] is True
    assert body["providers"] == 8                  # the pending listing is excluded


def test_health_is_degraded_without_a_model(client, monkeypatch):
    monkeypatch.setitem(service._state, "engine", None)
    assert client.get("/health").json()["status"] == "degraded"
    assert client.post("/recommend", json={}, headers=auth()).status_code == 503


@pytest.mark.parametrize("method,path,body", [
    ("post", "/recommend", {}), ("get", "/model", None),
    ("get", "/similar/1", None), ("post", "/reindex", None), ("post", "/retrain", None)])
def test_protected_routes_need_the_service_token(client, method, path, body):
    kw = {"json": body} if body is not None else {}
    assert getattr(client, method)(path, **kw).status_code == 401
    assert getattr(client, method)(path, headers=auth("wrong"), **kw).status_code == 401


def test_recommend_by_query(client):
    res = client.post("/recommend", headers=auth(),
                      json={"query": "lactation home visits", "top_n": 3})
    assert res.status_code == 200
    out = res.json()
    assert out["count"] == 3
    assert out["results"][0]["category_id"] == 12
    assert all(r["provider_id"] != 6 for r in out["results"])   # never unverified


def test_anonymous_visitor_gets_popular_services(client):
    out = client.post("/recommend", headers=auth(), json={}).json()
    assert out["strategy"] == "popularity_fallback" and out["count"] > 0


def test_saved_services_are_excluded(client):
    out = client.post("/recommend", headers=auth(),
                      json={"user_id": 1, "top_n": 8}).json()
    assert 7 not in {r["provider_id"] for r in out["results"]}
    keep = client.post("/recommend", headers=auth(),
                       json={"user_id": 1, "top_n": 8, "exclude_saved": False}).json()
    assert 7 in {r["provider_id"] for r in keep["results"]}


@pytest.mark.parametrize("body", [
    {"top_n": 0}, {"top_n": 201}, {"alpha": 1.5}, {"query": "x" * 301}])
def test_recommend_validates_its_input(client, body):
    assert client.post("/recommend", headers=auth(), json=body).status_code == 422


def test_search_asks_for_matches_only(client, monkeypatch):
    # The search page ranks a long candidate list and must not receive the
    # related-category items reserved for recommendation lists. Lactation and
    # paediatrics share a parent here, so the reserved slot has something to use.
    eng = service._state["engine"]
    monkeypatch.setattr(eng, "cat_parent", {12: 3, 17: 3, 23: 4})
    monkeypatch.setattr(eng, "cat_children", {3: {12, 17}, 4: {23}})
    body = {"query": "lactation breastfeeding", "top_n": 4}
    plain = client.post("/recommend", headers=auth(), json=body).json()
    search = client.post("/recommend", headers=auth(), json={**body, "related": False}).json()
    assert any(r["basis"] == "related_highly_rated" for r in plain["results"])
    assert all(r["basis"] == "match" for r in search["results"])
    whole = client.post("/recommend", headers=auth(),
                        json={**body, "top_n": 200, "related": False}).json()
    assert whole["count"] == 8, "the whole verified catalogue, ranked"


def test_similar_providers(client):
    out = client.get("/similar/1?top_n=2", headers=auth()).json()
    assert len(out["results"]) == 2
    assert all(r["provider_id"] != 1 for r in out["results"])
    assert client.get("/similar/999", headers=auth()).json()["results"] == []


def test_model_card(client):
    card = client.get("/model", headers=auth()).json()
    assert card["config"]["k"] == 3 and card["config"]["encoder_name"].startswith("tfidf")


def test_a_second_rebuild_is_refused_while_one_runs(client, monkeypatch):
    monkeypatch.setitem(service._state, "busy", True)
    assert client.post("/retrain", headers=auth()).status_code == 409


def test_request_id_is_echoed_and_on_every_log_line(client, caplog):
    import logging
    with caplog.at_level(logging.INFO):
        res = client.post("/recommend", headers={**auth(), "X-Request-Id": "trace-7"},
                          json={"query": "my private worry", "top_n": 2})
    assert res.headers["x-request-id"] == "trace-7"
    line = next(r for r in caplog.records if r.name == "mzazi.ml.request")
    assert (line.request_id, line.path, line.status) == ("trace-7", "/recommend", 200)
    assert "private worry" not in caplog.text
    fresh = client.get("/health", headers={"X-Request-Id": "not safe!"})
    assert fresh.headers["x-request-id"] != "not safe!"


def test_the_query_match_strength_is_reported(client):
    near = client.post("/recommend", headers=auth(), json={"query": "lactation latch"}).json()
    far = client.post("/recommend", headers=auth(), json={"query": "car mechanic"}).json()
    assert near["query_similarity"] > far["query_similarity"]
    assert client.post("/recommend", headers=auth(), json={}).json()["query_similarity"] is None
