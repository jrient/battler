import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type { AgentJson } from "../engine/replay.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..", "..");
const DATA_DIR = resolve(ROOT, "data");
const STORE_FILE = resolve(DATA_DIR, "store.json");
const MATCHES_DIR = resolve(DATA_DIR, "matches");

export interface UserRecord {
  id: string;            // "usr_xxxxxxxx"
  githubId: number;      // GitHub numeric user id
  githubLogin: string;   // GitHub username (mutable on GitHub side)
  avatarUrl: string;
  displayName: string;   // GitHub name or login
  createdAt: string;
}

export interface CommanderRecord {
  id: string;
  commanderKey: string;
  bootstrapToken: string;
  ownerId: string | null;       // User.id; null = orphaned legacy
  displayName: string;          // globally unique handle, [a-zA-Z0-9_-]{3,32}
  code: string;
  codeVersion: number;
  codeHash: string;
  submittedBy: string;
  changelog: string;
  codeUpdatedAt: string;
  createdAt: string;
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

// Lightweight summary held in store.json. The full MatchRecord (including the
// turn-by-turn agent JSON, which can be hundreds of KB) lives in
// data/matches/<matchId>.json. Keeps store.json bounded regardless of match
// volume so the V8 string-length cap on JSON.stringify never gets hit.
export interface MatchIndex {
  matchId: string;
  createdAt: string;
  type: "simulate" | "challenge";
  seed: number;
  participantA: { commanderId: string; submittedBy: string; version: number };
  participantB: { commanderId: string; submittedBy: string; version: number };
  // A-side perspective. B's view is the mirror (result inverted, units swapped).
  resultA: "win" | "loss" | "draw";
  totalTurns: number;
  aUnitsRemaining: number;
  bUnitsRemaining: number;
}

export interface IssueRecord {
  id: string;
  title: string;
  body: string;
  authorLogin: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  status: "open" | "closed";
  commentCount: number;
}

export interface CommentRecord {
  id: string;
  issueId: string;
  body: string;
  authorLogin: string;
  authorId: string;
  createdAt: string;
}

interface StoreShape {
  users: Record<string, UserRecord>;
  commanders: Record<string, CommanderRecord>;
  matches: Record<string, MatchIndex>;
  simulationLastAtByCommander: Record<string, string>;
  issues: Record<string, IssueRecord>;
  comments: Record<string, CommentRecord>;
}

const EMPTY: StoreShape = {
  users: {},
  commanders: {},
  matches: {},
  simulationLastAtByCommander: {},
  issues: {},
  comments: {},
};

let state: StoreShape = EMPTY;
let loaded = false;

// ===== Display name validation =====

const RESERVED_NAMES = new Set([
  "admin", "administrator", "anonymous", "api", "auth", "health", "root",
  "system", "support", "agentclash", "null", "undefined", "test",
  "red-charger", "blue-turtle", "green-tactician",
]);

// Allow Unicode letters (incl. CJK) and digits, plus _ and -.
// 3-32 UTF-16 code units (a single Han char is one code unit).
const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}_-]{3,32}$/u;

export type DisplayNameValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: "format" | "reserved" | "taken"; suggestions?: string[] };

export function validateDisplayName(name: string): DisplayNameValidation {
  if (!DISPLAY_NAME_PATTERN.test(name)) return { ok: false, reason: "format" };
  const lower = name.toLowerCase();
  if (RESERVED_NAMES.has(lower)) {
    return { ok: false, reason: "reserved", suggestions: makeSuggestions(name) };
  }
  if (findCommanderByDisplayName(name)) {
    return { ok: false, reason: "taken", suggestions: makeSuggestions(name) };
  }
  return { ok: true, normalized: name };
}

function makeSuggestions(name: string): string[] {
  const base = name.replace(/[-_]+$/, "").slice(0, 28);
  const year = new Date().getFullYear();
  const candidates = [
    `${base}-2`,
    `${base}-${year}`,
    `${base}-${nanoid(4).toLowerCase()}`,
    `${base}_x`,
  ];
  const out: string[] = [];
  for (const c of candidates) {
    if (!DISPLAY_NAME_PATTERN.test(c)) continue;
    if (RESERVED_NAMES.has(c.toLowerCase())) continue;
    if (findCommanderByDisplayName(c)) continue;
    out.push(c);
    if (out.length >= 3) break;
  }
  return out;
}

// ===== Persistence =====

function migrateInPlace(s: StoreShape): void {
  if (!s.users) s.users = {};
  if (!s.commanders) s.commanders = {};
  if (!s.matches) s.matches = {};
  if (!s.simulationLastAtByCommander) s.simulationLastAtByCommander = {};
  if (!s.issues) s.issues = {};
  if (!s.comments) s.comments = {};

  for (const c of Object.values(s.commanders)) {
    const anyC = c as unknown as Record<string, unknown>;
    if (!("ownerId" in anyC)) anyC.ownerId = null;
    if (!("bootstrapToken" in anyC) || !anyC.bootstrapToken) {
      anyC.bootstrapToken = "bst_" + nanoid(32);
    }
    if (!("createdAt" in anyC) || !anyC.createdAt) {
      anyC.createdAt = (c.codeUpdatedAt as string) || new Date(0).toISOString();
    }
  }

  // Split fat MatchRecord entries (legacy: full agentJson lived inside store.json)
  // into per-file storage, replacing the in-memory entry with a slim MatchIndex.
  if (!existsSync(MATCHES_DIR)) mkdirSync(MATCHES_DIR, { recursive: true });
  let migrated = 0;
  for (const [id, m] of Object.entries(s.matches)) {
    const anyM = m as unknown as Record<string, unknown>;
    if ("agentJsonForA" in anyM && "agentJsonForB" in anyM) {
      const fat = m as unknown as MatchRecord;
      writeMatchFile(fat);
      s.matches[id] = indexFromRecord(fat);
      migrated++;
    }
  }
  if (migrated > 0) {
    console.log(`[store] migrated ${migrated} fat matches into ${MATCHES_DIR}`);
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(STORE_FILE)) {
    try {
      const raw = readFileSync(STORE_FILE, "utf8");
      state = JSON.parse(raw) as StoreShape;
      migrateInPlace(state);
    } catch {
      state = { users: {}, commanders: {}, matches: {}, simulationLastAtByCommander: {}, issues: {}, comments: {} };
    }
  } else {
    state = { users: {}, commanders: {}, matches: {}, simulationLastAtByCommander: {}, issues: {}, comments: {} };
  }
  loaded = true;
  flush();
}

function flush(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
}

// ===== User =====

export function getUserById(id: string): UserRecord | null {
  ensureLoaded();
  return state.users[id] ?? null;
}

export function getUserByGithubId(githubId: number): UserRecord | null {
  ensureLoaded();
  for (const u of Object.values(state.users)) {
    if (u.githubId === githubId) return u;
  }
  return null;
}

export function createUser(input: {
  githubId: number;
  githubLogin: string;
  avatarUrl: string;
  displayName: string;
}): UserRecord {
  ensureLoaded();
  const id = "usr_" + nanoid(10);
  const rec: UserRecord = {
    id,
    githubId: input.githubId,
    githubLogin: input.githubLogin,
    avatarUrl: input.avatarUrl,
    displayName: input.displayName,
    createdAt: new Date().toISOString(),
  };
  state.users[id] = rec;
  flush();
  return rec;
}

export function updateUserProfile(
  id: string,
  patch: { githubLogin?: string; avatarUrl?: string; displayName?: string },
): UserRecord | null {
  ensureLoaded();
  const u = state.users[id];
  if (!u) return null;
  if (patch.githubLogin !== undefined) u.githubLogin = patch.githubLogin;
  if (patch.avatarUrl !== undefined) u.avatarUrl = patch.avatarUrl;
  if (patch.displayName !== undefined) u.displayName = patch.displayName;
  flush();
  return u;
}

// ===== Commander =====

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

export function getCommanderByBootstrapToken(token: string): CommanderRecord | null {
  ensureLoaded();
  for (const c of Object.values(state.commanders)) {
    if (c.bootstrapToken === token) return c;
  }
  return null;
}

export function findCommanderByDisplayName(name: string): CommanderRecord | null {
  ensureLoaded();
  const lower = name.toLowerCase();
  for (const c of Object.values(state.commanders)) {
    if (c.displayName.toLowerCase() === lower) return c;
  }
  return null;
}

export function listCommandersByOwner(ownerId: string): CommanderRecord[] {
  ensureLoaded();
  return Object.values(state.commanders)
    .filter((c) => c.ownerId === ownerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createCommanderForOwner(input: {
  ownerId: string;
  displayName: string;
}): CommanderRecord {
  ensureLoaded();
  const id = "cmd_" + nanoid(8);
  const rec: CommanderRecord = {
    id,
    commanderKey: "ack_" + nanoid(24),
    bootstrapToken: "bst_" + nanoid(32),
    ownerId: input.ownerId,
    displayName: input.displayName,
    code: "",
    codeVersion: 0,
    codeHash: "",
    submittedBy: "",
    changelog: "",
    codeUpdatedAt: new Date(0).toISOString(),
    createdAt: new Date().toISOString(),
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
  state.commanders[id] = rec;
  flush();
  return rec;
}

export function regenerateCommanderBootstrapToken(id: string): CommanderRecord | null {
  ensureLoaded();
  const c = state.commanders[id];
  if (!c) return null;
  c.bootstrapToken = "bst_" + nanoid(32);
  flush();
  return c;
}

export function resetCommanderKey(id: string): CommanderRecord | null {
  ensureLoaded();
  const c = state.commanders[id];
  if (!c) return null;
  c.commanderKey = "ack_" + nanoid(24);
  flush();
  return c;
}

export function deleteCommander(id: string): boolean {
  ensureLoaded();
  if (!state.commanders[id]) return false;
  delete state.commanders[id];
  flush();
  return true;
}

export function renameCommander(id: string, newName: string): CommanderRecord | null {
  ensureLoaded();
  const rec = state.commanders[id];
  if (!rec) return null;
  rec.displayName = newName;
  flush();
  return rec;
}

export const DISPLAY_NAME_RE = DISPLAY_NAME_PATTERN;

export function isDisplayNameReserved(name: string): boolean {
  return RESERVED_NAMES.has(name.toLowerCase());
}

export function applyRankUpdate(id: string, newRank: RankInfo): CommanderRecord | null {
  ensureLoaded();
  const rec = state.commanders[id];
  if (!rec) return null;
  rec.rank = newRank;
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

// Legacy: kept for back-compat with /api/register (no owner)
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
    bootstrapToken: "bst_" + nanoid(32),
    ownerId: null,
    displayName: input.displayName,
    code: "",
    codeVersion: 0,
    codeHash: "",
    submittedBy: "",
    changelog: "",
    codeUpdatedAt: new Date(0).toISOString(),
    createdAt: new Date().toISOString(),
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

// ===== Match file I/O =====

function matchFilePath(matchId: string): string {
  return resolve(MATCHES_DIR, `${matchId}.json`);
}

function writeMatchFile(rec: MatchRecord): void {
  if (!existsSync(MATCHES_DIR)) mkdirSync(MATCHES_DIR, { recursive: true });
  writeFileSync(matchFilePath(rec.matchId), JSON.stringify(rec));
}

function readMatchFile(matchId: string): MatchRecord | null {
  const p = matchFilePath(matchId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as MatchRecord;
  } catch {
    return null;
  }
}

function indexFromRecord(rec: MatchRecord): MatchIndex {
  return {
    matchId: rec.matchId,
    createdAt: rec.createdAt,
    type: rec.type,
    seed: rec.seed,
    participantA: rec.participantA,
    participantB: rec.participantB,
    resultA: rec.agentJsonForA.result,
    totalTurns: rec.agentJsonForA.summary.totalTurns,
    aUnitsRemaining: rec.agentJsonForA.summary.myUnitsRemaining,
    bUnitsRemaining: rec.agentJsonForA.summary.enemyUnitsRemaining,
  };
}

// ===== Matches =====

export function saveMatch(rec: MatchRecord): void {
  ensureLoaded();
  writeMatchFile(rec);
  state.matches[rec.matchId] = indexFromRecord(rec);
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
  return readMatchFile(id);
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

export function getMatchesByCommander(commanderId: string, limit = 20, offset = 0): MatchIndex[] {
  ensureLoaded();
  const cmd = state.commanders[commanderId];
  if (!cmd) return [];
  const ids = cmd.recentMatchIds.slice(offset, offset + limit);
  return ids.map(id => state.matches[id]).filter((m): m is MatchIndex => !!m);
}

export function listMatches(limit = 50, offset = 0): { matches: MatchIndex[]; total: number } {
  ensureLoaded();
  const all = Object.values(state.matches).sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt),
  );
  return { matches: all.slice(offset, offset + limit), total: all.length };
}

export function getMatchesByOwner(ownerId: string, limit = 50, offset = 0): MatchIndex[] {
  ensureLoaded();
  const myCmdIds = new Set(
    Object.values(state.commanders).filter((c) => c.ownerId === ownerId).map((c) => c.id),
  );
  if (myCmdIds.size === 0) return [];
  const all = Object.values(state.matches)
    .filter((m) => myCmdIds.has(m.participantA.commanderId) || myCmdIds.has(m.participantB.commanderId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return all.slice(offset, offset + limit);
}

// ===== Issues =====

export function createIssue(opts: { title: string; body: string; authorLogin: string; authorId: string }): IssueRecord {
  ensureLoaded();
  const now = new Date().toISOString();
  const rec: IssueRecord = {
    id: "iss_" + nanoid(8),
    title: opts.title,
    body: opts.body,
    authorLogin: opts.authorLogin,
    authorId: opts.authorId,
    createdAt: now,
    updatedAt: now,
    status: "open",
    commentCount: 0,
  };
  state.issues[rec.id] = rec;
  flush();
  return rec;
}

export function listIssues(limit = 50, offset = 0): IssueRecord[] {
  ensureLoaded();
  return Object.values(state.issues)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(offset, offset + limit);
}

export function getIssue(id: string): IssueRecord | null {
  ensureLoaded();
  return state.issues[id] ?? null;
}

export function addComment(opts: { issueId: string; body: string; authorLogin: string; authorId: string }): CommentRecord | null {
  ensureLoaded();
  const issue = state.issues[opts.issueId];
  if (!issue) return null;
  const rec: CommentRecord = {
    id: "cmt_" + nanoid(8),
    issueId: opts.issueId,
    body: opts.body,
    authorLogin: opts.authorLogin,
    authorId: opts.authorId,
    createdAt: new Date().toISOString(),
  };
  state.comments[rec.id] = rec;
  issue.commentCount++;
  issue.updatedAt = rec.createdAt;
  flush();
  return rec;
}

export function listComments(issueId: string): CommentRecord[] {
  ensureLoaded();
  return Object.values(state.comments)
    .filter((c) => c.issueId === issueId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
