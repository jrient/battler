import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { nanoid } from "nanoid";
import { z } from "zod";
import { runMatch } from "../../engine/battle.js";
import { loadAgent, wrapAgentAsDecideFn } from "../../sandbox/runner.js";
import { toAgentJson } from "../../engine/replay.js";
import { BOTS, loadBotCode } from "../../bots/registry.js";
import { computeNewRank, botScore, type Outcome } from "../../engine/elo.js";
import {
  getCommanderByKey,
  getCommanderById,
  saveMatch,
  applyRankUpdate,
  type CommanderRecord,
  type UserRecord,
} from "../store.js";

export type Vars = { commander: CommanderRecord; user: UserRecord };
export type AppType = Hono<{ Variables: Vars }>;

// Public base URL, single source for the localhost fallback. Set AC_BASE_URL in
// production so bootstrap/agent-init URLs point at the real host.
export const BASE_URL = process.env.AC_BASE_URL ?? "http://localhost:8787";

export const SIMULATE_COOLDOWN_MS = 2000;
export const CHALLENGE_COOLDOWN_MS = 60_000;

// Reject oversized request bodies before they are read into memory (DoS guard),
// with a consistent JSON 413. zod still bounds individual fields afterward.
export function jsonBodyLimit(maxSize: number): MiddlewareHandler<{ Variables: Vars }> {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      c.json({ error: "payload_too_large", message: `request body exceeds the ${maxSize}-byte limit` }, 413),
  });
}

export async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function resolveDisplayName(commanderId: string, submittedBy: string): string {
  const cmd = getCommanderById(commanderId);
  return cmd?.displayName || submittedBy;
}

export function publicCommanderView(cmd: CommanderRecord) {
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

export const bearerAuth: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: "unauthorized", message: "Bearer token required" }, 401);
  const cmd = getCommanderByKey(m[1]!.trim());
  if (!cmd) return c.json({ error: "unauthorized", message: "invalid commander key" }, 401);
  c.set("commander", cmd);
  await next();
};

export const DEMO_CODE = `// AgentClash demo strategy — buys an army with money, then fights smart.
// Turn 1 you start with no units: spend ctx.myMoney to buy, then operate
// whatever is on the board with ctx.myAP.
const RANGE = { knight: 1, spear: 2, archer: 4, mage: 3, priest: 2, engineer: 1 };
const MOVE = { knight: 2, spear: 3, archer: 2, mage: 1, priest: 1, engineer: 2 };
const COST = { knight: 5, spear: 3, archer: 3, mage: 4, priest: 4, engineer: 2 };
const THREAT = { mage: 10, archer: 7, priest: 6, spear: 4, engineer: 3, knight: 2 };
// Buy priority — cycles through this list while you can still afford something.
const BUY_ORDER = ["spear", "archer", "knight", "mage", "priest", "engineer"];

export function decideTurn(ctx) {
  const actions = [];

  // --- Spend money on new units (only works during the buy window) ---
  let money = ctx.myMoney || 0;
  const cheapest = Math.min.apply(null, BUY_ORDER.map(t => COST[t]));
  let i = 0;
  while (money >= cheapest) {
    const type = BUY_ORDER[i % BUY_ORDER.length];
    if (COST[type] <= money) {
      actions.push({ action: "buy", unitType: type });
      money -= COST[type];
    }
    i++;
  }

  // --- Operate units. Attacks are free; only moving costs AP. ---
  // Mage splash and priest heal are passives that trigger automatically on a
  // normal attack: a mage hitting an enemy also splashes nearby enemies, and a
  // priest "attacking" a friendly unit heals it instead.
  let ap = ctx.myAP;
  if (!ctx.enemyUnits.length) return actions;

  const targets = [...ctx.enemyUnits].sort((a, b) => THREAT[b.type] - THREAT[a.type]);

  for (const u of ctx.myUnits) {
    // Priest: heal the most wounded ally in range by attacking it.
    if (u.type === "priest") {
      const w = ctx.myUnits.filter(a => a.id !== u.id && a.hp < a.maxHp * 0.6)
        .sort((a, b) => a.hp - b.hp);
      const t = w.find(a => mhd(u.pos, a.pos) <= RANGE.priest);
      if (t) {
        actions.push({ unitId: u.id, action: "attack", targetUnitId: t.id });
        continue;
      }
    }

    const range = RANGE[u.type];
    const hit = targets.find(e => mhd(u.pos, e.pos) <= range);
    if (hit) {
      actions.push({ unitId: u.id, action: "attack", targetUnitId: hit.id });
      continue;
    }
    const goal = targets[0];
    if (goal && ap >= 1) {
      const dest = step(u.pos, goal.pos, MOVE[u.type]);
      actions.push({ unitId: u.id, action: "move", target: dest });
      ap -= 1;
    }
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

// Per-user cooldown for ranked challenges (one challenge per minute across all commanders).
const challengeLastAt = new Map<string, number>();

const challengeSchema = z.object({
  opponentId: z.string().min(1),
  seed: z.number().int().optional(),
});

// Runs a ranked challenge as `cmd` versus the given opponent (bot:<id> or
// commander id), updates ELO for both sides (bots have a fixed score and
// are not stored), persists the match, and returns the response payload.
export async function runChallenge(c: Context, cmd: CommanderRecord, body: unknown): Promise<Response> {
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
    // Only allow challenging commanders within ±10% of your score
    const myScore = cmd.rank.score;
    if (myScore > 0 && opponentScore > 0) {
      const lower = Math.round(myScore * 0.9);
      const upper = Math.round(myScore * 1.1);
      if (opponentScore < lower || opponentScore > upper) {
        return c.json({
          error: "score_mismatch",
          message: `Opponent score ${opponentScore} is outside your challenge range (${lower}–${upper})`,
          myScore,
          opponentScore,
          range: { lower, upper },
        }, 400);
      }
    }
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
  const myUpdate = computeNewRank(cmd.rank, opponentScore, aResult, opponentCmd === null);
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
