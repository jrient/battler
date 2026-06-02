/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

type Vars = { commander: string };

const app = new Hono<{ Variables: Vars }>();

const bearerAuth: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  c.set("commander", "test");
  await next();
};

app.get("/health", (c) => c.json({ ok: true }));

// removed regex param test

app.use("/api/commander/*", bearerAuth);
app.use("/api/matches/*", bearerAuth);

app.get("/api/commander", (c) => c.json({ ok: true, who: c.get("commander") }));

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("[err]", err);
  return c.json({ error: "internal", message: err.message }, 500);
});

serve({ fetch: app.fetch, port: 8789 }, (i) => console.log(`min-routes :${i.port}`));
