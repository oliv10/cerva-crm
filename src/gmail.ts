import type { Env } from "./types";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}

export function oauthAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<{ refresh_token?: string; access_token: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token exchange failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`refresh failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

type GmailMessageList = { messages?: { id: string; threadId: string }[] };
type GmailMessage = {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
  snippet?: string;
};

async function newestForEmail(
  accessToken: string,
  email: string,
): Promise<{ last_contact_at: string; gmail_thread_id: string; subject: string } | null> {
  const q = `from:${email} OR to:${email}`;
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", q);
  listUrl.searchParams.set("maxResults", "1");

  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    console.error("gmail list failed", email, listRes.status, await listRes.text());
    return null;
  }
  const list = (await listRes.json()) as GmailMessageList;
  const first = list.messages?.[0];
  if (!first) return null;

  const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${first.id}`);
  msgUrl.searchParams.set("format", "metadata");
  msgUrl.searchParams.set("metadataHeaders", "Subject");

  const msgRes = await fetch(msgUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!msgRes.ok) {
    console.error("gmail message failed", first.id, msgRes.status);
    return null;
  }
  const msg = (await msgRes.json()) as GmailMessage;
  const subject =
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")?.value ??
    msg.snippet ??
    "";
  const ms = Number(msg.internalDate ?? Date.now());
  return {
    last_contact_at: new Date(ms).toISOString(),
    gmail_thread_id: msg.threadId,
    subject: subject.slice(0, 200),
  };
}

/** Sync last-contact for every CRM contact email. ponytail: sequential per-email; batch if contact count grows. */
export async function syncGmailTouches(env: Env): Promise<{ synced: number; skipped: number }> {
  const refreshToken = await getSetting(env.DB, "gmail_refresh_token");
  if (!refreshToken) return { synced: 0, skipped: 0 };
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID/SECRET not configured");
  }

  const accessToken = await refreshAccessToken(env, refreshToken);
  const contacts = await env.DB.prepare(
    `SELECT id, account_id, email FROM contacts WHERE email IS NOT NULL AND trim(email) != ''`,
  ).all<{ id: number; account_id: number; email: string }>();

  let synced = 0;
  let skipped = 0;

  for (const contact of contacts.results ?? []) {
    const email = normalizeEmail(contact.email);
    const hit = await newestForEmail(accessToken, email);
    if (!hit) {
      skipped++;
      continue;
    }
    await env.DB.prepare(
      `INSERT INTO email_touch (contact_email, account_id, last_contact_at, gmail_thread_id, subject)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(contact_email) DO UPDATE SET
         account_id = excluded.account_id,
         last_contact_at = excluded.last_contact_at,
         gmail_thread_id = excluded.gmail_thread_id,
         subject = excluded.subject`,
    )
      .bind(email, contact.account_id, hit.last_contact_at, hit.gmail_thread_id, hit.subject)
      .run();
    synced++;
  }

  await setSetting(env.DB, "gmail_last_sync_at", new Date().toISOString());
  return { synced, skipped };
}

export async function gmailStatus(db: D1Database): Promise<{
  connected: boolean;
  last_sync_at: string | null;
}> {
  const token = await getSetting(db, "gmail_refresh_token");
  const last = await getSetting(db, "gmail_last_sync_at");
  return { connected: Boolean(token), last_sync_at: last };
}
