# -*- coding: utf-8 -*-
"""
Train, tune and evaluate the hybrid engine from the command line.

    python train.py                      # train with the configured encoder
    python train.py --tune               # grid search k and alpha first
    python train.py --compare-encoders   # neural vs TF-IDF+SVD, side by side
    python train.py --encoder sbert      # force sentence embeddings

Writes model/hybrid_model.joblib plus the tables Chapter Five needs.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
from pathlib import Path

import pandas as pd

from db import DataSource
from engine import HybridRecommender, EngineConfig
from encoders import build_encoder, sbert_available

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("train")

HERE = Path(__file__).resolve().parent
OUT = Path(os.getenv("MZAZI_MODEL_DIR", HERE.parent / "model"))


def cold_items(train: pd.DataFrame, provider_ids, threshold=12) -> set:
    pop = train.groupby("provider_id").size().to_dict()
    return {p for p in provider_ids if pop.get(p, 0) < threshold}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoder", default=None, help="sbert | tfidf | auto")
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--alpha", type=float, default=0.4)
    ap.add_argument("--top-n", type=int, default=10)
    ap.add_argument("--tune", action="store_true")
    ap.add_argument("--compare-encoders", action="store_true")
    ap.add_argument("--full", action="store_true",
                    help="train on all interactions (production model)")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    src = DataSource()
    frames = src.load()
    providers, categories = frames["providers"], frames["categories"]

    train = frames["interactions"] if args.full else src.training_interactions(frames)
    test = frames.get("interactions_test", pd.DataFrame())
    # Searches and declared preferences feed the preference vector (Section 4.8.1).
    side = dict(searches=frames.get("search_history"),
                preferences=frames.get("user_preferences"))

    print(f"providers {len(providers)}   train {len(train)}   test {len(test)}")
    print(f"sentence-transformers installed: {sbert_available()}")

    # ------------------------------------------------ encoder comparison
    if args.compare_encoders:
        rows = []
        for choice in ("tfidf", "sbert"):
            if choice == "sbert" and not sbert_available():
                print("\nskipping sbert - sentence-transformers not installed")
                continue
            cfg = EngineConfig(k=args.k, alpha=args.alpha, alpha_mode="fixed",
                               encoder=choice)
            eng = HybridRecommender(cfg, encoder=build_encoder(choice)).fit(
                providers, train, categories, **side)
            if len(test):
                cold = cold_items(train, eng.provider_ids)
                m = eng.evaluate(test, top_n=args.top_n)
                m_cold = eng.evaluate(test, top_n=args.top_n, alpha=1.0,
                                      only_items=cold)
                rows.append(dict(encoder=eng.encoder.name, dim=eng.encoder.dim,
                                 **m, cold_recall=m_cold["recall"]))
        if rows:
            df = pd.DataFrame(rows)
            print("\n" + df.to_string(index=False))
            df.to_csv(OUT / "encoder_comparison.csv", index=False)
            print(f"\nwritten {OUT / 'encoder_comparison.csv'}")
        return

    # ------------------------------------------------------------- train
    cfg = EngineConfig(k=args.k, alpha=args.alpha, alpha_mode="fixed",
                       alpha_source="train.py --alpha",
                       encoder=args.encoder or os.getenv("MZAZI_ENCODER", "auto"))
    eng = HybridRecommender(cfg).fit(providers, train, categories, **side)
    print(f"\nencoder: {eng.encoder.name}  ({eng.encoder.dim} dims)")
    print(f"matrix : {eng.n_users} users x {eng.n_items} providers, "
          f"density {eng.cfg.density_pct}%")

    if args.tune and len(test):
        grid, best = eng.tune(test, top_n=args.top_n)
        grid.to_csv(OUT / "tuning_results.csv", index=False)
        print(f"\ntuned  : k={eng.cfg.k}  alpha={eng.cfg.alpha}")
        print(grid.sort_values("recall", ascending=False).head(6).to_string(index=False))

    summary = {"encoder": eng.encoder.name, "config": eng.cfg.to_dict()}

    if len(test):
        cold = cold_items(train, eng.provider_ids)
        overall = eng.evaluate(test, top_n=args.top_n)
        content_only = eng.evaluate(test, top_n=args.top_n, alpha=1.0)
        collab_only = eng.evaluate(test, top_n=args.top_n, alpha=0.0)
        cold_content = eng.evaluate(test, top_n=args.top_n, alpha=1.0, only_items=cold)
        cold_collab = eng.evaluate(test, top_n=args.top_n, alpha=0.0, only_items=cold)

        table = pd.DataFrame([
            dict(model="content only (alpha=1)", **content_only),
            dict(model="collaborative only (alpha=0)", **collab_only),
            dict(model=f"hybrid (k={eng.cfg.k}, alpha={eng.cfg.alpha})", **overall),
        ])
        print("\n" + table.to_string(index=False))
        print(f"\nrecall@{args.top_n} on the {len(cold)} newest providers")
        print(f"  content only        {cold_content['recall']:.3f}")
        print(f"  collaborative only  {cold_collab['recall']:.3f}")
        print("  Collaborative filtering cannot reach a provider with no column")
        print("  in the user-item matrix - every new listing starts there.")

        table.to_csv(OUT / "model_comparison.csv", index=False)
        summary.update(metrics=overall, content_only=content_only,
                       collaborative_only=collab_only,
                       cold_items=len(cold),
                       cold_recall=dict(content=cold_content["recall"],
                                        collaborative=cold_collab["recall"]))

    eng.save(str(OUT / "hybrid_model.joblib"))
    (OUT / "model_card.json").write_text(json.dumps(summary, indent=2))
    print(f"\nsaved  {OUT / 'hybrid_model.joblib'}")
    print(f"       {OUT / 'model_card.json'}")


if __name__ == "__main__":
    main()
