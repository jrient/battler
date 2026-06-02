/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { loadAgent, CompileError } from "../sandbox/runner.js";

const cases: Array<{ name: string; code: string; expect: "compile-error" | "timeout-empty" | "ok-empty" | "ok" }> = [
  {
    name: "syntax error",
    code: "export function decideTurn(",
    expect: "compile-error",
  },
  {
    name: "missing decideTurn",
    code: "function notTheRightName(ctx) { return []; }",
    expect: "compile-error",
  },
  {
    name: "throws at call",
    code: "export function decideTurn(ctx) { throw new Error('boom'); }",
    expect: "ok-empty",
  },
  {
    name: "returns non-array",
    code: "export function decideTurn(ctx) { return 42; }",
    expect: "ok-empty",
  },
  {
    name: "infinite loop",
    code: "export function decideTurn(ctx) { while(true){}; return []; }",
    expect: "timeout-empty",
  },
  {
    name: "tries to access process",
    code: "export function decideTurn(ctx) { return [typeof process]; }",
    expect: "ok",
  },
  {
    name: "tries require",
    code: "export function decideTurn(ctx) { try { require('fs'); } catch(e) {} return []; }",
    expect: "ok-empty",
  },
  {
    name: "deeply recursive",
    code: "export function decideTurn(ctx) { function f(){f()}; try{f()}catch(e){} return []; }",
    expect: "ok-empty",
  },
];

const dummyCtx = {
  myUnits: [], enemyUnits: [], myArmy: [], enemyArmy: [],
  myAP: 10, myMoney: 17, turn: 1, history: [], rng: () => 0.5,
};

let failed = 0;
for (const c of cases) {
  let label = "ok";
  let result: unknown = null;
  let agent;
  try {
    agent = loadAgent(c.code);
  } catch (err) {
    if (err instanceof CompileError) {
      label = "compile-error";
    } else {
      label = `crash:${(err as Error).message}`;
    }
  }
  if (agent) {
    const start = Date.now();
    result = agent.call(dummyCtx as any, 12345);
    const elapsed = Date.now() - start;
    if (Array.isArray(result) && result.length === 0) {
      label = elapsed > 150 ? "timeout-empty" : "ok-empty";
    }
  }
  const ok = label === c.expect || (c.expect === "ok" && label === "ok-empty");
  console.log(`${ok ? "✓" : "✗"} ${c.name.padEnd(28)} → ${label} (expected ${c.expect})`);
  if (!ok) failed++;
}

console.log(`\n${failed === 0 ? "all pass" : `${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
