"""
被動曝光 API — 字幕上「看到」單字的紀錄
========================================
需 Bearer JWT。

⚠️ 核心原則：**看到單字不等於完成複習**。
本模組只寫入 context_exposures，**絕對不會**碰 srs_cards / srs_reviews，
也就是說被動曝光永遠不會改動任何卡片的排程狀態（due / stability / state）。
只有使用者主動回想並評分（POST /api/reviews/{card_id}）才會更新 FSRS 狀態。
修改本檔時請維持這個界線。

擴充端只會送出「使用者已有卡片的詞」，避免每行字幕的每個詞都上傳造成爆量。

端點：
  POST /api/exposures   — 批次寫入
  GET  /api/exposures/stats?term=  — 某個詞被看到幾次（供卡片顯示「已遇到 N 次」）
"""

from datetime import datetime
from typing import List, Optional

import asyncpg
from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field

from backend.database.connection import get_db
from backend.module.jwt import get_current_user
from backend.module.schemas import Language

router = APIRouter(prefix="/api/exposures", tags=["Exposures"])

_MAX_BATCH = 200


class ExposureIn(BaseModel):
    term: str = Field(..., min_length=1, max_length=200)
    language: Language
    video_id: Optional[str] = Field(default=None, max_length=20)
    sentence: Optional[str] = Field(default=None, max_length=4000)


class CreateExposuresRequest(BaseModel):
    exposures: List[ExposureIn] = Field(default_factory=list, max_length=_MAX_BATCH)


class CreateExposuresResponse(BaseModel):
    inserted: int


class ExposureStats(BaseModel):
    term: str
    seen_count: int
    last_seen_at: Optional[datetime] = None


@router.post("", response_model=CreateExposuresResponse, status_code=status.HTTP_201_CREATED)
async def create_exposures(
    body: CreateExposuresRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    if not body.exposures:
        return CreateExposuresResponse(inserted=0)

    user_id = current_user["id"]
    # 僅寫入曝光紀錄；不觸碰任何排程資料表（見檔案開頭說明）
    await db.executemany(
        """
        INSERT INTO context_exposures (user_id, term, language, video_id, sentence)
        VALUES ($1, $2, $3::language_code, $4, $5)
        """,
        [
            (user_id, e.term, e.language.value, e.video_id, e.sentence)
            for e in body.exposures
        ],
    )
    return CreateExposuresResponse(inserted=len(body.exposures))


@router.get("/stats", response_model=List[ExposureStats])
async def exposure_stats(
    term: Optional[str] = Query(default=None, max_length=200),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    if term:
        rows = await db.fetch(
            """
            SELECT term, count(*) AS seen_count, max(seen_at) AS last_seen_at
            FROM context_exposures
            WHERE user_id = $1 AND term = $2
            GROUP BY term
            """,
            current_user["id"],
            term,
        )
    else:
        rows = await db.fetch(
            """
            SELECT term, count(*) AS seen_count, max(seen_at) AS last_seen_at
            FROM context_exposures
            WHERE user_id = $1
            GROUP BY term
            ORDER BY seen_count DESC
            LIMIT $2
            """,
            current_user["id"],
            limit,
        )
    return [
        ExposureStats(
            term=r["term"], seen_count=r["seen_count"], last_seen_at=r["last_seen_at"]
        )
        for r in rows
    ]
