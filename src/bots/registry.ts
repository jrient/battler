/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface BotMeta {
  id: string;
  displayName: string;
  style: string;
  codePath: string;
}

export const BOTS: Record<string, BotMeta> = {
  "red-charger": {
    id: "red-charger",
    displayName: "Red Charger",
    style: "Combined-arms blitz: an archer screen behind a knight/spear wedge that charges in to break the line; presses as first mover, collapses on overextended enemies as second mover",
    codePath: resolve(__dirname, "red-charger.js"),
  },
  "blue-turtle": {
    id: "blue-turtle",
    displayName: "Blue Turtle",
    style: "Defensive wall: holds its own half behind a knight screen + priests, never chases, and kites back out of danger when it moves second",
    codePath: resolve(__dirname, "blue-turtle.js"),
  },
  "green-tactician": {
    id: "green-tactician",
    displayName: "Hermes Agent",
    style: "Threat-priority sniper: heavy mage wing for AOE, advances to a moderate line; pre-aims at enemy DPS as first mover, pivots onto the densest cluster as second mover",
    codePath: resolve(__dirname, "green-tactician.js"),
  },
};

const codeCache = new Map<string, string>();

export function loadBotCode(id: string): string {
  const meta = BOTS[id];
  if (!meta) throw new Error(`bot ${id} not found`);
  const cached = codeCache.get(id);
  if (cached) return cached;
  const code = readFileSync(meta.codePath, "utf8");
  codeCache.set(id, code);
  return code;
}

export function listBots(): BotMeta[] {
  return Object.values(BOTS);
}
