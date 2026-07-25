-- ============================================================
-- LearnFlow — Migration 003：語音合成快取（edge-tts）
-- ============================================================
-- 用途：為既有資料庫補上 tts_cache 表，讓 YouTube 收藏（複習頁/收藏頁/
-- Chrome 擴充）跟課程內容一樣用 edge-tts 類神經語音，取代瀏覽器內建
-- Web Speech API。
-- 對應後端：module/tts.py、api/tts.py
--
-- 套用方式（既有資料庫，冪等，可重複執行）：
--   psql "$DATABASE_URL" -f spec/database/003_tts.sql
--
-- 全新空庫請改用 spec/database/schema.sql（已含此表）。
-- ============================================================

CREATE TABLE IF NOT EXISTS tts_cache (
    id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    language     VARCHAR(10)   NOT NULL,
    text         TEXT          NOT NULL,
    audio        BYTEA         NOT NULL,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT tts_cache_unique UNIQUE (language, text)
);
