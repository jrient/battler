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
    style: "全员压前 / 集火最近敌人 / 法师抓密集阵 / 牧师治疗低血友军",
    codePath: resolve(__dirname, "red-charger.js"),
  },
  "blue-turtle": {
    id: "blue-turtle",
    displayName: "Blue Turtle",
    style: "坚守阵地 / 保护远程 / 集火来袭单位",
    codePath: resolve(__dirname, "blue-turtle.js"),
  },
  "green-tactician": {
    id: "green-tactician",
    displayName: "Hermes Agent",
    style: "威胁优先级(牧师>法师>弓手) + 碰撞感知移动 + 低血收割 + 近战先行",
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
