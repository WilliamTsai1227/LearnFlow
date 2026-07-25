"""
FSRS 排程器（純函式，無外部相依）
==================================
精簡版 Free Spaced Repetition Scheduler（FSRS-5 權重與公式），供複習頁背後的
間隔複習排程使用。輸入一張卡的目前記憶狀態與這次的評分，輸出新的
stability / difficulty / state 與下次到期時間（due）。

評分（rating）：1=Again 2=Hard 3=Good 4=Easy
state：0=new 1=learning 2=review 3=relearning

設計取捨（P1）：
- 以「天」為長間隔單位；Again（rating=1）走短學習步（分鐘級），使卡片很快再出現。
- 不做多段 learning steps，state 僅用於分析與「答錯回到 relearning」語意。
- 目標保留率固定 0.9；可日後開放為使用者設定。

參考：https://github.com/open-spaced-repetition/fsrs4anki/wiki
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

# FSRS-5 預設 19 權重
DEFAULT_W = (
    0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
    1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
    2.9898, 0.51655, 0.6621,
)

REQUEST_RETENTION = 0.9
DECAY = -0.5
FACTOR = 19.0 / 81.0            # 對應 DECAY=-0.5，使 R(t=S)=0.9
MIN_DIFFICULTY = 1.0
MAX_DIFFICULTY = 10.0
MAX_INTERVAL_DAYS = 365 * 5
AGAIN_STEP = timedelta(minutes=10)   # Again 的短學習步

# state
STATE_NEW = 0
STATE_LEARNING = 1
STATE_REVIEW = 2
STATE_RELEARNING = 3

RATING_AGAIN = 1
RATING_HARD = 2
RATING_GOOD = 3
RATING_EASY = 4


@dataclass
class CardState:
    stability: float = 0.0
    difficulty: float = 0.0
    state: int = STATE_NEW
    last_review: Optional[datetime] = None
    reps: int = 0
    lapses: int = 0


@dataclass
class ReviewResult:
    stability: float
    difficulty: float
    state: int
    due: datetime
    reps: int
    lapses: int
    elapsed_days: float
    scheduled_days: float


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _retrievability(elapsed_days: float, stability: float) -> float:
    if stability <= 0:
        return 0.0
    return (1.0 + FACTOR * elapsed_days / stability) ** DECAY


def _interval_days(stability: float) -> float:
    """由 stability 反推達到目標保留率的間隔天數。"""
    ivl = (stability / FACTOR) * (REQUEST_RETENTION ** (1.0 / DECAY) - 1.0)
    return _clamp(round(ivl), 1, MAX_INTERVAL_DAYS)


def _init_difficulty(rating: int) -> float:
    d = DEFAULT_W[4] - math.exp(DEFAULT_W[5] * (rating - 1)) + 1.0
    return _clamp(d, MIN_DIFFICULTY, MAX_DIFFICULTY)


def _init_stability(rating: int) -> float:
    return max(DEFAULT_W[rating - 1], 0.1)


def _next_difficulty(difficulty: float, rating: int) -> float:
    delta = -DEFAULT_W[6] * (rating - 3)
    damped = difficulty + delta * (10.0 - difficulty) / 9.0
    # 向 Easy 初始難度做均值回歸
    reverted = DEFAULT_W[7] * _init_difficulty(RATING_EASY) + (1.0 - DEFAULT_W[7]) * damped
    return _clamp(reverted, MIN_DIFFICULTY, MAX_DIFFICULTY)


def _next_stability_recall(stability: float, difficulty: float, retrievability: float, rating: int) -> float:
    hard_penalty = DEFAULT_W[15] if rating == RATING_HARD else 1.0
    easy_bonus = DEFAULT_W[16] if rating == RATING_EASY else 1.0
    growth = (
        math.exp(DEFAULT_W[8])
        * (11.0 - difficulty)
        * (stability ** -DEFAULT_W[9])
        * (math.exp(DEFAULT_W[10] * (1.0 - retrievability)) - 1.0)
        * hard_penalty
        * easy_bonus
    )
    return max(stability * (1.0 + growth), 0.1)


def _next_stability_forget(stability: float, difficulty: float, retrievability: float) -> float:
    s = (
        DEFAULT_W[11]
        * (difficulty ** -DEFAULT_W[12])
        * (((stability + 1.0) ** DEFAULT_W[13]) - 1.0)
        * math.exp(DEFAULT_W[14] * (1.0 - retrievability))
    )
    # 遺忘後的 stability 不應超過原本
    return max(min(s, stability if stability > 0 else s), 0.1)


def review(card: CardState, rating: int, now: Optional[datetime] = None) -> ReviewResult:
    """套用一次評分，回傳新的記憶狀態與到期時間。"""
    if rating not in (RATING_AGAIN, RATING_HARD, RATING_GOOD, RATING_EASY):
        raise ValueError(f"rating must be 1-4, got {rating}")

    now = now or datetime.now(timezone.utc)
    reps = card.reps + 1
    lapses = card.lapses

    # 首次複習（新卡）
    if card.state == STATE_NEW or card.stability <= 0:
        difficulty = _init_difficulty(rating)
        stability = _init_stability(rating)
        elapsed_days = 0.0
    else:
        elapsed_days = 0.0
        if card.last_review is not None:
            elapsed_days = max((now - card.last_review).total_seconds() / 86400.0, 0.0)
        r = _retrievability(elapsed_days, card.stability)
        difficulty = _next_difficulty(card.difficulty, rating)
        if rating == RATING_AGAIN:
            stability = _next_stability_forget(card.stability, difficulty, r)
        else:
            stability = _next_stability_recall(card.stability, difficulty, r, rating)

    if rating == RATING_AGAIN:
        if card.state != STATE_NEW:
            lapses += 1
        state = STATE_RELEARNING
        due = now + AGAIN_STEP
        scheduled_days = 0.0
    else:
        state = STATE_REVIEW
        scheduled_days = _interval_days(stability)
        due = now + timedelta(days=scheduled_days)

    return ReviewResult(
        stability=stability,
        difficulty=difficulty,
        state=state,
        due=due,
        reps=reps,
        lapses=lapses,
        elapsed_days=elapsed_days,
        scheduled_days=scheduled_days,
    )
