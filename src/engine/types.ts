export type UnitType = "knight" | "spear" | "archer" | "mage" | "priest" | "engineer";
export type Position = [number, number];
export type Side = "A" | "B";
// A unit's allegiance. "A"/"B" are the two players; "N" is a neutral monster
// (third faction) that belongs to neither side and never counts toward victory.
export type Faction = Side | "N";
// Anything that can stand on the board. UnitType stays the set of *buyable*
// units; "monster" is the neutral creature, which is never purchasable.
export type EntityType = UnitType | "monster";

export interface UnitDef {
  type: UnitType;
  hp: number;
  atk: number;
  range: number;
  moveRange: number;
  actionAP: number;
  cost: number;
  initiative: number;
  special: UnitSpecial;
}

export type UnitSpecial =
  | "damage_reduction_half"
  | "pierce_one"
  | "splash"
  | "heal_ally"
  | null;

export interface Unit {
  id: string;
  type: EntityType;
  side: Faction;
  pos: Position;
  hp: number;
  maxHp: number;
  cooldowns: Record<string, number>;
  defending: boolean;
  // Neutral monsters only: the id of the unit this monster is hunting (the first
  // unit to attack it or step adjacent). Cleared when that target dies, after
  // which the monster goes back to passive random wandering.
  aggroTargetId?: string | null;
}

export interface PublicUnit {
  id: string;
  type: EntityType;
  pos: Position;
  hp: number;
  maxHp: number;
  cooldowns: Record<string, number>;
}

export interface ArmyEntry {
  type: UnitType;
  count: number;
}

export type Action =
  | { unitId: string; action: "move"; target: Position }
  | { unitId: string; action: "attack"; targetUnitId: string }
  | { unitId: string; action: "defend" }
  | { action: "buy"; unitType: UnitType };

export interface DecideCtx {
  myUnits: PublicUnit[];
  enemyUnits: PublicUnit[];
  // Neutral monsters currently alive on the board (third faction, side "N").
  // They are not your opponent — killing them does NOT win the match — but they
  // can be attacked, block cells, and will hunt whoever first attacks or steps
  // adjacent to them. Empty if the board has no monsters.
  neutralUnits: PublicUnit[];
  myArmy: ArmyEntry[];
  enemyArmy: ArmyEntry[];
  myAP: number;
  myMoney: number;
  turn: number;
  history: TurnRecord[];
  rng: () => number;
  // True if you are the coin-flip winner who moves first every round. The first
  // mover decides on the round-start board; the second mover decides AFTER the
  // first mover has already moved/attacked, so its myUnits/enemyUnits reflect
  // those actions. The second mover's myMoney already includes the +10 bonus.
  isFirstMover: boolean;
}

export interface TurnRecord {
  turn: number;
  myActions: Action[];
  enemyActions: Action[];
  events: string[];
}

export type DecideFn = (ctx: DecideCtx) => Action[];

export interface MatchOutput {
  matchId: string;
  seed: number;
  // Coin-flip winner who moves first every round (see DecideCtx.isFirstMover).
  firstSide: Side;
  winner: Side | "draw";
  totalTurns: number;
  armyA: ArmyEntry[];
  armyB: ArmyEntry[];
  events: string[];
  turns: TurnRecord[];
  turnSnapshots: TurnSnapshot[];
  summary: MatchSummary;
}

export interface UnitSnapshot {
  id: string;
  type: EntityType;
  side: Faction;
  pos: Position;
  hp: number;
  maxHp: number;
  defending: boolean;
  cooldowns: Record<string, number>;
}

export interface PhaseSnapshot {
  phase: "defend" | "move" | "attack" | "death" | "buy" | "monster";
  units: UnitSnapshot[];
}

export interface TurnSnapshot {
  turn: number;
  start: UnitSnapshot[];
  phases: PhaseSnapshot[];
}

export interface MatchSummary {
  aUnitsLost: number;
  bUnitsLost: number;
  totalDamageDealtA: number;
  totalDamageDealtB: number;
  decisiveTurn: number;
  decisiveEvent: string;
  aUnitsRemaining: number;
  bUnitsRemaining: number;
}
