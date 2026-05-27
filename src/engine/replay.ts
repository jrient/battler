import type { ArmyEntry, MatchOutput, Side, TurnSnapshot } from "./types.js";

export interface CommanderMeta {
  id: string;
  submittedBy: string;
  version: number;
}

export interface AgentJson {
  matchId: string;
  result: "win" | "loss" | "draw";
  myCommander: CommanderMeta;
  enemyCommander: CommanderMeta;
  myArmy: ArmyEntry[];
  enemyArmy: ArmyEntry[];
  turnSnapshots: TurnSnapshot[];
  events: string[];
  summary: {
    myUnitsLost: number;
    enemyUnitsLost: number;
    totalDamageDealt: number;
    totalDamageTaken: number;
    decisiveTurn: number;
    decisiveEvent: string;
    myUnitsRemaining: number;
    enemyUnitsRemaining: number;
    totalTurns: number;
  };
}

/**
 * Convert internal symmetric MatchOutput into asymmetric agent.json
 * from a specific viewer's perspective.
 */
export function toAgentJson(
  match: MatchOutput,
  viewerSide: Side,
  myMeta: CommanderMeta,
  enemyMeta: CommanderMeta,
): AgentJson {
  const meIsA = viewerSide === "A";

  let result: "win" | "loss" | "draw";
  if (match.winner === "draw") result = "draw";
  else if (match.winner === viewerSide) result = "win";
  else result = "loss";

  const s = match.summary;

  return {
    matchId: match.matchId,
    result,
    myCommander: myMeta,
    enemyCommander: enemyMeta,
    myArmy: meIsA ? match.armyA : match.armyB,
    enemyArmy: meIsA ? match.armyB : match.armyA,
    turnSnapshots: match.turnSnapshots ?? [],
    events: rewriteEventsForViewer(match.events, viewerSide),
    summary: {
      myUnitsLost: meIsA ? s.aUnitsLost : s.bUnitsLost,
      enemyUnitsLost: meIsA ? s.bUnitsLost : s.aUnitsLost,
      totalDamageDealt: meIsA ? s.totalDamageDealtA : s.totalDamageDealtB,
      totalDamageTaken: meIsA ? s.totalDamageDealtB : s.totalDamageDealtA,
      decisiveTurn: s.decisiveTurn,
      decisiveEvent: s.decisiveEvent,
      myUnitsRemaining: meIsA ? s.aUnitsRemaining : s.bUnitsRemaining,
      enemyUnitsRemaining: meIsA ? s.bUnitsRemaining : s.aUnitsRemaining,
      totalTurns: match.totalTurns,
    },
  };
}

/**
 * Rewrites internal "_A" / "_B" unit ID suffixes to "my." / "enemy." prefixes
 * so the LLM doesn't have to mentally map sides.
 */
function rewriteEventsForViewer(events: string[], viewerSide: Side): string[] {
  const mineRe = viewerSide === "A" ? /\b([a-z]+)_A(\d+)\b/g : /\b([a-z]+)_B(\d+)\b/g;
  const enemyRe = viewerSide === "A" ? /\b([a-z]+)_B(\d+)\b/g : /\b([a-z]+)_A(\d+)\b/g;
  return events.map((line) =>
    line.replace(mineRe, "my.$1_$2").replace(enemyRe, "enemy.$1_$2"),
  );
}
