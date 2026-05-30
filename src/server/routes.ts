import { Hono } from "hono";
import type { Vars } from "./routes/shared.js";
import { registerAccount } from "./routes/account.js";
import { registerIssues } from "./routes/issues.js";
import { registerPages } from "./routes/pages.js";
import { registerPublic } from "./routes/public.js";
import { registerCommander } from "./routes/commander.js";
import { registerBootstrap } from "./routes/bootstrap.js";

export const app = new Hono<{ Variables: Vars }>();

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
