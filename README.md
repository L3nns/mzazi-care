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
score(u, s) = α · content(u, s) + (1 − α) · collaborative(u, s)
```

with content-based scoring from Sentence-BERT embeddings (TF-IDF+SVD as the
fallback) and collaborative scoring from k-Nearest Neighbors over the
user-item matrix. α starts at 1 and is reviewed at every retrain.

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
| FR-03 to FR-05 browse, search, filter by category, service type, location; sort | `routes/services.js`, `services/catalog.js`, `search.js` |
| FR-06 provider profile | `provider.js` — overview, qualifications, services offered, location tabs; rating summary; share |
| FR-07 save, rate | `routes/interactions.js`, `routes/saved.js` |
| FR-08 to FR-11 hybrid engine | `ml-service/engine.py` |
| FR-12 capture interactions | views, clicks (including clicks on recommendations), saves, ratings and searches |
| FR-13 RBAC | `middleware/auth.js` — the role is re-read from the database on every admin request |
| FR-14 add, update, delete listings | Admin → Provider listings, Add listing |
| FR-15 evidence and verification | Admin → listing form: upload evidence (PDF/JPG/PNG), approve, reject **with a reason** |
| FR-16 categories and sub-categories | Admin → Categories |
| FR-17 logs and summary reports | Admin → Activity log, Reports (engagement, searches, recommendation output, data quality) |
| FR-18 re-index, retrain | Admin → Dashboard → Model status |
| Table 4.3 alternative flow | below the similarity threshold the engine returns popular, highly rated services in the selected category |
| Section 4.8.3 diversity | while collaborative is unavailable, 20% of the list is kept for highly rated services in related categories |
| Figure 4.5 no empty result set | zero keyword matches return the closest services (semantic) or popular ones |
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
   (4.8.3) is implemented. On the seeded data the review picks 0.8.
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

Keyword search applies the same variant rules, prefix-matches every term, and
drops filler words, so *"looking for day-care near me"* finds daycare listings.
When nothing matches, the results page shows the engine's closest services
instead of an empty page.

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

On the seeded temporal split (`train.py`, sentence encoder, α=0.4):

| | content-based | collaborative | hybrid |
|---|---|---|---|
| recall@10, all providers | 0.24 | 0.26 | 0.25 |
| **recall@10, newest providers** | **0.49** | **0.05** | — |

A provider that has just been verified has **no column in the user-item
matrix**. No user has interacted with it, so no neighbour can have preferred
it, so k-NN can never surface it — however good it is. Every new listing starts
in exactly that state. That is the argument for the hybrid, and it is why the
verification endpoint triggers an immediate re-index.

**Two cautions for Chapter Five.**

- On the synthetic data the content upgrade over TF-IDF is small on recall,
  because the seeded descriptions are generated from per-category vocabulary.
  The difference shows on real wording, which is what the query benchmark
  measures. Do not claim a recall gain you cannot evidence.
- The admin dashboard's recall@10 (about 0.62) is a **different protocol**:
  leave-last-out on the live data, one held-out provider per user, so recall
  equals hit rate. It is labelled as such and must not be compared with the
  0.25 above.

---

## Project layout

```
mzazi-care/
├── docker-compose.yml          three services + volumes (db, model, uploads)
├── .env.example                copy to .env and fill in
├── database/
│   ├── schema.sql              DDL matching the ERD (Figure 4.8)
│   ├── seed_data.sql           120 providers, 240 users, 4,667 interactions
│   └── seed/*.csv              same data as CSV (the ML service can read these)
├── ml-service/
│   ├── app.py                  FastAPI: /recommend /similar /reindex /retrain /model
│   ├── engine.py               HybridRecommender - the whole of Section 4.8
│   ├── encoders.py             pluggable content encoder (SBERT | TF-IDF+SVD)
│   ├── synonyms.py             thesaurus + preprocessing, EN + SW
│   ├── db.py                   MySQL or CSV data source, live user history
│   ├── train.py                train, tune, evaluate, compare encoders
│   ├── benchmark_queries.py    query-level encoder benchmark
│   └── tests/test_engine.py    50 tests
├── backend/
│   ├── server.js               helmet, CORS, rate limits, static front end
│   ├── config/db.js            the single parameterised query seam + transactions
│   ├── config/migrate.js       idempotent schema upgrades
│   ├── middleware/auth.js      bcrypt, JWT, requireAuth / requireAdmin
│   ├── routes/                 auth, categories, services, interactions,
│   │                           saved, recommendations, admin
│   ├── services/               mlClient, catalog (search SQL), media (uploads)
│   └── tests/                  38 API tests + an integration smoke test
└── frontend/
    ├── index.html              landing and search         (Figure 4.9)
    ├── search.html             results, filters, recs     (Figure 4.10)
    ├── provider.html           provider profile           (Figure 4.11)
    ├── account.html            account area               (Figure 4.12)
    └── admin.html              administrator console      (Figures 4.13, 4.14)
```

## API

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | public |
| GET/PUT | `/api/auth/me`, `/api/auth/me/preferences` | authenticated |
| PUT | `/api/auth/me/password` | authenticated |
| GET/DELETE | `/api/auth/me/searches` | authenticated |
| GET | `/api/categories` | public |
| GET | `/api/services` (`q`, `type`, `category`, `location`, `sort`, `page`) | public |
| GET | `/api/services/:id`, `/api/services/locations`, `/api/services/media/:id` | public |
| POST | `/api/interactions`; GET `/api/interactions/me` | authenticated |
| GET/DELETE | `/api/saved`, `/api/saved/:providerId` | authenticated |
| GET | `/api/recommendations` | optional auth |
| GET/POST/PUT/DELETE | `/api/admin/providers…` | administrator |
| PUT | `/api/admin/providers/:id/verify` (reason required to reject) | administrator |
| POST/GET/DELETE | `/api/admin/providers/:id/media`, `/api/admin/media/:id` | administrator |
| GET/POST/PUT/DELETE | `/api/admin/categories…` | administrator |
| GET, PUT | `/api/admin/users`, `/api/admin/users/:id/role` | administrator |
| GET | `/api/admin/stats`, `/api/admin/reports`, `/api/admin/logs` | administrator |
| POST | `/api/admin/model/reindex`, `/api/admin/model/retrain` | administrator |

## Tests

```bash
cd ml-service && venv/Scripts/python -m pytest -q   # 49 passed, 1 skipped
cd backend && npm test                              # 38 passed
# Express against the real ML service (database stubbed):
ML_SERVICE_URL=http://127.0.0.1:8000 ML_SERVICE_TOKEN=<your token> node tests/integration.smoke.js
```

The Python suite covers the engine:
- only verified providers are recommendable
- semantic matching and spelling variants
- every cold-start path: launch day, the similarity threshold, searches and declared preferences, live history for a new user
- the related-category reservation and parent-category filters
- the α schedule and review, and the holdout split
- the encoder wrapper and query boost

The skipped test only runs when sentence-transformers is absent.

The Node suite covers:
- routing and authentication
- RBAC, including demotion
- validation and SQL parameter binding
- keyword search SQL
- empty-result suggestions
- rejection reasons and audit logging
- the last-administrator guard
- password change
- content-checked uploads, and that evidence is never public

## Security (Section 4.11)

- Passwords are bcrypt-hashed (12 rounds).
- Sessions are signed JWTs.
- The administrator role is re-checked against the database on every admin request.
- All input is validated with express-validator, and every query is parameterised through one `query()` helper.
- Multi-step changes and their audit entries commit in one transaction.
- Helmet sets a content security policy.
- Login and registration have their own rate limits, and failed sign-ins to administrator accounts are logged.
- Uploaded files are type-checked by their bytes, stored under random names, and evidence is only ever served to administrators.
- The ML service is reachable only from Express, behind a shared token.

The collaborative component derives suggestions from other users' behaviour
but exposes only the resulting services, never the neighbours' identities or
their interactions.

---

## Status

Verified on a Windows machine against MySQL 8.0 with the sentence encoder
running:
- both test suites
- an end-to-end run of 38 checks against the live stack and real database, covering search, recommendations, a new parent's first session, and the full verification flow with evidence upload
- every page rendered in headless Chrome at 1280px and at a true 390px width, with no script errors and no horizontal overflow

The same end-to-end run also passes against the Docker stack
(`docker compose up --build`): the containers seed their own database,
train on start, and retrain from the dashboard.

The Docker database (port 3307) is separate from a locally installed MySQL
(port 3306). Accounts created in one do not exist in the other, so promote
your administrator in whichever one the app is using.
