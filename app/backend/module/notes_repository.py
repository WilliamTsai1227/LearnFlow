import json
from typing import Any, Optional
from uuid import UUID

import asyncpg


async def create_note(
    conn: asyncpg.Connection,
    user_id: UUID,
    title: str,
    file_type: str,
    file_ext: str,
    size_bytes: int,
) -> asyncpg.Record:
    return await conn.fetchrow(
        """
        INSERT INTO notes (user_id, title, file_type, file_ext, size_bytes)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, title, file_type, file_ext, size_bytes,
                  canvas_x, canvas_y, created_at, updated_at
        """,
        user_id,
        title,
        file_type,
        file_ext,
        size_bytes,
    )


async def list_notes(conn: asyncpg.Connection, user_id: UUID) -> list[asyncpg.Record]:
    return await conn.fetch(
        """
        SELECT
            n.id, n.title, n.file_type, n.file_ext, n.size_bytes,
            n.canvas_x, n.canvas_y, n.created_at, n.updated_at,
            (SELECT COUNT(*) FROM note_annotations a WHERE a.note_id = n.id)::int AS annotation_count
        FROM notes n
        WHERE n.user_id = $1
        ORDER BY n.created_at ASC
        """,
        user_id,
    )


async def get_note(
    conn: asyncpg.Connection, user_id: UUID, note_id: UUID
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        """
        SELECT id, title, file_type, file_ext, size_bytes,
               canvas_x, canvas_y, created_at, updated_at
        FROM notes
        WHERE id = $1 AND user_id = $2
        """,
        note_id,
        user_id,
    )


async def update_note_position(
    conn: asyncpg.Connection,
    user_id: UUID,
    note_id: UUID,
    canvas_x: float,
    canvas_y: float,
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        """
        UPDATE notes
        SET canvas_x = $3, canvas_y = $4, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id, title, file_type, file_ext, size_bytes,
                  canvas_x, canvas_y, created_at, updated_at
        """,
        note_id,
        user_id,
        canvas_x,
        canvas_y,
    )


async def delete_note(
    conn: asyncpg.Connection, user_id: UUID, note_id: UUID
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        "DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING id",
        note_id,
        user_id,
    )


async def touch_note(conn: asyncpg.Connection, note_id: UUID) -> None:
    await conn.execute(
        "UPDATE notes SET updated_at = now() WHERE id = $1", note_id
    )


async def list_annotations(
    conn: asyncpg.Connection, note_id: UUID
) -> list[asyncpg.Record]:
    return await conn.fetch(
        """
        SELECT id, note_id, kind, page, color, rects, quote, body, created_at, updated_at
        FROM note_annotations
        WHERE note_id = $1
        ORDER BY created_at
        """,
        note_id,
    )


async def create_annotation(
    conn: asyncpg.Connection,
    note_id: UUID,
    user_id: UUID,
    kind: str,
    page: int,
    color: str,
    rects: Any,
    quote: Optional[str],
    body: Optional[str],
) -> asyncpg.Record:
    return await conn.fetchrow(
        """
        INSERT INTO note_annotations (note_id, user_id, kind, page, color, rects, quote, body)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        RETURNING id, note_id, kind, page, color, rects, quote, body, created_at, updated_at
        """,
        note_id,
        user_id,
        kind,
        page,
        color,
        json.dumps(rects),
        quote,
        body,
    )


async def get_annotation(
    conn: asyncpg.Connection, user_id: UUID, annotation_id: UUID
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        """
        SELECT id, note_id, kind, page, color, rects, quote, body, created_at, updated_at
        FROM note_annotations
        WHERE id = $1 AND user_id = $2
        """,
        annotation_id,
        user_id,
    )


async def update_annotation(
    conn: asyncpg.Connection,
    user_id: UUID,
    annotation_id: UUID,
    color: Optional[str],
    body: Optional[str],
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        """
        UPDATE note_annotations
        SET color = COALESCE($3, color),
            body = COALESCE($4, body),
            updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id, note_id, kind, page, color, rects, quote, body, created_at, updated_at
        """,
        annotation_id,
        user_id,
        color,
        body,
    )


async def delete_annotation(
    conn: asyncpg.Connection, user_id: UUID, annotation_id: UUID
) -> Optional[asyncpg.Record]:
    return await conn.fetchrow(
        "DELETE FROM note_annotations WHERE id = $1 AND user_id = $2 RETURNING id",
        annotation_id,
        user_id,
    )
