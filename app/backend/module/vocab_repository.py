from typing import Any, Optional

import asyncpg


async def list_decks(
    conn: asyncpg.Connection,
    language: Optional[str] = None,
) -> list[asyncpg.Record]:
    query = """
        SELECT
            d.id, d.language, d.kind, d.title, d.description, d.sort_order,
            COUNT(vi.id)::int AS item_count
        FROM vocab_decks d
        LEFT JOIN vocab_items vi ON vi.deck_id = d.id
        WHERE d.is_published = true
    """
    params: list[Any] = []
    if language:
        query += " AND d.language = $1"
        params.append(language)
    query += " GROUP BY d.id ORDER BY d.sort_order, d.id"
    return await conn.fetch(query, *params)


async def get_deck(conn: asyncpg.Connection, deck_id: str) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        """
        SELECT id, language, kind, title, description, sort_order
        FROM vocab_decks
        WHERE id = $1 AND is_published = true
        """,
        deck_id,
    )


async def list_items(conn: asyncpg.Connection, deck_id: str) -> list[asyncpg.Record]:
    return await conn.fetch(
        """
        SELECT id, group_key, order_index, term, romaji, reading, meaning, audio_url,
               category, kana_row, kana_col
        FROM vocab_items
        WHERE deck_id = $1
        ORDER BY group_key NULLS FIRST, order_index
        """,
        deck_id,
    )
