from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[2]
APP_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.api.analytics import router as analytics_router
from backend.api.auth import router as auth_router
from backend.api.captures import router as captures_router
from backend.api.lesson import router as lesson_router
from backend.api.notes import router as notes_router
from backend.api.exposures import router as exposures_router
from backend.api.reviews import router as reviews_router
from backend.api.saved import router as saved_router
from backend.api.translate import router as translate_router
from backend.api.tts import router as tts_router
from backend.api.vocab import router as vocab_router
from backend.api.scenarios import router as scenarios_router
from backend.api.user import router as user_router
from backend.database.connection import database
from backend.module.storage import notes_storage

import os

FRONTEND_DIR = APP_DIR / "frontend"
HTML_DIR = FRONTEND_DIR

_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost,http://localhost:80",
    ).split(",")
    if origin.strip()
]

# Chrome 擴充的來源為 chrome-extension://<id>。設定 EXTENSION_ORIGIN 可精確允許某個已發佈的擴充；
# 未設定時，下方 allow_origin_regex 會放行任意 chrome-extension:// 來源（本機開發用）。
_EXTENSION_ORIGIN = os.getenv("EXTENSION_ORIGIN", "").strip()
if _EXTENSION_ORIGIN:
    _ALLOWED_ORIGINS.append(_EXTENSION_ORIGIN)

app = FastAPI(
    title="LearnFlow API",
    description="FastAPI backend for scenario-first language learning.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_origin_regex=r"^(https?://(192\.168\.0\.\d+)(:\d+)?|chrome-extension://[a-z]{32})$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scenarios_router)
app.include_router(auth_router)
app.include_router(user_router)
app.include_router(saved_router)
app.include_router(lesson_router)
app.include_router(notes_router)
app.include_router(vocab_router)
app.include_router(captures_router)
app.include_router(reviews_router)
app.include_router(exposures_router)
app.include_router(translate_router)
app.include_router(tts_router)
app.include_router(analytics_router)

if FRONTEND_DIR.is_dir():
    if (FRONTEND_DIR / "css").is_dir():
        app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
    if (FRONTEND_DIR / "js").is_dir():
        app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
    if (FRONTEND_DIR / "audio").is_dir():
        app.mount("/audio", StaticFiles(directory=FRONTEND_DIR / "audio"), name="audio")
    if (FRONTEND_DIR / "vendor").is_dir():
        app.mount("/vendor", StaticFiles(directory=FRONTEND_DIR / "vendor"), name="vendor")


@app.on_event("startup")
async def on_startup() -> None:
    await database.connect()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await database.disconnect()
    await notes_storage.close()


if HTML_DIR.is_dir():

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(HTML_DIR / "index.html")

    @app.get("/login.html")
    async def login_page() -> FileResponse:
        return FileResponse(HTML_DIR / "login.html")
