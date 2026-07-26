"""
擷取 Repository — Chrome 擴充從 YouTube 收藏的單字/句子
======================================================
建立擷取時，同一交易 upsert 一張 srs_cards（item_type='capture'），
達成「收藏內容自動進入 SRS」。
"""

import json
from typing import Optional
from uuid import UUID

import asyncpg

_CAPTURE_COLUMNS = """
    id, kind, language::text AS language, term, context_sentence,
    translation, sentence_translation, context_before, context_after,
    reading, romaji, video_id, video_url, video_title,
    start_seconds, created_at
"""


async def create_capture(
    conn: asyncpg.Connection,
    user_id: UUID,
    *,
    kind: str,
    language: str,
    term: str,
    context_sentence: Optional[str],
    translation: Optional[str],
    sentence_translation: Optional[str] = None,
    context_before: Optional[list] = None,
    context_after: Optional[list] = None,
    reading: Optional[str],
    romaji: Optional[str],
    video_id: str,
    video_url: str,
    video_title: Optional[str],
    start_seconds: float,
) -> asyncpg.Record:
    """建立擷取並自動排入 SRS；重複收藏（同 user/video/term/time）為冪等。"""
    before_json = json.dumps(context_before or [])
    after_json = json.dumps(context_after or [])
    async with conn.transaction():
        capture = await conn.fetchrow(
            """
            INSERT INTO captures (
                user_id, kind, language, term, context_sentence, translation,
                sentence_translation, context_before, context_after,
                reading, romaji, video_id, video_url, video_title, start_seconds
            )
            VALUES ($1, $2, $3::language_code, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
                    $10, $11, $12, $13, $14, $15)
            ON CONFLICT (user_id, video_id, term, start_seconds)
            DO UPDATE SET
                translation = COALESCE(EXCLUDED.translation, captures.translation),
                reading     = COALESCE(EXCLUDED.reading, captures.reading),
                romaji      = COALESCE(EXCLUDED.romaji, captures.romaji),
                context_sentence = COALESCE(EXCLUDED.context_sentence, captures.context_sentence),
                sentence_translation =
                    COALESCE(EXCLUDED.sentence_translation, captures.sentence_translation),
                -- 空陣列不覆蓋既有前後文
                context_before = CASE
                    WHEN jsonb_array_length(EXCLUDED.context_before) > 0
                    THEN EXCLUDED.context_before ELSE captures.context_before END,
                context_after = CASE
                    WHEN jsonb_array_length(EXCLUDED.context_after) > 0
                    THEN EXCLUDED.context_after ELSE captures.context_after END
            RETURNING *
            """,
            user_id, kind, language, term, context_sentence, translation,
            sentence_translation, before_json, after_json,
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
    query = f"""
        SELECT {_CAPTURE_COLUMNS}
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


async def update_context(
    conn: asyncpg.Connection,
    user_id: UUID,
    capture_id: UUID,
    *,
    context_after: Optional[list] = None,
    context_before: Optional[list] = None,
) -> Optional[asyncpg.Record]:
    """
    回填前後文（主要用途：後文在收藏當下尚未播出，由擴充事後補上）。
    只更新有傳入的欄位；傳空陣列視為「沒有要更新」，避免把既有內容清掉。
    """
    sets = []
    params: list = [user_id, capture_id]
    if context_after:
        params.append(json.dumps(context_after))
        sets.append(f"context_after = ${len(params)}::jsonb")
    if context_before:
        params.append(json.dumps(context_before))
        sets.append(f"context_before = ${len(params)}::jsonb")
    if not sets:
        return await conn.fetchrow(
            f"SELECT {_CAPTURE_COLUMNS} FROM captures WHERE user_id = $1 AND id = $2",
            user_id,
            capture_id,
        )

    return await conn.fetchrow(
        f"""
        UPDATE captures SET {", ".join(sets)}
        WHERE user_id = $1 AND id = $2
        RETURNING {_CAPTURE_COLUMNS}
        """,
        *params,
    )


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
