"""
單字 API — 單字集（五十音、常用單字…）。免登入，與 scenarios 一致。

端點：
  GET /api/vocab/decks?language=japanese   — 單字集列表
  GET /api/vocab/decks/{deck_id}           — 單字集詳情（含所有項目）
"""

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query

from backend.database.connection import database
from backend.module import vocab_repository
from backend.module.schemas import Language, VocabDeck, VocabDeckDetail, VocabItem

router = APIRouter(prefix="/api/vocab", tags=["Vocab"])


def _require_connection():
    if not database.pool:
        raise HTTPException(
            status_code=503,
            detail="Database is not configured. Set DATABASE_URL and run migrations.",
        )


@router.get("/decks", response_model=List[VocabDeck])
async def list_decks(language: Optional[Language] = Query(default=None)) -> List[VocabDeck]:
    _require_connection()
    async with database.acquire() as conn:
        if conn is None:
            raise HTTPException(status_code=503, detail="Database connection unavailable")
        rows = await vocab_repository.list_decks(
            conn, language=language.value if language else None
        )
    return [
        VocabDeck(
            id=row["id"],
            language=Language(row["language"]),
            kind=row["kind"],
            title=row["title"],
            description=row["description"],
            item_count=row["item_count"],
            sort_order=row["sort_order"],
        )
        for row in rows
    ]


@router.get("/decks/{deck_id}", response_model=VocabDeckDetail)
async def get_deck(deck_id: str) -> VocabDeckDetail:
    _require_connection()
    async with database.acquire() as conn:
        if conn is None:
            raise HTTPException(status_code=503, detail="Database connection unavailable")
        deck = await vocab_repository.get_deck(conn, deck_id)
        if not deck:
            raise HTTPException(status_code=404, detail="Deck not found")
        items = await vocab_repository.list_items(conn, deck_id)

    return VocabDeckDetail(
        id=deck["id"],
        language=Language(deck["language"]),
        kind=deck["kind"],
        title=deck["title"],
        description=deck["description"],
        items=[
            VocabItem(
                id=row["id"],
                group_key=row["group_key"],
                order_index=row["order_index"],
                term=row["term"],
                romaji=row["romaji"],
                reading=row["reading"],
                meaning=row["meaning"],
                audio_url=row["audio_url"],
                category=row["category"],
                kana_row=row["kana_row"],
                kana_col=row["kana_col"],
            )
            for row in items
        ],
    )
