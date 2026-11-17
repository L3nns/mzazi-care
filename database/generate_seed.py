"""
Regenerate the behavioural seed tables for Mzazi Care.

Providers, categories, users and admin_logs are kept as they are. This script
rewrites, from one random seed:

    user_preferences, search_history, interactions, saved_services,
    interactions_train, interactions_test     (database/seed/*.csv)

and the matching INSERT blocks in database/seed_data.sql, so the CSV and
MySQL copies stay identical.

How the data is shaped
----------------------
Every parent belongs to a life-stage segment (users.segment_label_synthetic_only).
A segment maps to a few leaf categories; each parent takes two of them as their
"focus" needs and stays consistent across everything they do:

  * declared preferences  = their focus categories (plus sometimes a third)
  * searches              = phrases built from those categories' service tags
  * interactions          = mostly providers in those categories, picked by an
                            appeal score that is shared across the whole segment
                            (so similar parents like the same providers - the
                            collaborative signal) and boosted for providers in
                            the parent's own area
  * saves / ratings       = escalate from views on the providers they liked most

Two kinds of noise keep the data from being perfectly clean: some off-focus
browsing, and a share of parents whose last discovery comes from their next
life stage (pregnancy -> new baby, and so on).

The test split is leave-last-out, the same protocol the engine applies to live
MySQL data: for each parent with enough history, the last provider they
discovered (and every interaction with it) goes to interactions_test.csv;
everything earlier is interactions_train.csv.

The data is synthetic. Results measured on it describe how the engine behaves
on well-structured behaviour, not on real Mzazi Care users.

    python database/generate_seed.py            # writes CSVs + seed_data.sql
    python database/generate_seed.py --seed 7   # a different draw
"""
from __future__ import annotations

import argparse
import re
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
SEED_DIR = HERE / "seed"
SQL_FILE = HERE / "seed_data.sql"

# Leaf categories each life-stage segment draws its needs from. The first one
# listed is the segment's main need and is always among a parent's focus pair.
SEGMENT_CATEGORIES = {
    "early_pregnancy":     [5, 7, 15],
    "birth_preparation":   [6, 8, 9],
    "new_mother":          [10, 12, 11, 13],
    "maternal_wellbeing":  [14, 16, 15],
    "infant_health":       [17, 18, 19],
    "toddler_development": [20, 24, 19],
    "working_parent":      [23, 22, 24],
    "special_needs":       [21, 20, 17],
}

# Rough neighbourhood groups, used for a smaller "nearby" location boost.
AREAS = [
    {"Westlands", "Parklands", "Kileleshwa", "Lavington", "Kilimani", "Upper Hill"},
    {"Karen", "Langata", "Ngong Road", "South B", "South C"},
    {"Gigiri", "Runda", "Ruaka", "Kikuyu"},
    {"Kasarani", "Roysambu", "Buruburu", "Donholm", "Embakasi"},
]

START = datetime(2026, 3, 1)
END = datetime(2026, 9, 30, 23, 59)

# Where a parent's needs tend to go next. A share of parents move on to the
# next stage late in their history, which no model can fully anticipate.
NEXT_STAGE = {
    "early_pregnancy": "birth_preparation",
    "birth_preparation": "new_mother",
    "new_mother": "infant_health",
    "maternal_wellbeing": "new_mother",
    "infant_health": "toddler_development",
    "toddler_development": "working_parent",
    "working_parent": "toddler_development",
    "special_needs": "toddler_development",
}

OFF_FOCUS_SHARE = 0.10   # chance per discovery of a provider outside the focus pair
DRIFT_SHARE = 0.10       # parents whose last discovery is from their next stage
TEST_PROVIDERS = 1       # providers held out per parent (leave-last-out)
MIN_HISTORY = 5          # parents need at least this many providers to be tested

TABLE_COLUMNS = {
    "user_preferences": ["preference_id", "user_id", "category_id",
                         "preferred_location", "preference_weight", "updated_at"],
    "search_history":   ["search_id", "user_id", "query_text", "category_filter",
                         "location_filter", "searched_at"],
    "interactions":     ["interaction_id", "user_id", "provider_id", "interaction_type",
                         "rating_value", "interaction_weight", "created_at"],
    "saved_services":   ["saved_id", "user_id", "provider_id", "saved_at"],
}


def area_of(location: str) -> int:
    return next((i for i, a in enumerate(AREAS) if location in a), -1)


def fmt(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%d %H:%M:00")


class Generator:
    def __init__(self, seed: int):
        self.rng = np.random.default_rng(seed)
        self.providers = pd.read_csv(SEED_DIR / "providers.csv")
        self.categories = pd.read_csv(SEED_DIR / "categories.csv")
        self.users = pd.read_csv(SEED_DIR / "users.csv")

        self.cat_name = dict(zip(self.categories.category_id, self.categories.category_name))
        live = self.providers[self.providers.verification_status == "verified"]
        self.by_cat = {int(c): g.provider_id.tolist() for c, g in live.groupby("category_id")}
        self.prov_loc = dict(zip(live.provider_id, live.location))
        self.prov_cat = dict(zip(live.provider_id, live.category_id.astype(int)))
        self.prov_tags = {
            int(p): [t.replace("-", " ") for t in str(tags).split(",") if t]
            for p, tags in zip(live.provider_id, live.service_tags)}

        # A provider's general quality, then a per-segment taste on top of it:
        # parents in the same segment agree on which providers are good.
        quality = {int(p): self.rng.lognormal(0, 0.5) for p in live.provider_id}
        self.appeal = {
            seg: {p: q * self.rng.lognormal(0, 0.35) for p, q in quality.items()}
            for seg in SEGMENT_CATEGORIES}

    # ------------------------------------------------------------ per user
    def focus_for(self, segment: str) -> list[int]:
        cats = SEGMENT_CATEGORIES[segment]
        return [cats[0], int(self.rng.choice(cats[1:]))]

    def provider_weights(self, pids, segment, location):
        home = area_of(location)
        w = []
        for p in pids:
            v = self.appeal[segment][p]
            if self.prov_loc[p] == location:
                v *= 2.0
            elif area_of(self.prov_loc[p]) == home and home >= 0:
                v *= 1.4
            w.append(v)
        w = np.asarray(w)
        return w / w.sum()

    def discover(self, segment, focus, location):
        """The ordered list of providers a parent finds, earliest first."""
        focus_pool = [p for c in focus for p in self.by_cat.get(c, [])]
        n = min(len(focus_pool), int(self.rng.integers(5, 9)))
        w = self.provider_weights(focus_pool, segment, location)
        picked = list(self.rng.choice(focus_pool, size=n, replace=False, p=w))

        # A little off-focus browsing: other categories of the same segment
        # first, occasionally anything at all.
        others = [p for p in self.prov_cat if p not in focus_pool]
        seg_other = [p for p in others
                     if self.prov_cat[p] in SEGMENT_CATEGORIES[segment]]
        for _ in range(n):
            if self.rng.random() < OFF_FOCUS_SHARE:
                pool = seg_other if seg_other and self.rng.random() < 0.6 else others
                cand = [p for p in pool if p not in picked]
                if cand:
                    picked.insert(int(self.rng.integers(0, len(picked) + 1)),
                                  int(self.rng.choice(cand)))

        # Better providers tend to be found earlier, but not strictly.
        key = [self.appeal[segment][p] * self.rng.lognormal(0, 0.8) for p in picked]
        order = [int(p) for _, p in sorted(zip(key, picked), reverse=True)]

        if self.rng.random() < DRIFT_SHARE:
            nxt = NEXT_STAGE[segment]
            cand = [p for p in self.by_cat[SEGMENT_CATEGORIES[nxt][0]] if p not in order]
            if cand:
                w = self.provider_weights(cand, nxt, location)
                order.append(int(self.rng.choice(cand, p=w)))
        return order

    def engage(self, uid, pid, segment, location, when):
        """The interactions a parent has with one provider, from `when` on."""
        a = self.appeal[segment][pid] * (2.0 if self.prov_loc[pid] == location else 1.0)
        strength = min(1.0, a / 2.5)                       # 0..1, how much they like it
        rows, t = [], when

        def add(kind, rating=None):
            nonlocal t
            weight = float(rating) if kind == "rating" else \
                {"view": 1.0, "click": 2.0, "save": 3.5}[kind]
            rows.append([uid, pid, kind, rating, weight, t])
            t += timedelta(minutes=int(self.rng.integers(5, 60 * 30)))

        for _ in range(int(self.rng.integers(1, 3))):
            add("view")
        if self.rng.random() < 0.45 + 0.45 * strength:
            add("click")
            if self.rng.random() < 0.15 + 0.5 * strength:
                add("save")
            if self.rng.random() < 0.10 + 0.45 * strength:
                stars = int(np.clip(round(3 + 2 * strength + self.rng.normal(0, 0.5)), 2, 5))
                add("rating", stars)
            if self.rng.random() < 0.3:
                add("view")                                # coming back to it
        return rows, t

    def searches_for(self, uid, focus, location, first, last):
        rows = []
        for _ in range(int(self.rng.integers(6, 14))):
            cat = int(self.rng.choice(focus))
            pid = int(self.rng.choice(self.by_cat[cat]))
            tag = str(self.rng.choice(self.prov_tags[pid]))
            name = self.cat_name[cat].lower()
            form = self.rng.integers(0, 5)
            query = [tag, f"{tag} near me", f"{tag} {location}",
                     f"{name} in {location}", name][form]
            cat_filter = self.cat_name[cat] if self.rng.random() < 0.5 else ""
            loc_filter = location if self.rng.random() < 0.6 else ""
            span = max((last - first).total_seconds(), 3600)
            when = first - timedelta(hours=6) + timedelta(seconds=float(self.rng.random() * span))
            rows.append([uid, query, cat_filter, loc_filter, max(when, START)])
        return rows

    # --------------------------------------------------------------- build
    def build(self):
        prefs, searches, inter, test_keys = [], [], [], set()
        parents = self.users[(self.users.role == "user")
                             & self.users.segment_label_synthetic_only.notna()]
        for u in parents.itertuples():
            uid, seg, loc = int(u.user_id), u.segment_label_synthetic_only, u.location
            joined = datetime.strptime(u.created_at, "%Y-%m-%d %H:%M:%S")
            focus = self.focus_for(seg)

            declared = list(focus)
            extra = [c for c in SEGMENT_CATEGORIES[seg] if c not in focus]
            if extra and self.rng.random() < 0.35:
                declared.append(int(self.rng.choice(extra)))
            for c in declared:
                w = round(float(self.rng.uniform(0.8, 1.0) if c in focus
                                else self.rng.uniform(0.5, 0.75)), 2)
                prefs.append([uid, c, loc, w, joined])

            order = self.discover(seg, focus, loc)
            t = max(joined, START) + timedelta(hours=float(self.rng.uniform(1, 24 * 40)))
            user_rows = []
            for pid in order:
                rows, t = self.engage(uid, pid, seg, loc, t)
                user_rows += rows
                t += timedelta(hours=float(self.rng.uniform(6, 24 * 9)))
            # Squeeze a history that runs past the window back inside it.
            base, span = user_rows[0][5], user_rows[-1][5] - user_rows[0][5]
            if user_rows[-1][5] > END and span:
                scale = 0.98 * (END - base) / span
                for r in user_rows:
                    r[5] = base + (r[5] - base) * scale
            inter += user_rows

            if len(order) >= MIN_HISTORY:
                test_keys |= {(uid, p) for p in order[-TEST_PROVIDERS:]}

            searches += self.searches_for(uid, focus, loc, user_rows[0][5], user_rows[-1][5])

        # ---- tables, ids assigned in time order like a live database ----
        inter = pd.DataFrame(inter, columns=TABLE_COLUMNS["interactions"][1:])
        inter = inter.sort_values(["created_at", "user_id"], kind="stable").reset_index(drop=True)
        inter.insert(0, "interaction_id", np.arange(1, len(inter) + 1))
        inter["rating_value"] = inter.rating_value.astype("Int64")

        saved = (inter[inter.interaction_type == "save"]
                 .drop_duplicates(["user_id", "provider_id"])
                 [["user_id", "provider_id", "created_at"]]
                 .rename(columns={"created_at": "saved_at"}).reset_index(drop=True))
        saved.insert(0, "saved_id", np.arange(1, len(saved) + 1))

        searches = pd.DataFrame(searches, columns=TABLE_COLUMNS["search_history"][1:])
        searches = searches.sort_values(["searched_at", "user_id"], kind="stable").reset_index(drop=True)
        searches.insert(0, "search_id", np.arange(1, len(searches) + 1))

        prefs = pd.DataFrame(prefs, columns=TABLE_COLUMNS["user_preferences"][1:])
        prefs.insert(0, "preference_id", np.arange(1, len(prefs) + 1))

        for df, cols in ((inter, ["created_at"]), (saved, ["saved_at"]),
                         (searches, ["searched_at"]), (prefs, ["updated_at"])):
            for c in cols:
                df[c] = pd.to_datetime(df[c]).dt.strftime("%Y-%m-%d %H:%M:00")
        held = [(u, p) in test_keys for u, p in zip(inter.user_id, inter.provider_id)]
        test, train = inter[held], inter[[not h for h in held]]

        return {"user_preferences": prefs, "search_history": searches,
                "interactions": inter, "saved_services": saved,
                "interactions_train": train, "interactions_test": test}


# ------------------------------------------------------------------- output
def sql_value(v) -> str:
    if v is None or (isinstance(v, float) and np.isnan(v)) or v is pd.NA:
        return "NULL"
    if isinstance(v, (int, np.integer)):
        return str(int(v))
    if isinstance(v, (float, np.floating)):
        return repr(float(v))
    return "'" + str(v).replace("\\", "\\\\").replace("'", "''") + "'"


def sql_blocks(table: str, df: pd.DataFrame, chunk: int = 200) -> list[str]:
    cols = TABLE_COLUMNS[table]
    out = []
    for start in range(0, len(df), chunk):
        part = df.iloc[start:start + chunk][cols]
        rows = ["(" + ",".join(sql_value(v) for v in r) + ")"
                for r in part.astype(object).itertuples(index=False, name=None)]
        out.append(f"INSERT INTO {table} ({','.join(cols)}) VALUES\n"
                   + ",\n".join(rows) + ";\n")
    return out


def rewrite_sql(tables: dict[str, pd.DataFrame]) -> None:
    """Swap each regenerated table's INSERT statements in seed_data.sql,
    leaving every other statement exactly where it was."""
    text = SQL_FILE.read_text(encoding="utf-8")
    for table in TABLE_COLUMNS:
        pattern = re.compile(rf"INSERT INTO {table} \(.*?\);\n\n?", re.S)
        spans = [m.span() for m in pattern.finditer(text)]
        if not spans:
            raise RuntimeError(f"no INSERT INTO {table} in {SQL_FILE}")
        new = "\n".join(sql_blocks(table, tables[table])) + "\n"
        text = text[:spans[0][0]] + new + text[spans[-1][1]:]
    SQL_FILE.write_text(text, encoding="utf-8", newline="\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--no-sql", action="store_true", help="only write the CSVs")
    args = ap.parse_args()

    tables = Generator(args.seed).build()
    for name, df in tables.items():
        df.to_csv(SEED_DIR / f"{name}.csv", index=False)
    if not args.no_sql:
        rewrite_sql(tables)

    inter, test = tables["interactions"], tables["interactions_test"]
    print(f"interactions {len(inter)}  (train {len(tables['interactions_train'])}, "
          f"test {len(test)} across {test.user_id.nunique()} users)")
    print(f"searches {len(tables['search_history'])}  preferences "
          f"{len(tables['user_preferences'])}  saved {len(tables['saved_services'])}")
    print(inter.interaction_type.value_counts().to_dict())


if __name__ == "__main__":
    main()
