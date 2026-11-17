# -*- coding: utf-8 -*-
"""
Mzazi Care recommendation service (FastAPI).

This is the "recommendation layer" of the four-layer architecture in Figure 4.1.
The Express application layer is its only client; it is never exposed to the
browser directly.

Endpoints
    GET  /health                    liveness + serving version
    POST /recommend                 top-N for a user and/or query   (Figure 4.3)
    GET  /similar/{provider_id}     content neighbours of a listing
    POST /reindex                   refit the production configuration on the
                                    current catalogue (after a listing changes)
    POST /retrain                   build and evaluate a CANDIDATE version;
                                    it serves only if it passes the promotion
                                    gate (see _retrain)
    GET  /model                     serving configuration and metrics
    GET  /models                    every version, with its evaluation
    POST /models/{id}/promote       put a version into production
    POST /models/rollback           return to the previous production version

Model selection never looks at the test interactions: alpha and the location
and quality weights are chosen on a validation split cut from the training
period; the test split only scores the chosen configuration.

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import hmac
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
from encoders import build_encoder                           # noqa: E402
from engine import (HybridRecommender, EngineConfig,          # noqa: E402
                    alpha_schedule, holdout_split)
from registry import Registry, params_of                      # noqa: E402
import logs                                                   # noqa: E402

logs.setup()
log = logging.getLogger("mzazi.ml")

SERVICE_TOKEN = os.getenv("ML_SERVICE_TOKEN", "")
MODEL_PATH = os.getenv("MZAZI_MODEL_PATH", "/app/model/hybrid_model.joblib")
MODEL_DIR = os.getenv("MZAZI_MODEL_DIR", os.path.dirname(MODEL_PATH) or ".")
# Fewer held-out users than this and a recall comparison is noise, so alpha
# follows the density schedule and the extra ranking weights stay off.
MIN_REVIEW_USERS = int(os.getenv("MZAZI_MIN_REVIEW_USERS", "20"))
# A candidate replaces production automatically only if its test recall@10 is
# no more than this below production's on the same split. false: never; an
# administrator promotes by hand.
AUTO_PROMOTE = os.getenv("MZAZI_AUTO_PROMOTE", "true").strip().lower() != "false"
PROMOTE_TOLERANCE = float(os.getenv("MZAZI_PROMOTE_TOLERANCE", "0.01"))

_state: dict = {"engine": None, "source": None, "encoder": None, "metrics": {},
                "alpha_review": [], "ranking_review": [], "last_reindexed": None,
                "last_retrained": None, "saved": {}, "busy": False, "version": None}
_lock = threading.Lock()
registry = Registry(MODEL_DIR)


def _optional_float(name: str):
    raw = os.getenv(name, "").strip().lower()
    return None if raw in ("", "auto") else float(raw)


def _config() -> EngineConfig:
    raw_alpha = os.getenv("MZAZI_ALPHA", "auto").strip().lower()
    fixed = raw_alpha not in ("", "auto")
    loc_w, qual_w = _optional_float("MZAZI_LOCATION_WEIGHT"), _optional_float("MZAZI_QUALITY_WEIGHT")
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
        location_weight=loc_w or 0.0,
        quality_weight=qual_w or 0.0,
        mmr_lambda=_optional_float("MZAZI_MMR_LAMBDA"),
        # "auto" (unset) means tune on validation; a number pins the weight.
        ranking_source="auto" if loc_w is None and qual_w is None else "MZAZI_*_WEIGHT",
        encoder=os.getenv("MZAZI_ENCODER", "auto"),
    )


def _with_params(cfg: EngineConfig, params: dict) -> EngineConfig:
    """A copy of cfg carrying a version's ranking parameters."""
    out = replace(cfg)
    for k, v in (params or {}).items():
        if k != "encoder" and hasattr(out, k) and v is not None:
            setattr(out, k, v)
    if params and "mmr_lambda" in params:
        out.mmr_lambda = params["mmr_lambda"]
    return out


def _fit(cfg, frames, interactions):
    return HybridRecommender(replace(cfg), encoder=_state["encoder"]).fit(
        frames["providers"], interactions, frames["categories"],
        searches=frames.get("search_history"),
        preferences=frames.get("user_preferences"),
        areas=frames.get("service_areas"),
        provider_areas=frames.get("provider_service_areas"),
        users=frames.get("users"))


def _load():
    src = _state["source"] or DataSource()
    _state["source"] = src
    frames = src.load()
    if _state["encoder"] is None:
        _state["encoder"] = build_encoder(os.getenv("MZAZI_ENCODER", "auto"))
    # The CSV seed ships its own split; live MySQL data gets a leave-last-out
    # one. They are different protocols - with one held-out item per user,
    # recall@10 equals the hit rate - so the numbers are labelled, not compared.
    if len(frames.get("interactions_test", [])):
        serve_on = src.training_interactions(frames)
        eval_train, eval_test = serve_on, frames["interactions_test"]
        protocol = "seeded temporal split (interactions_test.csv)"
    else:
        serve_on = frames["interactions"]
        eval_train, eval_test = holdout_split(serve_on, _config().min_interactions)
        protocol = "leave-last-out on live data (1 held-out provider per user)"
    return src, frames, serve_on, eval_train, eval_test, protocol


def _held_out_users(eng, test) -> int:
    if test is None or not len(test):
        return 0
    t = test[test.provider_id.isin(eng.p_index) & test.user_id.isin(eng.u_index)]
    return int(t.user_id.nunique())


def _serve(eng, frames, version_id, metrics=None):
    saved = frames.get("saved_services")
    _state["saved"] = saved.groupby("user_id").provider_id.apply(
        lambda s: [int(x) for x in s]).to_dict() if saved is not None and len(saved) else {}
    _state["engine"] = eng
    _state["version"] = version_id
    if metrics is not None:
        _state["metrics"] = metrics
    _state["last_reindexed"] = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        os.makedirs(os.path.dirname(MODEL_PATH) or ".", exist_ok=True)
        eng.save(MODEL_PATH)
    except Exception as exc:                       # non-fatal
        log.warning("could not persist model to %s: %s", MODEL_PATH, exc)


def _reindex() -> HybridRecommender:
    """Refits the serving configuration on the current catalogue and data.
    Nothing about the configuration is reviewed, so no new version."""
    _, frames, serve_on, *_ = _load()
    current = _state["engine"]
    prod = registry.production()
    params = prod["params"] if prod else (params_of(current.cfg) if current else {})
    eng = _fit(_with_params(_config(), params), frames, serve_on)
    _serve(eng, frames, prod["id"] if prod else _state["version"],
           metrics=prod.get("metrics") if prod else None)
    log.info("reindex done: version %s, alpha=%.2f", _state["version"], eng.cfg.alpha)
    return eng


def _select(cfg, frames, eval_train):
    """Chooses alpha and the ranking weights on a validation split cut from the
    training period (each user's last training interaction held out)."""
    val_train, val_test = holdout_split(eval_train, cfg.min_interactions)
    selector = _fit(cfg, frames, val_train)
    n_val = _held_out_users(selector, val_test)
    notes = {"validation_users": n_val}
    if cfg.alpha_mode == "auto":
        if n_val >= MIN_REVIEW_USERS:
            alpha, grid = selector.review_alpha(val_test, top_n=10)
            cfg.alpha = float(alpha)
            cfg.alpha_source = f"validation review on {n_val} users (recall@10)"
            _state["alpha_review"] = grid.to_dict(orient="records")
        else:
            cfg.alpha = alpha_schedule(selector.cfg.density_pct, selector.cfg.n_users, cfg)
            cfg.alpha_source = f"density schedule ({selector.cfg.density_pct}% filled)"
            _state["alpha_review"] = []
    if cfg.ranking_source == "auto":
        if n_val >= MIN_REVIEW_USERS:
            selector.cfg.alpha = cfg.alpha
            best, grid = selector.tune_ranking(val_test, top_n=10)
            cfg.location_weight, cfg.quality_weight = best["location_weight"], best["quality_weight"]
            cfg.ranking_source = f"validation review on {n_val} users (recall@10)"
            _state["ranking_review"] = grid.drop(columns=["per_user"], errors="ignore") \
                .to_dict(orient="records")
        else:
            cfg.location_weight = cfg.quality_weight = 0.0
            cfg.ranking_source = "too little data to review; location and quality off"
    return cfg, notes


def _retrain(by: str = "retrain") -> dict:
    """
    1. choose a configuration on validation data (training period only);
    2. score it on the test split, and score the production configuration
       on the same split;
    3. record it as a candidate; it goes into production only if there is no
       production yet, or (with auto-promotion on) its recall@10 is no more
       than PROMOTE_TOLERANCE below production's. Otherwise production keeps
       serving, refitted on the new data, and an administrator decides.
    """
    _, frames, serve_on, eval_train, eval_test, protocol = _load()
    cfg, notes = _select(_config(), frames, eval_train)
    params = params_of(cfg)

    has_eval = eval_test is not None and len(eval_test) > 0
    scorer = _fit(cfg, frames, eval_train) if has_eval else None
    metrics = dict(scorer.evaluate(eval_test, top_n=10), protocol=protocol) if scorer else {}

    prod = registry.production()
    comparison = None
    if prod and scorer:
        prod_scorer = _fit(_with_params(_config(), prod["params"]), frames, eval_train)
        comparison = dict(production_id=prod["id"],
                          production=prod_scorer.evaluate(eval_test, top_n=10))

    if prod is None:
        promote, why = True, "first version"
    elif not AUTO_PROMOTE:
        promote, why = False, "auto-promotion is off; an administrator decides"
    elif not metrics or not comparison:
        promote, why = False, "no held-out data to compare on"
    else:
        gap = metrics["recall"] - comparison["production"]["recall"]
        promote = gap >= -PROMOTE_TOLERANCE
        why = (f"recall@10 {metrics['recall']:.4f} vs production "
               f"{comparison['production']['recall']:.4f} (tolerance {PROMOTE_TOLERANCE})")

    serving_cfg = cfg if promote else _with_params(_config(), prod["params"])
    eng = _fit(serving_cfg, frames, serve_on)
    record = registry.add_candidate(dict(
        params=params, metrics=metrics, comparison=comparison, selection=notes,
        alpha_review=_state["alpha_review"], ranking_review=_state["ranking_review"],
        data=dict(providers=eng.cfg.n_providers, users=eng.cfg.n_users,
                  interactions=eng.cfg.n_interactions, density_pct=eng.cfg.density_pct),
        decision=dict(promoted=promote, reason=why, by=by)), engine=scorer or eng)
    if promote:
        record = registry.promote(record["id"], by=by, note=why)
    version = record["id"] if promote else prod["id"]
    _serve(eng, frames, version, metrics=metrics if promote else prod.get("metrics"))
    _state["last_retrained"] = time.strftime("%Y-%m-%d %H:%M:%S")
    log.info("retrain: candidate %s %s (%s)", record["id"],
             "promoted" if promote else "kept as candidate", why)
    return dict(candidate=record, promoted=promote, reason=why, serving=version)


def _activate(version_id: str, by: str, rollback: bool = False) -> dict:
    """Puts a version into production and refits it on the current data."""
    target = registry.rollback(by) if rollback else registry.promote(version_id, by=by)
    _, frames, serve_on, *_ = _load()
    eng = _fit(_with_params(_config(), target["params"]), frames, serve_on)
    _serve(eng, frames, target["id"], metrics=target.get("metrics"))
    return target


def _startup():
    """Serve the registered production version if there is one, so a restart
    never silently changes the configuration; otherwise create the first."""
    if registry.production():
        _reindex()
    else:
        _retrain(by="startup")


def _initial_training(attempts: int = 30, wait_s: float = 10.0):
    """Train at start-up, retrying while the database comes up (it may still be
    loading its seed when this container starts). /health reports 'degraded'
    until it succeeds."""
    for attempt in range(1, attempts + 1):
        try:
            with _lock:
                _state["busy"] = True
                try:
                    _startup()
                finally:
                    _state["busy"] = False
            log.info("engine ready (version %s)", _state["version"])
            return
        except Exception as exc:
            log.warning("initial training failed (attempt %d/%d): %s",
                        attempt, attempts, exc)
            time.sleep(wait_s)
    log.error("giving up on initial training; POST /retrain once the database is up")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not SERVICE_TOKEN:
        log.warning("ML_SERVICE_TOKEN is not set - every endpoint is open; "
                    "set it before exposing this service")
    # In a thread, so the service answers /health while it trains or retries.
    threading.Thread(target=_initial_training, daemon=True).start()
    yield


app = FastAPI(title="Mzazi Care Recommendation Service", version="1.2.0",
              lifespan=lifespan)
logs.install(app)


def require_token(x_service_token: str = Header(default="")):
    """Shared-secret guard. The Express layer sends the token; browsers never
    reach this service directly."""
    if SERVICE_TOKEN and not hmac.compare_digest(
            x_service_token.encode(), SERVICE_TOKEN.encode()):
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
    # Up to 200 so free-text search can rank the whole matching set.
    top_n: int = Field(default=10, ge=1, le=200)
    alpha: float | None = Field(default=None, ge=0.0, le=1.0)
    category_id: int | None = None
    # Hard filter: only providers serving this area.
    location: str | None = Field(default=None, max_length=120)
    # Ranking only: the area distance is measured from.
    area: str | None = Field(default=None, max_length=120)
    # Section 3.2.4: "services the user has already saved are excluded".
    exclude_saved: bool = True
    exclude_seen: bool = False
    exclude_ids: list[int] = Field(default_factory=list, max_length=500)
    persist: bool = False
    # False for search: no slot reserved for related categories, matches only.
    related: bool = True


class ActionBy(BaseModel):
    by: str = Field(default="administrator", max_length=120)


def _model_card(eng: HybridRecommender) -> dict:
    return {"version": _state["version"], "config": eng.cfg.to_dict(),
            "metrics": _state["metrics"], "alpha_review": _state["alpha_review"],
            "ranking_review": _state["ranking_review"],
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
        "version": _state["version"],
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
            exclude_ids=exclude, history=history, area=req.area,
            overrides=None if req.related else {"diversity_share": 0.0})
    except Exception as exc:
        log.exception("recommend failed")
        raise HTTPException(status_code=500, detail=str(exc))
    out["version"] = _state["version"]
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
    return _rebuild("reindex", _reindex)


@app.post("/retrain")
def retrain(body: ActionBy | None = None, _=Depends(require_token)):
    """Build and evaluate a candidate version (Section 4.8.2, 4.8.3)."""
    return _rebuild("retrain", lambda: _retrain(by=(body.by if body else "retrain")))


@app.get("/models")
def models(_=Depends(require_token)):
    return registry.summary()


@app.post("/models/rollback")
def rollback(body: ActionBy | None = None, _=Depends(require_token)):
    try:
        return _rebuild("rollback", lambda: {
            "production": _activate(None, by=(body.by if body else "administrator"),
                                    rollback=True)})
    except LookupError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.post("/models/{version_id}/promote")
def promote(version_id: str, body: ActionBy | None = None, _=Depends(require_token)):
    if registry.get(version_id) is None:
        raise HTTPException(status_code=404, detail="no such version")
    return _rebuild("promote", lambda: {
        "production": _activate(version_id, by=(body.by if body else "administrator"))})


def _rebuild(kind: str, fn):
    if _state["busy"]:
        raise HTTPException(status_code=409, detail="a rebuild is already running")
    with _lock:
        _state["busy"] = True
        t0 = time.time()
        try:
            out = fn()
        except (LookupError, KeyError):
            raise
        except Exception as exc:
            log.exception("%s failed", kind)
            raise HTTPException(status_code=500, detail=str(exc))
        finally:
            _state["busy"] = False
    eng = _state["engine"]
    result = out if isinstance(out, dict) else {}
    return {"status": "ok", "operation": kind, "seconds": round(time.time() - t0, 2),
            "version": _state["version"],
            "providers": eng.cfg.n_providers, "users": eng.cfg.n_users,
            "interactions": eng.cfg.n_interactions,
            "encoder": eng.cfg.encoder_name, "alpha": eng.cfg.alpha,
            "alpha_source": eng.cfg.alpha_source,
            "location_weight": eng.cfg.location_weight,
            "quality_weight": eng.cfg.quality_weight,
            "metrics": _state["metrics"], **result}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
