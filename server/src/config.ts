import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, "../..");

/** 讀 repo 根目錄的 .env（KEY=VALUE，# 開頭為註解）；已存在的環境變數優先 */
function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    const value = raw.replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT_DIR, ".env"));

const port = Number(process.env.PORT ?? 3000);

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port,
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
  clientDir: path.join(ROOT_DIR, "client"),
  gmDir: path.join(ROOT_DIR, "gm"),
  savesDir: process.env.SAVES_DIR
    ? path.resolve(process.env.SAVES_DIR)
    : path.join(ROOT_DIR, "gm", "saves"),
  /** 重連時送給 client 的最近事件數 */
  historyLimit: 200,
  maxChatLength: 2000,
  /** 連線後必須在這段時間內送出 hello */
  helloTimeoutMs: 5000,
  /** 每個連線在 rateWindowMs 內最多 rateMaxMessages 則訊息 */
  rateWindowMs: 10_000,
  rateMaxMessages: 15,
  gm: {
    /** GM_MOCK=1 時不呼叫 Claude，改用假的 GM（開發與測試用） */
    mock: process.env.GM_MOCK === "1",
    /** 模擬 GM 每個字的間隔（毫秒），測試中斷時可以調慢 */
    mockDelayMs: Number(process.env.GM_MOCK_DELAY_MS ?? 5),
    model: process.env.GM_MODEL ?? "claude-opus-5-5",
    effort: (process.env.GM_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max",
    /** 單一回合的花費上限（美元，SDK 的估算值） */
    maxBudgetPerRoundUsd: Number(process.env.GM_MAX_BUDGET_PER_ROUND_USD ?? 1),
    /** 單一回合內 GM 最多的工具呼叫輪數 */
    maxTurns: 20,
  },
};
