"""
Auth API（Google SSO 認證）
============================
僅支援 Google OAuth 2.0 + OIDC 登入。

流程：
  1. GET /api/user/auth/google/start   → 產生 state、設 HttpOnly Cookie、302 到 Google
  2. GET /api/user/auth/google/callback → 驗 state、換 token、upsert user、簽發 RT Cookie
  3. POST /api/user/logout              → 撤銷 RT、清 Cookie
  4. POST /api/user/refresh             → RT Rotation：換新 AT + 新 RT
"""

import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlencode, urlparse
from uuid import UUID

import asyncpg
import httpx
from asyncpg.exceptions import UniqueViolationError
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from backend.database.connection import get_db
from backend.module.jwt import (
    REFRESH_TOKEN_EXPIRE_DAYS,
    create_access_token,
    create_refresh_token,
    decode_token,
)

COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv(
    "GOOGLE_OAUTH_REDIRECT_URI",
    "http://localhost/api/user/auth/google/callback",
)
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost").rstrip("/")
_CORS_ALLOWED_ORIGINS = [
    origin.strip().rstrip("/")
    for origin in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]
_FRONTEND_RETURN_ORIGIN_RE = re.compile(
    r"^https?://(localhost|127\.0\.0\.1|192\.168\.0\.\d+)(:\d+)?$",
    re.IGNORECASE,
)

_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

router = APIRouter(tags=["User Authentication"])


class TokenRefreshResponse(BaseModel):
    status: str = "success"
    access_token: str
    token_type: str = "bearer"


def _normalize_frontend_origin(url: Optional[str]) -> Optional[str]:
    if not url or not str(url).strip():
        return None
    try:
        parsed = urlparse(str(url).strip())
    except Exception:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    if parsed.path not in ("", "/"):
        return None
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


def _is_allowed_frontend_origin(origin: str) -> bool:
    normalized = origin.rstrip("/")
    if normalized == FRONTEND_URL.rstrip("/"):
        return True
    if normalized in _CORS_ALLOWED_ORIGINS:
        return True
    return bool(_FRONTEND_RETURN_ORIGIN_RE.match(normalized))


def resolve_frontend_return_url(candidate: Optional[str]) -> str:
    origin = _normalize_frontend_origin(candidate)
    if origin and _is_allowed_frontend_origin(origin):
        return origin
    return FRONTEND_URL.rstrip("/")


def _fe_error(error_code: str, return_base: Optional[str] = None) -> RedirectResponse:
    base = resolve_frontend_return_url(return_base)
    return RedirectResponse(
        url=f"{base}/login.html?error={error_code}",
        status_code=302,
    )


async def _issue_refresh_token(
    db: asyncpg.Connection,
    user_id: UUID,
    user_data: dict,
) -> str:
    expires_at = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    for _ in range(3):
        candidate = create_refresh_token(data=user_data)
        try:
            await db.execute(
                "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
                user_id,
                candidate,
                expires_at,
            )
            return candidate
        except UniqueViolationError:
            continue
    raise RuntimeError("Failed to generate unique refresh token after 3 attempts")


@router.get("/api/user/auth/google/start")
async def google_start(return_url: Optional[str] = None):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google OAuth is not configured on this server.",
        )

    state = secrets.token_urlsafe(32)
    frontend_return = resolve_frontend_return_url(return_url)

    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "offline",
        "prompt": "select_account",
    }
    redirect = RedirectResponse(
        url=f"{_GOOGLE_AUTH_URL}?{urlencode(params)}",
        status_code=302,
    )
    redirect.set_cookie(
        key="oauth_state",
        value=state,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=600,
    )
    redirect.set_cookie(
        key="oauth_return_url",
        value=frontend_return,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=600,
    )
    return redirect


@router.get("/api/user/auth/google/callback")
async def google_callback(
    db: asyncpg.Connection = Depends(get_db),
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    oauth_state: Optional[str] = Cookie(None),
    oauth_return_url: Optional[str] = Cookie(None),
):
    frontend_base = resolve_frontend_return_url(oauth_return_url)

    if error:
        return _fe_error("oauth_cancelled", frontend_base)

    if not state or not oauth_state or state != oauth_state:
        return _fe_error("invalid_state", frontend_base)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            token_resp = await client.post(
                _GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "redirect_uri": GOOGLE_REDIRECT_URI,
                    "grant_type": "authorization_code",
                },
            )
            token_resp.raise_for_status()
            token_data = token_resp.json()
    except httpx.HTTPError as e:
        print(f"[Google OAuth] Token exchange failed: {e}")
        return _fe_error("token_exchange_failed", frontend_base)

    google_at = token_data.get("access_token")
    if not google_at:
        return _fe_error("no_access_token", frontend_base)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            userinfo_resp = await client.get(
                _GOOGLE_USERINFO_URL,
                headers={"Authorization": f"Bearer {google_at}"},
            )
            userinfo_resp.raise_for_status()
            userinfo = userinfo_resp.json()
    except httpx.HTTPError as e:
        print(f"[Google OAuth] UserInfo fetch failed: {e}")
        return _fe_error("userinfo_failed", frontend_base)

    google_sub: Optional[str] = userinfo.get("sub")
    email: Optional[str] = userinfo.get("email")
    display_name: str = userinfo.get("name") or (email.split("@")[0] if email else "user")
    avatar_url: Optional[str] = userinfo.get("picture")

    if not google_sub or not email:
        return _fe_error("missing_user_info", frontend_base)

    now = datetime.now(timezone.utc)
    try:
        user = await db.fetchrow(
            "SELECT id, email, username FROM users WHERE google_sub = $1",
            google_sub,
        )

        if not user:
            existing = await db.fetchrow(
                "SELECT id, email, username FROM users WHERE email = $1 AND deleted_at IS NULL",
                email,
            )
            if existing:
                await db.execute(
                    """
                    UPDATE users
                    SET google_sub = $1, last_login_at = $2, last_login_provider = 'google',
                        display_name = COALESCE(display_name, $4),
                        avatar_url = COALESCE(avatar_url, $5),
                        updated_at = $2
                    WHERE id = $3
                    """,
                    google_sub,
                    now,
                    existing["id"],
                    display_name,
                    avatar_url,
                )
                user = existing
            else:
                base = display_name.lower().replace(" ", "_")[:40]
                username = base
                i = 1
                while await db.fetchval(
                    "SELECT id FROM users WHERE username = $1", username
                ):
                    username = f"{base}_{i}"
                    i += 1

                async with db.transaction():
                    user_id = await db.fetchval(
                        """
                        INSERT INTO users
                            (email, username, google_sub, display_name, avatar_url,
                             last_login_provider, last_login_at, subscription_tier)
                        VALUES
                            ($1, $2, $3, $4, $5, 'google', $6, 'free')
                        RETURNING id
                        """,
                        email,
                        username,
                        google_sub,
                        display_name,
                        avatar_url,
                        now,
                    )
                    await db.execute(
                        "INSERT INTO user_profiles (user_id) VALUES ($1)",
                        user_id,
                    )

                user = await db.fetchrow(
                    "SELECT id, email, username FROM users WHERE id = $1",
                    user_id,
                )
        else:
            await db.execute(
                """
                UPDATE users
                SET last_login_at = $1, last_login_provider = 'google', updated_at = $1
                WHERE id = $2
                """,
                now,
                user["id"],
            )

    except Exception as e:
        print(f"[Google OAuth] DB error: {e}")
        return _fe_error("db_error", frontend_base)

    user_data = {"sub": str(user["id"]), "email": user["email"]}
    try:
        rt = await _issue_refresh_token(db, user["id"], user_data)
    except RuntimeError as e:
        print(f"[Google OAuth] RT issue error: {e}")
        return _fe_error("session_error", frontend_base)

    await db.execute(
        "DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at <= NOW()",
        user["id"],
    )

    redirect = RedirectResponse(url=f"{frontend_base}/index.html", status_code=302)
    redirect.set_cookie(
        key="refresh_token",
        value=rt,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
    )
    return redirect


@router.post("/api/user/logout")
async def logout(
    response: Response,
    refresh_token: Optional[str] = Cookie(None),
    db: asyncpg.Connection = Depends(get_db),
):
    if refresh_token:
        await db.execute(
            "DELETE FROM refresh_tokens WHERE token = $1",
            refresh_token,
        )
    response.delete_cookie("refresh_token")
    return {"status": "success", "message": "Logged out successfully"}


@router.post("/api/user/refresh", response_model=TokenRefreshResponse)
async def refresh_access_token(
    response: Response,
    refresh_token: Optional[str] = Cookie(None),
    db: asyncpg.Connection = Depends(get_db),
):
    if not refresh_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token missing",
        )

    payload = decode_token(refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token invalid or expired. Please login again.",
        )

    consumed = await db.fetchrow(
        """
        DELETE FROM refresh_tokens
        WHERE token = $1 AND expires_at > NOW()
        RETURNING user_id
        """,
        refresh_token,
    )

    if not consumed:
        user_id_str = payload.get("sub")
        if user_id_str:
            try:
                uid = UUID(user_id_str)
                await db.execute(
                    "DELETE FROM refresh_tokens WHERE user_id = $1",
                    uid,
                )
            except Exception:
                pass
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Security alert: Token reuse detected. All sessions have been revoked. Please login again.",
        )

    user = await db.fetchrow(
        "SELECT id, email FROM users WHERE id = $1 AND deleted_at IS NULL",
        consumed["user_id"],
    )
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    user_data = {"sub": str(user["id"]), "email": user["email"]}
    new_at = create_access_token(data=user_data)

    try:
        new_rt = await _issue_refresh_token(db, user["id"], user_data)
    except RuntimeError:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to rotate refresh token. Please login again.",
        )

    response.set_cookie(
        key="refresh_token",
        value=new_rt,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
    )

    return {
        "status": "success",
        "access_token": new_at,
        "token_type": "bearer",
    }


class ExtensionTokenRequest(BaseModel):
    refresh_token: str


@router.post("/api/user/extension/token", response_model=TokenRefreshResponse)
async def extension_access_token(
    body: ExtensionTokenRequest,
    db: asyncpg.Connection = Depends(get_db),
):
    """
    Chrome 擴充換取 access token。
    擴充以 `cookies` 權限讀出網站的 HttpOnly refresh_token，POST 到此端點換 access token。
    與 /api/user/refresh 不同：**不輪替、不消耗** refresh token，避免干擾網站分頁的既有 session。
    僅驗證該 RT 仍存在於 DB 且未過期，簽發短效 access token。
    """
    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token invalid or expired. Please login again.",
        )

    row = await db.fetchrow(
        """
        SELECT rt.user_id, u.email
        FROM refresh_tokens rt
        JOIN users u ON u.id = rt.user_id
        WHERE rt.token = $1 AND rt.expires_at > NOW() AND u.deleted_at IS NULL
        """,
        body.refresh_token,
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session not found. Please log in to LearnFlow again.",
        )

    access_token = create_access_token(
        data={"sub": str(row["user_id"]), "email": row["email"]}
    )
    return {"status": "success", "access_token": access_token, "token_type": "bearer"}
