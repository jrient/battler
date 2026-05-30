import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { z } from "zod";
import { firstSideFromSeed } from "../../engine/battle.js";
import { BOTS, listBots, loadBotCode } from "../../bots/registry.js";
import {
  createCommander,
  getMatch,
  getMatchesByCommander,
  listMatches,
  listCommanders,
} from "../store.js";
import { DEMO_CODE, resolveDisplayName, safeJson, type AppType } from "./shared.js";

const registerSchema = z.object({
  displayName: z.string().min(1).max(64).optional().default("Commander"),
});

export function registerPublic(app: AppType): void {
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

  app.get("/api/agent-guide", (c) => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const mdPath = resolve(__dirname, "..", "..", "..", "AGENT_GUIDE.md");
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
      const opp = isA ? m.participantB : m.participantA;
      return {
        matchId: m.matchId,
        createdAt: m.createdAt,
        type: m.type,
        opponent: opp.submittedBy,
        opponentName: resolveDisplayName(opp.commanderId, opp.submittedBy),
        result: myResult,
        // Did THIS commander move first (won the coin flip) in this match?
        iMovedFirst: isA ? firstSideFromSeed(m.seed) === "A" : firstSideFromSeed(m.seed) === "B",
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
        // Derive from seed so it's present even for matches indexed before the
        // firstSide field existed (the engine picks first-mover purely from seed).
        firstSide: firstSideFromSeed(m.seed),
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
      firstSide: firstSideFromSeed(m.seed),
      turnSnapshots: m.agentJsonForA.turnSnapshots ?? [],
      events: m.agentJsonForA.events,
      summary: m.agentJsonForA.summary,
    });
  });
}
