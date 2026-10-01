# -*- coding: utf-8 -*-
"""Cache the sentence-transformer weights into the image at build time, so the
container does not download ~90MB on first boot. Failure is not fatal: the
engine falls back to the TF-IDF+SVD encoder."""
import os
import sys

name = os.getenv("PREFETCH_MODEL", "all-MiniLM-L6-v2")
try:
    from sentence_transformers import SentenceTransformer
    SentenceTransformer(name)
    print(f"cached sentence-transformer weights: {name}")
except Exception as exc:                                    # noqa: BLE001
    print(f"skipping model prefetch ({type(exc).__name__}: {exc})", file=sys.stderr)
    print("the service will fall back to the TF-IDF+SVD encoder", file=sys.stderr)
