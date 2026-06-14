# 語音批次產生（Google TTS → S3）

從 PostgreSQL 讀取句子與單字，以 **Google Cloud Text-to-Speech** 產生 MP3 並上傳 **AWS S3**。

採用**策略 A**：S3 object key 與 DB 的 `audio_url` 完全一致（相對路徑），例如：

```text
audio/english/en-cafe/en-cafe-l01/s01.mp3
```

DB 寫入後不必再改 URL；之後新增資料，重跑腳本即可補齊缺少的語音檔。

## 檔案說明

| 檔案 | 說明 |
|------|------|
| `generate_audio.py` | 主程式：查 DB → Google TTS → 上 S3 |
| `requirements.txt` | Python 依賴 |
| `.env.example` | 環境變數範本 |
| `.env` | 實際設定（勿 commit） |
| `credentials/` | 可放 GCP 金鑰 JSON（勿 commit） |

---

## 運作流程

1. 從 DB 查詢 **英文 / 日文** 且 `is_published = true` 的資料：
   - `course_sentences` → `target_text` + `audio_url`
   - `course_vocabulary` → `term` + `audio_url`
2. 依 `scenarios.language` 選擇英文或日文 Google TTS 聲音
3. 產生 MP3，上傳至 S3（key = DB 的 `audio_url`）
4. S3 上**已存在**的檔案預設**跳過**；加 `--force` 才覆蓋
5. 若設定 `LOCAL_AUDIO_DIR`，會同時寫一份到本地 `app/frontend/audio/...`

```text
PostgreSQL                    Google TTS              AWS S3
──────────                    ──────────              ──────
course_sentences  ──text──►   產生 MP3   ──upload──►  audio/english/.../s01.mp3
course_vocabulary ──term──►                         （key = audio_url）
```

---

## 前置條件

### 1. 資料庫

PostgreSQL 已啟動，且已執行 [`spec/operate/SQL.md`](../spec/operate/SQL.md) 的建表與種子資料。

### 2. Google Cloud

1. 前往 [Google Cloud Console](https://console.cloud.google.com/) 建立專案
2. 啟用 **Cloud Text-to-Speech API**
3. **IAM → 服務帳號** → 建立帳號 → 建立 JSON 金鑰並下載
4. 金鑰路徑填入 `.env` 的 `GOOGLE_APPLICATION_CREDENTIALS`

建議將 JSON 放在 `script/credentials/`（已加入 `.gitignore`），**不要 commit**。

### 3. AWS S3

1. 建立 S3 bucket（例如 `learnflow-audio`）
2. IAM 使用者需具備權限：`s3:PutObject`、`s3:HeadObject`
3. 將 Access Key 填入 `.env`

---

## 安裝與設定

```bash
cd script
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

編輯 `.env`，填入下方必要變數。

---

## 環境變數（`.env`）

### 必填

| 變數 | 說明 | 範例 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 連線字串 | `postgresql://learnflow:learnflow_dev@127.0.0.1:5432/learnflow` |
| `GOOGLE_APPLICATION_CREDENTIALS` | GCP 服務帳號 JSON **絕對路徑** | `/Users/william/project/LearnFlow/script/credentials/google-tts.json` |
| `AWS_ACCESS_KEY_ID` | AWS Access Key | |
| `AWS_SECRET_ACCESS_KEY` | AWS Secret Key | |
| `AWS_REGION` | S3 所在區域 | `ap-northeast-1` |
| `S3_BUCKET` | Bucket 名稱 | `learnflow-audio` |

### 建議填（程式內有預設值）

| 變數 | 說明 | 預設 |
|------|------|------|
| `GOOGLE_TTS_VOICE_EN` | 英文 Neural 聲音 | `en-US-Neural2-J` |
| `GOOGLE_TTS_VOICE_JA` | 日文 Neural 聲音 | `ja-JP-Neural2-B` |
| `GOOGLE_TTS_SPEAKING_RATE` | 語速（0.25～4.0，學習建議略慢） | `0.9` |

### 選填

| 變數 | 說明 |
|------|------|
| `S3_PREFIX` | Bucket 內額外路徑前綴；DB 的 `audio_url` 已是 `audio/...` 時**留空** |
| `LOCAL_AUDIO_DIR` | 設為 `../app/frontend` 時，會同步寫入本地，方便 Docker / venv 測試播放 |

完整範本見 [`.env.example`](.env.example)。

---

## 執行

```bash
cd script
source .venv/bin/activate

# 預覽：只列出將處理的項目，不呼叫 TTS、不上傳
python generate_audio.py --dry-run

# 正式執行：只產 S3 上還沒有的檔案
python generate_audio.py

# 全部重產並覆蓋 S3 既有檔案
python generate_audio.py --force
```

### 執行結果範例

```text
共 135 筆 audio 任務（english + japanese）
WORK  [1/135] audio/english/en-cafe/en-cafe-l01/s01.mp3
SKIP  [2/135] audio/english/en-cafe/en-cafe-l01/s02.mp3（S3 已存在）

完成：新增/更新 80，跳過 55，失敗 0
```

---

## 策略 A：與前端 / EC2 的對接

DB 始終存**相對路徑**：

```text
audio/english/en-cafe/en-cafe-l01/s01.mp3
```

部署時擇一：

| 環境 | 作法 |
|------|------|
| 本地 Docker | S3 sync 到 `app/frontend/audio/`，或設 `LOCAL_AUDIO_DIR` 直接寫入 |
| EC2 | Nginx `/audio/` 反向代理至 S3 / CloudFront |
| 試營運 | CloudFront 對外提供 `https://cdn.example.com/audio/...` |

**DB 不需因上線而修改 `audio_url`。**

---

## 新增內容後如何補語音

1. 在 DB 新增句子 / 單字，並填好 `audio_url`（路徑格式與現有一致）
2. 再跑一次：

```bash
python generate_audio.py
```

腳本只會處理 S3 上**尚未存在**的 key。

---

## 常見問題

| 狀況 | 處理方式 |
|------|----------|
| `找不到 Google 金鑰檔` | 確認 `GOOGLE_APPLICATION_CREDENTIALS` 為 JSON 的**絕對路徑** |
| `缺少必要環境變數` | 對照上方表格補齊 `.env` |
| `共 0 筆 audio 任務` | 確認 DB 種子已寫入，且 `audio_url` 非空 |
| Google API 403 | 確認已啟用 Text-to-Speech API，服務帳號有權限 |
| S3 AccessDenied | 確認 IAM 有 `PutObject`、`HeadObject` |
| 本地播放 404 | 設 `LOCAL_AUDIO_DIR=../app/frontend` 重跑，或從 S3 sync 至 `app/frontend/audio/` |

---

## 成本粗估

以目前種子資料（約 81 句 + 54 單字 ≈ 135 段）：

- Google TTS：約數千～萬字元，通常 **< 1 USD**
- S3 儲存：135 個 MP3，**每月極低**
