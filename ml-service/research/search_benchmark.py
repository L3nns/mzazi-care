# -*- coding: utf-8 -*-
"""
Labelled search benchmark: keyword vs semantic vs thesaurus vs the enhanced
engine, on English, Kiswahili, mixed, location and out-of-scope queries.

    python -m research.search_benchmark            (from ml-service/)

Systems ("arms")
  keyword route         the live search route, GET /api/services, as it was
                        before Phase 7 (SEARCH_MODE=keyword), run against MySQL
                        by backend/scripts/served-search.js.
  keyword route + suggestions
                        the same, counting the "suggestions" a parent is
                        offered when the keyword search finds nothing.
  served search         the live route as it is now: free text matched by the
                        engine (SEARCH_MODE=semantic), filters in SQL.
  served search + suggestions
  The four served arms are included only when model/research/
  served_search_<mode>.json exists and its catalogue matches the CSV seed.
  bm25                  a standard lexical baseline (Okapi BM25).
  bm25 + thesaurus      the same over thesaurus-expanded text (synonyms.py).
  lsa + thesaurus       TF-IDF + SVD, the engine's fallback encoder.
  sbert                 sentence embeddings, no thesaurus.
  sbert + thesaurus     the engine's content scoring (thesaurus + query boost).
  enhanced              the engine as a search: place names parsed into an
                        area filter, relevance floor, no-match threshold and
                        the related-category slot (EngineConfig defaults).
  enhanced (tf-idf)     the same engine on the fallback encoder.

Labels (research/queries.csv) are category-level: a verified provider is
relevant when its category is acceptable for the query (grade 2 for the
primary categories, 1 for the "also" ones) and, for a query naming a place,
it serves that place. Queries were written by the developer, not collected
from parents, and split dev/test before any system was run. Cut-offs are
chosen on dev; every headline number is on test.

Every system returns an empty list when it finds no match (BM25: no shared
term; embeddings: best cosine under the encoder's threshold; engine: no
candidate above the threshold), so out-of-scope queries test rejection.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import re
import time
from collections import Counter

import numpy as np
import pandas as pd

from research.common import HERE, out_path, md_table, data_hash, environment
from research.stats import bootstrap_ci, paired, holm, fmt_ci

from db import DataSource                                     # noqa: E402
from engine import HybridRecommender, EngineConfig            # noqa: E402
from encoders import SbertEncoder, TfidfSvdEncoder, sbert_available  # noqa: E402
from synonyms import expand                                   # noqa: E402

K = 10
METRICS = ["ndcg", "r10", "p10", "mrr", "cat_acc"]
REFERENCE = "enhanced"


# ------------------------------------------------------------------ data
def load_queries(path=HERE / "queries.csv") -> pd.DataFrame:
    q = pd.read_csv(path, dtype=str, keep_default_na=False)
    ids = lambda s: {int(x) for x in s.split(";") if x}          # noqa: E731
    q["primary_ids"] = q.primary.map(ids)
    q["also_ids"] = q.also.map(ids)
    q["answerable"] = q.subset != "no_match"
    return q


def fit_engine(frames, encoder, **cfg) -> HybridRecommender:
    src = DataSource("csv")
    config = EngineConfig(k=20, alpha=1.0, alpha_mode="fixed", **cfg)
    return HybridRecommender(config, encoder=encoder).fit(
        frames["providers"], src.training_interactions(frames), frames["categories"],
        searches=frames.get("search_history"), preferences=frames.get("user_preferences"),
        areas=frames.get("service_areas"), provider_areas=frames.get("provider_service_areas"),
        users=frames.get("users"))


# ------------------------------------------------- place names (areas.js)
CONNECTORS = ["near me in", "near", "in", "at", "around", "within", "close to",
              "karibu na", "karibu", "katika", "huko", "eneo la", "mtaa wa"]
_NONLETTER = r"[\W\d_]"
_CONN = re.compile(r"(?:^|\s)(?:" + "|".join(map(re.escape, CONNECTORS)) + r")\s*$", re.I)


def extract_location(text: str, area_names) -> tuple[str, str] | None:
    """Port of backend/services/areas.js extractLocation: longest name first,
    whole words only; drops a connector ("near", "karibu na") before it.
    Checked against the live route's output when served_search.json exists."""
    for name in sorted(area_names, key=len, reverse=True):
        body = r"\s+".join(map(re.escape, name.split()))
        m = re.search(rf"(^|{_NONLETTER})({body})(?=$|{_NONLETTER})", text, re.I)
        if not m:
            continue
        before, after = text[:m.start(2)], text[m.end(2):]
        before = _CONN.sub(" ", before, count=1)
        rest = re.sub(r"\s+", " ", f"{before} {after}")
        rest = re.sub(r"^[\s,.-]+|[\s,.-]+$", "", rest)
        return name, rest
    return None


# --------------------------------------------------------------- relevance
def relevance(engine, row) -> dict[int, int]:
    area = row.area.lower() if row.area else None
    rel = {}
    for i, pid in enumerate(engine.provider_ids):
        c = int(engine.item_cats[i])
        g = 2 if c in row.primary_ids else 1 if c in row.also_ids else 0
        if g and area and area not in engine.item_areas[i]:
            g = 0
        if g:
            rel[pid] = g
    return rel


def score_query(ranked, rel, cat_of, ok_cats, k=K) -> dict:
    ranked = list(ranked)[:k]
    gains = [rel.get(p, 0) for p in ranked]
    hits = sum(g > 0 for g in gains)
    dcg = sum((2 ** g - 1) / math.log2(i + 2) for i, g in enumerate(gains))
    ideal = sorted(rel.values(), reverse=True)[:k]
    idcg = sum((2 ** g - 1) / math.log2(i + 2) for i, g in enumerate(ideal))
    return dict(ndcg=dcg / idcg if idcg else 0.0, r10=hits / len(rel) if rel else 0.0,
                p10=hits / k, mrr=next((1 / (i + 1) for i, g in enumerate(gains) if g), 0.0),
                cat_acc=float(bool(ranked) and cat_of[ranked[0]] in ok_cats),
                list_precision=hits / len(ranked) if ranked else 0.0,
                empty=float(not ranked), returned=len(ranked))


# -------------------------------------------------------------------- arms
_STOP = set("""a about an and are as at be by for from how i in is it me my of on or
that the this to was what when where who will with we our you your someone need
looking find near help want please ya wa na kwa la za cha vya ni""".split())


class BM25:
    """Okapi BM25 (k1 = 1.2, b = 0.75). `prepare` runs on documents and
    queries alike; the thesaurus arm passes synonyms.expand."""

    def __init__(self, docs, prepare=None, k1=1.2, b=0.75):
        self.prepare, self.k1, self.b = prepare or (lambda t: t), k1, b
        toks = [self.tokens(d) for d in docs]
        self.tf = [Counter(t) for t in toks]
        self.dl = np.array([len(t) for t in toks], dtype=float)
        self.avgdl = float(self.dl.mean())
        self.df = Counter(w for t in toks for w in set(t))
        self.n = len(docs)

    def tokens(self, text):
        return [w for w in re.findall(r"\w+", self.prepare(text).lower())
                if len(w) > 1 and w not in _STOP]

    def scores(self, query) -> np.ndarray:
        s = np.zeros(self.n)
        for w in set(self.tokens(query)):
            df = self.df.get(w)
            if not df:
                continue
            idf = math.log(1 + (self.n - df + 0.5) / (df + 0.5))
            for i, tf in enumerate(self.tf):
                f = tf.get(w)
                if f:
                    s[i] += idf * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * self.dl[i] / self.avgdl))
        return s


def ranked_from(scores, ids, accept) -> list[int]:
    if not accept(scores):
        return []
    order = np.argsort(-scores, kind="stable")[:K]
    return [ids[i] for i in order]


@contextlib.contextmanager
def configured(engine, **cfg):
    old = {k: getattr(engine.cfg, k) for k in cfg}
    for k, v in cfg.items():
        setattr(engine.cfg, k, v)
    try:
        yield engine
    finally:
        for k, v in old.items():
            setattr(engine.cfg, k, v)


def engine_search(engine, text, areas, parse=True) -> list[int]:
    found = extract_location(text, areas) if parse else None
    query, location = (found[1] or None, found[0]) if found else (text, None)
    res = engine.recommend(query=query, location=location, top_n=K)
    if res["strategy"] == "popularity_fallback":
        return []
    return [r["provider_id"] for r in res["results"]]


def build_arms(frames, queries, served):
    """name -> callable(row) -> ranked provider ids ([] = no match)."""
    arms, engines = {}, {}
    use_sbert = sbert_available()
    main = fit_engine(frames, SbertEncoder() if use_sbert else TfidfSvdEncoder())
    engines["main"] = main
    ids, texts = main.provider_ids, main.content_text
    areas = list(frames["service_areas"].area_name)

    # (ranker, recorded latency): these ran in served-search.js, so the time
    # is the one measured there, not the time to read the file.
    for mode, name in (("keyword", "keyword route"), ("semantic", "served search")):
        if mode not in served:
            continue
        by_qid = {q["qid"]: q for q in served[mode]["queries"]}
        took = lambda r, b=by_qid: b[r.qid]["ms"]                         # noqa: E731
        arms[name] = (lambda r, b=by_qid: b[r.qid]["results"][:K], took)
        arms[name + " + suggestions"] = (
            lambda r, b=by_qid: (b[r.qid]["results"] or b[r.qid]["suggestions"])[:K], took)

    plain = BM25(texts)
    thes = BM25(texts, prepare=lambda t: expand(t, repeat=1))
    arms["bm25"] = lambda r: ranked_from(plain.scores(r.query), ids, lambda s: s.max() > 0)
    arms["bm25 + thesaurus"] = lambda r: ranked_from(thes.scores(r.query), ids, lambda s: s.max() > 0)

    lsa = TfidfSvdEncoder().fit(texts)
    lsa_items = lsa.encode(texts)
    arms["lsa + thesaurus"] = lambda r: ranked_from(
        lsa_items @ lsa.encode_one(r.query), ids, lambda s: s.max() >= lsa.default_min_similarity)

    if use_sbert:
        sb = SbertEncoder(expand=False).fit(texts)
        sb_items = sb.encode(texts)
        arms["sbert"] = lambda r: ranked_from(
            sb_items @ sb.encode_one(r.query), ids, lambda s: s.max() >= sb.default_min_similarity)
        arms["sbert + thesaurus"] = lambda r: ranked_from(
            main.item_vectors @ main.encoder.encode_one(r.query), ids,
            lambda s: s.max() >= main.min_similarity)

    arms[REFERENCE] = lambda r: engine_search(main, r.query, areas)
    if use_sbert:
        tf_engine = fit_engine(frames, TfidfSvdEncoder())
        engines["tfidf"] = tf_engine
        arms["enhanced (tf-idf)"] = lambda r: engine_search(tf_engine, r.query, areas)
    return arms, engines, areas


# ----------------------------------------------------------------- served
def load_served(frames, allow_mismatch=False):
    """{mode: recording} for each served recording that matches the seed, and notes."""
    out, notes = {}, []
    for mode in ("keyword", "semantic"):
        rec, note = _load_one(frames, mode, allow_mismatch)
        notes.append(f"{mode} route: {note}")
        if rec:
            out[mode] = rec
    return out, notes


def _load_one(frames, mode, allow_mismatch):
    path = out_path(f"served_search_{mode}.json")
    if not path.exists():
        return None, f"not run (no {path.name}; run `npm run benchmark:served` in backend/)"
    served = json.loads(path.read_text(encoding="utf-8"))
    p = frames["providers"]
    p = p[p.verification_status == "verified"]
    mine = {int(r.provider_id): hashlib.md5("|".join([
        str(r.provider_name), str(int(r.category_id)),
        "" if pd.isna(r.location) else str(r.location),
        "" if pd.isna(r.service_description) else str(r.service_description),
        "" if pd.isna(r.service_tags) else str(r.service_tags)]).encode("utf-8")).hexdigest()
        for r in p.itertuples(index=False)}
    theirs = {int(k): v for k, v in served["catalogue"].items()}
    differ = sorted(set(mine) ^ set(theirs) | {k for k in set(mine) & set(theirs) if mine[k] != theirs[k]})
    # Areas a verified provider serves in MySQL beyond its own location; the
    # CSV seed records only the location.
    own = dict(zip(p.provider_id.astype(int), p.location.fillna("").str.lower()))
    extra = sorted(int(k) for k, v in served.get("areas", {}).items()
                   if int(k) in own and {a.lower() for a in v} - {own[int(k)]})
    fell_back = sum(1 for q in served["queries"] if q.get("search_mode") not in (None, mode))
    note = (f"run {served['generated_at']}, engine "
            f"{'(' + str(served['engine'].get('version')) + ')' if served['engine']['reachable'] else 'NOT reachable (SQL fallback)'}"
            + (f"; WARNING {fell_back} queries fell back to keyword search" if fell_back else ""))
    if differ or extra:
        msg = (f"MySQL catalogue differs from the CSV seed: {len(differ)} providers differ "
               f"{differ[:10]}, {len(extra)} serve extra areas {extra[:10]}")
        if not allow_mismatch:
            return None, msg + " - served arms left out"
        note += "; WARNING " + msg
    return served, note


# --------------------------------------------------------------------- run
def run_arms(arms, queries, engines):
    cat_of = {pid: int(c) for pid, c in zip(engines["main"].provider_ids, engines["main"].item_cats)}
    rows = []
    for name, spec in arms.items():
        fn, recorded = spec if isinstance(spec, tuple) else (spec, None)
        for e in engines.values():                 # no cached query vectors between arms
            getattr(e.encoder, "_cache", {}).clear()
        fn(queries.iloc[0])                         # warm-up, untimed
        for e in engines.values():
            getattr(e.encoder, "_cache", {}).clear()
        for r in queries.itertuples(index=False):
            t0 = time.perf_counter()
            ranked = fn(r)
            ms = recorded(r) if recorded else (time.perf_counter() - t0) * 1000
            rel = relevance(engines["main"], r)
            m = score_query(ranked, rel, cat_of, r.primary_ids | r.also_ids)
            rows.append(dict(arm=name, qid=r.qid, split=r.split, subset=r.subset,
                             answerable=r.answerable, ms=ms, n_relevant=len(rel),
                             top=";".join(map(str, ranked[:3])), **m))
    return pd.DataFrame(rows)


def summarise(per, split="test"):
    ans = per[(per.split == split) & per.answerable]
    rej = per[(per.split == split) & ~per.answerable]
    out = []
    for arm, g in ans.groupby("arm", sort=False):
        row = dict(arm=arm, queries=len(g))
        for m in METRICS:
            row[m], row[m + "_lo"], row[m + "_hi"] = bootstrap_ci(g[m])
        row["empty"] = g["empty"].mean()
        r = rej[rej.arm == arm]
        row["no_match_rejected"], row["rej_lo"], row["rej_hi"] = bootstrap_ci(r["empty"])
        row["no_match_queries"] = len(r)
        lat = per[per.arm == arm].ms
        row["ms_median"], row["ms_p95"] = float(lat.median()), float(lat.quantile(0.95))
        out.append(row)
    return pd.DataFrame(out)


def by_subset(per, split="test", metric="ndcg"):
    ans = per[(per.split == split) & per.answerable]
    t = ans.pivot_table(index="arm", columns="subset", values=metric, aggfunc="mean", sort=False)
    t["all"] = ans.groupby("arm", sort=False)[metric].mean()
    return t.reset_index()


def paired_vs(per, reference=REFERENCE, split="test", metric="ndcg"):
    ans = per[(per.split == split) & per.answerable].sort_values("qid")
    ref = ans[ans.arm == reference][metric].to_numpy()
    rows = []
    for arm in ans.arm.unique():
        if arm == reference:
            continue
        other = ans[ans.arm == arm][metric].to_numpy()
        rows.append(dict(comparison=f"{reference} - {arm}", **paired(ref, other)))
    # Before and after Phase 7 on the live route, when both were recorded.
    arms = set(ans.arm)
    for new, old in (("served search", "keyword route"),
                     ("served search + suggestions", "keyword route + suggestions")):
        if {new, old} <= arms:
            rows.append(dict(comparison=f"{new} - {old}",
                             **paired(ans[ans.arm == new][metric].to_numpy(),
                                      ans[ans.arm == old][metric].to_numpy())))
    df = pd.DataFrame(rows)
    if len(df):
        df["p_holm"] = holm(df.p)
    return df


# --------------------------------------------- cut-offs, chosen on dev only
def sweep_floor(engine, queries, areas, ratios=(0.0, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95)):
    cat_of = dict(zip(engine.provider_ids, map(int, engine.item_cats)))
    rows = []
    for ratio in ratios:
        with configured(engine, query_relevance_ratio=ratio):
            for r in queries[queries.answerable].itertuples(index=False):
                m = score_query(engine_search(engine, r.query, areas), relevance(engine, r),
                                cat_of, r.primary_ids | r.also_ids)
                rows.append(dict(ratio=ratio, split=r.split, **m))
    df = pd.DataFrame(rows).groupby(["split", "ratio"]).mean(numeric_only=True).reset_index()
    p, rr = df.list_precision, df.r10
    df["f1"] = np.where(p + rr > 0, 2 * p * rr / (p + rr), 0.0)
    return df


def sweep_threshold(engine, queries, areas, values=(0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45)):
    rows = []
    for v in values:
        with configured(engine, min_similarity=v):
            for r in queries.itertuples(index=False):
                empty = not engine_search(engine, r.query, areas)
                rows.append(dict(threshold=v, split=r.split, answerable=r.answerable, empty=empty))
    df = pd.DataFrame(rows)
    out = []
    for (split, v), g in df.groupby(["split", "threshold"]):
        fr = g[g.answerable]["empty"].mean()
        cr = g[~g.answerable]["empty"].mean()
        out.append(dict(split=split, threshold=v, false_rejection=fr, correct_rejection=cr,
                        balanced_accuracy=(1 - fr + cr) / 2))
    return pd.DataFrame(out)


def choose(df, key, column, current, margin):
    """The dev value that maximises `key`; the current value stays unless the
    best beats it on dev by more than `margin` (a small dev set is noisy)."""
    dev = df[df.split == "dev"].set_index(column)[key]
    best = float(dev.idxmax())
    if current in dev.index and dev[best] - dev[current] <= margin:
        return current, f"the dev rule keeps the current {current} (best dev value {best} is within {margin} of it)"
    return best, f"the dev rule selects {best} over the current {current} (dev {key} {dev[best]:.3f} vs {dev.get(current, float('nan')):.3f} at {current}); adopting it is a separate decision, see FINDINGS.md"


def ablation(engine, queries, areas, frames):
    cat_of = dict(zip(engine.provider_ids, map(int, engine.item_cats)))
    test = queries[(queries.split == "test") & queries.answerable]
    variants = {
        "full": lambda r: engine_search(engine, r.query, areas),
        "no relevance floor": lambda r: _with(engine, dict(query_relevance_ratio=0.0), r, areas),
        "no place parsing": lambda r: engine_search(engine, r.query, areas, parse=False),
        "no related-category slot": lambda r: _with(engine, dict(diversity_share=0.0), r, areas),
    }
    if sbert_available():
        bare = fit_engine(frames, SbertEncoder(expand=False))
        variants["no thesaurus"] = lambda r: engine_search(bare, r.query, areas)
    rows = []
    for name, fn in variants.items():
        for r in test.itertuples(index=False):
            m = score_query(fn(r), relevance(engine, r), cat_of, r.primary_ids | r.also_ids)
            rows.append(dict(variant=name, qid=r.qid, subset=r.subset, **m))
    per = pd.DataFrame(rows)
    full = per[per.variant == "full"].sort_values("qid")
    out = []
    for name in variants:
        g = per[per.variant == name].sort_values("qid")
        row = dict(variant=name)
        for m in ("ndcg", "list_precision", "r10"):
            row[m] = g[m].mean()
        if name != "full":
            c = paired(full.ndcg.to_numpy(), g.ndcg.to_numpy())
            row.update(ndcg_change=-c["diff"], change_lo=-c["high"], change_hi=-c["low"], p=c["p"])
        out.append(row)
    df = pd.DataFrame(out)
    mask = df.variant != "full"
    df.loc[mask, "p_holm"] = holm(df.loc[mask, "p"])
    return df


def _with(engine, cfg, r, areas):
    with configured(engine, **cfg):
        return engine_search(engine, r.query, areas)


# ------------------------------------------------------------------ report
def run(allow_mismatch=False):
    frames = DataSource("csv").load()
    queries = load_queries()
    served, served_note = load_served(frames, allow_mismatch)
    arms, engines, areas = build_arms(frames, queries, served)
    main = engines["main"]

    parity = None
    if served:
        any_run = next(iter(served.values()))
        by_qid = {q["qid"]: (q["understood"] or {}).get("location") for q in any_run["queries"]}
        mism = [r.qid for r in queries.itertuples(index=False)
                if (extract_location(r.query, areas) or (None,))[0] != by_qid.get(r.qid)]
        parity = f"place parsing: Python port agrees with the live route on {len(queries) - len(mism)}/{len(queries)} queries" \
            + (f" (differs: {', '.join(mism)})" if mism else "")

    per = run_arms(arms, queries, engines)
    per.to_csv(out_path("search_per_query.csv"), index=False)

    floor = sweep_floor(main, queries, areas)
    floor.to_csv(out_path("search_floor_sweep.csv"), index=False)
    floor_pick, floor_note = choose(floor, "f1", "ratio", main.relevance_ratio, 0.02)
    thr = sweep_threshold(main, queries, areas)
    thr.to_csv(out_path("search_threshold_sweep.csv"), index=False)
    thr_pick, thr_note = choose(thr, "balanced_accuracy", "threshold", main.min_similarity, 0.05)

    summary = summarise(per)
    summary.to_csv(out_path("search_summary.csv"), index=False)
    subsets = by_subset(per)
    subsets.to_csv(out_path("search_by_subset.csv"), index=False)
    pairs = paired_vs(per)
    pairs.to_csv(out_path("search_paired.csv"), index=False)
    abl = ablation(main, queries, areas, frames)
    abl.to_csv(out_path("search_ablation.csv"), index=False)
    dev_summary = summarise(per, split="dev")
    dev_summary.to_csv(out_path("search_summary_dev.csv"), index=False)

    n_test = queries[queries.split == "test"]
    counts = n_test.groupby("subset").size().to_dict()
    lines = [
        "## Search benchmark",
        "",
        f"{len(queries)} labelled queries ({(queries.split == 'dev').sum()} dev, {len(n_test)} test); "
        f"test subsets: {', '.join(f'{k} {v}' for k, v in counts.items())}. "
        f"Catalogue: {len(main.provider_ids)} verified providers (seed data {data_hash('providers.csv', 'categories.csv')}). "
        f"Main encoder: `{main.encoder.name}`.",
        "",
        *[f"- Served {n}." for n in served_note],
    ]
    if parity:
        lines.append(f"- {parity}.")
    lines += [
        "",
        "### Test split, answerable queries (mean, 95% bootstrap interval over queries)",
        "",
        md_table(pd.DataFrame(dict(
            system=summary.arm, n=summary.queries,
            **{f"{m}@10" if m in ("ndcg", "p10", "r10") else m:
               [fmt_ci(a, b, c) for a, b, c in zip(summary[m], summary[m + "_lo"], summary[m + "_hi"])]
               for m in METRICS},
            empty=summary["empty"].round(3)))
            .rename(columns={"p10@10": "P@10", "r10@10": "R@10", "ndcg@10": "nDCG@10",
                             "mrr": "MRR", "cat_acc": "category acc."})),
        "",
        "`empty`: share of answerable queries for which the system returned nothing.",
        "",
        "### Out-of-scope queries rejected (test) and latency (all queries)",
        "",
        md_table(pd.DataFrame(dict(
            system=summary.arm,
            rejected=[fmt_ci(a, b, c) for a, b, c in zip(summary.no_match_rejected, summary.rej_lo, summary.rej_hi)],
            n=summary.no_match_queries,
            median_ms=summary.ms_median.round(1), p95_ms=summary.ms_p95.round(1)))),
        "",
        "Latency is per query on this machine, after one warm-up query, with no cached query "
        "vectors. The served arms' time is the whole request (HTTP, the route's SQL, the engine call "
        "where there is one, and suggestions when nothing matched); the others are in-process. "
        "The \"+ suggestions\" arms never reject a query by design: when nothing matches, the page "
        "shows suggestions, labelled as such, instead of results.",
        "",
        "### nDCG@10 by query type (test)",
        "",
        md_table(subsets),
        "",
        f"### Paired comparison on nDCG@10 (test, n = {int(pairs.n.iloc[0]) if len(pairs) else 0} queries)",
        "",
        md_table(pairs[["comparison", "diff", "low", "high", "wins", "losses", "ties", "p", "p_holm"]]
                 if len(pairs) else pairs),
        "",
        "`diff` is the mean per-query difference with its paired bootstrap interval; `p` is the "
        "two-sided Wilcoxon signed-rank test; `p_holm` corrects for the number of comparisons.",
        "",
        "### Ablation of the enhanced engine (test, answerable)",
        "",
        md_table(abl),
        "",
        "`ndcg_change`: the variant minus the full engine. `list_precision`: relevant share of what was "
        "returned (an empty list counts as 0).",
        "",
        "### Cut-offs, chosen on the dev split",
        "",
        f"Relevance floor (share of the best match a result must reach): {floor_note}.",
        "",
        md_table(floor[["split", "ratio", "list_precision", "r10", "ndcg", "f1", "empty"]]),
        "",
        f"No-match threshold (minimum cosine similarity): {thr_note}.",
        "",
        md_table(thr),
        "",
    ]
    return "\n".join(lines), dict(floor=floor_pick, threshold=thr_pick, environment=environment())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--allow-mismatch", action="store_true",
                    help="keep the served arms even if MySQL differs from the CSV seed")
    args = ap.parse_args()
    text, picks = run(args.allow_mismatch)
    path = out_path("search_benchmark.md")
    path.write_text(text, encoding="utf-8")
    print(text)
    print(f"\nchosen on dev: {picks['floor']=}, {picks['threshold']=}")
    print(f"written {path}")


if __name__ == "__main__":
    main()
