/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { createHash } from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { nanoid } from "nanoid";
import { z } from "zod";
import { runMatch } from "../../engine/battle.js";
import { CompileError, loadAgent, wrapAgentAsDecideFn } from "../../sandbox/runner.js";
import { toAgentJson } from "../../engine/replay.js";
import { BOTS, loadBotCode } from "../../bots/registry.js";
import {
  getMatch,
  getSimulationLastAt,
  saveMatch,
  setSimulationLastAt,
  updateCommanderCode,
} from "../store.js";
import {
  bearerAuth,
  publicCommanderView,
  runChallenge,
  safeJson,
  SIMULATE_COOLDOWN_MS,
  type AppType,
} from "./shared.js";

// Hard cap on uploaded algorithm files: 100k. Enforced twice — bodyLimit
// rejects oversized requests before the body is read into memory (DoS guard),
// and the zod schema bounds the code field itself.
const MAX_CODE_BYTES = 100 * 1024;

const codeSchema = z.object({
  code: z.string().min(10).max(MAX_CODE_BYTES),
  submittedBy: z.string().min(1).max(64),
  changelog: z.string().max(500).optional().default(""),
});

const simSchema = z.object({
  opponent: z.string().optional(),
  seed: z.number().int().optional(),
  rounds: z.number().int().min(1).max(5).optional().default(1),
});

export function registerCommander(app: AppType): void {
  app.use("/api/commander/*", bearerAuth);
  app.use("/api/matches/*", bearerAuth);

  app.get("/api/commander", (c) => {
    const cmd = c.get("commander");
    return c.json(publicCommanderView(cmd));
  });

  app.post(
    "/api/commander/code",
    bodyLimit({
      maxSize: MAX_CODE_BYTES,
      onError: (c) =>
        c.json(
          { error: "payload_too_large", message: `algorithm file exceeds the ${MAX_CODE_BYTES}-byte (100k) limit` },
          413,
        ),
    }),
    async (c) => {
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
    },
  );

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
}
