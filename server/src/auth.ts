import crypto from "node:crypto";
import { loadPlayers, savePlayers, type PlayerRecord, type Role } from "./store.js";

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** 建立玩家或為既有玩家換發 token；回傳原始 token（只會出現這一次） */
export function issueToken(name: string, role: Role): { player: PlayerRecord; token: string } {
  const token = crypto.randomBytes(24).toString("base64url");
  const players = loadPlayers();
  let player = players.find((p) => p.name === name);
  if (player) {
    player.tokenHash = hashToken(token);
    player.role = role;
  } else {
    player = {
      id: crypto.randomUUID(),
      name,
      role,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
    };
    players.push(player);
  }
  savePlayers(players);
  return { player, token };
}

/** 每次驗證都重讀 players.json，讓 npm run invite 換發的 token 不必重啟伺服器就生效 */
export function authenticate(token: string): PlayerRecord | undefined {
  const hash = Buffer.from(hashToken(token), "hex");
  return loadPlayers().find((p) =>
    crypto.timingSafeEqual(Buffer.from(p.tokenHash, "hex"), hash),
  );
}
