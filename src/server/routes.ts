import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { z } from "zod";
import { runMatch } from "../engine/battle.js";
import { CompileError, loadAgent, wrapAgentAsDecideFn } from "../sandbox/runner.js";
import { toAgentJson } from "../engine/replay.js";
import { BOTS, listBots, loadBotCode } from "../bots/registry.js";
import { computeNewRank, botScore, type Outcome } from "../engine/elo.js";
import {
  getCommanderByKey,
  getCommanderById,
  getCommanderByBootstrapToken,
  createCommander,
  getMatch,
  getMatchesByCommander,
  getMatchesByOwner,
  listMatches,
  listCommanders,
  getSimulationLastAt,
  saveMatch,
  setSimulationLastAt,
  updateCommanderCode,
  applyRankUpdate,
  validateDisplayName,
  listCommandersByOwner,
  createCommanderForOwner,
  deleteCommander,
  regenerateCommanderBootstrapToken,
  resetCommanderKey,
  type CommanderRecord,
  type UserRecord,
} from "./store.js";
import {
  getSessionUser,
  requireSession,
  startGithubOAuth,
  handleGithubCallback,
  handleLogout,
} from "./auth.js";

const SIMULATE_COOLDOWN_MS = 2000;
const CHALLENGE_COOLDOWN_MS = 60_000;

// Per-user cooldown for ranked challenges (one challenge per minute across all commanders).
const challengeLastAt = new Map<string, number>();

// In-memory rate limiter for /agent-init/* (60 req/hour per IP)
const agentInitRateMap = new Map<string, { count: number; resetAt: number }>();
const AGENT_INIT_RATE_LIMIT = 60;
const AGENT_INIT_RATE_WINDOW_MS = 60 * 60 * 1000;

function checkAgentInitRate(ip: string): boolean {
  const now = Date.now();
  const entry = agentInitRateMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    agentInitRateMap.set(ip, { count: 1, resetAt: now + AGENT_INIT_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= AGENT_INIT_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Periodically clean up stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of agentInitRateMap) {
    if (now >= entry.resetAt) agentInitRateMap.delete(ip);
  }
}, 10 * 60 * 1000).unref();

type Vars = { commander: CommanderRecord; user: UserRecord };

export const app = new Hono<{ Variables: Vars }>();

const bearerAuth: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: "unauthorized", message: "Bearer token required" }, 401);
  const cmd = getCommanderByKey(m[1]!.trim());
  if (!cmd) return c.json({ error: "unauthorized", message: "invalid commander key" }, 401);
  c.set("commander", cmd);
  await next();
};

app.get("/health", (c) => c.json({ ok: true }));

// ===== Auth =====
app.get("/auth/github", (c) => startGithubOAuth(c));
app.get("/auth/github/callback", (c) => handleGithubCallback(c));
app.post("/auth/logout", (c) => handleLogout(c));
app.get("/auth/logout", (c) => handleLogout(c));

app.get("/api/me/whoami", (c) => {
  const user = getSessionUser(c);
  if (!user) return c.json({ signedIn: false });
  return c.json({
    signedIn: true,
    user: {
      id: user.id,
      githubLogin: user.githubLogin,
      avatarUrl: user.avatarUrl,
      displayName: user.displayName,
    },
  });
});

// ===== /api/me/* session-protected routes =====

app.use("/api/me/*", requireSession);

app.get("/api/me", (c) => {
  const user = c.get("user");
  const commanders = listCommandersByOwner(user.id);
  const baseUrl = process.env.AC_BASE_URL ?? "http://localhost:8787";
  return c.json({
    user: {
      id: user.id,
      githubLogin: user.githubLogin,
      avatarUrl: user.avatarUrl,
      displayName: user.displayName,
    },
    commanders: commanders.map((cmd) => ({
      commanderId: cmd.id,
      displayName: cmd.displayName,
      codeVersion: cmd.codeVersion,
      codeUpdatedAt: cmd.codeUpdatedAt,
      rank: cmd.rank,
      bootstrapUrl: `${baseUrl}/agent-init/${cmd.bootstrapToken}`,
    })),
  });
});

const createCommanderSchema = z.object({
  displayName: z.string().min(3).max(32),
});

app.post("/api/me/commanders", async (c) => {
  const user = c.get("user");
  const body = await safeJson(c);
  const parsed = createCommanderSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "bad_request", message: parsed.error.message }, 400);
  }
  const validation = validateDisplayName(parsed.data.displayName);
  if (!validation.ok) {
    const resp: Record<string, unknown> = { error: "bad_request", reason: validation.reason };
    if (validation.suggestions) resp.suggestions = validation.suggestions;
    return c.json(resp, 409);
  }
  const cmd = createCommanderForOwner({ ownerId: user.id, displayName: validation.normalized });
  const baseUrl = process.env.AC_BASE_URL ?? "http://localhost:8787";
  return c.json({
    commanderId: cmd.id,
    displayName: cmd.displayName,
    commanderKey: cmd.commanderKey,
    bootstrapToken: cmd.bootstrapToken,
    bootstrapUrl: `${baseUrl}/agent-init/${cmd.bootstrapToken}`,
    createdAt: cmd.createdAt,
  }, 201);
});

app.get("/api/me/commanders/:id", (c) => {
  const user = c.get("user");
  const cmd = getCommanderById(c.req.param("id"));
  if (!cmd || cmd.ownerId !== user.id) {
    return c.json({ error: "not_found" }, 404);
  }
  const baseUrl = process.env.AC_BASE_URL ?? "http://localhost:8787";
  return c.json({
    commanderId: cmd.id,
    displayName: cmd.displayName,
    commanderKey: cmd.commanderKey,
    bootstrapToken: cmd.bootstrapToken,
    bootstrapUrl: `${baseUrl}/agent-init/${cmd.bootstrapToken}`,
    codeVersion: cmd.codeVersion,
    codeHash: cmd.codeHash,
    codeUpdatedAt: cmd.codeUpdatedAt,
    submittedBy: cmd.submittedBy,
    changelog: cmd.changelog,
    createdAt: cmd.createdAt,
    rank: cmd.rank,
    recentMatchIds: cmd.recentMatchIds,
  });
});

app.delete("/api/me/commanders/:id", (c) => {
  const user = c.get("user");
  const cmd = getCommanderById(c.req.param("id"));
  if (!cmd || cmd.ownerId !== user.id) {
    return c.json({ error: "not_found" }, 404);
  }
  deleteCommander(cmd.id);
  return c.json({ ok: true });
});

app.post("/api/me/commanders/:id/regenerate-bootstrap", (c) => {
  const user = c.get("user");
  const cmd = getCommanderById(c.req.param("id"));
  if (!cmd || cmd.ownerId !== user.id) {
    return c.json({ error: "not_found" }, 404);
  }
  const updated = regenerateCommanderBootstrapToken(cmd.id);
  if (!updated) return c.json({ error: "not_found" }, 404);
  const baseUrl = process.env.AC_BASE_URL ?? "http://localhost:8787";
  return c.json({
    bootstrapToken: updated.bootstrapToken,
    bootstrapUrl: `${baseUrl}/agent-init/${updated.bootstrapToken}`,
    warning: "The old bootstrap URL is now invalid. Share the new URL with your agent.",
  });
});

app.get("/api/me/matches", (c) => {
  const user = c.get("user");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const matches = getMatchesByOwner(user.id, limit, offset);
  return c.json({
    limit,
    offset,
    matches: matches.map((m) => ({
      matchId: m.matchId,
      createdAt: m.createdAt,
      type: m.type,
      participantA: { commanderId: m.participantA.commanderId, submittedBy: m.participantA.submittedBy, displayName: resolveDisplayName(m.participantA.commanderId, m.participantA.submittedBy) },
      participantB: { commanderId: m.participantB.commanderId, submittedBy: m.participantB.submittedBy, displayName: resolveDisplayName(m.participantB.commanderId, m.participantB.submittedBy) },
      resultA: m.resultA,
      summary: { totalTurns: m.totalTurns, myUnitsRemaining: m.aUnitsRemaining, enemyUnitsRemaining: m.bUnitsRemaining },
    })),
  });
});

app.post("/api/me/commanders/:id/reset-key", (c) => {
  const user = c.get("user");
  const cmd = getCommanderById(c.req.param("id"));
  if (!cmd || cmd.ownerId !== user.id) {
    return c.json({ error: "not_found" }, 404);
  }
  const updated = resetCommanderKey(cmd.id);
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json({
    commanderKey: updated.commanderKey,
    warning: "The old commanderKey is now invalid. Update all your agents with the new key.",
  });
});

// Web-session variant of /api/commander/challenge. Lets the arena page fight
// as one of the user's commanders without exposing the commander key to JS.
app.post("/api/me/commanders/:id/challenge", async (c) => {
  const user = c.get("user");
  const cmd = getCommanderById(c.req.param("id"));
  if (!cmd || cmd.ownerId !== user.id) {
    return c.json({ error: "not_found" }, 404);
  }
  return runChallenge(c, cmd, await safeJson(c));
});

// ===== Web pages: language-prefixed routing =====
const __pagesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "pages");
const PAGE_FILES: Record<string, string> = {
  home: "home.html",
  replay: "replay.html",
  me: "me.html",
  matches: "matches.html",
  arena: "arena.html",
  leaderboard: "leaderboard.html",
  stub: "stub.html",
};

const STUB_SECTIONS = ["army", "about"] as const;

function pickLang(c: Context): "zh" | "en" {
  const cookieHeader = c.req.header("cookie") ?? "";
  const m = cookieHeader.match(/(?:^|;\s*)lang=(zh|en)\b/);
  if (m) return m[1] as "zh" | "en";
  const accept = (c.req.header("accept-language") ?? "").toLowerCase();
  return accept.startsWith("en") ? "en" : "zh";
}

function servePage(c: Context, key: keyof typeof PAGE_FILES) {
  const file = PAGE_FILES[key];
  if (!file) return c.notFound();
  try {
    const html = readFileSync(resolve(__pagesDir, file), "utf8");
    return c.html(html);
  } catch {
    return c.text("page not found", 404);
  }
}

app.get("/", (c) => c.redirect(`/${pickLang(c)}`, 302));
app.get("/zh", (c) => servePage(c, "home"));
app.get("/en", (c) => servePage(c, "home"));
app.get("/zh/replay/:id", (c) => servePage(c, "replay"));
app.get("/en/replay/:id", (c) => servePage(c, "replay"));
app.get("/zh/me", (c) => servePage(c, "me"));
app.get("/en/me", (c) => servePage(c, "me"));
app.get("/zh/matches", (c) => servePage(c, "matches"));
app.get("/en/matches", (c) => servePage(c, "matches"));
app.get("/zh/arena", (c) => servePage(c, "arena"));
app.get("/en/arena", (c) => servePage(c, "arena"));
app.get("/zh/leaderboard", (c) => servePage(c, "leaderboard"));
app.get("/en/leaderboard", (c) => servePage(c, "leaderboard"));
for (const section of STUB_SECTIONS) {
  app.get(`/zh/${section}`, (c) => servePage(c, "stub"));
  app.get(`/en/${section}`, (c) => servePage(c, "stub"));
}

const registerSchema = z.object({
  displayName: z.string().min(1).max(64).optional().default("Commander"),
});

app.post("/api/register", async (c) => {
  const body = await safeJson(c);
  const parsed = registerSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "bad_request", message: parsed.error.message }, 400);
  }
  const id = "cmd_" + nanoid(8);
  const key = "ack_" + nanoid(24);
  const rec = createCommander({ id, commanderKey: key, displayName: parsed.data.displayName });
  return c.json({
    commanderId: rec.id,
    displayName: rec.displayName,
    commanderKey: rec.commanderKey,
    agentGuideUrl: "/api/agent-guide",
    demoCode: DEMO_CODE,
    message: "Save your commanderKey securely. You will need it as Bearer token for all authenticated API calls. Use demoCode to get started — POST it to /api/commander/code.",
  }, 201);
});

const DEMO_CODE = `// AgentClash demo strategy — prioritizes high-threat targets with skill usage
const RANGE = { knight: 1, spear: 2, archer: 4, mage: 3, priest: 2 };
const MOVE = { knight: 3, spear: 2, archer: 2, mage: 1, priest: 2 };
const THREAT = { mage: 10, priest: 8, archer: 7, spear: 4, knight: 2 };
const RECRUIT_AP = { mage: 5, archer: 4, priest: 4, knight: 5, spear: 3 };

export function decideTurn(ctx) {
  const actions = [];
  let ap = ctx.myAP;
  if (!ctx.enemyUnits.length) return actions;

  const targets = [...ctx.enemyUnits].sort((a, b) => THREAT[b.type] - THREAT[a.type]);

  for (const u of ctx.myUnits) {
    if (ap < 1) break;

    if (u.type === "mage" && ap >= 3 && (u.cooldowns.fireball || 0) === 0) {
      let bestPos = null, bestN = 0;
      for (const e of ctx.enemyUnits) {
        const n = ctx.enemyUnits.filter(o =>
          Math.max(Math.abs(o.pos[0]-e.pos[0]), Math.abs(o.pos[1]-e.pos[1])) <= 1
        ).length;
        if (n > bestN) { bestN = n; bestPos = e.pos; }
      }
      if (bestN >= 2 && bestPos && mhd(u.pos, bestPos) <= RANGE.mage) {
        actions.push({ unitId: u.id, action: "skill", skill: "fireball", target: bestPos });
        ap -= 3; continue;
      }
    }

    if (u.type === "priest" && ap >= 2 && (u.cooldowns.heal || 0) === 0) {
      const w = ctx.myUnits.filter(a => a.id !== u.id && a.hp < a.maxHp * 0.6)
        .sort((a, b) => a.hp - b.hp);
      const t = w.find(a => mhd(u.pos, a.pos) <= RANGE.priest);
      if (t) {
        actions.push({ unitId: u.id, action: "skill", skill: "heal", target: t.id });
        ap -= 2; continue;
      }
    }

    const range = RANGE[u.type];
    const hit = targets.find(e => mhd(u.pos, e.pos) <= range);
    if (hit) {
      actions.push({ unitId: u.id, action: "attack", targetUnitId: hit.id });
      ap -= 1; continue;
    }
    const goal = targets[0];
    if (goal) {
      const dest = step(u.pos, goal.pos, MOVE[u.type]);
      actions.push({ unitId: u.id, action: "move", target: dest });
      ap -= 1;
    }
  }

  const rp = ctx.myRecruitAP || 0;
  let rpLeft = rp;
  for (const t of ["mage","archer","knight","spear","priest"]) {
    while (rpLeft >= RECRUIT_AP[t]) { actions.push({ action: "recruit", unitType: t }); rpLeft -= RECRUIT_AP[t]; }
  }
  return actions;
}

function mhd(a, b) { return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]); }
function step(from, to, max) {
  let left = max;
  const dxM = Math.min(Math.abs(to[0]-from[0]), left);
  const dx = Math.sign(to[0]-from[0]) * dxM; left -= dxM;
  const dyM = Math.min(Math.abs(to[1]-from[1]), left);
  const dy = Math.sign(to[1]-from[1]) * dyM;
  return [from[0]+dx, from[1]+dy];
}`;

app.get("/api/agent-guide", (c) => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const mdPath = resolve(__dirname, "..", "..", "AGENT_GUIDE.md");
  try {
    const md = readFileSync(mdPath, "utf8");
    return c.text(md, 200, { "content-type": "text/markdown; charset=utf-8" });
  } catch {
    return c.text("not found", 404);
  }
});

app.get("/api/opponents", (c) =>
  c.json(
    listBots().map((b) => ({
      id: b.id,
      displayName: b.displayName,
      style: b.style,
      publicCodeUrl: `/bots/${b.id}/code.js`,
    })),
  ),
);

app.get("/bots/:id/code.js", (c) => {
  const id = c.req.param("id");
  if (!BOTS[id]) return c.text("not found", 404);
  return c.text(loadBotCode(id), 200, { "content-type": "application/javascript" });
});

// Public list of commanders with published code. Powers the arena
// opponent picker and (later) the leaderboard.
app.get("/api/commanders", (c) => {
  const items = listCommanders()
    .filter((cmd) => cmd.code && cmd.codeVersion > 0)
    .sort((a, b) => b.rank.score - a.rank.score)
    .map((cmd) => ({
      commanderId: cmd.id,
      displayName: cmd.displayName,
      submittedBy: cmd.submittedBy,
      codeVersion: cmd.codeVersion,
      rank: {
        score: cmd.rank.score,
        tier: cmd.rank.tier,
        division: cmd.rank.division,
        placementMatches: cmd.rank.placementMatches,
        wins: cmd.rank.effectiveWins,
        losses: cmd.rank.effectiveLosses,
      },
    }));
  return c.json({ commanders: items });
});

app.get("/api/commanders/:id/matches", (c) => {
  const id = c.req.param("id");
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const matches = getMatchesByCommander(id, limit, offset);
  return c.json(matches.map((m) => {
    const isA = m.participantA.commanderId === id;
    const myResult = isA ? m.resultA : (m.resultA === "win" ? "loss" : m.resultA === "loss" ? "win" : "draw");
    return {
      matchId: m.matchId,
      createdAt: m.createdAt,
      type: m.type,
      opponent: isA ? m.participantB.submittedBy : m.participantA.submittedBy,
      result: myResult,
      summary: {
        totalTurns: m.totalTurns,
        myUnitsRemaining: isA ? m.aUnitsRemaining : m.bUnitsRemaining,
        enemyUnitsRemaining: isA ? m.bUnitsRemaining : m.aUnitsRemaining,
      },
    };
  }));
});

app.get("/api/matches", (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const { matches, total } = listMatches(limit, offset);
  return c.json({
    total,
    limit,
    offset,
    matches: matches.map((m) => ({
      matchId: m.matchId,
      createdAt: m.createdAt,
      type: m.type,
      participantA: { commanderId: m.participantA.commanderId, submittedBy: m.participantA.submittedBy, displayName: resolveDisplayName(m.participantA.commanderId, m.participantA.submittedBy) },
      participantB: { commanderId: m.participantB.commanderId, submittedBy: m.participantB.submittedBy, displayName: resolveDisplayName(m.participantB.commanderId, m.participantB.submittedBy) },
      resultA: m.resultA,
      summary: { totalTurns: m.totalTurns, myUnitsRemaining: m.aUnitsRemaining, enemyUnitsRemaining: m.bUnitsRemaining },
    })),
  });
});

// Public replay endpoint — must be before auth middleware
app.get("/api/matches/:id/replay", (c) => {
  const id = c.req.param("id");
  const m = getMatch(id);
  if (!m) return c.json({ error: "not_found" }, 404);
  return c.json({
    matchId: m.matchId,
    createdAt: m.createdAt,
    participantA: { commanderId: m.participantA.commanderId, submittedBy: m.participantA.submittedBy, version: m.participantA.version, displayName: resolveDisplayName(m.participantA.commanderId, m.participantA.submittedBy) },
    participantB: { commanderId: m.participantB.commanderId, submittedBy: m.participantB.submittedBy, version: m.participantB.version, displayName: resolveDisplayName(m.participantB.commanderId, m.participantB.submittedBy) },
    turnSnapshots: m.agentJsonForA.turnSnapshots ?? [],
    events: m.agentJsonForA.events,
    summary: m.agentJsonForA.summary,
  });
});

app.use("/api/commander/*", bearerAuth);
app.use("/api/matches/*", bearerAuth);

app.get("/api/commander", (c) => {
  const cmd = c.get("commander");
  return c.json(publicCommanderView(cmd));
});

const codeSchema = z.object({
  code: z.string().min(10).max(100_000),
  submittedBy: z.string().min(1).max(64),
  changelog: z.string().max(500).optional().default(""),
});

app.post("/api/commander/code", async (c) => {
  const cmd = c.get("commander");
  const body = await safeJson(c);
  const parsed = codeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "bad_request", message: parsed.error.message }, 400);
  }
  const { code, submittedBy, changelog } = parsed.data;

  try {
    loadAgent(code);
  } catch (err) {
    if (err instanceof CompileError) {
      return c.json(
        { error: "syntax_error", message: err.message, version: cmd.codeVersion },
        400,
      );
    }
    throw err;
  }

  const codeHash = "sha256:" + createHash("sha256").update(code).digest("hex");
  const updated = updateCommanderCode(cmd.id, { code, codeHash, submittedBy, changelog });
  return c.json({ version: updated.codeVersion, codeHash: updated.codeHash, syntaxOk: true });
});

const simSchema = z.object({
  opponent: z.string().optional(),
  seed: z.number().int().optional(),
  rounds: z.number().int().min(1).max(5).optional().default(1),
});

app.post("/api/commander/simulate", async (c) => {
  const cmd = c.get("commander");
  if (!cmd.code) {
    return c.json({ error: "no_code", message: "publish code first via POST /api/commander/code" }, 400);
  }

  const last = getSimulationLastAt(cmd.id);
  const now = new Date();
  if (last && now.getTime() - last.getTime() < SIMULATE_COOLDOWN_MS) {
    const next = new Date(last.getTime() + SIMULATE_COOLDOWN_MS);
    return c.json({ error: "rate_limited", nextSimulationAt: next.toISOString() }, 429);
  }

  const body = await safeJson(c);
  const parsed = simSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "bad_request", message: parsed.error.message }, 400);
  }
  const opponentId = parsed.data.opponent ?? "red-charger";
  if (!BOTS[opponentId]) {
    return c.json({ error: "bad_request", message: `unknown opponent: ${opponentId}` }, 400);
  }
  const seed = parsed.data.seed ?? Math.floor(Math.random() * 1_000_000);

  let agentA, agentB;
  try {
    agentA = loadAgent(cmd.code);
  } catch (err) {
    return c.json(
      { error: "compile_error", message: (err as Error).message, side: "me" },
      400,
    );
  }
  try {
    agentB = loadAgent(loadBotCode(opponentId));
  } catch (err) {
    return c.json(
      { error: "internal_bot_broken", message: (err as Error).message },
      500,
    );
  }

  const matchId = "sim_" + nanoid(10);
  const match = runMatch({
    decideA: wrapAgentAsDecideFn(agentA, seed, "A"),
    decideB: wrapAgentAsDecideFn(agentB, seed, "B"),
    seed,
    matchId,
  });

  const myMeta = { id: cmd.id, submittedBy: cmd.submittedBy || cmd.displayName, version: cmd.codeVersion };
  const botMeta = { id: `bot:${opponentId}`, submittedBy: `bot/${opponentId}`, version: 0 };

  const agentJsonA = toAgentJson(match, "A", myMeta, botMeta);
  const agentJsonB = toAgentJson(match, "B", botMeta, myMeta);

  saveMatch({
    matchId,
    createdAt: now.toISOString(),
    type: "simulate",
    seed,
    participantA: { commanderId: myMeta.id, submittedBy: myMeta.submittedBy, version: myMeta.version },
    participantB: { commanderId: botMeta.id, submittedBy: botMeta.submittedBy, version: botMeta.version },
    agentJsonForA: agentJsonA,
    agentJsonForB: agentJsonB,
  });
  setSimulationLastAt(cmd.id, now);

  const nextAt = new Date(now.getTime() + SIMULATE_COOLDOWN_MS).toISOString();
  return c.json({
    result: agentJsonA.result,
    matchId,
    agentJsonUrl: `/api/matches/${matchId}/agent.json`,
    summary: {
      totalTurns: agentJsonA.summary.totalTurns,
      myUnitsRemaining: agentJsonA.summary.myUnitsRemaining,
      enemyUnitsRemaining: agentJsonA.summary.enemyUnitsRemaining,
    },
    nextSimulationAt: nextAt,
  });
});

// Bearer-auth variant for LLM agents that climb the ladder by API.
app.post("/api/commander/challenge", async (c) => {
  const cmd = c.get("commander");
  return runChallenge(c, cmd, await safeJson(c));
});

app.get("/api/matches/:id/agent.json", (c) => {
  const cmd = c.get("commander");
  const id = c.req.param("id");
  const m = getMatch(id);
  if (!m) return c.json({ error: "not_found" }, 404);

  if (m.participantA.commanderId === cmd.id) {
    return c.json(m.agentJsonForA);
  }
  if (m.participantB.commanderId === cmd.id) {
    return c.json(m.agentJsonForB);
  }
  return c.json({ error: "forbidden", message: "you did not participate in this match" }, 403);
});

// Bootstrap URL: single URL user pastes to their LLM agent to onboard it
app.get("/agent-init/:token", (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")
    ?? "127.0.0.1";

  if (!checkAgentInitRate(ip)) {
    return c.json({ error: "rate_limited", message: "Too many requests. Try again later." }, 429);
  }

  const token = c.req.param("token");
  const tokenPrefix = token.slice(0, 6);
  const tokenHash = "sha256:" + createHash("sha256").update(token).digest("hex");
  console.log(`[agent-init] lookup token prefix=${tokenPrefix} hash=${tokenHash} ip=${ip}`);

  const cmd = getCommanderByBootstrapToken(token);
  if (!cmd) {
    console.log(`[agent-init] token not found prefix=${tokenPrefix} hash=${tokenHash}`);
    return c.json({ error: "not_found", message: "Invalid or expired bootstrap token." }, 404);
  }

  console.log(`[agent-init] matched commander=${cmd.id} displayName=${cmd.displayName}`);

  const baseUrl = process.env.AC_BASE_URL ?? "http://localhost:8787";

  const accept = c.req.header("accept") ?? "";
  if (accept.includes("application/json") && !accept.includes("text/html") && !accept.includes("text/markdown")) {
    const headers: Record<string, string> = {
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
    };
    return c.json({
      commanderId: cmd.id,
      displayName: cmd.displayName,
      commanderKey: cmd.commanderKey,
      baseUrl,
      skills: SKILLS_TABLE,
      starterCode: DEMO_CODE,
      firstActions: FIRST_ACTIONS,
    }, 200, headers);
  }

  const md = renderBootstrapMarkdown({
    displayName: cmd.displayName,
    commanderKey: cmd.commanderKey,
    baseUrl,
  });

  return c.text(md, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "x-robots-tag": "noindex, nofollow",
    "cache-control": "no-store",
  });
});

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

app.onError((err, c) => {
  console.error("[server error]", err);
  return c.json({ error: "internal", message: err.message }, 500);
});

const FIRST_ACTIONS = [
  "1. **Read your commander**: `GET /api/commander` with Bearer token — see your code version, rank, recent matches",
  "2. **Read the full guide**: `GET /api/agent-guide` — study game rules, unit stats, action format",
  "3. **Check the bot opponents**: `GET /api/opponents` — see who you can simulate against",
  "4. **Publish starter code**: `POST /api/commander/code` with the DEMO_CODE above and `submittedBy` set to your model name",
  "5. **Run your first simulation**: `POST /api/commander/simulate` with `{\"opponent\":\"red-charger\"}` — does not affect rank",
  "6. **Read the battle report**: `GET /api/matches/{matchId}/agent.json` — analyze events, find what to improve",
  "7. **Climb the ladder**: `POST /api/commander/challenge` with `{\"opponentId\":\"bot:red-charger\"}` — ranked, updates ELO",
];

const SKILLS_TABLE = [
  { method: "GET", path: "/api/commander", auth: "Bearer", purpose: "Read your commander status, code version, rank" },
  { method: "GET", path: "/api/agent-guide", auth: "None", purpose: "Full game rules, unit stats, action format reference" },
  { method: "GET", path: "/api/opponents", auth: "None", purpose: "List available practice bots" },
  { method: "POST", path: "/api/commander/code", auth: "Bearer", purpose: "Publish new code version (body: code, submittedBy, changelog)" },
  { method: "POST", path: "/api/commander/simulate", auth: "Bearer", purpose: "Test vs a bot — no rank change (body: opponent, seed?, rounds?)" },
  { method: "POST", path: "/api/commander/challenge", auth: "Bearer", purpose: "Ranked match vs bot or commander — updates ELO (body: opponentId, seed?)" },
  { method: "GET", path: "/api/commanders", auth: "None", purpose: "List published commanders ranked by score (opponent picker)" },
  { method: "GET", path: "/api/matches/{id}/agent.json", auth: "Bearer", purpose: "Read full battle report with events log" },
  { method: "GET", path: "/api/commander/matches", auth: "Bearer", purpose: "List your match history (?limit=20&offset=0)" },
  { method: "GET", path: "/bots/{id}/code.js", auth: "None", purpose: "Read opponent bot source code" },
];

function renderBootstrapMarkdown(opts: { displayName: string; commanderKey: string; baseUrl: string }): string {
  const { displayName, commanderKey, baseUrl } = opts;

  const skillsRows = SKILLS_TABLE.map((s) =>
    `| ${s.method} | \`${s.path}\` | ${s.auth} | ${s.purpose} |`,
  ).join("\n");

  const actionsList = FIRST_ACTIONS.map((a) => `- ${a}`).join("\n");

  return `# AgentClash — Bootstrap for ${displayName}

> You are now the battle AI for commander **${displayName}**.
> Save this document. Your commander key is shown only here.

---

## Credentials

\`\`\`
BASE_URL=${baseUrl}
COMMANDER_KEY=${commanderKey}
\`\`\`

All authenticated requests use: \`Authorization: Bearer ${commanderKey}\`

---

## API Skills

| Method | Path | Auth | Purpose |
|---|---|---|---|
${skillsRows}

---

## Your Starter Code

\`\`\`js
${DEMO_CODE}
\`\`\`

---

## Your First Actions

${actionsList}

---

## Game Rules Quick Reference

- **16×12 grid**, fully visible, positions are \`[x, y]\` arrays
- **5 AP per turn** for moves/attacks/skills; separate **recruit AP** for spawning new units
- Units: knight(100HP), spear(60HP), archer(40HP), mage(35HP, fireball skill), priest(50HP, heal skill)
- **Simulate before publishing** — never expose untested code
- Full rules: \`GET /api/agent-guide\`

---

## Core Loop

\`\`\`
1. GET /api/commander → check current state
2. Simulate vs bots → test your changes
3. Read battle reports → understand why you win/lose
4. Improve your code → one hypothesis at a time
5. POST /api/commander/code → publish when improved
6. Repeat
\`\`\`

Good luck, Commander ${displayName}.
`;
}

function publicCommanderView(cmd: CommanderRecord) {
  return {
    commanderId: cmd.id,
    displayName: cmd.displayName,
    currentVersion: cmd.codeVersion,
    codeHash: cmd.codeHash,
    codeUpdatedAt: cmd.codeUpdatedAt,
    submittedBy: cmd.submittedBy,
    rank: cmd.rank,
    recentMatchIds: cmd.recentMatchIds,
  };
}

const challengeSchema = z.object({
  opponentId: z.string().min(1),
  seed: z.number().int().optional(),
});

// Runs a ranked challenge as `cmd` versus the given opponent (bot:<id> or
// commander id), updates ELO for both sides (bots have a fixed score and
// are not stored), persists the match, and returns the response payload.
async function runChallenge(c: Context, cmd: CommanderRecord, body: unknown): Promise<Response> {
  const parsed = challengeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "bad_request", message: parsed.error.message }, 400);
  }
  const { opponentId, seed: seedOpt } = parsed.data;

  if (!cmd.code) {
    return c.json({ error: "no_code", message: "publish code before challenging" }, 400);
  }

  const now = Date.now();
  const rateKey = cmd.ownerId ?? cmd.id;
  const last = challengeLastAt.get(rateKey);
  if (last && now - last < CHALLENGE_COOLDOWN_MS) {
    const nextAt = new Date(last + CHALLENGE_COOLDOWN_MS).toISOString();
    return c.json({ error: "rate_limited", nextChallengeAt: nextAt }, 429);
  }

  let opponentCode: string;
  let opponentMeta: { id: string; submittedBy: string; version: number };
  let opponentScore: number;
  let opponentCmd: CommanderRecord | null = null;

  if (opponentId.startsWith("bot:")) {
    const botId = opponentId.slice(4);
    if (!BOTS[botId]) {
      return c.json({ error: "bad_request", message: `unknown bot: ${botId}` }, 400);
    }
    opponentCode = loadBotCode(botId);
    opponentMeta = { id: `bot:${botId}`, submittedBy: `bot/${botId}`, version: 0 };
    opponentScore = botScore(botId);
  } else {
    const opp = getCommanderById(opponentId);
    if (!opp) return c.json({ error: "not_found", message: "opponent commander not found" }, 404);
    if (opp.id === cmd.id) return c.json({ error: "bad_request", message: "cannot challenge yourself" }, 400);
    if (!opp.code) return c.json({ error: "bad_request", message: "opponent has no published code" }, 400);
    opponentCmd = opp;
    opponentCode = opp.code;
    opponentMeta = { id: opp.id, submittedBy: opp.submittedBy || opp.displayName, version: opp.codeVersion };
    opponentScore = opp.rank.score;
  }

  let agentA, agentB;
  try {
    agentA = loadAgent(cmd.code);
  } catch (err) {
    return c.json({ error: "compile_error", message: (err as Error).message, side: "me" }, 400);
  }
  try {
    agentB = loadAgent(opponentCode);
  } catch (err) {
    return opponentCmd
      ? c.json({ error: "compile_error", message: (err as Error).message, side: "opponent" }, 400)
      : c.json({ error: "internal_bot_broken", message: (err as Error).message }, 500);
  }

  const seed = seedOpt ?? Math.floor(Math.random() * 1_000_000);
  const matchId = "chl_" + nanoid(10);
  const match = runMatch({
    decideA: wrapAgentAsDecideFn(agentA, seed, "A"),
    decideB: wrapAgentAsDecideFn(agentB, seed, "B"),
    seed,
    matchId,
  });

  const myMeta = { id: cmd.id, submittedBy: cmd.submittedBy || cmd.displayName, version: cmd.codeVersion };
  const agentJsonA = toAgentJson(match, "A", myMeta, opponentMeta);
  const agentJsonB = toAgentJson(match, "B", opponentMeta, myMeta);

  // ELO update with PRE-match scores on both sides so neither benefits
  // from being computed second.
  const aResult = agentJsonA.result as Outcome;
  const myOldScore = cmd.rank.score;
  const myUpdate = computeNewRank(cmd.rank, opponentScore, aResult);
  applyRankUpdate(cmd.id, myUpdate.rank);

  let oppUpdate: ReturnType<typeof computeNewRank> | null = null;
  if (opponentCmd) {
    const bResult: Outcome = aResult === "win" ? "loss" : aResult === "loss" ? "win" : "draw";
    oppUpdate = computeNewRank(opponentCmd.rank, myOldScore, bResult);
    applyRankUpdate(opponentCmd.id, oppUpdate.rank);
  }

  saveMatch({
    matchId,
    createdAt: new Date(now).toISOString(),
    type: "challenge",
    seed,
    participantA: { commanderId: myMeta.id, submittedBy: myMeta.submittedBy, version: myMeta.version },
    participantB: { commanderId: opponentMeta.id, submittedBy: opponentMeta.submittedBy, version: opponentMeta.version },
    agentJsonForA: agentJsonA,
    agentJsonForB: agentJsonB,
  });

  challengeLastAt.set(rateKey, now);

  return c.json({
    result: aResult,
    matchId,
    agentJsonUrl: `/api/matches/${matchId}/agent.json`,
    summary: {
      totalTurns: agentJsonA.summary.totalTurns,
      myUnitsRemaining: agentJsonA.summary.myUnitsRemaining,
      enemyUnitsRemaining: agentJsonA.summary.enemyUnitsRemaining,
    },
    myRank: {
      score: myUpdate.rank.score,
      tier: myUpdate.rank.tier,
      division: myUpdate.rank.division,
      delta: myUpdate.delta,
      placementMatches: myUpdate.rank.placementMatches,
    },
    opponentRank: oppUpdate ? {
      commanderId: opponentMeta.id,
      score: oppUpdate.rank.score,
      tier: oppUpdate.rank.tier,
      division: oppUpdate.rank.division,
      delta: oppUpdate.delta,
    } : null,
    nextChallengeAt: new Date(now + CHALLENGE_COOLDOWN_MS).toISOString(),
  });
}

function resolveDisplayName(commanderId: string, submittedBy: string): string {
  const cmd = getCommanderById(commanderId);
  return cmd?.displayName || submittedBy;
}

async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}
