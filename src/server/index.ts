import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./routes.js";

// Serve frontend static files
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`AgentClash server listening on http://localhost:${info.port}`);
});
