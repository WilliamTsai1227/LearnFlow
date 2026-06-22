# LearnFlow 資料庫 SQL

## 檔案說明

| 檔案 | 用途 |
|------|------|
| [`schema.sql`](./schema.sql) | **純 DDL**：ENUM、資料表、索引（目前已實作的部分） |
| [`../operate/scenario_seed.sql`](../operate/scenario_seed.sql) | DDL + 種子資料（會 DROP 重建內容表） |
| [`../document/database_spec.md`](../document/database_spec.md) | 完整產品規格（含 users、進度、AI 對話等**尚未實作**的表） |
| [`../../deploy/init/001_extensions.sql`](../../deploy/init/001_extensions.sql) | Docker 容器首次啟動時自動執行（僅 `pgcrypto`） |

## 目前實作範圍

```text
scenarios
  └── courses
        ├── course_sentences
        └── course_vocabulary
```

對應 API：`GET /api/scenarios`、`GET /api/scenarios/{id}/courses/{course_id}` 等。

## 建議執行順序

### 全新資料庫

```bash
psql "$DATABASE_URL" -f spec/database/schema.sql
psql "$DATABASE_URL" -f spec/operate/scenario_seed.sql
```

> `scenario_seed.sql` 開頭會 DROP 並重建四張內容表，若已執行過 `schema.sql`，直接跑 `scenario_seed.sql` 即可（內含相同 DDL）。

### 只更新種子資料

```bash
# 1. 改 spec/operate/seed_content.py
# 2. 重新產生 SQL
python spec/operate/generate_scenario_seed.py
# 3. 匯入
psql "$DATABASE_URL" -f spec/operate/scenario_seed.sql
```

## 與規格文件的差異

[`database_spec.md`](../document/database_spec.md) 描述完整產品（使用者認證、學習進度、SM-2 複習、AI 對話等），結構與目前實作不同：

| 規格文件 | 目前實作 |
|----------|----------|
| `lesson_steps` | `courses` + `course_sentences` |
| `vocabulary_items` + `scenario_vocabulary` | `course_vocabulary`（綁定課程） |
| `scenarios` 含 level、category、story… | `scenarios` 精簡為 id / title / language / description |

之後若遷移到完整 schema，建議以 migration 方式演進，而非直接覆蓋。
