# -*- coding: utf-8 -*-
"""
Model versions: every retrain produces a CANDIDATE, evaluated before it can
serve; one version is PRODUCTION; promotion and rollback are explicit.

A version is a ranking configuration (k, alpha, location and quality weights,
diversity setting, encoder) together with the evaluation that justified it
and a snapshot of the fitted model. Serving refits the production
configuration whenever the catalogue changes, so a newly verified provider
is recommendable at once; the saved snapshot is the evidence, kept so an
evaluation can be reproduced.

Layout under MZAZI_MODEL_DIR:
    registry.json            index of versions and the production pointer
    versions/<id>.joblib     fitted model as evaluated
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

PARAM_KEYS = ("k", "alpha", "alpha_mode", "alpha_source", "location_weight",
              "quality_weight", "mmr_lambda", "ranking_source", "encoder")


def params_of(cfg) -> dict:
    d = cfg.to_dict() if hasattr(cfg, "to_dict") else dict(cfg)
    return {k: d.get(k) for k in PARAM_KEYS}


class Registry:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.file = self.root / "registry.json"
        self._lock = threading.Lock()

    # ------------------------------------------------------------- storage
    def _read(self) -> dict:
        try:
            return json.loads(self.file.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            return {"production": None, "history": [], "versions": []}

    def _write(self, data: dict):
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
        os.replace(tmp, self.file)           # atomic on the same volume

    # --------------------------------------------------------------- reads
    def versions(self) -> list[dict]:
        return self._read()["versions"]

    def get(self, version_id: str) -> dict | None:
        return next((v for v in self.versions() if v["id"] == version_id), None)

    def production(self) -> dict | None:
        data = self._read()
        return next((v for v in data["versions"] if v["id"] == data["production"]), None)

    def summary(self) -> dict:
        data = self._read()
        return {"production": data["production"], "history": data["history"],
                "versions": list(reversed(data["versions"]))}

    # -------------------------------------------------------------- writes
    def add_candidate(self, record: dict, engine=None) -> dict:
        with self._lock:
            data = self._read()
            vid = time.strftime("v%Y%m%d-%H%M%S")
            n = 1
            while any(v["id"] == vid for v in data["versions"]):
                n += 1
                vid = time.strftime("v%Y%m%d-%H%M%S") + f"-{n}"
            record = {"id": vid, "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                      "status": "candidate", **record}
            if engine is not None:
                try:
                    (self.root / "versions").mkdir(parents=True, exist_ok=True)
                    engine.save(str(self.root / "versions" / f"{vid}.joblib"))
                    record["artifact"] = f"versions/{vid}.joblib"
                except Exception as exc:        # evidence is useful, not essential
                    record["artifact_error"] = str(exc)
            data["versions"].append(record)
            self._prune_files(data)
            self._write(data)
            return record

    def _prune_files(self, data: dict):
        """A model file holds parents' activity and past searches, so only the
        newest KEEP files are kept (MZAZI_KEEP_MODEL_FILES, default 3). The
        record - parameters and metrics - stays: promote and rollback refit
        from the parameters, never from the file."""
        keep = max(1, int(os.getenv("MZAZI_KEEP_MODEL_FILES", "3")))
        with_files = [v for v in data["versions"] if v.get("artifact")]
        for v in with_files[:-keep]:
            try:
                (self.root / v["artifact"]).unlink(missing_ok=True)
            except OSError:
                continue                     # try again at the next retrain
            v.pop("artifact")
            v["artifact_removed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")

    def promote(self, version_id: str, by: str, note: str = "") -> dict:
        with self._lock:
            data = self._read()
            target = next((v for v in data["versions"] if v["id"] == version_id), None)
            if target is None:
                raise KeyError(version_id)
            current = data["production"]
            if current == version_id:
                return target
            for v in data["versions"]:
                if v["id"] == current:
                    v["status"] = "retired"
            target["status"] = "production"
            target["promoted_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            target["promoted_by"] = by
            if note:
                target["promotion_note"] = note
            if current:
                data["history"].append(current)
            data["production"] = version_id
            self._write(data)
            return target

    def previous(self) -> str | None:
        """The version that was production before the current one."""
        data = self._read()
        return data["history"][-1] if data["history"] else None

    def rollback(self, by: str) -> dict:
        with self._lock:
            data = self._read()
            if not data["history"]:
                raise LookupError("there is no earlier production version")
            prev = data["history"].pop()
            current = data["production"]
            for v in data["versions"]:
                if v["id"] == current:
                    v["status"] = "rolled_back"
                if v["id"] == prev:
                    v["status"] = "production"
                    v["promoted_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                    v["promoted_by"] = by
                    v["promotion_note"] = f"rollback from {current}"
            data["production"] = prev
            self._write(data)
            return next(v for v in data["versions"] if v["id"] == prev)
