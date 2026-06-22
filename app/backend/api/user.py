"""
User Management API — 目前僅提供 GET /api/user 個人資料。
"""

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr

from backend.database.connection import get_db
from backend.module.jwt import get_current_user

router = APIRouter(tags=["User Management"])


class UserProfile(BaseModel):
    id: str
    email: EmailStr
    username: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    status: str
    subscription_tier: str = "free"


@router.get("/api/user", response_model=UserProfile)
async def get_my_profile(
    current_user: asyncpg.Record = Depends(get_current_user),
):
    return UserProfile(
        id=str(current_user["id"]),
        email=current_user["email"],
        username=current_user["username"],
        display_name=current_user["display_name"],
        avatar_url=current_user["avatar_url"],
        status=current_user["status"],
        subscription_tier=current_user["subscription_tier"],
    )
