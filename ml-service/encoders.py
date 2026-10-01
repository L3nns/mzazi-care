# -*- coding: utf-8 -*-
"""
Content encoders: turn provider text into vectors the engine can compare.

Two backends, one interface:

  SbertEncoder     sentence-transformers. Reads meaning, not term overlap, so a
                   query like "someone to help me breastfeed" matches a listing
                   that says "lactation consultant, latch support" even though
                   they share no words. This is the default.

  TfidfSvdEncoder  TF-IDF with Truncated SVD (latent semantic analysis) on top.
                   Pure scikit-learn, no torch, installs anywhere. Used when
                   sentence-transformers is unavailable, and as the comparison
                   baseline in the evaluation.

Both return L2-normalised dense matrices, so a dot product IS cosine similarity
and the rest of the engine does not care which one produced the vectors.

Choosing a model
----------------
MZAZI_ENCODER      sbert | tfidf | auto   (default: auto -> sbert, else tfidf)
MZAZI_SBERT_MODEL  sentence-transformers model name.
                   all-MiniLM-L6-v2                        ~90MB, English, fast
                   paraphrase-multilingual-MiniLM-L12-v2   ~470MB, 50+ languages
                       including Kiswahili - prefer this in production for
                       Kenyan users, who routinely mix English and Kiswahili.
"""
from __future__ import annotations

import os
import logging
from abc import ABC, abstractmethod

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.decomposition import TruncatedSVD
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import Normalizer

from synonyms import expand_all

log = logging.getLogger(__name__)

DEFAULT_SBERT = os.getenv("MZAZI_SBERT_MODEL", "all-MiniLM-L6-v2")


class ContentEncoder(ABC):
    """Fit on the catalogue once, then encode any text into the same space."""

    name: str = "base"
    dim: int = 0

    @abstractmethod
    def fit(self, texts: list[str]) -> "ContentEncoder": ...

    @abstractmethod
    def encode(self, texts: list[str]) -> np.ndarray:
        """(n, dim) float32, L2-normalised."""

    def encode_one(self, text: str) -> np.ndarray:
        return self.encode([text])[0]

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} name={self.name} dim={self.dim}>"


def _l2(a: np.ndarray) -> np.ndarray:
    a = np.asarray(a, dtype=np.float32)
    n = np.linalg.norm(a, axis=1, keepdims=True)
    return a / np.where(n == 0, 1, n)


class SbertEncoder(ContentEncoder):
    """Sentence embeddings. Nothing is learned from the catalogue - the model is
    pre-trained - so `fit` only records the corpus size for the model card."""

    def __init__(self, model_name: str = DEFAULT_SBERT, expand: bool = True):
        from sentence_transformers import SentenceTransformer  # noqa: local import

        self.model_name = model_name
        self.expand = expand
        self.model = SentenceTransformer(model_name)
        self.dim = int(self.model.get_sentence_embedding_dimension())
        self.name = f"sbert:{model_name}"
        self._fitted_on = 0

    def fit(self, texts: list[str]) -> "SbertEncoder":
        self._fitted_on = len(texts)
        return self

    def encode(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        prepared = expand_all(texts, repeat=1) if self.expand else list(texts)
        vecs = self.model.encode(
            prepared,
            batch_size=32,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return np.asarray(vecs, dtype=np.float32)


class TfidfSvdEncoder(ContentEncoder):
    """TF-IDF then Truncated SVD. The SVD step is what makes this more than the
    TF-IDF baseline: it folds co-occurring terms onto shared latent dimensions,
    so two listings that use different words for the same service still land
    near each other."""

    def __init__(self, n_components: int = 128, expand: bool = True,
                 ngram_range=(1, 2)):
        self.n_components = n_components
        self.expand = expand
        self.ngram_range = ngram_range
        self.name = f"tfidf-svd:{n_components}"
        self.pipeline = None
        self.vectoriser = None

    def fit(self, texts: list[str]) -> "TfidfSvdEncoder":
        prepared = expand_all(texts, repeat=2) if self.expand else list(texts)
        self.vectoriser = TfidfVectorizer(
            stop_words="english", sublinear_tf=True, min_df=1,
            ngram_range=self.ngram_range,
        )
        X = self.vectoriser.fit_transform(prepared)
        # SVD needs strictly fewer components than features or samples
        k = max(2, min(self.n_components, X.shape[1] - 1, X.shape[0] - 1))
        self.svd = TruncatedSVD(n_components=k, random_state=42)
        self.svd.fit(X)
        self.dim = k
        self.name = f"tfidf-svd:{k}"
        explained = float(self.svd.explained_variance_ratio_.sum())
        log.info("TF-IDF+SVD fitted: %d terms -> %d dims (%.1f%% variance)",
                 X.shape[1], k, 100 * explained)
        self.explained_variance = explained
        return self

    def encode(self, texts: list[str]) -> np.ndarray:
        if self.vectoriser is None:
            raise RuntimeError("TfidfSvdEncoder.fit() must be called first")
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        prepared = expand_all(texts, repeat=2) if self.expand else list(texts)
        return _l2(self.svd.transform(self.vectoriser.transform(prepared)))


def sbert_available() -> bool:
    try:
        import sentence_transformers  # noqa: F401
        return True
    except Exception:
        return False


def build_encoder(preferred: str | None = None, **kwargs) -> ContentEncoder:
    """
    Build the configured encoder, falling back cleanly.

    preferred: "sbert" | "tfidf" | "auto" | None  (None reads MZAZI_ENCODER)
    """
    choice = (preferred or os.getenv("MZAZI_ENCODER", "auto")).lower()

    if choice in ("sbert", "auto"):
        if sbert_available():
            try:
                return SbertEncoder(**{k: v for k, v in kwargs.items()
                                       if k in ("model_name", "expand")})
            except Exception as exc:                     # model download, RAM, ...
                if choice == "sbert":
                    raise
                log.warning("sentence-transformers present but unusable (%s); "
                            "falling back to TF-IDF+SVD", exc)
        elif choice == "sbert":
            raise RuntimeError(
                "MZAZI_ENCODER=sbert but sentence-transformers is not installed.\n"
                "  pip install sentence-transformers\n"
                "or set MZAZI_ENCODER=tfidf to use the scikit-learn encoder.")
        else:
            log.info("sentence-transformers not installed; using TF-IDF+SVD")

    return TfidfSvdEncoder(**{k: v for k, v in kwargs.items()
                              if k in ("n_components", "expand", "ngram_range")})
