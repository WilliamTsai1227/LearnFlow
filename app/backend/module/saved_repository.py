from typing import Any, Optional
from uuid import UUID

import asyncpg


async def vocabulary_exists(conn: asyncpg.Connection, vocabulary_id: str) -> bool:
    row = await conn.fetchval(
        "SELECT 1 FROM course_vocabulary WHERE id = $1",
        vocabulary_id,
    )
    return row is not None


async def sentence_exists(conn: asyncpg.Connection, sentence_id: str) -> bool:
    row = await conn.fetchval(
        "SELECT 1 FROM course_sentences WHERE id = $1",
        sentence_id,
    )
    return row is not None


async def save_vocabulary(
    conn: asyncpg.Connection,
    user_id: UUID,
    vocabulary_id: str,
) -> asyncpg.Record:
    return await conn.fetchrow(
        """
        INSERT INTO user_saved_vocabulary (user_id, vocabulary_id)
        VALUES ($1, $2)
        RETURNING id, vocabulary_id, created_at
        """,
        user_id,
        vocabulary_id,
    )


async def save_sentence(
    conn: asyncpg.Connection,
    user_id: UUID,
    sentence_id: str,
) -> asyncpg.Record:
    return await conn.fetchrow(
        """
        INSERT INTO user_saved_sentences (user_id, sentence_id)
        VALUES ($1, $2)
        RETURNING id, sentence_id, created_at
        """,
        user_id,
        sentence_id,
    )


async def delete_saved_vocabulary(
    conn: asyncpg.Connection,
    user_id: UUID,
    vocabulary_id: str,
) -> bool:
    result = await conn.execute(
        """
        DELETE FROM user_saved_vocabulary
        WHERE user_id = $1 AND vocabulary_id = $2
        """,
        user_id,
        vocabulary_id,
    )
    return result.endswith("1")


async def delete_saved_sentence(
    conn: asyncpg.Connection,
    user_id: UUID,
    sentence_id: str,
) -> bool:
    result = await conn.execute(
        """
        DELETE FROM user_saved_sentences
        WHERE user_id = $1 AND sentence_id = $2
        """,
        user_id,
        sentence_id,
    )
    return result.endswith("1")


async def delete_saved_by_id(
    conn: asyncpg.Connection,
    user_id: UUID,
    saved_id: UUID,
) -> bool:
    deleted_vocab = await conn.execute(
        """
        DELETE FROM user_saved_vocabulary
        WHERE user_id = $1 AND id = $2
        """,
        user_id,
        saved_id,
    )
    if deleted_vocab.endswith("1"):
        return True

    deleted_sentence = await conn.execute(
        """
        DELETE FROM user_saved_sentences
        WHERE user_id = $1 AND id = $2
        """,
        user_id,
        saved_id,
    )
    return deleted_sentence.endswith("1")


async def list_saved_vocabulary(
    conn: asyncpg.Connection,
    user_id: UUID,
    language: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[asyncpg.Record]:
    query = """
        SELECT
            sv.id,
            sv.vocabulary_id AS item_id,
            sv.created_at,
            cv.term,
            cv.reading,
            cv.meaning,
            cv.example_sentence,
            cv.audio_url,
            cv.course_id,
            c.scenario_id,
            s.language::text AS language,
            s.title AS scenario_title,
            c.title AS course_title
        FROM user_saved_vocabulary sv
        JOIN course_vocabulary cv ON cv.id = sv.vocabulary_id
        JOIN courses c ON c.id = cv.course_id
        JOIN scenarios s ON s.id = c.scenario_id
        WHERE sv.user_id = $1
    """
    params: list[Any] = [user_id]

    if language:
        query += " AND s.language = $2::language_code"
        params.append(language)

    query += f" ORDER BY sv.created_at DESC LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}"
    params.extend([limit, offset])

    return await conn.fetch(query, *params)


async def list_saved_sentences(
    conn: asyncpg.Connection,
    user_id: UUID,
    language: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[asyncpg.Record]:
    query = """
        SELECT
            ss.id,
            ss.sentence_id AS item_id,
            ss.created_at,
            cs.target_text,
            cs.reading,
            cs.translation,
            cs.audio_url,
            cs.course_id,
            c.scenario_id,
            s.language::text AS language,
            s.title AS scenario_title,
            c.title AS course_title
        FROM user_saved_sentences ss
        JOIN course_sentences cs ON cs.id = ss.sentence_id
        JOIN courses c ON c.id = cs.course_id
        JOIN scenarios s ON s.id = c.scenario_id
        WHERE ss.user_id = $1
    """
    params: list[Any] = [user_id]

    if language:
        query += " AND s.language = $2::language_code"
        params.append(language)

    query += f" ORDER BY ss.created_at DESC LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}"
    params.extend([limit, offset])

    return await conn.fetch(query, *params)
