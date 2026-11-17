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
        for key in ("providers", "interactions", "categories", "users",
                    "saved_services", "search_history", "user_preferences",
                    "service_areas"):
            frames.setdefault(key, pd.DataFrame())
        # Without an explicit table, each provider serves its own location.
        if "provider_service_areas" not in frames or frames["provider_service_areas"].empty:
            prov = frames["providers"]
            frames["provider_service_areas"] = (
                prov[["provider_id", "location"]].dropna()
                .rename(columns={"location": "area_name"})
                if len(prov) and "location" in prov else pd.DataFrame(
                    columns=["provider_id", "area_name"]))
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
                     "saved_services", "interactions_train", "interactions_test",
                     "search_history", "user_preferences", "service_areas",
                     "provider_service_areas"):
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
            "search_history": "SELECT user_id, query_text, searched_at "
                              "FROM search_history WHERE query_text IS NOT NULL",
            "user_preferences": "SELECT user_id, category_id FROM user_preferences",
            "service_areas": "SELECT area_name, latitude, longitude FROM service_areas "
                             "WHERE is_active = 1",
            "provider_service_areas": """SELECT psa.provider_id, a.area_name
                                         FROM provider_service_areas psa
                                         JOIN service_areas a ON a.area_id = psa.area_id""",
        }
        conn = self._connect()
        try:
            out = {}
            for name, sql in queries.items():
                with conn.cursor() as cur:
                    try:
                        cur.execute(sql)
                    except Exception as exc:          # a database not migrated yet
                        if name in ("service_areas", "provider_service_areas"):
                            log.warning("no %s table yet (%s); run the backend migrations",
                                        name, exc)
                            continue
                        raise
                    out[name] = pd.DataFrame(cur.fetchall())
            log.info("loaded from MySQL (%d providers, %d interactions)",
                     len(out["providers"]), len(out["interactions"]))
            return out
        finally:
            conn.close()

    # --------------------------------------------------- live user history
    def user_history(self, user_id: int, max_searches: int = 20) -> dict | None:
        """
        What one user has done so far, read at request time (Figure 4.3, step 7)
        so a parent who registered, searched or saved a provider a minute ago
        is not still treated as a stranger until the next retrain. CSV mode
        has no live data and returns None, so the engine uses its fit-time view.
        """
        if self.source != "mysql":
            return None
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT provider_id, interaction_weight FROM interactions "
                            "WHERE user_id = %s", (user_id,))
                inter = [(int(r["provider_id"]), float(r["interaction_weight"]))
                         for r in cur.fetchall()]
                cur.execute("SELECT query_text FROM search_history WHERE user_id = %s "
                            "AND query_text IS NOT NULL AND query_text <> '' "
                            "ORDER BY searched_at DESC, search_id DESC LIMIT %s",
                            (user_id, max_searches))
                queries = [r["query_text"] for r in cur.fetchall()][::-1]
                cur.execute("SELECT category_id FROM user_preferences WHERE user_id = %s",
                            (user_id,))
                prefs = [int(r["category_id"]) for r in cur.fetchall()]
                cur.execute("SELECT provider_id FROM saved_services WHERE user_id = %s",
                            (user_id,))
                saved = [int(r["provider_id"]) for r in cur.fetchall()]
            return {"interactions": inter, "queries": queries,
                    "preferred_categories": prefs, "saved": saved}
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
