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

## 目錄

| 路徑 | 用途 |
|---|---|
| `gm/` | host 放 GM 設定的地方：系統提示詞、世界觀、角色卡、劇情摘要 |
| `server/` | （待建）host 伺服器 |
| `client/` | （待建）HTML client，由伺服器直接提供 |

## 待決定

- ~~GM 後端~~：已決定用 Agent SDK 接續 host 的 Claude Code session
- 玩家驗證方式：房間碼 + 個人 token，或 Cloudflare Access
- 規則系統與玩家人數
