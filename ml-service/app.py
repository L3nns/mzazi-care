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
    POST /reindex                recompute the service embeddings after a
                                 catalogue change; k and alpha are kept
    POST /retrain                rebuild the user-item matrix, refit k-NN and
                                 review alpha against held-out interactions
    GET  /model                  current configuration and metrics

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import os
import logging
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import replace

from pathlib import Path

from dotenv import load_dotenv

# ml-service/.env wins; the project-root .env (shared with docker compose and
# the backend) fills in anything it does not set. Real environment variables
# beat both, so docker compose settings are never overridden.
_here = Path(__file__).resolve().parent
load_dotenv(_here / ".env")
load_dotenv(_here.parent / ".env")

from fastapi import FastAPI, HTTPException, Header, Depends  # noqa: E402
from pydantic import BaseModel, Field                        # noqa: E402

from db import DataSource                                    # noqa: E402
from encoders import build_encoder
from engine import HybridRecommender, EngineConfig, alpha_schedule, holdout_split

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("mzazi.ml")

SERVICE_TOKEN = os.getenv("ML_SERVICE_TOKEN", "")
MODEL_PATH = os.getenv("MZAZI_MODEL_PATH", "/app/model/hybrid_model.joblib")
# Fewer held-out users than this and a recall comparison is noise, so alpha
# follows the density schedule instead of the review.
MIN_REVIEW_USERS = int(os.getenv("MZAZI_MIN_REVIEW_USERS", "20"))

_state: dict = {"engine": None, "source": None, "encoder": None, "metrics": {},
                "alpha_review": [], "last_reindexed": None, "last_retrained": None,
                "saved": {}, "busy": False}
_lock = threading.Lock()


def _optional_float(name: str):
    raw = os.getenv(name, "").strip().lower()
    return None if raw in ("", "auto") else float(raw)


def _config() -> EngineConfig:
    raw_alpha = os.getenv("MZAZI_ALPHA", "auto").strip().lower()
    fixed = raw_alpha not in ("", "auto")
    return EngineConfig(
        k=int(os.getenv("MZAZI_K", "20")),
        alpha=float(raw_alpha) if fixed else 1.0,
        alpha_mode="fixed" if fixed else "auto",
        alpha_source="MZAZI_ALPHA" if fixed else "launch default",
        alpha_floor=float(os.getenv("MZAZI_ALPHA_FLOOR", "0.3")),
        density_target=float(os.getenv("MZAZI_DENSITY_TARGET", "10")),
        min_interactions=int(os.getenv("MZAZI_MIN_INTERACTIONS", "3")),
        min_similarity=_optional_float("MZAZI_MIN_SIMILARITY"),
        diversity_share=float(os.getenv("MZAZI_DIVERSITY_SHARE", "0.2")),
        encoder=os.getenv("MZAZI_ENCODER", "auto"),
    )


def _fit(cfg, frames, interactions):
    return HybridRecommender(cfg, encoder=_state["encoder"]).fit(
        frames["providers"], interactions, frames["categories"],
        searches=frames.get("search_history"),
        preferences=frames.get("user_preferences"))


def _train(kind: str = "retrain") -> HybridRecommender:
    """
    reindex  re-reads the catalogue and recomputes the embeddings; the current
             k and alpha are kept, because nothing about behaviour was reviewed.
    retrain  additionally rebuilds the user-item matrix from all interactions
             and reviews alpha (Section 4.8.3).
    """
    src = _state["source"] or DataSource()
    _state["source"] = src
    frames = src.load()
    if _state["encoder"] is None:
        _state["encoder"] = build_encoder(os.getenv("MZAZI_ENCODER", "auto"))

    cfg = _config()
    current = _state["engine"]
    review = kind == "retrain" or current is None

    # The CSV seed ships its own split; live MySQL data gets a leave-last-out
    # one. They are different protocols - with one held-out item per user,
    # recall@10 equals the hit rate - so the numbers are labelled, not compared.
    if len(frames.get("interactions_test", [])):
        serve_on = src.training_interactions(frames)
        eval_train, eval_test = serve_on, frames["interactions_test"]
        protocol = "seeded temporal split (interactions_test.csv)"
    else:
        serve_on = frames["interactions"]
        eval_train, eval_test = holdout_split(serve_on, cfg.min_interactions)
        protocol = "leave-last-out on live data (1 held-out provider per user)"

    if not review:
        cfg.k = current.cfg.k
        cfg.alpha, cfg.alpha_mode = current.cfg.alpha, current.cfg.alpha_mode
        cfg.alpha_source = current.cfg.alpha_source
        eng = _fit(replace(cfg), frames, serve_on)
    else:
        has_eval = eval_test is not None and len(eval_test) > 0
        same_data = serve_on is eval_train
        eng = _fit(replace(cfg), frames, serve_on)
        # Score on a model that never saw the held-out rows.
        scorer = (eng if same_data else _fit(replace(cfg), frames, eval_train)) \
            if has_eval else None

        if cfg.alpha_mode == "auto":
            n_eval = 0
            if scorer is not None:
                t = eval_test[eval_test.provider_id.isin(scorer.p_index)
                              & eval_test.user_id.isin(scorer.u_index)]
                n_eval = int(t.user_id.nunique())
            if n_eval >= MIN_REVIEW_USERS:
                alpha, grid = scorer.review_alpha(eval_test, top_n=10)
                source = f"reviewed on {n_eval} held-out users (recall@10)"
                _state["alpha_review"] = grid.to_dict(orient="records")
            else:
                alpha = alpha_schedule(eng.cfg.density_pct, eng.cfg.n_users, cfg)
                source = (f"density schedule ({eng.cfg.density_pct}% of the "
                          f"user-item matrix filled)")
                _state["alpha_review"] = []
            for e in {id(eng): eng, id(scorer): scorer}.values():
                if e is not None:
                    e.cfg.alpha, e.cfg.alpha_source = float(alpha), source

        _state["metrics"] = dict(scorer.evaluate(eval_test, top_n=10), protocol=protocol) \
            if scorer else {}

    saved = frames.get("saved_services")
    _state["saved"] = saved.groupby("user_id").provider_id.apply(
        lambda s: [int(x) for x in s]).to_dict() if saved is not None and len(saved) else {}
    _state["engine"] = eng
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    _state["last_reindexed"] = now
    if review:
        _state["last_retrained"] = now
    try:
        os.makedirs(os.path.dirname(MODEL_PATH) or ".", exist_ok=True)
        eng.save(MODEL_PATH)
    except Exception as exc:                       # non-fatal
        log.warning("could not persist model to %s: %s", MODEL_PATH, exc)
    log.info("%s done: alpha=%.2f (%s)", kind, eng.cfg.alpha, eng.cfg.alpha_source)
    return eng


def _initial_training(attempts: int = 30, wait_s: float = 10.0):
    """Train at start-up, retrying while the database comes up (it may still be
    loading its seed when this container starts). /health reports 'degraded'
    until it succeeds."""
    for attempt in range(1, attempts + 1):
        try:
            with _lock:
                _state["busy"] = True
                try:
                    _train("retrain")
                finally:
                    _state["busy"] = False
            log.info("engine ready")
            return
        except Exception as exc:
            log.warning("initial training failed (attempt %d/%d): %s",
                        attempt, attempts, exc)
            time.sleep(wait_s)
    log.error("giving up on initial training; POST /retrain once the database is up")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # In a thread, so the service answers /health while it trains or retries.
    threading.Thread(target=_initial_training, daemon=True).start()
    yield


app = FastAPI(title="Mzazi Care Recommendation Service", version="1.1.0",
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
    query: str | None = Field(default=None, max_length=300)
    top_n: int = Field(default=10, ge=1, le=50)
    alpha: float | None = Field(default=None, ge=0.0, le=1.0)
    category_id: int | None = None
    location: str | None = None
    # Section 3.2.4: "services the user has already saved are excluded".
    exclude_saved: bool = True
    exclude_seen: bool = False
    exclude_ids: list[int] = Field(default_factory=list, max_length=200)
    persist: bool = False


def _model_card(eng: HybridRecommender) -> dict:
    return {"config": eng.cfg.to_dict(), "metrics": _state["metrics"],
            "alpha_review": _state["alpha_review"],
            "last_trained": _state["last_retrained"],
            "last_reindexed": _state["last_reindexed"],
            "last_retrained": _state["last_retrained"]}


# ----------------------------------------------------------------- routes
@app.get("/health")
def health():
    eng = _state["engine"]
    return {
        "status": "ok" if eng else "degraded",
        "model_loaded": eng is not None,
        "last_trained": _state["last_retrained"],
        "last_reindexed": _state["last_reindexed"],
        "encoder": eng.cfg.encoder_name if eng else None,
        "alpha": eng.cfg.alpha if eng else None,
        "providers": eng.cfg.n_providers if eng else 0,
        "users": eng.cfg.n_users if eng else 0,
    }


@app.get("/model")
def model_card(_=Depends(require_token)):
    return _model_card(engine())


@app.post("/recommend")
def recommend(req: RecommendRequest, _=Depends(require_token)):
    eng = engine()
    history = None
    if req.user_id is not None and _state["source"]:
        try:
            history = _state["source"].user_history(req.user_id, eng.cfg.max_searches)
        except Exception as exc:                 # fall back to the fit-time view
            log.warning("could not read live history for %s: %s", req.user_id, exc)
    exclude = set(req.exclude_ids)
    if req.exclude_saved and req.user_id is not None:
        exclude |= set(history["saved"] if history is not None
                       else _state["saved"].get(req.user_id, []))
    # No user and no query is a legitimate case - an anonymous visitor landing
    # on the results page. The engine answers with popular, highly rated
    # services rather than an error (Section 4.8.3).
    try:
        out = eng.recommend(
            user_id=req.user_id, query=req.query, top_n=req.top_n,
            alpha=req.alpha, category_id=req.category_id,
            location=req.location, exclude_seen=req.exclude_seen,
            exclude_ids=exclude, history=history)
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
    """Rebuild the user-item matrix, refit k-NN on the accumulated
    interactions and review alpha (Section 4.8.2, 4.8.3)."""
    return _rebuild("retrain")


def _rebuild(kind: str):
    if _state["busy"]:
        raise HTTPException(status_code=409, detail="a rebuild is already running")
    with _lock:
        _state["busy"] = True
        t0 = time.time()
        try:
            eng = _train(kind)
        except Exception as exc:
            log.exception("%s failed", kind)
            raise HTTPException(status_code=500, detail=str(exc))
        finally:
            _state["busy"] = False
    return {"status": "ok", "operation": kind,
            "seconds": round(time.time() - t0, 2),
            "providers": eng.cfg.n_providers, "users": eng.cfg.n_users,
            "interactions": eng.cfg.n_interactions,
            "encoder": eng.cfg.encoder_name, "alpha": eng.cfg.alpha,
            "alpha_source": eng.cfg.alpha_source, "metrics": _state["metrics"]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
