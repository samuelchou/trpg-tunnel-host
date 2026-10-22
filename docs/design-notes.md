# TRPG 共享 AI GM：設計筆記

> 整理日期：2026-10-22

## 1. 問題

目前玩法：開一個 claude.ai 對話，所有玩家登入**同一個人的帳號**輪流打字。

- **安全風險**：共享 Google / Claude 帳號。且 claude.ai 帳號是個人使用，多人共用可能違反服務條款。
- **Token 浪費**：只有一個對話不停長大，每一輪都要重讀整串歷史，越玩越貴、越慢。

## 2. 核心方向

由 host 架一個伺服器，**Claude 的憑證（API key 或登入）只存在 host 端**；玩家透過 client 連到 host，不接觸任何帳號。上下文由程式管理，不讓對話無限長大。

## 3. 省 Token 的設計

### 3.1 分層上下文

每次呼叫 GM 時組合：

| 層 | 內容 | 說明 |
|---|---|---|
| 固定層 | GM 設定、規則摘要、世界觀 | 用 prompt caching，重複讀取約原價 1/20 |
| 狀態層 | 角色卡（HP、裝備、狀態）、NPC、地點、任務、線索 | 伺服器維護的結構化資料，每回合更新 |
| 劇情摘要層 | 每章幾百字的滾動摘要 | 可交給便宜模型（Haiku）整理 |
| 近況層 | 最近 10–20 則原文 + 本回合所有玩家行動 | |

### 3.2 其他手段

- **回合制呼叫**：收齊所有玩家行動（或 host 按「結算回合」）才呼叫 GM 一次，而非每句話都觸發。
- **模型分工**：GM 敘事用 Opus；摘要、狀態整理用 Haiku。
- **effort 調整**：日常劇情 `low`/`medium`，戰鬥解謎再調高。
- **預算上限**：Console 設每月上限，伺服器設每團預算。

### 3.3 工具（tool use）

讓 GM 呼叫伺服器函式而非自己編數字：

- `roll_dice("1d20+3")`：伺服器擲骰，公平且所有人可見
- `update_character(...)`、`add_item(...)`、`reveal_clue(...)`：寫回狀態層

## 4. TRPG 功能清單

- IC（角色發言）／OOC（玩家閒聊）分流，OOC 不送 AI
- 私訊 GM（秘密行動，只有該玩家看得到結果）
- Host 權限：重生成、撤銷、手動修正狀態、暫停 AI
- 存檔／讀檔（狀態層 + 摘要層即完整存檔）

## 5. 評估過的路線

| 路線 | 說明 | 結論 |
|---|---|---|
| Discord Bot | Discord 已處理帳號、聊天、同步，開發量最小 | 可行，但介面受限 |
| Claude Code Channels | 官方 Discord/Telegram plugin 把訊息推進執行中的 Claude Code session（研究預覽，CLI `--channels`） | 可快速實驗；但 Claude Code 有 Bash/檔案權限，allowlist 中的人等於能對 host 電腦下指令，需嚴格限制工具 |
| Remote Control | 自己從手機/網頁操作本機 session | 只適合單人，不適用多玩家 |
| **自建 HTML client + host 伺服器** | 瀏覽器透過 WebSocket 連 host；可做角色卡面板、擲骰動畫 | **採用** |

Client 不必做成執行檔：由 host 伺服器直接提供 HTML，玩家用瀏覽器開網址即可。日後真要執行檔可用 Tauri（輕量）或 Electron 包同一份 HTML。

## 6. 兩個部署方案（皆用 Cloudflare）

### 方案一：Cloudflare Tunnel + host 本機伺服器 ← **先實驗這個**

```
玩家瀏覽器 ──https──▶ Cloudflare ──Tunnel──▶ host 電腦上的 Node 伺服器 ──▶ Claude
```

- host 執行 `cloudflared tunnel`，得到 `trpg.<網域>` 網址，不需開路由器 port
- 伺服器在本機 → 可選 **Claude API** 或 **Agent SDK 接續 Claude Code session**
- 選這個的原因：**host 想在自己那邊的 session 設置背景資訊與提示詞**（例如 `CLAUDE.md`、世界觀檔、角色卡檔，Claude Code 能自己讀寫並自動壓縮 context）
- 缺點：開團時 host 電腦須開著

### 方案二：Cloudflare Workers + Durable Objects（全雲端）

```
玩家瀏覽器 ──WebSocket──▶ Worker ──▶ Durable Object（一團一個 DO）
                                      ├─ 連線管理、廣播
                                      ├─ 狀態存 DO 內建 SQLite
                                      └─ 呼叫 Claude API（key 為 Worker secret）
```

- 24 小時在線，可非同步玩
- 登入交給 Cloudflare Access（朋友 email 白名單 + 驗證碼）
- 限制：Workers 上不能跑 Claude Code，只能直接呼叫 Claude API

## 7. 待決定事項

- [ ] 方案一 GM 後端：直接呼叫 Claude API，還是 Agent SDK `--resume` 接續 host 的 Claude Code session？
  - 若用 Claude Code session：host 互動式操作與伺服器同時寫入同一個 session 會衝突，需規劃（例如 host 只在暫停時介入，或透過伺服器的 host 指令發言）
  - 必須關閉 Bash、網路等工具，只允許讀寫 GM 資料夾
- [ ] 憑證：用 Console API key（按量計費、可設上限），避免把個人 Pro/Max 訂閱開給多人使用
- [ ] 玩家驗證：房間碼 + 個人 token，或 Cloudflare Access
- [ ] 規則系統（D&D 5e / CoC 7th / 自創）與玩家人數 → 影響狀態層與角色卡格式
