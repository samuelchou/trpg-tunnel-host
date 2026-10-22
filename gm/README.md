# GM 設定

host 在這裡放 GM 的背景資訊與提示詞，伺服器每次呼叫 GM 時會讀取。預計結構：

- `system-prompt.md`：GM 的角色、語氣、規則（固定層，會被快取）
- `world.md`：世界觀、地點、重要 NPC
- `characters/`：每位玩家的角色卡
- `saves/`：執行中的狀態與劇情摘要（不進 git）
