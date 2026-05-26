import { UNITS, ARMY_BUDGET, ARMY_BUDGET_TOLERANCE, BOARD_HEIGHT } from "./units.js";
import { pick, shuffle, type Rng } from "./rng.js";
import type { Unit, UnitType, Side, ArmyEntry, Position } from "./types.js";

export interface DealResult {
  armyA: ArmyEntry[];
  armyB: ArmyEntry[];
  unitsA: Unit[];
  unitsB: Unit[];
}

const UNIT_POOL: readonly UnitType[] = ["knight", "spear", "archer", "mage", "priest"];

export function dealArmies(rng: Rng): DealResult {
  const drawsA = drawArmy(rng);
  const drawsB = drawArmy(rng);
  return {
    armyA: toArmyEntries(drawsA),
    armyB: toArmyEntries(drawsB),
    unitsA: placeUnits(drawsA, "A", rng),
    unitsB: placeUnits(drawsB, "B", rng),
  };
}

function drawArmy(rng: Rng): UnitType[] {
  const draws: UnitType[] = [];
  let budgetUsed = 0;
  const targetMin = ARMY_BUDGET - ARMY_BUDGET_TOLERANCE;
  const targetMax = ARMY_BUDGET + ARMY_BUDGET_TOLERANCE;

  let attempts = 0;
  while (budgetUsed < targetMin && attempts < 50) {
    const type = pick(rng, UNIT_POOL);
    const cost = UNITS[type].cost;
    if (budgetUsed + cost <= targetMax) {
      draws.push(type);
      budgetUsed += cost;
    }
    attempts++;
  }

  const cheapest = UNIT_POOL.reduce((min, t) =>
    UNITS[t].cost < UNITS[min].cost ? t : min,
  );
  while (budgetUsed + UNITS[cheapest].cost <= targetMax && budgetUsed < targetMin) {
    draws.push(cheapest);
    budgetUsed += UNITS[cheapest].cost;
  }

  while (draws.length < 2) draws.push(cheapest);
  return draws;
}

function toArmyEntries(draws: UnitType[]): ArmyEntry[] {
  const counts = new Map<UnitType, number>();
  for (const t of draws) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries()).map(([type, count]) => ({ type, count }));
}

function placeUnits(draws: UnitType[], side: Side, rng: Rng): Unit[] {
  const cols = side === "A" ? [0, 1] : [6, 7];
  const positions: Position[] = [];
  for (const c of cols) {
    for (let r = 0; r < BOARD_HEIGHT; r++) {
      positions.push([c, r]);
    }
  }
  const shuffled = shuffle(rng, positions);

  const seq: Record<UnitType, number> = {
    knight: 0, spear: 0, archer: 0, mage: 0, priest: 0,
  };
  const units: Unit[] = [];

  for (let i = 0; i < draws.length; i++) {
    const type = draws[i]!;
    seq[type]++;
    const pos = shuffled[i] ?? ([cols[0]!, 0] as Position);
    units.push({
      id: `${type}_${side}${seq[type]}`,
      type,
      side,
      pos,
      hp: UNITS[type].hp,
      maxHp: UNITS[type].hp,
      cooldowns: {},
      defending: false,
    });
  }
  return units;
}
