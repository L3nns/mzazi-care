# -*- coding: utf-8 -*-
"""Paths, Markdown tables and the environment record shared by the research scripts."""
from __future__ import annotations

import hashlib
import os
import platform
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ML_DIR = HERE.parent
ROOT = ML_DIR.parent
SEED_DIR = ROOT / "database" / "seed"
OUT_DIR = Path(os.getenv("MZAZI_MODEL_DIR", ROOT / "model")) / "research"

if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))


def out_path(name: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    return OUT_DIR / name


def md_table(df, floatfmt="{:.3f}") -> str:
    """A pandas frame as a GitHub Markdown table (no tabulate dependency)."""
    def cell(v):
        if isinstance(v, float):
            return "" if v != v else floatfmt.format(v)
        return str(v).replace("|", "\\|")
    head = "| " + " | ".join(map(str, df.columns)) + " |"
    rule = "| " + " | ".join("---" for _ in df.columns) + " |"
    rows = ["| " + " | ".join(cell(v) for v in r) + " |" for r in df.itertuples(index=False)]
    return "\n".join([head, rule, *rows])


def data_hash(*names: str) -> str:
    """Short SHA-256 over the named seed files, so a result names its data."""
    h = hashlib.sha256()
    for n in names:
        h.update((SEED_DIR / n).read_bytes())
    return h.hexdigest()[:12]


def environment() -> dict:
    import numpy, pandas, scipy, sklearn   # noqa: E401
    env = dict(python=platform.python_version(), numpy=numpy.__version__,
               pandas=pandas.__version__, scipy=scipy.__version__,
               scikit_learn=sklearn.__version__)
    try:
        import sentence_transformers, torch   # noqa: E401
        env.update(sentence_transformers=sentence_transformers.__version__,
                   torch=torch.__version__)
    except Exception:
        env.update(sentence_transformers="not installed")
    try:
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
                                capture_output=True, text=True, timeout=10).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT,
                               capture_output=True, text=True, timeout=10).stdout.strip()
        env["git"] = commit + (" (uncommitted changes)" if dirty else "")
    except Exception:
        env["git"] = "unknown"
    return env
