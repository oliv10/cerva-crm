import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./types";

const COOKIE = "cerva_session";

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sessionToken(password: string): Promise<string> {
  return sha256Hex(`cerva:${password}`);
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.length !== bb.length) return false;
  // Web Crypto doesn't expose constant-time compare for arbitrary bytes; length-matched XOR is fine for cookies.
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}

async function resolvePassword(c: Context<{ Bindings: Env }>): Promise<string | null> {
  if (c.env.CRM_PASSWORD) return c.env.CRM_PASSWORD;
  const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
    .bind("crm_password")
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function isAuthed(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const password = await resolvePassword(c);
  if (!password) return false;
  const cookie = getCookie(c, COOKIE);
  if (!cookie) return false;
  const expected = await sessionToken(password);
  return timingSafeEqual(cookie, expected);
}

export async function login(c: Context<{ Bindings: Env }>, password: string): Promise<boolean> {
  const expected = await resolvePassword(c);
  if (!expected) return false;
  const ok = await timingSafeEqual(password, expected);
  if (!ok) return false;
  const token = await sessionToken(password);
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return true;
}

export function logout(c: Context<{ Bindings: Env }>) {
  deleteCookie(c, COOKIE, { path: "/" });
}
