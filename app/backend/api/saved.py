"""
收藏 API — 收藏單字與收藏句子
================================
需 Bearer JWT（Google SSO 登入後取得的 access token）。

端點：
  GET    /api/saved                          — 收藏列表（?type=vocabulary|sentence）
  POST   /api/saved                          — 新增收藏
  DELETE /api/saved/{saved_id}               — 依收藏紀錄 id 取消
  POST   /api/vocabulary/{vocabulary_id}/favorite
  DELETE /api/vocabulary/{vocabulary_id}/favorite
  POST   /api/sentences/{sentence_id}/favorite
  DELETE /api/sentences/{sentence_id}/favorite
"""

from datetime import datetime
from enum import Enum
from typing import List, Optional, Union
from uuid import UUID

import asyncpg
from asyncpg.exceptions import ForeignKeyViolationError, UniqueViolationError
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from backend.database.connection import get_db
from backend.module import saved_repository
from backend.module.jwt import get_current_user
from backend.module.schemas import Language

router = APIRouter(prefix="/api", tags=["Saved"])


class SavedItemType(str, Enum):
    vocabulary = "vocabulary"
    sentence = "sentence"


class CreateSavedRequest(BaseModel):
    item_type: SavedItemType
    item_id: str = Field(..., min_length=1, max_length=50)


class SavedRecordResponse(BaseModel):
    id: str
    item_type: SavedItemType
    item_id: str
    created_at: datetime


class SavedVocabularyItem(BaseModel):
    id: str
    item_type: SavedItemType = SavedItemType.vocabulary
    item_id: str
    created_at: datetime
    term: str
    reading: Optional[str] = None
    meaning: str
    example_sentence: Optional[str] = None
    audio_url: Optional[str] = None
    course_id: str
    scenario_id: str
    language: Language
    scenario_title: str
    course_title: str


class SavedSentenceItem(BaseModel):
    id: str
    item_type: SavedItemType = SavedItemType.sentence
    item_id: str
    created_at: datetime
    target_text: str
    reading: Optional[str] = None
    translation: str
    audio_url: Optional[str] = None
    course_id: str
    scenario_id: str
    language: Language
    scenario_title: str
    course_title: str


def _vocabulary_row_to_item(row: asyncpg.Record) -> SavedVocabularyItem:
    return SavedVocabularyItem(
        id=str(row["id"]),
        item_id=row["item_id"],
        created_at=row["created_at"],
        term=row["term"],
        reading=row["reading"],
        meaning=row["meaning"],
        example_sentence=row["example_sentence"],
        audio_url=row["audio_url"],
        course_id=row["course_id"],
        scenario_id=row["scenario_id"],
        language=Language(row["language"]),
        scenario_title=row["scenario_title"],
        course_title=row["course_title"],
    )


def _sentence_row_to_item(row: asyncpg.Record) -> SavedSentenceItem:
    return SavedSentenceItem(
        id=str(row["id"]),
        item_id=row["item_id"],
        created_at=row["created_at"],
        target_text=row["target_text"],
        reading=row["reading"],
        translation=row["translation"],
        audio_url=row["audio_url"],
        course_id=row["course_id"],
        scenario_id=row["scenario_id"],
        language=Language(row["language"]),
        scenario_title=row["scenario_title"],
        course_title=row["course_title"],
    )


async def _insert_vocabulary(
    conn: asyncpg.Connection,
    user_id: UUID,
    vocabulary_id: str,
) -> SavedRecordResponse:
    if not await saved_repository.vocabulary_exists(conn, vocabulary_id):
        raise HTTPException(status_code=404, detail="Vocabulary not found")

    try:
        row = await saved_repository.save_vocabulary(conn, user_id, vocabulary_id)
    except UniqueViolationError:
        raise HTTPException(status_code=409, detail="Vocabulary already saved")
    except ForeignKeyViolationError:
        raise HTTPException(status_code=404, detail="Vocabulary not found")

    return SavedRecordResponse(
        id=str(row["id"]),
        item_type=SavedItemType.vocabulary,
        item_id=row["vocabulary_id"],
        created_at=row["created_at"],
    )


async def _insert_sentence(
    conn: asyncpg.Connection,
    user_id: UUID,
    sentence_id: str,
) -> SavedRecordResponse:
    if not await saved_repository.sentence_exists(conn, sentence_id):
        raise HTTPException(status_code=404, detail="Sentence not found")

    try:
        row = await saved_repository.save_sentence(conn, user_id, sentence_id)
    except UniqueViolationError:
        raise HTTPException(status_code=409, detail="Sentence already saved")
    except ForeignKeyViolationError:
        raise HTTPException(status_code=404, detail="Sentence not found")

    return SavedRecordResponse(
        id=str(row["id"]),
        item_type=SavedItemType.sentence,
        item_id=row["sentence_id"],
        created_at=row["created_at"],
    )


@router.get(
    "/saved",
    response_model=List[Union[SavedVocabularyItem, SavedSentenceItem]],
)
async def list_saved_items(
    item_type: Optional[SavedItemType] = Query(default=None, alias="type"),
    language: Optional[Language] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    user_id = current_user["id"]
    lang = language.value if language else None

    if item_type == SavedItemType.vocabulary:
        rows = await saved_repository.list_saved_vocabulary(
            db, user_id, language=lang, limit=limit, offset=offset
        )
        return [_vocabulary_row_to_item(row) for row in rows]

    if item_type == SavedItemType.sentence:
        rows = await saved_repository.list_saved_sentences(
            db, user_id, language=lang, limit=limit, offset=offset
        )
        return [_sentence_row_to_item(row) for row in rows]

    fetch_size = limit + offset
    vocab_rows = await saved_repository.list_saved_vocabulary(
        db, user_id, language=lang, limit=fetch_size, offset=0
    )
    sentence_rows = await saved_repository.list_saved_sentences(
        db, user_id, language=lang, limit=fetch_size, offset=0
    )
    items: list[Union[SavedVocabularyItem, SavedSentenceItem]] = [
        *(_vocabulary_row_to_item(row) for row in vocab_rows),
        *(_sentence_row_to_item(row) for row in sentence_rows),
    ]
    items.sort(key=lambda item: item.created_at, reverse=True)
    return items[offset : offset + limit]


@router.post(
    "/saved",
    response_model=SavedRecordResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_saved_item(
    body: CreateSavedRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    user_id = current_user["id"]

    if body.item_type == SavedItemType.vocabulary:
        return await _insert_vocabulary(db, user_id, body.item_id)
    return await _insert_sentence(db, user_id, body.item_id)


@router.delete("/saved/{saved_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_saved_item(
    saved_id: UUID,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    deleted = await saved_repository.delete_saved_by_id(
        db, current_user["id"], saved_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Saved item not found")


@router.post(
    "/vocabulary/{vocabulary_id}/favorite",
    response_model=SavedRecordResponse,
    status_code=status.HTTP_201_CREATED,
)
async def favorite_vocabulary(
    vocabulary_id: str,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    return await _insert_vocabulary(db, current_user["id"], vocabulary_id)


@router.delete(
    "/vocabulary/{vocabulary_id}/favorite",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def unfavorite_vocabulary(
    vocabulary_id: str,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    deleted = await saved_repository.delete_saved_vocabulary(
        db, current_user["id"], vocabulary_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Saved vocabulary not found")


@router.post(
    "/sentences/{sentence_id}/favorite",
    response_model=SavedRecordResponse,
    status_code=status.HTTP_201_CREATED,
)
async def favorite_sentence(
    sentence_id: str,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    return await _insert_sentence(db, current_user["id"], sentence_id)


@router.delete(
    "/sentences/{sentence_id}/favorite",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def unfavorite_sentence(
    sentence_id: str,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    deleted = await saved_repository.delete_saved_sentence(
        db, current_user["id"], sentence_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Saved sentence not found")
