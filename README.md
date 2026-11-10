# Cerva CRM

Single-user CRM for **Cerva Services** (Indy-area commercial & residential cleaning). Built on Cloudflare Workers + D1 + Workers Assets.

Korē (`kore@cerva.team`) uses a shared password gate. Gmail readonly sync fills **Last contact** from the shared mailbox.

## Features

- Accounts + contacts (residential / commercial)
- Pipeline board (lead → quoted → won / lost) with drag-and-drop or stage buttons
- Last email contact per account/contact via Gmail sync (cron ~every 30 min + Sync now)
- Shared `CRM_PASSWORD` cookie auth

Out of scope: multi-user, quote PDFs, job calendar, public quote form, sending email.

## Stack

- Hono API Worker
- D1 (SQL migrations in `migrations/`)
- Static UI in `public/` (Workers Assets)
- Wrangler for local/dev and deploy

## Local development

```bash
npm install

# Optional: copy and edit local secrets
cp .dev.vars.example .dev.vars

# Apply D1 migrations to local DB
npm run db:migrate:local

# Start worker (includes /cdn-cgi/local/scheduled for cron testing)
npm run dev
```

Open http://localhost:8787 — sign in with the `CRM_PASSWORD` from `.dev.vars`.

Test cron sync:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/30+*+*+*+*"
```

## Required secrets

Set these with Wrangler (or Workers dashboard → Settings → Variables and Secrets):

| Secret | Purpose |
| --- | --- |
| `CRM_PASSWORD` | Shared login password for Korē |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

Optional var (plain env, not secret):

| Var | Purpose |
| --- | --- |
| `APP_URL` | Canonical public origin for OAuth redirect, e.g. `https://cerva-crm.<subdomain>.workers.dev` |

```bash
npx wrangler secret put CRM_PASSWORD
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Locally, put the same values in `.dev.vars` (gitignored).

### Google OAuth setup

1. Create an OAuth **Web application** client in Google Cloud Console.
2. Enable the **Gmail API**.
3. Authorized redirect URI: `https://<your-worker-host>/api/oauth/gmail/callback` (and `http://localhost:8787/api/oauth/gmail/callback` for local).
4. Scope used: `https://www.googleapis.com/auth/gmail.readonly`.
5. In the CRM, open **Gmail → Connect Gmail** while signed into the shared Cerva mailbox. Refresh token is stored in D1 (`app_settings`).

## First deploy checklist (GitHub → Workers on `main`)

1. Create the D1 database once:

   ```bash
   npx wrangler d1 create cerva-crm
   ```

2. Paste the returned `database_id` into `wrangler.toml` (replace the placeholder UUID).

3. Apply migrations remotely:

   ```bash
   npm run db:migrate:remote
   ```

4. Set secrets (`CRM_PASSWORD`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and optionally `APP_URL` as a Worker variable.

5. Connect the GitHub repo to Cloudflare Workers Builds (or keep using `npm run deploy`). Ensure production deploys from **`main`**.

6. Confirm cron trigger `*/30 * * * *` is present in `wrangler.toml` after deploy.

7. Sign in, connect Gmail, create an account/contact with a known email, hit **Sync now**, confirm Last contact fills in.

## API sketch

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/login` | `{ password }` → session cookie |
| GET/POST/PUT/DELETE | `/api/accounts`… | CRUD + nested contacts |
| GET/POST/PUT/PATCH/DELETE | `/api/deals`… | Pipeline; `PATCH …/stage` |
| GET | `/api/oauth/gmail/start` | Begin OAuth |
| GET | `/api/oauth/gmail/callback` | OAuth redirect |
| POST | `/api/gmail/sync` | On-demand sync |

## Project layout

```
migrations/     D1 SQL
public/         UI (HTML/CSS/JS)
src/            Worker (Hono API, auth, Gmail, cron)
wrangler.toml   Worker name, D1, assets, cron
```
