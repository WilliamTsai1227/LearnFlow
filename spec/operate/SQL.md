# LearnFlow SQL 操作手冊

> 用途：管理情境學習內容 seed data。  
> 目前完成內容：英文咖啡廳 `en-cafe`、日文咖啡廳 `jp-cafe`、英文日常閒聊 `en-casual-chat`、日文日常閒聊 `jp-casual-chat`。  
> 目前規格：4 個情境 × 每情境 20 課 × 每課 15 句子 + 30 單字。  
> 產生器：[`generate_scenario_seed.py`](./generate_scenario_seed.py)  
> 內容來源：[`seed_content.py`](./seed_content.py)  
> SQL 輸出：[`scenario_seed.sql`](./scenario_seed.sql)

## 1. 現在只需要看這幾個檔案

```text
spec/operate/
  SQL.md
  SCENARIO_SEED_AUDIT.md
  seed_content.py
  generate_scenario_seed.py
  scenario_seed.sql
```

檔案用途：

| 檔案 | 用途 |
|------|------|
| `seed_content.py` | 唯一內容來源：情境、課程、15 句對話、30 個單字 |
| `generate_scenario_seed.py` | 唯一執行檔：把 `seed_content.py` 轉成 SQL |
| `scenario_seed.sql` | 最終匯入 PostgreSQL 的 SQL |
| `SQL.md` | 操作指令 |
| `SCENARIO_SEED_AUDIT.md` | 舊版內容問題檢查報告 |

舊的模板生成檔已移除：

```text
_gen_lesson_data.py
content_builder.py
lesson_contexts.py
lesson_lexicons.py
scenario_content_data.py
```

## 2. 目前資料規模

```text
scenarios: 4
courses: 80
course_sentences: 1200
course_vocabulary: 2400
```

目前正式 seed 內容：

```text
en-cafe: 咖啡廳點餐
jp-cafe: 咖啡廳點餐
en-casual-chat: 日常對話閒聊
jp-casual-chat: 日常對話閒聊
```

等級：

```text
Lesson 1-7: beginner
Lesson 8-14: intermediate
Lesson 15-20: advanced
```

其他情境先不塞入 SQL，避免使用不自然的批次生成資料。之後每完成一個情境，再加進 `seed_content.py`。

## 3. 更新 SQL

核心觀念：

```text
1. 改 seed_content.py
   ↓
2. 執行 generate_scenario_seed.py
   ↓
3. 產生 / 更新 scenario_seed.sql
   ↓
4. 手動匯入 PostgreSQL
```

也就是：

```text
seed_content.py
   ↓
generate_scenario_seed.py
   ↓
scenario_seed.sql
   ↓
PostgreSQL
```

三個檔案的關係：

| 檔案 | 角色 | 是否手動修改 |
|------|------|--------------|
| `seed_content.py` | 內容原稿，放主題、課程、句子、翻譯、單字來源 | 是，主要改這個 |
| `generate_scenario_seed.py` | 轉檔工具，把內容原稿轉成 SQL | 通常不用改 |
| `scenario_seed.sql` | 產物，給 PostgreSQL 匯入 | 通常不要手動改 |

重點：`seed_content.py` 是真正要編輯的內容原稿，`scenario_seed.sql` 是產物。通常不要手動改 `scenario_seed.sql`，因為下次再跑 generator，手動改過的 SQL 會被覆蓋。

修改內容時，只改：

```text
spec/operate/seed_content.py
```

然後從專案根目錄執行：

```bash
python3 spec/operate/generate_scenario_seed.py
```

成功時會看到：

```text
Wrote /Users/william/Documents/project/LearnFlow/spec/operate/scenario_seed.sql (... lines)
```

產生器會檢查：

```text
每課必須剛好 15 句
每課必須剛好 30 個單字
句子不能有空翻譯
不能使用「（英文對話）」或「（日文對話）」fallback
單字必須真的出現在該課對話句子中
```

## 4. 一鍵清掉重匯

如果要把目前 DB 裡的情境、課程、句子、單字全部清掉，並重新匯入最新 seed，從專案根目錄執行：

```bash
python3 spec/operate/generate_scenario_seed.py
docker exec -i learnflow-db psql -U learnflow -d learnflow < spec/operate/scenario_seed.sql
```

這會清掉並重建：

```text
scenarios
courses
course_sentences
course_vocabulary
```

目前不會處理使用者資料，因為這份 seed 只管理課程內容表。

## 5. 只匯入已產生好的 SQL

如果不需要重新產生 SQL，只要匯入目前的 `scenario_seed.sql`：

```bash
docker exec -i learnflow-db psql -U learnflow -d learnflow < spec/operate/scenario_seed.sql
```

如果本機有 `psql`：

```bash
psql postgresql://learnflow:learnflow_dev@127.0.0.1:5433/learnflow -f spec/operate/scenario_seed.sql
```

## 6. 驗證資料

進入 DB：

```bash
docker exec -i learnflow-db psql -U learnflow -d learnflow
```

查總數：

```sql
SELECT COUNT(*) AS total_scenarios FROM scenarios;
SELECT COUNT(*) AS total_courses FROM courses;
SELECT COUNT(*) AS total_sentences FROM course_sentences;
SELECT COUNT(*) AS total_vocabulary FROM course_vocabulary;
```

預期：

```text
total_scenarios: 4
total_courses: 80
total_sentences: 1200
total_vocabulary: 2400
```

檢查每課是否都有 15 句與 30 單字，這個查詢應回傳 0 rows：

```sql
SELECT
  c.id,
  COUNT(DISTINCT cs.id) AS sentence_count,
  COUNT(DISTINCT cv.id) AS vocabulary_count
FROM courses c
LEFT JOIN course_sentences cs ON cs.course_id = c.id
LEFT JOIN course_vocabulary cv ON cv.course_id = c.id
GROUP BY c.id
HAVING COUNT(DISTINCT cs.id) <> 15
    OR COUNT(DISTINCT cv.id) <> 30
ORDER BY c.id;
```

檢查等級分布：

```sql
SELECT level, COUNT(*) AS course_count
FROM courses
GROUP BY level
ORDER BY level;
```

預期：

```text
beginner: 28
intermediate: 28
advanced: 24
```

## 7. 後續新增其他情境

下一個情境要加時：

1. 在 `seed_content.py` 的 `SCENARIOS` 加情境入口。
2. 在 `COURSE_BLUEPRINTS` 加該情境每堂課的 15 句對話，或建立像 `JP_CAFE_SPECS`、`EN_CASUAL_SPECS`、`JP_CASUAL_CHAT_SPECS` 這種只服務單一情境的專用內容規格。

英文咖啡廳目前由 glossary 從句子中萃取單字；日文咖啡廳、英文日常閒聊與日文日常閒聊使用各自的專用詞彙表產生單字。無論哪種方式，產生器都會檢查每課 15 句、30 單字，且單字必須真的出現在該課句子中。
