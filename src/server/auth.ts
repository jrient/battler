import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import {
  getUserById,
  getUserByGithubId,
  createUser,
  updateUserProfile,
  type UserRecord,
} from "./store.js";

const SESSION_COOKIE = "ac_session";
const STATE_COOKIE = "ac_oauth_state";
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days
const STATE_MAX_AGE_SEC = 60 * 10;             // 10 minutes

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string): string {
  const secret = getEnv("AC_SESSION_SECRET");
  const mac = createHmac("sha256", secret).update(payload).digest();
  return b64url(mac);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ===== Cookie helpers =====

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCookie(
  c: Context,
  name: string,
  value: string,
  opts: { maxAgeSec?: number; httpOnly?: boolean; sameSite?: "Lax" | "Strict" | "None"; path?: string; secure?: boolean } = {},
): void {
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${opts.maxAgeSec}`);
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure ?? isProduction()) parts.push("Secure");
  c.header("Set-Cookie", parts.join("; "), { append: true });
}

function clearCookie(c: Context, name: string): void {
  setCookie(c, name, "", { maxAgeSec: 0 });
}

// ===== Session token =====

interface SessionPayload {
  uid: string;
  iat: number; // unix seconds
}

function encodeSession(payload: SessionPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = sign(body);
  return `${body}.${sig}`;
}

function decodeSession(token: string): SessionPayload | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, sign(body))) return null;
  try {
    const parsed = JSON.parse(fromB64url(body).toString()) as SessionPayload;
    if (typeof parsed.uid !== "string" || typeof parsed.iat !== "number") return null;
    const ageSec = Math.floor(Date.now() / 1000) - parsed.iat;
    if (ageSec > SESSION_MAX_AGE_SEC) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setSession(c: Context, userId: string): void {
  const token = encodeSession({ uid: userId, iat: Math.floor(Date.now() / 1000) });
  setCookie(c, SESSION_COOKIE, token, { maxAgeSec: SESSION_MAX_AGE_SEC, httpOnly: true });
}

export function clearSession(c: Context): void {
  clearCookie(c, SESSION_COOKIE);
}

export function getSessionUser(c: Context): UserRecord | null {
  const cookies = parseCookies(c.req.header("cookie"));
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const payload = decodeSession(raw);
  if (!payload) return null;
  return getUserById(payload.uid);
}

export const requireSession: MiddlewareHandler<{ Variables: { user: UserRecord } }> = async (c, next) => {
  const user = getSessionUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "sign in via /auth/github" }, 401);
  c.set("user", user);
  await next();
};

// ===== GitHub OAuth flow =====

function callbackUrl(): string {
  const base = getEnv("AC_BASE_URL").replace(/\/+$/, "");
  return `${base}/auth/github/callback`;
}

export function startGithubOAuth(c: Context): Response {
  const state = b64url(randomBytes(24));
  const signed = `${state}.${sign(state)}`;
  setCookie(c, STATE_COOKIE, signed, { maxAgeSec: STATE_MAX_AGE_SEC, httpOnly: true });

  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set("client_id", getEnv("AC_GITHUB_CLIENT_ID"));
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("allow_signup", "true");
  return c.redirect(url.toString(), 302);
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export async function handleGithubCallback(c: Context): Promise<Response> {
  const code = c.req.query("code");
  const stateParam = c.req.query("state");
  const error = c.req.query("error");
  if (error) {
    return c.text(`GitHub OAuth error: ${error}`, 400);
  }
  if (!code || !stateParam) return c.text("missing code/state", 400);

  // Verify state cookie
  const cookies = parseCookies(c.req.header("cookie"));
  const signedState = cookies[STATE_COOKIE];
  if (!signedState) return c.text("missing state cookie", 400);
  const dot = signedState.indexOf(".");
  if (dot < 0) return c.text("malformed state", 400);
  const stateVal = signedState.slice(0, dot);
  const stateSig = signedState.slice(dot + 1);
  if (!safeEqual(stateSig, sign(stateVal))) return c.text("invalid state signature", 400);
  if (!safeEqual(stateVal, stateParam)) return c.text("state mismatch", 400);
  clearCookie(c, STATE_COOKIE);

  // Exchange code for access token
  const tokenRes = await fetch(GITHUB_TOKEN, {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: getEnv("AC_GITHUB_CLIENT_ID"),
      client_secret: getEnv("AC_GITHUB_CLIENT_SECRET"),
      code,
      redirect_uri: callbackUrl(),
    }),
  });
  if (!tokenRes.ok) return c.text(`token exchange failed (${tokenRes.status})`, 502);
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) return c.text(`token exchange: ${tokenJson.error || "no token"}`, 502);

  // Fetch GitHub user
  const userRes = await fetch(GITHUB_USER, {
    headers: {
      "authorization": `Bearer ${tokenJson.access_token}`,
      "accept": "application/vnd.github+json",
      "user-agent": "AgentClash",
    },
  });
  if (!userRes.ok) return c.text(`github user fetch failed (${userRes.status})`, 502);
  const gh = (await userRes.json()) as GithubUser;

  // Create or update local User
  let user = getUserByGithubId(gh.id);
  const displayName = gh.name || gh.login;
  if (!user) {
    user = createUser({
      githubId: gh.id,
      githubLogin: gh.login,
      avatarUrl: gh.avatar_url,
      displayName,
    });
  } else {
    user = updateUserProfile(user.id, {
      githubLogin: gh.login,
      avatarUrl: gh.avatar_url,
      displayName,
    }) ?? user;
  }

  setSession(c, user.id);

  // Redirect to /me in the language the browser came in on
  const lang = decideLang(c);
  return c.redirect(`/${lang}/me`, 302);
}

export function handleLogout(c: Context): Response {
  clearSession(c);
  const lang = decideLang(c);
  return c.redirect(`/${lang}`, 302);
}

function decideLang(c: Context): "zh" | "en" {
  const cookies = parseCookies(c.req.header("cookie"));
  const v = cookies.lang;
  if (v === "zh" || v === "en") return v;
  const accept = (c.req.header("accept-language") ?? "").toLowerCase();
  return accept.startsWith("en") ? "en" : "zh";
}
