import { describe, it, expect } from "vitest";
import { loadAgent, wrapAgentAsDecideFn, CompileError } from "./runner.js";
import type { DecideCtx } from "../engine/types.js";

// Minimal ctx; the sandbox only forwards a fixed subset and injects rng itself.
function makeCtx(overrides: Partial<DecideCtx> = {}): DecideCtx {
  return {
    myUnits: [],
    enemyUnits: [],
    myArmy: [],
    enemyArmy: [],
    myAP: 10,
    myMoney: 12,
    turn: 1,
    history: [],
    rng: () => 0,
    isFirstMover: true,
    ...overrides,
  };
}

describe("loadAgent — compilation", () => {
  it("accepts a valid agent and returns its actions", () => {
    const agent = loadAgent(`export function decideTurn(ctx) {
      return [{ action: "buy", unitType: "knight" }];
    }`);
    expect(agent.call(makeCtx(), 1)).toEqual([{ action: "buy", unitType: "knight" }]);
  });

  it("strips `export default` too", () => {
    const agent = loadAgent(`export default {};
      function decideTurn() { return [{ action: "buy", unitType: "spear" }]; }`);
    expect(agent.call(makeCtx(), 1)).toEqual([{ action: "buy", unitType: "spear" }]);
  });

  it("rejects a syntax error with CompileError", () => {
    expect(() => loadAgent("function decideTurn( { return []")).toThrow(CompileError);
  });

  it("rejects code with no decideTurn function", () => {
    expect(() => loadAgent("const x = 1;")).toThrow(CompileError);
  });

  it("rejects code over the size cap", () => {
    expect(() => loadAgent("//" + "x".repeat(100_001))).toThrow(CompileError);
  });
});

describe("loadAgent — runtime safety", () => {
  it("returns [] when the agent throws at call time", () => {
    const agent = loadAgent(`function decideTurn() { throw new Error("boom"); }`);
    expect(agent.call(makeCtx(), 1)).toEqual([]);
  });

  it("returns [] when the agent returns a non-array", () => {
    const agent = loadAgent(`function decideTurn() { return { not: "an array" }; }`);
    expect(agent.call(makeCtx(), 1)).toEqual([]);
  });

  it("returns [] when the agent runs past the timeout (infinite loop)", () => {
    const agent = loadAgent(`function decideTurn() { while (true) {} }`);
    expect(agent.call(makeCtx(), 1)).toEqual([]);
  });

  it("does not expose host globals like process", () => {
    const agent = loadAgent(`function decideTurn() {
      return [{ action: "buy", unitType: typeof process === "undefined" ? "knight" : "spear" }];
    }`);
    expect(agent.call(makeCtx(), 1)).toEqual([{ action: "buy", unitType: "knight" }]);
  });
});

describe("loadAgent — determinism & isolation", () => {
  it("gives the same rng-driven result for the same seed (compiled once, reused)", () => {
    const code = `function decideTurn(ctx) {
      return [{ action: "buy", unitType: ctx.rng() < 0.5 ? "knight" : "spear" }];
    }`;
    const agent = loadAgent(code);
    const first = agent.call(makeCtx(), 12345);
    // Re-running the SAME agent object with the SAME seed must be identical,
    // proving the per-turn call path (now a reused precompiled script) is stable.
    expect(agent.call(makeCtx(), 12345)).toEqual(first);
    // A different seed is allowed to diverge; just assert it still yields a valid action.
    const other = agent.call(makeCtx(), 999) as Array<{ unitType: string }>;
    expect(["knight", "spear"]).toContain(other[0]!.unitType);
  });

  it("reads the per-call ctx, not a stale one from a previous call", () => {
    const agent = loadAgent(`function decideTurn(ctx) {
      return [{ action: "buy", unitType: ctx.myMoney > 5 ? "knight" : "engineer" }];
    }`);
    expect(agent.call(makeCtx({ myMoney: 10 }), 1)).toEqual([{ action: "buy", unitType: "knight" }]);
    expect(agent.call(makeCtx({ myMoney: 2 }), 1)).toEqual([{ action: "buy", unitType: "engineer" }]);
  });
});

describe("wrapAgentAsDecideFn", () => {
  it("derives a deterministic per-turn seed and forwards the call", () => {
    const agent = loadAgent(`function decideTurn(ctx) {
      return [{ action: "buy", unitType: ctx.rng() < 0.5 ? "knight" : "spear" }];
    }`);
    const fnA = wrapAgentAsDecideFn(agent, 42, "A");
    const ctx = makeCtx({ turn: 3 });
    // Same wrapper + same ctx (same turn) → same derived seed → identical output.
    expect(fnA(ctx)).toEqual(fnA(ctx));
  });
});
