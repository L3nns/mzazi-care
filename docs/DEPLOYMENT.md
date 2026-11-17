# Deploying Mzazi Care

For whoever runs the service: first deployment, TLS, secrets, backups,
upgrades, the model, logs and monitoring. Local development is in
[RUNNING.md](../RUNNING.md); the API is described in
[api/openapi.yaml](api/openapi.yaml).

## 1. What runs where

| Container | Port | Reachable from | Holds state |
| --- | --- | --- | --- |
| `backend` (Express, serves the site) | 4000 | the reverse proxy, then the internet | `uploads` volume: listing images and verification documents |
| `ml-service` (FastAPI) | 8000 | `127.0.0.1` and the backend only | `model_data` volume: model files and `registry.json` |
| `mysql` (8.0) | 3306, published as `127.0.0.1:3307` | `127.0.0.1` and the other containers | `mysql_data` volume |

Only the backend is meant to be public, and only through a TLS reverse proxy.
Browsers never call the ML service; the backend authenticates to it with
`ML_SERVICE_TOKEN`.

**Run a single backend instance.** The rate limits are kept in process memory,
and the daily document-expiry check runs inside the backend. With two
instances, each limit doubles and the check runs twice. The check is harmless
to repeat, but the limits are not.

## 2. Requirements

- Docker Engine 24 or later with the Compose plugin.
- About 4 GB RAM. The sentence-transformer model and PyTorch need about 1.5 GB
  in the ML container.
- About 4 GB of disk for images, plus the data volumes.
- A domain name and a reverse proxy for TLS (Caddy or nginx).

## 3. First deployment

```bash
git clone <repository> mzazi-care && cd mzazi-care
cp .env.example .env
openssl rand -hex 32    # run three times: JWT_SECRET, ML_SERVICE_TOKEN, MFA_ENCRYPTION_KEY
```

Edit `.env`:

| Setting | Value |
| --- | --- |
| `JWT_SECRET`, `ML_SERVICE_TOKEN`, `MFA_ENCRYPTION_KEY` | Three different random values. The backend refuses to start in production with a missing, placeholder or short (fewer than 32 characters) `JWT_SECRET`. |
| `DB_PASSWORD`, `MYSQL_ROOT_PASSWORD` | New passwords. |
| `CORS_ORIGIN` | Leave empty when the site and API share an origin (the normal case). |
| `TRUST_PROXY=1` | Behind one reverse proxy. Without it, every visitor shares the proxy's address and the login limit (20 per 15 minutes) applies to everyone at once. |
| `LOG_FORMAT=json` | The default in Compose. |

Then:

```bash
docker compose up -d --build
docker compose logs -f ml-service    # first start trains the model: about 1-2 minutes
curl -s http://127.0.0.1:4000/api/health
```

Health reports `"model_loaded": true` once training finishes. Until then,
search falls back to keyword matching and recommendations to popularity.

**Database.** On its first start, the MySQL container loads `database/schema.sql`
and `database/seed_data.sql` (synthetic demonstration data). For a real
launch, load the schema only and remove the seed mount from
`docker-compose.yml` first. The backend applies any pending migrations each
time it starts.

**First administrator.** Registration only creates parent accounts. Register,
then promote the account once:

```bash
docker compose exec mysql mysql -uroot -p mzazi_care \
  -e "UPDATE users SET role = 'admin' WHERE email = 'you@example.org';"
```

Then turn on two-step sign-in for the account (Account, then Password and
sign-in). Later administrators can be promoted from Admin, then Registered users.

## 4. TLS and the reverse proxy

A minimal Caddyfile, with automatic certificates:

```
mzazicare.example.org {
    encode gzip
    reverse_proxy 127.0.0.1:4000
}
```

Caddy passes `X-Forwarded-For`, so set `TRUST_PROXY=1`. Then change the
backend's port mapping in `docker-compose.yml` to `"127.0.0.1:4000:4000"`, so
the plain-HTTP port is not reachable from outside. The backend already sends
security headers (Helmet), including a strict Content-Security-Policy.

## 5. Secrets

| Secret | If it leaks | Rotating it |
| --- | --- | --- |
| `JWT_SECRET` | Anyone can sign session tokens. | Change it and restart the backend. Every user is signed out. |
| `MFA_ENCRYPTION_KEY` | Two-step secrets in a database copy can be decrypted. | **Cannot simply be changed:** every enrolled authenticator stops working. Users must turn two-step sign-in off and on again (or an administrator clears `mfa_enabled` in SQL), then the key can change. |
| `ML_SERVICE_TOKEN` | The ML service is bound to localhost, so exposure is limited. | Change it in `.env` and restart both services together. |
| Database passwords | Full data access. | Change in MySQL, then in `.env`, then restart. |

Keep `.env` out of version control (it is in `.gitignore`) and readable only
by the deploying user: `chmod 600 .env`.

## 6. Backups and restore

Three things hold state; back up all three, at least nightly:

```bash
# 1. Database (consistent snapshot, no lock on InnoDB tables)
docker compose exec -T mysql mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
  --single-transaction --routines mzazi_care | gzip > backup/db-$(date +%F).sql.gz

# 2. Uploaded images and verification documents
docker run --rm -v mzazi-care_uploads:/data -v "$PWD/backup":/out alpine \
  tar czf /out/uploads-$(date +%F).tgz -C /data .

# 3. Model versions and registry (recreatable by retraining, but this keeps history)
docker run --rm -v mzazi-care_model_data:/data -v "$PWD/backup":/out alpine \
  tar czf /out/model-$(date +%F).tgz -C /data .
```

Volume names start with the Compose project name, which is the directory name
by default (`mzazi-care_` here); `docker volume ls` shows yours.

Verification documents are personal data: store the backups encrypted, and
keep them only as long as the privacy notice (`frontend/privacy.html`) says.

**Restore** (into a stopped stack):

```bash
gunzip -c backup/db-YYYY-MM-DD.sql.gz | docker compose exec -T mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" mzazi_care
docker run --rm -v mzazi-care_uploads:/data -v "$PWD/backup":/in alpine tar xzf /in/uploads-YYYY-MM-DD.tgz -C /data
```

Test a restore on a spare machine before you need one.

**Backups and deletion.** A deleted account is gone from the live database at
once, but it is still in older backups. Keep backups only as long as you need
them, for example 30 days, so that deleted data is also gone from them within
that time. A restore brings deleted accounts back: after restoring, delete
again any accounts that were deleted after the backup was taken. The audit log
records each deletion done by an administrator (`user:delete`).

## 7. Upgrades and rolling back

```bash
# back up first (section 6): migrations only move forward
git pull
docker compose up -d --build
docker compose logs backend | grep -i migrat
```

Migrations are versioned (`schema_migrations`) and applied when the backend
starts. They are additive, so the previous release usually runs against the
newer schema. To roll back code: check out the previous tag and
`docker compose up -d --build`. To roll back data: restore the backup taken
before the upgrade.

## 8. The recommendation model

- **Re-index** (Admin, then Model) refits the serving configuration on current
  data. Use it after bulk listing changes. It also runs automatically after an
  administrator edits a listing.
- **Retrain** builds a candidate. It chooses its settings on a validation
  split, scores them on a test split, and records the version in the registry.
  The candidate serves only if its recall@10 is within `MZAZI_PROMOTE_TOLERANCE`
  (0.01) of the serving version's. Otherwise an administrator decides.
  `MZAZI_AUTO_PROMOTE=false` makes every promotion manual.
- **Promote** and **Roll back** switch versions instantly; both are audited.
- With the default encoder, model files are small. The sentence-transformer
  weights are baked into the image, not the volume.

**Search depends on the engine.** Free text is matched by meaning
(`SEARCH_MODE=semantic`). If the engine is down or still training, search
falls back to keyword matching automatically, and keeps working at lower
quality. `SEARCH_MODE=keyword` forces the fallback, for example to rule the
engine out while investigating a problem.

**A light deployment without PyTorch** (`MZAZI_ENCODER=tfidf`, with
`sentence-transformers` removed from `requirements.txt`) works. It is weaker
for searches that describe a need in plain words rather than naming the
service (see docs/research/RESULTS.md), and it has no relevance floor.

## 9. Logs

Both services write one JSON object per line to stdout:

```bash
docker compose logs -f backend ml-service
docker compose logs backend | jq 'select(.level == "error")'
```

Every request has an id. It is returned to the browser in `X-Request-Id`,
sent from the backend to the ML service, and written on every log line of
both services:

```bash
docker compose logs backend ml-service | grep '"request_id":"<id>"'
```

**Deliberately not logged:** query strings (search text is the parent's own
words), request bodies, passwords, tokens and two-step codes. Request lines
hold the method, path, status, duration and numeric user id. Ship stdout to
whatever log store you use; Docker's default `json-file` driver needs a size
limit, or it fills the disk:

```yaml
# docker-compose.override.yml
services:
  backend:    { logging: { options: { max-size: "20m", max-file: "5" } } }
  ml-service: { logging: { options: { max-size: "20m", max-file: "5" } } }
```

`LOG_LEVEL=debug` adds static-file and health-check requests.

## 10. The map and its third-party services

The search page's map uses two OpenStreetMap services. Both are free and
run by volunteers, with usage policies meant for light use.

| Service | Used for | Policy | If you outgrow it |
| --- | --- | --- | --- |
| `tile.openstreetmap.org` | map images, loaded by the visitor's browser | [tile usage policy](https://operations.osmfoundation.org/policies/tiles/): attribution (shown), no heavy use | a commercial tile provider; change `TILES` in `frontend/js/map.js` and `imgSrc` in `backend/server.js` |
| Nominatim | finding places that are not service areas, from the backend | [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/): at most 1 request a second (enforced), identifying User-Agent, results cached | `NOMINATIM_URL` for your own or a paid Nominatim; `GEOCODER=off` to match service areas only |

- **Set `GEOCODER_CONTACT`** to a monitored email address; it goes in the
  User-Agent.
- **Place search has its own rate limit:** 30 requests a minute per visitor,
  and at most 5 queued lookups. Beyond that it answers 503 ("busy").
- **Both services see visitor data.** The tile servers see the browser's IP
  address; Nominatim sees the typed place text. The privacy notice says so.
- **Leaflet 1.9.4 is shipped with the site** (`frontend/vendor/leaflet-1.9.4/`,
  BSD-2-Clause licence included), so no script comes from a CDN.

## 11. Data retention and deletion

A daily job in the backend (`backend/services/retention.js`) deletes personal
data past its period. Run it by hand with
`docker compose exec backend npm run retention`, which prints what it deleted.

| Data | Kept for | Setting |
| --- | --- | --- |
| Searches | 365 days | `SEARCH_RETENTION_DAYS` |
| Recommendations shown, with scores | 90 days | `RECOMMENDATION_LOG_RETENTION_DAYS` |
| "Not for me" answers | 365 days (never less than `FEEDBACK_HIDE_DAYS`) | `FEEDBACK_RETENTION_DAYS` |
| Views, clicks, saves, ratings | 730 days | `INTERACTION_RETENTION_DAYS` |
| Model files (`model_data` volume) | the 3 newest | `MZAZI_KEEP_MODEL_FILES` |
| Accounts, preferences, saved services | until the account is deleted | |
| Admin audit log | not purged | |

`0` keeps that data indefinitely. **The privacy notice
(`frontend/privacy.html`) states these periods: change both together.**

**Deleting an account.** A parent deletes their own account from Account,
then Your data (password, and the code if two-step sign-in is on). A parent who
cannot sign in can ask an administrator, who deletes it from Admin, then
Registered users; that deletion is recorded in the audit log.

- **Everything about the parent goes at once:** profile, preferences,
  searches, activity, ratings, feedback and logged recommendations. The live
  model is refitted at once, so it forgets them too.
- **Stored model files still hold the parent's activity** until three newer
  versions have been trained.
- **Administrator accounts cannot be deleted.** Remove the role first. Their
  audit entries are kept, with the account link cleared.

## 12. Monitoring

- **Liveness:** `GET /api/health` (the Docker health check already polls it).
  Alert if `ml.status` is not `ok` or `ml.model_loaded` is false for more than
  10 minutes. Search is then running in keyword fallback.
- **Errors:** alert on `level: "error"` lines.
- **Slow requests:** request lines carry `ms`. On the seed data, search takes
  about 25 ms (median) and 60 ms (95th percentile); investigate sustained
  values ten times that.
- **Verification documents:** the admin dashboard lists those expiring within
  `DOCUMENT_WARN_DAYS`. Listings with lapsed documents are moved to "expired"
  automatically each day.

## 13. Before going live

- [ ] The three secrets in `.env` are new random values; `.env` is `chmod 600`.
- [ ] The seed data is not loaded (or is deliberately kept for a demonstration).
- [ ] TLS through the proxy; `TRUST_PROXY=1`; port 4000 bound to `127.0.0.1`.
- [ ] Every administrator account has two-step sign-in on.
- [ ] Nightly backups of the database, uploads and model run, and a restore has been tested.
- [ ] Backups expire (for example after 30 days), and the retention periods match the privacy notice.
- [ ] Log rotation is configured.
- [ ] `/api/health` is monitored.
- [ ] The privacy notice names the real data controller and contact.
- [ ] `GEOCODER_CONTACT` is set, and expected map traffic fits the OpenStreetMap usage policies (section 10).
