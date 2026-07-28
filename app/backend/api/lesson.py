"""
學習流程 API — 步驟機課程展開、進度、作答紀錄
================================================
規格：spec/document/LEARNING_FLOW_SPEC.md

端點：
  GET /api/scenarios/{scenario_id}/courses/{course_id}/lesson  — 展開步驟與題目（免登入）
  GET /api/lesson/progress/{course_id}                         — 進度（需 JWT）
  PUT /api/lesson/progress/{course_id}                         — 進度 upsert（需 JWT）
  POST /api/lesson/attempts                                    — 批次作答紀錄（需 JWT）
"""

import asyncpg
from asyncpg.exceptions import ForeignKeyViolationError
from fastapi import APIRouter, Depends, HTTPException, status

from backend.database.connection import database, get_db
from backend.module import lesson_builder, lesson_repository, scenario_repository
from backend.module.jwt import get_current_user
from backend.module.schemas import (
    CourseDetail,
    CourseSentence,
    CourseSummary,
    CourseVocabulary,
    Language,
    LessonProgress,
    LessonProgressUpdate,
    LessonResponse,
    LessonStep,
    Level,
    PracticeAttemptsRequest,
)

router = APIRouter(prefix="/api", tags=["Lesson"])


def _require_connection():
    if not database.pool:
        raise HTTPException(
            status_code=503,
            detail="Database is not configured. Set DATABASE_URL and run spec/operate/SQL.md migrations.",
        )


@router.get(
    "/scenarios/{scenario_id}/courses/{course_id}/lesson",
    response_model=LessonResponse,
)
async def get_lesson(scenario_id: str, course_id: str) -> LessonResponse:
    _require_connection()

    async with database.acquire() as conn:
        if conn is None:
            raise HTTPException(status_code=503, detail="Database connection unavailable")

        scenario = await scenario_repository.get_scenario(conn, scenario_id)
        if not scenario:
            raise HTTPException(status_code=404, detail="Scenario not found")

        course = await scenario_repository.get_course(conn, scenario_id, course_id)
        if not course:
            raise HTTPException(status_code=404, detail="Course not found")

        sentence_rows = await scenario_repository.list_sentences_by_course(conn, course_id)
        vocabulary_rows = await scenario_repository.list_vocabulary_by_course(conn, course_id)

        language = scenario["language"]
        other_titles = await lesson_repository.list_other_scenario_titles(
            conn, language, scenario_id
        )
        other_translations = await lesson_repository.list_other_course_translations(
            conn, language, course_id
        )
        # 盲聽干擾項優先用同情境的其他課程（語境合理、無法用主題排除）
        sibling_translations = await lesson_repository.list_sibling_course_translations(
            conn, scenario_id, course_id
        )

    sentences = [dict(row) for row in sentence_rows]
    vocabulary = [dict(row) for row in vocabulary_rows]

    steps = lesson_builder.build_lesson_steps(
        course=dict(course),
        scenario_title=scenario["title"],
        sentences=sentences,
        vocabulary=vocabulary,
        language=language,
        other_scenario_titles=other_titles,
        other_course_translations=other_translations,
        sibling_course_translations=sibling_translations,
    )

    return LessonResponse(
        course=CourseDetail(
            id=course["id"],
            scenario_id=course["scenario_id"],
            title=course["title"],
            level=Level(course["level"]),
            order_index=course["order_index"],
            description=course["description"],
            estimated_minutes=course["estimated_minutes"],
            sentences=[CourseSentence(**row) for row in sentences],
            vocabulary=[CourseVocabulary(**row) for row in vocabulary],
        ),
        scenario_title=scenario["title"],
        steps=[LessonStep(**step) for step in steps],
    )


@router.get("/lesson/progress/{course_id}", response_model=LessonProgress)
async def get_lesson_progress(
    course_id: str,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> LessonProgress:
    row = await lesson_repository.get_progress(db, current_user["id"], course_id)
    if not row:
        return LessonProgress(course_id=course_id)
    return LessonProgress(
        course_id=row["course_id"],
        current_step=row["current_step"],
        completed=row["completed"],
        score=row["score"],
    )


@router.put("/lesson/progress/{course_id}", response_model=LessonProgress)
async def put_lesson_progress(
    course_id: str,
    body: LessonProgressUpdate,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> LessonProgress:
    if body.current_step < 0:
        raise HTTPException(status_code=422, detail="current_step must be >= 0")

    try:
        row = await lesson_repository.upsert_progress(
            db,
            current_user["id"],
            course_id,
            body.current_step,
            body.completed,
            body.score,
        )
    except ForeignKeyViolationError:
        raise HTTPException(status_code=404, detail="Course not found")

    return LessonProgress(
        course_id=row["course_id"],
        current_step=row["current_step"],
        completed=row["completed"],
        score=row["score"],
    )


@router.post("/lesson/attempts", status_code=status.HTTP_201_CREATED)
async def post_lesson_attempts(
    body: PracticeAttemptsRequest,
    current_user: asyncpg.Record = Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
) -> dict:
    try:
        inserted = await lesson_repository.insert_attempts(
            db,
            current_user["id"],
            body.course_id,
            [attempt.model_dump() for attempt in body.attempts],
        )
    except ForeignKeyViolationError:
        raise HTTPException(status_code=404, detail="Course not found")

    return {"inserted": inserted}
