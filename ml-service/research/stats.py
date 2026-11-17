# -*- coding: utf-8 -*-
"""
Uncertainty for small evaluation sets: percentile bootstrap intervals, paired
comparisons between two systems scored on the same units (queries or users),
and Holm's correction when several comparisons are made at once.

Every function takes a seed, so a rerun gives the same intervals.
"""
from __future__ import annotations

import numpy as np
from scipy import stats as _st

N_BOOT = 2000
SEED = 7


def bootstrap_ci(values, n_boot=N_BOOT, seed=SEED, level=0.95):
    """Mean and percentile bootstrap interval of the mean. Returns
    (mean, low, high); all NaN for an empty sample."""
    v = np.asarray(values, dtype=float)
    if not len(v):
        return float("nan"), float("nan"), float("nan")
    rng = np.random.default_rng(seed)
    means = v[rng.integers(0, len(v), size=(n_boot, len(v)))].mean(axis=1)
    tail = (1 - level) / 2
    return float(v.mean()), float(np.quantile(means, tail)), float(np.quantile(means, 1 - tail))


def paired(a, b, n_boot=N_BOOT, seed=SEED, level=0.95):
    """a and b score the same units in the same order. Returns the mean
    difference a - b, its paired bootstrap interval, the Wilcoxon signed-rank
    p-value (two-sided; 1.0 when every difference is zero) and the counts of
    units where a wins, b wins, or they tie."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    if a.shape != b.shape:
        raise ValueError("paired samples must be the same length")
    d = a - b
    mean, lo, hi = bootstrap_ci(d, n_boot=n_boot, seed=seed, level=level)
    nonzero = d[np.abs(d) > 1e-12]
    p = 1.0 if len(nonzero) == 0 else float(_st.wilcoxon(nonzero).pvalue)
    return dict(diff=mean, low=lo, high=hi, p=p, n=int(len(d)),
                wins=int((d > 1e-12).sum()), losses=int((d < -1e-12).sum()),
                ties=int((np.abs(d) <= 1e-12).sum()))


def holm(pvalues):
    """Holm-Bonferroni adjusted p-values, in the input order."""
    p = np.asarray(pvalues, dtype=float)
    m = len(p)
    order = np.argsort(p)
    adj = np.empty(m)
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p[i]))
        adj[i] = running
    return adj.tolist()


def fmt_ci(mean, lo, hi, digits=3):
    if np.isnan(mean):
        return "n/a"
    return f"{mean:.{digits}f} [{lo:.{digits}f}, {hi:.{digits}f}]"
