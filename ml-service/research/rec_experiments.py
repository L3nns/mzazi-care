# -*- coding: utf-8 -*-
"""
Recommendation baselines, the diversity (MMR) experiment, and confidence
intervals, on the seeded train/test split.

    python -m research.rec_experiments [--encoder sbert|tfidf]   (from ml-service/)

Protocol (the same as a live retrain, ml-service/app.py _select):
  1. A validation split is cut from the TRAINING period (each user's most
     recent training interaction held out).
  2. alpha, the location/quality weights and the MMR lambda are chosen on it.
  3. The engine is refitted on all training data and scored once on the test
     split. Nothing in step 2 sees the test split.

Systems: random, popularity (most-interacted, unseen), content only (alpha=1),
collaborative only (alpha=0), hybrid (alpha from validation), hybrid on the
TF-IDF+SVD encoder, and enhanced (hybrid + the chosen ranking weights and MMR).
Metrics @10 per user, with 95% bootstrap intervals over users and paired
comparisons against the hybrid (Wilcoxon signed-rank, Holm-corrected).
"""
from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

from research.common import out_path, md_table, data_hash, environment
from research.stats import bootstrap_ci, paired, holm, fmt_ci, SEED

from db import DataSource                                          # noqa: E402
from engine import HybridRecommender, EngineConfig, holdout_split  # noqa: E402
from encoders import build_encoder, TfidfSvdEncoder                # noqa: E402

TOP_N = 10
LAMBDAS = (1.0, 0.9, 0.8, 0.7, 0.5, 0.3)
MMR_TOLERANCE = 0.01          # the same recall tolerance as the promotion gate
PER_USER = ["recall", "ndcg", "precision", "mrr"]
CATALOGUE = ["coverage", "diversity", "categories"]


def side(frames):
    return dict(searches=frames.get("search_history"), preferences=frames.get("user_preferences"),
                areas=frames.get("service_areas"), provider_areas=frames.get("provider_service_areas"),
                users=frames.get("users"))


def fit(frames, train, encoder, **cfg):
    config = EngineConfig(k=int(os.getenv("MZAZI_K", 20)), alpha_mode="fixed",
                          min_interactions=int(os.getenv("MZAZI_MIN_INTERACTIONS", 3)), **cfg)
    return HybridRecommender(config, encoder=encoder).fit(
        frames["providers"], train, frames["categories"], **side(frames))


def select(frames, train, encoder):
    """Everything chosen on validation. Returns (choices, tables)."""
    val_train, val_test = holdout_split(train, int(os.getenv("MZAZI_MIN_INTERACTIONS", 3)))
    sel = fit(frames, val_train, encoder, alpha=1.0)
    alpha, alpha_grid = sel.review_alpha(val_test, top_n=TOP_N)
    sel.cfg.alpha = float(alpha)
    weights, ranking_grid = sel.tune_ranking(val_test, top_n=TOP_N)
    mmr_rows = []
    for lam in LAMBDAS:
        m = sel.evaluate(val_test, top_n=TOP_N, overrides=dict(mmr_lambda=lam))
        mmr_rows.append(dict(split="validation", mmr_lambda=lam, **m))
    mmr_val = pd.DataFrame(mmr_rows)
    plain = float(mmr_val.loc[mmr_val.mmr_lambda == 1.0, "recall"].iloc[0])
    ok = mmr_val[mmr_val.recall >= plain - MMR_TOLERANCE]
    lam = float(ok.sort_values(["diversity", "mmr_lambda"], ascending=[False, False]).mmr_lambda.iloc[0])
    return (dict(alpha=float(alpha), validation_users=int(len(val_test)), mmr_lambda=lam, **weights),
            dict(alpha=alpha_grid, ranking=ranking_grid, mmr=mmr_val))


def baselines(engine, train):
    seen = train.groupby("user_id").provider_id.apply(lambda s: set(map(int, s))).to_dict()
    ids = np.array(engine.provider_ids)
    pop_order = ids[np.argsort(-engine.popularity, kind="stable")]

    def popularity(uid, n):
        s = seen.get(uid, set())
        return [int(p) for p in pop_order if int(p) not in s][:n]

    def random(uid, n):
        rng = np.random.default_rng(SEED + int(uid))
        s = seen.get(uid, set())
        pool = [int(p) for p in ids if int(p) not in s]
        return list(rng.choice(pool, size=min(n, len(pool)), replace=False))
    return dict(random=random, popularity=popularity)


def run(encoder_choice=None):
    src = DataSource("csv")
    frames = src.load()
    train = src.training_interactions(frames)
    test = frames["interactions_test"]
    encoder = build_encoder(encoder_choice)

    choices, grids = select(frames, train, encoder)
    eng = fit(frames, train, encoder, alpha=choices["alpha"],
              location_weight=choices["location_weight"], quality_weight=choices["quality_weight"])
    tf_choices, _ = select(frames, train, TfidfSvdEncoder())
    tf_eng = fit(frames, train, TfidfSvdEncoder(), alpha=tf_choices["alpha"])

    base = baselines(eng, train)
    systems = {
        "random": dict(engine=eng, kw=dict(ranker=base["random"])),
        "popularity": dict(engine=eng, kw=dict(ranker=base["popularity"])),
        "content only (alpha=1)": dict(engine=eng, kw=dict(alpha=1.0)),
        "collaborative only (alpha=0)": dict(engine=eng, kw=dict(alpha=0.0)),
        f"hybrid (alpha={choices['alpha']})": dict(engine=eng, kw={}),
        f"hybrid, tf-idf encoder (alpha={tf_choices['alpha']})": dict(engine=tf_eng, kw={}),
        f"enhanced (hybrid + MMR lambda={choices['mmr_lambda']})":
            dict(engine=eng, kw=dict(overrides=dict(mmr_lambda=choices["mmr_lambda"]))),
    }
    hybrid = f"hybrid (alpha={choices['alpha']})"

    results, per_user = [], {}
    for name, s in systems.items():
        m = s["engine"].evaluate(test, top_n=TOP_N, per_user=True, space=eng, **s["kw"])
        pu = pd.DataFrame(m.pop("per_user")).set_index("user_id").sort_index()
        per_user[name] = pu
        row = dict(system=name, users=m["users"])
        for k in PER_USER:
            row[k], row[k + "_lo"], row[k + "_hi"] = bootstrap_ci(pu[k])
        row.update({k: m[k] for k in CATALOGUE})
        results.append(row)
    res = pd.DataFrame(results)
    res.to_csv(out_path("rec_systems.csv"), index=False)
    pd.concat({k: v for k, v in per_user.items()}, names=["system"]).to_csv(out_path("rec_per_user.csv"))

    # Users whose "collaborative only" list is really content-based: too little
    # history for neighbours, so the engine falls back (alpha is forced to 1).
    test_users = set(per_user[hybrid].index)
    thin = sum(1 for u in test_users
               if eng.interaction_counts.get(u, 0) < eng.cfg.min_interactions)

    pairs = []
    for name in systems:
        if name == hybrid:
            continue
        for k in ("recall", "ndcg"):
            a, b = per_user[hybrid][k], per_user[name][k].reindex(per_user[hybrid].index)
            pairs.append(dict(comparison=f"hybrid - {name}", metric=k, **paired(a, b)))
    pairs = pd.DataFrame(pairs)
    pairs["p_holm"] = holm(pairs.p)
    pairs.to_csv(out_path("rec_paired.csv"), index=False)

    mmr_test = pd.DataFrame([dict(split="test", mmr_lambda=lam,
                                  **{k: v for k, v in eng.evaluate(
                                      test, top_n=TOP_N, overrides=dict(mmr_lambda=lam)).items()})
                             for lam in LAMBDAS])
    mmr = pd.concat([grids["mmr"], mmr_test], ignore_index=True)
    mmr.to_csv(out_path("rec_mmr.csv"), index=False)
    grids["alpha"].to_csv(out_path("rec_alpha_validation.csv"), index=False)
    grids["ranking"].to_csv(out_path("rec_ranking_validation.csv"), index=False)

    cols = ["split", "mmr_lambda", "recall", "ndcg", "diversity", "categories", "coverage"]
    lines = [
        "## Recommendation experiments",
        "",
        f"Seeded split: {len(train)} training and {len(test)} test interactions "
        f"(data {data_hash('interactions_train.csv', 'interactions_test.csv', 'providers.csv')}); "
        f"{choices['validation_users']} validation users cut from the training period. "
        f"Main encoder: `{eng.encoder.name}`; k = {eng.cfg.k}.",
        "",
        f"Chosen on validation: alpha = {choices['alpha']} (TF-IDF encoder: {tf_choices['alpha']}), "
        f"location weight = {choices['location_weight']}, quality weight = {choices['quality_weight']}, "
        f"MMR lambda = {choices['mmr_lambda']} (the most diverse setting whose recall is within "
        f"{MMR_TOLERANCE} of lambda = 1).",
        "",
        f"### Test split, @{TOP_N} (mean, 95% bootstrap interval over users)",
        "",
        md_table(pd.DataFrame(dict(
            system=res.system, users=res.users,
            **{k: [fmt_ci(a, b, c) for a, b, c in zip(res[k], res[k + "_lo"], res[k + "_hi"])] for k in PER_USER},
            **{k: res[k] for k in CATALOGUE}))),
        "",
        f"`coverage`: share of the catalogue recommended to anyone. `diversity`: mean intra-list "
        f"dissimilarity, measured with the main encoder's vectors for every system. `categories`: distinct categories per list. "
        f"{thin} of {len(test_users)} test users have fewer than {eng.cfg.min_interactions} training "
        f"interactions; for them \"collaborative only\" falls back to content, as the live engine does.",
        "",
        "### Paired comparison against the hybrid (test)",
        "",
        md_table(pairs[["comparison", "metric", "diff", "low", "high", "wins", "losses", "ties", "p", "p_holm"]]),
        "",
        "### Diversity re-ranking (MMR)",
        "",
        md_table(mmr[cols]),
        "",
    ]
    return "\n".join(lines), dict(choices=choices, environment=environment())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--encoder", default=None, help="sbert | tfidf | auto (default: MZAZI_ENCODER)")
    args = ap.parse_args()
    text, info = run(args.encoder)
    path = out_path("rec_experiments.md")
    path.write_text(text, encoding="utf-8")
    print(text)
    print(f"written {path}")


if __name__ == "__main__":
    main()
