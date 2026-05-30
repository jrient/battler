import { z } from "zod";
import { firstSideFromSeed } from "../../engine/battle.js";
import {
  getCommanderById,
  findCommanderByDisplayName,
  getMatchesByOwner,
  validateDisplayName,
  listCommandersByOwner,
  createCommanderForOwner,
  deleteCommander,
  regenerateCommanderBootstrapToken,
  resetCommanderKey,
  renameCommander,
  DISPLAY_NAME_RE,
  isDisplayNameReserved,
} from "../store.js";
import {
  getSessionUser,
  requireSession,
  startGithubOAuth,
  handleGithubCallback,
  handleLogout,
} from "../auth.js";
import { BASE_URL, safeJson, resolveDisplayName, runChallenge, type AppType } from "./shared.js";

const createCommanderSchema = z.object({
  displayName: z.string().min(3).max(32),
});

const renameSchema = z.object({
  displayName: z.string().min(3).max(32),
});

export function registerAccount(app: AppType): void {
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
        bootstrapUrl: `${BASE_URL}/agent-init/${cmd.bootstrapToken}`,
      })),
    });
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
    return c.json({
      commanderId: cmd.id,
      displayName: cmd.displayName,
      commanderKey: cmd.commanderKey,
      bootstrapToken: cmd.bootstrapToken,
      bootstrapUrl: `${BASE_URL}/agent-init/${cmd.bootstrapToken}`,
      createdAt: cmd.createdAt,
    }, 201);
  });

  app.get("/api/me/commanders/:id", (c) => {
    const user = c.get("user");
    const cmd = getCommanderById(c.req.param("id"));
    if (!cmd || cmd.ownerId !== user.id) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({
      commanderId: cmd.id,
      displayName: cmd.displayName,
      commanderKey: cmd.commanderKey,
      bootstrapToken: cmd.bootstrapToken,
      bootstrapUrl: `${BASE_URL}/agent-init/${cmd.bootstrapToken}`,
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

  app.patch("/api/me/commanders/:id", async (c) => {
    const user = c.get("user");
    const cmd = getCommanderById(c.req.param("id"));
    if (!cmd || cmd.ownerId !== user.id) {
      return c.json({ error: "not_found" }, 404);
    }
    const body = await safeJson(c);
    const parsed = renameSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: "bad_request", message: parsed.error.message }, 400);
    }
    const name = parsed.data.displayName;
    if (!DISPLAY_NAME_RE.test(name)) {
      return c.json({ error: "bad_request", reason: "format" }, 409);
    }
    if (isDisplayNameReserved(name)) {
      return c.json({ error: "bad_request", reason: "reserved" }, 409);
    }
    // Allow keeping the same name; only reject if a *different* commander already has it
    const existing = findCommanderByDisplayName(name);
    if (existing && existing.id !== cmd.id) {
      return c.json({ error: "bad_request", reason: "taken" }, 409);
    }
    const updated = renameCommander(cmd.id, name);
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json({ displayName: updated.displayName });
  });

  app.post("/api/me/commanders/:id/regenerate-bootstrap", (c) => {
    const user = c.get("user");
    const cmd = getCommanderById(c.req.param("id"));
    if (!cmd || cmd.ownerId !== user.id) {
      return c.json({ error: "not_found" }, 404);
    }
    const updated = regenerateCommanderBootstrapToken(cmd.id);
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json({
      bootstrapToken: updated.bootstrapToken,
      bootstrapUrl: `${BASE_URL}/agent-init/${updated.bootstrapToken}`,
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
        firstSide: firstSideFromSeed(m.seed),
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
}
