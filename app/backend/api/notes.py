"""
筆記 API — 上傳 PDF / Word 文件，做螢光筆標註與 comment 留言
==============================================================
需 Bearer JWT。檔案本體交由 module/storage.py 儲存（本機為目錄、正式環境為 Blob）。

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
from typing import Any, List, Optional
from urllib.parse import quote
from uuid import UUID, uuid4

import asyncpg
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend.database.connection import get_db
from backend.module import notes_repository
from backend.module.jwt import get_current_user
from backend.module.storage import note_key, notes_storage

router = APIRouter(prefix="/api", tags=["Notes"])

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


class NoteText(BaseModel):
    id: str
    canvas_x: float
    canvas_y: float
    canvas_w: Optional[float] = None
    canvas_h: Optional[float] = None
    body: str
    created_at: Any
    updated_at: Any


class CreateNoteTextRequest(BaseModel):
    canvas_x: float = 0
    canvas_y: float = 0
    canvas_w: Optional[float] = None
    canvas_h: Optional[float] = None
    body: str = ""


class UpdateNoteTextRequest(BaseModel):
    canvas_x: Optional[float] = None
    canvas_y: Optional[float] = None
    canvas_w: Optional[float] = None
    canvas_h: Optional[float] = None
    body: Optional[str] = None


def _note_text(row: asyncpg.Record) -> "NoteText":
    return NoteText(
        id=str(row["id"]),
        canvas_x=row["canvas_x"],
        canvas_y=row["canvas_y"],
        canvas_w=row["canvas_w"],
        canvas_h=row["canvas_h"],
        body=row["body"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


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
    try:
        await notes_storage.save(note_key(current_user["id"], note_id, ext), data)
    except Exception as exc:
        # 儲存失敗時回滾 DB，避免留下沒有實體檔案的孤兒筆記
        await notes_repository.delete_note(db, current_user["id"], row["id"])
        # 原始例外可能夾帶連線字串等內部資訊，只寫 log 不回給瀏覽器
        print(f"[Notes] 儲存檔案失敗（{notes_storage.backend}）：{exc}")
        raise HTTPException(
            status_code=500,
            detail="伺服器無法儲存檔案，請稍後再試。",
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
    data = await notes_storage.load(note_key(current_user["id"], str(note_id), ext))
    if data is None:
        raise HTTPException(status_code=404, detail="File missing on server")
    # 標題可能含非 ASCII 字元，用 RFC 5987 格式避免 header 編碼錯誤
    filename = quote(f"{row['title']}.{ext}")
    return Response(
        content=data,
        media_type=_MEDIA_TYPE.get(ext, "application/octet-stream"),
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
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
    key = note_key(current_user["id"], str(note_id), row["file_ext"])
    await notes_repository.delete_note(db, current_user["id"], note_id)
    try:
        await notes_storage.delete(key)
    except Exception:
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


# --- 畫布自由文字框 ---


@router.get("/note-texts", response_model=List[NoteText])
async def list_note_texts(
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await notes_repository.list_texts(db, current_user["id"])
    return [_note_text(r) for r in rows]


@router.post("/note-texts", response_model=NoteText, status_code=status.HTTP_201_CREATED)
async def create_note_text(
    body: CreateNoteTextRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await notes_repository.create_text(
        db, current_user["id"], body.canvas_x, body.canvas_y, body.canvas_w, body.canvas_h, body.body
    )
    return _note_text(row)


@router.patch("/note-texts/{text_id}", response_model=NoteText)
async def update_note_text(
    text_id: UUID,
    body: UpdateNoteTextRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await notes_repository.update_text(
        db, current_user["id"], text_id, body.canvas_x, body.canvas_y, body.canvas_w, body.canvas_h, body.body
    )
    if not row:
        raise HTTPException(status_code=404, detail="Text not found")
    return _note_text(row)


@router.delete("/note-texts/{text_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note_text(
    text_id: UUID,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    deleted = await notes_repository.delete_text(db, current_user["id"], text_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Text not found")
