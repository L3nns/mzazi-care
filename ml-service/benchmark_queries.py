# -*- coding: utf-8 -*-
"""
Query-level benchmark for the content encoders: does a parent's query, typed
the way a parent would type it, reach the right category?

    python benchmark_queries.py               # every installed encoder

The 28 queries are a small, hand-written set: indicative, not conclusive.
Replace or extend them with real queries from stakeholder testing.

Unlike the recall@10 evaluation in train.py, which replays the synthetic
interaction log, this measures the vocabulary-mismatch case directly - in
English and in Kiswahili. Writes model/query_benchmark.csv.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
import pandas as pd

from db import DataSource
from encoders import SbertEncoder, TfidfSvdEncoder, sbert_available

# (query, acceptable category ids). Written to avoid the listings' own words.
QUERIES = [
    ("someone to help me breastfeed", {12, 13}),
    ("my baby won't latch properly", {12, 13}),
    ("I feel sad since my baby was born", {14}),
    ("vaccines for my baby", {18}),
    ("someone to look after my toddler at home", {22}),
    ("a place to leave my child during work hours", {23}),
    ("help with baby sleep and tantrums", {24}),
    ("pregnancy check-up", {5}),
    ("someone to support me during labour", {9, 8}),
    ("my child has autism", {21}),
    ("what to eat while pregnant", {15}),
    ("exercise after giving birth", {16}),
    ("midwife for a home birth", {8}),
    ("weaning my baby onto solids", {19}),
    ("high risk pregnancy specialist", {7}),
    ("classes to prepare for birth", {6}),
    ("nurse to help at home after delivery", {11, 10}),
    ("doctor for my sick child", {17}),
    # Kiswahili and mixed
    ("natafuta yaya wa mtoto", {22}),
    ("daktari wa watoto", {17}),
    ("chanjo ya mtoto", {18}),
    ("mama mjamzito anahitaji kliniki", {5, 7}),
    ("msaada wa kunyonyesha", {12, 13}),
    ("lishe ya mtoto", {19}),
    ("mkunga wa kujifungua nyumbani", {8}),
    ("shule ya chekechea", {23}),
    ("afya ya akili baada ya kujifungua", {14, 10}),
    ("malezi ya watoto", {24}),
]
SWAHILI_FROM = 18


def catalogue():
    frames = DataSource("csv").load()
    p = frames["providers"]
    p = p[p.verification_status == "verified"].reset_index(drop=True)
    names = dict(zip(frames["categories"].category_id, frames["categories"].category_name))
    text = (p.category_id.map(names).fillna("") + ". " + p.provider_name + ". " +
            p.service_description.fillna("") + " " +
            p.service_tags.fillna("").str.replace("-", " ").str.replace(",", " ") + " " +
            p.location.fillna("")).tolist()
    return p.category_id.to_numpy(), text


def score(encoder, cats, text):
    encoder.fit(text)
    items = encoder.encode(text)
    rows = []
    for i, (q, ok) in enumerate(QUERIES):
        qv = encoder.encode_queries([q])[0]
        order = np.argsort(-(items @ qv))
        top1 = cats[order[0]] in ok
        top3 = any(c in ok for c in cats[order[:3]])
        p5 = float(np.mean([c in ok for c in cats[order[:5]]]))
        rows.append(dict(query=q, swahili=i >= SWAHILI_FROM, top1=top1, top3=top3, p_at_5=p5))
    return pd.DataFrame(rows)


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    cats, text = catalogue()
    configs = [("tfidf-svd + thesaurus", lambda: TfidfSvdEncoder()),
               ("tfidf-svd, no thesaurus", lambda: TfidfSvdEncoder(expand=False))]
    if sbert_available():
        for model in ("all-MiniLM-L6-v2", "paraphrase-multilingual-MiniLM-L12-v2"):
            configs += [
                (f"{model}, no thesaurus", lambda m=model: SbertEncoder(m, expand=False)),
                (f"{model} + thesaurus", lambda m=model: SbertEncoder(m, query_boost=False)),
                (f"{model} + thesaurus + query boost", lambda m=model: SbertEncoder(m, query_boost=True)),
            ]
    out = []
    for name, make in configs:
        df = score(make(), cats, text)
        for subset, part in (("english", df[~df.swahili]), ("kiswahili", df[df.swahili]),
                             ("all", df)):
            out.append(dict(encoder=name, subset=subset, top1=round(part.top1.mean(), 3),
                            top3=round(part.top3.mean(), 3),
                            p_at_5=round(part.p_at_5.mean(), 3), n=len(part)))
    res = pd.DataFrame(out)
    print(res.pivot(index="encoder", columns="subset", values="top1").to_string())
    print()
    print(res.to_string(index=False))
    outdir = Path(os.getenv("MZAZI_MODEL_DIR", Path(__file__).resolve().parent.parent / "model"))
    outdir.mkdir(parents=True, exist_ok=True)
    res.to_csv(outdir / "query_benchmark.csv", index=False)
    print(f"\nwritten {outdir / 'query_benchmark.csv'}")


if __name__ == "__main__":
    main()
