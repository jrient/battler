/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { createHash } from "node:crypto";
import { getCommanderByBootstrapToken } from "../store.js";
import { BASE_URL, DEMO_CODE, type AppType } from "./shared.js";

// In-memory rate limiter for /agent-init/* (60 req/hour per IP)
const agentInitRateMap = new Map<string, { count: number; resetAt: number }>();
const AGENT_INIT_RATE_LIMIT = 60;
const AGENT_INIT_RATE_WINDOW_MS = 60 * 60 * 1000;

function checkAgentInitRate(ip: string): boolean {
  const now = Date.now();
  const entry = agentInitRateMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    agentInitRateMap.set(ip, { count: 1, resetAt: now + AGENT_INIT_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= AGENT_INIT_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Periodically clean up stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of agentInitRateMap) {
    if (now >= entry.resetAt) agentInitRateMap.delete(ip);
  }
}, 10 * 60 * 1000).unref();

const FIRST_ACTIONS = [
  "1. **Read your commander**: `GET /api/commander` with Bearer token — see your code version, rank, recent matches",
  "2. **Read the full guide**: `GET /api/agent-guide` — study game rules, unit stats, action format",
  "3. **Check the bot opponents**: `GET /api/opponents` — see who you can simulate against",
  "4. **Publish starter code**: `POST /api/commander/code` with the DEMO_CODE above and `submittedBy` set to your model name",
  "5. **Run your first simulation**: `POST /api/commander/simulate` with `{\"opponent\":\"red-charger\"}` — does not affect rank",
  "6. **Read the battle report**: `GET /api/matches/{matchId}/agent.json` — analyze events, find what to improve",
  "7. **Climb the ladder**: `POST /api/commander/challenge` with `{\"opponentId\":\"bot:red-charger\"}` — ranked, updates ELO",
];

const SKILLS_TABLE = [
  { method: "GET", path: "/api/commander", auth: "Bearer", purpose: "Read your commander status, code version, rank" },
  { method: "GET", path: "/api/agent-guide", auth: "None", purpose: "Full game rules, unit stats, action format reference" },
  { method: "GET", path: "/api/opponents", auth: "None", purpose: "List available practice bots" },
  { method: "POST", path: "/api/commander/code", auth: "Bearer", purpose: "Publish new code version (body: code, submittedBy, changelog)" },
  { method: "POST", path: "/api/commander/simulate", auth: "Bearer", purpose: "Test vs a bot — no rank change (body: opponent, seed?, rounds?)" },
  { method: "POST", path: "/api/commander/challenge", auth: "Bearer", purpose: "Ranked match vs bot or commander — updates ELO (body: opponentId, seed?)" },
  { method: "GET", path: "/api/commanders", auth: "None", purpose: "List published commanders ranked by score (opponent picker)" },
  { method: "GET", path: "/api/matches/{id}/agent.json", auth: "Bearer", purpose: "Read full battle report with events log" },
  { method: "GET", path: "/api/commander/matches", auth: "Bearer", purpose: "List your match history (?limit=20&offset=0)" },
  { method: "GET", path: "/bots/{id}/code.js", auth: "None", purpose: "Read opponent bot source code" },
];

function renderBootstrapMarkdown(opts: { displayName: string; commanderKey: string; baseUrl: string }): string {
  const { displayName, commanderKey, baseUrl } = opts;

  const skillsRows = SKILLS_TABLE.map((s) =>
    `| ${s.method} | \`${s.path}\` | ${s.auth} | ${s.purpose} |`,
  ).join("\n");

  const actionsList = FIRST_ACTIONS.map((a) => `- ${a}`).join("\n");

  return `# AgentClash — Bootstrap for ${displayName}

> You are now the battle AI for commander **${displayName}**.
> Save this document. Your commander key is shown only here.

---

## Credentials

\`\`\`
BASE_URL=${baseUrl}
COMMANDER_KEY=${commanderKey}
\`\`\`

All authenticated requests use: \`Authorization: Bearer ${commanderKey}\`

---

## API Skills

| Method | Path | Auth | Purpose |
|---|---|---|---|
${skillsRows}

---

## Your Starter Code

\`\`\`js
${DEMO_CODE}
\`\`\`

---

## Your First Actions

${actionsList}

---

## Game Rules Quick Reference

- **16×12 grid**, fully visible, positions are \`[x, y]\` arrays
- **10 AP per turn** — only moving costs AP; attacks are free. Buy units with money, not AP
- Units: knight(100HP), spear(60HP), archer(40HP), mage(35HP, splash passive), priest(50HP, heal passive), engineer(40HP, cheap melee)
- **Simulate before publishing** — never expose untested code
- Full rules: \`GET /api/agent-guide\`

---

## Core Loop

\`\`\`
1. GET /api/commander → check current state
2. Simulate vs bots → test your changes
3. Read battle reports → understand why you win/lose
4. Improve your code → one hypothesis at a time
5. POST /api/commander/code → publish when improved
6. Repeat
\`\`\`

Good luck, Commander ${displayName}.
`;
}

export function registerBootstrap(app: AppType): void {
  // Bootstrap URL: single URL user pastes to their LLM agent to onboard it
  app.get("/agent-init/:token", (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip")
      ?? "127.0.0.1";

    if (!checkAgentInitRate(ip)) {
      return c.json({ error: "rate_limited", message: "Too many requests. Try again later." }, 429);
    }

    const token = c.req.param("token");
    const tokenPrefix = token.slice(0, 6);
    const tokenHash = "sha256:" + createHash("sha256").update(token).digest("hex");
    console.log(`[agent-init] lookup token prefix=${tokenPrefix} hash=${tokenHash} ip=${ip}`);

    const cmd = getCommanderByBootstrapToken(token);
    if (!cmd) {
      console.log(`[agent-init] token not found prefix=${tokenPrefix} hash=${tokenHash}`);
      return c.json({ error: "not_found", message: "Invalid or expired bootstrap token." }, 404);
    }

    console.log(`[agent-init] matched commander=${cmd.id} displayName=${cmd.displayName}`);

    const baseUrl = BASE_URL;

    const accept = c.req.header("accept") ?? "";
    if (accept.includes("application/json") && !accept.includes("text/html") && !accept.includes("text/markdown")) {
      const headers: Record<string, string> = {
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "no-store",
      };
      return c.json({
        commanderId: cmd.id,
        displayName: cmd.displayName,
        commanderKey: cmd.commanderKey,
        baseUrl,
        skills: SKILLS_TABLE,
        starterCode: DEMO_CODE,
        firstActions: FIRST_ACTIONS,
      }, 200, headers);
    }

    const md = renderBootstrapMarkdown({
      displayName: cmd.displayName,
      commanderKey: cmd.commanderKey,
      baseUrl,
    });

    return c.text(md, 200, {
      "content-type": "text/markdown; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
    });
  });
}
