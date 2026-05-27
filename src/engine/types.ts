export type UnitType = "knight" | "spear" | "archer" | "mage" | "priest";
export type Position = [number, number];
export type Side = "A" | "B";

export interface UnitDef {
  type: UnitType;
  hp: number;
  atk: number;
  range: number;
  moveRange: number;
  actionAP: number;
  cost: number;
  recruitAP: number;
  initiative: number;
  special: UnitSpecial;
  skills: SkillDef[];
}

export type UnitSpecial =
  | "damage_reduction_half"
  | "pierce_one"
  | null;

export interface SkillDef {
  name: string;
  apCost: number;
  cooldown: number;
  description: string;
}

export interface Unit {
  id: string;
  type: UnitType;
  side: Side;
  pos: Position;
  hp: number;
  maxHp: number;
  cooldowns: Record<string, number>;
  defending: boolean;
}

export interface PublicUnit {
  id: string;
  type: UnitType;
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
  | { unitId: string; action: "skill"; skill: string; target: Position | string }
  | { unitId: string; action: "defend" }
  | { action: "recruit"; unitType: UnitType };

export interface DecideCtx {
  myUnits: PublicUnit[];
  enemyUnits: PublicUnit[];
  myArmy: ArmyEntry[];
  enemyArmy: ArmyEntry[];
  myAP: number;
  myRecruitAP: number;
  turn: number;
  history: TurnRecord[];
  rng: () => number;
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
  type: UnitType;
  side: Side;
  pos: Position;
  hp: number;
  maxHp: number;
  defending: boolean;
  cooldowns: Record<string, number>;
}

export interface PhaseSnapshot {
  phase: "defend" | "move" | "attack" | "skill" | "death" | "recruit";
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
