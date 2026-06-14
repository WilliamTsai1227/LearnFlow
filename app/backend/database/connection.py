import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

try:
    import asyncpg
except ImportError:  # pragma: no cover - optional until dependencies are installed.
    asyncpg = None


class Database:
    def __init__(self) -> None:
        self.pool: Optional["asyncpg.Pool"] = None

    async def connect(self) -> None:
        database_url = os.getenv("DATABASE_URL")
        if not database_url:
            return
        if asyncpg is None:
            raise RuntimeError("asyncpg is required when DATABASE_URL is configured")
        self.pool = await asyncpg.create_pool(
            dsn=database_url,
            min_size=int(os.getenv("DB_POOL_MIN_SIZE", "1")),
            max_size=int(os.getenv("DB_POOL_MAX_SIZE", "5")),
            command_timeout=30,
        )

    async def disconnect(self) -> None:
        if self.pool:
            await self.pool.close()
            self.pool = None

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[Optional["asyncpg.Connection"]]:
        if not self.pool:
            yield None
            return
        async with self.pool.acquire() as connection:
            yield connection


database = Database()
