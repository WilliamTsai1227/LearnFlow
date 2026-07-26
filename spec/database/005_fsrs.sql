-- ============================================================
-- LearnFlow — Migration 005：改用官方 FSRS 套件（py-fsrs）＋ 被動曝光
-- ============================================================
-- 用途：
--   1. 讓 srs_cards 對齊 py-fsrs 的 Card 結構（新增 step、S/D 改可為 NULL）
--   2. srs_reviews 補上作答訊號（response_ms / prompt_type / hint_used / answer_revealed）
--   3. 新增 context_exposures（被動曝光：字幕上看到單字 ≠ 完成複習，不參與排程）
--   4. user_profiles 補上兩軌各自的每日新卡上限
--
-- 已實測對照（py-fsrs 6.3.1）：
--   State  : Learning=1, Review=2, Relearning=3  → 與既有 state 1/2/3 完全一致
--   Rating : Again=1, Hard=2, Good=3, Easy=4     → 與既有 rating 1-4 完全一致
--   全新 Card(): step=0, stability=NULL, difficulty=NULL, state=Learning(1)
--   進入 Review 狀態後 step 會變成 NULL，故 step 必須可為 NULL
--
-- 套用方式（既有資料庫，冪等，可重複執行）：
--   psql "$DATABASE_URL" -f spec/database/005_fsrs.sql
--
-- 全新空庫請改用 spec/database/schema.sql（已含這些欄位）。
-- ============================================================

-- ── 1. srs_cards 對齊 py-fsrs Card ──────────────────────────

ALTER TABLE srs_cards ADD COLUMN IF NOT EXISTS step SMALLINT;

ALTER TABLE srs_cards ALTER COLUMN stability  DROP NOT NULL;
ALTER TABLE srs_cards ALTER COLUMN difficulty DROP NOT NULL;
ALTER TABLE srs_cards ALTER COLUMN stability  DROP DEFAULT;
ALTER TABLE srs_cards ALTER COLUMN difficulty DROP DEFAULT;

-- py-fsrs 用 NULL 表示「尚未初始化」，不是 0；舊版預設 0 會讓公式算錯
UPDATE srs_cards SET stability  = NULL WHERE stability  = 0;
UPDATE srs_cards SET difficulty = NULL WHERE difficulty = 0;

-- 舊 state 0（自訂的 new）→ py-fsrs State.Learning(1)，並補上 step=0
UPDATE srs_cards SET state = 1, step = 0 WHERE state = 0;

-- ── 2. srs_reviews 作答訊號 ─────────────────────────────────

ALTER TABLE srs_reviews ADD COLUMN IF NOT EXISTS response_ms     INT;
ALTER TABLE srs_reviews ADD COLUMN IF NOT EXISTS prompt_type     VARCHAR(20);
ALTER TABLE srs_reviews ADD COLUMN IF NOT EXISTS hint_used       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE srs_reviews ADD COLUMN IF NOT EXISTS answer_revealed BOOLEAN NOT NULL DEFAULT false;

-- ── 3. context_exposures（被動曝光）─────────────────────────
-- 只記錄「使用者已有卡片的詞」在字幕上出現過；若每行字幕每個詞都記，
-- 資料量會爆炸且沒有學習意義。
-- 這張表**絕對不參與排程**：看到 ≠ 完成複習。

CREATE TABLE IF NOT EXISTS context_exposures (
    id        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id   UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    term      TEXT          NOT NULL,
    language  language_code NOT NULL,
    video_id  VARCHAR(20),
    sentence  TEXT,
    seen_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_context_exposures_user ON context_exposures (user_id, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_exposures_term ON context_exposures (user_id, term);

-- ── 4. 每日新卡上限（兩軌各自）──────────────────────────────

ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS daily_new_youtube SMALLINT NOT NULL DEFAULT 10;
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS daily_new_course  SMALLINT NOT NULL DEFAULT 10;
