-- ============================================================
-- LearnFlow — Migration 002：YouTube 擷取 + FSRS 複習 + 翻譯快取
-- ============================================================
-- 用途：為既有資料庫補上 captures / srs_cards / srs_reviews / translation_cache 四張表。
-- 對應後端：module/captures_repository.py、module/srs_repository.py、module/fsrs.py
--           api/captures.py、api/review.py、api/translate.py
--
-- 套用方式（既有資料庫，冪等，可重複執行）：
--   psql "$DATABASE_URL" -f spec/database/002_srs.sql
--
-- 全新空庫請改用 spec/database/schema.sql（已含這四張表）。
-- 依賴：users、course_vocabulary、course_sentences、language_code enum（皆由 schema.sql 建立）。
-- ============================================================

CREATE TABLE IF NOT EXISTS captures (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind             VARCHAR(10)   NOT NULL,
    language         language_code NOT NULL,
    term             TEXT          NOT NULL,
    context_sentence TEXT,
    translation      TEXT,
    reading          TEXT,
    romaji           TEXT,
    video_id         VARCHAR(20)   NOT NULL,
    video_url        TEXT          NOT NULL,
    video_title      TEXT,
    start_seconds    REAL          NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT captures_unique UNIQUE (user_id, video_id, term, start_seconds)
);

CREATE INDEX IF NOT EXISTS idx_captures_user ON captures (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS srs_cards (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_type    VARCHAR(20) NOT NULL,
    item_id      VARCHAR(60) NOT NULL,
    stability    REAL        NOT NULL DEFAULT 0,
    difficulty   REAL        NOT NULL DEFAULT 0,
    state        SMALLINT    NOT NULL DEFAULT 0,
    due          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_review  TIMESTAMPTZ,
    reps         INT         NOT NULL DEFAULT 0,
    lapses       INT         NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT srs_cards_unique UNIQUE (user_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_srs_cards_due ON srs_cards (user_id, due);

CREATE TABLE IF NOT EXISTS srs_reviews (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_id        UUID        NOT NULL REFERENCES srs_cards(id) ON DELETE CASCADE,
    rating         SMALLINT    NOT NULL,
    state_before   SMALLINT    NOT NULL,
    elapsed_days   REAL        NOT NULL DEFAULT 0,
    scheduled_days REAL        NOT NULL DEFAULT 0,
    reviewed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_srs_reviews_user ON srs_reviews (user_id, reviewed_at);
CREATE INDEX IF NOT EXISTS idx_srs_reviews_card ON srs_reviews (card_id, reviewed_at);

CREATE TABLE IF NOT EXISTS translation_cache (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    source_language  language_code NOT NULL,
    target_language  VARCHAR(10)   NOT NULL,
    term             TEXT          NOT NULL,
    payload          JSONB         NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT translation_cache_unique UNIQUE (source_language, target_language, term)
);

-- ------------------------------------------------------------
-- Backfill：既有課程收藏也排入 SRS（冪等，可重複執行）
-- 之後新收藏由 saved_repository.save_vocabulary/save_sentence 自動 upsert。
-- ------------------------------------------------------------

INSERT INTO srs_cards (user_id, item_type, item_id, state, due)
SELECT user_id, 'vocabulary', vocabulary_id, 0, now()
FROM user_saved_vocabulary
ON CONFLICT (user_id, item_type, item_id) DO NOTHING;

INSERT INTO srs_cards (user_id, item_type, item_id, state, due)
SELECT user_id, 'sentence', sentence_id, 0, now()
FROM user_saved_sentences
ON CONFLICT (user_id, item_type, item_id) DO NOTHING;
