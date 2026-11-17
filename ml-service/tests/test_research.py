# -*- coding: utf-8 -*-
"""The research tooling: statistics, metric arithmetic, the place-name port,
the integrity of the labelled queries, and evaluate()'s outside-ranker hook.
Run: pytest -q (from ml-service/)"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from research.stats import bootstrap_ci, paired, holm                     # noqa: E402
from research.search_benchmark import (extract_location, score_query,     # noqa: E402
                                       load_queries, BM25)
from research.common import SEED_DIR                                       # noqa: E402
from test_engine import catalogue                                          # noqa: E402,F401
from test_ranking import build                                             # noqa: E402

AREAS = pd.read_csv(SEED_DIR / "service_areas.csv").area_name.tolist()


# ------------------------------------------------------------------ stats
def test_bootstrap_is_reproducible_and_brackets_the_mean():
    v = np.random.default_rng(0).random(50)
    a, b = bootstrap_ci(v), bootstrap_ci(v)
    assert a == b
    assert a[1] <= a[0] <= a[2]
    assert bootstrap_ci([0.5] * 10) == (0.5, 0.5, 0.5)


def test_paired_identical_systems_tie_everywhere():
    r = paired([0.1, 0.5, 1.0], [0.1, 0.5, 1.0])
    assert r["diff"] == 0 and r["p"] == 1.0 and r["ties"] == 3


def test_paired_counts_wins_and_losses():
    r = paired([1, 1, 0, 1], [0, 0, 0, 1])
    assert (r["wins"], r["losses"], r["ties"]) == (2, 0, 2)
    assert r["diff"] == pytest.approx(0.5)


def test_holm_matches_a_hand_worked_example():
    assert holm([0.01, 0.04, 0.03]) == pytest.approx([0.03, 0.06, 0.06])


# ---------------------------------------------------------------- metrics
CAT = {1: 5, 2: 5, 3: 7, 4: 9}


def test_perfect_graded_ranking_scores_one():
    m = score_query([1, 2, 3], {1: 2, 2: 2, 3: 1}, CAT, {5, 7})
    assert m["ndcg"] == pytest.approx(1.0) and m["r10"] == 1.0 and m["mrr"] == 1.0
    assert m["p10"] == pytest.approx(0.3) and m["list_precision"] == 1.0


def test_an_empty_answer_scores_zero_and_is_counted():
    m = score_query([], {1: 2}, CAT, {5})
    assert m["ndcg"] == m["r10"] == m["cat_acc"] == 0 and m["empty"] == 1.0


def test_order_matters_for_ndcg_and_mrr():
    m = score_query([4, 1], {1: 2}, CAT, {5})
    assert m["mrr"] == 0.5 and 0 < m["ndcg"] < 1 and m["cat_acc"] == 0.0


# ------------------------------------------------- place-name port parity
# The same cases as backend/tests/areas.test.js, so the port cannot drift.
@pytest.mark.parametrize("text,expected", [
    ("I need a midwife near Kilimani", ("Kilimani", "I need a midwife")),
    ("Childcare services in Westlands", ("Westlands", "Childcare services")),
    ("natafuta yaya Karen", ("Karen", "natafuta yaya")),
    ("kliniki ya mtoto karibu na Langata", ("Langata", "kliniki ya mtoto")),
    ("daycare huko Embakasi please", ("Embakasi", "daycare please")),
    ("LACTATION upper   hill", ("Upper Hill", "LACTATION")),
    ("Kileleshwa", ("Kileleshwa", "")),
    ("nanny in South C", ("South C", "nanny")),
    ("nanny in south b", ("South B", "nanny")),
    ("karenina daycare", None),
    ("help with breastfeeding", None),
    ("", None),
])
def test_place_parsing_matches_the_backend(text, expected):
    assert extract_location(text, AREAS) == expected


# ------------------------------------------------------- labelled queries
def test_every_answerable_query_has_a_right_answer_in_the_catalogue():
    q = load_queries()
    p = pd.read_csv(SEED_DIR / "providers.csv")
    p = p[p.verification_status == "verified"]
    for r in q[q.answerable].itertuples():
        ok = p.category_id.isin(r.primary_ids | r.also_ids)
        if r.area:
            ok &= p.location == r.area
        assert ok.any(), f"{r.qid} {r.query!r} has no relevant provider"
    assert set(q[q.area != ""].area) <= set(AREAS)
    assert q.qid.is_unique


def test_splits_are_balanced_within_every_query_type():
    q = load_queries()
    counts = q.groupby(["subset", "split"]).size().unstack()
    assert (abs(counts.dev - counts.test) <= 1).all()


def test_bm25_needs_a_shared_term():
    bm = BM25(["lactation consultant latch support", "nanny placement agency"])
    assert bm.scores("nanny").argmax() == 1
    assert bm.scores("car mechanic").max() == 0


# ----------------------------------------------------- evaluate(ranker=)
def test_an_outside_ranker_is_scored_by_the_same_code(catalogue):  # noqa: F811
    eng = build(catalogue)
    test = pd.DataFrame([(1, 7), (4, 9)], columns=["user_id", "provider_id"])
    oracle = {1: [7], 4: [9]}
    m = eng.evaluate(test, top_n=5, ranker=lambda u, n: oracle[u], per_user=True)
    assert m["recall"] == 1.0 and m["mrr"] == 1.0 and m["users"] == 2
    assert set(m["per_user"]) >= {"recall", "ndcg", "precision", "mrr", "hit_rate"}
    assert m["categories"] == 1.0
