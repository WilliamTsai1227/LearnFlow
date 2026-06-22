"""
JWT 模組 — 統一管理 JWT 簽發與 FastAPI Depends 驗證。
"""

import os
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID, uuid4

import asyncpg
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext

from backend.database.connection import get_db

SECRET_KEY = os.getenv("SECRET_KEY", "super-secret-key-for-development")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7

_pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/user/login")
_CREDENTIALS_EXCEPTION = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


def hash_password(password: str) -> str:
    return _pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return _pwd_context.verify(plain_password, hashed_password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta if expires_delta else timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(data: dict) -> str:
    now = datetime.now(timezone.utc)
    expire = now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode = data.copy()
    to_encode.update(
        {
            "exp": expire,
            "iat": now,
            "jti": str(uuid4()),
            "type": "refresh",
        }
    )
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except Exception:
        return None


def _decode_user_id(token: str) -> UUID:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id_str: str = payload.get("sub")
        if not user_id_str:
            raise _CREDENTIALS_EXCEPTION
        return UUID(user_id_str)
    except (JWTError, ValueError):
        raise _CREDENTIALS_EXCEPTION


async def get_current_user_id(
    token: str = Depends(_oauth2_scheme),
) -> UUID:
    return _decode_user_id(token)


async def get_current_user(
    token: str = Depends(_oauth2_scheme),
    db: asyncpg.Connection = Depends(get_db),
) -> asyncpg.Record:
    user_uuid = _decode_user_id(token)

    user = await db.fetchrow(
        """
        SELECT id, email, username, display_name, avatar_url, status,
               subscription_tier, last_login_at, created_at, updated_at
        FROM users
        WHERE id = $1 AND deleted_at IS NULL
        """,
        user_uuid,
    )

    if user is None:
        raise _CREDENTIALS_EXCEPTION

    if user["status"] == "disabled":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is disabled.",
        )

    return user
