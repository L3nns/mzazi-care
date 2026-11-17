# Running Mzazi Care manually (without Docker)

This guide starts the three parts of the system by hand on Windows and connects
the web application to the recommendation (ML) service.

```
 Browser ──► Express backend (Node, port 4000) ──► ML service (FastAPI, port 8000)
                 │  also serves the front end           │  KNN + SBERT hybrid engine
                 └──────────────► MySQL (port 3306) ◄────┘  trains from the same database
```

The browser only talks to the backend. The backend calls the ML service, using
a shared token, whenever it needs recommendations. Both services read the same
MySQL database.

Commands are for **PowerShell**, run from the project root
(`mzazi-care\`) unless a step says otherwise.

---

## 0. Prerequisites

| Tool | Version | Check |
|---|---|---|
| MySQL Server | 8.x, running as a Windows service | `Get-Service MySQL*` → `Running` |
| Python | 3.11 or 3.12 | `python --version` |
| Node.js | 18 or newer | `node -v` |

`mysql.exe` is usually not on the PATH, so the commands below call it by its
full path. Each one is a single line you can paste as it is.

---

## 1. Configure the environment files

There are three `.env` files. Each service reads its own folder's `.env` first.
It then falls back to the root `.env` for anything missing.

| File | Read by |
|---|---|
| `.env` (project root) | both services, as the fallback |
| `backend\.env` | the Express backend |
| `ml-service\.env` | the ML service |

These values **must be the same** in every file that sets them:

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | both services use the same database |
| `ML_SERVICE_TOKEN` | the shared secret: the backend sends it and the ML service checks it |

And these connect the backend to the ML service:

| Variable | File | Value |
|---|---|---|
| `ML_SERVICE_URL` | `backend\.env` | `http://localhost:8000` |
| `ML_SERVICE_TOKEN` | `backend\.env` **and** `ml-service\.env` | the same random string in both |
| `MZAZI_DATA_SOURCE` | `ml-service\.env` | `mysql` (train from the live database) |
| `MZAZI_ENCODER` | `ml-service\.env` | `sbert` (or `auto`, which picks SBERT when installed) |

To generate a token:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

> If the token differs between the two files, the site still loads, but
> recommendations fail with `invalid service token`.

---

## 2. Set up the database

### 2a. Create the application user (first time only)

Skip this if the `mzazi` user already exists, which it does if the app or ML
service has connected to the database before. Otherwise log in as root:

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p
```

and run, using the `DB_PASSWORD` from your `.env`:

```sql
CREATE USER IF NOT EXISTS 'mzazi'@'localhost' IDENTIFIED BY 'your-DB_PASSWORD';
GRANT ALL PRIVILEGES ON mzazi_care.* TO 'mzazi'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 2b. Load the schema and seed data (fresh install only)

> **Stop if the database already has accounts you want to keep.**
> `schema.sql` drops and recreates the whole `mzazi_care` database, so every
> registered account and all of its activity is lost. To refresh only the seed
> data on an existing database, back it up first and replace the seed rows
> without dropping anything else.

Run these from the project root:

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p -e "source database/schema.sql"
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p -e "source database/seed_data.sql"
```

Check it loaded (should print 120 / 243 / 5012):

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p -e "SELECT (SELECT COUNT(*) FROM mzazi_care.providers), (SELECT COUNT(*) FROM mzazi_care.users), (SELECT COUNT(*) FROM mzazi_care.interactions);"
```

---

## 3. Start the ML service (terminal 1)

```powershell
cd ml-service

# first time only
python -m venv venv
.\venv\Scripts\pip install -r requirements.txt     # ~2 GB with PyTorch + sentence-transformers

# every time
.\venv\Scripts\python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Leave this terminal open. On start it trains the hybrid model from MySQL in a
background thread. Watch for:

```
INFO data source: mysql
INFO loaded from MySQL (120 providers, 5012 interactions)
...
INFO engine ready
```

The first run downloads the SBERT model (`all-MiniLM-L6-v2`, about 90 MB). Expect
it to take a minute.

**Check it:** open http://localhost:8000/health

```json
{"status": "ok", "model_loaded": true, "encoder": "sbert:all-MiniLM-L6-v2", ...}
```

`"status": "degraded"` means it is still training, or it cannot reach MySQL;
the terminal says which. Interactive API docs are at http://localhost:8000/docs.

---

## 4. Start the backend and front end (terminal 2)

```powershell
cd backend

# first time only
npm install

# every time
npm start
```

Expected output (with `LOG_FORMAT=pretty`; with `json`, the same as one JSON
object per line):

```
10:15:02 INFO  listening url=http://localhost:4000 ml_service=http://localhost:8000 frontend=...\mzazi-care\frontend
```

Every request then logs one line with its path, status, time and request id.
Search text is never logged.

The backend also serves the front end, so you do not need a separate web server.

---

## 5. Confirm the backend can reach the ML service

Open http://localhost:4000/api/health. The `ml` part is the ML service's
own health report, fetched by the backend:

```json
{"status": "ok", "service": "mzazi-care-api",
 "ml": {"status": "ok", "model_loaded": true, "encoder": "sbert:all-MiniLM-L6-v2", ...}}
```

| `ml.status` | Meaning | Fix |
|---|---|---|
| `ok` | connected and the model is trained | nothing to fix |
| `degraded` | connected, model still training or the database is unreachable | wait, or read terminal 1 |
| `unreachable` | the backend cannot reach port 8000 | start the ML service; check `ML_SERVICE_URL` |

Then open **http://localhost:4000**, sign in or register, and the home page
shows personalised recommendations.

---

## 6. Retraining after data changes

The ML service trains once at start-up. After new interactions, or after
reloading the seed:

- **From the app:** sign in as an admin → **Admin** → **Retrain model**. For
  catalogue edits only, use **Re-index catalogue**, which is faster.
- **Or** restart the ML service (Ctrl+C in terminal 1, then run the `uvicorn`
  command again).

To make your account an admin:

```sql
UPDATE mzazi_care.users SET role = 'admin' WHERE email = 'you@example.com';
```

---

## 7. Run the tests

```powershell
cd backend;    npm test                                  # API, spec, logging (no database needed)
cd ml-service; .\venv\Scripts\python -m pytest -q        # engine, ranking, API, research tooling

# browser tests, with both services running (first time: npm install; npx playwright install chromium)
cd e2e; $env:E2E_BASE_URL = "http://localhost:4000"; npx playwright test
```

The browser test that creates an account is skipped unless `E2E_WRITE=1`. It
deletes that account again at the end, through the account page.

---

## 8. Data retention

The backend deletes old searches and activity once a day (periods in `.env`,
section "data retention"). To run it now and see what it deleted:

```powershell
cd backend; npm run retention
```

---

## 9. Reproduce the research results

```powershell
cd backend;    npm run benchmark:served                 # the live search route, both modes (needs MySQL + ML service)
cd ml-service; .\venv\Scripts\python -m research.run_all  # about 4 minutes
```

This writes `docs/research/RESULTS.md`; the interpretation is in
`docs/research/FINDINGS.md`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: pymysql` (or `fastapi`, …) | packages installed in another Python | use `.\venv\Scripts\python`, or re-run the `pip install` |
| `Access denied for user 'mzazi'@'localhost'` | user missing or wrong password | step 2a; check `DB_PASSWORD` in all `.env` files |
| `Unknown database 'mzazi_care'` | schema not loaded | step 2b |
| `The expression after '&' ... was not valid` or `Unexpected token '-u'` | an older version of this guide used a `$mysql` variable | use the full-path commands above, which start with `& "C:\Program Files\MySQL\...\mysql.exe"` |
| ML terminal shows the old interaction count | database still has old seed data | step 2b, then restart the ML service |
| `invalid service token` / recommendations empty | `ML_SERVICE_TOKEN` differs between the `.env` files | make them identical, restart both services |
| `recommendation service timed out` | ML service busy training | wait for `engine ready`; raise `ML_TIMEOUT_MS` if it persists |
| `EADDRINUSE` / port already in use | an old copy is still running | `Get-NetTCPConnection -LocalPort 4000` (or 8000), then `Stop-Process -Id <OwningProcess>` |
| `sentence-transformers not installed; using TF-IDF+SVD` | SBERT missing from the venv | `.\venv\Scripts\pip install sentence-transformers` |
| "crèche" shows as "cr├¿che" | the seed was loaded by an older `seed_data.sql` without `SET NAMES utf8mb4` | reload the seed (step 2b), or fix just those rows: categories 23 and providers 109-115 |
| Search finds only exact words, or `"search_mode":"keyword"` in `/api/services` | the ML service is down or still training, so search fell back to keywords | wait for `engine ready`; check `SEARCH_MODE` is not `keyword` |
| "None of these clearly matches" above results | nothing in the catalogue is close to the request | expected for requests outside maternal and childcare; the closest services are still listed |

---

## Quick start (after first-time setup)

```powershell
# terminal 1
cd ml-service; .\venv\Scripts\python -m uvicorn app:app --host 127.0.0.1 --port 8000

# terminal 2
cd backend; npm start

# browser
start http://localhost:4000
```
