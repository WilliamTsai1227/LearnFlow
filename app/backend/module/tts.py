"""
語音合成（edge-tts，微軟 Edge 類神經語音，免費免金鑰）
======================================================
與課程音檔（script/generate_audio_local.py）用同一套語音/語速設定，
確保 YouTube 收藏（複習頁、收藏頁、Chrome 擴充）跟課程內容聽起來一致、
不再用瀏覽器內建 Web Speech API（音色差、依系統而異）。
"""

import os

import edge_tts

VOICES = {
    "japanese": os.getenv("EDGE_TTS_VOICE_JA", "ja-JP-NanamiNeural"),
    "english": os.getenv("EDGE_TTS_VOICE_EN", "en-US-JennyNeural"),
}
RATE = os.getenv("EDGE_TTS_RATE", "-10%")


async def synthesize(text: str, language: str) -> bytes:
    """回傳 MP3 bytes；language 不在 VOICES 中時退回英文語音。"""
    voice = VOICES.get(language, VOICES["english"])
    communicate = edge_tts.Communicate(text, voice, rate=RATE)
    chunks: list[bytes] = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    audio = b"".join(chunks)
    if not audio:
        raise RuntimeError("edge-tts returned empty audio")
    return audio
