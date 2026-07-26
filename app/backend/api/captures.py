"""
擷取 API — Chrome 擴充從 YouTube 收藏單字/句子
===============================================
需 Bearer JWT（Google SSO 登入後取得的 access token；擴充以 refresh cookie 換取）。

端點：
  POST   /api/captures                — 建立擷取（自動排入 SRS）
  GET    /api/captures                — 收藏列表（?language=、分頁）
  PATCH  /api/captures/{id}/context   — 回填前後文（後文在收藏當下尚未播出）
  DELETE /api/captures/{id}           — 刪除擷取（連同 SRS 卡）
"""

import json
from datetime import datetime
from enum import Enum
from typing import Any, List, Optional
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


class ContextLine(BaseModel):
    """前後文的一行字幕（附上當時已取得的翻譯，通常來自雙字幕快取，不額外耗額度）。"""

    text: str = Field(..., min_length=1, max_length=4000)
    translation: Optional[str] = Field(default=None, max_length=4000)


class CreateCaptureRequest(BaseModel):
    kind: CaptureKind = CaptureKind.word
    language: Language
    term: str = Field(..., min_length=1, max_length=2000)
    context_sentence: Optional[str] = Field(default=None, max_length=4000)
    translation: Optional[str] = Field(default=None, max_length=4000)
    sentence_translation: Optional[str] = Field(default=None, max_length=4000)
    context_before: List[ContextLine] = Field(default_factory=list, max_length=5)
    context_after: List[ContextLine] = Field(default_factory=list, max_length=5)
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
    sentence_translation: Optional[str] = None
    context_before: List[ContextLine] = Field(default_factory=list)
    context_after: List[ContextLine] = Field(default_factory=list)
    reading: Optional[str] = None
    romaji: Optional[str] = None
    video_id: str
    video_url: str
    video_title: Optional[str] = None
    start_seconds: float
    created_at: datetime


def _json_list(value: Any) -> List[ContextLine]:
    """asyncpg 的 JSONB 可能回傳 str 或已解析的 list，兩種都要能處理。"""
    if not value:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(value, list):
        return []
    out: List[ContextLine] = []
    for entry in value:
        if isinstance(entry, dict) and entry.get("text"):
            out.append(
                ContextLine(text=entry["text"], translation=entry.get("translation"))
            )
    return out


def _row_to_item(row: asyncpg.Record) -> CaptureItem:
    return CaptureItem(
        id=str(row["id"]),
        kind=CaptureKind(row["kind"]),
        language=Language(row["language"]),
        term=row["term"],
        context_sentence=row["context_sentence"],
        translation=row["translation"],
        sentence_translation=row["sentence_translation"],
        context_before=_json_list(row["context_before"]),
        context_after=_json_list(row["context_after"]),
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
        sentence_translation=body.sentence_translation,
        context_before=[c.model_dump() for c in body.context_before],
        context_after=[c.model_dump() for c in body.context_after],
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


class UpdateContextRequest(BaseModel):
    context_before: List[ContextLine] = Field(default_factory=list, max_length=5)
    context_after: List[ContextLine] = Field(default_factory=list, max_length=5)


@router.patch("/captures/{capture_id}/context", response_model=CaptureItem)
async def update_capture_context(
    capture_id: UUID,
    body: UpdateContextRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    """
    回填前後文。主要用途：收藏當下「後面兩句」尚未播出，
    擴充會在後續字幕出現後呼叫此端點補上（best-effort）。
    """
    row = await captures_repository.update_context(
        db,
        current_user["id"],
        capture_id,
        context_before=[c.model_dump() for c in body.context_before],
        context_after=[c.model_dump() for c in body.context_after],
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Capture not found")
    return _row_to_item(row)


@router.delete("/captures/{capture_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_capture(
    capture_id: UUID,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    deleted = await captures_repository.delete_capture(db, current_user["id"], capture_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Capture not found")
