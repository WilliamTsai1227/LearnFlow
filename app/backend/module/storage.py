"""
使用者上傳檔案的儲存抽象層
==========================

同一組介面，兩種後端：

- 本機 / Docker：寫入本地目錄（`NOTES_UPLOAD_DIR`，預設 `backend/uploads`）
- 正式環境：寫入 Azure Blob Storage 的**私有**容器

為什麼正式環境不能用本地目錄：Container Apps 的容器檔案系統是暫時的，
重新部署或縮到 0 replica 就會清空。此時資料庫的 `notes` 記錄還在、檔案卻不見了，
使用者會看到筆記列在清單上卻打不開（404 File missing on server）。

切換方式：設定 `AZURE_STORAGE_CONNECTION_STRING` 即改用 Blob，未設定則用本地目錄。
筆記屬於私人資料，容器必須維持私有（無匿名存取）；下載一律經過後端驗證身分後轉發，
不對外發放 SAS 連結。
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Optional

try:  # 未安裝 azure-storage-blob 時仍可用本地儲存
    from azure.storage.blob.aio import BlobServiceClient
except ImportError:  # pragma: no cover
    BlobServiceClient = None  # type: ignore[assignment]


AZURE_CONNECTION_STRING = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "").strip()
NOTES_CONTAINER = os.getenv("AZURE_NOTES_CONTAINER", "").strip() or "notes"

LOCAL_ROOT = Path(
    os.getenv("NOTES_UPLOAD_DIR") or (Path(__file__).resolve().parents[1] / "uploads")
)


class LocalFileStorage:
    """本機 / Docker volume。阻塞式 IO 一律丟到執行緒，避免卡住事件迴圈。"""

    backend = "local"

    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, key: str) -> Path:
        return self.root / key

    async def save(self, key: str, data: bytes) -> None:
        path = self._path(key)

        def _write() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

        await asyncio.to_thread(_write)

    async def load(self, key: str) -> Optional[bytes]:
        path = self._path(key)

        def _read() -> Optional[bytes]:
            if not path.is_file():
                return None
            return path.read_bytes()

        return await asyncio.to_thread(_read)

    async def delete(self, key: str) -> None:
        path = self._path(key)
        await asyncio.to_thread(lambda: path.unlink(missing_ok=True))

    async def healthy(self) -> bool:
        return await asyncio.to_thread(lambda: self.root.parent.is_dir())

    async def close(self) -> None:
        return None


class AzureBlobStorage:
    """Azure Blob Storage 私有容器。用戶端延遲建立並重複使用。"""

    backend = "azure_blob"

    def __init__(self, connection_string: str, container: str) -> None:
        if BlobServiceClient is None:
            raise RuntimeError(
                "設定了 AZURE_STORAGE_CONNECTION_STRING，但未安裝 azure-storage-blob"
            )
        self._connection_string = connection_string
        self._container = container
        self._client: Optional["BlobServiceClient"] = None
        self._lock = asyncio.Lock()

    async def _container_client(self):
        if self._client is None:
            async with self._lock:
                if self._client is None:
                    self._client = BlobServiceClient.from_connection_string(
                        self._connection_string
                    )
        return self._client.get_container_client(self._container)

    async def save(self, key: str, data: bytes) -> None:
        container = await self._container_client()
        await container.upload_blob(name=key, data=data, overwrite=True)

    async def load(self, key: str) -> Optional[bytes]:
        from azure.core.exceptions import ResourceNotFoundError

        container = await self._container_client()
        try:
            stream = await container.download_blob(key)
            return await stream.readall()
        except ResourceNotFoundError:
            return None

    async def delete(self, key: str) -> None:
        from azure.core.exceptions import ResourceNotFoundError

        container = await self._container_client()
        try:
            await container.delete_blob(key)
        except ResourceNotFoundError:
            return None

    async def healthy(self) -> bool:
        from azure.core.exceptions import AzureError

        try:
            container = await self._container_client()
            return bool(await container.exists())
        except AzureError:
            return False

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None


def _build_storage():
    if AZURE_CONNECTION_STRING:
        return AzureBlobStorage(AZURE_CONNECTION_STRING, NOTES_CONTAINER)
    return LocalFileStorage(LOCAL_ROOT)


notes_storage = _build_storage()


def note_key(user_id, note_id: str, ext: str) -> str:
    """本地路徑與 blob 名稱共用同一組 key，沿用既有的 {user_id}/{note_id}.{ext} 結構。"""
    return f"{user_id}/{note_id}.{ext}"
