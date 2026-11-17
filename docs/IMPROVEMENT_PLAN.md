# Mzazi Care: audit and improvement plan

Phase 1 deliverable of the master prompt. Every status below was checked against
the source, schema and test runs on 28 October 2026, not inferred from the README.

## 1. Implementation status

### 1.1 Fully implemented and working

| Area | Evidence |
|---|---|
| Four-layer architecture, browser talks only to Express | `frontend/js/api.js` calls `/api/*` only; Express calls the ML service with `X-Service-Token` |
| Fallback when the ML service fails | `routes/recommendations.js` falls back to `popularSql`; 8 s timeout in `services/mlClient.js` |
| Parent registration, login, profile, category preferences, password change, search history (view, clear), saved providers | `routes/auth.js`, `routes/saved.js`, `account.js` |
| Keyword search with prefix terms, filler-word removal, spelling variants; semantic suggestions on zero results | `services/catalog.js`, `routes/services.js` |
| Hybrid engine: SBERT content + k-NN collaborative, min-max blend, α schedule and held-out review | `ml-service/engine.py`, `app.py` |
| Cold-start rules: new user, new provider, similarity threshold, anonymous visitor, live history | `engine.py`, 50 engine tests |
| English–Kiswahili thesaurus (about 20 groups), spelling variants, query boost | `synonyms.py`, `encoders.py` |
| Verification: pending → verified / rejected with a required reason; only verified providers are searchable or recommendable | `routes/admin.js`, `engine.fit` |
| Private evidence: content-checked, random names, size limit, never served publicly | `services/media.js`, 2 API tests |
| RBAC: role re-read on every admin request; no self-demotion; last-admin guard; no public admin registration | `middleware/auth.js`, `routes/admin.js` |
| Audit log with rejection notes; failed admin sign-ins logged | `admin_logs`, `routes/auth.js` |
| Admin reports: engagement, top searches, category demand, recommendation output, data quality, duplicates | `GET /api/admin/reports` |
| Re-index on catalogue change; retrain on demand | `routes/admin.js`, `app.py` |
| Security baseline: bcrypt (12), parameterised SQL, express-validator, Helmet CSP, CORS allow-list, rate limits, no stack traces in production, constant-time ML token check, weak-secret refusal in production | `server.js`, `middleware/` |
| Docker Compose with MySQL health check and restart policy | `docker-compose.yml` |
| Tests: backend 40 pass; ML engine and API suites pass (1 skip by design) | `npm test`, `pytest` |

### 1.2 Implemented but needs improvement

| Gap | Why it matters | Fix |
|---|---|---|
| Verification has 3 states | Prompt needs DRAFT … EXPIRED with enforced transitions; no way to suspend or expire a listing | State machine in one module, `provider_verification_events` table |
| Location is one free-text field with exact match | A provider serving Kilimani and Lavington can only list one; no distance; query "midwife near Kilimani" is not parsed | `service_areas` table (admin-managed, with centroid coordinates), `provider_service_areas`, location extraction in the query pipeline |
| Recommendation explanations | Only a `basis` field (`match` / `popular` / `related_highly_rated`) | Reason codes generated from the actual score components and provider record |
| Search benchmark | 28 queries, top-1 category only; no mixed-language, location or no-match queries; no Recall/nDCG/MRR/latency | Labelled benchmark file, per-language metrics, keyword vs semantic vs enhanced comparison |
| Diversity | Category reservation while content-only, not a general reranker | Optional MMR reranker, evaluated before/after |
| Ratings | Bayesian smoothing exists (m = 3, fixed) but anyone signed in can rate any provider | Tie reviews to completed bookings (Phase 4); document the choice of m |
| Migrations | `config/migrate.js` is a list of idempotent statements with no version table | `schema_migrations` table and numbered SQL files |

### 1.3 Partially implemented

| Feature | Present | Missing |
|---|---|---|
| Session handling | 12 h JWT, logout clears local storage | Revocation, short-lived access + refresh rotation, invalidation after password or role change |
| Model lifecycle | Single `hybrid_model.joblib`, model card, metrics | Versions, evaluation history, candidate comparison, promotion, rollback. Retrain currently **replaces production automatically**, which the prompt forbids |
| Account management | Profile, preferences, password | Location preferences (`user_preferences.preferred_location` exists but is unused), notification preferences, account deletion request |
| Analytics | Reports endpoint | Zero-result searches, search-to-click conversion, latency, service-gap indicator, time series |

### 1.4 Missing

- Provider role, provider self-registration and provider dashboard
- Services offered as separate records; working hours, availability, bookings, booking states, double-booking protection
- Written reviews, review reports, moderation
- Notifications and a background worker (reminders, document expiry)
- Verification document types, expiry dates, document versions
- Email verification, password reset, MFA for administrators
- Recommendation feedback ("not relevant", "too far away")
- Query intent and entity extraction, clarification prompts
- Location-aware ranking (γ) and quality feature (δ) in the score
- GitHub Actions CI, frontend tests, end-to-end tests, coverage reports
- OpenAPI documentation for the Express API
- Structured logging and latency metrics
- Safety notice (not medical advice, emergency signposting) and a privacy notice
- Statistical confidence intervals on evaluation metrics; learning-to-rank experiment
- PWA (optional, later)

### 1.5 Implemented but needs more testing

- Express against a real MySQL database (the smoke test exists but is not automated)
- The frontend (no tests at all)
- Search SQL against real full-text indexes (tests stub the database)

### 1.6 Potentially unsafe or architecturally problematic

| Issue | Risk | Fix |
|---|---|---|
| `docker-compose.yml` publishes the ML service on host port 8000 and MySQL on 3307 | The internal service and the database are reachable from the network | Remove both port mappings, or bind to `127.0.0.1` for development only |
| Tokens live 12 h in `localStorage` and cannot be revoked | A stolen token works until it expires, even after a password change | `token_version` on users now (cheap); refresh-token rotation in Phase 2 |
| Retrain promotes the new model with no gate | A worse model goes live silently | Candidate → evaluate → promote, with rollback |
| Any signed-in user can rate any provider | Ratings can be gamed and feed the quality signal | Reviews only after a completed booking |
| No safety boundary in the UI | Users may read a recommendation as clinical endorsement | Site-wide notice and emergency signposting |

## 2. Prioritised roadmap

Effort is for one developer and is approximate.

| Phase | Work | Effort | Depends on |
|---|---|---|---|
| **2a Quick security fixes** | Close ports 8000/3307; `token_version` invalidation on password and role change; logout endpoint; safety and privacy notices; versioned migrations | 1–2 days | — |
| **2b Provider trust** | Verification state machine and events; document types, expiry, versions; expiry check job; admin MFA (TOTP) | 4–6 days | 2a |
| **3 Search and recommendations** | Service areas with coordinates; location extraction; reason codes; recommendation feedback; γ location and δ quality features tuned on validation data; MMR; model versioning, promotion and rollback; full search benchmark | 6–9 days | 2a |
| **4 Bookings** | Provider role and dashboard; services; availability; bookings with transactional double-booking protection; booking events; reviews tied to completed bookings; moderation; notifications and worker | 10–15 days | 2b |
| **5 Analytics** | Zero-result searches, conversion, latency, service-gap indicator, verification processing time | 3–4 days | 3, 4 |
| **6 Research** | Baseline comparisons, chronological validation split, bootstrap confidence intervals, diversity experiment, optional learning-to-rank | 4–6 days | 3 |
| **7 Quality and delivery** | GitHub Actions (lint, backend, MySQL integration, Python, frontend, `npm audit`, `pip-audit`); Playwright end-to-end; OpenAPI; structured logs; deployment and recovery docs | 5–7 days | all |

Phases 2a, 3 and 6 carry the academic contribution (multilingual search, explainable location-aware hybrid ranking, evaluation against baselines). Phase 4 is the largest and is product scope rather than research; it should be included only if time allows.

## 3. Proposed architecture

The four layers stay. Inside Express, routes are grouped into modules (auth, catalogue, bookings, reviews, administration). A worker process (`backend/worker.js`, same codebase, separate container) runs scheduled jobs: document expiry, booking reminders and expiry, notification retries. The ML service gains a model registry directory (`model/versions/<id>/`) and endpoints to evaluate a candidate, promote it and roll back. Only Express is published to the host.

## 4. Database migrations

| # | Change |
|---|---|
| 001 | `schema_migrations` table; adopt existing `migrate.js` steps as 000 |
| 002 | `users.token_version INT NOT NULL DEFAULT 0` |
| 003 | `service_areas` (name, centroid lat/lng); `provider_service_areas`; backfill from `providers.location` |
| 004 | `providers.verification_status` extended to the 8 states; `provider_verification_events` |
| 005 | `provider_verification_documents` (type, expiry, version, review status, reviewer, reason) |
| 006 | `recommendation_feedback` |
| 007 | `model_versions`, `model_evaluations` |
| 008 | `users.role` adds `provider`; `providers.owner_user_id` |
| 009 | `services`, `provider_availability`, `availability_exceptions` |
| 010 | `bookings` (unique on provider + slot start for active states), `booking_events` |
| 011 | `reviews` (unique per booking), `review_reports` |
| 012 | `notifications`, notification preferences |
| 013 | `refresh_sessions`, if refresh tokens are adopted |

## 5. New dependencies

| Package | Layer | Why |
|---|---|---|
| `otplib` | Node | TOTP codes for admin MFA |
| `pino` | Node | Structured JSON logs without passwords or tokens |
| `swagger-ui-express` | Node | Serve the OpenAPI document |
| `@playwright/test` (dev) | Node | Frontend and end-to-end tests |
| `pip-audit` (dev) | Python | Dependency checks in CI |
| `lightgbm` (optional) | Python | Learning-to-rank experiment only, if data supports it |

Location distance, MMR and bootstrap intervals need no new libraries (NumPy and SciPy are already installed).

## 6. Testing strategy

- **Unit:** state machines (verification, booking), permission checks, query normalisation, location extraction, reason codes, MMR.
- **Integration:** Express against a disposable MySQL in CI; concurrent booking requests; evidence access; ML fallback.
- **ML:** existing engine and API suites, plus model promotion, rollback and explanation tests.
- **Frontend and end to end:** Playwright journeys for parent booking and admin verification.
- **Security:** cross-user access, privilege escalation, revoked sessions, upload abuse, ML token.
- Every result reported only after the suite has actually been run.

## 7. Risks

- **Scope.** The full prompt is several weeks of work. Bookings alone touch every layer.
- **Synthetic data.** Interaction data is generated, so recommendation results show the method working, not real-world benefit. Location and booking effects cannot be measured meaningfully without real users.
- **Benchmark labels.** Relevance labels written by the developer bias the search evaluation; independent labellers are needed for a defensible result.
- **Machine resources.** The development machine runs close to its memory limit when the sentence encoder loads.
- **Legal compliance.** The Data Protection Act, 2019 needs a proper assessment; the project should describe its measures, not claim compliance.

## 8. Progress

Agreed scope: the research core (phases 2a, 2b, 3, 6 and 7).

| Phase | Status | Notes |
|---|---|---|
| 2a Quick security fixes | Done, 28 Oct 2026 | ML service and MySQL bound to `127.0.0.1` in Compose; `users.token_version` revokes all sessions on password change, role change and "Sign out of all devices" (`POST /api/auth/logout-all`); versioned migrations with a `schema_migrations` table; safety notice on every page; `privacy.html`. Backend tests 43/43; verified end to end against local MySQL. |
| 2b Provider trust | Done, 28 Oct 2026 | Eight-state verification workflow enforced in `services/verification.js` (`verified` is the APPROVED state); every move recorded in `provider_verification_events`; reasons required for rejection, more-information requests and suspension. Typed, versioned verification documents with expiry and per-document review; approval requires an accepted, current copy of each document the category requires (`categories.required_documents`, editable by admins). Daily expiry job (`npm run expiry-check`) moves lapsed listings to `expired`. Evidence downloads audited. Two-step sign-in (TOTP, RFC 6238, secrets AES-GCM encrypted, replay-protected, rate-limited). Eligibility re-checked when results are served; a re-index during a rebuild is queued, not dropped. Migrations 5–10. Backend 61/61, ML 66 passed + 1 skip; 18-step end-to-end run against local MySQL passed. |
| 3 Search and recommendations | Done, 28 Oct 2026 | Admin-managed `service_areas` (20 Nairobi areas, approximate centres) and `provider_service_areas`; a place named in a query ("near Kilimani", "karibu na Karen") becomes a visible, removable area filter; optional "within N km" widening and nearest-first sort (between area centres, labelled approximate); an empty area search offers nearby areas. Engine: `score = (1-γ-δ)·blend + γ·location + δ·quality`, γ and δ chosen on a validation split cut from the training period. **On the seeded data validation keeps both at 0** (any weight lowers recall), consistent with the weak location signal in the generator; reported as a negative result. Every recommendation carries reasons built from its real score components ("Why am I seeing this?"); query-led lists drop anything below 0.85 of the best match in the catalogue (SBERT; provisional, set by inspection, to be tested in Phase 6). Optional MMR re-ranker (off). Feedback ("not relevant", "too far" …) stored separately and hides the provider for that parent. Model registry: retrain builds an evaluated candidate; it serves only if recall@10 is within 0.01 of the serving version on the same split; promote and rollback from the dashboard, audited. Model selection moved off the test split onto validation. Migrations 11–13. Backend 74/74, ML 83 passed + 1 skip; 15-check end-to-end run (backend → ML → MySQL) passed. The full labelled search benchmark moved to Phase 6, where it belongs with the other experiments. |
| 6 Research | Done, 28 Oct 2026 | `ml-service/research/`: 113 labelled queries (English keyword and paraphrase, Kiswahili, mixed, place, out-of-scope; dev/test split fixed in advance); search benchmark over nine systems including the live route run in-process against MySQL (`npm run benchmark:served`); ablation of the engine; relevance-floor and no-match-threshold sweeps chosen on dev; recommendation baselines (random, popularity, content, collaborative, hybrid on both encoders, hybrid + MMR) with choices made on validation; bootstrap intervals, paired Wilcoxon tests, Holm correction; `python -m research.run_all` regenerates `docs/research/RESULTS.md`. Interpretation in `docs/research/FINDINGS.md`. Main results: search as served returns nothing for 69% of answerable queries (nDCG 0.27 vs 0.80 for the engine); the thesaurus is the largest single contributor; the hybrid beats collaborative-only but not content-only; TF-IDF is as good as SBERT for recommendations; no single similarity threshold separates out-of-scope queries (dev-selected 0.40 not adopted: it would reject "I feel sad since my baby was born"). Defaults unchanged. Fixed: `seed_data.sql` lacked `SET NAMES utf8mb4`, corrupting "crèche" in 8 MySQL rows (repaired). Backend 74/74, ML 106 passed + 1 skip. |
| Account deletion and retention | Done, 1 Nov 2026 | **Self-service deletion** (`DELETE /api/auth/me`: password, plus code with two-step sign-in) removes the account and everything about it by cascade, and refits the live model. **Administrators delete a parent's account** on request (`DELETE /api/admin/users/:id`, audited as `user:delete`, id only). Administrator accounts are refused until the role is removed. **Migration 15:** `admin_logs.admin_id` is `ON DELETE SET NULL`, not `CASCADE`, which had meant that deleting a former administrator erased their audit trail. **Daily retention job** (`services/retention.js`, `npm run retention`): searches 365 days, recommendation logs 90, feedback 365 (never below the hide period), interactions 730; batched deletes; refit after interactions go; first run on the seed deleted nothing. **Model files** pruned to the newest 3 (records kept; promote and rollback refit from parameters). Privacy notice, account page ("Your data"), admin users list, API description, `.env.example` and DEPLOYMENT updated. Live check 8/8; backend 91/91, ML 110 + 1 skip, browser 10/10 with the account test (which now deletes its own account). Still open: password reset, contact details and tracking, data export. |
| Review fixes | Done, 1 Nov 2026 | From the post-Phase-7 review. **One rating per parent per provider:** rating again updates it (migration 14: a virtual generated column `rating_pair` with a unique key; a stored one is refused on cascading foreign keys). Before, a changed rating counted twice in the average and in the engine's quality score, and ratings could be repeated through the API. **One view per parent, provider and day:** page reloads no longer inflate popularity or the profile; the seed's existing same-day repeats are kept. **Weak search matches show the five closest services**, not the whole list ("fundi wa magari" showed 38). Checked live on MySQL (9/9) and in the browser tests. Backend 85/85. Still open from the review: password reset, account deletion and data retention, real-user study, structured listing fields, contact tracking. |
| 7 Quality and delivery | Done, 28 Oct 2026 | **Search by meaning (approved):** free text goes to the engine (`related: false`, up to 200 candidates), filters stay in SQL, a name match always counts, keyword SQL is the automatic fallback (`SEARCH_MODE`). Live route on the test queries: nDCG@10 0.272 → 0.811 (+0.539 [0.421, 0.654]), empty answerable searches 69% → 2%, median 51 → 24 ms. Cost found and handled: 4 of 7 out-of-scope test queries now return listings, so a best match below 0.40 similarity is labelled "none of these clearly matches" rather than hidden. **Logging:** JSON lines in both services with a request id carried from the backend to the ML service; query text never logged (tested); morgan removed. **API docs:** `docs/api/openapi.yaml` (54 operations), served at `/api/openapi.yaml`, with a test that fails if routes and spec disagree. **Browser tests:** Playwright, 10 tests (one writes data, opt-in). **CI:** `.github/workflows/ci.yml`: backend, ML (TF-IDF) plus research scripts, and a full-stack job (MySQL seed, SBERT engine, API, smoke test, browser tests); not yet run on GitHub. **Deployment:** `docs/DEPLOYMENT.md`; `TRUST_PROXY` added (behind a proxy the rate limits were shared by all visitors). README and RUNNING refreshed. Fixed: the integration smoke test's database stub had been stale since Phase 2b, and on Windows it exited non-zero after passing. Backend 83/83, ML 109 + 1 skip, browser 9 + 1 skip, smoke 5/5. |
