"""
擷取 API — Chrome 擴充從 YouTube 收藏單字/句子
===============================================
需 Bearer JWT（Google SSO 登入後取得的 access token；擴充以 refresh cookie 換取）。

端點：
  POST   /api/captures        — 建立擷取（自動排入 SRS）
  GET    /api/captures        — 收藏列表（?language=、分頁）
  DELETE /api/captures/{id}   — 刪除擷取（連同 SRS 卡）
"""

from datetime import datetime
from enum import Enum
from typing import List, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from backend.database.connection import get_db
from backend.module import captures_repository
from backend.module.jwt import get_current_user
from backend.module.schemas import Language

router = APIRouter(prefix="/api", tags=["Captures"])


class CaptureKind(str, Enum):
    word = "word"
    sentence = "sentence"


class CreateCaptureRequest(BaseModel):
    kind: CaptureKind
    language: Language
    term: str = Field(..., min_length=1, max_length=2000)
    context_sentence: Optional[str] = Field(default=None, max_length=4000)
    translation: Optional[str] = Field(default=None, max_length=4000)
    reading: Optional[str] = Field(default=None, max_length=2000)
    romaji: Optional[str] = Field(default=None, max_length=2000)
    video_id: str = Field(..., min_length=1, max_length=20)
    video_url: str = Field(..., min_length=1, max_length=500)
    video_title: Optional[str] = Field(default=None, max_length=500)
    start_seconds: float = Field(default=0, ge=0)

    @field_validator("video_url")
    @classmethod
    def _video_url_must_be_http(cls, v: str) -> str:
        # 前端會把 video_url 直接當作 <a href>；拒絕 javascript:/data: 等危險 scheme，
        # 且限定 YouTube 網域，避免存進來的連結被用來做開放重導向或 XSS。
        if not v.startswith(("https://www.youtube.com/", "https://youtu.be/")):
            raise ValueError("video_url must be an https youtube.com/youtu.be URL")
        return v


class CaptureItem(BaseModel):
    id: str
    kind: CaptureKind
    language: Language
    term: str
    context_sentence: Optional[str] = None
    translation: Optional[str] = None
    reading: Optional[str] = None
    romaji: Optional[str] = None
    video_id: str
    video_url: str
    video_title: Optional[str] = None
    start_seconds: float
    created_at: datetime


def _row_to_item(row: asyncpg.Record) -> CaptureItem:
    return CaptureItem(
        id=str(row["id"]),
        kind=CaptureKind(row["kind"]),
        language=Language(row["language"]),
        term=row["term"],
        context_sentence=row["context_sentence"],
        translation=row["translation"],
        reading=row["reading"],
        romaji=row["romaji"],
        video_id=row["video_id"],
        video_url=row["video_url"],
        video_title=row["video_title"],
        start_seconds=row["start_seconds"],
        created_at=row["created_at"],
    )


@router.post("/captures", response_model=CaptureItem, status_code=status.HTTP_201_CREATED)
async def create_capture(
    body: CreateCaptureRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await captures_repository.create_capture(
        db,
        current_user["id"],
        kind=body.kind.value,
        language=body.language.value,
        term=body.term,
        context_sentence=body.context_sentence,
        translation=body.translation,
        reading=body.reading,
        romaji=body.romaji,
        video_id=body.video_id,
        video_url=body.video_url,
        video_title=body.video_title,
        start_seconds=body.start_seconds,
    )
    return _row_to_item(row)


@router.get("/captures", response_model=List[CaptureItem])
async def list_captures(
    language: Optional[Language] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await captures_repository.list_captures(
        db,
        current_user["id"],
        language=language.value if language else None,
        limit=limit,
        offset=offset,
    )
    return [_row_to_item(row) for row in rows]


@router.delete("/captures/{capture_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_capture(
    capture_id: UUID,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    deleted = await captures_repository.delete_capture(db, current_user["id"], capture_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Capture not found")
