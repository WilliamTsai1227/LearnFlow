from typing import Any, Optional

import asyncpg


async def list_scenarios(
    conn: asyncpg.Connection,
    language: Optional[str] = None,
) -> list[asyncpg.Record]:
    query = """
        SELECT
            s.id,
            s.title,
            s.language,
            s.description,
            s.sort_order,
            COUNT(c.id)::int AS course_count
        FROM scenarios s
        LEFT JOIN courses c ON c.scenario_id = s.id
        WHERE s.is_published = true
    """
    params: list[Any] = []

    if language:
        query += " AND s.language = $1"
        params.append(language)

    query += """
        GROUP BY s.id
        ORDER BY s.sort_order, s.id
    """
    return await conn.fetch(query, *params)


async def get_scenario(
    conn: asyncpg.Connection,
    scenario_id: str,
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        """
        SELECT id, title, language, description, sort_order
        FROM scenarios
        WHERE id = $1 AND is_published = true
        """,
        scenario_id,
    )


async def list_courses_by_scenario(
    conn: asyncpg.Connection,
    scenario_id: str,
) -> list[asyncpg.Record]:
    return await conn.fetch(
        """
        SELECT
            c.id,
            c.scenario_id,
            c.title,
            c.level,
            c.order_index,
            c.description,
            c.estimated_minutes,
            COUNT(DISTINCT cs.id)::int AS sentence_count,
            COUNT(DISTINCT cv.id)::int AS vocabulary_count
        FROM courses c
        LEFT JOIN course_sentences cs ON cs.course_id = c.id
        LEFT JOIN course_vocabulary cv ON cv.course_id = c.id
        WHERE c.scenario_id = $1
        GROUP BY c.id
        ORDER BY c.order_index
        """,
        scenario_id,
    )


async def get_course(
    conn: asyncpg.Connection,
    scenario_id: str,
    course_id: str,
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        """
        SELECT
            id,
            scenario_id,
            title,
            level,
            order_index,
            description,
            estimated_minutes
        FROM courses
        WHERE id = $1 AND scenario_id = $2
        """,
        course_id,
        scenario_id,
    )


async def list_sentences_by_course(
    conn: asyncpg.Connection,
    course_id: str,
) -> list[asyncpg.Record]:
    return await conn.fetch(
        """
        SELECT id, order_index, target_text, reading, translation, audio_url
        FROM course_sentences
        WHERE course_id = $1
        ORDER BY order_index
        """,
        course_id,
    )


async def list_vocabulary_by_course(
    conn: asyncpg.Connection,
    course_id: str,
) -> list[asyncpg.Record]:
    return await conn.fetch(
        """
        SELECT id, order_index, term, reading, meaning, example_sentence, audio_url
        FROM course_vocabulary
        WHERE course_id = $1
        ORDER BY order_index
        """,
        course_id,
    )
