"""
固化記憶 API — FSRS 雙軌複習佇列
==================================
需 Bearer JWT。排程數學全部由官方 py-fsrs 負責（module/fsrs_scheduler）。

兩條互不干擾的軌道：
  track=youtube — Chrome 擴充從 YouTube 收藏的單字（item_type='capture'）
  track=course  — 系統內部課程單字／句子（item_type='vocabulary'|'sentence'）

端點：
  GET  /api/reviews/today?track=&limit=   — 今日佇列
  POST /api/reviews/{card_id}             — 送出評分
  GET  /api/reviews/summary?track=        — 摘要

佇列組成順序（規格）：
  1. 逾期卡片，依「預測可提取率」由低到高（最可能忘記的先複習）
  2. 今日到期
  3. 新卡（受每日上限）

可提取率必須在 Python 端算（SQL 無法計算 FSRS 公式），因此先由 DB 取回
候選卡片，再於記憶體排序。
"""

import re
from datetime import datetime, timezone
from enum import Enum
from typing import List, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.database.connection import get_db
from backend.module import fsrs_scheduler, srs_repository
from backend.module.jwt import get_current_user
from backend.module.schemas import Language

router = APIRouter(prefix="/api/reviews", tags=["Reviews"])

CLOZE_BLANK = "＿＿＿"


class Track(str, Enum):
    youtube = "youtube"
    course = "course"


class PromptType(str, Enum):
    recognition = "recognition"  # 看字/聽音 → 回想意思
    cloze = "cloze"              # 句子挖空 → 回想單字


class ReviewCard(BaseModel):
    card_id: str
    item_type: str
    item_id: str
    state: int
    due: datetime
    retrievability: Optional[float] = None
    is_new: bool = False
    # 題型
    prompt_type: PromptType
    prompt_text: str
    # 卡面內容
    term: str
    reading: Optional[str] = None
    romaji: Optional[str] = None
    translation: Optional[str] = None
    context_sentence: Optional[str] = None
    sentence_translation: Optional[str] = None
    audio_url: Optional[str] = None
    language: Optional[str] = None
    scenario_title: Optional[str] = None
    course_title: Optional[str] = None
    video_id: Optional[str] = None
    video_url: Optional[str] = None
    video_title: Optional[str] = None
    start_seconds: Optional[float] = None


class GradeRequest(BaseModel):
    rating: int = Field(..., ge=1, le=4)  # py-fsrs Rating：1=Again 2=Hard 3=Good 4=Easy
    response_ms: Optional[int] = Field(default=None, ge=0)
    prompt_type: Optional[PromptType] = None
    hint_used: bool = False
    answer_revealed: bool = False


class GradeResponse(BaseModel):
    card_id: str
    state: int
    due: datetime
    scheduled_days: float


class ReviewSummary(BaseModel):
    due_count: int
    new_count: int
    total_cards: int
    reviewed_today: int
    new_remaining_today: int
    daily_new_limit: int


def _make_cloze(sentence: str, term: str) -> Optional[str]:
    """
    把例句中的目標詞挖空；不適合出挖空題時回 None（呼叫端退回辨認題）。
    不適合的情況：
      - 例句中找不到該詞
      - 目標詞幾乎就是整句（例如舊的整句收藏）→ 挖完只剩一個空格，題目無意義
    """
    sentence = (sentence or "").strip()
    term = (term or "").strip()
    if not sentence or not term:
        return None
    idx = sentence.lower().find(term.lower())
    if idx == -1:
        return None

    blanked = sentence[:idx] + CLOZE_BLANK + sentence[idx + len(term) :]
    if blanked == sentence:
        return None
    # 挖空後必須還留有足夠的上下文可供推敲，否則等於沒有題目
    remaining = blanked.replace(CLOZE_BLANK, "").strip()
    if len(remaining) < 3:
        return None
    return blanked


def _choose_prompt(row: asyncpg.Record, level: str) -> tuple[PromptType, str]:
    """
    依使用者程度選題型（規格：初階先辨認，程度提高再加入挖空回想）：
      beginner            → recognition
      intermediate/advanced → 有可用例句時 cloze，否則退回 recognition
    """
    term = row["term"] or ""
    if level != "beginner":
        cloze = _make_cloze(row["context_sentence"] or "", term)
        if cloze:
            return PromptType.cloze, cloze
    return PromptType.recognition, term


def _row_to_card(row: asyncpg.Record, level: str, *, is_new: bool, now: datetime) -> ReviewCard:
    prompt_type, prompt_text = _choose_prompt(row, level)
    r: Optional[float] = None
    if not is_new and row["last_review"] is not None:
        r = fsrs_scheduler.retrievability(fsrs_scheduler.build_card(row), now=now)
    return ReviewCard(
        card_id=str(row["card_id"]),
        item_type=row["item_type"],
        item_id=row["item_id"],
        state=row["state"],
        due=row["due"],
        retrievability=r,
        is_new=is_new,
        prompt_type=prompt_type,
        prompt_text=prompt_text,
        term=row["term"],
        reading=row["reading"],
        romaji=row["romaji"],
        translation=row["translation"],
        context_sentence=row["context_sentence"],
        sentence_translation=row["sentence_translation"],
        audio_url=row["audio_url"],
        language=row["language"],
        scenario_title=row["scenario_title"],
        course_title=row["course_title"],
        video_id=row["video_id"],
        video_url=row["video_url"],
        video_title=row["video_title"],
        start_seconds=row["start_seconds"],
    )


@router.get("/today", response_model=List[ReviewCard])
async def review_queue(
    track: Track = Query(default=Track.youtube),
    language: Optional[Language] = Query(default=None, description="不指定＝該軌全部語言"),
    limit: int = Query(default=30, ge=1, le=100),
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    user_id = current_user["id"]
    now = datetime.now(timezone.utc)
    level = await srs_repository.get_user_level(db, user_id)
    lang = language.value if language else None

    # 1-2. 到期卡片（含逾期）→ 依可提取率由低到高
    due_rows = await srs_repository.list_due_cards(
        db, user_id, track.value, language=lang, limit=limit
    )
    due_cards = [_row_to_card(r, level, is_new=False, now=now) for r in due_rows]
    due_cards.sort(key=lambda c: c.retrievability if c.retrievability is not None else 1.0)

    # 3. 新卡（受每日上限，且不超過本次 limit 的剩餘空間）
    # 注意：每日額度是整條軌道共用（總認知負荷），不因語言過濾而各自重算
    remaining_slots = max(0, limit - len(due_cards))
    new_cards: list[ReviewCard] = []
    if remaining_slots:
        daily_limit = await srs_repository.get_daily_new_limit(db, user_id, track.value)
        introduced = await srs_repository.count_new_introduced_today(db, user_id, track.value)
        quota = max(0, min(daily_limit - introduced, remaining_slots))
        if quota:
            new_rows = await srs_repository.list_new_cards(
                db, user_id, track.value, language=lang, limit=quota
            )
            new_cards = [_row_to_card(r, level, is_new=True, now=now) for r in new_rows]

    return due_cards + new_cards


class LanguageOption(BaseModel):
    language: str
    count: int


@router.get("/languages", response_model=List[LanguageOption])
async def review_languages(
    track: Track = Query(default=Track.youtube),
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    """該軌道實際有哪些語言的卡（前端只顯示有卡片的語言）。"""
    rows = await srs_repository.list_languages(db, current_user["id"], track.value)
    return [LanguageOption(**r) for r in rows]


class SettingsRequest(BaseModel):
    daily_new_limit: int = Field(..., ge=0, le=100)


class SettingsResponse(BaseModel):
    track: Track
    daily_new_limit: int


@router.patch("/settings", response_model=SettingsResponse)
async def update_settings(
    body: SettingsRequest,
    track: Track = Query(default=Track.youtube),
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    """調整該軌道的每日新卡上限（規格建議初期 5–10、穩定後 10–20）。"""
    value = await srs_repository.set_daily_new_limit(
        db, current_user["id"], track.value, body.daily_new_limit
    )
    return SettingsResponse(track=track, daily_new_limit=value)


@router.post("/{card_id}", response_model=GradeResponse)
async def grade_card(
    card_id: UUID,
    body: GradeRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    result = await srs_repository.apply_review(
        db,
        current_user["id"],
        card_id,
        body.rating,
        response_ms=body.response_ms,
        prompt_type=body.prompt_type.value if body.prompt_type else None,
        hint_used=body.hint_used,
        answer_revealed=body.answer_revealed,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Card not found")
    return GradeResponse(
        card_id=str(card_id),
        state=result["state"],
        due=result["due"],
        scheduled_days=result["scheduled_days"],
    )


@router.get("/summary", response_model=ReviewSummary)
async def review_summary(
    track: Track = Query(default=Track.youtube),
    language: Optional[Language] = Query(default=None),
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    data = await srs_repository.summary(
        db,
        current_user["id"],
        track.value,
        language=language.value if language else None,
    )
    return ReviewSummary(**data)
