# LearnFlow Chrome 擴充（YouTube 沈浸式學習）

在 YouTube 字幕上點單字看 AI 翻譯，收藏單字/整句與影片時間點到 LearnFlow，
回平台自動進入 FSRS 複習排程。

## 安裝（開發者模式）

1. 先在瀏覽器登入 LearnFlow 網站（預設 `http://localhost`）。
2. 打開 `chrome://extensions`，右上角開啟「開發者模式」。
3. 「載入未封裝項目」→ 選擇本資料夾 `app/extension/`。
4. 點擊工具列的擴充圖示 → 設定「LearnFlow 網址」「影片語言」「翻譯成」→ 儲存。
   - 狀態列顯示「已登入 ✓」代表能讀到網站登入 cookie。

## 使用

1. 打開一支有字幕（CC）的 YouTube 影片，開啟字幕。
2. 點字幕上的字 → 出現翻譯浮動卡。
3. 「＋ 儲存單字」或「＋ 儲存整句」→ 收藏並自動排入複習。
4. 回 LearnFlow →「收藏 › YouTube 收藏」看到項目與「跳回影片」；「複習」頁走 FSRS 複習曲線。

## 運作與權限

- `cookies` + host 權限：讀取網站的 HttpOnly `refresh_token`，向後端 `POST /api/user/extension/token`
  換取短效 access token（**不輪替**，不影響網站分頁 session）。token 只留在 background。
- 需驗證的 API 呼叫（translate / captures）皆由 background 代發，帶 `Authorization: Bearer`。
- 後端需設定 `ANTHROPIC_API_KEY`（翻譯用 Claude），並允許擴充來源（`main.py` CORS 已放行
  `chrome-extension://<id>`；正式環境可用 `EXTENSION_ORIGIN` 精確指定）。

## 疑難排解

- 「尚未登入」：先在網站登入；確認擴充設定的網址與登入網址一致（含 port）。
- 點字沒反應：確認字幕已開啟（畫面有 CC 文字）；某些播放器樣式的字幕 class 可能不同。
- 翻譯失敗：確認後端已設 `ANTHROPIC_API_KEY` 並重啟。
