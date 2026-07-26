# LearnFlow Chrome 擴充（YouTube 沈浸式學習）

在 YouTube 字幕上點單字看 AI 翻譯，收藏單字/整句與影片時間點到 LearnFlow，
回平台自動進入 FSRS 複習排程。

## 安裝（開發者模式）

1. 先在瀏覽器登入 LearnFlow 網站（預設 `http://localhost`）。
2. 打開 `chrome://extensions`，右上角開啟「開發者模式」。
3. 「載入未封裝項目」→ 選擇本資料夾 `app/extension/`。
4. 點擊工具列的擴充圖示 → 確認「LearnFlow 網址」→ 儲存。
   - 狀態列顯示「已登入 ✓」代表能讀到網站登入 cookie。

## 使用

打開一支有字幕（CC）的 YouTube 影片並開啟字幕，播放器右下角會出現兩個 LearnFlow 按鈕：

| 按鈕 | 作用 |
|---|---|
| **開啟／關閉** pill | 主開關。關閉後雙字幕、點字翻譯、懸停暫停全部停用。 |
| **齒輪** | 打開設定面板（母語、學習語言、進階設定）。 |

- **雙字幕**：原字幕下方自動顯示中文翻譯（可在設定面板關閉）。
- **點字幕上的字** → 出現翻譯浮動卡（單字字義＋整句真義＋發音）。
- 「＋ 儲存單字」或「＋ 儲存整句」→ 收藏並自動排入複習。
- 回 LearnFlow →「收藏 › YouTube 收藏」看到項目與「跳回影片」；「複習」頁走 FSRS 複習曲線。

### 設定面板（播放器右下角齒輪）
- **母語**：翻譯要翻成什麼語言
- **學習語言**：影片本身的語言（日文／英文）
- **進階設定**（可摺疊）
  - 顯示字幕翻譯：開／關雙字幕
  - 懸停自動暫停：滑鼠移到字幕上自動暫停，移開續播
  - 字幕大小：75%–200%

> 工具列 popup 只保留「LearnFlow 網址」與登入狀態；學習相關設定都在播放器內的齒輪面板。

## 運作與權限

- `cookies` + host 權限：讀取網站的 HttpOnly `refresh_token`，向後端 `POST /api/user/extension/token`
  換取短效 access token（**不輪替**，不影響網站分頁 session）。token 只留在 background。
- 需驗證的 API 呼叫（translate / captures）皆由 background 代發，帶 `Authorization: Bearer`。
- 翻譯使用免費資源（MyMemory + Jisho），無需金鑰；但**強烈建議**在後端 `.env` 填
  `MYMEMORY_EMAIL`——MyMemory 匿名額度只有 5,000 字元/日，填 email 後提升為 50,000
  字元/日。常駐雙字幕逐句翻譯很吃額度，不填很容易當天就用完。
- 每句翻譯都會寫入 `translation_cache`，重看同一支影片或別人看過的句子不再消耗額度。
- 後端 CORS 已放行 `chrome-extension://<id>`；正式環境可用 `EXTENSION_ORIGIN` 精確指定。

## 疑難排解

- 「尚未登入」：先在網站登入；確認擴充設定的網址與登入網址一致（含 port）。
- 點字沒反應：確認字幕已開啟（畫面有 CC 文字）、且 pill 是「開啟」狀態。
- 看不到播放器按鈕：重新整理該 YouTube 分頁（改過擴充後必須重整分頁）。
- 雙字幕沒出現：確認 CC 已開、設定面板的「顯示字幕翻譯」為開。
- 播放器顯示「翻譯額度可能已用盡」：當日 MyMemory 額度用完，請在後端 `.env` 設定
  `MYMEMORY_EMAIL` 並重啟後端，隔日額度會重置。
