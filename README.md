# Cerva CRM

Single-user sales CRM for **Cerva Services** (Indy-area commercial & residential cleaning). Cloudflare Workers + D1 + Workers Assets.

Korē (`kore@cerva.team`) uses a shared password gate. Gmail readonly sync fills **Last contact** from the shared mailbox.

## Phase 1 surfaces

- **Dashboard** — open opps, commercial/residential, MRR, follow-ups, activity tallies (date filters)
- **Leads & Opportunities** — Kanban + detail (12 stages); site address on the opportunity; Lost requires reason
- **Contacts** — people + Gmail last-contact
- **Activities** — log + chronological list
- **Follow-ups** — Overdue / Today / Tomorrow / This Week / Upcoming / None + shortcut chips
- **Customers** — auto-created when stage → Won
- **Settings** — password (D1 `crm_password`) + Gmail connect

Out of scope: multi-user, Reports, quote PDFs, calendar, sending email.

## Stack

- Hono API Worker
- D1 (SQL migrations in `migrations/`)
- Static UI in `public/` (Workers Assets)
- Wrangler for local/dev and deploy

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Open http://localhost:8787 — sign in with `CRM_PASSWORD` from `.dev.vars` (or D1 `crm_password`).

## Secrets

| Secret | Purpose |
| --- | --- |
| `CRM_PASSWORD` | Shared login (optional if D1 `crm_password` is set) |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

Optional: `APP_URL` for OAuth redirect origin.

## Deploy

1. Apply migrations: `npm run db:migrate:remote` (or D1 SQL MCP when Wrangler has no token)
2. Deploy from **`main`** via Workers Builds / `npm run deploy`
3. Sign in, confirm Dashboard + pipeline stages, Won → Customers

## API sketch

| Path | Notes |
| --- | --- |
| `/api/dashboard` | Metrics; `?from=&to=` |
| `/api/opportunities` | CRUD + filters; `PATCH …/stage` |
| `/api/contacts` | Global list + account nested create |
| `/api/activities` | Log + list |
| `/api/follow-ups` | Open opps for bucketing |
| `/api/customers` | Won conversions |
| `/api/settings/password` | Update D1 password when secret unset |
| `/api/gmail/*` | OAuth + sync |
