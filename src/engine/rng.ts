/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
export type Rng = () => number;

/**
 * Mulberry32 — small, fast, deterministic PRNG.
 * Same seed always produces same sequence,enabling replay reproducibility.
 */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return function rng(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, minInclusive: number, maxExclusive: number): number {
  return Math.floor(rng() * (maxExclusive - minInclusive)) + minInclusive;
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error("pick from empty array");
  return arr[randInt(rng, 0, arr.length)]!;
}

export function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
