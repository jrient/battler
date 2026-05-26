import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentJson } from "../engine/replay.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..", "..");
const DATA_DIR = resolve(ROOT, "data");
const STORE_FILE = resolve(DATA_DIR, "store.json");

export interface CommanderRecord {
  id: string;
  commanderKey: string;
  displayName: string;
  code: string;
  codeVersion: number;
  codeHash: string;
  submittedBy: string;
  changelog: string;
  codeUpdatedAt: string;
  rank: RankInfo;
  recentMatchIds: string[];
}

export interface RankInfo {
  score: number;
  tier: "Bronze" | "Silver" | "Gold" | "Platinum" | "Diamond" | "Master";
  division: "I" | "II" | "III";
  placementMatches: number;
  effectiveWins: number;
  effectiveLosses: number;
  lastRankChange: number;
}

export interface MatchRecord {
  matchId: string;
  createdAt: string;
  type: "simulate" | "challenge";
  seed: number;
  participantA: { commanderId: string; submittedBy: string; version: number };
  participantB: { commanderId: string; submittedBy: string; version: number };
  agentJsonForA: AgentJson;
  agentJsonForB: AgentJson;
}

interface StoreShape {
  commanders: Record<string, CommanderRecord>;
  matches: Record<string, MatchRecord>;
  simulationLastAtByCommander: Record<string, string>;
}

const EMPTY: StoreShape = {
  commanders: {},
  matches: {},
  simulationLastAtByCommander: {},
};

let state: StoreShape = EMPTY;
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(STORE_FILE)) {
    try {
      const raw = readFileSync(STORE_FILE, "utf8");
      state = JSON.parse(raw) as StoreShape;
      if (!state.commanders) state.commanders = {};
      if (!state.matches) state.matches = {};
      if (!state.simulationLastAtByCommander) state.simulationLastAtByCommander = {};
    } catch {
      state = { ...EMPTY };
    }
  } else {
    state = { commanders: {}, matches: {}, simulationLastAtByCommander: {} };
  }
  loaded = true;
}

function flush(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
}

export function getCommanderByKey(key: string): CommanderRecord | null {
  ensureLoaded();
  for (const c of Object.values(state.commanders)) {
    if (c.commanderKey === key) return c;
  }
  return null;
}

export function getCommanderById(id: string): CommanderRecord | null {
  ensureLoaded();
  return state.commanders[id] ?? null;
}

export function createCommander(input: {
  id: string;
  commanderKey: string;
  displayName: string;
}): CommanderRecord {
  ensureLoaded();
  if (state.commanders[input.id]) {
    throw new Error(`commander ${input.id} already exists`);
  }
  const rec: CommanderRecord = {
    id: input.id,
    commanderKey: input.commanderKey,
    displayName: input.displayName,
    code: "",
    codeVersion: 0,
    codeHash: "",
    submittedBy: "",
    changelog: "",
    codeUpdatedAt: new Date(0).toISOString(),
    rank: {
      score: 1000,
      tier: "Bronze",
      division: "III",
      placementMatches: 0,
      effectiveWins: 0,
      effectiveLosses: 0,
      lastRankChange: 0,
    },
    recentMatchIds: [],
  };
  state.commanders[input.id] = rec;
  flush();
  return rec;
}

export function updateCommanderCode(
  id: string,
  patch: { code: string; codeHash: string; submittedBy: string; changelog: string },
): CommanderRecord {
  ensureLoaded();
  const rec = state.commanders[id];
  if (!rec) throw new Error(`commander ${id} not found`);
  rec.code = patch.code;
  rec.codeHash = patch.codeHash;
  rec.codeVersion += 1;
  rec.submittedBy = patch.submittedBy;
  rec.changelog = patch.changelog;
  rec.codeUpdatedAt = new Date().toISOString();
  flush();
  return rec;
}

export function saveMatch(rec: MatchRecord): void {
  ensureLoaded();
  state.matches[rec.matchId] = rec;
  const aId = rec.participantA.commanderId;
  const bId = rec.participantB.commanderId;
  const aCmd = state.commanders[aId];
  const bCmd = state.commanders[bId];
  if (aCmd) {
    aCmd.recentMatchIds = [rec.matchId, ...aCmd.recentMatchIds].slice(0, 20);
  }
  if (bCmd) {
    bCmd.recentMatchIds = [rec.matchId, ...bCmd.recentMatchIds].slice(0, 20);
  }
  flush();
}

export function getMatch(id: string): MatchRecord | null {
  ensureLoaded();
  return state.matches[id] ?? null;
}

export function getSimulationLastAt(commanderId: string): Date | null {
  ensureLoaded();
  const iso = state.simulationLastAtByCommander[commanderId];
  return iso ? new Date(iso) : null;
}

export function setSimulationLastAt(commanderId: string, at: Date): void {
  ensureLoaded();
  state.simulationLastAtByCommander[commanderId] = at.toISOString();
  flush();
}

export function listCommanders(): CommanderRecord[] {
  ensureLoaded();
  return Object.values(state.commanders);
}
