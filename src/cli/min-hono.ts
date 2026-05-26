import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();
app.get("/health", (c) => {
  console.log("/health hit");
  return c.json({ ok: true });
});
app.get("/text", (c) => c.text("hello"));

serve({ fetch: app.fetch, port: 8788 }, (info) => {
  console.log(`min-hono listening :${info.port}`);
});
