import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { runMatch } from "../engine/battle.js";
import { CompileError, loadAgent, wrapAgentAsDecideFn } from "../sandbox/runner.js";
import { toAgentJson } from "../engine/replay.js";
import { BOTS, listBots, loadBotCode } from "../bots/registry.js";
import {
  getCommanderByKey,
  getCommanderById,
  getMatch,
  getSimulationLastAt,
  saveMatch,
  setSimulationLastAt,
  updateCommanderCode,
  type CommanderRecord,
} from "./store.js";

const SIMULATE_COOLDOWN_MS = 2000;

type Vars = { commander: CommanderRecord };

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

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

app.onError((err, c) => {
  console.error("[server error]", err);
  return c.json({ error: "internal", message: err.message }, 500);
});

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

async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}
