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

const playersFile = path.join(config.savesDir, "players.json");
const logFile = path.join(config.savesDir, "log.jsonl");

function ensureSavesDir() {
  fs.mkdirSync(config.savesDir, { recursive: true });
}

export function loadPlayers(): PlayerRecord[] {
  if (!fs.existsSync(playersFile)) return [];
  return JSON.parse(fs.readFileSync(playersFile, "utf8")).players ?? [];
}

export function savePlayers(players: PlayerRecord[]) {
  ensureSavesDir();
  // 先寫暫存檔再改名，避免寫到一半當掉留下壞檔
  const tmp = `${playersFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ players }, null, 2));
  fs.renameSync(tmp, playersFile);
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
