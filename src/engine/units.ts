/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import type { UnitDef, UnitType } from "./types.js";

export const BOARD_WIDTH = 16;
export const BOARD_HEIGHT = 12;
export const MAX_TURNS = 100;
// Turns 1..BUY_TURNS you earn money income and may buy units; after that the
// roster is locked and you only fight with what you have.
export const BUY_TURNS = 10;
// If the board is completely unchanged (no HP changes, no successful moves, no
// buys) for this many consecutive turns after the buy window, the match is a
// stalemate: end it early and decide on remaining strength instead of grinding
// out dozens of identical frozen turns to MAX_TURNS.
export const STALE_TURNS_LIMIT = 8;
export const AP_PER_TURN = 10;
// Single currency: you start with STARTING_MONEY and gain
// MONEY_INCOME_BASE + MONEY_INCOME_PER_TURN * turn each turn in the buy window.
export const STARTING_MONEY = 10;
// 10 gold per turn during the buy window (flat, not scaled by turn).
export const MONEY_INCOME_PER_TURN = 10;
// At game start a coin flip decides turn order. The winner moves first every
// round (an information advantage: it acts before seeing the opponent's move).
// The loser moves second but gets this much extra starting gold as compensation.
// Tunable — adjust after balance testing with tmp/harness.ts. Records showed the
// second mover (who reacts on the already-updated board) was already ~even with
// the first mover at 0 gold, so +10 over-compensated and pushed second-mover win
// rate to ~64-70%; cut to 5 to pull it back toward even without fully removing it.
export const SECOND_MOVER_BONUS = 5;

export const UNITS: Record<UnitType, UnitDef> = {
  knight: {
    type: "knight",
    hp: 100,
    atk: 20,
    range: 1,
    moveRange: 3,
    actionAP: 1,
    cost: 5,
    initiative: 3,
    special: "damage_reduction_half",
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
  },
  archer: {
    type: "archer",
    hp: 40,
    atk: 18,
    range: 3,
    moveRange: 2,
    actionAP: 1,
    cost: 3,
    initiative: 6,
    special: null,
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
    special: "splash",
  },
  priest: {
    type: "priest",
    hp: 50,
    atk: 10,
    range: 2,
    moveRange: 2,
    actionAP: 1,
    cost: 4,
    initiative: 4,
    special: "heal_ally",
  },
  engineer: {
    type: "engineer",
    hp: 40,
    atk: 12,
    range: 1,
    moveRange: 3,
    actionAP: 1,
    cost: 2,
    initiative: 4,
    special: null,
  },
};

// Mage splash: enemies within this Chebyshev radius of the primary target take
// floor(atk/2) extra damage.
export const SPLASH_RADIUS = 1;

// ===== Neutral monsters =====
// A third faction (side "N") that spawns in the neutral middle columns. Passive
// until ATTACKED — then it hunts that attacker, but gives up if the target
// outruns its leash. Never buyable, never counts toward victory, but killing one
// pays a gold bounty (see MONSTER_BOUNTY) — they're a contested resource, not a
// wall. Stats live here (not in UNITS) so "monster" stays out of UnitType.
export const MONSTER: UnitDef = {
  type: "monster" as UnitType,
  hp: 200,
  atk: 10,
  range: 1,
  moveRange: 2,
  actionAP: 1,
  cost: Number.POSITIVE_INFINITY,
  initiative: 0,
  special: null,
};

// How many monsters spawn (inclusive range), and the column band they spawn in.
export const MONSTER_MIN = 8;
export const MONSTER_MAX = 12;
export const NEUTRAL_COL_MIN = 4;
export const NEUTRAL_COL_MAX = 11;
// Gold paid to whoever lands the killing blow on a monster. After the buy window
// closes this is the ONLY income source, so clearing monsters is how you keep
// reinforcing mid/late game. Tune for risk/reward against MONSTER.hp.
export const MONSTER_BOUNTY = 10;
// Leash: an enraged monster gives up and goes passive once the chase pulls it
// more than this many cells (Chebyshev) from its spawn anchor — so it can't be
// kited all the way back to a player's home, and "poke then retreat" is a clean
// way to disengage. Kept tight relative to the 16-wide board on purpose.
export const MONSTER_LEASH = 4;
