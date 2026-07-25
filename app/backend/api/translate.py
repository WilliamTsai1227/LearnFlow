"""
翻譯 API — 點擊字幕單字時的即時翻譯（免費資源 + DB 快取）
=========================================================
需 Bearer JWT。先查 translation_cache，未命中才呼叫免費線上資源並寫回快取，
確保同一 (詞, 語言對) 只查一次，也降低對免費 API 的請求量。

使用的免費資源（皆免金鑰）：
  - 翻譯文字：MyMemory Translation API（任意語言對，含 ja→zh-TW / en→zh-TW）
  - 日文讀音：Jisho API（回傳假名讀音）
  - 羅馬拼音：本地 module/kana.py 由假名轉換（Hepburn）
"""

import json
from typing import Optional

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from backend.database.connection import get_db
from backend.module.jwt import get_current_user
from backend.module.kana import kana_to_romaji
from backend.module.schemas import Language

router = APIRouter(prefix="/api", tags=["Translate"])

# language_code → MyMemory / Jisho 用的語言代碼
_SRC_CODE = {"japanese": "ja", "english": "en"}

_MYMEMORY_URL = "https://api.mymemory.translated.net/get"
_JISHO_URL = "https://jisho.org/api/v1/search/words"
_HTTP_TIMEOUT = 8.0


class TranslateRequest(BaseModel):
    term: str = Field(..., min_length=1, max_length=2000)
    context_sentence: Optional[str] = Field(default=None, max_length=4000)
    source_language: Language
    target_language: str = Field(default="zh-TW", max_length=10)


class TranslateResponse(BaseModel):
    term: str
    translation: str
    reading: Optional[str] = None
    romaji: Optional[str] = None
    part_of_speech: Optional[str] = None
    cached: bool = False


async def _mymemory_translate(term: str, src: str, tgt: str) -> str:
    """免費 MyMemory 翻譯；zh-TW 失敗時退回 zh。"""
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        for target in (tgt, "zh") if tgt.lower().startswith("zh") and tgt != "zh" else (tgt,):
            try:
                resp = await client.get(
                    _MYMEMORY_URL, params={"q": term, "langpair": f"{src}|{target}"}
                )
                resp.raise_for_status()
                data = resp.json()
            except (httpx.HTTPError, json.JSONDecodeError):
                continue
            if data.get("responseStatus") in (200, "200"):
                text = (data.get("responseData") or {}).get("translatedText")
                if text and "INVALID" not in text.upper() and "PLEASE SELECT" not in text.upper():
                    return text.strip()
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Free translation service unavailable, please try again.",
    )


async def _jisho_reading(term: str) -> Optional[str]:
    """免費 Jisho 查日文單字的假名讀音（找不到回 None）。"""
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get(_JISHO_URL, params={"keyword": term})
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, json.JSONDecodeError):
        return None
    for entry in data.get("data", []):
        for jp in entry.get("japanese", []):
            reading = jp.get("reading")
            if reading:
                return reading
    return None


async def _lookup(body: TranslateRequest) -> dict:
    src = _SRC_CODE.get(body.source_language.value)
    if not src:
        raise HTTPException(status_code=400, detail="Unsupported source language")

    translation = await _mymemory_translate(body.term, src, body.target_language)

    reading: Optional[str] = None
    romaji: Optional[str] = None
    if body.source_language == Language.japanese:
        reading = await _jisho_reading(body.term)
        base = reading or body.term
        romaji = kana_to_romaji(base) or None

    return {
        "translation": translation,
        "reading": reading,
        "romaji": romaji,
        "part_of_speech": None,
    }


@router.post("/translate", response_model=TranslateResponse)
async def translate(
    body: TranslateRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    # 1. 查快取
    cached = await db.fetchrow(
        """
        SELECT payload FROM translation_cache
        WHERE source_language = $1::language_code AND target_language = $2 AND term = $3
        """,
        body.source_language.value,
        body.target_language,
        body.term,
    )
    if cached is not None:
        payload = cached["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        return TranslateResponse(term=body.term, cached=True, **payload)

    # 2. 未命中 → 免費資源查詢
    payload = await _lookup(body)

    # 3. 寫回快取（併發時忽略衝突）
    await db.execute(
        """
        INSERT INTO translation_cache (source_language, target_language, term, payload)
        VALUES ($1::language_code, $2, $3, $4::jsonb)
        ON CONFLICT (source_language, target_language, term) DO NOTHING
        """,
        body.source_language.value,
        body.target_language,
        body.term,
        json.dumps(payload),
    )

    return TranslateResponse(term=body.term, cached=False, **payload)
