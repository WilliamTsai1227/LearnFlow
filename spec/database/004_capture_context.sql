-- ============================================================
-- LearnFlow — Migration 004：擷取的整句翻譯與前後文
-- ============================================================
-- 用途：擴充改為「只收藏單字」，但實際寫入的是該單字所在的完整句子，
-- 並連同前兩句、後兩句一起保存，讓收藏頁能展開完整上下文。
--
--   sentence_translation — context_sentence（整句）的翻譯
--                          （translation 欄位維持存「單字」在句中的字義）
--   context_before       — 前文，JSONB 陣列 [{"text": "...", "translation": "..."}]
--   context_after        — 後文，同上格式
--
-- 後文在收藏當下尚未播出，因此由擴充在後續字幕出現後，
-- 以 PATCH /api/captures/{id}/context 回填（best-effort）。
--
-- 套用方式（既有資料庫，冪等，可重複執行）：
--   psql "$DATABASE_URL" -f spec/database/004_capture_context.sql
--
-- 全新空庫請改用 spec/database/schema.sql（已含這些欄位）。
-- ============================================================

ALTER TABLE captures
    ADD COLUMN IF NOT EXISTS sentence_translation TEXT;

ALTER TABLE captures
    ADD COLUMN IF NOT EXISTS context_before JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE captures
    ADD COLUMN IF NOT EXISTS context_after JSONB NOT NULL DEFAULT '[]'::jsonb;
