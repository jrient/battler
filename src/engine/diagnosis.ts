/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
// Battle diagnosis — a post-processing aggregation layer over the event log.
//
// The engine already logs every action outcome line-by-line (a hit, a heal, and
// crucially every SILENT failure: a move that whiffed out of range, an attack
// blocked by line of sight, a buy with no spawn space). But an agent reading the
// raw log has to parse ~100+ lines to answer "how many of my attacks connected,
// and why did the rest miss?". This turns that log into a compact, per-viewer
// scoreboard so an LLM can self-correct from aggregates instead of prose.
//
// Pure function of (raw events, viewerSide) — no engine coupling, computable at
// index time and back-fillable for old matches, exactly like engine/excitement.ts.
//
// It reads the RAW internal events (unit ids still carry their "_A"/"_B" suffix)
// plus the viewer's side, rather than the my./enemy.-rewritten log: buy lines
// carry a bare side LETTER ("[buy] A buy archer failed ...") that the viewer
// rewrite doesn't touch, so the raw form is the only unambiguous attribution.
import type { Side } from "./types.js";

export interface UnitTypeStat {
  attacks: number; // attack attempts by my units of this type (hits + whiffs)
  hits: number; // attacks that landed damage
  whiffs: number; // attacks that failed (out of range / LOS / no target / ally)
  damageDealt: number; // direct + pierce + splash damage from this type
  splashHits: number; // extra enemies caught by mage splash
  pierceHits: number; // extra enemies caught by spear pierce
  heals: number; // priest heal casts (attacking a friendly)
  healing: number; // total HP restored to allies
  losses: number; // my units of this type that died
}

// Reasons my actions silently failed. Only keys with a non-zero count are emitted.
export type WhiffReason =
  | "move_out_of_bounds"
  | "move_out_of_range"
  | "move_cell_occupied"
  | "attack_target_not_found"
  | "attack_out_of_range"
  | "attack_los_blocked"
  | "attack_cannot_attack_ally"
  | "buy_no_space";

export interface Diagnosis {
  byUnitType: Record<string, UnitTypeStat>;
  // Every way my actions failed this match, aggregated. The single highest-value
  // signal for self-correction: "attack_out_of_range: 4" says positioning is off.
  whiffReasons: Partial<Record<WhiffReason, number>>;
  totals: {
    attacks: number;
    hits: number;
    whiffs: number;
    hitRate: number; // 0..1, hits / attacks (0 when no attacks)
    damageDealt: number;
    healing: number;
    unitsLost: number;
    monstersSlain: number;
    bountyGold: number;
    actionFailures: number; // sum across whiffReasons (move + attack + buy)
  };
  // One-line, templated, factual summary — no LLM call needed.
  narrative: string;
}

function emptyStat(): UnitTypeStat {
  return {
    attacks: 0,
    hits: 0,
    whiffs: 0,
    damageDealt: 0,
    splashHits: 0,
    pierceHits: 0,
    heals: 0,
    healing: 0,
    losses: 0,
  };
}

export function computeDiagnosis(events: string[], viewerSide: Side): Diagnosis {
  const me = viewerSide; // "A" | "B"
  const byUnitType: Record<string, UnitTypeStat> = {};
  const whiffReasons: Partial<Record<WhiffReason, number>> = {};

  const stat = (type: string): UnitTypeStat => (byUnitType[type] ??= emptyStat());
  const whiff = (r: WhiffReason): void => {
    whiffReasons[r] = (whiffReasons[r] ?? 0) + 1;
  };

  // A "my unit" mention: <type>_<myside><n>. Capture group 1 = unit type.
  const myId = `([a-z]+)_${me}(\\d+)`;
  const reAtkHit = new RegExp(`^\\[atk\\] ${myId} attacked \\S+ for (\\d+) dmg`);
  const reHeal = new RegExp(`^\\[atk\\] ${myId} healed \\S+ \\+(\\d+) `);
  const rePierce = new RegExp(`^\\[atk\\] ${myId} pierce hit \\S+ for (\\d+) dmg`);
  const reSplash = new RegExp(`^\\[atk\\] ${myId} splash hit (.+)$`);
  const reAtkFailTagged = new RegExp(`^\\[atk\\] ${myId} attack failed: (.+)$`);
  const reAtkFailLos = new RegExp(`^${myId} attack failed: line of sight`);
  const reMoveFail = new RegExp(`^\\[mov\\] ${myId} move failed: (.+)$`);
  const reBuyFail = new RegExp(`^\\[buy\\] ${me} buy [a-z]+ failed:`);
  const reMonSlain = new RegExp(`slain by ${myId} — bounty \\+(\\d+)g`);
  const reMyDeath = new RegExp(`^\\[die\\] ([a-z]+)_${me}(\\d+) died`);

  for (const line of events) {
    let m: RegExpExecArray | null;

    if ((m = reAtkHit.exec(line))) {
      const s = stat(m[1]!);
      s.attacks++;
      s.hits++;
      s.damageDealt += Number(m[3]);
      continue;
    }
    if ((m = reHeal.exec(line))) {
      const s = stat(m[1]!);
      s.heals++;
      s.healing += Number(m[3]);
      continue;
    }
    if ((m = rePierce.exec(line))) {
      const s = stat(m[1]!);
      s.pierceHits++;
      s.damageDealt += Number(m[3]);
      continue;
    }
    if ((m = reSplash.exec(line))) {
      const s = stat(m[1]!);
      // tail looks like "enemy_B2(15), spear_B1(15)" (raw ids); sum the (N) parts.
      for (const dm of m[3]!.matchAll(/\((\d+)\)/g)) {
        s.splashHits++;
        s.damageDealt += Number(dm[1]);
      }
      continue;
    }
    if ((m = reAtkFailTagged.exec(line))) {
      const s = stat(m[1]!);
      s.attacks++;
      s.whiffs++;
      const reason = m[3]!;
      if (reason.includes("not found")) whiff("attack_target_not_found");
      else if (reason.includes("out of range")) whiff("attack_out_of_range");
      else if (reason.includes("cannot attack ally")) whiff("attack_cannot_attack_ally");
      continue;
    }
    if ((m = reAtkFailLos.exec(line))) {
      const s = stat(m[1]!);
      s.attacks++;
      s.whiffs++;
      whiff("attack_los_blocked");
      continue;
    }
    if ((m = reMoveFail.exec(line))) {
      const reason = m[3]!;
      if (reason.includes("out of bounds")) whiff("move_out_of_bounds");
      else if (reason.includes("out of range")) whiff("move_out_of_range");
      else if (reason.includes("cell occupied")) whiff("move_cell_occupied");
      continue;
    }
    if (reBuyFail.test(line)) {
      whiff("buy_no_space");
      continue;
    }
    if ((m = reMyDeath.exec(line))) {
      stat(m[1]!).losses++;
      continue;
    }
    // Monster kills (`[mon] ... slain by my.unit`) are tallied in the totals pass
    // below — the kill blow itself is already counted on its [atk] line here.
  }

  // ----- totals -----
  let attacks = 0,
    hits = 0,
    whiffs = 0,
    damageDealt = 0,
    healing = 0,
    unitsLost = 0;
  for (const s of Object.values(byUnitType)) {
    attacks += s.attacks;
    hits += s.hits;
    whiffs += s.whiffs;
    damageDealt += s.damageDealt;
    healing += s.healing;
    unitsLost += s.losses;
  }
  let monstersSlain = 0,
    bountyGold = 0;
  for (const line of events) {
    const m = reMonSlain.exec(line);
    if (m) {
      monstersSlain++;
      bountyGold += Number(m[3]);
    }
  }
  let actionFailures = 0;
  for (const v of Object.values(whiffReasons)) actionFailures += v ?? 0;

  const hitRate = attacks > 0 ? hits / attacks : 0;

  const totals = {
    attacks,
    hits,
    whiffs,
    hitRate: Math.round(hitRate * 1000) / 1000,
    damageDealt,
    healing,
    unitsLost,
    monstersSlain,
    bountyGold,
    actionFailures,
  };

  return { byUnitType, whiffReasons, totals, narrative: buildNarrative(byUnitType, totals, whiffReasons) };
}

function buildNarrative(
  byUnitType: Record<string, UnitTypeStat>,
  totals: Diagnosis["totals"],
  whiffReasons: Diagnosis["whiffReasons"],
): string {
  const parts: string[] = [];

  if (totals.attacks > 0) {
    const pct = Math.round(totals.hitRate * 100);
    parts.push(`Landed ${totals.hits}/${totals.attacks} attacks (${pct}%)`);
  } else {
    parts.push("Made no attacks");
  }

  // Biggest single failure reason — the most actionable nudge.
  const reasons = Object.entries(whiffReasons).filter(([, n]) => (n ?? 0) > 0);
  if (reasons.length) {
    reasons.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    const [reason, n] = reasons[0]!;
    parts.push(`top failure ${reason}×${n}`);
  }

  // Top damage dealer.
  const dealers = Object.entries(byUnitType)
    .filter(([, s]) => s.damageDealt > 0)
    .sort((a, b) => b[1].damageDealt - a[1].damageDealt);
  if (dealers.length) {
    const [type, s] = dealers[0]!;
    parts.push(`${type} dealt most damage (${s.damageDealt})`);
  }

  if (totals.healing > 0) parts.push(`healed ${totals.healing}`);
  if (totals.unitsLost > 0) parts.push(`lost ${totals.unitsLost} units`);
  if (totals.monstersSlain > 0) parts.push(`slew ${totals.monstersSlain} monsters (+${totals.bountyGold}g)`);

  return parts.join("; ") + ".";
}
