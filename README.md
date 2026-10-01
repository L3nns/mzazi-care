# Mzazi Care Discovery & Catalog System

A web-based recommender system for personalised maternal and childcare service
discovery, implementing the design in Chapter Four of the capstone proposal.

**Leonard Kipkoech · 167152 · ICS 4D** — Supervisor: Mr. Allan Vikiru
Strathmore University, School of Computing and Engineering Sciences

For a detailed, file-by-file walkthrough of the frontend (HTML/CSS/JS) and
the recommendation engine's internals, see **[PROJECT_GUIDE.md](PROJECT_GUIDE.md)**.

---

## What this is

The four-layer architecture from Figure 4.1, built end to end:

| Layer | Technology | Directory |
|---|---|---|
| Presentation | HTML, CSS, vanilla JavaScript (mobile-first) | `frontend/` |
| Application | Node.js + Express.js, REST API, JWT + RBAC | `backend/` |
| Recommendation | Python + FastAPI + scikit-learn, hybrid engine | `ml-service/` |
| Data | MySQL 8.0 | `database/` |

The recommendation engine is the weighted hybrid of Section 4.8:

```
score(u, s) = α · content(u, s) + (1 − α) · collaborative(u, s)
```

with content-based scoring from sentence embeddings and collaborative scoring
from k-Nearest Neighbors over the user-item matrix.

## Run it

```bash
cp .env.example .env          # then edit the secrets
docker compose up --build
```

Then open **http://localhost:4000**.

| Service | URL |
|---|---|
| Web application | http://localhost:4000 |
| API health | http://localhost:4000/api/health |
| Recommendation service docs | http://localhost:8000/docs |
| MySQL | localhost:3307 |

The database is created and seeded automatically on first start with 120
providers, 240 users and 4,667 interactions.

> **Before anything else, change `JWT_SECRET` and `ML_SERVICE_TOKEN` in `.env`.**
> Generate each with `openssl rand -hex 32`. The defaults in
> `docker-compose.yml` exist so the stack boots for a demo; they are not safe.

### Without Docker

```bash
# 1. database
mysql -u root -p < database/schema.sql
mysql -u root -p < database/seed_data.sql

# 2. recommendation service
cd ml-service && pip install -r requirements.txt
MZAZI_DATA_SOURCE=csv uvicorn app:app --port 8000     # csv needs no database

# 3. application layer (serves the front end too)
cd backend && npm install && npm start
```

---

## The content model: better than TF-IDF

The proposal specifies TF-IDF. This implementation keeps that as a fallback and
defaults to something stronger, because TF-IDF has one failure mode that matters
enormously for a discovery product: **vocabulary mismatch**.

A parent types *"someone to help me breastfeed"*. The listing says
*"lactation consultant, latch support, tongue tie"*. They share **no terms**, so
TF-IDF scores that pair at cosine ≈ 0 and the right provider is never shown.

Two mechanisms fix it, and both are in `ml-service/`:

**1. Sentence embeddings** (`encoders.py`, default). A pre-trained
sentence-transformer reads meaning rather than term overlap. Set
`MZAZI_SBERT_MODEL=paraphrase-multilingual-MiniLM-L12-v2` in production — it
covers Kiswahili, which Nairobi users mix with English constantly.

**2. A domain thesaurus** (`synonyms.py`). ~20 curated groups of maternal and
childcare vocabulary, including Kiswahili terms (*yaya*, *mimba*, *kujifungua*,
*chanjo*), applied to both listings and queries. This is the "standardises
category and tag variants" step already named in Section 3.2.2, so it needs no
change to your stated methodology.

### Choosing an encoder

| `MZAZI_ENCODER` | What runs | When to use it |
|---|---|---|
| `auto` (default) | sentence embeddings if installed, else TF-IDF+SVD | normal |
| `sbert` | sentence embeddings, error if unavailable | production |
| `tfidf` | TF-IDF + Truncated SVD, pure scikit-learn | light deployment, CI |

The fallback is automatic and logged. Note that even the fallback is stronger
than plain TF-IDF: the SVD step folds co-occurring terms onto shared latent
dimensions, so listings that use different words for the same service still land
near each other.

**A caveat you should carry into Chapter Five.** On the synthetic dataset this
upgrade is *not measurable* — the seeded descriptions are generated from
per-category vocabulary lists, so every bag-of-words method already reaches 100%
nearest-neighbour category purity. Seven representations were compared and the
hybrid result was identical to three decimal places. The benefit is real but it
appears on messy human-written listings, which only stakeholder testing will
show. Do not claim a measured improvement you cannot evidence.

---

## Training and evaluation

```bash
cd ml-service
python train.py --tune                 # grid search k and α, then save
python train.py --compare-encoders     # neural vs TF-IDF+SVD, side by side
```

Writes `model/hybrid_model.joblib`, `model/tuning_results.csv` and
`model/model_comparison.csv` — the tables for Chapter Five.

The service also retrains on demand: an administrator can trigger it from the
dashboard, or `POST /retrain` directly.

### The result that matters

On the seeded data the hybrid roughly matches collaborative filtering on
aggregate recall. Its value shows up elsewhere:

| | content-based | collaborative |
|---|---|---|
| recall@10, all providers | 0.21 | 0.26 |
| **recall@10, newest providers** | **0.58** | **0.05** |

A provider that has just been verified has **no column in the user-item matrix**.
No user has interacted with it, so no neighbour can have preferred it, so k-NN
can never surface it — however good it is. Every new listing starts in exactly
that state. That is the argument for the hybrid, and `admin.js` acts on it: the
verification endpoint triggers an immediate re-index so a newly approved listing
becomes recommendable at once rather than after the next retraining cycle.

---

## Project layout

```
mzazi-care/
├── docker-compose.yml          three services + volumes
├── .env.example                copy to .env and fill in
├── database/
│   ├── schema.sql              DDL matching the ERD (Figure 4.8)
│   ├── seed_data.sql           120 providers, 240 users, 4,667 interactions
│   └── seed/*.csv              same data as CSV (the ML service can read these)
├── ml-service/
│   ├── app.py                  FastAPI: /recommend /similar /reindex /retrain
│   ├── engine.py               HybridRecommender - the whole of Section 4.8
│   ├── encoders.py             pluggable content encoder (SBERT | TF-IDF+SVD)
│   ├── synonyms.py             maternal/childcare thesaurus, EN + SW
│   ├── db.py                   MySQL or CSV data source
│   ├── train.py                train, tune, evaluate, compare encoders
│   └── tests/test_engine.py    27 tests
├── backend/
│   ├── server.js               helmet, CORS, rate limits, static front end
│   ├── config/db.js            the single parameterised query seam
│   ├── middleware/auth.js      bcrypt, JWT, requireAuth / requireAdmin
│   ├── routes/                 auth, categories, services, interactions,
│   │                           saved, recommendations, admin
│   ├── services/mlClient.js    talks to the Python service
│   └── tests/                  24 API tests + an integration smoke test
└── frontend/
    ├── index.html              landing and search      (Figure 4.9)
    ├── search.html             results, filters, recs  (Figure 4.10)
    ├── provider.html           provider profile        (Figure 4.11)
    ├── account.html            shortlist, preferences  (Figure 4.12)
    └── admin.html              dashboard, queue, form  (Figures 4.13, 4.14)
```

## API

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | public |
| GET/PUT | `/api/auth/me`, `/api/auth/me/preferences` | authenticated |
| GET | `/api/categories` | public |
| GET | `/api/services`, `/api/services/:id`, `/api/services/locations` | public |
| POST | `/api/interactions` | authenticated |
| GET/DELETE | `/api/saved`, `/api/saved/:providerId` | authenticated |
| GET | `/api/recommendations` | optional auth |
| GET/POST/PUT/DELETE | `/api/admin/providers…` | administrator |
| PUT | `/api/admin/providers/:id/verify` | administrator |
| POST | `/api/admin/model/reindex`, `/api/admin/model/retrain` | administrator |

## Tests

```bash
cd ml-service && pytest -q                      # 27 passed
cd backend && npm test                          # 24 passed
node tests/integration.smoke.js                 # needs the ML service running
```

The Python suite covers the engine: only verified providers are recommendable,
semantic matching, both cold-start fallbacks, the α blend, filters, persistence,
and the encoder wrapper. The Node suite covers routing, authentication, RBAC,
validation and SQL parameter binding with the database stubbed.

## Security (Section 4.11)

Passwords are bcrypt-hashed (12 rounds); sessions are signed JWTs carrying the
role; `requireAdmin` gates every management route; all input is validated with
express-validator; every query is parameterised through one `query()` helper;
helmet sets a content security policy; login and registration have their own
rate limits; the ML service is reachable only from Express, behind a shared
token. Administrative actions are written to `admin_logs`.

The collaborative component adds one consideration: it derives suggestions from
other users' behaviour but exposes only the resulting services, never the
neighbours' identities or their interactions.

---

## Honest status

Built and verified in this environment: the engine and its 27 tests, the API and
its 24 tests, and an integration test proving Express and the Python service talk
over HTTP. The front end was rendered and inspected in a headless browser
against the live API.

**Not verified here:** the MySQL path (no database in the build environment — the
schema and queries are written but untested against a live server), the Docker
images (not built), and the sentence-transformer encoder end to end, because
model downloads are blocked in this sandbox. The SBERT *wrapper* is covered by
tests using a stub model, and the fallback to TF-IDF+SVD when the download fails
is tested and works.

First run on your machine: `docker compose up --build`, then check
`/api/health` shows `"ml": {"status": "ok"}`. If the encoder line reads
`tfidf-svd`, sentence-transformers did not install or the model did not
download — the system works, just with the lighter encoder.
