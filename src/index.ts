import { Hono } from "hono";
import { isAuthed, login, logout } from "./auth";
import {
  exchangeCode,
  getSetting,
  gmailStatus,
  oauthAuthorizeUrl,
  setSetting,
  syncGmailTouches,
} from "./gmail";
import type { DealStage, Env } from "./types";

const STAGES = new Set<DealStage>(["lead", "quoted", "won", "lost"]);

const app = new Hono<{ Bindings: Env }>();

function originOf(c: { req: { url: string }; env: Env }): string {
  if (c.env.APP_URL) return c.env.APP_URL.replace(/\/$/, "");
  return new URL(c.req.url).origin;
}

function publicPath(path: string): boolean {
  return (
    path === "/login" ||
    path === "/login/" ||
    path === "/styles.css" ||
    path === "/cerva-logo.png" ||
    path === "/cerva-icon.png" ||
    path === "/cerva-hero.jpg" ||
    path === "/api/login" ||
    path === "/api/oauth/gmail/callback" ||
    path.startsWith("/favicon")
  );
}

app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (publicPath(path)) return next();
  if (await isAuthed(c)) return next();
  if (path.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
  return c.redirect("/login");
});

app.post("/api/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { password?: string } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  if (!(await login(c, password))) return c.json({ error: "invalid password" }, 401);
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  logout(c);
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const gmail = await gmailStatus(c.env.DB);
  return c.json({ ok: true, gmail });
});

/* ---------- accounts ---------- */

app.get("/api/accounts", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.*,
       (SELECT MAX(et.last_contact_at)
          FROM contacts ct
          LEFT JOIN email_touch et ON et.contact_email = lower(trim(ct.email))
         WHERE ct.account_id = a.id) AS last_contact_at
     FROM accounts a
     ORDER BY a.name COLLATE NOCASE`,
  ).all();
  return c.json({ accounts: rows.results ?? [] });
});

app.get("/api/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const account = await c.env.DB.prepare(
    `SELECT a.*,
       (SELECT MAX(et.last_contact_at)
          FROM contacts ct
          LEFT JOIN email_touch et ON et.contact_email = lower(trim(ct.email))
         WHERE ct.account_id = a.id) AS last_contact_at
     FROM accounts a WHERE a.id = ?`,
  )
    .bind(id)
    .first();
  if (!account) return c.json({ error: "not found" }, 404);

  const contacts = await c.env.DB.prepare(
    `SELECT c.*, et.last_contact_at, et.subject AS last_subject, et.gmail_thread_id
     FROM contacts c
     LEFT JOIN email_touch et ON et.contact_email = lower(trim(c.email))
     WHERE c.account_id = ?
     ORDER BY c.is_primary DESC, c.name COLLATE NOCASE`,
  )
    .bind(id)
    .all();

  const deals = await c.env.DB.prepare(
    `SELECT * FROM deals WHERE account_id = ? ORDER BY created_at DESC`,
  )
    .bind(id)
    .all();

  return c.json({
    account,
    contacts: contacts.results ?? [],
    deals: deals.results ?? [],
  });
});

app.post("/api/accounts", async (c) => {
  const body = await c.req.json<{
    name?: string;
    type?: string;
    notes?: string;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const type = body.type === "commercial" ? "commercial" : "residential";
  const result = await c.env.DB.prepare(
    `INSERT INTO accounts (name, type, notes) VALUES (?, ?, ?) RETURNING id`,
  )
    .bind(body.name.trim(), type, body.notes ?? null)
    .first<{ id: number }>();
  return c.json({ id: result!.id }, 201);
});

app.put("/api/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    name?: string;
    type?: string;
    notes?: string;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const type = body.type === "commercial" ? "commercial" : "residential";
  const result = await c.env.DB.prepare(
    `UPDATE accounts SET name=?, type=?, notes=? WHERE id=?`,
  )
    .bind(body.name.trim(), type, body.notes ?? null, id)
    .run();
  if (!result.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/accounts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

/* ---------- contacts ---------- */

app.post("/api/accounts/:id/contacts", async (c) => {
  const accountId = Number(c.req.param("id"));
  const body = await c.req.json<{
    name?: string;
    email?: string;
    phone?: string;
    is_primary?: boolean;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  if (body.is_primary) {
    await c.env.DB.prepare(`UPDATE contacts SET is_primary = 0 WHERE account_id = ?`)
      .bind(accountId)
      .run();
  }
  const result = await c.env.DB.prepare(
    `INSERT INTO contacts (account_id, name, email, phone, is_primary)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      accountId,
      body.name.trim(),
      body.email?.trim() || null,
      body.phone?.trim() || null,
      body.is_primary ? 1 : 0,
    )
    .first<{ id: number }>();
  return c.json({ id: result!.id }, 201);
});

app.put("/api/contacts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    name?: string;
    email?: string;
    phone?: string;
    is_primary?: boolean;
    account_id?: number;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);

  const existing = await c.env.DB.prepare(`SELECT account_id FROM contacts WHERE id = ?`)
    .bind(id)
    .first<{ account_id: number }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  if (body.is_primary) {
    await c.env.DB.prepare(`UPDATE contacts SET is_primary = 0 WHERE account_id = ?`)
      .bind(existing.account_id)
      .run();
  }

  await c.env.DB.prepare(
    `UPDATE contacts SET name=?, email=?, phone=?, is_primary=? WHERE id=?`,
  )
    .bind(
      body.name.trim(),
      body.email?.trim() || null,
      body.phone?.trim() || null,
      body.is_primary ? 1 : 0,
      id,
    )
    .run();
  return c.json({ ok: true });
});

app.delete("/api/contacts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare(`DELETE FROM contacts WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

/* ---------- deals / pipeline ---------- */

app.get("/api/deals", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.*, a.name AS account_name
     FROM deals d
     JOIN accounts a ON a.id = d.account_id
     ORDER BY d.stage, d.created_at DESC`,
  ).all();
  return c.json({ deals: rows.results ?? [] });
});

app.post("/api/deals", async (c) => {
  const body = await c.req.json<{
    account_id?: number;
    stage?: string;
    cleaning_type?: string;
    frequency?: string;
    value_cents?: number | null;
    preferred_at?: string;
    address?: string;
    city?: string;
    property_type?: string;
    sq_ft?: number | null;
    notes?: string;
  }>();
  if (!body.account_id) return c.json({ error: "account_id required" }, 400);
  const stage = (body.stage && STAGES.has(body.stage as DealStage) ? body.stage : "lead") as string;
  const result = await c.env.DB.prepare(
    `INSERT INTO deals (account_id, stage, cleaning_type, frequency, value_cents, preferred_at, address, city, property_type, sq_ft, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      body.account_id,
      stage,
      body.cleaning_type ?? null,
      body.frequency ?? null,
      body.value_cents ?? null,
      body.preferred_at ?? null,
      body.address ?? null,
      body.city ?? null,
      body.property_type ?? null,
      body.sq_ft ?? null,
      body.notes ?? null,
    )
    .first<{ id: number }>();
  return c.json({ id: result!.id }, 201);
});

app.put("/api/deals/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    stage?: string;
    cleaning_type?: string;
    frequency?: string;
    value_cents?: number | null;
    preferred_at?: string;
    address?: string;
    city?: string;
    property_type?: string;
    sq_ft?: number | null;
    notes?: string;
  }>();

  const existing = await c.env.DB.prepare(`SELECT * FROM deals WHERE id = ?`).bind(id).first<{
    stage: string;
    cleaning_type: string | null;
    frequency: string | null;
    value_cents: number | null;
    preferred_at: string | null;
    address: string | null;
    city: string | null;
    property_type: string | null;
    sq_ft: number | null;
    notes: string | null;
  }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  const stage =
    body.stage && STAGES.has(body.stage as DealStage) ? body.stage : existing.stage;

  await c.env.DB.prepare(
    `UPDATE deals SET stage=?, cleaning_type=?, frequency=?, value_cents=?, preferred_at=?, address=?, city=?, property_type=?, sq_ft=?, notes=?
     WHERE id=?`,
  )
    .bind(
      stage,
      body.cleaning_type ?? existing.cleaning_type,
      body.frequency ?? existing.frequency,
      body.value_cents !== undefined ? body.value_cents : existing.value_cents,
      body.preferred_at ?? existing.preferred_at,
      body.address !== undefined ? body.address : existing.address,
      body.city !== undefined ? body.city : existing.city,
      body.property_type !== undefined ? body.property_type : existing.property_type,
      body.sq_ft !== undefined ? body.sq_ft : existing.sq_ft,
      body.notes ?? existing.notes,
      id,
    )
    .run();
  return c.json({ ok: true });
});

app.patch("/api/deals/:id/stage", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ stage?: string }>();
  if (!body.stage || !STAGES.has(body.stage as DealStage)) {
    return c.json({ error: "invalid stage" }, 400);
  }
  const result = await c.env.DB.prepare(`UPDATE deals SET stage = ? WHERE id = ?`)
    .bind(body.stage, id)
    .run();
  if (!result.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/deals/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare(`DELETE FROM deals WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

/* ---------- gmail ---------- */

app.get("/api/gmail/status", async (c) => {
  return c.json(await gmailStatus(c.env.DB));
});

app.get("/api/oauth/gmail/start", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: "Google OAuth secrets not configured" }, 500);
  }
  const state = crypto.randomUUID();
  await setSetting(c.env.DB, "gmail_oauth_state", state);
  const redirectUri = `${originOf(c)}/api/oauth/gmail/callback`;
  return c.redirect(oauthAuthorizeUrl(c.env, redirectUri, state));
});

app.get("/api/oauth/gmail/callback", async (c) => {
  const url = new URL(c.req.url);
  const err = url.searchParams.get("error");
  if (err) return c.text(`OAuth error: ${err}`, 400);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = await getSetting(c.env.DB, "gmail_oauth_state");
  if (!code || !state || !expected || state !== expected) {
    return c.text("Invalid OAuth state", 400);
  }

  const redirectUri = `${originOf(c)}/api/oauth/gmail/callback`;
  try {
    const tokens = await exchangeCode(c.env, code, redirectUri);
    if (tokens.refresh_token) {
      await setSetting(c.env.DB, "gmail_refresh_token", tokens.refresh_token);
    } else {
      // Re-consent may omit refresh_token if already granted; keep existing.
      const existing = await getSetting(c.env.DB, "gmail_refresh_token");
      if (!existing) return c.text("No refresh token returned. Revoke app access and retry.", 400);
    }
    await setSetting(c.env.DB, "gmail_oauth_state", "");
    return c.redirect("/?gmail=connected");
  } catch (e) {
    console.error(e);
    return c.text(`OAuth failed: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
});

app.post("/api/gmail/sync", async (c) => {
  try {
    const result = await syncGmailTouches(c.env);
    return c.json(result);
  } catch (e) {
    console.error(e);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.post("/api/gmail/disconnect", async (c) => {
  await setSetting(c.env.DB, "gmail_refresh_token", "");
  return c.json({ ok: true });
});

/* ---------- static assets ---------- */

app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      syncGmailTouches(env)
        .then((r) => console.log("gmail sync", r))
        .catch((e) => console.error("gmail sync failed", e)),
    );
  },
};
