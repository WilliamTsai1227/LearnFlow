"""
語音合成 API — YouTube 收藏（複習頁/收藏頁/Chrome 擴充）發音
==============================================================
需 Bearer JWT。與課程音檔用同一套 edge-tts 語音，先查 tts_cache，
未命中才呼叫 edge-tts 並寫回快取，同一 (語言, 文字) 只合成一次。

端點：
  GET /api/tts?text=...&language=japanese|english  — 回傳 audio/mpeg
"""

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from backend.database.connection import get_db
from backend.module import tts
from backend.module.jwt import get_current_user
from backend.module.schemas import Language

router = APIRouter(prefix="/api", tags=["TTS"])

_MAX_TEXT_LENGTH = 500


@router.get("/tts")
async def synthesize_speech(
    text: str = Query(..., min_length=1, max_length=_MAX_TEXT_LENGTH),
    language: Language = Query(...),
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    cached = await db.fetchval(
        "SELECT audio FROM tts_cache WHERE language = $1 AND text = $2",
        language.value,
        text,
    )
    if cached is not None:
        return Response(content=bytes(cached), media_type="audio/mpeg")

    try:
        audio = await tts.synthesize(text, language.value)
    except Exception as exc:  # pragma: no cover - 上游 TTS 服務錯誤
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Speech synthesis unavailable: {exc}",
        ) from exc

    await db.execute(
        """
        INSERT INTO tts_cache (language, text, audio)
        VALUES ($1, $2, $3)
        ON CONFLICT (language, text) DO NOTHING
        """,
        language.value,
        text,
        audio,
    )
    return Response(content=audio, media_type="audio/mpeg")
