"""
擷取 Repository — Chrome 擴充從 YouTube 收藏的單字/句子
======================================================
建立擷取時，同一交易 upsert 一張 srs_cards（item_type='capture'），
達成「收藏內容自動進入 SRS」。
"""

from typing import Optional
from uuid import UUID

import asyncpg


async def create_capture(
    conn: asyncpg.Connection,
    user_id: UUID,
    *,
    kind: str,
    language: str,
    term: str,
    context_sentence: Optional[str],
    translation: Optional[str],
    reading: Optional[str],
    romaji: Optional[str],
    video_id: str,
    video_url: str,
    video_title: Optional[str],
    start_seconds: float,
) -> asyncpg.Record:
    """建立擷取並自動排入 SRS；重複收藏（同 user/video/term/time）為冪等。"""
    async with conn.transaction():
        capture = await conn.fetchrow(
            """
            INSERT INTO captures (
                user_id, kind, language, term, context_sentence, translation,
                reading, romaji, video_id, video_url, video_title, start_seconds
            )
            VALUES ($1, $2, $3::language_code, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (user_id, video_id, term, start_seconds)
            DO UPDATE SET
                translation = COALESCE(EXCLUDED.translation, captures.translation),
                reading     = COALESCE(EXCLUDED.reading, captures.reading),
                romaji      = COALESCE(EXCLUDED.romaji, captures.romaji),
                context_sentence = COALESCE(EXCLUDED.context_sentence, captures.context_sentence)
            RETURNING *
            """,
            user_id, kind, language, term, context_sentence, translation,
            reading, romaji, video_id, video_url, video_title, start_seconds,
        )

        await conn.execute(
            """
            INSERT INTO srs_cards (user_id, item_type, item_id, state, due)
            VALUES ($1, 'capture', $2, 0, now())
            ON CONFLICT (user_id, item_type, item_id) DO NOTHING
            """,
            user_id,
            str(capture["id"]),
        )

    return capture


async def list_captures(
    conn: asyncpg.Connection,
    user_id: UUID,
    *,
    language: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[asyncpg.Record]:
    query = """
        SELECT id, kind, language::text AS language, term, context_sentence,
               translation, reading, romaji, video_id, video_url, video_title,
               start_seconds, created_at
        FROM captures
        WHERE user_id = $1
    """
    params: list = [user_id]
    if language:
        query += " AND language = $2::language_code"
        params.append(language)
    query += f" ORDER BY created_at DESC LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}"
    params.extend([limit, offset])
    return await conn.fetch(query, *params)


async def delete_capture(conn: asyncpg.Connection, user_id: UUID, capture_id: UUID) -> bool:
    """刪除擷取，並移除對應的 srs 卡片。"""
    async with conn.transaction():
        result = await conn.execute(
            "DELETE FROM captures WHERE user_id = $1 AND id = $2",
            user_id,
            capture_id,
        )
        if result.endswith("1"):
            await conn.execute(
                "DELETE FROM srs_cards WHERE user_id = $1 AND item_type = 'capture' AND item_id = $2",
                user_id,
                str(capture_id),
            )
            return True
    return False
