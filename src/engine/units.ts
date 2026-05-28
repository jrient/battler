import type { UnitDef, UnitType } from "./types.js";

export const BOARD_WIDTH = 16;
export const BOARD_HEIGHT = 12;
export const MAX_TURNS = 100;
// Turns 1..BUY_TURNS you earn money income and may buy units; after that the
// roster is locked and you only fight with what you have.
export const BUY_TURNS = 10;
export const AP_PER_TURN = 10;
// Single currency: you start with STARTING_MONEY and gain
// MONEY_INCOME_BASE + MONEY_INCOME_PER_TURN * turn each turn in the buy window.
export const STARTING_MONEY = 10;
// 10 gold per turn during the buy window (flat, not scaled by turn).
export const MONEY_INCOME_PER_TURN = 10;

export const UNITS: Record<UnitType, UnitDef> = {
  knight: {
    type: "knight",
    hp: 100,
    atk: 20,
    range: 1,
    moveRange: 2,
    actionAP: 1,
    cost: 5,
    initiative: 3,
    special: "damage_reduction_half",
    skills: [],
  },
  spear: {
    type: "spear",
    hp: 60,
    atk: 25,
    range: 2,
    moveRange: 3,
    actionAP: 1,
    cost: 3,
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
    cost: 3,
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
    cost: 4,
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
    moveRange: 1,
    actionAP: 1,
    cost: 4,
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
