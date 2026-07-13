# LearnFlow 資料庫 SQL

本目錄描述**目前已實作並由後端使用**的 PostgreSQL 結構。完整產品願景（學習進度、SM-2 複習、AI 對話等）見 [`../document/database_spec.md`](../document/database_spec.md)，其中多數表**尚未建表**。

---

## 檔案說明

| 檔案 | 用途 |
|------|------|
| [`schema.sql`](./schema.sql) | **純 DDL（權威來源）**：EXTENSION、ENUM、全部已實作資料表與索引；**不含** INSERT |
| [`../operate/scenario_seed.sql`](../operate/scenario_seed.sql) | 同上 DDL（auth 用 `IF NOT EXISTS`）+ 情境種子資料；會 **DROP 重建** 四張內容表 |
| [`../operate/generate_scenario_seed.py`](../operate/generate_scenario_seed.py) | 從 `seed_content.py` 重新產生 `scenario_seed.sql` |
| [`../../deploy/init/001_extensions.sql`](../../deploy/init/001_extensions.sql) | Docker Postgres 首次啟動時自動執行（僅 `pgcrypto`） |

### `schema.sql` 是否完整、最新、正確？

**是** — 對「目前已實作的 API」而言，`schema.sql` 就是完整且最新的 DDL：

- 與 `app/backend` 實際查詢的表、欄位一致（auth + 情境學習）
- 與 `scenario_seed.sql` 內容表結構一致（欄位名、型別、索引相同）
- **不包含** `database_spec.md` 裡尚未實作的表（進度、複習、AI chat 等）

維護原則：**改表結構時先改 `schema.sql`，再同步 `generate_scenario_seed.py` 的 DDL 片段並重跑產生器。**

---

## 目前實作範圍（11 張表）

```text
users 1 ── * refresh_tokens
      ├── 1 user_profiles
      ├── * user_saved_vocabulary  → course_vocabulary.id
      ├── * user_saved_sentences   → course_sentences.id
      ├── * user_course_progress   → courses.id
      └── * practice_attempts      → courses.id

scenarios 1 ── * courses 1 ── * course_sentences
                              └── * course_vocabulary
```

### ENUM

| 型別 | 值 |
|------|-----|
| `language_code` | `english`, `japanese` |
| `level_code` | `beginner`, `intermediate`, `advanced` |
| `subscription_tier` | `free`, `pro` |
| `user_status` | `active`, `disabled`, `pending` |

### 會員 / 認證（Google SSO）

| 表 | 說明 | 後端 |
|----|------|------|
| `users` | 會員主檔；`google_sub` 為 Google OIDC subject，僅 Google 登入 | `api/auth.py`, `module/jwt.py`, `api/user.py` |
| `refresh_tokens` | JWT Refresh Token（明文存 DB；RT Rotation） | `api/auth.py` |
| `user_profiles` | 學習偏好 1:1；首次 Google 登入由 callback 建立預設列 | 規格預留；callback 已 INSERT |

**Auth API（已實作）：**

- `GET /api/user/auth/google/start`
- `GET /api/user/auth/google/callback`
- `POST /api/user/refresh`
- `POST /api/user/logout`
- `GET /api/user`

### 情境學習內容

| 表 | 說明 | 後端 |
|----|------|------|
| `scenarios` | 情境（英文 / 日文） | `module/scenario_repository.py` |
| `courses` | 情境下的課程（由淺入深） | 同上 |
| `course_sentences` | 課程對話句子 | 同上 |
| `course_vocabulary` | 課程關鍵單字 | 同上 |

**Scenarios API（已實作）：**

- `GET /api/health`
- `GET /api/scenarios`
- `GET /api/scenarios/{id}`
- `GET /api/scenarios/{id}/courses/{course_id}`

### 收藏（表已建；API 待實作）

| 表 | 說明 | 對應內容 |
|----|------|----------|
| `user_saved_vocabulary` | 使用者收藏單字 | `course_vocabulary.id`（FK, ON DELETE CASCADE） |
| `user_saved_sentences` | 使用者收藏句子 | `course_sentences.id`（FK, ON DELETE CASCADE） |

> 重跑 `scenario_seed.sql` 會 DROP 內容表，收藏列會一併清除；`users` 等會員資料仍保留。

規格 API 見 [`api.md`](../document/api.md) §9.3–9.4、§12。

### 學習流程（步驟機）

| 表 | 說明 | 後端 |
|----|------|------|
| `user_course_progress` | 每人每課的步驟進度（PK：user_id + course_id） | `module/lesson_repository.py`, `api/lesson.py` |
| `practice_attempts` | 每一次練習作答紀錄（餵複習排程與進度分析） | 同上 |

**Lesson API（已實作）：**

- `GET /api/scenarios/{id}/courses/{course_id}/lesson`
- `GET /api/lesson/progress/{course_id}`（JWT）
- `PUT /api/lesson/progress/{course_id}`（JWT）
- `POST /api/lesson/attempts`（JWT）

規格見 [`LEARNING_FLOW_SPEC.md`](../document/LEARNING_FLOW_SPEC.md)。

> 重跑 `scenario_seed.sql` DROP 內容表時，`user_course_progress` 與 `practice_attempts` 因 FK `ON DELETE CASCADE` 也會被清除。

---

## 建議執行順序

### 全新空資料庫

```bash
export DATABASE_URL=postgresql://learnflow:learnflow_dev@127.0.0.1:5433/learnflow

psql "$DATABASE_URL" -f spec/database/schema.sql
psql "$DATABASE_URL" -f spec/operate/scenario_seed.sql
```

第二行會重建內容表並寫入種子；auth 表若已存在則保留（`IF NOT EXISTS`）。

### Docker 容器內執行

```bash
docker exec -i learnflow-db psql -U learnflow -d learnflow < spec/database/schema.sql
docker exec -i learnflow-db psql -U learnflow -d learnflow < spec/operate/scenario_seed.sql
```

### 舊 DB 只有情境表、缺少 auth 表

若 Google 登入出現 `relation "users" does not exist`，表示 DB 在 auth DDL 加入前已建過。可擇一：

**A. 只補 auth（保留既有情境資料）** — 執行 `scenario_seed.sql` 開頭 auth 區塊（至 `CREATE TABLE scenarios` 之前），或手動跑 `schema.sql` 中 auth 相關段落（注意 `CREATE TYPE` 可能已存在）。

**B. 全新重建** — 在可清空 DB 時跑完整 `schema.sql` + `scenario_seed.sql`。

### 只更新情境種子（不動會員資料）

```bash
# 1. 改 spec/operate/seed_content.py
# 2. 重新產生 SQL
python spec/operate/generate_scenario_seed.py
# 3. 匯入（DROP 重建 scenarios / courses / course_sentences / course_vocabulary）
psql "$DATABASE_URL" -f spec/operate/scenario_seed.sql
```

> `scenario_seed.sql` **不會** DROP `users` / `refresh_tokens` / `user_profiles`，重跑種子不會清掉已登入使用者；**會** DROP 收藏表與內容表（收藏需重新建立）。

---

## `schema.sql` 與 `scenario_seed.sql` 的差異

| | `schema.sql` | `scenario_seed.sql` |
|--|--------------|---------------------|
| 用途 | 空庫建表、文件、migration 參考 | 開發 / Demo 一鍵灌資料 |
| auth 表 | `CREATE TABLE`（空庫） | `CREATE TABLE IF NOT EXISTS`（可重跑） |
| ENUM | 直接 `CREATE TYPE` | `DO $$ … EXCEPTION` 略過已存在 |
| 內容表 | `CREATE TABLE` | 先 `DROP` 再 `CREATE` + `INSERT` |
| 種子資料 | 無 | 有 |

---

## 與 `database_spec.md` 的差異

[`database_spec.md`](../document/database_spec.md) 描述完整產品藍圖，與目前實作不同：

| 規格文件（未實作或不同） | 目前實作 |
|--------------------------|----------|
| `lesson_steps` | `courses` + `course_sentences` |
| `vocabulary_items` + `scenario_vocabulary` | `course_vocabulary`（綁定課程） |
| `scenarios` 含 level、category、story… | `scenarios` 精簡為 id / title / language / description |
| 密碼登入、`password_reset_tokens` | 僅 Google SSO |
| 學習進度、SM-2、AI 對話等表 | 尚未建表 |

之後若擴充 schema，建議以 **migration** 演進，避免直接覆蓋 production 資料。
