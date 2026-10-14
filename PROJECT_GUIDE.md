# Mzazi Care — Codebase Guide

A file-by-file walkthrough of the four layers in [README.md](README.md):
presentation (HTML/CSS/JS), application (Express), recommendation (FastAPI +
scikit-learn), and data (MySQL). Read `README.md` first for what the project
is and how to run it — this document explains **how each layer is built**.

```
Browser  ──HTTP/JSON──▶  Express (backend/)  ──HTTP + shared token──▶  FastAPI (ml-service/)
   ▲                          │                                              │
   │                          ▼                                              ▼
   └──── static files ──  MySQL (database/)  ◀──────────────── reads the same tables
```

The browser never talks to the Python service directly — `backend/services/mlClient.js`
is the only caller, authenticated with `ML_SERVICE_TOKEN`. If that call fails,
routes degrade to a plain SQL popularity query rather than breaking the page
(see [recommendations.js](backend/routes/recommendations.js) below).

---

## 1. Frontend — `frontend/`

Vanilla HTML/CSS/JS, no build step, no framework. Every page is a static
`.html` file that loads three scripts in a fixed order: `api.js` (network),
`app.js` (shared UI helpers), then a page-specific controller.

```
frontend/
├── index.html      landing + search entry point
├── search.html     results + filters + recommendation panel
├── provider.html   single provider profile
├── account.html    login / register / saved / preferences / profile / history / password
├── admin.html      dashboard, queue, listings, form + evidence, categories, users, reports, log
├── css/styles.css  the entire design system, one file
└── js/
    ├── api.js       fetch wrapper + auth token storage
    ├── app.js       nav rendering, toasts, card templates, interaction tracking
    ├── home.js      controller for index.html
    ├── search.js    controller for search.html
    ├── provider.js  controller for provider.html
    ├── account.js   controller for account.html
    └── admin.js     controller for admin.html
```

### 1.1 HTML pages

Every page shares one skeleton: a sticky `.site-header` with the brand, nav
links, and a `#nav-actions` slot that JS fills in (`UI.renderNav`, see below),
a `<main>`, and the same footer. Pages are deliberately thin — `provider.html`
and `account.html` are little more than `<main id="provider-root">` /
`<main id="account-root">`, because their controllers render everything into
that root element. `search.html` and `admin.html` hard-code more structure
(filter form, tab bar) because those elements exist before any data loads.

- **`index.html`** — hero search bar (free-text `q`, `category`, `location`),
  a `#home-recs` panel (recommendations when signed in, an invitation to sign
  in otherwise), and categories grouped by service type from `GET /api/categories`.
- **`search.html`** — a three-column layout on desktop
  (`.layout.search-layout` → 230px filters / results / 280px recommendations,
  collapsing to a single column under 960px, with the recommendation panel
  reordered above the results via `order`, and the filter panel collapsed
  behind a "Filters" button — Figure 4.15). Filters are service type (the top
  level of the category tree), category, location and sort; together with the
  query and page they round-trip through the URL so results are shareable.
  A "Recently viewed" panel appears for signed-in users, and a zero-result
  search shows the engine's closest services instead of an empty page.
- **`provider.html`** — renders into `#provider-root`: header with image (or
  monogram), rating summary and tags; Overview / Qualifications / Services
  offered / Location tabs; save, share and rate controls; and a "similar
  services" panel from `GET /similar/{id}`.
- **`account.html`** — one controller, two modes: an auth form (login/register
  tabs) when logged out, or the account area with five sections (saved
  services, preferences grouped by service type with a preferred location,
  profile, search history, change password) when logged in. A new account
  lands on preferences, because they seed the first recommendations.
- **`admin.html`** — a tab bar (`Dashboard`, `Pending verification`,
  `Provider listings`, `Add listing`, `Categories`, `Registered users`,
  `Reports`, `Activity log`) that swaps the contents of `#admin-view`, plus a
  `<dialog>` that collects the reason for a rejection. `admin.js` guards the
  page client-side by checking `user.role === 'admin'`; the real enforcement
  is server-side, see §2.

### 1.2 CSS — `css/styles.css`

One stylesheet, mobile-first (base rules are the phone layout; `@media
(min-width: 640px)` and `(min-width: 960px)` add columns as the viewport
grows — see the bottom of the file). It's organised as a small design system:

- **Design tokens** (`:root`, lines 5–48): a navy/blue/teal/amber/red palette,
  neutral ink/muted/line/bg scale, shape tokens (`--radius*`, `--shadow*`,
  `--ring`), and motion tokens (`--ease`, `--transition`). Every component
  below is built from these variables rather than hard-coded colors, so the
  whole site can be re-themed by editing lines 5–48.
- **Primitives**: `.btn` (+ `.secondary`, `.danger`, `.small` variants),
  form controls (`input`/`select`/`textarea` with a shared focus ring via
  `--ring`), `.card` / `.panel` surfaces, `.chip` tags, and `.badge-verified`
  (with `.badge-pending` / `.badge-rejected` modifiers) for verification
  status.
- **Composed components**: `.result` (a listing row with a monogram
  `.thumb`), `.rec-panel` / `.rec-item` (recommendation panels get a distinct
  teal-tinted background so a user can visually tell "matched your filters"
  apart from "recommended for you" — this is a deliberate requirement, not a
  styling accident), `.stat-row` / `.stat` (admin dashboard tiles), `.tabs`
  (admin/account tab bars), and `.toast` (bottom-center transient messages,
  fired by `UI.toast()`).
- **Layout system**: `.layout` is a bare grid; `.layout.with-sidebar`,
  `.layout.search-layout`, and `.layout.profile-layout` each define their own
  `grid-template-columns` only above 960px, so every multi-column page is a
  single column by default.
- **Accessibility**: a `prefers-reduced-motion` block at the very end zeroes
  out all animation/transition durations for users who've asked for that.

There is no CSS build step (no Sass/PostCSS) and no class-name convention
enforced beyond "one class per component" — it reads closer to hand-written
BEM-lite than a utility framework.

### 1.3 JavaScript

No framework, no bundler — each file is loaded as a plain `<script>` and
communicates through two global IIFEs (`API` and `UI`) plus a per-page
`DOMContentLoaded` listener. There's no client-side router; navigation is
real page loads between the five `.html` files.

**`api.js`** — the only file that touches `fetch` or `localStorage`. It:
- stores the JWT and the logged-in user under `mzazi_token` / `mzazi_user`
  in `localStorage`;
- exposes a `call(path, opts)` helper that prefixes `/api`, attaches
  `Authorization: Bearer <token>` when present, parses JSON, and throws an
  `Error` carrying `.status` and `.details` (validation errors) on non-2xx
  responses — every controller catches this the same way;
- clears the session automatically on a `401` from an authenticated call;
- exposes one typed method per backend endpoint (`search`, `provider`,
  `recommendations`, `interact`, `saved`, the whole `admin*` family, …), so
  no controller ever builds a URL by hand.

**`app.js`** (the `UI` object) — cross-page helpers:
- `esc()` — the only HTML-escaping function in the codebase; every controller
  routes user-controlled or server-controlled *text* through it before
  interpolating into a template string, which is how the app avoids DOM XSS
  without a templating engine.
- `renderNav()` — reads `API.getUser()` and rewrites `#nav-actions` into
  either "Log in / Sign up" or "My account / Log out" (+ "Admin" if
  `role === 'admin'`); runs on every page via a `DOMContentLoaded` listener
  registered inside `app.js` itself.
- `resultCard()` / `statusBadge()` / `tagChips()` — the shared HTML snippets
  for a provider row, verification badge, and tag chip list, used by both
  `search.js` and `account.js` so listings look identical everywhere.
- `track(providerId, type, ratingValue)` — fires `POST /api/interactions`
  (fire-and-forget, swallows errors) for `view`/`click`/`save`/`rating`
  events. This is the client-side half of what feeds the collaborative
  filter: every click on a result, every provider page view, every save, and
  every star rating becomes a training row.
- `toast()` / `initials()` / `params()` — small UI utilities.

**Page controllers** — each owns exactly one page and one job:
- `home.js` — populates the category/location selects, builds the category
  grid, wires the search form to redirect to `search.html?...`, and (if
  logged in) fetches 3 recommendations for the "Personalised for you" panel.
- `search.js` — keeps a module-level `state` object (`q`, `category`,
  `location`, `sort`, `page`) synced with the URL via `history.replaceState`
  so results are re-runnable from a bookmark; `run()` fires
  `loadResults()` and `loadRecommendations()` in parallel. The recommendation
  panel shows a human-readable `strategy-note` (e.g. "Blended from your
  history and similar parents") mapped from the `strategy` field the engine
  returns — see §3.4.
- `provider.js` — records a `view` interaction on load (viewing a profile is
  itself a signal), then renders the profile, a save/unsave button, and a
  star-rating select that also records an interaction.
- `account.js` — `showAuth(mode)` (login/register form) vs `showAccount()`
  (profile + preferences + saved list), switching based on whether a token
  exists; on a `401` from `API.me()` it falls back to the auth form rather
  than erroring.
- `admin.js` — a small router (`show(view)`, mirrored in `?view=`):
  `dashboard()` (stat tiles, the oldest five pending listings with inline
  approve/reject, the model card, recent activity); `listings()` (search,
  status and category filters, pagination, approve/reject/edit/delete);
  `providerForm()` (create/edit, supporting evidence and profile image
  uploads, verification status, the listing's history); `categoryAdmin()`;
  `users()` (role changes); `reports()`; `logs()`. Rejecting always asks for a
  reason (`askReason()`), which the API requires.

---

## 2. Backend — `backend/` (Express)

```
backend/
├── server.js              helmet, CORS, rate limiting, mounts routes, serves frontend/
├── config/db.js            one mysql2 pool + query()/one() helpers
├── middleware/
│   ├── auth.js              bcrypt + JWT issue/verify, requireAuth/requireAdmin/optionalAuth
│   ├── validate.js          turns express-validator errors into a 422
│   └── errors.js            asyncRoute() wrapper + notFound/errorHandler
├── config/migrate.js        idempotent schema upgrades, run on start
├── routes/
│   ├── auth.js               register, login, me, password, preferences, search history
│   ├── categories.js         category tree + verified-provider counts
│   ├── services.js           public search/detail/locations/profile images
│   ├── interactions.js       records the events the recommender trains on
│   ├── saved.js               shortlist add/remove/list
│   ├── recommendations.js    the ML client + SQL popularity fallback
│   └── admin.js               listings, verification, evidence, categories,
│                              users, reports, reindex/retrain, logs
└── services/
    ├── mlClient.js           fetch() wrapper for the Python service
    ├── catalog.js            keyword-search SQL, category tree, hydration
    └── media.js              evidence and image storage, type-checked by content
```

`server.js` is the composition root: it applies `helmet()` with an explicit
CSP (`default-src 'self'`, etc.), CORS restricted to `CORS_ORIGIN`, a global
rate limiter (`RATE_LIMIT`/min) plus tighter ones on `/api/auth/login` and
`/api/auth/register`, mounts every router under `/api/*`, and serves
`frontend/` as static files so the whole app is one origin — the browser
never makes a cross-origin call.

**Data access** (`config/db.js`) is deliberately narrow: one `mysql2/promise`
pool, and every query in the codebase goes through `query(sql, params)` or
`one(sql, params)`, which always uses parameterised placeholders. There is no
ORM and no second way to reach the database — that's the "single
parameterised query seam" the top-level README's security section refers to.

**Auth** (`middleware/auth.js`): passwords are bcrypt-hashed (`BCRYPT_ROUNDS`,
default 12); a session is a JWT signed with `JWT_SECRET` carrying
`{ sub: user_id, role, name }`. `requireAuth` populates `req.user` or 401s;
`optionalAuth` populates it if present but never rejects (used on
`recommendations.js`, so an anonymous visitor still gets a response);
`requireAdmin` re-reads the role from `users` on every request and 403s
anyone who is not an administrator *now* — so a demotion takes effect at once,
not when the token expires. This is the actual enforcement behind the
client-side check in `admin.js`.

**Search** (`services/catalog.js`): the query is lowercased, hyphens become
spaces, spelling variants collapse (*day care* → *daycare*, mirroring
`synonyms.py`), and filler words drop out. Every remaining term must match, by
prefix, in the description, tags, name or category (a full-text BOOLEAN-mode
match plus `LIKE`s); a variant also matches its spaced spelling as a phrase.
Results are ordered by a NATURAL-LANGUAGE full-text score plus name and
category bonuses. If nothing matches, the route asks the engine for the
closest services (dropping the location filter) and returns them as
`suggestions` (Figure 4.5).

**`recommendations.js`** is the most interesting route: it doesn't rank
anything itself. It builds a payload (`user_id` from `req.user` if present,
`query`, `top_n`, `category`, `location`, `alpha`) and calls
`ml.recommend(payload)`. If the ML service throws (down, timed out, model not
trained), it catches the error and falls back to a raw SQL "most-interacted
providers" query, tagging the response `strategy: 'popularity_fallback_sql'`
so the frontend can still show *something*. On success, it hydrates the
engine's bare `{provider_id, provider_name, category_id, ...}` results with
`service_tags`, `service_description`, `qualifications` from MySQL, since the
ML service only knows what it indexed, not the full row.

**`admin.js`** (routes) is the management surface: provider CRUD, the
verification queue (`PUT /admin/providers/:id/verify` — a rejection must carry
a reason, stored in `admin_logs.notes`), evidence and image uploads (raw
bodies, type decided by the file's first bytes, stored under random names;
evidence is downloadable only here), categories (two levels: service types
and the categories under them; a category with providers or children cannot
be deleted), users (role changes, never your own, never the last
administrator), reports, and the two ML controls. Every mutation and its
`admin_logs` row commit in one transaction (`config/db.js`'s `transaction()`).

---

## 3. Recommendation engine — `ml-service/` (FastAPI + scikit-learn)

```
ml-service/
├── app.py       FastAPI: /health /recommend /similar/{id} /reindex /retrain /model
├── engine.py    HybridRecommender — the whole of Section 4.8
├── encoders.py  pluggable content encoder: SbertEncoder | TfidfSvdEncoder
├── synonyms.py  ~20-group EN/Kiswahili thesaurus applied before encoding
├── db.py        DataSource — MySQL or CSV, behind one interface
└── train.py     offline training/tuning/evaluation CLI
```

This service holds one in-process `HybridRecommender` (`_state["engine"]` in
`app.py`), trained at startup and rebuilt via `/reindex` or `/retrain`. At
request time it reads the user's *live* history from MySQL (interactions,
recent searches, declared preferences, saved services — `db.user_history()`,
Figure 4.3 step 7), so a parent who registered a minute ago is personalised
immediately rather than after the next retrain. It is never reached by the browser; every request carries
`X-Service-Token`, checked against `ML_SERVICE_TOKEN` by `require_token()`.

### 3.1 The math

```
score(u, s) = α · content(u, s) + (1 − α) · collaborative(u, s)
```

- **content(u, s)** — cosine similarity between a user's *preference vector*
  and each provider's content vector. The preference vector (Section 4.8.1,
  `_build_profile`) sums the vectors of the services they viewed, clicked,
  saved and rated (weighted by action), their 20 most recent searches, and
  the centroids of the categories they declared. A live search query is
  blended in and *weighted more than the stored profile* (`query_weight =
  0.75`).
- **collaborative(u, s)** — k-Nearest-Neighbours over the sparse user-item
  interaction matrix (cosine metric, `algorithm="brute"`, `k=20` by
  default). A user's score for provider *s* is the interaction-weighted sum
  of *s*'s weight across their nearest neighbours, excluding themselves.
- Both components are **min-max normalised per request** before blending
  (`_minmax()`), because raw cosine similarity and summed neighbour weights
  live on entirely different scales and can't be combined directly.

**Interaction weights** (`INTERACTION_WEIGHTS` in `engine.py`): a `view` is
worth 1.0, a `click` 2.0, a `save` 3.5, a `rating` 4.0 — deliberately
increasing with how deliberate the action is, since a rating is a much
stronger signal of preference than a page view.

**α** (`MZAZI_ALPHA=auto`): 1 at launch; a density schedule while data is
thin; once 20+ users have a held-out interaction, each retrain picks the α
with the best held-out recall@10 (`review_alpha`). Re-index keeps α; retrain
reviews it.

**Cold-start rules**, applied in order (Table 4.3, alternative flow):
1. If a user has fewer than `min_interactions` (default 3) interactions,
   there's no usable collaborative signal → `α` is forced to `1.0` (content
   only).
2. If there's no content signal, or no candidate clears the similarity
   threshold (0.25 for sentence embeddings, 0.10 for TF-IDF), the engine
   returns popular, highly rated services — half popularity, half a
   Bayesian-smoothed rating — within the selected category
   (`strategy: "popularity_fallback"`).
3. A live search query always outweighs a stored preference vector, per the
   `query_weight` blend above.

This is also the answer to a question the top-level README raises directly:
a brand-new verified provider has **no column in the user-item matrix** (no
one has interacted with it yet), so collaborative filtering can never
surface it, however good it is. Content-based scoring has no such blind
spot — it only needs the listing's own text. That's why `admin.js`'s verify
action triggers an immediate `/reindex` rather than waiting for the next
scheduled retrain.

**Diversity** (`_reserve_related`, Section 4.8.3): while the collaborative
component is unavailable, 20% of the list (`MZAZI_DIVERSITY_SHARE`) is kept
for the highest rated services in *related* categories — siblings of the top
matches under the same service type. Those rows carry `basis:
"related_highly_rated"` and the UI labels them. No reservation is made when
the user filtered by category. A parent category ("service type") filter
covers all its children.

**Exclusions**: services the user has saved are never recommended (Section
3.2.4). Evaluation additionally excludes everything seen in training.

### 3.2 Content encoders — `encoders.py`

Both encoders implement the same tiny interface (`fit(texts)` /
`encode(texts)` → L2-normalised `(n, dim)` float32 arrays, so a dot product
*is* cosine similarity and `engine.py` never needs to know which one is
active):

- **`SbertEncoder`** (default when available) — wraps a
  `sentence-transformers` model (`MZAZI_SBERT_MODEL`, default
  `all-MiniLM-L6-v2`; `paraphrase-multilingual-MiniLM-L12-v2` recommended for
  Kiswahili-mixed queries). Reads meaning, not term overlap, so *"someone to
  help me breastfeed"* matches a listing that says *"lactation consultant,
  latch support"* despite sharing zero words.
- **`TfidfSvdEncoder`** (automatic fallback) — TF-IDF (word 1–2-grams) into
  Truncated SVD. Pure scikit-learn, no PyTorch. The SVD step is the
  important part: it folds co-occurring terms onto shared latent dimensions,
  so it's meaningfully stronger than plain TF-IDF even though it's still a
  bag-of-words method underneath.
- **`build_encoder()`** reads `MZAZI_ENCODER` (`sbert` / `tfidf` / `auto`,
  default `auto`): `auto` uses SBERT if importable, else logs and falls back
  to TF-IDF+SVD automatically. `/api/health` → `ml.encoder` shows which one is
  live. The live model is `all-MiniLM-L6-v2`; see the README for the
  benchmark that chose it over the multilingual model.
- **Query encoding** (`encode_queries`): user-typed text gets the thesaurus
  expansion plus a *query boost* — a concept that is rare in the catalogue is
  repeated so mean pooling weights it up (*"natafuta yaya wa mtoto"* leans on
  *nanny*, not on the generic *child*).
- Embeddings are cached by text, so a re-index only encodes listings whose
  text changed.

Every text is expanded through `synonyms.py` **before** either encoder sees
it (`expand_all`, applied inside both `fit`/`encode` methods) — so the
thesaurus benefits the neural encoder too, not just the bag-of-words one.

### 3.3 Domain thesaurus — `synonyms.py`

~20 curated synonym groups (EN + Kiswahili — *yaya*, *mimba*, *kujifungua*,
*chanjo*, …) plus an `EXTRA_FORMS` map for irregular word forms a simple
stemmer wouldn't reach (*breastfeed* → *breastfeeding*, *deliver* → *birth*,
etc). `expand_all()` appends matched terms to a copy of the text before
encoding, which is what closes the vocabulary-mismatch gap described in the
top-level README without requiring every listing to be re-written by hand.

### 3.4 The API — `app.py`

| Route | Purpose |
|---|---|
| `GET /health` | Liveness + which encoder is live — no token required |
| `POST /recommend` | Top-N for a `user_id` and/or `query`, with `category`/`location`/`alpha` overrides; returns a `strategy` field (`hybrid` / `content_only` / `collaborative_only` / `popularity_fallback`) that the frontend surfaces as a human-readable note |
| `GET /similar/{provider_id}` | Content-space nearest neighbours of one listing (powers "Similar services" on `provider.html`) |
| `POST /reindex` | Re-reads the catalogue and recomputes embeddings; keeps k and α |
| `POST /retrain` | Also rebuilds the user-item matrix from all interactions and reviews α against a held-out split. Both persist to `MZAZI_MODEL_PATH`; a lock plus a `busy` flag returns `409` if a rebuild is already in flight |
| `GET /model` | Current `EngineConfig` (k, α and where it came from, encoder, density, …), the α review grid, and held-out metrics labelled with their protocol — what the admin dashboard renders |

### 3.5 Data source — `db.py`

One `DataSource` class, two backends behind it: `mysql` (reads the tables in
`database/schema.sql` directly) or `csv` (reads `database/seed/*.csv`, no
database required — used for tests and quick local iteration). Selected by
`MZAZI_DATA_SOURCE`, defaulting to `mysql` if `DB_HOST` is set, else `csv`.
`training_interactions()` prefers an explicit train/test split
(`interactions_train`/`interactions_test`) when present (CSV). Live MySQL data
has none, so `engine.holdout_split()` holds out each user's most recent
provider for evaluation and the α review; the served model is then fit on
everything. `user_history()` serves the live per-user signals described in §3.

### 3.6 Offline tooling — `train.py`

A CLI on top of the same `HybridRecommender`:
`python train.py --tune` grid-searches `k` and `α` against held-out recall
and saves `model/hybrid_model.joblib`; `--compare-encoders` runs the neural
vs. TF-IDF+SVD encoder side by side and writes `model/model_comparison.csv`.
These are the two tables the top-level README points to for the capstone's
evaluation chapter.

---

## 4. Database — `database/`

`schema.sql` defines 10 InnoDB tables (`utf8mb4`): `users`, `categories`
(self-referencing `parent_category_id` for the category tree),
`providers` (+ `provider_media`), `user_preferences`, `search_history`,
`interactions` (the collaborative-filtering training data), `saved_services`,
`recommendations` (persisted output, written when `persist: true` is passed
to `/recommend`), and `admin_logs` (with a `notes` column for rejection
reasons). `provider_media.media_type` is `image` (public) or `evidence`
(administrators only). `backend/config/migrate.js` upgrades a database created
from an older schema. `seed_data.sql` — and the equivalent
`seed/*.csv` files the ML service can read directly — populate 120
providers, ~240 users and ~4,700 interactions with realistic category-scoped
vocabulary.

---

## 5. End-to-end example: a search on `search.html`

1. User types "lactation consultant" and hits Search. `search.js` updates
   `state` and calls `run()`.
2. `loadResults()` → `API.search({ q, category, location, sort, page })` →
   `GET /api/services?...` (`backend/routes/services.js`) → parameterised
   MySQL query against `providers`/`categories`, verified listings only.
3. `loadRecommendations()` → `API.recommendations({ query: state.q, top_n: 5,
   ... })` → `GET /api/recommendations` (`backend/routes/recommendations.js`)
   → `ml.recommend()` → `POST http://ml-service:8000/recommend` with
   `X-Service-Token`.
4. Inside `HybridRecommender.recommend()`: the query text is encoded (through
   `synonyms.py` expansion, then the active encoder) and compared against
   every verified provider's pre-computed content vector; if the user is
   logged in, their live history builds the preference vector and, with ≥3
   interactions, their k-NN neighbourhood is blended in at the reviewed α;
   saved services are dropped, results are ranked, sliced to `top_n`, and
   returned with a `strategy` label.
5. Express hydrates those bare results with `service_tags` /
   `service_description` from MySQL and returns them.
6. `search.js` renders the results list and, separately, the
   visually-distinct `.rec-panel` with a plain-language strategy note (e.g.
   *"Matched on what you searched for"*).
7. Clicking a result fires `UI.track(id, 'click')` — a `POST
   /api/interactions` that becomes training data for the *next* fit, closing
   the loop.
