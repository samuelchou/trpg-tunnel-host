// 用法：npm run tunnel:setup -- <對外網址的主機名稱> [--name <tunnel 名稱>]
// 例如：npm run tunnel:setup -- trpg.example.com
//
// 前置：已安裝 cloudflared，並執行過 cloudflared tunnel login。
// 這支腳本會：建立 tunnel（已存在就沿用）→ 設定 DNS → 產生 tunnel/config.yml。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ROOT_DIR } from "../src/config.js";

const CLOUDFLARED_DIR = process.env.CLOUDFLARED_DIR ?? path.join(os.homedir(), ".cloudflared");
const CONFIG_FILE = path.join(ROOT_DIR, "tunnel", "config.yml");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function cloudflared(args: string[]): string {
  return execFileSync("cloudflared", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ---- 參數 ----
const args = process.argv.slice(2);
const nameIndex = args.indexOf("--name");
const tunnelName = nameIndex >= 0 ? args[nameIndex + 1] : "trpg-host";
const positional = nameIndex >= 0 ? args.filter((_, i) => i !== nameIndex && i !== nameIndex + 1) : args;
const hostname = positional[0]?.trim().toLowerCase();

if (!hostname || !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(hostname)) {
  fail("請提供對外網址的主機名稱，例如：npm run tunnel:setup -- trpg.example.com");
}
if (!tunnelName || !/^[A-Za-z0-9_-]+$/.test(tunnelName)) fail("tunnel 名稱只能用英數字、- 和 _");

// ---- 1. cloudflared 與登入 ----
try {
  console.log(`cloudflared：${cloudflared(["--version"]).trim()}`);
} catch {
  fail("找不到 cloudflared。請先安裝：brew install cloudflared");
}
if (!fs.existsSync(path.join(CLOUDFLARED_DIR, "cert.pem"))) {
  fail("還沒登入 Cloudflare。請先執行：cloudflared tunnel login（在瀏覽器選擇你的網域）");
}

// ---- 2. 建立或沿用 tunnel ----
function findTunnelId(): string | undefined {
  try {
    const list = JSON.parse(cloudflared(["tunnel", "list", "--output", "json"])) as {
      id: string;
      name: string;
      deleted_at?: string;
    }[];
    return list.find((t) => t.name === tunnelName && !t.deleted_at?.startsWith("2"))?.id;
  } catch {
    return undefined;
  }
}

let tunnelId = findTunnelId();
if (tunnelId) {
  console.log(`沿用既有的 tunnel「${tunnelName}」（${tunnelId}）`);
} else {
  console.log(`建立 tunnel「${tunnelName}」…`);
  let output: string;
  try {
    output = cloudflared(["tunnel", "create", tunnelName]);
  } catch (err) {
    fail(`建立 tunnel 失敗：${(err as { stderr?: string }).stderr ?? err}`);
  }
  tunnelId = findTunnelId() ?? output.match(UUID_RE)?.[0];
  if (!tunnelId) fail(`建立了 tunnel，但讀不到它的 ID。cloudflared 的輸出：\n${output}`);
  console.log(`已建立（${tunnelId}）`);
}

const credentialsFile = path.join(CLOUDFLARED_DIR, `${tunnelId}.json`);
if (!fs.existsSync(credentialsFile)) {
  fail(
    `找不到 tunnel 的憑證檔 ${credentialsFile}。\n` +
      "這個 tunnel 可能是在別台電腦建立的。可以改用 --name 建立新的 tunnel，或把憑證檔複製過來。",
  );
}

// ---- 3. DNS ----
try {
  cloudflared(["tunnel", "route", "dns", tunnelId, hostname]);
  console.log(`已把 ${hostname} 指向這個 tunnel`);
} catch (err) {
  const stderr = String((err as { stderr?: string }).stderr ?? err);
  if (/already exists/i.test(stderr)) {
    console.log(`${hostname} 已經有 DNS 紀錄，沿用（若指向別的服務，請到 Cloudflare 後台確認）`);
  } else {
    fail(`設定 DNS 失敗：${stderr}`);
  }
}

// ---- 4. 設定檔 ----
const yaml = `# 由 npm run tunnel:setup 產生，不進 git。
tunnel: ${tunnelId}
credentials-file: ${credentialsFile}

ingress:
  - hostname: ${hostname}
    service: http://127.0.0.1:${config.port}
  # 其他主機名稱一律回 404
  - service: http_status:404
`;
fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
fs.writeFileSync(CONFIG_FILE, yaml);
console.log(`已寫入 ${path.relative(ROOT_DIR, CONFIG_FILE)}`);

const publicUrl = `https://${hostname}`;
console.log("\n✓ 設定完成。接下來：");
if (config.publicUrl !== publicUrl) {
  console.log(`  1. 把 .env 的 PUBLIC_URL 改成 ${publicUrl}（邀請連結會用到），並重新產生邀請連結`);
} else {
  console.log("  1. .env 的 PUBLIC_URL 已經正確");
}
console.log("  2. 一個終端機執行：npm run dev    （啟動伺服器）");
console.log("  3. 另一個終端機執行：npm run tunnel  （開啟 tunnel）");
console.log(`  4. 打開 ${publicUrl}/healthz，看到 ok 就代表外網連得到了`);
