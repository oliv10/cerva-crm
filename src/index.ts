import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { isAuthed, login, logout, sessionToken } from "./auth";
import {
  exchangeCode,
  getSetting,
  gmailStatus,
  oauthAuthorizeUrl,
  setSetting,
  syncGmailTouches,
} from "./gmail";
import { OPPORTUNITY_STAGES, type Env, type OpportunityStage } from "./types";

const STAGES = new Set<string>(OPPORTUNITY_STAGES);

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

function dollarsToCents(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function parseCents(v: unknown, fallback: number | null = null): number | null {
  if (v === undefined) return fallback;
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

async function ensureCustomer(db: D1Database, opportunityId: number): Promise<void> {
  const row = await db
    .prepare(
      `SELECT o.*, a.name AS account_name, a.type AS account_type
       FROM opportunities o
       JOIN accounts a ON a.id = o.account_id
       WHERE o.id = ?`,
    )
    .bind(opportunityId)
    .first<{
      id: number;
      account_id: number;
      account_name: string;
      account_type: string;
      address: string | null;
      city: string | null;
      frequency: string | null;
      quoted_mrr_cents: number | null;
      expected_start: string | null;
      notes: string | null;
      stage: string;
    }>();
  if (!row || row.stage !== "won") return;

  await db
    .prepare(
      `INSERT INTO customers (
         account_id, opportunity_id, name, type, service_address, city, frequency, mrr_cents, start_date, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(opportunity_id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         service_address = excluded.service_address,
         city = excluded.city,
         frequency = excluded.frequency,
         mrr_cents = excluded.mrr_cents,
         start_date = excluded.start_date,
         notes = excluded.notes`,
    )
    .bind(
      row.account_id,
      row.id,
      row.account_name,
      row.account_type,
      row.address,
      row.city,
      row.frequency,
      row.quoted_mrr_cents,
      row.expected_start,
      row.notes,
    )
    .run();
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

/* ---------- dashboard ---------- */

app.get("/api/dashboard", async (c) => {
  const from = c.req.query("from") || null;
  const to = c.req.query("to") || null;

  const open = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM opportunities WHERE stage NOT IN ('won', 'lost')`,
  ).first<{ n: number }>();

  const byType = await c.env.DB.prepare(
    `SELECT a.type, COUNT(*) AS n
     FROM opportunities o
     JOIN accounts a ON a.id = o.account_id
     WHERE o.stage NOT IN ('won', 'lost')
     GROUP BY a.type`,
  ).all<{ type: string; n: number }>();

  const mrr = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(estimated_mrr_cents), 0) AS estimated,
       COALESCE(SUM(quoted_mrr_cents), 0) AS quoted
     FROM opportunities
     WHERE stage NOT IN ('won', 'lost')`,
  ).first<{ estimated: number; quoted: number }>();

  const today = new Date();
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const todayStr = ymd(today);

  const overdue = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM opportunities
     WHERE next_follow_up_at IS NOT NULL AND date(next_follow_up_at) < date(?)
       AND stage NOT IN ('won', 'lost')`,
  )
    .bind(todayStr)
    .first<{ n: number }>();

  const dueToday = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM opportunities
     WHERE next_follow_up_at IS NOT NULL AND date(next_follow_up_at) = date(?)
       AND stage NOT IN ('won', 'lost')`,
  )
    .bind(todayStr)
    .first<{ n: number }>();

  let activitySql = `SELECT COUNT(*) AS n FROM activities WHERE 1=1`;
  const binds: string[] = [];
  if (from) {
    activitySql += ` AND date(happened_at) >= date(?)`;
    binds.push(from);
  }
  if (to) {
    activitySql += ` AND date(happened_at) <= date(?)`;
    binds.push(to);
  }
  let stmt = c.env.DB.prepare(activitySql);
  if (binds.length) stmt = stmt.bind(...binds);
  const activities = await stmt.first<{ n: number }>();

  const typeMap: Record<string, number> = { residential: 0, commercial: 0 };
  for (const row of byType.results ?? []) typeMap[row.type] = row.n;

  return c.json({
    open_opportunities: open?.n ?? 0,
    residential: typeMap.residential ?? 0,
    commercial: typeMap.commercial ?? 0,
    estimated_mrr_cents: mrr?.estimated ?? 0,
    quoted_mrr_cents: mrr?.quoted ?? 0,
    followups_overdue: overdue?.n ?? 0,
    followups_today: dueToday?.n ?? 0,
    activities: activities?.n ?? 0,
    from,
    to,
  });
});

/* ---------- accounts (org backbone) ---------- */

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

app.post("/api/accounts", async (c) => {
  const body = await c.req.json<{ name?: string; type?: string; notes?: string }>();
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
  const body = await c.req.json<{ name?: string; type?: string; notes?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const type = body.type === "commercial" ? "commercial" : "residential";
  const result = await c.env.DB.prepare(`UPDATE accounts SET name=?, type=?, notes=? WHERE id=?`)
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

app.get("/api/contacts", async (c) => {
  const q = (c.req.query("q") || "").trim().toLowerCase();
  let sql = `SELECT c.*, a.name AS account_name, a.type AS account_type,
       et.last_contact_at, et.subject AS last_subject
     FROM contacts c
     JOIN accounts a ON a.id = c.account_id
     LEFT JOIN email_touch et ON et.contact_email = lower(trim(c.email))`;
  const binds: string[] = [];
  if (q) {
    sql += ` WHERE lower(c.name) LIKE ? OR lower(COALESCE(c.email,'')) LIKE ? OR lower(a.name) LIKE ?`;
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  sql += ` ORDER BY c.name COLLATE NOCASE`;
  let stmt = c.env.DB.prepare(sql);
  if (binds.length) stmt = stmt.bind(...binds);
  const rows = await stmt.all();
  return c.json({ contacts: rows.results ?? [] });
});

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

/* ---------- opportunities ---------- */

app.get("/api/opportunities", async (c) => {
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const stage = c.req.query("stage") || "";
  const type = c.req.query("type") || "";
  const source = c.req.query("source") || "";

  let sql = `SELECT o.*, a.name AS account_name, a.type AS account_type, a.notes AS account_notes,
       (SELECT MAX(et.last_contact_at)
          FROM contacts ct
          LEFT JOIN email_touch et ON et.contact_email = lower(trim(ct.email))
         WHERE ct.account_id = a.id) AS last_contact_at
     FROM opportunities o
     JOIN accounts a ON a.id = o.account_id
     WHERE 1=1`;
  const binds: string[] = [];

  if (stage && STAGES.has(stage)) {
    sql += ` AND o.stage = ?`;
    binds.push(stage);
  }
  if (type === "residential" || type === "commercial") {
    sql += ` AND a.type = ?`;
    binds.push(type);
  }
  if (source) {
    sql += ` AND lower(COALESCE(o.lead_source,'')) = ?`;
    binds.push(source.toLowerCase());
  }
  if (q) {
    sql += ` AND (
      lower(a.name) LIKE ? OR lower(COALESCE(o.city,'')) LIKE ? OR lower(COALESCE(o.address,'')) LIKE ?
      OR lower(COALESCE(o.lead_source,'')) LIKE ? OR lower(COALESCE(o.next_action,'')) LIKE ?
    )`;
    const like = `%${q}%`;
    binds.push(like, like, like, like, like);
  }

  sql += ` ORDER BY o.stage, o.created_at DESC`;
  let stmt = c.env.DB.prepare(sql);
  if (binds.length) stmt = stmt.bind(...binds);
  const rows = await stmt.all();
  return c.json({ opportunities: rows.results ?? [] });
});

app.get("/api/opportunities/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const opportunity = await c.env.DB.prepare(
    `SELECT o.*, a.name AS account_name, a.type AS account_type, a.notes AS account_notes,
       (SELECT MAX(et.last_contact_at)
          FROM contacts ct
          LEFT JOIN email_touch et ON et.contact_email = lower(trim(ct.email))
         WHERE ct.account_id = a.id) AS last_contact_at
     FROM opportunities o
     JOIN accounts a ON a.id = o.account_id
     WHERE o.id = ?`,
  )
    .bind(id)
    .first();
  if (!opportunity) return c.json({ error: "not found" }, 404);

  const accountId = (opportunity as { account_id: number }).account_id;
  const contacts = await c.env.DB.prepare(
    `SELECT c.*, et.last_contact_at, et.subject AS last_subject, et.gmail_thread_id
     FROM contacts c
     LEFT JOIN email_touch et ON et.contact_email = lower(trim(c.email))
     WHERE c.account_id = ?
     ORDER BY c.is_primary DESC, c.name COLLATE NOCASE`,
  )
    .bind(accountId)
    .all();

  const activities = await c.env.DB.prepare(
    `SELECT * FROM activities WHERE opportunity_id = ? ORDER BY happened_at DESC, id DESC`,
  )
    .bind(id)
    .all();

  const customer = await c.env.DB.prepare(
    `SELECT * FROM customers WHERE opportunity_id = ?`,
  )
    .bind(id)
    .first();

  return c.json({
    opportunity,
    contacts: contacts.results ?? [],
    activities: activities.results ?? [],
    customer: customer ?? null,
  });
});

app.post("/api/opportunities", async (c) => {
  const body = await c.req.json<{
    account_id?: number;
    account_name?: string;
    account_type?: string;
    stage?: string;
    lead_source?: string;
    cleaning_type?: string;
    frequency?: string;
    estimated_mrr_cents?: number | null;
    quoted_mrr_cents?: number | null;
    estimated_mrr_dollars?: number | null;
    quoted_mrr_dollars?: number | null;
    expected_start?: string;
    next_follow_up_at?: string;
    next_action?: string;
    lost_reason?: string;
    address?: string;
    city?: string;
    property_type?: string;
    sq_ft?: number | null;
    notes?: string;
    contact_name?: string;
    contact_email?: string;
    contact_phone?: string;
  }>();

  let accountId = body.account_id ? Number(body.account_id) : 0;
  if (!accountId) {
    if (!body.account_name?.trim()) return c.json({ error: "account_name or account_id required" }, 400);
    const type = body.account_type === "commercial" ? "commercial" : "residential";
    const created = await c.env.DB.prepare(
      `INSERT INTO accounts (name, type, notes) VALUES (?, ?, ?) RETURNING id`,
    )
      .bind(body.account_name.trim(), type, null)
      .first<{ id: number }>();
    accountId = created!.id;

    if (body.contact_name?.trim()) {
      await c.env.DB.prepare(
        `INSERT INTO contacts (account_id, name, email, phone, is_primary) VALUES (?, ?, ?, ?, 1)`,
      )
        .bind(
          accountId,
          body.contact_name.trim(),
          body.contact_email?.trim() || null,
          body.contact_phone?.trim() || null,
        )
        .run();
    }
  }

  const stage =
    body.stage && STAGES.has(body.stage) ? (body.stage as OpportunityStage) : "new_lead";
  if (stage === "lost" && !body.lost_reason?.trim()) {
    return c.json({ error: "lost_reason required when stage is lost" }, 400);
  }

  const estimated =
    body.estimated_mrr_cents !== undefined
      ? parseCents(body.estimated_mrr_cents)
      : dollarsToCents(body.estimated_mrr_dollars);
  const quoted =
    body.quoted_mrr_cents !== undefined
      ? parseCents(body.quoted_mrr_cents)
      : dollarsToCents(body.quoted_mrr_dollars);

  const result = await c.env.DB.prepare(
    `INSERT INTO opportunities (
       account_id, stage, lead_source, cleaning_type, frequency,
       estimated_mrr_cents, quoted_mrr_cents, expected_start,
       next_follow_up_at, next_action, lost_reason,
       address, city, property_type, sq_ft, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      accountId,
      stage,
      body.lead_source ?? null,
      body.cleaning_type ?? null,
      body.frequency ?? null,
      estimated,
      quoted,
      body.expected_start ?? null,
      body.next_follow_up_at ?? null,
      body.next_action ?? null,
      stage === "lost" ? body.lost_reason!.trim() : body.lost_reason ?? null,
      body.address ?? null,
      body.city ?? null,
      body.property_type ?? null,
      body.sq_ft ?? null,
      body.notes ?? null,
    )
    .first<{ id: number }>();

  if (stage === "won") await ensureCustomer(c.env.DB, result!.id);
  return c.json({ id: result!.id, account_id: accountId }, 201);
});

app.put("/api/opportunities/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>();

  const existing = await c.env.DB.prepare(`SELECT * FROM opportunities WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!existing) return c.json({ error: "not found" }, 404);

  const stage =
    typeof body.stage === "string" && STAGES.has(body.stage)
      ? body.stage
      : (existing.stage as string);

  const lostReason =
    body.lost_reason !== undefined
      ? typeof body.lost_reason === "string"
        ? body.lost_reason.trim() || null
        : null
      : (existing.lost_reason as string | null);

  if (stage === "lost" && !lostReason) {
    return c.json({ error: "lost_reason required when stage is lost" }, 400);
  }

  const estimated =
    body.estimated_mrr_cents !== undefined
      ? parseCents(body.estimated_mrr_cents)
      : body.estimated_mrr_dollars !== undefined
        ? dollarsToCents(body.estimated_mrr_dollars)
        : (existing.estimated_mrr_cents as number | null);
  const quoted =
    body.quoted_mrr_cents !== undefined
      ? parseCents(body.quoted_mrr_cents)
      : body.quoted_mrr_dollars !== undefined
        ? dollarsToCents(body.quoted_mrr_dollars)
        : (existing.quoted_mrr_cents as number | null);

  await c.env.DB.prepare(
    `UPDATE opportunities SET
       stage=?, lead_source=?, cleaning_type=?, frequency=?,
       estimated_mrr_cents=?, quoted_mrr_cents=?, expected_start=?,
       next_follow_up_at=?, next_action=?, lost_reason=?,
       address=?, city=?, property_type=?, sq_ft=?, notes=?,
       updated_at=datetime('now')
     WHERE id=?`,
  )
    .bind(
      stage,
      body.lead_source !== undefined ? body.lead_source || null : existing.lead_source,
      body.cleaning_type !== undefined ? body.cleaning_type || null : existing.cleaning_type,
      body.frequency !== undefined ? body.frequency || null : existing.frequency,
      estimated,
      quoted,
      body.expected_start !== undefined ? body.expected_start || null : existing.expected_start,
      body.next_follow_up_at !== undefined
        ? body.next_follow_up_at || null
        : existing.next_follow_up_at,
      body.next_action !== undefined ? body.next_action || null : existing.next_action,
      stage === "lost" ? lostReason : stage === "won" ? null : lostReason,
      body.address !== undefined ? body.address || null : existing.address,
      body.city !== undefined ? body.city || null : existing.city,
      body.property_type !== undefined ? body.property_type || null : existing.property_type,
      body.sq_ft !== undefined
        ? body.sq_ft === null || body.sq_ft === ""
          ? null
          : Number(body.sq_ft)
        : existing.sq_ft,
      body.notes !== undefined ? body.notes || null : existing.notes,
      id,
    )
    .run();

  if (typeof body.account_name === "string" && body.account_name.trim()) {
    const type = body.account_type === "commercial" ? "commercial" : undefined;
    if (type) {
      await c.env.DB.prepare(`UPDATE accounts SET name=?, type=? WHERE id=?`)
        .bind(body.account_name.trim(), type, existing.account_id)
        .run();
    } else {
      await c.env.DB.prepare(`UPDATE accounts SET name=? WHERE id=?`)
        .bind(body.account_name.trim(), existing.account_id)
        .run();
    }
  } else if (body.account_type === "residential" || body.account_type === "commercial") {
    await c.env.DB.prepare(`UPDATE accounts SET type=? WHERE id=?`)
      .bind(body.account_type, existing.account_id)
      .run();
  }

  if (stage === "won") await ensureCustomer(c.env.DB, id);
  return c.json({ ok: true });
});

app.patch("/api/opportunities/:id/stage", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ stage?: string; lost_reason?: string }>();
  if (!body.stage || !STAGES.has(body.stage)) {
    return c.json({ error: "invalid stage" }, 400);
  }
  if (body.stage === "lost" && !body.lost_reason?.trim()) {
    return c.json({ error: "lost_reason required" }, 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE opportunities SET
       stage = ?,
       lost_reason = CASE WHEN ? = 'lost' THEN ? ELSE CASE WHEN ? = 'won' THEN NULL ELSE lost_reason END END,
       updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(
      body.stage,
      body.stage,
      body.lost_reason?.trim() || null,
      body.stage,
      id,
    )
    .run();
  if (!result.meta.changes) return c.json({ error: "not found" }, 404);
  if (body.stage === "won") await ensureCustomer(c.env.DB, id);
  return c.json({ ok: true });
});

app.delete("/api/opportunities/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare(`DELETE FROM opportunities WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

/* ---------- activities ---------- */

app.get("/api/activities", async (c) => {
  const opportunityId = c.req.query("opportunity_id");
  let sql = `SELECT a.*, o.account_id, acc.name AS account_name
     FROM activities a
     JOIN opportunities o ON o.id = a.opportunity_id
     JOIN accounts acc ON acc.id = o.account_id
     WHERE 1=1`;
  const binds: (string | number)[] = [];
  if (opportunityId) {
    sql += ` AND a.opportunity_id = ?`;
    binds.push(Number(opportunityId));
  }
  sql += ` ORDER BY a.happened_at DESC, a.id DESC LIMIT 200`;
  let stmt = c.env.DB.prepare(sql);
  if (binds.length) stmt = stmt.bind(...binds);
  const rows = await stmt.all();
  return c.json({ activities: rows.results ?? [] });
});

app.post("/api/activities", async (c) => {
  const body = await c.req.json<{
    opportunity_id?: number;
    happened_at?: string;
    type?: string;
    person?: string;
    summary?: string;
    outcome?: string;
    next_action?: string;
    next_follow_up_at?: string;
    update_opportunity?: boolean;
  }>();
  if (!body.opportunity_id) return c.json({ error: "opportunity_id required" }, 400);
  if (!body.summary?.trim()) return c.json({ error: "summary required" }, 400);

  const result = await c.env.DB.prepare(
    `INSERT INTO activities (
       opportunity_id, happened_at, type, person, summary, outcome, next_action, next_follow_up_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      body.opportunity_id,
      body.happened_at || new Date().toISOString(),
      body.type?.trim() || "note",
      body.person?.trim() || null,
      body.summary.trim(),
      body.outcome?.trim() || null,
      body.next_action?.trim() || null,
      body.next_follow_up_at || null,
    )
    .first<{ id: number }>();

  // Default: push next action/date onto the opportunity when provided.
  if (body.update_opportunity !== false && (body.next_action || body.next_follow_up_at)) {
    await c.env.DB.prepare(
      `UPDATE opportunities SET
         next_action = COALESCE(?, next_action),
         next_follow_up_at = COALESCE(?, next_follow_up_at),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(body.next_action?.trim() || null, body.next_follow_up_at || null, body.opportunity_id)
      .run();
  }

  return c.json({ id: result!.id }, 201);
});

app.delete("/api/activities/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare(`DELETE FROM activities WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

/* ---------- follow-ups ---------- */

app.get("/api/follow-ups", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT o.*, a.name AS account_name, a.type AS account_type
     FROM opportunities o
     JOIN accounts a ON a.id = o.account_id
     WHERE o.stage NOT IN ('won', 'lost')
     ORDER BY
       CASE WHEN o.next_follow_up_at IS NULL THEN 1 ELSE 0 END,
       o.next_follow_up_at ASC,
       a.name COLLATE NOCASE`,
  ).all();
  return c.json({ opportunities: rows.results ?? [] });
});

/* ---------- customers ---------- */

app.get("/api/customers", async (c) => {
  const q = (c.req.query("q") || "").trim().toLowerCase();
  let sql = `SELECT * FROM customers WHERE 1=1`;
  const binds: string[] = [];
  if (q) {
    sql += ` AND (lower(name) LIKE ? OR lower(COALESCE(city,'')) LIKE ? OR lower(COALESCE(service_address,'')) LIKE ?)`;
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  sql += ` ORDER BY created_at DESC`;
  let stmt = c.env.DB.prepare(sql);
  if (binds.length) stmt = stmt.bind(...binds);
  const rows = await stmt.all();
  return c.json({ customers: rows.results ?? [] });
});

/* ---------- settings ---------- */

app.put("/api/settings/password", async (c) => {
  const body = await c.req.json<{ password?: string; current_password?: string }>();
  const next = typeof body.password === "string" ? body.password.trim() : "";
  if (next.length < 4) return c.json({ error: "password must be at least 4 characters" }, 400);

  // If CRM_PASSWORD secret is set, D1 fallback won't be used for auth — refuse confusing updates.
  if (c.env.CRM_PASSWORD) {
    return c.json(
      { error: "Password is managed by CRM_PASSWORD secret; update it in Cloudflare, not here." },
      400,
    );
  }

  const current = await getSetting(c.env.DB, "crm_password");
  if (current && body.current_password !== current) {
    return c.json({ error: "current password incorrect" }, 401);
  }

  await setSetting(c.env.DB, "crm_password", next);
  const token = await sessionToken(next);
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, "cerva_session", token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
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
