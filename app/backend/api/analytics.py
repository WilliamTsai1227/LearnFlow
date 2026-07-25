"""
進度分析 API — 懶人追蹤 + 深度數據（全自動彙整）
================================================
需 Bearer JWT。

端點：
  GET /api/analytics/overview  — 進度分析頁所需的全部彙整資料
"""

from typing import List, Optional

import asyncpg
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from backend.database.connection import get_db
from backend.module import analytics_repository
from backend.module.jwt import get_current_user

router = APIRouter(prefix="/api/analytics", tags=["Analytics"])


class Kpis(BaseModel):
    due_today: int
    total_cards: int
    known_cards: int
    captures_total: int
    reviews_total: int
    reviews_today: int
    streak_days: int
    retention: Optional[float] = None


class CardsByState(BaseModel):
    new: int
    learning: int
    review: int
    relearning: int


class RatingBreakdown(BaseModel):
    again: int
    hard: int
    good: int
    easy: int


class DailyReview(BaseModel):
    date: str
    count: int


class VocabGrowth(BaseModel):
    date: str
    cumulative: int


class LessonAttempts(BaseModel):
    total: int
    correct: int


class AnalyticsOverview(BaseModel):
    kpis: Kpis
    cards_by_state: CardsByState
    rating_breakdown: RatingBreakdown
    daily_reviews: List[DailyReview]
    vocab_growth: List[VocabGrowth]
    lesson_attempts: LessonAttempts


@router.get("/overview", response_model=AnalyticsOverview)
async def analytics_overview(
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    data = await analytics_repository.overview(db, current_user["id"])
    return AnalyticsOverview(**data)
