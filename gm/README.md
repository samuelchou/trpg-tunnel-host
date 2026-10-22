# GM 設定

這個資料夾是 GM 的工作資料夾（Claude Code 的工作目錄）。主持人在這裡寫背景與提示詞，GM 在這裡讀寫角色卡與劇情。

| 檔案 | 誰寫 | 說明 |
|---|---|---|
| `CLAUDE.md` | 主持人 | GM 的人設、語氣、規則、回合格式。每回合自動載入 |
| `world.md` | 主持人 | 世界觀、地點、NPC、主線。GM 只能讀 |
| `characters/<玩家名字>.md` | 主持人建立，GM 更新 | 角色卡。檔名要跟邀請時用的名字一樣 |
| `story/summary.md` | GM | 劇情摘要，每結束一個場景補一段 |
| `.claude/settings.json` | — | 權限規則：禁止 Bash／網路，GM 只能改 `characters/` 和 `story/` |
| `saves/` | 伺服器 | 玩家名單、遊戲紀錄、session ID（不進 git，GM 讀不到） |
