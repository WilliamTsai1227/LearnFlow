"""
翻譯 API — 點擊字幕單字時的即時翻譯（免費資源 + DB 快取）
=========================================================
需 Bearer JWT。

兩種請求，行為不同：
  1. 整句翻譯（term == context_sentence，或無 context_sentence）
     → 先查 translation_cache，未命中才查免費資源並寫回快取。
  2. 單字在句中的翻譯（term != context_sentence）
     → 以單字周圍一小段上下文組成查詢送給 MyMemory，讓翻譯引擎有語境可判斷，
       避免單獨翻一個字時脫離句意（例如 "go" 單獨查是「去」，但在
       "Shall we go now?" 裡應該偏向「走」）。
     → 這種查詢結果**不進 translation_cache**（key 只有 term，若快取住某次的
       上下文翻譯，會被錯誤套用到未來其他句子裡出現的同一個字）。

使用的免費資源（皆免金鑰）：
  - 翻譯文字：MyMemory Translation API（任意語言對，含 ja→zh-TW / en→zh-TW）
  - 日文讀音：Jisho API（回傳假名讀音）
  - 羅馬拼音：本地 module/kana.py 由假名轉換（Hepburn）
"""

import json
import os
import re
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

# MyMemory 免費額度：匿名 5,000 字元/日；帶上有效 email（de 參數）提升為 50,000 字元/日。
# 常駐雙字幕會逐句翻譯，額度消耗快，務必設定此環境變數。留空則自動退回匿名額度。
_MYMEMORY_EMAIL = os.getenv("MYMEMORY_EMAIL", "").strip()


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
            params = {"q": term, "langpair": f"{src}|{target}"}
            if _MYMEMORY_EMAIL:
                params["de"] = _MYMEMORY_EMAIL
            try:
                resp = await client.get(_MYMEMORY_URL, params=params)
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


def _context_window(term: str, sentence: str, language: str) -> Optional[str]:
    """
    單字在句子中的翻譯查詢：截取單字周圍一小段上下文（不是整句、也不是孤立單字），
    讓 MyMemory 有語境可以判斷字義，同時不會因為整句太長而失焦。
    找不到單字在句中的位置，或本來就沒有獨立句子（term == sentence）時回傳 None，
    呼叫端據此判斷要不要走「無上下文」的原本快取路徑。
    """
    term = term.strip()
    sentence = sentence.strip()
    if not term or not sentence or term == sentence:
        return None

    if language == "english":
        tokens = re.findall(r"\S+", sentence)
        target = re.sub(r"^\W+|\W+$", "", term).lower()
        for i, tok in enumerate(tokens):
            if re.sub(r"^\W+|\W+$", "", tok).lower() == target:
                window = " ".join(tokens[max(0, i - 2) : min(len(tokens), i + 3)])
                return window if window.lower() != term.lower() else sentence
        return sentence  # 找不到精確詞邊界，退回整句給 MyMemory 判斷

    # 日文等無空白斷詞語言：用字元位置抓單字前後各 6 個字當上下文
    idx = sentence.find(term)
    if idx == -1:
        return sentence
    window = sentence[max(0, idx - 6) : min(len(sentence), idx + len(term) + 6)]
    return window if window != term else sentence


async def _lookup(body: TranslateRequest, query_text: Optional[str] = None) -> dict:
    """
    翻譯查詢：預設翻 body.term 本身（整句路徑，結果會進快取）；
    傳入 query_text 時改翻該段文字（單字上下文小段，呼叫端不會快取結果），
    但讀音／羅馬拼音一律以 body.term 為準（term 是使用者實際點的字）。
    """
    src = _SRC_CODE.get(body.source_language.value)
    if not src:
        raise HTTPException(status_code=400, detail="Unsupported source language")

    translation = await _mymemory_translate(query_text or body.term, src, body.target_language)

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
    # 單字在句中的翻譯：以上下文小段即時查詢，不進快取（見檔案開頭說明）
    window = _context_window(body.term, body.context_sentence or "", body.source_language.value)
    if window is not None:
        payload = await _lookup(body, query_text=window)
        return TranslateResponse(term=body.term, cached=False, **payload)

    # 整句翻譯（或無句子上下文）：走原本的快取路徑
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
