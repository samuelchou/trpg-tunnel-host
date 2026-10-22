# Server 骨架規劃（方案一：Agent SDK 版）

> 2026-10-22。GM 後端確定採用 Claude Agent SDK（TypeScript，`@anthropic-ai/claude-agent-sdk`），以 `resume` 接續 host 的 Claude Code session。

## 1. 核心概念

- **`gm/` 是 GM 的工作資料夾**，也是 Agent SDK 的 `cwd`。host 在這裡寫背景與提示詞，GM 在這裡讀寫角色卡與劇情。
- **整場團 = 一個 Claude Code session。** session ID 存在 `gm/saves/state.json`，伺服器每回合用 `resume` 接續；context 過長時由 Claude Code 自動壓縮。
- **伺服器是唯一會對 session 發話的程式。** 玩家和 host 都透過網頁 client 發言，伺服器排隊後依序送進 session。

```
玩家／host 瀏覽器 ──WebSocket──▶ server（Node）
                                   ├─ auth：邀請 token → 玩家身分
                                   ├─ room：收集回合行動、廣播、事件紀錄
                                   └─ gm：一次只跑一個 query()
                                         query({ prompt, options: { cwd: "gm/", resume: sessionId, ... } })
                                               │
                                               ├─ 讀：gm/CLAUDE.md、world.md、characters/*.md
                                               ├─ 寫：characters/*.md、story/*.md
                                               └─ 自訂工具：roll_dice、send_private …（in-process MCP）
```

## 2. host 怎麼設定背景與提示詞

| 檔案 | 用途 | 載入方式 |
|---|---|---|
| `gm/CLAUDE.md` | GM 人設、語氣、規則、回合格式、使用工具的規定 | `settingSources: ["project"]`，每次 query 自動載入 |
| `gm/world.md` | 世界觀、地點、NPC | CLAUDE.md 指示 GM 需要時 Read |
| `gm/characters/<玩家>.md` | 角色卡（數值、裝備、狀態） | GM 讀寫 |
| `gm/story/summary.md` | 劇情摘要（GM 每章結束時更新） | GM 讀寫 |
| `gm/.claude/settings.json` | 權限規則（禁止 Bash、網路，限制只能寫 characters/ 與 story/） | `settingSources: ["project"]` |

**開團前（Session 0）**：host 可以直接在 `gm/` 執行 `claude`，跟 GM 對話討論設定。準備好之後，把那個 session 的 ID 交給伺服器（`npm run adopt-session <id>`），伺服器就從這個 session 接續。

**開團中**：host 不要另外開 CLI 寫入同一個 session，兩個程序同時寫入會衝突。host 改從網頁的 host 面板發言：
- **GM 指示**（只有 GM 看得到，例如「讓 BOSS 在這回合登場」）：以 `【主持人指示】` 前綴併入下一回合的 prompt
- **暫停**：伺服器停止送出回合。暫停期間 host 可以用 `claude --resume <id>` 進去改設定，結束後再按「繼續」

## 3. Agent SDK 呼叫設定

```ts
query({
  prompt: roundPrompt,
  options: {
    cwd: GM_DIR,
    resume: state.sessionId,          // 第一回合沒有 → 建新 session，從 init 訊息拿 session_id
    settingSources: ["project"],      // 只載 gm/ 的 CLAUDE.md 與 settings，不載 host 個人設定與 plugin
    tools: ["Read", "Write", "Edit", "Glob", "Grep"],  // 可用工具白名單，不含 Bash / Web
    disallowedTools: ["Bash", "WebFetch", "WebSearch"],
    permissionMode: "dontAsk",        // 沒被允許的動作一律拒絕，不會卡在權限提示
    allowedTools: [
      "Read", "Glob", "Grep",
      "Edit(characters/**)", "Write(characters/**)",
      "Edit(story/**)", "Write(story/**)",
      "mcp__trpg__roll_dice", "mcp__trpg__send_private",
    ],
    mcpServers: { trpg: trpgToolServer },
    model: config.model,              // 預設 claude-opus-5-5
    effort: config.effort,            // 預設 medium
    maxBudgetUsd: config.maxBudgetPerRound,
    includePartialMessages: true,     // 串流給 client
    abortController,                  // host 可中斷
  },
});
```

保險：再加一個 `PreToolUse` hook，檢查所有檔案路徑都在 `gm/` 底下，不在就拒絕。

> **M2 實作時的修正**
> - 原本打算用 `canUseTool`，但在 `dontAsk` 模式下它根本不會被呼叫，所以改用 `PreToolUse` hook（`server/src/gm.ts` 的 `guardTools`）。
> - `allowedTools` 不放不帶路徑的 `Read`：不帶路徑的規則會放行任何路徑。在工作資料夾內讀檔本來就不需要授權，所以只放 `Edit(characters/**)`、`Edit(story/**)`（Edit 規則同時適用於 Write）。
> - `gm/.claude/settings.json` 另外 deny 了 Bash、Web 工具、修改 `world.md`／`CLAUDE.md`，以及讀取 `saves/`。主持人自己在 `gm/` 開 `claude` 時也會套用這些規則。

## 4. 自訂工具（in-process MCP，`createSdkMcpServer` + `tool()`）

| 工具 | 參數 | 行為 |
|---|---|---|
| `roll_dice` | `notation`（如 `1d20+3`）、`reason`、`player?` | 伺服器擲骰，回傳結果給 GM，同時廣播給所有人（顯示擲骰動畫） |
| `send_private` | `player`、`text` | 只傳給指定玩家（秘密行動的結果、私人線索） |

GM 最後的文字回覆 = 公開敘事，廣播給所有人。

## 5. 回合流程

1. 玩家送出行動，分三種模式：`ic`（角色行動）、`ooc`（閒聊，不送 GM）、`private`（秘密行動，只有 GM 看得到）
2. 伺服器把行動收進目前回合，所有人都看得到「誰已行動」
3. 結算時機：所有在線玩家都送出了，或 host 按「結算」
4. 組合 prompt：
   ```
   【回合 12】
   - 阿明（艾琳／精靈遊俠）：我搜索書架。
   - 小華（托爾／矮人戰士）：我守在門口。
   - 【私密】小美（夜影／盜賊）：趁亂把桌上的鑰匙收進口袋。
   【主持人指示】讓守衛在這回合出現。
   ```
5. `query()` 串流：文字增量廣播 `gm_delta`，工具事件即時處理，結束時廣播 `gm_done`
6. 更新 `state.json`（sessionId、回合數、累計花費），把事件寫進 `saves/log.jsonl`

GM 執行中收到的新行動會先排進下一回合。

## 6. WebSocket 協定（草案）

**client → server**

| type | 內容 | 誰可以用 |
|---|---|---|
| `action` | `{ mode: "ic" \| "ooc" \| "private", text }` | 玩家 |
| `withdraw` | 撤回本回合的行動 | 玩家 |
| `resolve_round` | 立即結算 | host |
| `gm_note` | 主持人指示，併入下一回合 | host |
| `pause` / `unpause` | 暫停／繼續 GM | host |
| `abort` | 中斷正在跑的 GM 回應 | host |

**server → client**

| type | 內容 |
|---|---|
| `snapshot` | 連線或重連時送：玩家列表、回合狀態、最近 N 筆事件 |
| `chat` | OOC 訊息、公開事件 |
| `round_status` | 誰已行動、是否等待中 |
| `gm_delta` / `gm_done` | GM 敘事串流與結束 |
| `dice` | 擲骰結果 |
| `private` | 私人訊息（只送給該玩家） |
| `error` | 錯誤 |

## 7. 驗證

- 一個伺服器 = 一場團，不做多房間
- `npm run invite <玩家名>` 產生個人 token，存在 `gm/saves/players.json`，給玩家的連結是 `https://trpg.<網域>/#t=<token>`（用 hash，token 不會進 Cloudflare 的請求 log）
- host 有一組獨立的 host token
- 之後可以在 Cloudflare 前面加 Access（email 白名單），當第二層防護

## 8. 憑證與成本

- `.env` 設 `ANTHROPIC_API_KEY`（Console 申請，按用量計費，可設上限）。不要用個人 Pro/Max 訂閱開給多人使用
- `maxBudgetUsd` 限制每回合花費；`result` 訊息的 `total_cost_usd` 累計到 `state.json`，顯示在 host 面板
- Claude Code 的系統提示加上工具定義，每回合都有固定開銷，但會被 prompt cache 快取

## 9. 目錄結構

```
server/
  package.json, tsconfig.json
  src/
    index.ts        HTTP（提供 client 靜態檔）+ WebSocket 入口
    config.ts       讀 .env 與預設值
    auth.ts         token 驗證、玩家與 host 身分
    protocol.ts     client/server 訊息型別
    room.ts         連線、回合收集、廣播
    gm.ts           Agent SDK 包裝：排隊、query、串流、存 sessionId
    tools.ts        roll_dice、send_private
    dice.ts         擲骰表示法解析
    store.ts        state.json、log.jsonl、players.json 讀寫
  scripts/
    invite.ts       產生玩家 token
    adopt-session.ts  指定要接續的 session ID
client/
  index.html, app.js, style.css
gm/
  CLAUDE.md         GM 提示詞範本（host 改寫）
  world.md
  characters/  story/
  .claude/settings.json
  saves/            （不進 git）
.env.example
docs/cloudflare-tunnel.md
```

技術選擇：Node 22+、TypeScript、`ws`（WebSocket）、`zod`（工具參數驗證）、`tsx`（開發時直接執行）。HTTP 用 Node 內建模組，不另外裝框架。client 用純 HTML/JS，不需要建置步驟。

## 10. 里程碑

| # | 內容 | 完成標準 |
|---|---|---|
| M1 ✅ | server + WebSocket + client 聊天、token 驗證 | 兩個瀏覽器分頁能互相看到 OOC 訊息，重連後有歷史紀錄 |
| M2 ✅ | 接上 Agent SDK：回合結算 → GM 回應串流 | 送出行動後，所有人都看到 GM 敘事逐字出現；重啟伺服器後能接續同一個 session |
| M3 | `roll_dice`、`send_private`、私密行動 | GM 擲骰時所有人看到結果；私密內容只有當事人看得到 |
| M4 | host 面板：結算、GM 指示、暫停、中斷、花費顯示 | host 不開 CLI 也能控場 |
| M5 | Cloudflare Tunnel 設定文件 | 朋友從外網用連結加入 |

## 11. 待決定

- 規則系統與玩家人數（影響 `CLAUDE.md` 範本和角色卡格式）
- host 自己是否也扮演角色（是的話 host token 要同時具備玩家身分）
- 回合結算要不要加逾時（例如 5 分鐘沒動作就自動結算）
