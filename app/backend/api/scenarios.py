from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from backend.database.connection import database
from backend.module import scenario_repository
from backend.module.schemas import (
    CourseDetail,
    CourseSentence,
    CourseSummary,
    CourseVocabulary,
    Language,
    Level,
    ScenarioDetail,
    ScenarioSummary,
)


router = APIRouter(prefix="/api", tags=["Scenarios"])


def _require_connection():
    if not database.pool:
        raise HTTPException(
            status_code=503,
            detail="Database is not configured. Set DATABASE_URL and run spec/operate/SQL.md migrations.",
        )


@router.get("/health")
async def health() -> dict:
    db_status = "connected" if database.pool else "not_configured"
    saved_status = "not_checked"

    if database.pool:
        async with database.acquire() as conn:
            if conn is not None:
                tables_ok = await conn.fetchval(
                    """
                    SELECT COUNT(*) = 2
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_name IN (
                          'user_saved_vocabulary',
                          'user_saved_sentences'
                      )
                    """
                )
                saved_status = "ready" if tables_ok else "tables_missing"

    return {
        "status": "ok",
        "service": "learnflow",
        "database": db_status,
        "saved": saved_status,
    }


@router.get("/scenarios", response_model=list[ScenarioSummary])
async def list_scenarios(
    language: Optional[Language] = Query(default=None),
) -> list[ScenarioSummary]:
    _require_connection()

    async with database.acquire() as conn:
        if conn is None:
            raise HTTPException(status_code=503, detail="Database connection unavailable")

        rows = await scenario_repository.list_scenarios(
            conn,
            language=language.value if language else None,
        )

    return [
        ScenarioSummary(
            id=row["id"],
            title=row["title"],
            language=Language(row["language"]),
            description=row["description"],
            course_count=row["course_count"],
            sort_order=row["sort_order"],
        )
        for row in rows
    ]


@router.get("/scenarios/{scenario_id}", response_model=ScenarioDetail)
async def get_scenario(scenario_id: str) -> ScenarioDetail:
    _require_connection()

    async with database.acquire() as conn:
        if conn is None:
            raise HTTPException(status_code=503, detail="Database connection unavailable")

        scenario = await scenario_repository.get_scenario(conn, scenario_id)
        if not scenario:
            raise HTTPException(status_code=404, detail="Scenario not found")

        courses = await scenario_repository.list_courses_by_scenario(conn, scenario_id)

    return ScenarioDetail(
        id=scenario["id"],
        title=scenario["title"],
        language=Language(scenario["language"]),
        description=scenario["description"],
        courses=[
            CourseSummary(
                id=row["id"],
                scenario_id=row["scenario_id"],
                title=row["title"],
                level=Level(row["level"]),
                order_index=row["order_index"],
                description=row["description"],
                estimated_minutes=row["estimated_minutes"],
                sentence_count=row["sentence_count"],
                vocabulary_count=row["vocabulary_count"],
            )
            for row in courses
        ],
    )


@router.get(
    "/scenarios/{scenario_id}/courses/{course_id}",
    response_model=CourseDetail,
)
async def get_course(scenario_id: str, course_id: str) -> CourseDetail:
    _require_connection()

    async with database.acquire() as conn:
        if conn is None:
            raise HTTPException(status_code=503, detail="Database connection unavailable")

        course = await scenario_repository.get_course(conn, scenario_id, course_id)
        if not course:
            raise HTTPException(status_code=404, detail="Course not found")

        sentences = await scenario_repository.list_sentences_by_course(conn, course_id)
        vocabulary = await scenario_repository.list_vocabulary_by_course(conn, course_id)

    return CourseDetail(
        id=course["id"],
        scenario_id=course["scenario_id"],
        title=course["title"],
        level=Level(course["level"]),
        order_index=course["order_index"],
        description=course["description"],
        estimated_minutes=course["estimated_minutes"],
        sentences=[
            CourseSentence(
                id=row["id"],
                order_index=row["order_index"],
                target_text=row["target_text"],
                reading=row["reading"],
                romaji=row["romaji"],
                translation=row["translation"],
                audio_url=row["audio_url"],
            )
            for row in sentences
        ],
        vocabulary=[
            CourseVocabulary(
                id=row["id"],
                order_index=row["order_index"],
                term=row["term"],
                reading=row["reading"],
                romaji=row["romaji"],
                meaning=row["meaning"],
                example_sentence=row["example_sentence"],
                audio_url=row["audio_url"],
            )
            for row in vocabulary
        ],
    )
