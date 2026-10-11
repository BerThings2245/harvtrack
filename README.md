# HarvTrack — Smart Integrated Livestock and Harvest Management System

A Progressive Web Application (PWA) and Flask backend for Titular Farm, Barangay San Nicolas, San Pablo City, Laguna.
One interface serves the Owner, Farmhands, and Buyers on both mobile and desktop browsers.

## Project structure
```
harvtrack-project/
├── index.html            # App shell: landing page, login/register, containers rendered by js/app.js
├── css/style.css         # Design tokens, layout, components
├── js/app.js             # Client logic: state loading, rendering, events, offline action queue
├── sw.js                 # Service worker (network-first with offline fallback; /api/ requests are never cached)
├── manifest.json         # PWA manifest (name, icons, theme) so the app can be installed
├── server.py             # Flask + SQLAlchemy backend (REST API, static file routing, seed data)
├── img/                  # App icons and uploaded product images
├── test_harvtrack_api.py # API-level pytest suite (see "Tests")
├── Dockerfile            # Container image (gunicorn serving wsgi:app)
├── wsgi.py               # WSGI entry point: creates/upgrades tables once, then serves server.py's app
├── docker-compose.yml    # API + PostgreSQL primary + standby instance (replication not configured)
├── .env.example          # Copy to .env and set HT_DB_PASSWORD and HT_SECRET for Docker
└── .github/workflows/    # GitHub Actions CI/CD workflow
```

## Run locally
```bash
pip install flask flask-sqlalchemy
python server.py
```
Open http://localhost:8000. On first start the SQLite database (`harvtrack.db`) is created and seeded with
demo data for Titular Farm. Delete the file to reset it.

Set a private signing secret before real use (it signs login tokens):
```bash
export HT_SECRET="a-long-random-string"      # Windows PowerShell: $env:HT_SECRET="..."
```
On start-up the server upgrades an existing database in place (adds the inventory reorder level and hashes any old
plain-text passwords), so your current `harvtrack.db` keeps working.

Demo accounts (all use the password `farmtrack123`; for demonstration only):
- Owner: `owner@farm.ph`
- Farmhand: `hand@farm.ph`
- Buyer: `buyer@farm.ph`

The Owner creates Owner/Farmhand accounts from the **Users** page; Buyers register themselves from the landing page.
Philippine mobile numbers are validated as 11 digits starting with `09`.

## API
Every endpoint except `/api/login` and `/api/register` needs the header `Authorization: Bearer <token>` (valid for 12 hours).
| Endpoint | Purpose |
|---|---|
| `POST /api/login` | `{email, password, role}` -> `{token, user}`. Passwords are checked against a hash; repeated failures are throttled. |
| `POST /api/register` | Public buyer self-registration (the role is always `buyer`) -> `{token, user}`. |
| `GET /api/state` | Returns the system state for the signed-in role (see below). Also flags Due tasks past their date as Overdue and creates alerts. Never includes passwords. |
| `POST /api/action` | Single action handler. Body: `{"action": "...", "payload": {...}}`. Each action is allowed only for certain roles (`PERMISSIONS` in `server.py`); identity fields such as buyer, recorder and completer are set by the server. |
| `POST /api/upload` | Owner only. Uploads a JPG/PNG/GIF/WEBP product image (max 5 MB) to `img/`. |

What `/api/state` returns: the **owner** gets everything; a **farmhand** gets livestock, crops, their own tasks and alerts;
a **buyer** gets products, their own orders and alerts. Only `index.html`, `sw.js`, `manifest.json` and the `css/`, `js/`, `img/` folders are served as files;
`server.py` and the database are not downloadable.

## Notifications and offline behavior
- Alerts are in-app only (bell icon). The server creates them for overdue tasks, newly assigned tasks, order updates, and **low stock**: each inventory item has a reorder level, and the owner is alerted when a stock-out takes it to or below that level. There is no SMS or push delivery.
- When the browser is offline, actions sent through `apiAction()` are queued in `localStorage` and replayed when the connection returns.
- The service worker is registered from `js/app.js` and the app is installable through `manifest.json`. After changing any cached file, bump `CACHE_NAME` in `sw.js` so users receive the update.

## Database configuration
`server.py` uses SQLite by default. To make the database configurable (needed for the Docker/PostgreSQL deployment and for the tests), use:
```python
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('HT_DB', 'sqlite:///harvtrack.db')
```
For PostgreSQL also `pip install psycopg2-binary` and set `HT_DB=postgresql://user:password@db-primary:5432/harvtrack`.
If you run the app with a WSGI server instead of `python server.py`, call `init_database()` once inside an app context to create the tables and apply the upgrade.

## Docker
```bash
cp .env.example .env        # then edit HT_DB_PASSWORD and HT_SECRET
docker compose up --build
```
The API container runs `gunicorn --preload wsgi:app` on port 8000. `wsgi.py` calls `init_database()` once at start-up.
The `db-replica` service is only a provisioned standby: streaming replication is not configured, so it gives no failover yet.
Put an HTTPS reverse proxy in front of port 8000 for real use.

## Tests
```bash
pip install pytest
pytest -v test_harvtrack_api.py
```
The suite drives the API with Flask's test client against a fresh seeded SQLite database, logging in as the owner, farmhand or buyer.
It covers the use cases (registration, tasks, harvest, inventory, orders, sync) and security checks (hashed passwords, login and role checks,
state limited by role, token expiry, upload and static-file restrictions, login throttling, SQL injection). The HTTPS test is skipped:
HTTPS must be checked on the deployed URL.

## Known limitations
- HTTPS must be provided by the hosting layer (reverse proxy); `server.py` serves plain HTTP. Set `HT_SECRET` in production.
- Login throttling is kept in memory, so it is per server process.
- Login tokens are held in memory by the page, so refreshing the browser asks the user to log in again.
- Orders do not reserve stock: stock is deducted when the owner marks an order Completed.
- Alerts are in-app only (no SMS, e-mail or push).
- Tasks are created by the owner; the server does not generate recurring care or harvest schedules by itself.
- Livestock and crop plots cannot be edited after creation (livestock health and crop stage can be updated; records can be removed).
