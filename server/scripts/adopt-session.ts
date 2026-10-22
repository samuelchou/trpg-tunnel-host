// 用法：npm run adopt-session -- <session ID>
// 讓伺服器接續主持人在 gm/ 用 claude 開的 session（Session 0）。請在伺服器停止時執行。
// 不帶參數則顯示目前的 session；帶 --new 則清除，下一回合會建立新的 session。
import { loadState, saveState } from "../src/store.js";

const arg = process.argv[2];
const state = loadState();

if (!arg) {
  console.log(state.sessionId ? `目前接續的 session：${state.sessionId}` : "目前沒有接續中的 session");
  process.exit(0);
}

if (arg === "--new") {
  delete state.sessionId;
  saveState(state);
  console.log("已清除 session，下一回合會建立新的 session");
  process.exit(0);
}

if (!/^[0-9a-f-]{36}$/i.test(arg)) {
  console.error("session ID 格式不對，應該像 5b3f2c1a-8d4e-4f6b-9a7c-2e1d0f9b8a6c");
  process.exit(1);
}

state.sessionId = arg;
saveState(state);
console.log(`伺服器之後會接續 session ${arg}`);
