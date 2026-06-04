/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { describe, it, expect } from "vitest";
import { computeExcitement, type ExcitementInput } from "./excitement.js";
import type { TurnSnapshot, UnitSnapshot, Faction } from "./types.js";

// One knight per "strength point block": a knight costs 5, so its strength
// contribution is 5 * hp/maxHp. We model a side's strength curve with a single
// knight whose HP we dial to hit a target strength, plus a unit count we control
// separately for the closeness/scale terms.
function knight(side: Faction, hp: number): UnitSnapshot {
  return { id: `k_${side}_${hp}`, type: "knight", side, pos: [0, 0], hp, maxHp: 100, defending: false, cooldowns: {} };
}

// Build a side's units so that (a) it has `count` living bodies and (b) its
// total strength is roughly `strength`. We spread strength across `count`
// knights of equal HP (or one low-HP knight when strength is tiny).
function sideUnits(side: Faction, count: number, strength: number): UnitSnapshot[] {
  if (count <= 0) return [];
  const perHp = Math.max(1, Math.min(100, Math.round((strength / count / 5) * 100)));
  return Array.from({ length: count }, () => knight(side, perHp));
}

function snap(turn: number, a: UnitSnapshot[], b: UnitSnapshot[]): TurnSnapshot {
  return { turn, start: [...a, ...b], phases: [] };
}

function baseInput(over: Partial<ExcitementInput> = {}): ExcitementInput {
  return {
    result: "win",
    turnSnapshots: [],
    events: [],
    summary: {
      myUnitsLost: 0,
      enemyUnitsLost: 0,
      totalDamageDealt: 0,
      totalDamageTaken: 0,
      decisiveTurn: 0,
      totalTurns: 0,
      myUnitsRemaining: 0,
      enemyUnitsRemaining: 0,
    },
    ...over,
  };
}

// A neck-and-neck fight: strengths track each other the whole way, A edges it
// out 1 unit to 0 at the very end.
function closeMatch(): ExcitementInput {
  const snaps: TurnSnapshot[] = [];
  const T = 12;
  for (let t = 0; t < T; t++) {
    const decay = 1 - t / (T + 2);
    const aS = 24 * decay;
    const bS = 24 * decay * (t < T - 1 ? 0.98 : 0.0); // B collapses on the last turn
    const aCount = t < T - 1 ? Math.max(1, 6 - Math.floor(t / 2)) : 1;
    const bCount = t < T - 1 ? Math.max(1, 6 - Math.floor(t / 2)) : 0;
    snaps.push(snap(t + 1, sideUnits("A", aCount, aS), sideUnits("B", bCount, bS)));
  }
  return baseInput({
    result: "win",
    turnSnapshots: snaps,
    events: Array.from({ length: 11 }, (_, i) => `[T${i + 1}] [die] u_${i} died (side B)`),
    summary: {
      myUnitsLost: 5, enemyUnitsLost: 6,
      totalDamageDealt: 1100, totalDamageTaken: 980,
      decisiveTurn: 11, totalTurns: 12,
      myUnitsRemaining: 1, enemyUnitsRemaining: 0,
    },
  });
}

// B dominates the first half, A claws back and wins — a real comeback.
function comebackMatch(): ExcitementInput {
  const snaps: TurnSnapshot[] = [];
  const T = 14;
  for (let t = 0; t < T; t++) {
    const aAhead = t >= 7;
    const aS = aAhead ? 20 : 8;
    const bS = aAhead ? 6 : 24;
    const aCount = aAhead ? Math.max(3, 6 - Math.floor((t - 7) / 2)) : 5;
    const bCount = aAhead ? Math.max(0, 3 - Math.floor((t - 7) / 2)) : 6;
    snaps.push(snap(t + 1, sideUnits("A", t === T - 1 ? 3 : aCount, aS), sideUnits("B", t === T - 1 ? 0 : bCount, bS)));
  }
  return baseInput({
    result: "win",
    turnSnapshots: snaps,
    events: Array.from({ length: 9 }, (_, i) => `[T${i + 1}] [die] u_${i} died (side ${i % 2 ? "A" : "B"})`),
    summary: {
      myUnitsLost: 3, enemyUnitsLost: 6,
      totalDamageDealt: 900, totalDamageTaken: 820,
      decisiveTurn: 12, totalTurns: 14,
      myUnitsRemaining: 3, enemyUnitsRemaining: 0,
    },
  });
}

// A erases B almost untouched — a lopsided blowout.
function stompMatch(): ExcitementInput {
  const snaps: TurnSnapshot[] = [
    snap(1, sideUnits("A", 6, 24), sideUnits("B", 6, 24)),
    snap(2, sideUnits("A", 6, 23), sideUnits("B", 3, 10)),
    snap(3, sideUnits("A", 6, 22), sideUnits("B", 0, 0)),
  ];
  return baseInput({
    result: "win",
    turnSnapshots: snaps,
    events: ["[T2] [die] x died (side B)", "[T2] [die] y died (side B)", "[T3] [die] z died (side B)"],
    summary: {
      myUnitsLost: 0, enemyUnitsLost: 6,
      totalDamageDealt: 600, totalDamageTaken: 40,
      decisiveTurn: 3, totalTurns: 3,
      myUnitsRemaining: 6, enemyUnitsRemaining: 0,
    },
  });
}

// Two passive armies that never really fight — runs out the 100-turn clock.
function stalemateMatch(): ExcitementInput {
  const snaps: TurnSnapshot[] = [];
  for (let t = 0; t < 100; t++) {
    snaps.push(snap(t + 1, sideUnits("A", 6, 24), sideUnits("B", 6, 24)));
  }
  return baseInput({
    result: "draw",
    turnSnapshots: snaps,
    events: [],
    summary: {
      myUnitsLost: 0, enemyUnitsLost: 0,
      totalDamageDealt: 30, totalDamageTaken: 20,
      decisiveTurn: 100, totalTurns: 100,
      myUnitsRemaining: 6, enemyUnitsRemaining: 6,
    },
  });
}

describe("computeExcitement", () => {
  const close = computeExcitement(closeMatch());
  const comeback = computeExcitement(comebackMatch());
  const stomp = computeExcitement(stompMatch());
  const stalemate = computeExcitement(stalemateMatch());

  it("keeps every score within 0..100", () => {
    for (const r of [close, comeback, stomp, stalemate]) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it("rates a comeback as highly exciting", () => {
    expect(comeback.score).toBeGreaterThan(55);
    expect(comeback.breakdown.comeback).toBeGreaterThan(0.6);
  });

  it("rates a nail-biter as exciting", () => {
    expect(close.score).toBeGreaterThan(50);
  });

  it("rates a blowout as dull and applies the stomp penalty", () => {
    expect(stomp.score).toBeLessThan(35);
    expect(stomp.breakdown.penalty).toBeLessThan(1);
  });

  it("rates a passive stalemate as dull and applies a penalty", () => {
    expect(stalemate.score).toBeLessThan(30);
    expect(stalemate.breakdown.penalty).toBeLessThan(1);
  });

  it("ranks exciting matches above dull ones", () => {
    expect(comeback.score).toBeGreaterThan(stomp.score);
    expect(comeback.score).toBeGreaterThan(stalemate.score);
    expect(close.score).toBeGreaterThan(stomp.score);
    expect(close.score).toBeGreaterThan(stalemate.score);
  });

  it("handles an empty match without throwing", () => {
    const r = computeExcitement(baseInput());
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});
