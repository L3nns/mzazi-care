# -*- coding: utf-8 -*-
"""
Data access for the recommendation service.

Two sources behind one interface:

  mysql  production - reads the tables defined in database/schema.sql
  csv    development and CI - reads the seed CSVs directly, so the engine and
         its tests run without a database

Set MZAZI_DATA_SOURCE=mysql|csv (default: mysql if DB_HOST is set, else csv).
"""
from __future__ import annotations

import os
import logging
from pathlib import Path

import pandas as pd

log = logging.getLogger(__name__)

VERIFIED = "verified"


def _csv_dir() -> Path:
    explicit = os.getenv("MZAZI_CSV_DIR")
    if explicit:
        return Path(explicit)
    here = Path(__file__).resolve().parent
    for cand in (here.parent / "database" / "seed",
                 here.parent / "dataset",
                 here / "data"):
        if (cand / "providers.csv").exists():
            return cand
    return here.parent / "database" / "seed"


class DataSource:
    """Returns the four frames the engine needs, whatever the backend."""

    def __init__(self, source: str | None = None):
        if source is None:
            source = os.getenv("MZAZI_DATA_SOURCE") or (
                "mysql" if os.getenv("DB_HOST") else "csv")
        self.source = source.lower()
        log.info("data source: %s", self.source)

    # ------------------------------------------------------------------ api
    def load(self) -> dict[str, pd.DataFrame]:
        frames = self._load_mysql() if self.source == "mysql" else self._load_csv()
        for key in ("providers", "interactions", "categories", "users"):
            frames.setdefault(key, pd.DataFrame())
        return frames

    def training_interactions(self, frames) -> pd.DataFrame:
        """Prefer an explicit train split when one exists (so evaluation stays honest)."""
        return frames.get("interactions_train", frames["interactions"])

    # --------------------------------------------------------------- csv
    def _load_csv(self) -> dict[str, pd.DataFrame]:
        d = _csv_dir()
        if not (d / "providers.csv").exists():
            raise FileNotFoundError(
                f"no seed CSVs under {d}. Set MZAZI_CSV_DIR to the dataset folder.")
        out = {}
        for name in ("providers", "categories", "users", "interactions",
                     "saved_services", "interactions_train", "interactions_test"):
            f = d / f"{name}.csv"
            if f.exists():
                out[name] = pd.read_csv(f)
        log.info("loaded CSVs from %s (%d providers, %d interactions)", d,
                 len(out.get("providers", [])), len(out.get("interactions", [])))
        return out

    # -------------------------------------------------------------- mysql
    def _connect(self):
        import pymysql
        return pymysql.connect(
            host=os.getenv("DB_HOST", "localhost"),
            port=int(os.getenv("DB_PORT", "3306")),
            user=os.getenv("DB_USER", "mzazi"),
            password=os.getenv("DB_PASSWORD", ""),
            database=os.getenv("DB_NAME", "mzazi_care"),
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
        )

    def _load_mysql(self) -> dict[str, pd.DataFrame]:
        queries = {
            "providers": """SELECT provider_id, provider_name, category_id,
                                   service_description, service_tags, location,
                                   qualifications, verification_status, created_at
                            FROM providers""",
            "categories": "SELECT category_id, category_name, description, "
                          "parent_category_id FROM categories",
            "users": "SELECT user_id, full_name, location, role, created_at FROM users",
            "interactions": """SELECT interaction_id, user_id, provider_id,
                                      interaction_type, rating_value,
                                      interaction_weight, created_at
                               FROM interactions""",
            "saved_services": "SELECT saved_id, user_id, provider_id, saved_at "
                              "FROM saved_services",
        }
        conn = self._connect()
        try:
            out = {}
            for name, sql in queries.items():
                with conn.cursor() as cur:
                    cur.execute(sql)
                    out[name] = pd.DataFrame(cur.fetchall())
            log.info("loaded from MySQL (%d providers, %d interactions)",
                     len(out["providers"]), len(out["interactions"]))
            return out
        finally:
            conn.close()

    # ------------------------------------------------- write recommendations
    def persist_recommendations(self, user_id: int, results: list[dict]) -> int:
        """Store a generated list in the recommendations table. No-op on CSV."""
        if self.source != "mysql" or not results:
            return 0
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM recommendations WHERE user_id = %s", (user_id,))
                cur.executemany(
                    """INSERT INTO recommendations
                       (user_id, provider_id, content_score, collaborative_score,
                        hybrid_score, rank_position)
                       VALUES (%s, %s, %s, %s, %s, %s)""",
                    [(user_id, r["provider_id"], r["content_score"],
                      r["collaborative_score"], r["hybrid_score"],
                      r["rank_position"]) for r in results])
            conn.commit()
            return len(results)
        finally:
            conn.close()
