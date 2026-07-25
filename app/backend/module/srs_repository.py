"""
SRS Repository — 統一複習佇列與 FSRS 狀態
=========================================
srs_cards 多型指向 captures / course_vocabulary / course_sentences；
複習佇列以 LEFT JOIN 三張表組出卡面內容。
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

import asyncpg

from backend.module import fsrs

# 佇列 JOIN：把三種 item_type 的內容攤平成統一卡面欄位
_QUEUE_SELECT = """
    SELECT
        sc.id            AS card_id,
        sc.item_type,
        sc.item_id,
        sc.state,
        sc.due,
        COALESCE(cap.term, cv.term, cs.target_text)                 AS term,
        COALESCE(cap.reading, cv.reading, cs.reading)               AS reading,
        COALESCE(cap.romaji, cv.romaji, cs.romaji)                  AS romaji,
        COALESCE(cap.translation, cv.meaning, cs.translation)       AS translation,
        COALESCE(cap.context_sentence, cv.example_sentence)         AS context_sentence,
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


async def list_due_cards(
    conn: asyncpg.Connection,
    user_id: UUID,
    *,
    limit: int = 30,
) -> list[asyncpg.Record]:
    """今日到期（due <= now）的複習佇列，new 卡優先排最後，其餘依 due 由早到晚。"""
    return await conn.fetch(
        _QUEUE_SELECT
        + """
        WHERE sc.user_id = $1 AND sc.due <= now()
        ORDER BY sc.state = 0, sc.due
        LIMIT $2
        """,
        user_id,
        limit,
    )


async def get_card(
    conn: asyncpg.Connection,
    user_id: UUID,
    card_id: UUID,
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        """
        SELECT id, item_type, item_id, stability, difficulty, state,
               due, last_review, reps, lapses
        FROM srs_cards
        WHERE id = $1 AND user_id = $2
        """,
        card_id,
        user_id,
    )


async def apply_review(
    conn: asyncpg.Connection,
    user_id: UUID,
    card_id: UUID,
    rating: int,
    *,
    now: Optional[datetime] = None,
) -> Optional[fsrs.ReviewResult]:
    """套用一次評分：更新 srs_cards、寫入 srs_reviews；回傳新的排程結果。"""
    now = now or datetime.now(timezone.utc)
    async with conn.transaction():
        row = await conn.fetchrow(
            """
            SELECT id, stability, difficulty, state, last_review, reps, lapses
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
        card = fsrs.CardState(
            stability=row["stability"],
            difficulty=row["difficulty"],
            state=row["state"],
            last_review=row["last_review"],
            reps=row["reps"],
            lapses=row["lapses"],
        )
        result = fsrs.review(card, rating, now)

        await conn.execute(
            """
            UPDATE srs_cards
            SET stability = $2, difficulty = $3, state = $4, due = $5,
                last_review = $6, reps = $7, lapses = $8
            WHERE id = $1
            """,
            card_id,
            result.stability,
            result.difficulty,
            result.state,
            result.due,
            now,
            result.reps,
            result.lapses,
        )

        await conn.execute(
            """
            INSERT INTO srs_reviews
                (user_id, card_id, rating, state_before, elapsed_days, scheduled_days, reviewed_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            user_id,
            card_id,
            rating,
            state_before,
            result.elapsed_days,
            result.scheduled_days,
            now,
        )

    return result


async def summary(conn: asyncpg.Connection, user_id: UUID) -> dict:
    """複習頁上方摘要：待複習數、今日已複習數、卡片總數。"""
    row = await conn.fetchrow(
        """
        SELECT
            (SELECT count(*) FROM srs_cards WHERE user_id = $1 AND due <= now())            AS due_count,
            (SELECT count(*) FROM srs_cards WHERE user_id = $1)                             AS total_cards,
            (SELECT count(*) FROM srs_reviews
                WHERE user_id = $1 AND reviewed_at >= date_trunc('day', now()))             AS reviewed_today
        """,
        user_id,
    )
    return {
        "due_count": row["due_count"],
        "total_cards": row["total_cards"],
        "reviewed_today": row["reviewed_today"],
    }
