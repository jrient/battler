/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { Hono } from "hono";
import { compress } from "hono/compress";
import type { Vars } from "./routes/shared.js";
import { registerAccount } from "./routes/account.js";
import { registerIssues } from "./routes/issues.js";
import { registerPages } from "./routes/pages.js";
import { registerPublic } from "./routes/public.js";
import { registerCommander } from "./routes/commander.js";
import { registerBootstrap } from "./routes/bootstrap.js";

export const app = new Hono<{ Variables: Vars }>();

// Gzip/deflate every response above the default 1 KB threshold. Registered
// first so it wraps all routes below. The replay payload is ~2.7 MB of highly
// repetitive per-phase unit snapshots that shrinks ~98% (to ~28 KB) over the
// wire — this is the single biggest replay-page load win.
app.use(compress());

app.get("/health", (c) => c.json({ ok: true }));

// Route groups are registered in this exact order because Hono applies
// middleware only to routes declared after it: the public read routes in
// registerPublic (notably /api/matches/:id/replay) must be registered before
// registerCommander installs the bearer-auth middleware on /api/matches/*.
registerAccount(app);
registerIssues(app);
registerPages(app);
registerPublic(app);
registerCommander(app);
registerBootstrap(app);

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

app.onError((err, c) => {
  console.error("[server error]", err);
  return c.json({ error: "internal", message: err.message }, 500);
});
