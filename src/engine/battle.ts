import {
  UNITS,
  BOARD_WIDTH,
  BOARD_HEIGHT,
  MAX_TURNS,
  BUY_TURNS,
  AP_PER_TURN,
  STARTING_MONEY,
  MONEY_INCOME_PER_TURN,
  FIREBALL_DAMAGE,
  FIREBALL_AOE_RADIUS,
  HEAL_AMOUNT,
} from "./units.js";
import { makeRng } from "./rng.js";
import type {
  Action,
  ArmyEntry,
  DecideCtx,
  DecideFn,
  MatchOutput,
  PhaseSnapshot,
  Position,
  PublicUnit,
  Side,
  TurnRecord,
  TurnSnapshot,
  Unit,
  UnitSnapshot,
  UnitType,
} from "./types.js";

export interface RunMatchOptions {
  decideA: DecideFn;
  decideB: DecideFn;
  seed: number;
  matchId: string;
}

interface ValidatedAction {
  unit: Unit;
  apCost: number;
  raw: Action;
}

interface ValidatedBuy {
  unitType: UnitType;
  cost: number;
  side: Side;
}

export function runMatch(opts: RunMatchOptions): MatchOutput {
  const rng = makeRng(opts.seed);
  // Both sides start empty and buy their army with money during the buy window.
  const units: Unit[] = [];

  // Track unit ID sequence counters per side for purchases
  const seqCounters: Record<Side, Record<UnitType, number>> = {
    A: { knight: 0, spear: 0, archer: 0, mage: 0, priest: 0 },
    B: { knight: 0, spear: 0, archer: 0, mage: 0, priest: 0 },
  };

  const allEvents: string[] = [];
  const turns: TurnRecord[] = [];
  const turnSnapshots: TurnSnapshot[] = [];
  let totalDamageDealtA = 0;
  let totalDamageDealtB = 0;
  let aLost = 0;
  let bLost = 0;
  let decisiveTurn = 0;
  let maxDamageInTurn = 0;
  let decisiveEvent = "no decisive event";

  let winner: Side | "draw" | null = null;
  let turnIdx = 0;

  let moneyA = STARTING_MONEY;
  let moneyB = STARTING_MONEY;

  for (turnIdx = 1; turnIdx <= MAX_TURNS; turnIdx++) {
    tickCooldowns(units);
    clearDefending(units);

    const startSnapshot = snapshotUnits(units);
    const phases: PhaseSnapshot[] = [];

    const aliveA = units.filter((u) => u.side === "A" && u.hp > 0);
    const aliveB = units.filter((u) => u.side === "B" && u.hp > 0);

    if (turnIdx <= BUY_TURNS) {
      moneyA += MONEY_INCOME_PER_TURN;
      moneyB += MONEY_INCOME_PER_TURN;
    }
    const moneyAvailA = turnIdx <= BUY_TURNS ? moneyA : 0;
    const moneyAvailB = turnIdx <= BUY_TURNS ? moneyB : 0;

    const ctxA = buildCtx(aliveA, aliveB, armyEntries(units, "A"), armyEntries(units, "B"), turnIdx, turns, opts.seed, "A", moneyAvailA);
    const ctxB = buildCtx(aliveB, aliveA, armyEntries(units, "B"), armyEntries(units, "A"), turnIdx, turns, opts.seed, "B", moneyAvailB);

    const rawA = safeDecide(opts.decideA, ctxA);
    const rawB = safeDecide(opts.decideB, ctxB);

    const { combat: actsA, buys: buyA } = validateAndSplit(rawA, units, "A", moneyAvailA);
    const { combat: actsB, buys: buyB } = validateAndSplit(rawB, units, "B", moneyAvailB);

    const spentA = buyA.reduce((s, r) => s + r.cost, 0);
    const spentB = buyB.reduce((s, r) => s + r.cost, 0);
    moneyA -= spentA;
    moneyB -= spentB;

    const turnEvents: string[] = [];
    const turnEventsHeader = `[T${turnIdx}] -- turn start --`;
    turnEvents.push(turnEventsHeader);

    applyDefendIntents([...actsA, ...actsB], turnEvents);
    phases.push({ phase: "defend", units: snapshotUnits(units) });

    phaseMovement([...actsA, ...actsB], units, turnEvents);
    phases.push({ phase: "move", units: snapshotUnits(units) });

    const dmgFromA = phaseAttack(actsA, units, turnEvents);
    const dmgFromB = phaseAttack(actsB, units, turnEvents);
    totalDamageDealtA += dmgFromA;
    totalDamageDealtB += dmgFromB;
    phases.push({ phase: "attack", units: snapshotUnits(units) });

    phaseSkill([...actsA, ...actsB], units, turnEvents);
    phases.push({ phase: "skill", units: snapshotUnits(units) });

    const deaths = phaseDeath(units, turnEvents);
    aLost += deaths.aLost;
    bLost += deaths.bLost;
    phases.push({ phase: "death", units: snapshotUnits(units) });

    phaseBuy(buyA, units, seqCounters, rng, turnEvents);
    phaseBuy(buyB, units, seqCounters, rng, turnEvents);
    phases.push({ phase: "buy", units: snapshotUnits(units) });

    const turnDamage = dmgFromA + dmgFromB;
    if (turnDamage > maxDamageInTurn) {
      maxDamageInTurn = turnDamage;
      decisiveTurn = turnIdx;
      decisiveEvent = `T${turnIdx} dealt ${turnDamage} total damage (A→B ${dmgFromA}, B→A ${dmgFromB})`;
    }

    const allActionsA = [...actsA.map((a) => a.raw), ...buyA.map((r) => ({ action: "buy" as const, unitType: r.unitType }))];
    const allActionsB = [...actsB.map((a) => a.raw), ...buyB.map((r) => ({ action: "buy" as const, unitType: r.unitType }))];

    turns.push({
      turn: turnIdx,
      myActions: allActionsA,
      enemyActions: allActionsB,
      events: turnEvents,
    });
    turnSnapshots.push({ turn: turnIdx, start: startSnapshot, phases });
    allEvents.push(...turnEvents);

    const stillAliveA = units.filter((u) => u.side === "A" && u.hp > 0).length;
    const stillAliveB = units.filter((u) => u.side === "B" && u.hp > 0).length;

    // A side isn't "eliminated" before it has fielded anything — otherwise the
    // empty opening (turns before either side can afford a unit) would end the
    // match instantly. Once the buy window closes, an empty roster is a loss.
    const everFieldedA = units.some((u) => u.side === "A");
    const everFieldedB = units.some((u) => u.side === "B");
    const aGone = stillAliveA === 0 && (everFieldedA || turnIdx > BUY_TURNS);
    const bGone = stillAliveB === 0 && (everFieldedB || turnIdx > BUY_TURNS);

    if (aGone && bGone) {
      winner = "draw";
      allEvents.push(`[END] mutual annihilation at turn ${turnIdx}`);
      break;
    } else if (aGone) {
      winner = "B";
      allEvents.push(`[END] B wins by total elimination at turn ${turnIdx}`);
      break;
    } else if (bGone) {
      winner = "A";
      allEvents.push(`[END] A wins by total elimination at turn ${turnIdx}`);
      break;
    }
  }

  if (winner === null) {
    const strengthA = computeRemainingStrength(units, "A");
    const strengthB = computeRemainingStrength(units, "B");
    if (strengthA > strengthB) {
      winner = "A";
      allEvents.push(`[END] A wins on strength after ${MAX_TURNS} turns (${strengthA} vs ${strengthB})`);
    } else if (strengthB > strengthA) {
      winner = "B";
      allEvents.push(`[END] B wins on strength after ${MAX_TURNS} turns (${strengthB} vs ${strengthA})`);
    } else {
      winner = "draw";
      allEvents.push(`[END] draw on equal strength after ${MAX_TURNS} turns (${strengthA})`);
    }
  }

  const remA = units.filter((u) => u.side === "A" && u.hp > 0).length;
  const remB = units.filter((u) => u.side === "B" && u.hp > 0).length;
  const lastTurn = turns[turns.length - 1];
  const playedTurns = lastTurn ? lastTurn.turn : 0;

  return {
    matchId: opts.matchId,
    seed: opts.seed,
    winner,
    totalTurns: playedTurns,
    armyA: armyEntries(units, "A"),
    armyB: armyEntries(units, "B"),
    events: allEvents,
    turns,
    turnSnapshots,
    summary: {
      aUnitsLost: aLost,
      bUnitsLost: bLost,
      totalDamageDealtA,
      totalDamageDealtB,
      decisiveTurn,
      decisiveEvent,
      aUnitsRemaining: remA,
      bUnitsRemaining: remB,
    },
  };
}

function tickCooldowns(units: Unit[]): void {
  for (const u of units) {
    for (const k of Object.keys(u.cooldowns)) {
      if (u.cooldowns[k]! > 0) u.cooldowns[k] = u.cooldowns[k]! - 1;
    }
  }
}

function clearDefending(units: Unit[]): void {
  for (const u of units) u.defending = false;
}

function safeDecide(fn: DecideFn, ctx: DecideCtx): Action[] {
  try {
    const result = fn(ctx);
    if (!Array.isArray(result)) return [];
    return result;
  } catch {
    return [];
  }
}

function validateAndSplit(
  raw: Action[],
  allUnits: Unit[],
  side: Side,
  moneyBudget: number,
): { combat: ValidatedAction[]; buys: ValidatedBuy[] } {
  const combat: ValidatedAction[] = [];
  const buys: ValidatedBuy[] = [];
  const usedUnitIds = new Set<string>();
  let apRemaining = AP_PER_TURN;
  let moneyRemaining = moneyBudget;

  for (const a of raw) {
    if (!a || typeof a !== "object") continue;

    if (a.action === "buy") {
      const unitType = (a as { action: "buy"; unitType: UnitType }).unitType;
      if (!UNITS[unitType]) continue;
      const cost = UNITS[unitType].cost;
      if (cost > moneyRemaining) continue;
      buys.push({ unitType, cost, side });
      moneyRemaining -= cost;
      continue;
    }

    if (typeof a.unitId !== "string") continue;
    if (usedUnitIds.has(a.unitId)) continue;

    const unit = allUnits.find((u) => u.id === a.unitId && u.side === side && u.hp > 0);
    if (!unit) continue;

    const apCost = computeApCost(a, unit);
    if (apCost === null) continue;
    if (apCost > apRemaining) continue;

    combat.push({ unit, apCost, raw: a });
    usedUnitIds.add(a.unitId);
    apRemaining -= apCost;
  }
  return { combat, buys };
}

function computeApCost(action: Action, unit: Unit): number | null {
  switch (action.action) {
    case "move":
      return UNITS[unit.type].actionAP;
    case "attack":
      return 0;
    case "skill": {
      // Skills are free; still require a valid skill name (cooldown is enforced
      // later in the skill phase).
      const def = UNITS[unit.type].skills.find((s) => s.name === action.skill);
      return def ? 0 : null;
    }
    case "defend":
      return 0;
    default:
      return null;
  }
}

function applyDefendIntents(actions: ValidatedAction[], events: string[]): void {
  for (const va of actions) {
    if (va.raw.action === "defend") {
      va.unit.defending = true;
      events.push(`[def] ${va.unit.id} defends`);
    }
  }
}

function phaseMovement(actions: ValidatedAction[], allUnits: Unit[], events: string[]): void {
  const moveActions = actions
    .filter((va) => va.raw.action === "move")
    .sort((a, b) => UNITS[b.unit.type].initiative - UNITS[a.unit.type].initiative);

  for (const va of moveActions) {
    if (va.raw.action !== "move") continue;
    const target = va.raw.target;
    const unit = va.unit;

    if (!inBounds(target)) {
      events.push(`[mov] ${unit.id} move failed: out of bounds [${target}]`);
      continue;
    }
    const dist = manhattan(unit.pos, target);
    if (dist === 0 || dist > UNITS[unit.type].moveRange) {
      events.push(`[mov] ${unit.id} move failed: target [${target}] out of range`);
      continue;
    }
    const occupant = allUnits.find((u) => u.hp > 0 && samePos(u.pos, target) && u.id !== unit.id);
    if (occupant) {
      events.push(`[mov] ${unit.id} move failed: cell occupied by ${occupant.id}`);
      continue;
    }
    events.push(`[mov] ${unit.id} moved [${unit.pos[0]},${unit.pos[1]}]→[${target[0]},${target[1]}]`);
    unit.pos = [target[0], target[1]];
  }
}

function phaseAttack(actions: ValidatedAction[], allUnits: Unit[], events: string[]): number {
  let totalDamage = 0;
  const attackActions = actions
    .filter((va) => va.raw.action === "attack")
    .sort((a, b) => UNITS[b.unit.type].initiative - UNITS[a.unit.type].initiative);

  for (const va of attackActions) {
    const raw = va.raw;
    if (raw.action !== "attack") continue;
    const attacker = va.unit;
    const targetId = raw.targetUnitId;
    const target = allUnits.find((u) => u.id === targetId);
    if (!target || target.hp <= 0) {
      events.push(`[atk] ${attacker.id} attack failed: target ${targetId} not found`);
      continue;
    }
    if (target.side === attacker.side) {
      events.push(`[atk] ${attacker.id} attack failed: cannot attack ally ${target.id}`);
      continue;
    }
    const dist = manhattan(attacker.pos, target.pos);
    if (dist > UNITS[attacker.type].range) {
      events.push(`[atk] ${attacker.id} attack failed: target ${target.id} out of range (d=${dist})`);
      continue;
    }

    const baseDmg = UNITS[attacker.type].atk;
    const dealt = applyDamage(target, baseDmg);
    totalDamage += dealt;
    events.push(`[atk] ${attacker.id} attacked ${target.id} for ${dealt} dmg (hp ${target.hp}/${target.maxHp})`);

    if (UNITS[attacker.type].special === "pierce_one") {
      const dx = Math.sign(target.pos[0] - attacker.pos[0]);
      const dy = Math.sign(target.pos[1] - attacker.pos[1]);
      const behind: Position = [target.pos[0] + dx, target.pos[1] + dy];
      if (inBounds(behind)) {
        const pierceTarget = allUnits.find((u) => u.hp > 0 && samePos(u.pos, behind) && u.id !== attacker.id);
        if (pierceTarget) {
          const pierceDmg = applyDamage(pierceTarget, Math.floor(baseDmg / 2));
          totalDamage += pierceDmg;
          events.push(`[atk] ${attacker.id} pierce hit ${pierceTarget.id} for ${pierceDmg} dmg`);
        }
      }
    }
  }
  return totalDamage;
}

function phaseSkill(actions: ValidatedAction[], allUnits: Unit[], events: string[]): void {
  const skillActions = actions
    .filter((va) => va.raw.action === "skill")
    .sort((a, b) => UNITS[b.unit.type].initiative - UNITS[a.unit.type].initiative);

  for (const va of skillActions) {
    const raw = va.raw;
    if (raw.action !== "skill") continue;
    const caster = va.unit;
    const skillName = raw.skill;
    const def = UNITS[caster.type].skills.find((s) => s.name === skillName);
    if (!def) {
      events.push(`[skl] ${caster.id} skill failed: ${skillName} unknown`);
      continue;
    }
    if ((caster.cooldowns[def.name] ?? 0) > 0) {
      events.push(`[skl] ${caster.id} skill failed: ${def.name} on cooldown (${caster.cooldowns[def.name]})`);
      continue;
    }

    if (def.name === "fireball") {
      const target = raw.target as Position;
      if (!Array.isArray(target) || !inBounds(target)) {
        events.push(`[skl] ${caster.id} fireball failed: invalid target`);
        continue;
      }
      const distFromCaster = manhattan(caster.pos, target);
      if (distFromCaster > UNITS[caster.type].range) {
        events.push(`[skl] ${caster.id} fireball failed: target [${target}] out of range`);
        continue;
      }
      const hits: string[] = [];
      for (const u of allUnits) {
        if (u.hp <= 0) continue;
        const d = chebyshev(u.pos, target);
        if (d <= FIREBALL_AOE_RADIUS) {
          const dealt = applyDamage(u, FIREBALL_DAMAGE);
          hits.push(`${u.id}(${dealt})`);
        }
      }
      caster.cooldowns[def.name] = def.cooldown;
      events.push(`[skl] ${caster.id} cast fireball at [${target[0]},${target[1]}] → ${hits.join(", ") || "no hits"}`);
    } else if (def.name === "heal") {
      const targetId = raw.target as string;
      const ally = allUnits.find((u) => u.id === targetId && u.side === caster.side && u.hp > 0);
      if (!ally) {
        events.push(`[skl] ${caster.id} heal failed: target ${targetId} invalid`);
        continue;
      }
      const dist = manhattan(caster.pos, ally.pos);
      if (dist > UNITS[caster.type].range) {
        events.push(`[skl] ${caster.id} heal failed: target ${ally.id} out of range`);
        continue;
      }
      const before = ally.hp;
      ally.hp = Math.min(ally.maxHp, ally.hp + HEAL_AMOUNT);
      caster.cooldowns[def.name] = def.cooldown;
      events.push(`[skl] ${caster.id} healed ${ally.id} +${ally.hp - before} (hp ${ally.hp}/${ally.maxHp})`);
    }
  }
}

function phaseDeath(units: Unit[], events: string[]): { aLost: number; bLost: number } {
  let aLost = 0;
  let bLost = 0;
  for (const u of units) {
    if (u.hp <= 0 && !u.cooldowns.__dead__) {
      u.cooldowns.__dead__ = 999;
      events.push(`[die] ${u.id} died (side ${u.side})`);
      if (u.side === "A") aLost++;
      else bLost++;
    }
  }
  return { aLost, bLost };
}

function phaseBuy(
  buys: ValidatedBuy[],
  allUnits: Unit[],
  seqCounters: Record<Side, Record<UnitType, number>>,
  rng: ReturnType<typeof makeRng>,
  events: string[],
): void {
  for (const r of buys) {
    const def = UNITS[r.unitType];
    const side = r.side;
    seqCounters[side][r.unitType]++;
    const id = `${r.unitType}_${side}${seqCounters[side][r.unitType]}`;

    const cols = side === "A" ? [0, 1, 2, 3] : [BOARD_WIDTH - 4, BOARD_WIDTH - 3, BOARD_WIDTH - 2, BOARD_WIDTH - 1];
    const emptyCells: Position[] = [];
    for (const c of cols) {
      for (let row = 0; row < BOARD_HEIGHT; row++) {
        const pos: Position = [c, row];
        if (!allUnits.some((u) => u.hp > 0 && samePos(u.pos, pos))) {
          emptyCells.push(pos);
        }
      }
    }

    if (emptyCells.length === 0) {
      events.push(`[buy] ${side} buy ${r.unitType} failed: no space in spawn zone`);
      continue;
    }

    const idx = Math.floor(rng() * emptyCells.length);
    const pos = emptyCells[idx]!;

    const unit: Unit = {
      id,
      type: r.unitType,
      side,
      pos,
      hp: def.hp,
      maxHp: def.hp,
      cooldowns: {},
      defending: false,
    };
    allUnits.push(unit);
    events.push(`[buy] ${side} bought ${id} at [${pos[0]},${pos[1]}]`);
  }
}

function applyDamage(target: Unit, rawDmg: number): number {
  let dmg = rawDmg;
  if (UNITS[target.type].special === "damage_reduction_half") dmg = Math.floor(dmg / 2);
  if (target.defending) dmg = Math.floor(dmg / 2);
  target.hp -= dmg;
  return dmg;
}

function computeRemainingStrength(units: Unit[], side: Side): number {
    return units
    .filter((u) => u.side === side && u.hp > 0)
    .reduce((sum, u) => sum + UNITS[u.type].cost, 0);
}

function buildCtx(
  myUnits: Unit[],
  enemyUnits: Unit[],
  myArmy: ArmyEntry[],
  enemyArmy: ArmyEntry[],
  turn: number,
  history: TurnRecord[],
  seed: number,
  side: Side,
  money: number,
): DecideCtx {
  const sideRng = makeRng(seed ^ (turn * 0x9e3779b1) ^ (side === "A" ? 1 : 2));
  return {
    myUnits: myUnits.map(toPublic),
    enemyUnits: enemyUnits.map(toPublic),
    myArmy,
    enemyArmy,
    myAP: AP_PER_TURN,
    myMoney: money,
    turn,
    history,
    rng: sideRng,
  };
}

// Composition of every unit a side has fielded so far (dead units stay in the
// array, so this reflects the cumulative roster, not just survivors).
function armyEntries(units: Unit[], side: Side): ArmyEntry[] {
  const counts = new Map<UnitType, number>();
  for (const u of units) {
    if (u.side !== side) continue;
    counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([type, count]) => ({ type, count }));
}

function toPublic(u: Unit): PublicUnit {
  const cooldowns: Record<string, number> = {};
  for (const [k, v] of Object.entries(u.cooldowns)) {
    if (!k.startsWith("__")) cooldowns[k] = v;
  }
  return {
    id: u.id,
    type: u.type,
    pos: [u.pos[0], u.pos[1]],
    hp: u.hp,
    maxHp: u.maxHp,
    cooldowns,
  };
}

function snapshotUnits(units: Unit[]): UnitSnapshot[] {
    return units.map((u) => ({
    id: u.id,
    type: u.type,
    side: u.side,
    pos: [u.pos[0], u.pos[1]] as Position,
    hp: u.hp,
    maxHp: u.maxHp,
    defending: u.defending,
    cooldowns: { ...u.cooldowns },
  }));
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function chebyshev(a: Position, b: Position): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

function samePos(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function inBounds(p: Position): boolean {
  return p[0] >= 0 && p[0] < BOARD_WIDTH && p[1] >= 0 && p[1] < BOARD_HEIGHT;
}
