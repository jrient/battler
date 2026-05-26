import * as vm from "node:vm";
import type { Action, DecideCtx, DecideFn, Side } from "../engine/types.js";

const CALL_TIMEOUT_MS = 200;
const SETUP_TIMEOUT_MS = 1000;
const MAX_CODE_SIZE = 100_000;

export interface SandboxedAgent {
  call(ctx: DecideCtx, rngSeed: number): Action[];
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

/**
 * Compile player code into a sandboxed agent.
 * MVP uses Node's built-in vm with a fresh V8 context. Not a hard security boundary
 * (Array.constructor.constructor escape works) — adequate for trusted LLM authors.
 * Upgrade to isolated-vm for production / untrusted user code.
 */
export function loadAgent(code: string): SandboxedAgent {
  if (code.length > MAX_CODE_SIZE) {
    throw new CompileError(`agent code exceeds ${MAX_CODE_SIZE} bytes`);
  }

  const stripped = code
    .replace(/\bexport\s+default\s+/g, "")
    .replace(/\bexport\s+/g, "");

  const context = vm.createContext({});

  const setupSource = `
    function __makeRng(seed) {
      let state = seed >>> 0;
      return function() {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    ${stripped}

    if (typeof decideTurn !== "function") {
      throw new Error("agent must define a function named decideTurn");
    }

    globalThis.__runTurn = function(ctxString, rngSeed) {
      var ctx = JSON.parse(ctxString);
      ctx.rng = __makeRng(rngSeed);
      var result = decideTurn(ctx);
      if (!Array.isArray(result)) return "[]";
      return JSON.stringify(result);
    };
  `;

  try {
    new vm.Script(setupSource, { filename: "agent-setup.js" }).runInContext(
      context,
      { timeout: SETUP_TIMEOUT_MS },
    );
  } catch (err) {
    throw new CompileError(`agent setup failed: ${(err as Error).message}`);
  }

  return {
    call(ctx: DecideCtx, rngSeed: number): Action[] {
      const minimalCtx = {
        myUnits: ctx.myUnits,
        enemyUnits: ctx.enemyUnits,
        myArmy: ctx.myArmy,
        enemyArmy: ctx.enemyArmy,
        myAP: ctx.myAP,
        turn: ctx.turn,
        history: ctx.history,
      };
      let resultString: unknown;
      try {
        const ctxJson = JSON.stringify(minimalCtx);
        const script = new vm.Script(
          `__runTurn(${JSON.stringify(ctxJson)}, ${rngSeed | 0})`,
          { filename: "agent-call.js" },
        );
        resultString = script.runInContext(context, { timeout: CALL_TIMEOUT_MS });
      } catch {
        return [];
      }
      if (typeof resultString !== "string") return [];
      try {
        const parsed: unknown = JSON.parse(resultString);
        if (!Array.isArray(parsed)) return [];
        return parsed as Action[];
      } catch {
        return [];
      }
    },
  };
}

/**
 * Wrap a SandboxedAgent so the engine can call it like a regular DecideFn.
 * Derives a per-turn rng seed deterministically from matchSeed + turn + side.
 */
export function wrapAgentAsDecideFn(
  agent: SandboxedAgent,
  matchSeed: number,
  side: Side,
): DecideFn {
  return (ctx: DecideCtx): Action[] => {
    const turnSeed =
      (matchSeed ^ (ctx.turn * 0x9e3779b1) ^ (side === "A" ? 1 : 2)) >>> 0;
    return agent.call(ctx, turnSeed);
  };
}
