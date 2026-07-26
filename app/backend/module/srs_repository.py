"""
SRS Repository — 固化記憶的雙軌佇列與 FSRS 狀態
================================================
srs_cards 多型指向 captures / course_vocabulary / course_sentences；
佇列以 LEFT JOIN 三張表組出卡面內容。

兩條互不干擾的軌道（依 item_type 判定，不需要額外欄位）：
  youtube ⇢ item_type = 'capture'
  course  ⇢ item_type IN ('vocabulary', 'sentence')

排程數學一律交給 module/fsrs_scheduler（官方 py-fsrs），本模組不含記憶公式。
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

import asyncpg

from backend.module import fsrs_scheduler

TRACK_YOUTUBE = "youtube"
TRACK_COURSE = "course"

# 軌道 → item_type 條件（參數化以避免字串拼接）
_TRACK_ITEM_TYPES = {
    TRACK_YOUTUBE: ["capture"],
    TRACK_COURSE: ["vocabulary", "sentence"],
}

# 佇列 JOIN：把三種 item_type 的內容攤平成統一卡面欄位
_QUEUE_SELECT = """
    SELECT
        sc.id            AS card_id,
        sc.item_type,
        sc.item_id,
        sc.state,
        sc.step,
        sc.stability,
        sc.difficulty,
        sc.due,
        sc.last_review,
        sc.reps,
        COALESCE(cap.term, cv.term, cs.target_text)                 AS term,
        COALESCE(cap.reading, cv.reading, cs.reading)               AS reading,
        COALESCE(cap.romaji, cv.romaji, cs.romaji)                  AS romaji,
        COALESCE(cap.translation, cv.meaning, cs.translation)       AS translation,
        COALESCE(cap.context_sentence, cv.example_sentence)         AS context_sentence,
        cap.sentence_translation,
        COALESCE(cv.audio_url, cs.audio_url)                        AS audio_url,
        cap.video_id,
        cap.video_url,
        cap.video_title,
        cap.start_seconds,
        COALESCE(cap.language::text, sv.language::text, ss.language::text) AS language,
        COALESCE(sv.title, ss.title)                                AS scenario_title,
        COALESCE(cov.title, cos.title)                              AS course_title
    FROM srs_cards sc
    LEFT JOIN captures cap
        ON sc.item_type = 'capture' AND cap.id::text = sc.item_id
    LEFT JOIN course_vocabulary cv
        ON sc.item_type = 'vocabulary' AND cv.id = sc.item_id
    LEFT JOIN courses cov ON cov.id = cv.course_id
    LEFT JOIN scenarios sv ON sv.id = cov.scenario_id
    LEFT JOIN course_sentences cs
        ON sc.item_type = 'sentence' AND cs.id = sc.item_id
    LEFT JOIN courses cos ON cos.id = cs.course_id
    LEFT JOIN scenarios ss ON ss.id = cos.scenario_id
"""


def _item_types(track: str) -> list[str]:
    return _TRACK_ITEM_TYPES.get(track, _TRACK_ITEM_TYPES[TRACK_YOUTUBE])


# 卡片語言：capture 直接有 language；課程項目要回溯到 scenarios.language
_LANGUAGE_EXPR = "COALESCE(cap.language::text, sv.language::text, ss.language::text)"


def _language_clause(language: Optional[str], param_index: int) -> str:
    """語言過濾條件（None 代表全部語言）。"""
    return f" AND {_LANGUAGE_EXPR} = ${param_index}" if language else ""


async def list_due_cards(
    conn: asyncpg.Connection,
    user_id: UUID,
    track: str,
    *,
    language: Optional[str] = None,
    limit: int = 50,
) -> list[asyncpg.Record]:
    """已到期（due <= now）且複習過的卡；新卡另外由 list_new_cards 取得。"""
    params: list = [user_id, _item_types(track)]
    lang_sql = ""
    if language:
        params.append(language)
        lang_sql = _language_clause(language, len(params))
    params.append(limit)

    return await conn.fetch(
        _QUEUE_SELECT
        + f"""
        WHERE sc.user_id = $1
          AND sc.item_type = ANY($2::text[])
          AND sc.due <= now()
          AND sc.last_review IS NOT NULL
          {lang_sql}
        ORDER BY sc.due
        LIMIT ${len(params)}
        """,
        *params,
    )


async def list_new_cards(
    conn: asyncpg.Connection,
    user_id: UUID,
    track: str,
    *,
    language: Optional[str] = None,
    limit: int,
) -> list[asyncpg.Record]:
    """尚未複習過的新卡（last_review IS NULL），依收藏時間由舊到新。"""
    if limit <= 0:
        return []
    params: list = [user_id, _item_types(track)]
    lang_sql = ""
    if language:
        params.append(language)
        lang_sql = _language_clause(language, len(params))
    params.append(limit)

    return await conn.fetch(
        _QUEUE_SELECT
        + f"""
        WHERE sc.user_id = $1
          AND sc.item_type = ANY($2::text[])
          AND sc.last_review IS NULL
          {lang_sql}
        ORDER BY sc.created_at
        LIMIT ${len(params)}
        """,
        *params,
    )


async def list_languages(
    conn: asyncpg.Connection,
    user_id: UUID,
    track: str,
) -> list[dict]:
    """該軌道實際有哪些語言的卡（供前端只顯示有卡片的語言分頁）。"""
    rows = await conn.fetch(
        _QUEUE_SELECT
        + """
        WHERE sc.user_id = $1 AND sc.item_type = ANY($2::text[])
        """,
        user_id,
        _item_types(track),
    )
    counts: dict[str, int] = {}
    for r in rows:
        lang = r["language"]
        if lang:
            counts[lang] = counts.get(lang, 0) + 1
    return [
        {"language": k, "count": v}
        for k, v in sorted(counts.items(), key=lambda kv: -kv[1])
    ]


async def count_new_introduced_today(
    conn: asyncpg.Connection,
    user_id: UUID,
    track: str,
) -> int:
    """
    今日已「introduce」的新卡數 —— 該卡的第一次複習發生在今天。
    用來扣減每日新卡額度。
    """
    return await conn.fetchval(
        """
        SELECT count(*)
        FROM (
            SELECT r.card_id, min(r.reviewed_at) AS first_review
            FROM srs_reviews r
            JOIN srs_cards c ON c.id = r.card_id
            WHERE r.user_id = $1 AND c.item_type = ANY($2::text[])
            GROUP BY r.card_id
        ) firsts
        WHERE firsts.first_review >= date_trunc('day', now())
        """,
        user_id,
        _item_types(track),
    ) or 0


async def get_daily_new_limit(
    conn: asyncpg.Connection,
    user_id: UUID,
    track: str,
) -> int:
    column = "daily_new_youtube" if track == TRACK_YOUTUBE else "daily_new_course"
    value = await conn.fetchval(
        f"SELECT {column} FROM user_profiles WHERE user_id = $1",
        user_id,
    )
    return int(value) if value is not None else 10


async def get_user_level(conn: asyncpg.Connection, user_id: UUID) -> str:
    """依使用者程度決定題型（初階辨認、中階以上挖空）。"""
    level = await conn.fetchval(
        "SELECT level::text FROM user_profiles WHERE user_id = $1",
        user_id,
    )
    return level or "beginner"


async def apply_review(
    conn: asyncpg.Connection,
    user_id: UUID,
    card_id: UUID,
    rating: int,
    *,
    response_ms: Optional[int] = None,
    prompt_type: Optional[str] = None,
    hint_used: bool = False,
    answer_revealed: bool = False,
    now: Optional[datetime] = None,
) -> Optional[dict]:
    """
    套用一次評分：以 py-fsrs 更新 srs_cards、寫入 srs_reviews。
    這是**唯一**會改動排程狀態的路徑（被動曝光不得經由此處）。
    """
    now = now or datetime.now(timezone.utc)
    async with conn.transaction():
        row = await conn.fetchrow(
            """
            SELECT id, stability, difficulty, state, step, due, last_review, reps, lapses
            FROM srs_cards
            WHERE id = $1 AND user_id = $2
            FOR UPDATE
            """,
            card_id,
            user_id,
        )
        if row is None:
            return None

        state_before = row["state"]
        last_review = row["last_review"]
        elapsed_days = (
            max((now - last_review).total_seconds() / 86400.0, 0.0) if last_review else 0.0
        )

        card = fsrs_scheduler.build_card(row)
        updated = fsrs_scheduler.review(card, rating, now=now, response_ms=response_ms)
        scheduled_days = max((updated.due - now).total_seconds() / 86400.0, 0.0)

        lapses = row["lapses"] + (1 if rating == 1 and state_before != 1 else 0)

        await conn.execute(
            """
            UPDATE srs_cards
            SET stability = $2, difficulty = $3, state = $4, step = $5,
                due = $6, last_review = $7, reps = $8, lapses = $9
            WHERE id = $1
            """,
            card_id,
            updated.stability,
            updated.difficulty,
            updated.state.value,
            updated.step,
            updated.due,
            now,
            row["reps"] + 1,
            lapses,
        )

        await conn.execute(
            """
            INSERT INTO srs_reviews
                (user_id, card_id, rating, state_before, elapsed_days, scheduled_days,
                 response_ms, prompt_type, hint_used, answer_revealed, reviewed_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            """,
            user_id,
            card_id,
            rating,
            state_before,
            elapsed_days,
            scheduled_days,
            response_ms,
            prompt_type,
            hint_used,
            answer_revealed,
            now,
        )

    return {
        "state": updated.state.value,
        "due": updated.due,
        "scheduled_days": scheduled_days,
    }


async def summary(
    conn: asyncpg.Connection,
    user_id: UUID,
    track: str,
    *,
    language: Optional[str] = None,
) -> dict:
    """
    固化記憶頁上方摘要（單一軌道，可再依語言過濾）。
    注意：每日新卡額度是**整條軌道共用**（總認知負荷），不隨語言切分，
    因此 new_remaining_today / daily_new_limit 不受 language 影響。
    """
    params: list = [user_id, _item_types(track)]
    lang_sql = ""
    if language:
        params.append(language)
        lang_sql = _language_clause(language, len(params))

    row = await conn.fetchrow(
        f"""
        SELECT
            count(*) FILTER (WHERE sc.due <= now() AND sc.last_review IS NOT NULL) AS due_count,
            count(*) FILTER (WHERE sc.last_review IS NULL)                         AS new_count,
            count(*)                                                               AS total_cards
        FROM srs_cards sc
        LEFT JOIN captures cap ON sc.item_type = 'capture' AND cap.id::text = sc.item_id
        LEFT JOIN course_vocabulary cv ON sc.item_type = 'vocabulary' AND cv.id = sc.item_id
        LEFT JOIN courses cov ON cov.id = cv.course_id
        LEFT JOIN scenarios sv ON sv.id = cov.scenario_id
        LEFT JOIN course_sentences cs ON sc.item_type = 'sentence' AND cs.id = sc.item_id
        LEFT JOIN courses cos ON cos.id = cs.course_id
        LEFT JOIN scenarios ss ON ss.id = cos.scenario_id
        WHERE sc.user_id = $1 AND sc.item_type = ANY($2::text[])
          {lang_sql}
        """,
        *params,
    )

    reviewed_today = await conn.fetchval(
        """
        SELECT count(*) FROM srs_reviews r
        JOIN srs_cards c ON c.id = r.card_id
        WHERE r.user_id = $1 AND c.item_type = ANY($2::text[])
          AND r.reviewed_at >= date_trunc('day', now())
        """,
        user_id,
        _item_types(track),
    )

    limit = await get_daily_new_limit(conn, user_id, track)
    introduced = await count_new_introduced_today(conn, user_id, track)
    return {
        "due_count": row["due_count"],
        "new_count": row["new_count"],
        "total_cards": row["total_cards"],
        "reviewed_today": reviewed_today or 0,
        "new_remaining_today": max(0, limit - introduced),
        "daily_new_limit": limit,
    }


async def set_daily_new_limit(
    conn: asyncpg.Connection,
    user_id: UUID,
    track: str,
    value: int,
) -> int:
    """調整每日新卡上限（規格建議初期 5–10、穩定後 10–20）。"""
    column = "daily_new_youtube" if track == TRACK_YOUTUBE else "daily_new_course"
    updated = await conn.fetchval(
        f"UPDATE user_profiles SET {column} = $2 WHERE user_id = $1 RETURNING {column}",
        user_id,
        value,
    )
    return int(updated) if updated is not None else value
