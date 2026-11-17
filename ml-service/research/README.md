# Research experiments

Reproducible experiments behind `docs/research/RESULTS.md`; the
interpretation is in `docs/research/FINDINGS.md`.

| File | What it does |
| --- | --- |
| `queries.csv` | 113 labelled queries: English keyword-style and paraphrased, Kiswahili, mixed, place, out-of-scope. Split dev/test before any system ran. |
| `search_benchmark.py` | Keyword (as served), BM25, BM25 + thesaurus, LSA, SBERT, SBERT + thesaurus, the enhanced engine; cut-off sweeps on dev; ablation. |
| `rec_experiments.py` | Random, popularity, content, collaborative, hybrid (both encoders), hybrid + MMR; choices made on a validation split. |
| `stats.py` | Bootstrap intervals, paired comparisons (Wilcoxon), Holm correction. |
| `run_all.py` | Runs both and writes `docs/research/RESULTS.md`. |

## Run

```bash
# 1. Optional: the live search route, against MySQL (with the ML service up
#    for its suggestions). Skipped arms are reported, not silently dropped.
cd backend && npm run benchmark:served

# 2. Everything else (about 4 minutes on a laptop CPU)
cd ml-service && python -m research.run_all
```

Each script can also run on its own (`python -m research.search_benchmark`,
`python -m research.rec_experiments --encoder tfidf`). Raw per-query and
per-user values go to `model/research/`.

## Rules the scripts follow

- **The test split is never used to choose anything.** The relevance floor and
  the no-match threshold are chosen on the dev queries. α, the ranking weights
  and the MMR λ are chosen on a validation split cut from the training period.
- **Selection rules are fixed in code before the results are seen,** and
  ties go to the current value or the simpler option. Whether a selected value
  is adopted is a separate, documented decision.
- **The served arm runs only if MySQL matches the CSV seed.** The check
  fingerprints every verified listing; `--allow-mismatch` overrides it.
- **Fixed seeds** (bootstrap and random baseline: 7). A rerun on the same data
  and library versions gives the same tables.
