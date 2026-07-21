"""
筆記 API — 上傳 PDF / Word 文件，做螢光筆標註與 comment 留言
==============================================================
需 Bearer JWT。檔案存於 backend/uploads/{user_id}/{note_id}.{ext}。

端點：
  GET    /api/notes                          — 筆記列表
  POST   /api/notes                          — 上傳（multipart file）
  GET    /api/notes/{id}                      — 單筆 meta
  GET    /api/notes/{id}/file                 — 下載原始檔（供前端渲染）
  DELETE /api/notes/{id}                      — 刪除筆記與檔案
  GET    /api/notes/{id}/annotations          — 標註列表
  POST   /api/notes/{id}/annotations          — 新增標註（highlight / comment）
  PATCH  /api/annotations/{id}                — 更新顏色或留言內容
  DELETE /api/annotations/{id}                — 刪除標註
"""

import json
import os
from pathlib import Path
from typing import Any, List, Optional
from uuid import UUID, uuid4

import asyncpg
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from backend.database.connection import get_db
from backend.module import notes_repository
from backend.module.jwt import get_current_user

router = APIRouter(prefix="/api", tags=["Notes"])

# 上傳檔存放根目錄。Docker 下的程式碼目錄是唯讀掛載，必須用 NOTES_UPLOAD_DIR
# 指到可寫的 volume（見 deploy/docker-compose.yml）。本機開發預設為 backend/uploads。
UPLOAD_ROOT = Path(
    os.getenv("NOTES_UPLOAD_DIR") or (Path(__file__).resolve().parents[1] / "uploads")
)
MAX_BYTES = 25 * 1024 * 1024  # 25 MB

_EXT_TYPE = {"pdf": "pdf", "docx": "docx", "doc": "docx"}
_MEDIA_TYPE = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
}
_ALLOWED_COLORS = {"yellow", "green", "blue", "pink", "orange", "purple"}


class NoteMeta(BaseModel):
    id: str
    title: str
    file_type: str
    file_ext: str
    size_bytes: int
    canvas_x: Optional[float] = None
    canvas_y: Optional[float] = None
    annotation_count: int = 0
    created_at: Any
    updated_at: Any


class UpdateNoteRequest(BaseModel):
    canvas_x: float
    canvas_y: float


def _note_meta(row: asyncpg.Record, annotation_count: int = 0) -> "NoteMeta":
    return NoteMeta(
        id=str(row["id"]),
        title=row["title"],
        file_type=row["file_type"],
        file_ext=row["file_ext"],
        size_bytes=row["size_bytes"],
        canvas_x=row["canvas_x"],
        canvas_y=row["canvas_y"],
        annotation_count=annotation_count,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class Annotation(BaseModel):
    id: str
    note_id: str
    kind: str
    page: int
    color: str
    rects: List[dict]
    quote: Optional[str] = None
    body: Optional[str] = None
    created_at: Any
    updated_at: Any


class CreateAnnotationRequest(BaseModel):
    kind: str = Field(..., pattern="^(highlight|comment)$")
    page: int = Field(default=1, ge=1)
    color: str = "yellow"
    rects: List[dict] = Field(default_factory=list)
    quote: Optional[str] = None
    body: Optional[str] = None


class UpdateAnnotationRequest(BaseModel):
    color: Optional[str] = None
    body: Optional[str] = None


def _rows_annotation(row: asyncpg.Record) -> Annotation:
    rects = row["rects"]
    if isinstance(rects, str):
        rects = json.loads(rects)
    return Annotation(
        id=str(row["id"]),
        note_id=str(row["note_id"]),
        kind=row["kind"],
        page=row["page"],
        color=row["color"],
        rects=rects or [],
        quote=row["quote"],
        body=row["body"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _note_path(user_id: UUID, note_id: str, ext: str) -> Path:
    return UPLOAD_ROOT / str(user_id) / f"{note_id}.{ext}"


@router.get("/notes", response_model=List[NoteMeta])
async def list_notes(
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await notes_repository.list_notes(db, current_user["id"])
    return [_note_meta(r, annotation_count=r["annotation_count"]) for r in rows]


@router.post("/notes", response_model=NoteMeta, status_code=status.HTTP_201_CREATED)
async def upload_note(
    file: UploadFile = File(...),
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    filename = file.filename or "note"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in _EXT_TYPE:
        raise HTTPException(status_code=400, detail="只支援 PDF 或 Word（.pdf / .docx）檔案")

    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="檔案是空的")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="檔案過大（上限 25MB）")

    file_type = _EXT_TYPE[ext]
    title = filename.rsplit(".", 1)[0][:255] or "未命名筆記"

    row = await notes_repository.create_note(
        db, current_user["id"], title, file_type, ext, len(data)
    )
    note_id = str(row["id"])
    path = _note_path(current_user["id"], note_id, ext)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    except OSError as exc:
        # 寫檔失敗時回滾 DB，避免留下沒有實體檔案的孤兒筆記
        await notes_repository.delete_note(db, current_user["id"], row["id"])
        raise HTTPException(
            status_code=500,
            detail=f"伺服器無法儲存檔案（{exc.strerror or exc}）。請確認 NOTES_UPLOAD_DIR 指向可寫入的目錄。",
        )

    return _note_meta(row, annotation_count=0)


@router.get("/notes/{note_id}", response_model=NoteMeta)
async def get_note(
    note_id: UUID,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await notes_repository.get_note(db, current_user["id"], note_id)
    if not row:
        raise HTTPException(status_code=404, detail="Note not found")
    return _note_meta(row)


@router.patch("/notes/{note_id}", response_model=NoteMeta)
async def update_note(
    note_id: UUID,
    body: UpdateNoteRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await notes_repository.update_note_position(
        db, current_user["id"], note_id, body.canvas_x, body.canvas_y
    )
    if not row:
        raise HTTPException(status_code=404, detail="Note not found")
    return _note_meta(row)


@router.get("/notes/{note_id}/file")
async def get_note_file(
    note_id: UUID,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await notes_repository.get_note(db, current_user["id"], note_id)
    if not row:
        raise HTTPException(status_code=404, detail="Note not found")
    ext = row["file_ext"]
    path = _note_path(current_user["id"], str(note_id), ext)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File missing on server")
    return FileResponse(
        path,
        media_type=_MEDIA_TYPE.get(ext, "application/octet-stream"),
        filename=f"{row['title']}.{ext}",
    )


@router.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(
    note_id: UUID,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await notes_repository.get_note(db, current_user["id"], note_id)
    if not row:
        raise HTTPException(status_code=404, detail="Note not found")
    path = _note_path(current_user["id"], str(note_id), row["file_ext"])
    await notes_repository.delete_note(db, current_user["id"], note_id)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


@router.get("/notes/{note_id}/annotations", response_model=List[Annotation])
async def list_annotations(
    note_id: UUID,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    note = await notes_repository.get_note(db, current_user["id"], note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    rows = await notes_repository.list_annotations(db, note_id)
    return [_rows_annotation(r) for r in rows]


@router.post(
    "/notes/{note_id}/annotations",
    response_model=Annotation,
    status_code=status.HTTP_201_CREATED,
)
async def create_annotation(
    note_id: UUID,
    body: CreateAnnotationRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    note = await notes_repository.get_note(db, current_user["id"], note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    color = body.color if body.color in _ALLOWED_COLORS else "yellow"
    row = await notes_repository.create_annotation(
        db,
        note_id,
        current_user["id"],
        body.kind,
        body.page,
        color,
        body.rects,
        body.quote,
        body.body,
    )
    await notes_repository.touch_note(db, note_id)
    return _rows_annotation(row)


@router.patch("/annotations/{annotation_id}", response_model=Annotation)
async def update_annotation(
    annotation_id: UUID,
    body: UpdateAnnotationRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    color = body.color if (body.color in _ALLOWED_COLORS) else None
    row = await notes_repository.update_annotation(
        db, current_user["id"], annotation_id, color, body.body
    )
    if not row:
        raise HTTPException(status_code=404, detail="Annotation not found")
    return _rows_annotation(row)


@router.delete("/annotations/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_annotation(
    annotation_id: UUID,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    deleted = await notes_repository.delete_annotation(
        db, current_user["id"], annotation_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Annotation not found")
