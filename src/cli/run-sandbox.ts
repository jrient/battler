/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runMatch } from "../engine/battle.js";
import { loadAgent, wrapAgentAsDecideFn } from "../sandbox/runner.js";
import { toAgentJson } from "../engine/replay.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..", "..");

const redCharger = readFileSync(resolve(ROOT, "src/bots/red-charger.js"), "utf8");

const minimalDefender = `
export function decideTurn(ctx) {
  const actions = [];
  let ap = ctx.myAP;
  const RANGE = { knight: 1, spear: 2, archer: 4, mage: 3, priest: 2, engineer: 1 };
  for (const u of ctx.myUnits) {
    if (ap < 1) break;
    const r = RANGE[u.type] || 1;
    const target = ctx.enemyUnits.find(e =>
      Math.abs(u.pos[0]-e.pos[0]) + Math.abs(u.pos[1]-e.pos[1]) <= r
    );
    if (target) {
      actions.push({ unitId: u.id, action: "attack", targetUnitId: target.id });
      ap -= 1;
    } else {
      actions.push({ unitId: u.id, action: "defend" });
    }
  }
  return actions;
}
`;

const seed = Number(process.argv[2] ?? Date.now() % 100000);
console.log(`# sandbox match seed=${seed}`);

const agentA = loadAgent(redCharger);
const agentB = loadAgent(minimalDefender);

const result = runMatch({
  decideA: wrapAgentAsDecideFn(agentA, seed, "A"),
  decideB: wrapAgentAsDecideFn(agentB, seed, "B"),
  seed,
  matchId: `sbx_${seed}`,
});

const view = toAgentJson(
  result,
  "A",
  { id: "cmd_red", submittedBy: "red-charger", version: 1 },
  { id: "cmd_def", submittedBy: "defender", version: 1 },
);

console.log("\n=== Events (last 30) ===");
for (const e of view.events.slice(-30)) console.log(e);

console.log("\n=== Summary ===");
console.log(JSON.stringify({
  result: view.result,
  myArmy: view.myArmy,
  enemyArmy: view.enemyArmy,
  ...view.summary,
}, null, 2));
