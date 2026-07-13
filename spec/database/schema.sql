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
