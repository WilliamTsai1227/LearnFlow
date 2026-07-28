from typing import Optional
from uuid import UUID

import asyncpg


async def list_other_scenario_titles(
    conn: asyncpg.Connection,
    language: str,
    exclude_scenario_id: str,
    limit: int = 8,
) -> list[str]:
    rows = await conn.fetch(
        """
        SELECT title
        FROM scenarios
        WHERE language = $1 AND id <> $2 AND is_published = true
        ORDER BY sort_order, id
        LIMIT $3
        """,
        language,
        exclude_scenario_id,
        limit,
    )
    return [row["title"] for row in rows]


async def list_sibling_course_translations(
    conn: asyncpg.Connection,
    scenario_id: str,
    exclude_course_id: str,
    limit: int = 20,
) -> list[str]:
    """
    同一情境下、其他課程的句子翻譯 —— 盲聽測驗的干擾項優先用這些。
    來自完全不同情境的句子（例如「辦公室」對上「咖啡廳」）用主題就能排除，
    題目會變得太好猜；同情境的句子在語境上同樣合理，才真的需要聽懂內容。
    """
    rows = await conn.fetch(
        """
        SELECT cs.translation
        FROM course_sentences cs
        JOIN courses c ON c.id = cs.course_id
        WHERE c.scenario_id = $1 AND cs.course_id <> $2
        ORDER BY cs.course_id, cs.order_index
        LIMIT $3
        """,
        scenario_id,
        exclude_course_id,
        limit,
    )
    return [row["translation"] for row in rows]


async def list_other_course_translations(
    conn: asyncpg.Connection,
    language: str,
    exclude_course_id: str,
    limit: int = 12,
) -> list[str]:
    rows = await conn.fetch(
        """
        SELECT cs.translation
        FROM course_sentences cs
        JOIN courses c ON c.id = cs.course_id
        JOIN scenarios s ON s.id = c.scenario_id
        WHERE s.language = $1 AND cs.course_id <> $2
        ORDER BY cs.course_id, cs.order_index
        LIMIT $3
        """,
        language,
        exclude_course_id,
        limit,
    )
    return [row["translation"] for row in rows]


async def get_progress(
    conn: asyncpg.Connection,
    user_id: UUID,
    course_id: str,
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        """
        SELECT course_id, current_step, completed, score, updated_at
        FROM user_course_progress
        WHERE user_id = $1 AND course_id = $2
        """,
        user_id,
        course_id,
    )


async def upsert_progress(
    conn: asyncpg.Connection,
    user_id: UUID,
    course_id: str,
    current_step: int,
    completed: bool,
    score: Optional[int],
) -> asyncpg.Record:
    return await conn.fetchrow(
        """
        INSERT INTO user_course_progress
            (user_id, course_id, current_step, completed, score, completed_at)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 THEN now() END)
        ON CONFLICT (user_id, course_id) DO UPDATE SET
            current_step = GREATEST(user_course_progress.current_step, EXCLUDED.current_step),
            completed = user_course_progress.completed OR EXCLUDED.completed,
            score = COALESCE(EXCLUDED.score, user_course_progress.score),
            completed_at = COALESCE(user_course_progress.completed_at, EXCLUDED.completed_at),
            updated_at = now()
        RETURNING course_id, current_step, completed, score, updated_at
        """,
        user_id,
        course_id,
        current_step,
        completed,
        score,
    )


async def insert_attempts(
    conn: asyncpg.Connection,
    user_id: UUID,
    course_id: str,
    attempts: list[dict],
) -> int:
    if not attempts:
        return 0
    await conn.executemany(
        """
        INSERT INTO practice_attempts
            (user_id, course_id, step_type, exercise_kind, item_type, item_id, is_correct)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        """,
        [
            (
                user_id,
                course_id,
                attempt["step_type"],
                attempt["exercise_kind"],
                attempt.get("item_type"),
                attempt.get("item_id"),
                attempt["is_correct"],
            )
            for attempt in attempts
        ],
    )
    return len(attempts)
