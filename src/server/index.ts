import { serve } from "@hono/node-server";
import { app } from "./routes.js";

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`AgentClash server listening on http://localhost:${info.port}`);
});
