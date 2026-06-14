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
    translation: str
    audio_url: Optional[str] = None


class CourseVocabulary(BaseModel):
    id: str
    order_index: int
    term: str
    reading: Optional[str] = None
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
