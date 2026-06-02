/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { describe, it, expect } from "vitest";
import { runMatch } from "./battle.js";
import {
  MAX_TURNS,
  BUY_TURNS,
  STALE_TURNS_LIMIT,
  STARTING_MONEY,
  MONEY_INCOME_PER_TURN,
  SECOND_MOVER_BONUS,
} from "./units.js";
import type { Action, DecideCtx, DecideFn } from "./types.js";

// An agent that buys `count` archers in the opening, then does nothing. Two such
// agents spawn on opposite ends of the board, well out of archer range, and
// never move — a permanently frozen board that should trip stalemate detection.
function idleArmy(count: number): DecideFn {
  return (ctx: DecideCtx): Action[] => {
    if (ctx.myUnits.length < count && ctx.myMoney >= 3) {
      return [{ action: "buy", unitType: "archer" }];
    }
    return ctx.myUnits.map((u) => ({ unitId: u.id, action: "defend" as const }));
  };
}

describe("stalemate detection", () => {
  it("ends a frozen match early instead of grinding to MAX_TURNS", () => {
    const out = runMatch({
      decideA: idleArmy(2),
      decideB: idleArmy(1),
      seed: 42,
      matchId: "test_stale",
      monsters: false,
    });

    // Both sides field units but never engage → no progress → early stop.
    expect(out.totalTurns).toBeLessThan(MAX_TURNS);
    // Should stop right after the staleness threshold is reached.
    expect(out.totalTurns).toBeLessThanOrEqual(BUY_TURNS + STALE_TURNS_LIMIT + 1);
    expect(out.events.some((e) => e.includes("stalemate"))).toBe(true);
    // A fielded more strength (2 archers vs 1) → A wins the stalemate.
    expect(out.winner).toBe("A");
  });
});

// Sanity guard: an aggressive, decisive match must NOT be cut short by the
// stalemate check — it should end by elimination well before MAX_TURNS.
const rusher: DecideFn = (ctx: DecideCtx): Action[] => {
  const range: Record<string, number> = { knight: 1, spear: 2, archer: 4, mage: 3, priest: 2, engineer: 1 };
  const acts: Action[] = [];
  if (ctx.myUnits.length === 0 && ctx.myMoney >= 5) {
    return [{ action: "buy", unitType: "knight" }];
  }
  for (const u of ctx.myUnits) {
    const e = ctx.enemyUnits[0];
    if (!e) {
      acts.push({ unitId: u.id, action: "defend" });
      continue;
    }
    const d = Math.abs(u.pos[0] - e.pos[0]) + Math.abs(u.pos[1] - e.pos[1]);
    if (d <= (range[u.type] ?? 1)) {
      acts.push({ unitId: u.id, action: "attack", targetUnitId: e.id });
    } else {
      // Step one cell toward the enemy along a single axis, so the knight stops
      // adjacent (and attacks next turn) instead of overshooting onto its cell.
      const dx0 = e.pos[0] - u.pos[0];
      const dy0 = e.pos[1] - u.pos[1];
      const target: [number, number] =
        dx0 !== 0 ? [u.pos[0] + Math.sign(dx0), u.pos[1]] : [u.pos[0], u.pos[1] + Math.sign(dy0)];
      acts.push({ unitId: u.id, action: "move", target });
    }
  }
  return acts;
};

describe("stalemate detection does not affect decisive matches", () => {
  it("a fight to elimination still ends by elimination", () => {
    const out = runMatch({ decideA: rusher, decideB: idleArmy(1), seed: 7, matchId: "test_decisive" });
    expect(out.events.some((e) => e.includes("elimination"))).toBe(true);
    expect(out.winner).toBe("A");
  });
});

// A monster grazed by a mage's splash or a spear's pierce must wake up and hunt,
// not soak the collateral for free — otherwise AoE armies farm the neutral band
// with zero risk. This army buys mages + spears and converges on the center
// (cols 4-11), where monsters spawn, so its splash/pierce keeps grazing them.
const centerFighter: DecideFn = (ctx: DecideCtx): Action[] => {
  const COST: Record<string, number> = { mage: 4, spear: 3 };
  const RANGE: Record<string, number> = { knight: 1, spear: 2, archer: 3, mage: 3, priest: 2, engineer: 1 };
  const acts: Action[] = [];
  if (ctx.turn <= BUY_TURNS) {
    let money = ctx.myMoney;
    let i = ctx.myUnits.length;
    while (money >= 3) {
      const t = i % 2 ? "spear" : "mage";
      if (COST[t]! > money) break;
      acts.push({ action: "buy", unitType: t });
      money -= COST[t]!;
      i++;
    }
  }
  for (const u of ctx.myUnits) {
    let tgt: { id: string } | null = null;
    let bd = Infinity;
    for (const e of ctx.enemyUnits) {
      const d = Math.abs(u.pos[0] - e.pos[0]) + Math.abs(u.pos[1] - e.pos[1]);
      if (d <= (RANGE[u.type] ?? 1) && d < bd) { bd = d; tgt = e; }
    }
    if (tgt) { acts.push({ unitId: u.id, action: "attack", targetUnitId: tgt.id }); continue; }
    const dx = Math.sign(8 - u.pos[0]), dy = Math.sign(6 - u.pos[1]);
    if (dx === 0 && dy === 0) continue;
    const target: [number, number] = Math.abs(8 - u.pos[0]) >= Math.abs(6 - u.pos[1])
      ? [u.pos[0] + dx, u.pos[1]] : [u.pos[0], u.pos[1] + dy];
    acts.push({ unitId: u.id, action: "move", target });
  }
  return acts;
};

describe("monsters enrage on collateral damage, not just direct hits", () => {
  it("a monster grazed by splash/pierce wakes up (or dies) instead of soaking it for free", () => {
    let totalCollateral = 0;
    let soakedForFree = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const out = runMatch({ decideA: centerFighter, decideB: centerFighter, seed, matchId: `mon_${seed}` });
      const collateral = new Set<string>(); // monsters hit by splash/pierce
      const wokeOrDied = new Set<string>(); // monsters that enraged or were slain
      for (const e of out.events) {
        if (e.includes("splash hit")) for (const m of e.matchAll(/(monster_\d+)\(/g)) collateral.add(m[1]!);
        const pm = e.match(/pierce hit (monster_\d+)/); if (pm) collateral.add(pm[1]!);
        const mm = e.match(/\[mon\] (monster_\d+) (?:enraged|slain)/); if (mm) wokeOrDied.add(mm[1]!);
      }
      totalCollateral += collateral.size;
      for (const id of collateral) if (!wokeOrDied.has(id)) soakedForFree++;
    }
    // The scenario must actually exercise collateral hits, and none may be free.
    expect(totalCollateral).toBeGreaterThan(0);
    expect(soakedForFree).toBe(0);
  });
});

describe("coin flip + alternating turns", () => {
  it("flips for turn order and compensates the second mover with bonus gold", () => {
    const seen: Record<string, { isFirst: boolean; money: number }> = {};
    const probe = (label: "A" | "B"): DecideFn => (ctx: DecideCtx): Action[] => {
      if (ctx.turn === 1) seen[label] = { isFirst: ctx.isFirstMover, money: ctx.myMoney };
      return [];
    };
    const out = runMatch({ decideA: probe("A"), decideB: probe("B"), seed: 12345, matchId: "test_coin" });

    // Exactly one coin event is emitted.
    expect(out.events.filter((e) => e.startsWith("[COIN]")).length).toBe(1);
    // Exactly one side moves first.
    expect(seen.A!.isFirst).not.toBe(seen.B!.isFirst);

    // Turn-1 money = starting + one income tick, plus the bonus for the second mover.
    const base = STARTING_MONEY + MONEY_INCOME_PER_TURN;
    const firstLabel = seen.A!.isFirst ? "A" : "B";
    const secondLabel = seen.A!.isFirst ? "B" : "A";
    expect(seen[firstLabel]!.money).toBe(base);
    expect(seen[secondLabel]!.money).toBe(base + SECOND_MOVER_BONUS);
  });

  it("lets the second mover react to the first mover's move within the same round", () => {
    // The first mover steps its archer one cell each round; the second mover must
    // observe that post-move position (not the round-start position) when it acts.
    const movedTo: Record<number, [number, number]> = {};
    let comparisons = 0;
    let mismatch = false;
    const probe = (ctx: DecideCtx): Action[] => {
      if (ctx.turn === 1 && ctx.myUnits.length === 0) return [{ action: "buy", unitType: "archer" }];
      if (ctx.myUnits.length === 0) return [];
      if (ctx.isFirstMover) {
        const u = ctx.myUnits[0]!;
        const dx = u.pos[0] < 8 ? 1 : -1;
        const tgt: [number, number] = [u.pos[0] + dx, u.pos[1]];
        movedTo[ctx.turn] = tgt;
        return [{ unitId: u.id, action: "move", target: tgt }];
      }
      const e = ctx.enemyUnits[0];
      const expected = movedTo[ctx.turn];
      if (e && expected) {
        comparisons++;
        if (e.pos[0] !== expected[0] || e.pos[1] !== expected[1]) mismatch = true;
      }
      return [];
    };
    // Disable monsters: they can wander onto the archer's path and block its
    // move, which is unrelated to the turn-order reactivity under test here.
    runMatch({ decideA: probe, decideB: probe, seed: 12345, matchId: "test_react", monsters: false });
    expect(comparisons).toBeGreaterThan(0);
    expect(mismatch).toBe(false);
  });
});
