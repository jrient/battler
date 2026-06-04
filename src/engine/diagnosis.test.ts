/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { describe, it, expect } from "vitest";
import { computeDiagnosis } from "./diagnosis.js";

// A hand-built RAW event log (internal "_A"/"_B" ids, pre viewer-rewrite) that
// exercises every line shape the engine emits in battle.ts. Viewer is side A.
const LOG: string[] = [
  "[COIN] A won the toss and moves first; B moves second (+5 gold)",
  "[T1] -- turn start --",
  "[buy] A bought archer_A1 at [2,1]",
  "[mov] archer_A1 moved [2,1]→[3,1]",
  "[atk] archer_A1 attacked priest_B1 for 18 dmg (hp 32/50)",
  "[atk] archer_A2 attack failed: target spear_B3 out of range (d=4)",
  "archer_A3 attack failed: line of sight to mage_B1 blocked", // NOTE: no [atk] tag
  "[atk] mage_A1 attacked archer_B1 for 30 dmg (hp 10/40)",
  "[atk] mage_A1 splash hit archer_B2(15), spear_B1(15)",
  "[atk] spear_A1 attacked knight_B1 for 25 dmg (hp 75/100)",
  "[atk] spear_A1 pierce hit archer_B3 for 12 dmg",
  "[atk] priest_A1 healed knight_A1 +20 (hp 100/100)",
  "[atk] archer_B1 attacked knight_A1 for 14 dmg (hp 86/100)", // enemy action — ignored for A
  "[mov] knight_A1 move failed: target [9,9] out of range",
  "[mov] knight_A2 move failed: cell occupied by spear_A1",
  "[mov] archer_A1 move failed: out of bounds [16,3]",
  "[buy] A buy archer failed: no space in spawn zone",
  "[atk] archer_A2 attack failed: target ghost_B9 not found",
  "[atk] knight_A1 attack failed: cannot attack ally spear_A1",
  "[mon] monster_N1 slain by spear_A1 — bounty +10g",
  "[die] archer_A2 died (side A)",
  "[die] mage_A1 died (side A)",
  "[die] priest_B1 died (side B)", // enemy death — not my loss
  "[END] A wins by total elimination at turn 8",
];

describe("computeDiagnosis", () => {
  const d = computeDiagnosis(LOG, "A");

  it("aggregates attack hits, whiffs and damage per unit type", () => {
    expect(d.byUnitType.archer).toMatchObject({ attacks: 4, hits: 1, whiffs: 3, damageDealt: 18 });
    expect(d.byUnitType.mage).toMatchObject({ attacks: 1, hits: 1, damageDealt: 60, splashHits: 2 });
    expect(d.byUnitType.spear).toMatchObject({ attacks: 1, hits: 1, damageDealt: 37, pierceHits: 1 });
    expect(d.byUnitType.knight).toMatchObject({ attacks: 1, whiffs: 1 });
  });

  it("counts priest heals separately from attacks", () => {
    expect(d.byUnitType.priest).toMatchObject({ attacks: 0, heals: 1, healing: 20 });
  });

  it("tracks my unit deaths by type, ignoring enemy deaths", () => {
    expect(d.byUnitType.archer!.losses).toBe(1);
    expect(d.byUnitType.mage!.losses).toBe(1);
    expect(d.totals.unitsLost).toBe(2);
  });

  it("aggregates every silent-failure reason", () => {
    expect(d.whiffReasons).toEqual({
      attack_out_of_range: 1,
      attack_target_not_found: 1,
      attack_los_blocked: 1,
      attack_cannot_attack_ally: 1,
      move_out_of_range: 1,
      move_cell_occupied: 1,
      move_out_of_bounds: 1,
      buy_no_space: 1,
    });
    expect(d.totals.actionFailures).toBe(8);
  });

  it("computes correct totals and hit rate", () => {
    expect(d.totals.attacks).toBe(7);
    expect(d.totals.hits).toBe(3);
    expect(d.totals.whiffs).toBe(4);
    expect(d.totals.hitRate).toBeCloseTo(0.429, 3);
    expect(d.totals.damageDealt).toBe(115);
    expect(d.totals.healing).toBe(20);
  });

  it("credits monster bounties to the killer's side", () => {
    expect(d.totals.monstersSlain).toBe(1);
    expect(d.totals.bountyGold).toBe(10);
  });

  it("ignores enemy actions entirely (no enemy unit types leak in)", () => {
    // archer_B1's 14-dmg hit must not inflate my archer damage.
    expect(d.byUnitType.archer!.damageDealt).toBe(18);
    // Only my unit types appear.
    expect(Object.keys(d.byUnitType).sort()).toEqual(["archer", "knight", "mage", "priest", "spear"]);
  });

  it("produces a non-empty one-line narrative", () => {
    expect(d.narrative).toContain("3/7");
    expect(d.narrative).toMatch(/los_blocked|out_of_range|not_found|cannot_attack_ally|no_space|occupied|out_of_bounds/);
    expect(d.narrative.split("\n")).toHaveLength(1);
  });

  it("attributes from the viewer's side: side B sees only B units", () => {
    const db = computeDiagnosis(LOG, "B");
    expect(Object.keys(db.byUnitType)).toContain("archer");
    expect(db.byUnitType.archer!.hits).toBe(1); // archer_B1's 14-dmg hit on knight_A1
    expect(db.byUnitType.archer!.damageDealt).toBe(14);
    expect(db.totals.unitsLost).toBe(1); // only priest_B1 died on side B
  });

  it("handles an empty log without throwing", () => {
    const empty = computeDiagnosis([], "A");
    expect(empty.totals.attacks).toBe(0);
    expect(empty.totals.hitRate).toBe(0);
    expect(empty.narrative).toContain("Made no attacks");
    expect(Object.keys(empty.byUnitType)).toHaveLength(0);
  });
});
