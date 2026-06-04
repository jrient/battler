/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
// Battle excitement scoring.
//
// Turns a finished match into a single 0..100 "how exciting was this fight"
// score, used to rank the Exciting-Battles board. The score is derived purely
// from match data we already store (per-turn snapshots, the event log, and the
// summary), so it can be computed at index time and back-filled for old matches.
//
// Five positive factors plus a multiplicative penalty (anti gaming):
//   - comeback  (35): lead changes + the biggest deficit the eventual winner overcame
//   - closeness (25): how tight the final result and the whole strength curve were
//   - suspense  (20): how late the decisive moment landed
//   - intensity (15): damage + casualty density (not a passive shuffle)
//   - scale      (5): how many units were actually in the fight
//   - penalty (×):    stomps / grindy stalemates / zombie matches get scaled down
import type { TurnSnapshot, UnitSnapshot } from "./types.js";
import { UNITS } from "./units.js";

// Mirrors the A-side AgentJson shape (see engine/replay.ts) — structurally typed
// so the full agentJsonForA can be passed straight in.
export interface ExcitementInput {
  result: "win" | "loss" | "draw";
  turnSnapshots: TurnSnapshot[];
  events: string[];
  summary: {
    myUnitsLost: number;
    enemyUnitsLost: number;
    totalDamageDealt: number;
    totalDamageTaken: number;
    decisiveTurn: number;
    totalTurns: number;
    myUnitsRemaining: number;
    enemyUnitsRemaining: number;
  };
}

export interface ExcitementBreakdown {
  comeback: number; // 0..1
  closeness: number; // 0..1
  suspense: number; // 0..1
  intensity: number; // 0..1
  scale: number; // 0..1
  penalty: number; // 0..1 multiplier
}

export interface ExcitementResult {
  score: number; // 0..100 integer
  breakdown: ExcitementBreakdown;
}

const WEIGHTS = { comeback: 35, closeness: 25, suspense: 20, intensity: 15, scale: 5 };

// Tunables — kept named so they're easy to rebalance after watching real games.
const LEAD_DEADBAND = 0.05; // |Δstrength| under 5% of the total counts as a tie
const DEFICIT_FULL = 0.5; // a winner who was 50%+ behind gets full comeback credit
const DMG_DENSITY_FULL = 10; // dmg per unit per turn that maxes the intensity term
const DEATH_DENSITY_FULL = 1; // casualties per turn that maxes the death term
const FULL_ROSTER = 20; // combined peak roster that reads as a full-scale clash
const PENALTY_FLOOR = 0.2; // never zero a match out entirely

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function unitValue(type: string): number {
  const def = (UNITS as Record<string, { cost: number } | undefined>)[type];
  return def ? def.cost : 0;
}

// A side's fighting strength = sum of living units' gold value, scaled by how
// much HP each still has. Neutral monsters (side "N") are excluded.
function sideStrength(units: UnitSnapshot[], side: "A" | "B"): number {
  let total = 0;
  for (const u of units) {
    if (u.side !== side || u.hp <= 0) continue;
    const hpFrac = u.maxHp > 0 ? u.hp / u.maxHp : 0;
    total += unitValue(u.type) * hpFrac;
  }
  return total;
}

function countPlayerUnits(units: UnitSnapshot[]): number {
  let n = 0;
  for (const u of units) if (u.side === "A" || u.side === "B") n++;
  return n;
}

export function computeExcitement(input: ExcitementInput): ExcitementResult {
  const snaps: TurnSnapshot[] = input.turnSnapshots ?? [];
  const s = input.summary;
  const winner: "A" | "B" | "draw" =
    input.result === "win" ? "A" : input.result === "loss" ? "B" : "draw";

  // Per-turn strength curves for both sides (from each turn's starting board).
  // Units are bought over the opening turns, so the rosters grow before they
  // shrink — track the PEAK combined roster as the fight's true scale rather
  // than turn 1 (which is just neutral monsters before anyone has bought in).
  const curveA: number[] = [];
  const curveB: number[] = [];
  let peakUnits = 0;
  for (const sn of snaps) {
    curveA.push(sideStrength(sn.start, "A"));
    curveB.push(sideStrength(sn.start, "B"));
    const n = countPlayerUnits(sn.start);
    if (n > peakUnits) peakUnits = n;
  }

  // ----- comeback: lead changes + worst deficit the winner clawed back -----
  let flips = 0;
  let prevLeader = 0; // +1 A ahead, -1 B ahead, 0 tie
  let maxWinnerDeficit = 0;
  for (let i = 0; i < curveA.length; i++) {
    const a = curveA[i]!;
    const b = curveB[i]!;
    const total = a + b;
    const dead = total * LEAD_DEADBAND;
    const diff = a - b;
    const leader = diff > dead ? 1 : diff < -dead ? -1 : 0;
    if (leader !== 0) {
      if (prevLeader !== 0 && leader !== prevLeader) flips++;
      prevLeader = leader;
    }
    if (winner !== "draw" && total > 0) {
      const w = winner === "A" ? a : b;
      const l = winner === "A" ? b : a;
      const deficit = (l - w) / total; // >0 while the eventual winner trails
      if (deficit > maxWinnerDeficit) maxWinnerDeficit = deficit;
    }
  }
  const flipsComp = flips <= 0 ? 0 : flips === 1 ? 0.7 : 1;
  const deficitComp = clamp01(maxWinnerDeficit / DEFICIT_FULL);
  const comeback = clamp01(0.6 * flipsComp + 0.6 * deficitComp);

  // ----- closeness: tight final result + tight strength curve throughout -----
  const aRem = s.myUnitsRemaining ?? 0;
  const bRem = s.enemyUnitsRemaining ?? 0;
  const rosterScale = Math.max(1, peakUnits, aRem + bRem);
  // Final-result tightness, scaled to the rosters involved: a 2-unit gap means
  // something very different in a 4-unit fight than in a 20-unit one.
  const closeSpread = Math.max(4, rosterScale * 0.5);
  const closenessFinal = 1 - clamp01(Math.abs(aRem - bRem) / closeSpread);
  let gapSum = 0;
  let gapN = 0;
  for (let i = 0; i < curveA.length; i++) {
    const total = curveA[i]! + curveB[i]!;
    if (total <= 0) continue;
    gapSum += Math.abs(curveA[i]! - curveB[i]!) / total;
    gapN++;
  }
  const avgGap = gapN > 0 ? gapSum / gapN : 1;
  const closenessCurve = 1 - clamp01(avgGap);
  const closeness = 0.5 * closenessFinal + 0.5 * closenessCurve;

  // ----- suspense: the later the game was decided, the longer it stayed live --
  const totalTurns = Math.max(1, s.totalTurns || snaps.length || 1);
  const decisive = s.decisiveTurn > 0 ? s.decisiveTurn : totalTurns;
  const suspense = clamp01(decisive / totalTurns);

  // ----- intensity: damage + casualty density (filters out passive shuffles) --
  const totalDamage = (s.totalDamageDealt ?? 0) + (s.totalDamageTaken ?? 0);
  const dmgDensity = totalDamage / (totalTurns * rosterScale);
  const dmgComp = clamp01(dmgDensity / DMG_DENSITY_FULL);
  let deaths = 0;
  for (const ev of input.events) if (ev.includes("[die]")) deaths++;
  const deathComp = clamp01(deaths / totalTurns / DEATH_DENSITY_FULL);
  const intensity = clamp01(0.7 * dmgComp + 0.3 * deathComp);

  // ----- scale: a full-roster clash reads bigger than a few-unit skirmish -----
  const scale = clamp01(peakUnits / FULL_ROSTER);

  // ----- penalty: scale down stomps, grindy stalemates, zombie matches --------
  let penalty = 1;
  const winnerLost =
    winner === "A" ? s.myUnitsLost : winner === "B" ? s.enemyUnitsLost : Math.min(s.myUnitsLost, s.enemyUnitsLost);
  const winnerRem = winner === "A" ? aRem : bRem;
  const loserRem = winner === "A" ? bRem : aRem;
  if (winner !== "draw" && winnerLost <= 1 && winnerRem - loserRem >= 4) {
    penalty *= 0.4; // clean blowout: winner barely scratched, opponent erased
  }
  const totalLost = (s.myUnitsLost ?? 0) + (s.enemyUnitsLost ?? 0);
  if (totalTurns >= 20 && totalLost <= 2) {
    penalty *= 0.4; // dragged on but almost nobody died — a passive/zombie match
  }
  penalty = Math.max(PENALTY_FLOOR, penalty);

  const base =
    WEIGHTS.comeback * comeback +
    WEIGHTS.closeness * closeness +
    WEIGHTS.suspense * suspense +
    WEIGHTS.intensity * intensity +
    WEIGHTS.scale * scale;
  const score = Math.round(Math.max(0, Math.min(100, base * penalty)));

  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    score,
    breakdown: {
      comeback: r3(comeback),
      closeness: r3(closeness),
      suspense: r3(suspense),
      intensity: r3(intensity),
      scale: r3(scale),
      penalty: r3(penalty),
    },
  };
}
