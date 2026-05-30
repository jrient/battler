import { describe, it, expect } from "vitest";
import { computeNewRank, botScore, BOT_SCORES } from "./elo.js";
import type { RankInfo } from "../server/store.js";

// A fresh rank at the seeded default (score 1000, no placement matches yet).
function baseRank(overrides: Partial<RankInfo> = {}): RankInfo {
  return {
    score: 1000,
    tier: "Bronze",
    division: "III",
    placementMatches: 0,
    effectiveWins: 0,
    effectiveLosses: 0,
    lastRankChange: 0,
    ...overrides,
  };
}

describe("botScore", () => {
  it("returns the configured score for known bots", () => {
    expect(botScore("red-charger")).toBe(BOT_SCORES["red-charger"]);
    expect(botScore("green-tactician")).toBe(1600);
  });
  it("falls back to 1000 for unknown bots", () => {
    expect(botScore("does-not-exist")).toBe(1000);
  });
});

describe("computeNewRank — K factor", () => {
  it("uses the placement K (32) for the first 5 matches", () => {
    // Equal-score win during placement: round(32 * (1 - 0.5)) = 16.
    const { delta } = computeNewRank(baseRank(), 1000, "win");
    expect(delta).toBe(16);
  });

  it("uses the normal K (20) once placement is done", () => {
    // Equal-score win after placement: round(20 * 0.5) = 10.
    const { delta } = computeNewRank(baseRank({ placementMatches: 5 }), 1000, "win");
    expect(delta).toBe(10);
  });
});

describe("computeNewRank — bot win damp", () => {
  it("halves only positive deltas earned against a bot", () => {
    const pvp = computeNewRank(baseRank(), 1000, "win", false);
    const bot = computeNewRank(baseRank(), 1000, "win", true);
    expect(bot.delta).toBe(Math.round(pvp.delta * 0.5));
  });

  it("does not damp losses against a bot", () => {
    const pvp = computeNewRank(baseRank(), 1000, "loss", false);
    const bot = computeNewRank(baseRank(), 1000, "loss", true);
    expect(bot.delta).toBe(pvp.delta);
    expect(bot.delta).toBeLessThan(0);
  });
});

describe("computeNewRank — bookkeeping", () => {
  it("increments placementMatches and win/loss tallies", () => {
    const win = computeNewRank(baseRank(), 1000, "win");
    expect(win.rank.placementMatches).toBe(1);
    expect(win.rank.effectiveWins).toBe(1);
    expect(win.rank.effectiveLosses).toBe(0);

    const loss = computeNewRank(baseRank({ effectiveLosses: 2 }), 1000, "loss");
    expect(loss.rank.effectiveLosses).toBe(3);
    expect(loss.rank.lastRankChange).toBe(loss.delta);
  });

  it("never lets the score fall below 0", () => {
    // Huge favourite losing to a near-zero opponent still floors at 0.
    const { rank } = computeNewRank(baseRank({ score: 5 }), 0, "loss");
    expect(rank.score).toBeGreaterThanOrEqual(0);
  });

  it("a draw against an equal opponent leaves the score unchanged", () => {
    const { delta, rank } = computeNewRank(baseRank({ placementMatches: 5 }), 1000, "draw");
    expect(delta).toBe(0);
    expect(rank.score).toBe(1000);
  });
});

describe("computeNewRank — tier/division boundaries", () => {
  const tierAt = (score: number) => {
    // Feed a draw vs an equal-score opponent so the score is unchanged and we
    // read back the tier the score maps to.
    const { rank } = computeNewRank(baseRank({ score, placementMatches: 5 }), score, "draw");
    return `${rank.tier} ${rank.division}`;
  };

  it("maps band edges to the right tier", () => {
    expect(tierAt(1099)).toBe("Bronze I"); // top of the Bronze band, just below Silver
    expect(tierAt(900)).toBe("Bronze III");
    expect(tierAt(800)).toBe("Bronze III"); // below the band base, offset clamps to 0
    expect(tierAt(1100)).toBe("Silver III");
    expect(tierAt(1300)).toBe("Gold III");
    expect(tierAt(1500)).toBe("Platinum III");
    expect(tierAt(1700)).toBe("Diamond III");
    expect(tierAt(1800)).toBe("Master I");
    expect(tierAt(2500)).toBe("Master I");
  });

  it("splits each 200-point tier into three divisions", () => {
    expect(tierAt(1100)).toBe("Silver III"); // offset 0
    expect(tierAt(1167)).toBe("Silver II");  // offset 67
    expect(tierAt(1234)).toBe("Silver I");   // offset 134
  });
});
