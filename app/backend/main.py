from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[2]
APP_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.api.auth import router as auth_router
from backend.api.saved import router as saved_router
from backend.api.scenarios import router as scenarios_router
from backend.api.user import router as user_router
from backend.database.connection import database

import os

FRONTEND_DIR = APP_DIR / "frontend"
HTML_DIR = FRONTEND_DIR / "html"

_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost,http://localhost:80",
    ).split(",")
    if origin.strip()
]

app = FastAPI(
    title="LearnFlow API",
    description="FastAPI backend for scenario-first language learning.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_origin_regex=r"^https?://(192\.168\.0\.\d+)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scenarios_router)
app.include_router(auth_router)
app.include_router(user_router)
app.include_router(saved_router)

if FRONTEND_DIR.is_dir():
    if (FRONTEND_DIR / "css").is_dir():
        app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
    if (FRONTEND_DIR / "js").is_dir():
        app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
    if (FRONTEND_DIR / "audio").is_dir():
        app.mount("/audio", StaticFiles(directory=FRONTEND_DIR / "audio"), name="audio")


@app.on_event("startup")
async def on_startup() -> None:
    await database.connect()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await database.disconnect()


if HTML_DIR.is_dir():

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(HTML_DIR / "index.html")

    @app.get("/login.html")
    async def login_page() -> FileResponse:
        return FileResponse(HTML_DIR / "login.html")
