# TRPG Tunnel Host

多人 TRPG 的 AI GM 主機（方案一）：host 在自己的電腦上執行伺服器，透過 Cloudflare Tunnel 對外開放，玩家用瀏覽器連線同步遊玩。Claude 的憑證只存在 host 端，玩家不需共用任何帳號。

完整設計背景見 [docs/design-notes.md](docs/design-notes.md)，server 規劃見 [docs/server-plan.md](docs/server-plan.md)。

## 架構

```
玩家瀏覽器 ──https/WebSocket──▶ Cloudflare ──Tunnel──▶ host 電腦
                                                      ├─ Node 伺服器
                                                      │   ├─ 房間／玩家驗證
                                                      │   ├─ 回合收集、擲骰、IC/OOC 分流
                                                      │   └─ 呼叫 Claude（GM）
                                                      └─ gm/  ← host 自訂的背景、提示詞、狀態
```

## 目前進度

- [x] M1：伺服器、WebSocket、聊天、邀請 token 驗證、斷線重連後補歷史
- [x] M2：接上 Agent SDK，回合結算 → GM 回應串流
- [x] M3：擲骰、私密行動
- [ ] M4：host 控場面板
- [ ] M5：Cloudflare Tunnel 設定

## 快速開始

需要 Node.js 22 LTS。

```bash
cp .env.example .env              # 填入 ANTHROPIC_API_KEY
cd server
npm install
npm run invite -- 主持人 --host   # 印出主持人的邀請連結
npm run invite -- 阿明            # 每位玩家各產生一條
npm run dev                       # 啟動伺服器（修改程式會自動重啟）
```

打開邀請連結就能加入。連結裡的 token 只會顯示一次；同一個名字再執行一次 `invite` 會換發新 token，舊連結會立即失效。

想先試介面、不花 token 的話，用模擬 GM 啟動：

```bash
GM_MOCK=1 npm run dev
```

## 怎麼玩

- **角色行動**：描述角色這回合要做什麼。送出後可以撤回或重送（以最後一次為準）。
- **私密行動**：只有 GM 看得到的行動。GM 會用私訊回覆結果，其他玩家只會看到「已行動」。
- **閒聊**：玩家之間聊天，GM 看不到。
- **擲骰**：GM 需要判定時由伺服器擲骰，所有人都看得到點數；私密行動的檢定只有當事人看得到。
- **主持人看得到所有私密行動、私密擲骰與私訊**。如果主持人自己也扮演角色，要記得這一點。
- 所有在線玩家都送出行動後，回合會自動結算；主持人也可以按「立即結算」，不等還沒行動的人。
- GM 回應時，大家可以先送出下一回合的行動。

## 主持人設定 GM

在 `gm/` 底下設定（見 [gm/README.md](gm/README.md)）：

- `CLAUDE.md`：GM 的人設、語氣、規則
- `world.md`：世界觀
- `characters/<玩家名字>.md`：角色卡（範本在 `characters/_template.md`）

整場團接續同一個 Claude Code session，session ID 存在 `gm/saves/state.json`。想先在 `gm/` 用 `claude` 跟 GM 討論設定（Session 0），再讓伺服器接手：

```bash
npm run adopt-session -- <session ID>   # 在伺服器停止時執行
npm run adopt-session                   # 查看目前的 session
npm run adopt-session -- --new          # 清除，下一回合開新 session
```

開團中不要同時用 `claude --resume` 操作同一個 session，兩邊同時寫入會衝突。

玩家名單、遊戲紀錄、存檔都在 `gm/saves/`（不進 git）。

## 目錄

| 路徑 | 用途 |
|---|---|
| `gm/` | host 放 GM 設定的地方：系統提示詞、世界觀、角色卡、劇情摘要 |
| `server/` | host 伺服器（Node + TypeScript + `ws` + Claude Agent SDK） |
| `client/` | HTML client，由伺服器直接提供 |

## 待決定

- ~~GM 後端~~：已決定用 Agent SDK 接續 host 的 Claude Code session
- ~~玩家驗證方式~~：個人邀請 token（之後可在 Cloudflare 前面加 Access 作為第二層）
- 規則系統與玩家人數
