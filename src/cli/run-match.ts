import { runMatch } from "../engine/battle.js";
import type { Action, DecideCtx, DecideFn } from "../engine/types.js";
import { toAgentJson } from "../engine/replay.js";

/**
 * Minimal agent: each unit moves toward / attacks the nearest enemy.
 */
const aggressor: DecideFn = (ctx: DecideCtx): Action[] => {
  const range: Record<string, number> = { knight: 1, spear: 2, archer: 4, mage: 3, priest: 2 };
  const moveRange: Record<string, number> = { knight: 3, spear: 2, archer: 2, mage: 1, priest: 2 };
  const actions: Action[] = [];
  let ap = ctx.myAP;
  for (const u of ctx.myUnits) {
    if (ap < 1 || ctx.enemyUnits.length === 0) break;
    let nearest = ctx.enemyUnits[0]!;
    let best = manhattan(u.pos, nearest.pos);
    for (const e of ctx.enemyUnits) {
      const d = manhattan(u.pos, e.pos);
      if (d < best) {
        best = d;
        nearest = e;
      }
    }
    const r = range[u.type] ?? 1;
    if (best <= r) {
      actions.push({ unitId: u.id, action: "attack", targetUnitId: nearest.id });
    } else {
      const mr = moveRange[u.type] ?? 1;
      const dx0 = nearest.pos[0] - u.pos[0];
      const dy0 = nearest.pos[1] - u.pos[1];
      let stepsLeft = mr;
      const dxMag = Math.min(Math.abs(dx0), stepsLeft);
      const dx = Math.sign(dx0) * dxMag;
      stepsLeft -= dxMag;
      const dyMag = Math.min(Math.abs(dy0), stepsLeft);
      const dy = Math.sign(dy0) * dyMag;
      const target: [number, number] = [u.pos[0] + dx, u.pos[1] + dy];
      actions.push({ unitId: u.id, action: "move", target });
    }
    ap -= 1;
  }
  return actions;
};

/**
 * Minimal defender: stays put and attacks anything in range.
 */
const turtle: DecideFn = (ctx: DecideCtx): Action[] => {
  const range: Record<string, number> = { knight: 1, spear: 2, archer: 4, mage: 3, priest: 2 };
  const actions: Action[] = [];
  let ap = ctx.myAP;
  for (const u of ctx.myUnits) {
    if (ap < 1) break;
    const r = range[u.type] ?? 1;
    const target = ctx.enemyUnits.find((e) => manhattan(u.pos, e.pos) <= r);
    if (target) {
      actions.push({ unitId: u.id, action: "attack", targetUnitId: target.id });
      ap -= 1;
    } else {
      actions.push({ unitId: u.id, action: "defend" });
    }
  }
  return actions;
};

function manhattan(a: [number, number], b: [number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const seed = Number(process.argv[2] ?? Date.now() % 100000);
console.log(`# match seed=${seed}`);
const result = runMatch({
  decideA: aggressor,
  decideB: turtle,
  seed,
  matchId: `cli_${seed}`,
});

const agentJson = toAgentJson(
  result,
  "A",
  { id: "cmd_aggressor", submittedBy: "cli/aggressor", version: 1 },
  { id: "cmd_turtle", submittedBy: "cli/turtle", version: 1 },
);

console.log("\n=== Events ===");
for (const e of agentJson.events) console.log(e);

console.log("\n=== Summary ===");
console.log(JSON.stringify({
  result: agentJson.result,
  myArmy: agentJson.myArmy,
  enemyArmy: agentJson.enemyArmy,
  ...agentJson.summary,
}, null, 2));
