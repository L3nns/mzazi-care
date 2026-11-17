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
| Recommendation | Python + FastAPI + sentence-transformers + scikit-learn | `ml-service/` |
| Data | MySQL 8.0 | `database/` |

The recommendation engine is the weighted hybrid of Section 4.8:

```
blend(u, s) = α · content(u, s) + (1 − α) · collaborative(u, s)
score(u, s) = (1 − γ − δ) · blend(u, s) + γ · location(u, s) + δ · quality(s)
```

with content-based scoring from Sentence-BERT embeddings (TF-IDF+SVD as the
fallback) and collaborative scoring from k-Nearest Neighbors over the
user-item matrix. α, γ (distance from the parent's area) and δ (popularity and
smoothed rating) are chosen on a validation split at every retrain; on the
seeded data that gives α = 0.4 and γ = δ = 0.

Free-text search uses the same engine: a parent's words are matched by
meaning, in English or Kiswahili, and a place named in the query becomes a
visible area filter. Keyword SQL remains as the automatic fallback.

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
| API description (OpenAPI 3) | http://localhost:4000/api/openapi.yaml |
| Recommendation service docs | http://localhost:8000/docs (host only) |
| MySQL | localhost:3307 |

The database is created and seeded automatically on first start with 120
providers, 240 users and 5,012 interactions. The behavioural tables
(preferences, searches, interactions, saved services and the train/test split)
are synthetic and come from `database/generate_seed.py`; rerun it to redraw them.

> **Set `JWT_SECRET`, `ML_SERVICE_TOKEN` and `MFA_ENCRYPTION_KEY` in `.env`
> before the first start.** Generate each with `openssl rand -hex 32`. Compose
> refuses to start without the first two. For a real deployment (TLS, backups,
> logs, monitoring) follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

### Without Docker

Both services read the project-root `.env` themselves (a `backend/.env` or
`ml-service/.env` overrides it), so nothing needs exporting by hand.

```bash
# 1. database (once)
mysql -u root -p < database/schema.sql
mysql -u root -p < database/seed_data.sql

# 2. recommendation service
cd ml-service
python -m venv venv && venv/Scripts/pip install -r requirements.txt   # Windows path
venv/Scripts/python -m uvicorn app:app --port 8000

# 3. application layer (serves the front end too)
cd backend && npm install && npm start
```

`requirements.txt` installs sentence-transformers and PyTorch (about 2GB). To
skip them, comment that line out: the engine falls back to TF-IDF+SVD on its
own, and `/api/health` reports which encoder is live. The first start
downloads the sentence-transformer weights (~90MB) and takes about a minute.

An existing database is brought up to date automatically when the backend
starts. To run the migration by hand: `cd backend && npm run migrate`.

### Administrator accounts

Registration only ever creates parent accounts. The seed contains three
administrators (`admin1@` to `admin3@mzazicare.example`) whose passwords are not
published. To make yourself an administrator, register normally, then either
promote the account in SQL once:

```sql
UPDATE mzazi_care.users SET role = 'admin' WHERE email = 'you@example.com';
```

or, from then on, use **Admin → Registered users → Make admin**. The role is
re-checked on every admin request, so a demotion takes effect at once.

---

## How the system meets the proposal

| Proposal | Where it lives |
|---|---|
| FR-01, FR-02 register, profile, preferences | `routes/auth.js`, `account.js` (profile, preferences, saved, search history, password) |
| FR-03 to FR-05 browse, search, filter by category, service type, location; sort | `routes/services.js` (search by meaning through the engine, keyword fallback), `services/areas.js` (place names, nearby areas), `search.js` |
| FR-06 provider profile | `provider.js` — overview, qualifications, services offered, location tabs; rating summary; share |
| FR-07 save, rate | `routes/interactions.js`, `routes/saved.js` |
| FR-08 to FR-11 hybrid engine | `ml-service/engine.py` |
| FR-12 capture interactions | views, clicks (including clicks on recommendations), saves, ratings and searches |
| FR-13 RBAC | `middleware/auth.js` — the role is re-read from the database on every admin request |
| FR-14 add, update, delete listings | Admin → Provider listings, Add listing |
| FR-15 evidence and verification | `services/verification.js`: eight-state workflow with recorded history; typed, versioned documents with expiry, reviewed one by one; a listing is verified only with every document its category requires; lapsed documents expire the listing |
| FR-16 categories and sub-categories | Admin → Categories |
| FR-17 logs and summary reports | Admin → Activity log, Reports (engagement, searches, recommendation output, data quality) |
| FR-18 re-index, retrain | Admin → Dashboard → Model: retrain builds an evaluated candidate, promoted only if it is no worse; promote and roll back by hand |
| Table 4.3 alternative flow | below the similarity threshold the engine returns popular, highly rated services in the selected category |
| Section 4.8.3 diversity | while collaborative is unavailable, 20% of the list is kept for highly rated services in related categories |
| Figure 4.5 no empty result set | nothing in the area: nearby areas; nothing at all: closest or popular services; a weak best match is labelled as such |
| Figure 4.6 failed attempts logged | failed sign-ins to administrator accounts go to the audit trail |
| Figure 4.15 mobile | filters collapse behind a control; recommendations move above results |

### Where the build departs from the text, and why

These are deliberate and evidenced. Chapter Five should describe the system as
built.

1. **The encoder is `all-MiniLM-L6-v2`, not the multilingual model.** Section
   4.8.1 says the multilingual model is used in production "so that Kiswahili
   text is supported". Its model card does not list Swahili among its training
   languages, and on `benchmark_queries.py` it is worse at Kiswahili queries
   than the English model (table below). Kiswahili is carried by the thesaurus.
   Switching back is one setting: `MZAZI_SBERT_MODEL`.
2. **α is reviewed against held-out data.** Section 2.5.3 says α starts at 1
   and falls as data accumulates. `MZAZI_ALPHA=auto` does exactly that on a
   young platform, using a density schedule. Once at least 20 users have a
   held-out interaction, each retrain instead picks the α with the best
   held-out recall@10, which is how "reviewed at each retraining cycle"
   (4.8.3) is implemented. The review uses a validation split cut from the
   training period, never the test split. On the seeded data it picks 0.4.
3. **Stop words are kept for the sentence encoder.** Section 4.8.1 lists stop
   word removal in preprocessing. TF-IDF removes them; a transformer needs
   them to read the sentence, so they are left in for SBERT.
4. **`admin_logs` gained a `notes` column.** Table 4.4's alternative flow
   rejects a listing "and requests further information"; the reason has to be
   stored somewhere. Add `notes` to ADMIN_LOGS in Figure 4.8.
5. **`provider_media.media_type` is `image` or `evidence`.** Profile images
   are public; supporting evidence (Figure 4.14) is administrator-only.
6. **The seed has 120 providers, not "approximately forty"** (Section 3.2.1),
   across the same twenty categories.
7. **Free-text search is matched by meaning, not keywords.** Keyword SQL needs
   every word to appear; on the labelled benchmark it returned nothing for 69%
   of answerable questions (nDCG@10 0.27). The live route through the engine
   scores 0.81 (+0.54, 95% CI [0.42, 0.65]). Keyword SQL is kept as the
   fallback when the engine is unavailable.

---

## The content model

TF-IDF has one failure mode that matters enormously for a discovery product:
**vocabulary mismatch**. A parent types *"someone to help me breastfeed"*. The
listing says *"lactation consultant, latch support"*. They share **no terms**,
so TF-IDF scores that pair at cosine ≈ 0 and the right provider is never shown.

Three mechanisms close the gap, all in `ml-service/`:

1. **Sentence embeddings** (`encoders.py`). A pre-trained sentence-transformer
   reads meaning rather than term overlap.
2. **A domain thesaurus** (`synonyms.py`). ~20 curated groups of maternal and
   childcare vocabulary, including Kiswahili (*yaya*, *mjamzito*, *chanjo*,
   *kujifungua*, *kliniki*), applied to listings and queries. It also collapses
   spelling variants: *child care*, *child-care* and *childcare* become one
   term (Section 3.2.2).
3. **Query boost.** In a query, a thesaurus concept that is rare in the
   catalogue (*nanny*) is weighted up against a generic one (*child*).

Search sends the parent's words to the engine and ranks the listings it
matches, best first; a listing whose name contains the words always appears.
When nothing clearly matches, the closest services are shown under a notice
saying so. The keyword fallback applies the same variant rules, prefix-matches
every term and drops filler words.

### Measured: which encoder

`python benchmark_queries.py` scores 28 hand-written queries (18 English, 10
Kiswahili) that avoid the listings' own wording, by whether the top result is
in an acceptable category:

| Encoder | English | Kiswahili | All |
|---|---|---|---|
| **all-MiniLM-L6-v2 + thesaurus + query boost** (live) | **0.89** | **0.90** | **0.89** |
| all-MiniLM-L6-v2 + thesaurus | 0.89 | 0.80 | 0.86 |
| paraphrase-multilingual-MiniLM-L12-v2 + thesaurus | 0.83 | 0.60 | 0.75 |
| TF-IDF+SVD + thesaurus (fallback) | 0.56 | 0.90 | 0.68 |
| all-MiniLM-L6-v2, no thesaurus | 0.83 | 0.00 | 0.54 |
| paraphrase-multilingual-MiniLM-L12-v2, no thesaurus | 0.78 | 0.10 | 0.54 |

Two conclusions: the sentence encoder is what makes English work, and the
thesaurus is what makes Kiswahili work — without it, neither model handles
Kiswahili at all. The query set is small and written by the developer; it is
indicative, and should be replaced with real queries from stakeholder testing.

The fuller study is in **[docs/research/](docs/research/FINDINGS.md)**: 113
labelled queries (English, Kiswahili, mixed, place and out-of-scope, split into
dev and test in advance), nine search systems including the live route,
recommendation baselines, a diversity experiment, bootstrap confidence
intervals and paired significance tests. Regenerate it with
`python -m research.run_all` (ml-service/).

---

## Training and evaluation

```bash
cd ml-service
python train.py                        # train, evaluate, save
python train.py --tune                 # grid search k and α first
python train.py --compare-encoders     # SBERT vs TF-IDF+SVD on recall@10
python benchmark_queries.py            # the query-level table above
```

Writes `model/hybrid_model.joblib`, `model/model_comparison.csv`,
`model/tuning_results.csv` and `model/query_benchmark.csv` — the tables for
Chapter Five.

The running service retrains on demand (Admin → Dashboard, or `POST /retrain`)
and re-indexes automatically whenever a listing is verified, edited or removed.

### The result that matters

On the seeded temporal split (`train.py --encoder sbert`, α=0.4):

| | content-based | collaborative | hybrid |
|---|---|---|---|
| recall@10, all providers | 0.79 | 0.75 | 0.83 |
| **recall@10, the 7 newest providers** | **0.92** | **0.17** | — |

A provider that has just been verified has **no column in the user-item
matrix**. No user has interacted with it, so no neighbour can have preferred
it, so k-NN can never surface it — however good it is. Every new listing starts
in exactly that state. That is the argument for the hybrid, and it is why the
verification endpoint triggers an immediate re-index.

**Cautions for Chapter Five** (details in docs/research/FINDINGS.md):

- The hybrid's lead over content-only (+0.04 recall) is **not statistically
  significant** on this data; its lead over collaborative-only is.
- For recommendations, the TF-IDF encoder does as well as SBERT (better nDCG).
  SBERT's measured advantage is in search, for questions worded unlike the
  listings. Do not claim a recall gain you cannot evidence.
- The interactions are synthetic, and the generator favours content-based
  methods.
- The admin dashboard's metrics use a **different protocol** on the live data
  (each user's last interaction held out) and must not be compared with the
  table above.

---

## Project layout

```
mzazi-care/
├── docker-compose.yml          three services + volumes (db, model, uploads)
├── .env.example                copy to .env and fill in
├── database/
│   ├── schema.sql              DDL matching the ERD (Figure 4.8)
│   ├── seed_data.sql           120 providers, 240 users, 5,012 interactions
│   └── seed/*.csv              same data as CSV (the ML service can read these)
├── ml-service/
│   ├── app.py                  FastAPI: /recommend /similar /reindex /retrain /models
│   ├── engine.py               HybridRecommender - the whole of Section 4.8
│   ├── registry.py             model versions: candidate, production, rollback
│   ├── logs.py                 structured logs with request ids
│   ├── encoders.py             pluggable content encoder (SBERT | TF-IDF+SVD)
│   ├── synonyms.py             thesaurus + preprocessing, EN + SW
│   ├── db.py                   MySQL or CSV data source, live user history
│   ├── train.py                train, tune, evaluate, compare encoders
│   ├── benchmark_queries.py    query-level encoder benchmark
│   ├── research/               labelled benchmark and experiments (Phase 6)
│   └── tests/                  engine, ranking, API and research tests
├── backend/
│   ├── server.js               helmet, CORS, rate limits, static front end
│   ├── config/db.js            the single parameterised query seam + transactions
│   ├── config/migrate.js       idempotent schema upgrades
│   ├── middleware/auth.js      bcrypt, JWT, requireAuth / requireAdmin
│   ├── routes/                 auth, categories, services, interactions,
│   │                           saved, recommendations, admin
│   ├── services/               mlClient, catalog, areas, verification, expiry,
│   │                           totp, media, logger
│   ├── scripts/served-search.js  runs the benchmark queries through the live route
│   └── tests/                  API, spec, logging, areas, verification + smoke test
├── e2e/                        browser tests (Playwright)
├── docs/                       DEPLOYMENT.md, api/openapi.yaml, research/
├── .github/workflows/ci.yml    backend, ML and full-stack jobs
└── frontend/
    ├── index.html              landing and search         (Figure 4.9)
    ├── search.html             results, filters, recs     (Figure 4.10)
    ├── provider.html           provider profile           (Figure 4.11)
    ├── account.html            account area               (Figure 4.12)
    └── admin.html              administrator console      (Figures 4.13, 4.14)
```

## API

The full description is **[docs/api/openapi.yaml](docs/api/openapi.yaml)**
(also served at `/api/openapi.yaml`). A test fails if a route is added or
removed without updating it. In short:

| Area | Endpoints | Access |
|---|---|---|
| Accounts | `/api/auth/*`: register, login, two-step sign-in, profile, preferences, password, sign out everywhere | public / signed in |
| Catalogue | `/api/categories`, `/api/services` (search), `/api/services/:id`, `/api/services/locations` | public |
| Activity | `/api/interactions`, `/api/saved` | signed in |
| Recommendations | `/api/recommendations`, `/api/recommendations/feedback` | optional / signed in |
| Administration | `/api/admin/*`: listings, verification, documents, categories, areas, users, reports, logs, model versions | administrator |

Every response carries an `X-Request-Id`, which also appears in both services'
logs.

## Tests

```bash
cd backend && npm test                              # 91 passed
cd ml-service && venv/Scripts/python -m pytest -q   # 110 passed, 1 skipped
# Express against the real ML service (database stubbed):
ML_SERVICE_URL=http://127.0.0.1:8000 ML_SERVICE_TOKEN=<your token> node tests/integration.smoke.js
# In a browser, against a running stack:
cd e2e && npm install && npx playwright install chromium
E2E_BASE_URL=http://localhost:4000 npx playwright test   # 9 passed, 1 skipped
```

The skipped browser test creates an account; it runs with `E2E_WRITE=1` (CI
does, on a throwaway database). The skipped Python test only runs when
sentence-transformers is absent.

- **Python suite.** The engine and its cold-start paths; location, quality
  and explanations; MMR; the metrics; the model registry and promotion gate;
  the API, including request ids; and the research tooling (statistics, metric
  arithmetic, the place-name parser, the integrity of the labelled queries).
- **Node suite.** Routing, authentication, sessions and two-step sign-in;
  RBAC; validation and SQL binding; search by meaning and the keyword fallback;
  places and nearby areas; the verification workflow and documents;
  recommendation feedback; model versions; uploads; logging that never
  records search text; and that `openapi.yaml` matches the routes.
- **Browser tests.** A paraphrased question, Kiswahili with a place, the
  nearby-areas fallback, an out-of-scope request, the weak-match notice,
  opening a provider, and a new parent's first session ending with deleting
  the account.

**CI** (`.github/workflows/ci.yml`) runs:

1. both suites (Python on TF-IDF);
2. the research scripts, as a check that they still run;
3. a full-stack job: MySQL seeded from `database/`, the ML service with the
   sentence encoder, the API, the integration smoke test and the browser tests.

## Security (Section 4.11)

- Passwords are bcrypt-hashed (12 rounds).
- Sessions are signed JWTs, revoked on password change, role change and "sign out of all devices".
- Optional two-step sign-in (TOTP); secrets are encrypted at rest and codes cannot be replayed.
- The administrator role is re-checked against the database on every admin request.
- All input is validated with express-validator, and every query is parameterised through one `query()` helper.
- Multi-step changes and their audit entries commit in one transaction.
- Helmet sets a content security policy.
- Login and registration have their own rate limits, and failed sign-ins to administrator accounts are logged.
- Uploaded files are type-checked by their bytes, stored under random names, and evidence is only ever served to administrators.
- The ML service is reachable only from Express, behind a shared token.
- Logs carry request ids but never search text, request bodies, passwords or tokens.
- Parents can delete their account and everything recorded about them; old searches, activity and model files are deleted on a schedule (docs/DEPLOYMENT.md, section 10).
- One rating per parent per provider, enforced by the database; repeat views on the same day are not counted.
- Behind a reverse proxy, set `TRUST_PROXY` so rate limits apply per visitor (docs/DEPLOYMENT.md).

The collaborative component derives suggestions from other users' behaviour
but exposes only the resulting services, never the neighbours' identities or
their interactions.

---

## Status

Verified on 28 October 2026, on a Windows machine against MySQL 8.0 with the
sentence encoder running:

- both test suites (numbers above);
- the browser tests against a live backend, ML service and database;
- the labelled search benchmark through the live route (docs/research/RESULTS.md).

Not re-verified after the Phase 7 changes: the Docker stack, and the GitHub
Actions workflow, which has not yet run on GitHub. Earlier sessions ran the
Docker stack end to end.

The Docker database (port 3307) is separate from a locally installed MySQL
(port 3306). Accounts created in one do not exist in the other, so promote
your administrator in whichever one the app is using.
