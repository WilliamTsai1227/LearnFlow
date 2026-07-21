#!/usr/bin/env python3
"""Generate scenario_seed.sql from the curated seed_content.py file."""

from __future__ import annotations

from pathlib import Path

from seed_content import COURSE_CONTENT, SCENARIOS

OUTPUT = Path(__file__).with_name("scenario_seed.sql")
SENTENCE_COUNT = 15
VOCAB_COUNT = 30

# Google SSO 會員表（不在下方 DROP 範圍內；重跑種子不會清除 users / refresh_tokens）
AUTH_DDL_LINES: list[str] = [
    "-- ------------------------------------------------------------",
    "-- 會員系統（Google SSO only）— 對齊 Stock-Insight-Chat auth 表",
    "-- 不在下方 DROP 範圍；重跑種子只重建情境內容表",
    "-- 後端流程：GET /auth/google/start → callback → refresh_tokens Cookie → POST /auth/refresh",
    "-- ------------------------------------------------------------",
    "",
    "DO $$ BEGIN",
    "    CREATE TYPE subscription_tier AS ENUM ('free', 'pro');",
    "EXCEPTION WHEN duplicate_object THEN NULL;",
    "END $$;",
    "",
    "DO $$ BEGIN",
    "    CREATE TYPE user_status AS ENUM ('active', 'disabled', 'pending');",
    "EXCEPTION WHEN duplicate_object THEN NULL;",
    "END $$;",
    "",
    "CREATE TABLE IF NOT EXISTS users (",
    "    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),",
    "    email               VARCHAR(255) NOT NULL,",
    "    username            VARCHAR(100) NOT NULL,",
    "    google_sub          TEXT         NOT NULL,",
    "    display_name        VARCHAR(100),",
    "    avatar_url          TEXT,",
    "    last_login_provider VARCHAR(32)  NOT NULL DEFAULT 'google',",
    "    status              user_status  NOT NULL DEFAULT 'active',",
    "    subscription_tier   subscription_tier NOT NULL DEFAULT 'free',",
    "    last_login_at       TIMESTAMPTZ,",
    "    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),",
    "    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),",
    "    deleted_at          TIMESTAMPTZ,",
    "    CONSTRAINT users_email_unique UNIQUE (email),",
    "    CONSTRAINT users_username_unique UNIQUE (username),",
    "    CONSTRAINT users_google_sub_unique UNIQUE (google_sub)",
    ");",
    "",
    "CREATE TABLE IF NOT EXISTS refresh_tokens (",
    "    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),",
    "    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
    "    token      TEXT        NOT NULL,",
    "    expires_at TIMESTAMPTZ NOT NULL,",
    "    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),",
    "    CONSTRAINT refresh_tokens_token_unique UNIQUE (token)",
    ");",
    "",
    "CREATE TABLE IF NOT EXISTS user_profiles (",
    "    user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,",
    "    native_language        VARCHAR(10)     NOT NULL DEFAULT 'zh-TW',",
    "    active_languages       language_code[] NOT NULL DEFAULT '{}',",
    "    level                  level_code      NOT NULL DEFAULT 'beginner',",
    "    interests              TEXT[]          NOT NULL DEFAULT '{}',",
    "    daily_goal_minutes     SMALLINT        NOT NULL DEFAULT 30,",
    "    speech_speed           DECIMAL(3,2)    NOT NULL DEFAULT 1.00,",
    "    ai_feedback_strictness VARCHAR(20)     NOT NULL DEFAULT 'normal',",
    "    ui_language            VARCHAR(10)     NOT NULL DEFAULT 'zh-TW',",
    "    timezone               VARCHAR(50)     NOT NULL DEFAULT 'Asia/Taipei',",
    "    updated_at             TIMESTAMPTZ     NOT NULL DEFAULT now()",
    ");",
    "",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_active",
    "    ON users (email) WHERE deleted_at IS NULL;",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_users_google_sub ON users (google_sub);",
    "CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);",
    "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);",
    "CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens (expires_at);",
    "",
]

# 收藏表須在 course_vocabulary / course_sentences 建立後才能加 FK
SAVED_DDL_LINES: list[str] = [
    "-- ------------------------------------------------------------",
    "-- 收藏（FK 至內容表；重跑種子 DROP 內容表時會一併清除收藏列）",
    "-- ------------------------------------------------------------",
    "",
    "CREATE TABLE IF NOT EXISTS user_saved_vocabulary (",
    "    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),",
    "    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
    "    vocabulary_id  VARCHAR(50) NOT NULL REFERENCES course_vocabulary(id) ON DELETE CASCADE,",
    "    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),",
    "    CONSTRAINT user_saved_vocabulary_unique UNIQUE (user_id, vocabulary_id)",
    ");",
    "",
    "CREATE TABLE IF NOT EXISTS user_saved_sentences (",
    "    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),",
    "    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
    "    sentence_id VARCHAR(50) NOT NULL REFERENCES course_sentences(id) ON DELETE CASCADE,",
    "    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),",
    "    CONSTRAINT user_saved_sentences_unique UNIQUE (user_id, sentence_id)",
    ");",
    "",
    "CREATE INDEX IF NOT EXISTS idx_user_saved_vocabulary_user",
    "    ON user_saved_vocabulary (user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_user_saved_vocabulary_vocab",
    "    ON user_saved_vocabulary (vocabulary_id);",
    "CREATE INDEX IF NOT EXISTS idx_user_saved_sentences_user",
    "    ON user_saved_sentences (user_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_user_saved_sentences_sentence",
    "    ON user_saved_sentences (sentence_id);",
    "",
]


def sql_str(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def validate_content() -> None:
    expected_course_ids: list[str] = []
    for scenario in SCENARIOS:
        for course in scenario["courses"]:
            course_id = course["id"]
            expected_course_ids.append(course_id)
            if course_id not in COURSE_CONTENT:
                raise ValueError(f"Missing course content: {course_id}")

    extra = sorted(set(COURSE_CONTENT) - set(expected_course_ids))
    if extra:
        raise ValueError(f"Course content has unknown ids: {extra[:5]}")

    for course_id, content in COURSE_CONTENT.items():
        sentence_count = len(content["sentences"])
        vocab_count = len(content["vocabulary"])
        if sentence_count != SENTENCE_COUNT:
            raise ValueError(f"{course_id} has {sentence_count} sentences, expected {SENTENCE_COUNT}")
        if vocab_count != VOCAB_COUNT:
            raise ValueError(f"{course_id} has {vocab_count} vocabulary items, expected {VOCAB_COUNT}")

        for idx, sentence in enumerate(content["sentences"], start=1):
            target, _reading, translation = sentence
            if not target.strip() or not translation.strip():
                raise ValueError(f"{course_id} sentence {idx} has blank target or translation")
            if translation in {"（英文對話）", "（日文對話）"}:
                raise ValueError(f"{course_id} sentence {idx} has fallback translation")

        sentence_blob = " ".join(sentence[0].lower() for sentence in content["sentences"])
        for idx, item in enumerate(content["vocabulary"], start=1):
            term, _reading, meaning, example = item
            if not term.strip() or not meaning.strip() or not example.strip():
                raise ValueError(f"{course_id} vocabulary {idx} has blank required field")
            if term.lower() not in sentence_blob:
                raise ValueError(f"{course_id} vocabulary {idx} is not extracted from dialogue: {term}")


def generate() -> str:
    validate_content()

    lines: list[str] = [
        "-- ============================================================",
        "-- LearnFlow — 情境學習種子資料（scenario_seed.sql）",
        "-- ============================================================",
        "-- 用途：建立 Schema 並寫入已人工整理過的情境學習種子資料。",
        "-- 來源：spec/operate/seed_content.py",
        "-- 規格：每課 15 句真實對話 + 30 個從對話萃取的關鍵單字。",
        "--",
        "-- 注意：本檔開頭會 DROP 並重建 scenarios / courses / course_sentences / course_vocabulary，",
        "--       執行後舊情境資料會全部清除再重新載入。",
        "--       users / refresh_tokens / user_profiles 不在 DROP 範圍，使用者資料會保留。",
        "--       收藏表 FK 至內容表，重跑種子時收藏列會一併清除。",
        "-- ============================================================",
        "",
        "DROP TABLE IF EXISTS user_saved_vocabulary, user_saved_sentences CASCADE;",
        "DROP TABLE IF EXISTS course_vocabulary, course_sentences, courses, scenarios CASCADE;",
        "",
        "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\";",
        "",
        "DO $$ BEGIN",
        "    CREATE TYPE language_code AS ENUM ('english', 'japanese');",
        "EXCEPTION WHEN duplicate_object THEN NULL;",
        "END $$;",
        "",
        "DO $$ BEGIN",
        "    CREATE TYPE level_code AS ENUM ('beginner', 'intermediate', 'advanced');",
        "EXCEPTION WHEN duplicate_object THEN NULL;",
        "END $$;",
        "",
        *AUTH_DDL_LINES,
        "CREATE TABLE scenarios (",
        "    id            VARCHAR(50)  PRIMARY KEY,",
        "    title         VARCHAR(255) NOT NULL,",
        "    language      language_code NOT NULL,",
        "    description   TEXT         NOT NULL,",
        "    sort_order    SMALLINT     NOT NULL DEFAULT 0,",
        "    is_published  BOOLEAN      NOT NULL DEFAULT true,",
        "    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),",
        "    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()",
        ");",
        "",
        "CREATE TABLE courses (",
        "    id                VARCHAR(50)  PRIMARY KEY,",
        "    scenario_id       VARCHAR(50)  NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,",
        "    title             VARCHAR(255) NOT NULL,",
        "    level             level_code   NOT NULL DEFAULT 'beginner',",
        "    order_index       SMALLINT     NOT NULL,",
        "    description       TEXT         NOT NULL DEFAULT '',",
        "    estimated_minutes SMALLINT     NOT NULL DEFAULT 10,",
        "    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),",
        "    UNIQUE (scenario_id, order_index)",
        ");",
        "",
        "CREATE INDEX idx_courses_scenario ON courses (scenario_id, order_index);",
        "",
        "CREATE TABLE course_sentences (",
        "    id           VARCHAR(50) PRIMARY KEY,",
        "    course_id    VARCHAR(50) NOT NULL REFERENCES courses(id) ON DELETE CASCADE,",
        "    order_index  SMALLINT    NOT NULL,",
        "    target_text  TEXT        NOT NULL,",
        "    reading      TEXT,",
        "    romaji       TEXT,",
        "    translation  TEXT        NOT NULL,",
        "    audio_url    TEXT,",
        "    UNIQUE (course_id, order_index)",
        ");",
        "",
        "CREATE INDEX idx_sentences_course ON course_sentences (course_id, order_index);",
        "",
        "CREATE TABLE course_vocabulary (",
        "    id               VARCHAR(50)  PRIMARY KEY,",
        "    course_id        VARCHAR(50)  NOT NULL REFERENCES courses(id) ON DELETE CASCADE,",
        "    order_index      SMALLINT     NOT NULL,",
        "    term             VARCHAR(100) NOT NULL,",
        "    reading          VARCHAR(200),",
        "    romaji           VARCHAR(300),",
        "    meaning          TEXT         NOT NULL,",
        "    example_sentence TEXT,",
        "    audio_url        TEXT,",
        "    UNIQUE (course_id, order_index)",
        ");",
        "",
        "CREATE INDEX idx_vocabulary_course ON course_vocabulary (course_id, order_index);",
        "",
        *SAVED_DDL_LINES,
        "INSERT INTO scenarios (id, title, language, description, sort_order) VALUES",
    ]

    scenario_rows = [
        f"('{scenario['id']}', {sql_str(scenario['title'])}, '{scenario['language']}', "
        f"{sql_str(scenario['description'])}, {scenario['sort_order']})"
        for scenario in SCENARIOS
    ]
    lines.append(",\n".join(scenario_rows) + ";")

    lines.append("")
    lines.append("INSERT INTO courses (id, scenario_id, title, level, order_index, description, estimated_minutes) VALUES")
    course_rows: list[str] = []
    sentence_rows: list[str] = []
    vocab_rows: list[str] = []

    for scenario in SCENARIOS:
        scenario_id = scenario["id"]
        lang_folder = scenario["lang_folder"]
        for course in scenario["courses"]:
            course_id = course["id"]
            course_rows.append(
                f"('{course_id}', '{scenario_id}', {sql_str(course['title'])}, '{course['level']}', "
                f"{course['order_index']}, {sql_str(course['description'])}, {course['estimated_minutes']})"
            )

            content = COURSE_CONTENT[course_id]
            for idx, (target, reading, translation) in enumerate(content["sentences"], start=1):
                audio = f"audio/{lang_folder}/{scenario_id}/{course_id}/s{idx:02d}.mp3"
                sentence_rows.append(
                    f"('{course_id}-s{idx:02d}', '{course_id}', {idx}, {sql_str(target)}, "
                    f"{sql_str(reading)}, {sql_str(translation)}, '{audio}')"
                )

            for idx, (term, reading, meaning, example) in enumerate(content["vocabulary"], start=1):
                audio = f"audio/{lang_folder}/{scenario_id}/{course_id}/v{idx:02d}.mp3"
                vocab_rows.append(
                    f"('{course_id}-v{idx:02d}', '{course_id}', {idx}, {sql_str(term)}, "
                    f"{sql_str(reading)}, {sql_str(meaning)}, {sql_str(example)}, '{audio}')"
                )

    lines.append(",\n".join(course_rows) + ";")

    lines.append("")
    lines.append("INSERT INTO course_sentences (id, course_id, order_index, target_text, reading, translation, audio_url) VALUES")
    lines.append(_chunked_values(sentence_rows))

    lines.append("")
    lines.append("INSERT INTO course_vocabulary (id, course_id, order_index, term, reading, meaning, example_sentence, audio_url) VALUES")
    lines.append(_chunked_values(vocab_rows))

    lines.extend(
        [
            "",
            "-- 驗證查詢",
            "SELECT language, COUNT(*) FROM scenarios GROUP BY language;",
            "SELECT COUNT(*) AS total_courses FROM courses;",
            "SELECT COUNT(*) AS total_sentences FROM course_sentences;",
            "SELECT COUNT(*) AS total_vocabulary FROM course_vocabulary;",
            "",
            "-- 檢查每課是否皆為 15 句、30 字（應 0 rows）",
            "SELECT c.id,",
            "       (SELECT COUNT(*) FROM course_sentences cs WHERE cs.course_id = c.id) AS sentence_count,",
            "       (SELECT COUNT(*) FROM course_vocabulary cv WHERE cv.course_id = c.id) AS vocab_count",
            "FROM courses c",
            "WHERE (SELECT COUNT(*) FROM course_sentences cs WHERE cs.course_id = c.id) <> 15",
            "   OR (SELECT COUNT(*) FROM course_vocabulary cv WHERE cv.course_id = c.id) <> 30",
            "ORDER BY c.id;",
        ]
    )
    return "\n".join(lines) + "\n"


def _chunked_values(rows: list[str], chunk_size: int = 50) -> str:
    chunks: list[str] = []
    for start in range(0, len(rows), chunk_size):
        chunk = rows[start : start + chunk_size]
        suffix = "," if start + chunk_size < len(rows) else ";"
        chunks.append(",\n".join(chunk) + suffix)
    return "\n".join(chunks)


if __name__ == "__main__":
    sql = generate()
    OUTPUT.write_text(sql, encoding="utf-8")
    print(f"Wrote {OUTPUT} ({len(sql.splitlines())} lines)")
