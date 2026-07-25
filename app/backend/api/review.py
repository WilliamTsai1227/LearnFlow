"""
複習 API — FSRS 間隔複習佇列與評分
==================================
需 Bearer JWT。翻卡評分（1=Again 2=Hard 3=Good 4=Easy），背後由 module/fsrs.py 排程。

端點：
  GET  /api/review/queue            — 今日到期的複習卡（含卡面內容與影片跳轉資訊）
  POST /api/review/{card_id}/grade  — 評分一張卡，回傳新的到期時間
  GET  /api/review/summary          — 待複習數 / 今日已複習 / 卡片總數
"""

from datetime import datetime
from typing import List, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.database.connection import get_db
from backend.module import srs_repository
from backend.module.jwt import get_current_user

router = APIRouter(prefix="/api/review", tags=["Review"])


class ReviewCard(BaseModel):
    card_id: str
    item_type: str
    item_id: str
    state: int
    due: datetime
    term: str
    reading: Optional[str] = None
    romaji: Optional[str] = None
    translation: Optional[str] = None
    context_sentence: Optional[str] = None
    audio_url: Optional[str] = None
    language: Optional[str] = None
    scenario_title: Optional[str] = None
    course_title: Optional[str] = None
    # capture 專屬：跳回影片
    video_id: Optional[str] = None
    video_url: Optional[str] = None
    video_title: Optional[str] = None
    start_seconds: Optional[float] = None


class GradeRequest(BaseModel):
    rating: int = Field(..., ge=1, le=4)


class GradeResponse(BaseModel):
    card_id: str
    state: int
    due: datetime
    scheduled_days: float


class ReviewSummary(BaseModel):
    due_count: int
    total_cards: int
    reviewed_today: int


def _row_to_card(row: asyncpg.Record) -> ReviewCard:
    return ReviewCard(
        card_id=str(row["card_id"]),
        item_type=row["item_type"],
        item_id=row["item_id"],
        state=row["state"],
        due=row["due"],
        term=row["term"],
        reading=row["reading"],
        romaji=row["romaji"],
        translation=row["translation"],
        context_sentence=row["context_sentence"],
        audio_url=row["audio_url"],
        language=row["language"],
        scenario_title=row["scenario_title"],
        course_title=row["course_title"],
        video_id=row["video_id"],
        video_url=row["video_url"],
        video_title=row["video_title"],
        start_seconds=row["start_seconds"],
    )


@router.get("/queue", response_model=List[ReviewCard])
async def review_queue(
    limit: int = Query(default=30, ge=1, le=100),
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await srs_repository.list_due_cards(db, current_user["id"], limit=limit)
    return [_row_to_card(row) for row in rows]


@router.post("/{card_id}/grade", response_model=GradeResponse)
async def grade_card(
    card_id: UUID,
    body: GradeRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    result = await srs_repository.apply_review(db, current_user["id"], card_id, body.rating)
    if result is None:
        raise HTTPException(status_code=404, detail="Card not found")
    return GradeResponse(
        card_id=str(card_id),
        state=result.state,
        due=result.due,
        scheduled_days=result.scheduled_days,
    )


@router.get("/summary", response_model=ReviewSummary)
async def review_summary(
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    data = await srs_repository.summary(db, current_user["id"])
    return ReviewSummary(**data)
