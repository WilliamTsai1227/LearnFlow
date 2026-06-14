# scenario_seed.sql 內容檢查紀錄

> 檢查日期：2026-06-14  
> 狀態：舊版生成流程已移除，以下問題作為歷史紀錄保留。  
> 目前正式內容來源：[`seed_content.py`](./seed_content.py)

## 1. 舊版問題

舊版 seed 由多個檔案互相產生與組合：

```text
_gen_lesson_data.py
content_builder.py
lesson_contexts.py
lesson_lexicons.py
scenario_content_data.py
```

當時主要問題：

- `translation` 有大量英文殘留。
- 有 `（英文對話）` / `（日文對話）` fallback 翻譯。
- 對話句像模板拼接，不像真實生活情境。
- 單字從大型字池輪抽，不一定出現在該課對話。
- 單字 meaning 有大量英文殘留。
- 檔案太多，難以判斷真正內容來源。

## 2. 已採取的修正

目前已移除舊版生成流程，`spec/operate` 只保留：

```text
SQL.md
SCENARIO_SEED_AUDIT.md
seed_content.py
generate_scenario_seed.py
scenario_seed.sql
```

新版規則：

- `seed_content.py` 是唯一內容來源。
- `generate_scenario_seed.py` 是唯一 SQL 產生器。
- 每課必須 15 句對話。
- 每課必須 30 個單字。
- 單字必須從該課對話句子中萃取。
- 不允許 fallback 翻譯。

## 3. 目前正式 seed 狀態

目前正式 seed 情境：

```text
en-cafe: 咖啡廳點餐
jp-cafe: 咖啡廳點餐
en-casual-chat: 日常對話閒聊
jp-casual-chat: 日常對話閒聊
```

資料量：

```text
scenarios: 4
courses: 80
course_sentences: 1200
course_vocabulary: 2400
```

## 4. 後續品質標準

新增下一個情境前，必須符合：

- 每個情境 20 課。
- L1-L7 初級，L8-L14 中級，L15-L20 高級。
- 每課 15 句真實對話。
- 每課 30 個單字，且都能在該課對話中找到。
- 中文翻譯要完整，不保留不必要英文。
- 日文情境未來可再補更完整的 reading。
