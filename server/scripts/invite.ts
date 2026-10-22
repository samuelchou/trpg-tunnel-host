// 用法：npm run invite -- <名字> [--host]
// 同名玩家再執行一次會換發新 token，舊連結立即失效。
import { issueToken } from "../src/auth.js";
import { config } from "../src/config.js";

const args = process.argv.slice(2);
const isHost = args.includes("--host");
const name = args.filter((a) => a !== "--host").join(" ").trim();

if (!name) {
  console.error("用法：npm run invite -- <名字> [--host]");
  process.exit(1);
}

const { player, token } = issueToken(name, isHost ? "host" : "player");
console.log(`${player.role === "host" ? "主持人" : "玩家"}「${player.name}」的邀請連結：`);
console.log(`${config.publicUrl}/#t=${token}`);
