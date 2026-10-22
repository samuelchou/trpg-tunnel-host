import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { GameEvent } from "./protocol.js";

export type Role = "player" | "host";

export interface PlayerRecord {
  id: string;
  name: string;
  role: Role;
  /** token 的 sha256，原始 token 不落地 */
  tokenHash: string;
  createdAt: string;
}

export interface GameState {
  /** 接續中的 Claude Code session；沒有的話下一回合會建立新的 */
  sessionId?: string;
  /** 下一個要結算的回合編號 */
  round: number;
  totalCostUsd: number;
}

const playersFile = path.join(config.savesDir, "players.json");
const logFile = path.join(config.savesDir, "log.jsonl");
const stateFile = path.join(config.savesDir, "state.json");

function ensureSavesDir() {
  fs.mkdirSync(config.savesDir, { recursive: true });
}

function writeJsonAtomic(file: string, data: unknown) {
  ensureSavesDir();
  // 先寫暫存檔再改名，避免寫到一半當掉留下壞檔
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function loadState(): GameState {
  if (!fs.existsSync(stateFile)) return { round: 1, totalCostUsd: 0 };
  return { round: 1, totalCostUsd: 0, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) };
}

export function saveState(state: GameState) {
  writeJsonAtomic(stateFile, state);
}

export function loadPlayers(): PlayerRecord[] {
  if (!fs.existsSync(playersFile)) return [];
  return JSON.parse(fs.readFileSync(playersFile, "utf8")).players ?? [];
}

export function savePlayers(players: PlayerRecord[]) {
  writeJsonAtomic(playersFile, { players });
}

export function appendEvent(event: GameEvent) {
  ensureSavesDir();
  fs.appendFileSync(logFile, JSON.stringify(event) + "\n");
}

export function loadRecentEvents(limit: number): GameEvent[] {
  if (!fs.existsSync(logFile)) return [];
  const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line) as GameEvent);
}
