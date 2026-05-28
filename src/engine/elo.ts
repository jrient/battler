import type { RankInfo } from "../server/store.js";

export type Outcome = "win" | "loss" | "draw";

const PLACEMENT_MATCHES = 5;
const K_PLACEMENT = 64;
const K_NORMAL = 32;

// Fixed scores for bot opponents. Used as the opponent score in ELO
// calculation and as their tier label. Bots themselves never gain or
// lose rank.
export const BOT_SCORES: Record<string, number> = {
  "red-charger": 900,
  "blue-turtle": 1200,
  "green-tactician": 1600, // Hermes Agent — ~91% winrate against the others
};

export function botScore(botId: string): number {
  return BOT_SCORES[botId] ?? 1000;
}

function expectedScore(self: number, opponent: number): number {
  return 1 / (1 + Math.pow(10, (opponent - self) / 400));
}

function actualScore(outcome: Outcome): number {
  if (outcome === "win") return 1;
  if (outcome === "loss") return 0;
  return 0.5;
}

export interface RankUpdate {
  rank: RankInfo;
  delta: number;
}

export function computeNewRank(
  current: RankInfo,
  opponentScore: number,
  outcome: Outcome,
): RankUpdate {
  const k = current.placementMatches < PLACEMENT_MATCHES ? K_PLACEMENT : K_NORMAL;
  const expected = expectedScore(current.score, opponentScore);
  const actual = actualScore(outcome);
  const delta = Math.round(k * (actual - expected));
  const newScore = Math.max(0, current.score + delta);

  const next: RankInfo = {
    score: newScore,
    ...tierFromScore(newScore),
    placementMatches: current.placementMatches + 1,
    effectiveWins: current.effectiveWins + (outcome === "win" ? 1 : 0),
    effectiveLosses: current.effectiveLosses + (outcome === "loss" ? 1 : 0),
    lastRankChange: delta,
  };
  return { rank: next, delta };
}

function tierFromScore(score: number): Pick<RankInfo, "tier" | "division"> {
  if (score >= 1800) return { tier: "Master", division: "I" };
  if (score >= 1700) return { tier: "Diamond", division: divFromBand(score, 1700) };
  if (score >= 1500) return { tier: "Platinum", division: divFromBand(score, 1500) };
  if (score >= 1300) return { tier: "Gold", division: divFromBand(score, 1300) };
  if (score >= 1100) return { tier: "Silver", division: divFromBand(score, 1100) };
  return { tier: "Bronze", division: divFromBand(score, 900) };
}

// Each tier (except Master) spans 200 points, split into three 67-point divisions.
function divFromBand(score: number, base: number): "I" | "II" | "III" {
  const offset = Math.max(0, score - base);
  if (offset < 67) return "III";
  if (offset < 134) return "II";
  return "I";
}
