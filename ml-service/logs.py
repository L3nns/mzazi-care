# -*- coding: utf-8 -*-
"""
Structured logging for the recommendation service, matching the backend's
(backend/services/logger.js): one JSON object per line when LOG_FORMAT=json,
a readable line otherwise, and the caller's X-Request-Id on every line written
while that request is served, so one id follows a search across both tiers.

Request lines carry the method, path, status and duration only - never the
query text, which is the parent's own words.

    LOG_LEVEL   DEBUG | INFO | WARNING | ERROR   (default INFO)
    LOG_FORMAT  json | pretty                      (default pretty)
"""
from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import time
import uuid

request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_FIELDS = ("method", "path", "status", "ms")


_base_factory = logging.getLogRecordFactory()


def _record_with_id(*args, **kwargs):
    # On the record itself, so every handler (and pytest's caplog) sees it.
    record = _base_factory(*args, **kwargs)
    record.request_id = request_id.get() or "-"
    return record


class JsonFormatter(logging.Formatter):
    def format(self, record):
        entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
                 + f".{int(record.msecs):03d}Z",
                 "level": record.levelname.lower(), "logger": record.name,
                 "msg": record.getMessage()}
        rid = getattr(record, "request_id", "-")
        if rid != "-":
            entry["request_id"] = rid
        for k in _FIELDS:
            if hasattr(record, k):
                entry[k] = getattr(record, k)
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry)


def setup():
    logging.setLogRecordFactory(_record_with_id)
    handler = logging.StreamHandler()
    if os.getenv("LOG_FORMAT", "pretty").lower() == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())


def install(app):
    """FastAPI middleware: adopt or create the request id, echo it back, and
    log one line per request (health checks at DEBUG, they run every 30 s)."""
    req_log = logging.getLogger("mzazi.ml.request")

    @app.middleware("http")
    async def _request_id(request, call_next):
        incoming = request.headers.get("x-request-id")
        rid = incoming if incoming and SAFE_ID.match(incoming) else uuid.uuid4().hex
        token = request_id.set(rid)
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Request-Id"] = rid
            return response
        finally:
            level = logging.DEBUG if request.url.path == "/health" else \
                logging.ERROR if status >= 500 else logging.INFO
            req_log.log(level, "request", extra=dict(
                method=request.method, path=request.url.path, status=status,
                ms=round((time.perf_counter() - started) * 1000, 2)))
            request_id.reset(token)
