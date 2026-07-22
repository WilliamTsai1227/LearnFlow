from enum import Enum
from typing import List, Optional

from pydantic import BaseModel


class Language(str, Enum):
    english = "english"
    japanese = "japanese"


class Level(str, Enum):
    beginner = "beginner"
    intermediate = "intermediate"
    advanced = "advanced"


class ScenarioSummary(BaseModel):
    id: str
    title: str
    language: Language
    description: str
    course_count: int
    sort_order: int


class CourseSummary(BaseModel):
    id: str
    scenario_id: str
    title: str
    level: Level
    order_index: int
    description: str
    estimated_minutes: int
    sentence_count: int
    vocabulary_count: int


class CourseSentence(BaseModel):
    id: str
    order_index: int
    target_text: str
    reading: Optional[str] = None
    romaji: Optional[str] = None
    translation: str
    audio_url: Optional[str] = None


class CourseVocabulary(BaseModel):
    id: str
    order_index: int
    term: str
    reading: Optional[str] = None
    romaji: Optional[str] = None
    meaning: str
    example_sentence: Optional[str] = None
    audio_url: Optional[str] = None


class ScenarioDetail(BaseModel):
    id: str
    title: str
    language: Language
    description: str
    courses: List[CourseSummary]


class CourseDetail(BaseModel):
    id: str
    scenario_id: str
    title: str
    level: Level
    order_index: int
    description: str
    estimated_minutes: int
    sentences: List[CourseSentence]
    vocabulary: List[CourseVocabulary]


class LessonStep(BaseModel):
    step_index: int
    type: str
    title: str
    data: dict


class LessonResponse(BaseModel):
    course: CourseDetail
    scenario_title: str
    steps: List[LessonStep]


class LessonProgress(BaseModel):
    course_id: str
    current_step: int = 0
    completed: bool = False
    score: Optional[int] = None


class LessonProgressUpdate(BaseModel):
    current_step: int
    completed: bool = False
    score: Optional[int] = None


class PracticeAttemptIn(BaseModel):
    step_type: str
    exercise_kind: str
    item_type: Optional[str] = None
    item_id: Optional[str] = None
    is_correct: bool


class PracticeAttemptsRequest(BaseModel):
    course_id: str
    attempts: List[PracticeAttemptIn]


class VocabDeck(BaseModel):
    id: str
    language: Language
    kind: str
    title: str
    description: str
    item_count: int
    sort_order: int


class VocabItem(BaseModel):
    id: str
    group_key: Optional[str] = None
    order_index: int
    term: str
    romaji: Optional[str] = None
    reading: Optional[str] = None
    meaning: Optional[str] = None
    audio_url: Optional[str] = None
    category: Optional[str] = None
    kana_row: Optional[str] = None
    kana_col: Optional[str] = None


class VocabDeckDetail(BaseModel):
    id: str
    language: Language
    kind: str
    title: str
    description: str
    items: List[VocabItem]
