-- ============================================================
-- LearnFlow — 資料庫結構（DDL only）
-- ============================================================
-- 用途：建立目前專案已實作的情境學習與 Google SSO 會員資料表。
-- 對應後端：app/backend/module/scenario_repository.py（情境）
--           認證 API 規格見 spec/document/api.md §3（Google SSO）
-- 種子資料：請另執行 spec/operate/scenario_seed.sql
--
-- 關聯：
--   users 1 ── * refresh_tokens
--         ├── 1 user_profiles
--         ├── * user_saved_vocabulary  → course_vocabulary.id (FK)
--         └── * user_saved_sentences   → course_sentences.id (FK)
--   scenarios 1 ── * courses 1 ── * course_sentences
--                              └── * course_vocabulary
--
-- 執行方式（空資料庫）：
--   psql "$DATABASE_URL" -f spec/database/schema.sql
--   psql "$DATABASE_URL" -f spec/operate/scenario_seed.sql
--
-- 完整產品規格（含尚未實作的進度、AI 對話等表）：
--   spec/document/database_spec.md
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- ENUM
-- ------------------------------------------------------------

CREATE TYPE language_code AS ENUM ('english', 'japanese');
CREATE TYPE level_code AS ENUM ('beginner', 'intermediate', 'advanced');
CREATE TYPE subscription_tier AS ENUM ('free', 'pro');
CREATE TYPE user_status AS ENUM ('active', 'disabled', 'pending');

-- ------------------------------------------------------------
-- users — Google SSO 會員（僅 Google 登入；google_sub 為 OIDC subject）
-- 對齊 Stock-Insight-Chat app/backend/database/init_db.sql §users
-- ------------------------------------------------------------

CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               VARCHAR(255) NOT NULL,
    username            VARCHAR(100) NOT NULL,
    google_sub          TEXT         NOT NULL,
    display_name        VARCHAR(100),
    avatar_url          TEXT,
    last_login_provider VARCHAR(32)  NOT NULL DEFAULT 'google',
    status              user_status  NOT NULL DEFAULT 'active',
    subscription_tier   subscription_tier NOT NULL DEFAULT 'free',
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT users_email_unique UNIQUE (email),
    CONSTRAINT users_username_unique UNIQUE (username),
    CONSTRAINT users_google_sub_unique UNIQUE (google_sub)
);

CREATE UNIQUE INDEX idx_users_email_active
    ON users (email)
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX ux_users_google_sub
    ON users (google_sub);

CREATE INDEX idx_users_created_at
    ON users (created_at);

-- ------------------------------------------------------------
-- refresh_tokens — JWT Refresh Token（RT Rotation；存明文 token，與 Stock-Insight-Chat 一致）
-- 後端：GET /auth/google/callback 寫入 HttpOnly Cookie → POST /auth/refresh 換 AT
-- ------------------------------------------------------------

CREATE TABLE refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT refresh_tokens_token_unique UNIQUE (token)
);

CREATE INDEX idx_refresh_tokens_user
    ON refresh_tokens (user_id);

CREATE INDEX idx_refresh_tokens_expires
    ON refresh_tokens (expires_at);

-- ------------------------------------------------------------
-- user_profiles — 學習偏好（1:1 users；註冊／首次 Google 登入後由 API 建立預設列）
-- ------------------------------------------------------------

CREATE TABLE user_profiles (
    user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    native_language        VARCHAR(10)   NOT NULL DEFAULT 'zh-TW',
    active_languages       language_code[] NOT NULL DEFAULT '{}',
    level                  level_code    NOT NULL DEFAULT 'beginner',
    interests              TEXT[]        NOT NULL DEFAULT '{}',
    daily_goal_minutes     SMALLINT      NOT NULL DEFAULT 30,
    -- 固化記憶：兩軌各自的每日新卡上限（規格建議初期 5–10、穩定後 10–20）
    daily_new_youtube      SMALLINT      NOT NULL DEFAULT 10,
    daily_new_course       SMALLINT      NOT NULL DEFAULT 10,
    speech_speed           DECIMAL(3,2)  NOT NULL DEFAULT 1.00,
    ai_feedback_strictness VARCHAR(20)   NOT NULL DEFAULT 'normal',
    ui_language            VARCHAR(10)   NOT NULL DEFAULT 'zh-TW',
    timezone               VARCHAR(50)   NOT NULL DEFAULT 'Asia/Taipei',
    updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- scenarios — 情境（如咖啡廳點餐、日常閒聊）
-- ------------------------------------------------------------

CREATE TABLE scenarios (
    id            VARCHAR(50)   PRIMARY KEY,
    title         VARCHAR(255)  NOT NULL,
    language      language_code NOT NULL,
    description   TEXT          NOT NULL,
    sort_order    SMALLINT      NOT NULL DEFAULT 0,
    is_published  BOOLEAN       NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- courses — 情境下的課程（每情境多堂，由淺入深）
-- ------------------------------------------------------------

CREATE TABLE courses (
    id                VARCHAR(50)  PRIMARY KEY,
    scenario_id       VARCHAR(50)  NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    title             VARCHAR(255) NOT NULL,
    level             level_code   NOT NULL DEFAULT 'beginner',
    order_index       SMALLINT     NOT NULL,
    description       TEXT         NOT NULL DEFAULT '',
    estimated_minutes SMALLINT     NOT NULL DEFAULT 10,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (scenario_id, order_index)
);

CREATE INDEX idx_courses_scenario
    ON courses (scenario_id, order_index);

-- ------------------------------------------------------------
-- course_sentences — 課程對話句子
-- ------------------------------------------------------------

CREATE TABLE course_sentences (
    id           VARCHAR(50) PRIMARY KEY,
    course_id    VARCHAR(50) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    order_index  SMALLINT    NOT NULL,
    target_text  TEXT        NOT NULL,
    reading      TEXT,
    romaji       TEXT,
    translation  TEXT        NOT NULL,
    audio_url    TEXT,
    UNIQUE (course_id, order_index)
);

CREATE INDEX idx_sentences_course
    ON course_sentences (course_id, order_index);

-- ------------------------------------------------------------
-- course_vocabulary — 課程關鍵單字
-- ------------------------------------------------------------

CREATE TABLE course_vocabulary (
    id               VARCHAR(50)  PRIMARY KEY,
    course_id        VARCHAR(50)  NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    order_index      SMALLINT     NOT NULL,
    term             VARCHAR(100) NOT NULL,
    reading          VARCHAR(200),
    romaji           VARCHAR(300),
    meaning          TEXT         NOT NULL,
    example_sentence TEXT,
    audio_url        TEXT,
    UNIQUE (course_id, order_index)
);

CREATE INDEX idx_vocabulary_course
    ON course_vocabulary (course_id, order_index);

-- ------------------------------------------------------------
-- user_saved_vocabulary — 使用者收藏單字
-- API：POST/DELETE /vocabulary/{vocab_id}/favorite、GET /saved?type=vocabulary
-- ------------------------------------------------------------

CREATE TABLE user_saved_vocabulary (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vocabulary_id  VARCHAR(50) NOT NULL REFERENCES course_vocabulary(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_saved_vocabulary_unique UNIQUE (user_id, vocabulary_id)
);

CREATE INDEX idx_user_saved_vocabulary_user
    ON user_saved_vocabulary (user_id, created_at DESC);

CREATE INDEX idx_user_saved_vocabulary_vocab
    ON user_saved_vocabulary (vocabulary_id);

-- ------------------------------------------------------------
-- user_saved_sentences — 使用者收藏句子
-- API：GET /saved?type=sentence、POST /saved { item_type: "sentence", ... }
-- ------------------------------------------------------------

CREATE TABLE user_saved_sentences (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sentence_id VARCHAR(50) NOT NULL REFERENCES course_sentences(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_saved_sentences_unique UNIQUE (user_id, sentence_id)
);

CREATE INDEX idx_user_saved_sentences_user
    ON user_saved_sentences (user_id, created_at DESC);

CREATE INDEX idx_user_saved_sentences_sentence
    ON user_saved_sentences (sentence_id);

-- ------------------------------------------------------------
-- user_course_progress — 每人每課的學習流程步驟進度
-- API：GET/PUT /api/lesson/progress/{course_id}
-- 規格：spec/document/LEARNING_FLOW_SPEC.md §3.1
-- ------------------------------------------------------------

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

CREATE INDEX idx_user_course_progress_user
    ON user_course_progress (user_id, updated_at DESC);

-- ------------------------------------------------------------
-- practice_attempts — 每一次練習作答紀錄（餵複習排程與進度分析）
-- API：POST /api/lesson/attempts
-- 規格：spec/document/LEARNING_FLOW_SPEC.md §3.1
-- ------------------------------------------------------------

CREATE TABLE practice_attempts (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id     VARCHAR(50) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    step_type     VARCHAR(30) NOT NULL,
    exercise_kind VARCHAR(30) NOT NULL,
    item_type     VARCHAR(20),
    item_id       VARCHAR(50),
    is_correct    BOOLEAN     NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_practice_attempts_user_course
    ON practice_attempts (user_id, course_id, created_at DESC);

CREATE INDEX idx_practice_attempts_user_item
    ON practice_attempts (user_id, item_type, item_id);

-- ------------------------------------------------------------
-- notes — 使用者上傳的筆記文件（PDF / Word）
-- API：POST/GET/DELETE /api/notes、GET /api/notes/{id}/file
-- ------------------------------------------------------------

CREATE TABLE notes (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       VARCHAR(255) NOT NULL,
    file_type   VARCHAR(10)  NOT NULL,           -- 'pdf' | 'docx'
    file_ext    VARCHAR(10)  NOT NULL,
    size_bytes  BIGINT       NOT NULL DEFAULT 0,
    canvas_x    REAL,
    canvas_y    REAL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_user ON notes (user_id, updated_at DESC);

-- ------------------------------------------------------------
-- note_annotations — 螢光筆標註與 comment 留言
-- rects 為相對頁面正規化座標 [{x,y,w,h}]（0..1），縮放時前端換算
-- API：GET/POST /api/notes/{id}/annotations、PATCH/DELETE /api/annotations/{id}
-- ------------------------------------------------------------

CREATE TABLE note_annotations (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id    UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       VARCHAR(20) NOT NULL,             -- 'highlight' | 'comment'
    page       SMALLINT    NOT NULL DEFAULT 1,
    color      VARCHAR(20) NOT NULL DEFAULT 'yellow',
    rects      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    quote      TEXT,
    body       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_note_annotations_note ON note_annotations (note_id, page);

-- ------------------------------------------------------------
-- vocab_decks — 單字頁的單字集（五十音、常用單字…）
-- API：GET /api/vocab/decks?language=、GET /api/vocab/decks/{id}/items
-- ------------------------------------------------------------

CREATE TABLE vocab_decks (
    id           VARCHAR(50)   PRIMARY KEY,
    language     language_code NOT NULL,
    kind         VARCHAR(20)   NOT NULL,          -- 'kana' | 'word'
    title        VARCHAR(255)  NOT NULL,
    description  TEXT          NOT NULL DEFAULT '',
    sort_order   SMALLINT      NOT NULL DEFAULT 0,
    is_published BOOLEAN       NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- vocab_items — 單字集內的每個項目（一個假名 / 一個單字）
-- group_key：kana 用 'hiragana' | 'katakana'；word 可為分類或 NULL
-- ------------------------------------------------------------

CREATE TABLE vocab_items (
    id          VARCHAR(60)  PRIMARY KEY,
    deck_id     VARCHAR(50)  NOT NULL REFERENCES vocab_decks(id) ON DELETE CASCADE,
    group_key   VARCHAR(30),
    order_index SMALLINT     NOT NULL,
    term        VARCHAR(100) NOT NULL,
    romaji      VARCHAR(120),
    reading     VARCHAR(120),
    meaning     TEXT,
    audio_url   TEXT,
    category    VARCHAR(20),                     -- kana：'seion'|'dakuon'|'yoon'
    kana_row    VARCHAR(4),                      -- 'a'|'i'|'u'|'e'|'o'|'n'
    kana_col    VARCHAR(4)                       -- 'K'|'S'|...|'KY'|'J'…（母音欄為 ''）
);

CREATE INDEX idx_vocab_items_deck ON vocab_items (deck_id, group_key, order_index);

-- ------------------------------------------------------------
-- note_texts — 筆記畫布上的自由文字框（不綁定特定文件，屬使用者的畫布）
-- API：GET/POST /api/note-texts、PATCH/DELETE /api/note-texts/{id}
-- ------------------------------------------------------------

CREATE TABLE note_texts (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    canvas_x   REAL        NOT NULL DEFAULT 0,
    canvas_y   REAL        NOT NULL DEFAULT 0,
    canvas_w   REAL,
    canvas_h   REAL,
    body       TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_note_texts_user ON note_texts (user_id);

-- ------------------------------------------------------------
-- captures — Chrome 擴充從 YouTube 字幕擷取的項目（單字或整句）
-- API：POST/GET/DELETE /api/captures
-- kind：'word'（點的單字）| 'sentence'（整句收藏）
-- start_seconds：跳回影片的時間點（watch?v=<video_id>&t=<sec>s）
-- ------------------------------------------------------------

CREATE TABLE captures (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind             VARCHAR(10)   NOT NULL,            -- 'word' | 'sentence'（新版擴充只產生 'word'）
    language         language_code NOT NULL,
    term             TEXT          NOT NULL,            -- 點的字，或整句
    context_sentence TEXT,                              -- 該字所在的完整字幕句
    translation      TEXT,                              -- 單字在句中的字義
    sentence_translation TEXT,                          -- context_sentence 的整句翻譯
    -- 前後文：JSONB 陣列 [{"text": "...", "translation": "..."}]
    -- 後文在收藏當下尚未播出，由擴充事後以 PATCH .../context 回填
    context_before   JSONB         NOT NULL DEFAULT '[]'::jsonb,
    context_after    JSONB         NOT NULL DEFAULT '[]'::jsonb,
    reading          TEXT,
    romaji           TEXT,
    video_id         VARCHAR(20)   NOT NULL,
    video_url        TEXT          NOT NULL,
    video_title      TEXT,
    start_seconds    REAL          NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT captures_unique UNIQUE (user_id, video_id, term, start_seconds)
);

CREATE INDEX idx_captures_user ON captures (user_id, created_at DESC);

-- ------------------------------------------------------------
-- srs_cards — 統一複習佇列與 FSRS 記憶狀態（多型：一張卡對應一個可複習項目）
-- item_type：'capture'（→ captures.id）| 'vocabulary'（→ course_vocabulary.id）| 'sentence'（→ course_sentences.id）
-- 「收藏內容自動進入 SRS」＝建立 capture / 收藏課程項目時同交易 upsert 一張卡（state=0, due=now）
-- state：0=new 1=learning 2=review 3=relearning
-- API：GET /api/review/queue、POST /api/review/{card_id}/grade、GET /api/review/summary
-- ------------------------------------------------------------

-- 欄位對齊官方 py-fsrs 的 Card：
--   state：Learning=1 / Review=2 / Relearning=3（無 new，新卡即 Learning）
--   stability / difficulty：NULL 表示尚未初始化（不可用 0）
--   step：學習步驟索引，進入 Review 後為 NULL
CREATE TABLE srs_cards (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_type    VARCHAR(20) NOT NULL,                  -- 'capture'（YouTube 軌）| 'vocabulary' | 'sentence'（課程軌）
    item_id      VARCHAR(60) NOT NULL,                  -- captures.id / course_vocabulary.id / course_sentences.id
    stability    REAL,                                  -- FSRS S（NULL=尚未初始化）
    difficulty   REAL,                                  -- FSRS D（NULL=尚未初始化，初始化後 1-10）
    state        SMALLINT    NOT NULL DEFAULT 1,        -- py-fsrs State
    step         SMALLINT    DEFAULT 0,                 -- 學習步驟索引（Review 狀態為 NULL）
    due          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_review  TIMESTAMPTZ,
    reps         INT         NOT NULL DEFAULT 0,
    lapses       INT         NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT srs_cards_unique UNIQUE (user_id, item_type, item_id)
);

CREATE INDEX idx_srs_cards_due ON srs_cards (user_id, due);

-- ------------------------------------------------------------
-- srs_reviews — 每次複習評分紀錄（餵懶人追蹤/深度分析，可支援 undo）
-- rating：1=Again 2=Hard 3=Good 4=Easy
-- ------------------------------------------------------------

CREATE TABLE srs_reviews (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_id         UUID        NOT NULL REFERENCES srs_cards(id) ON DELETE CASCADE,
    rating          SMALLINT    NOT NULL,               -- py-fsrs Rating：1=Again 2=Hard 3=Good 4=Easy
    state_before    SMALLINT    NOT NULL,
    elapsed_days    REAL        NOT NULL DEFAULT 0,
    scheduled_days  REAL        NOT NULL DEFAULT 0,
    -- 作答訊號（供日後 FSRS 參數最佳化與學習分析）
    response_ms     INT,                                -- 卡片顯示 → 按下評分的毫秒數
    prompt_type     VARCHAR(20),                        -- 'recognition' | 'cloze'
    hint_used       BOOLEAN     NOT NULL DEFAULT false,
    answer_revealed BOOLEAN     NOT NULL DEFAULT false, -- 是否按過「顯示答案」
    reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_srs_reviews_user ON srs_reviews (user_id, reviewed_at);
CREATE INDEX idx_srs_reviews_card ON srs_reviews (card_id, reviewed_at);

-- ------------------------------------------------------------
-- context_exposures — 被動曝光（字幕上看到單字）
-- 「看到 ≠ 完成複習」：這張表絕對不參與 FSRS 排程，
-- 只有使用者主動回想並評分（srs_reviews）才會更新 srs_cards。
-- 只記錄「使用者已有卡片的詞」，否則每行字幕每個詞都記會爆量。
-- API：POST /api/exposures（批次）
-- ------------------------------------------------------------

CREATE TABLE context_exposures (
    id        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id   UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    term      TEXT          NOT NULL,
    language  language_code NOT NULL,
    video_id  VARCHAR(20),
    sentence  TEXT,
    seen_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_context_exposures_user ON context_exposures (user_id, seen_at DESC);
CREATE INDEX idx_context_exposures_term ON context_exposures (user_id, term);

-- ------------------------------------------------------------
-- translation_cache — 翻譯快取（同一 (詞, 語言對) 只查一次）
-- API：POST /api/translate 先查此表，未命中才呼叫免費翻譯資源（MyMemory + Jisho）並寫回
-- ------------------------------------------------------------

CREATE TABLE translation_cache (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    source_language  language_code NOT NULL,
    target_language  VARCHAR(10)   NOT NULL,
    term             TEXT          NOT NULL,
    payload          JSONB         NOT NULL DEFAULT '{}'::jsonb,  -- translation/reading/romaji/part_of_speech
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT translation_cache_unique UNIQUE (source_language, target_language, term)
);

-- ------------------------------------------------------------
-- tts_cache — 語音合成快取（edge-tts，與課程音檔同一套語音/語速）
-- API：GET /api/tts 先查此表，未命中才呼叫 edge-tts 並寫回
-- 讓 YouTube 收藏（複習頁/收藏頁/Chrome 擴充）跟課程內容用同樣音色，
-- 不再依賴瀏覽器內建 Web Speech API。
-- ------------------------------------------------------------

CREATE TABLE tts_cache (
    id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    language     VARCHAR(10)   NOT NULL,
    text         TEXT          NOT NULL,
    audio        BYTEA         NOT NULL,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT tts_cache_unique UNIQUE (language, text)
);
