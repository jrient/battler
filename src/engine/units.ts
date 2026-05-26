import type { UnitDef, UnitType } from "./types.js";

export const BOARD_WIDTH = 8;
export const BOARD_HEIGHT = 6;
export const MAX_TURNS = 10;
export const AP_PER_TURN = 5;
export const ARMY_BUDGET = 100;
export const ARMY_BUDGET_TOLERANCE = 10;

export const UNITS: Record<UnitType, UnitDef> = {
  knight: {
    type: "knight",
    hp: 100,
    atk: 20,
    range: 1,
    moveRange: 3,
    actionAP: 1,
    cost: 30,
    initiative: 3,
    special: "damage_reduction_half",
    skills: [],
  },
  spear: {
    type: "spear",
    hp: 60,
    atk: 25,
    range: 2,
    moveRange: 2,
    actionAP: 1,
    cost: 20,
    initiative: 5,
    special: "pierce_one",
    skills: [],
  },
  archer: {
    type: "archer",
    hp: 40,
    atk: 18,
    range: 4,
    moveRange: 2,
    actionAP: 1,
    cost: 25,
    initiative: 6,
    special: null,
    skills: [],
  },
  mage: {
    type: "mage",
    hp: 35,
    atk: 30,
    range: 3,
    moveRange: 1,
    actionAP: 1,
    cost: 35,
    initiative: 4,
    special: null,
    skills: [
      { name: "fireball", apCost: 3, cooldown: 2, description: "AOE radius 1, damage 25" },
    ],
  },
  priest: {
    type: "priest",
    hp: 50,
    atk: 8,
    range: 2,
    moveRange: 2,
    actionAP: 1,
    cost: 25,
    initiative: 4,
    special: null,
    skills: [
      { name: "heal", apCost: 2, cooldown: 1, description: "Heal target friendly +25 HP" },
    ],
  },
};

export const FIREBALL_DAMAGE = 25;
export const FIREBALL_AOE_RADIUS = 1;
export const HEAL_AMOUNT = 25;
