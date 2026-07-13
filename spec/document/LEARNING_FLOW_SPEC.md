# LearnFlow 學習流程規格（Learning Flow Spec）

> 版本：v1（2026-07）
> 範圍：情境課程的「步驟機學習流程」（P1 已實作）、記憶狀態與間隔複習（P2 草案）。
> 相關文件：`PRODUCT_SPEC.md`（產品願景）、`database_spec.md`、`schema.sql`。

## 0. 設計依據：大腦學習語言的原則

每個功能決策對應一條認知科學原則，實作時不可違反：

| # | 原則 | 對應功能規則 |
|---|------|-------------|
| 1 | 可理解輸入（i+1） | 每課新單字 5–8 個上限；內容應讓使用者聽懂約 90% |
| 2 | 聽先於讀（自然習得順序） | 盲聽步驟在任何文字呈現之前；聽力題不顯示原文 |
| 3 | 提取練習 > 重複輸入（Testing Effect） | 每步驟要求主動產出（選、排、錄、打字），不能只按「下一步」 |
| 4 | 預測錯誤驅動學習 | 盲聽後先「猜」再揭曉；答錯不懲罰，立即顯示正解 |
| 5 | 間隔重複 | 練習結果寫入 `practice_attempts`，供 P2 複習排程使用 |
| 6 | 語塊優先（Chunking） | 單字永遠綁定例句呈現；填空/聽寫以「詞組」為單位挖空 |
| 7 | 降低情緒過濾（敢開口） | 跟讀=自我比對、零評分；提示階梯；看答案唸出來也算完成 |
| 8 | 產出假說 | 「寫」放最後（最高負荷）；由重組 → 選擇填空 → 打字聽寫遞進 |

## 1. 步驟機（Lesson Step Machine）

一堂課（`courses` 一列）由後端展開成固定順序的步驟序列。前端是純狀態機：
`stepIndex` 只能前進（已完成的步驟可回看），每步驟有「完成條件」才解鎖下一步。

### 1.1 步驟定義

| # | type | 技能 | 內容 | 完成條件 |
|---|------|------|------|----------|
| 0 | `mission` | — | 任務卡：情境故事 + 本課目標（句數、字數、預估時間） | 按「開始」 |
| 1 | `blind_listen` | 聽 | 連續播放整課音檔（不顯示文字）→ 2 題全域理解選擇題 | 全部作答 |
| 2 | `sentence_study` | 讀+單字 | 逐句：音檔 → 原文 → 讀音 → 翻譯（預設隱藏）；側欄單字卡 | 看完全部句子 |
| 3 | `listen_check` | 聽 | 最多 5 題「聽音選義」：播音檔（無文字）選正確翻譯 | 全部作答 |
| 4 | `shadowing` | 說 | 逐句跟讀：播原音 → 錄音 → 並排回放自我比對（無評分） | 每句至少播放一次；錄音非必要（麥克風被拒仍可通過） |
| 5 | `apply` | 讀+用 | 最多 6 題混合：句子重組 + 填空選擇 | 全部作答 |
| 6 | `write` | 寫 | 最多 3 題聽寫填空：播音檔 + 挖空句 → 打字作答 | 全部作答（兩次錯誤後顯示答案，記為錯） |
| 7 | `result` | — | 分數、各技能答對率、能力宣告、寫入進度與作答紀錄 | — |

### 1.2 狀態與轉移

- 前端狀態：`{ stepIndex, maxStepReached, answers[], correctCount/totalCount per skill }`。
- 使用者可點擊已到達過的步驟回看；未到達的步驟鎖定。
- 每完成一個步驟：`PUT /api/lesson/progress/{course_id}`（`current_step` 只增不減）。
- `result` 時：`PUT` `completed=true` + `score`，並 `POST /api/lesson/attempts` 批次寫入作答。
- 重新學習：允許；`completed` 一旦為 true 即保留，`score` 取最新一次結算，`practice_attempts` 持續累加（歷史不刪）。

### 1.3 能力宣告（result 步驟）

不只顯示分數，顯示「你現在可以做到什麼」：
`你現在可以完成「{scenario.title}」的 {course.title} 情境對話。`
分數分級：≥90% 極佳 / ≥70% 良好 / <70% 建議重聽一次（附「再學一次」按鈕）。

## 2. 題型自動生成規則（lesson_builder）

所有題目由現有 `course_sentences` + `course_vocabulary` 自動生成，**不需要新增內容欄位**。
生成使用 `random.Random(course_id)` 作種子，確保同一課每次產生相同題目（利於複習與快取）。

### 2.1 盲聽全域理解題（`blind_listen.quiz`）

1. **情境判斷題**：「這段對話最可能發生在什麼情境？」
   - 正解：本課所屬 `scenarios.title`；干擾項：同語言其他 3 個 scenario 的 title。
2. **內容出現題**：「下列哪一句的意思『有』出現在對話中？」
   - 正解：本課隨機一句的 `translation`；干擾項：同語言其他課程隨機 3 句 `translation`。

### 2.2 聽音選義（`listen_check`）

- 從有 `audio_url` 的句子隨機取最多 5 句。
- 每題：播放該句音檔（不顯示原文）→ 4 個翻譯選項（正解 + 同課其他 3 句翻譯）。
- 同課句子不足 4 句時退為 2–3 選項；不足 2 句時跳過此步驟。

### 2.3 句子重組（`apply` / kind=`reorder`）

- **英文**：以空白切詞（標點附著於前一詞）。詞數 3–10 才生成；打亂順序（保證與原序不同）。
- **日文**：以「本課單字詞組貪婪匹配 + 標點邊界」切塊（chunk）；塊數 3–8 才生成。
  切不出 ≥3 塊的句子改生成填空選擇題。
- 作答：點擊詞塊組句，可撤銷；按「檢查」比對。

### 2.4 填空選擇（`apply` / kind=`cloze_choice`）

- 找出 `term` 確實出現在某句 `target_text` 中的單字（英文需詞邊界匹配、忽略大小寫；日文為子字串匹配）。
- 題面：該句挖空 `term`（以「＿＿＿」呈現）+ 中文翻譯提示。
- 選項：正解 term + 同課其他 3 個單字 term。

### 2.5 聽寫填空（`write` / kind=`dictation`）

- 題面：播放句子音檔 + 挖空句 + 中文翻譯；使用者打字填入被挖空的詞組。
- 判定：trim 後比對；英文忽略大小寫與首尾標點；日文接受 `term` 或 `reading` 任一。
- 兩次錯誤後顯示正解（記為答錯），可繼續。

### 2.6 apply 步驟組卷規則

- 目標 6 題：優先取 3 題重組 + 3 題填空；某類不足時以另一類補滿。
- 同一句子在 apply 步驟中最多出現一次（避免重複疲勞）。

## 3. 資料表

### 3.1 P1 已實作（見 `spec/database/schema.sql`）

```sql
-- 每人每課的步驟進度
CREATE TABLE user_course_progress (
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id    VARCHAR(50) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    current_step SMALLINT    NOT NULL DEFAULT 0,
    completed    BOOLEAN     NOT NULL DEFAULT false,
    score        SMALLINT,
    completed_at TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, course_id)
);

-- 每一次作答（餵 P2 記憶模型與進度分析頁）
CREATE TABLE practice_attempts (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id     VARCHAR(50) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    step_type     VARCHAR(30) NOT NULL,   -- blind_listen | listen_check | apply | write
    exercise_kind VARCHAR(30) NOT NULL,   -- scenario_choice | sentence_choice | listen_choice | reorder | cloze_choice | dictation
    item_type     VARCHAR(20),            -- sentence | vocabulary（全域題為 NULL）
    item_id       VARCHAR(50),            -- course_sentences.id / course_vocabulary.id
    is_correct    BOOLEAN     NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.2 P2 草案（尚未實作）：記憶狀態表

```sql
CREATE TYPE skill_code AS ENUM ('listening', 'speaking', 'reading', 'writing');

-- user × item × skill 的間隔重複狀態（FSRS 參數）
CREATE TABLE user_item_memory (
    user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_type        VARCHAR(20) NOT NULL,          -- sentence | vocabulary
    item_id          VARCHAR(50) NOT NULL,
    skill            skill_code  NOT NULL,
    stability        REAL        NOT NULL DEFAULT 0,  -- FSRS S
    difficulty       REAL        NOT NULL DEFAULT 5,  -- FSRS D (1-10)
    review_count     INT         NOT NULL DEFAULT 0,
    lapse_count      INT         NOT NULL DEFAULT 0,
    last_reviewed_at TIMESTAMPTZ,
    next_review_at   TIMESTAMPTZ,
    PRIMARY KEY (user_id, item_type, item_id, skill)
);
CREATE INDEX idx_user_item_memory_due ON user_item_memory (user_id, next_review_at);
```

P2 規則摘要：
- `practice_attempts` 每筆對應一次「提取事件」，依 `exercise_kind` 映射到 skill
  （listen_choice→listening、reorder/cloze→reading、dictation→writing、跟讀完成→speaking）。
- 複習佇列 = `next_review_at <= now()` 的 item，複習題型依該 item 最弱 skill 生成（沿用第 2 節生成器）。
- 複習永遠帶情境：以原句音檔挖空呈現，不做孤立單字卡。

## 4. API

### 4.1 課程展開（免登入，與現有 scenarios API 一致）

```
GET /api/scenarios/{scenario_id}/courses/{course_id}/lesson
→ {
    "course": CourseDetail,          # 同現有 /courses/{id} 回傳
    "scenario_title": str,
    "steps": [ { "step_index": int, "type": str, "title": str, "data": {…} } ]
  }
```

`data` 內容依 type 而異（quiz 題目含 `answer_id`，由前端本地判分；P1 非防弊場景，接受此取捨）。

### 4.2 進度與作答（需 Bearer JWT）

```
GET  /api/lesson/progress/{course_id}      → { course_id, current_step, completed, score } | current_step=0
PUT  /api/lesson/progress/{course_id}      body: { current_step, completed?, score? }（upsert；current_step 只增不減，completed 保留、score 取最新）
POST /api/lesson/attempts                  body: { course_id, attempts: [{ step_type, exercise_kind, item_type?, item_id?, is_correct }] }
```

## 5. 前端

- `js/lesson.js`：獨立步驟機模組，掛在 `window.learnflowLesson`；`app.js` 的 `render()` 以 `state.view === "lesson"` 分派。
- 入口：情境頁課程卡「開始這堂課」→ 學習流程；卡片另有「瀏覽內容」保留舊的逐句瀏覽模式。
- 跟讀錄音：`MediaRecorder`；權限被拒或不支援時降級為「跟著原音唸」仍可通過步驟。
- 續學：進入 lesson 時讀取進度，`mission` 步驟顯示「從上次步驟繼續」。

## 6. Roadmap 對照

| 階段 | 內容 | 狀態 |
|------|------|------|
| P1 | 步驟機 + 題型自動生成 + 進度/作答紀錄 | ✅ 本文件涵蓋，已實作 |
| P2 | `user_item_memory` + FSRS 複習佇列 + 每日複習頁（複習優先於新課） | 草案（§3.2） |
| P3 | 句型替換練習（需補句型骨架資料）+ 決策樹角色扮演 | 未開始 |
| P4 | LLM 自由角色扮演 + STT 發音回饋 | 未開始 |
