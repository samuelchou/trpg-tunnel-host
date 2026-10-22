# 用 Cloudflare Tunnel 讓朋友從外網連進來

伺服器只監聽 `127.0.0.1`，外面連不到。Cloudflare Tunnel 會從你的電腦主動連到 Cloudflare，再把 `https://trpg.<你的網域>` 的流量轉回本機伺服器，所以**不用開路由器的 port**，HTTPS 憑證也由 Cloudflare 處理。

```
朋友的瀏覽器 ──https/wss──▶ Cloudflare ──tunnel──▶ cloudflared（你的電腦）──▶ 127.0.0.1:3000
```

需要：一個已經加進 Cloudflare 的網域（DNS 由 Cloudflare 管理）。

## 1. 安裝 cloudflared

```bash
brew install cloudflared
```

確認裝好：

```bash
cloudflared --version
```

## 2. 登入 Cloudflare

```bash
cloudflared tunnel login
```

瀏覽器會打開 Cloudflare 的授權頁，**選擇你要用的網域**後按授權。完成後會在 `~/.cloudflared/cert.pem` 存一份帳號憑證，之後建立 tunnel、設定 DNS 都靠它。

> `cert.pem` 和之後產生的 `~/.cloudflared/<tunnel ID>.json` 都是憑證，不要傳給別人，也不要放進 git。

## 3. 建立 tunnel 並產生設定檔

在 `server/` 底下執行（把網址換成你的）：

```bash
npm run tunnel:setup -- trpg.example.com
```

這會依序：

1. 建立名為 `trpg-host` 的 tunnel（已經存在就沿用；想用別的名字加 `--name 名字`）
2. 在 Cloudflare DNS 新增 `trpg.example.com`，指向這個 tunnel
3. 產生 `tunnel/config.yml`（不進 git），把 `trpg.example.com` 轉到 `http://127.0.0.1:<PORT>`

## 4. 更新邀請連結的網址

把 repo 根目錄 `.env` 的 `PUBLIC_URL` 改成：

```
PUBLIC_URL=https://trpg.example.com
```

之前產生的邀請連結還是 `http://localhost:3000/…`，要**重新產生**才會是外網網址（舊 token 會一起失效）：

```bash
npm run invite -- 阿明
```

## 5. 開團時啟動

需要兩個終端機，都在 `server/` 底下：

```bash
npm run dev
```

```bash
npm run tunnel
```

打開 `https://trpg.example.com/healthz`，看到 `ok` 就代表外網連得到了。最好用手機的行動網路（不連家裡 Wi-Fi）開一次邀請連結，確認玩家那邊真的進得來。

## 常見問題

| 狀況 | 原因與處理 |
|---|---|
| 瀏覽器顯示 Cloudflare **Error 1033** | tunnel 沒在跑。確認 `npm run tunnel` 還開著 |
| 顯示 **502 Bad Gateway** | tunnel 有在跑，但本機伺服器沒開，或 `.env` 的 `PORT` 跟 `config.yml` 對不上。改過 `PORT` 要重跑 `tunnel:setup` |
| `tunnel:setup` 說 DNS 紀錄已存在 | 這個主機名稱已經有 DNS 紀錄。如果原本指向別的服務，到 Cloudflare 後台 DNS 頁面刪掉後再執行一次 |
| `tunnel:setup` 說找不到憑證檔 | tunnel 是在別台電腦建立的。用 `--name` 建一個新的，或把那台的 `~/.cloudflared/<ID>.json` 複製過來 |
| 頁面打得開但一直「連線中」 | WebSocket 沒接上。確認是用 `https://` 開（不是 `http://`），並看 `npm run dev` 的終端機有沒有錯誤 |
| 邀請連結還是 localhost | `PUBLIC_URL` 沒改，或改了之後沒重新產生邀請連結 |

## 只想先試試看：Quick Tunnel

不想動自己的網域，可以先用 Cloudflare 的臨時網址（不需要登入）：

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

它會印出一個 `https://<隨機字>.trycloudflare.com` 網址。每次啟動網址都會變，而且沒有服務保證，只適合測試。邀請連結要手動把 `http://localhost:3000` 換成這個網址（`#t=` 後面的 token 不變）。

## 安全性

- **伺服器只聽 `127.0.0.1`**：外部只能經由 tunnel 進來。不要把 `.env` 的 `HOST` 改成 `0.0.0.0`。
- **知道網址不等於能進來**：每個人都需要自己的邀請 token。token 外流時，用同一個名字重新 `invite`，舊連結就會立即失效。
- **主持人的連結特別重要**：它能下指示、暫停、中斷 GM，也看得到所有私密內容。不要貼在群組裡。

### 進階：加一層 Cloudflare Access（選用）

想讓陌生人連頁面都打不開，可以在 Cloudflare Zero Trust 後台加一層 Access：

1. **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**
2. **Application domain** 填 `trpg.example.com`
3. 新增一條 **Allow** policy，**Include** 選 **Emails**，填入每位玩家的 email
4. 登入方式用預設的 **One-time PIN**（Cloudflare 寄驗證碼到 email）

之後朋友第一次開網址時，要先輸入 email 收驗證碼，通過後才會看到遊戲頁面，再用邀請 token 辨識身分。兩層都通過才進得來。
