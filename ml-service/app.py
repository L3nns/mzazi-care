# -*- coding: utf-8 -*-
"""
Mzazi Care recommendation service (FastAPI).

This is the "recommendation layer" of the four-layer architecture in Figure 4.1.
The Express application layer is its only client; it is never exposed to the
browser directly.

Endpoints
    GET  /health                 liveness + model card
    POST /recommend              top-N for a user and/or query   (Figure 4.3)
    GET  /similar/{provider_id}  content neighbours of a listing
    POST /reindex                re-encode the catalogue after a verification
    POST /retrain                rebuild the user-item matrix and refit k-NN
    GET  /model                  current configuration and metrics

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import os
import logging
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Header, Depends
from pydantic import BaseModel, Field

from db import DataSource
from engine import HybridRecommender, EngineConfig

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("mzazi.ml")

SERVICE_TOKEN = os.getenv("ML_SERVICE_TOKEN", "")
MODEL_PATH = os.getenv("MZAZI_MODEL_PATH", "/app/model/hybrid_model.joblib")

_state: dict = {"engine": None, "source": None, "last_trained": None,
                "metrics": {}, "busy": False}
_lock = threading.Lock()


def _train(persist: bool = True) -> HybridRecommender:
    src = _state["source"] or DataSource()
    _state["source"] = src
    frames = src.load()
    cfg = EngineConfig(
        k=int(os.getenv("MZAZI_K", "20")),
        alpha=float(os.getenv("MZAZI_ALPHA", "0.4")),
        min_interactions=int(os.getenv("MZAZI_MIN_INTERACTIONS", "3")),
        encoder=os.getenv("MZAZI_ENCODER", "auto"),
        diversity_slots=int(os.getenv("MZAZI_DIVERSITY_SLOTS", "0")),
    )
    eng = HybridRecommender(cfg).fit(
        frames["providers"], src.training_interactions(frames), frames["categories"])
    if "interactions_test" in frames and len(frames["interactions_test"]):
        _state["metrics"] = eng.evaluate(frames["interactions_test"], top_n=10)
    _state["engine"] = eng
    _state["last_trained"] = time.strftime("%Y-%m-%d %H:%M:%S")
    if persist:
        try:
            os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
            eng.save(MODEL_PATH)
        except Exception as exc:                       # non-fatal
            log.warning("could not persist model to %s: %s", MODEL_PATH, exc)
    return eng


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        _train()
        log.info("engine ready")
    except Exception as exc:
        log.error("initial training failed: %s", exc)   # /health will report it
    yield


app = FastAPI(title="Mzazi Care Recommendation Service", version="1.0.0",
              lifespan=lifespan)


def require_token(x_service_token: str = Header(default="")):
    """Shared-secret guard. The Express layer sends the token; browsers never
    reach this service directly."""
    if SERVICE_TOKEN and x_service_token != SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid service token")
    return True


def engine() -> HybridRecommender:
    eng = _state["engine"]
    if eng is None:
        raise HTTPException(status_code=503,
                            detail="model not trained yet; POST /retrain")
    return eng


# ------------------------------------------------------------------ schemas
class RecommendRequest(BaseModel):
    user_id: int | None = None
    query: str | None = None
    top_n: int = Field(default=10, ge=1, le=50)
    alpha: float | None = Field(default=None, ge=0.0, le=1.0)
    category_id: int | None = None
    location: str | None = None
    exclude_seen: bool = True
    persist: bool = False


# ----------------------------------------------------------------- routes
@app.get("/health")
def health():
    eng = _state["engine"]
    return {
        "status": "ok" if eng else "degraded",
        "model_loaded": eng is not None,
        "last_trained": _state["last_trained"],
        "encoder": eng.cfg.encoder_name if eng else None,
        "providers": eng.cfg.n_providers if eng else 0,
        "users": eng.cfg.n_users if eng else 0,
    }


@app.get("/model")
def model_card(_=Depends(require_token)):
    eng = engine()
    return {"config": eng.cfg.to_dict(), "metrics": _state["metrics"],
            "last_trained": _state["last_trained"]}


@app.post("/recommend")
def recommend(req: RecommendRequest, _=Depends(require_token)):
    eng = engine()
    # No user and no query is a legitimate case - an anonymous visitor landing
    # on the results page. The engine answers with the popularity fallback
    # rather than an error (Section 4.8.3).
    try:
        out = eng.recommend(
            user_id=req.user_id, query=req.query, top_n=req.top_n,
            alpha=req.alpha, category_id=req.category_id,
            location=req.location, exclude_seen=req.exclude_seen)
    except Exception as exc:
        log.exception("recommend failed")
        raise HTTPException(status_code=500, detail=str(exc))
    if req.persist and req.user_id is not None and _state["source"]:
        try:
            _state["source"].persist_recommendations(req.user_id, out["results"])
        except Exception as exc:
            log.warning("could not persist recommendations: %s", exc)
    return out


@app.get("/similar/{provider_id}")
def similar(provider_id: int, top_n: int = 5, _=Depends(require_token)):
    return {"provider_id": provider_id,
            "results": engine().similar_providers(provider_id, top_n=top_n)}


@app.post("/reindex")
def reindex(_=Depends(require_token)):
    """Re-encode the catalogue. Called after a provider is verified or edited,
    so a new listing becomes recommendable immediately (Figure 4.4, step 17)."""
    return _rebuild("reindex")


@app.post("/retrain")
def retrain(_=Depends(require_token)):
    """Rebuild the user-item matrix and refit k-NN on the accumulated
    interactions (Section 4.8.2)."""
    return _rebuild("retrain")


def _rebuild(kind: str):
    if _state["busy"]:
        raise HTTPException(status_code=409, detail="a rebuild is already running")
    with _lock:
        _state["busy"] = True
        t0 = time.time()
        try:
            eng = _train()
        except Exception as exc:
            log.exception("%s failed", kind)
            raise HTTPException(status_code=500, detail=str(exc))
        finally:
            _state["busy"] = False
    return {"status": "ok", "operation": kind,
            "seconds": round(time.time() - t0, 2),
            "providers": eng.cfg.n_providers, "users": eng.cfg.n_users,
            "interactions": eng.cfg.n_interactions,
            "encoder": eng.cfg.encoder_name, "metrics": _state["metrics"]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
