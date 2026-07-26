"""
FSRS 排程 — 官方 py-fsrs 的薄封裝層
====================================
不自行實作記憶公式，一律交給官方套件（fsrs 6.x）。本模組只負責：
  1. DB 欄位 ⇄ fsrs.Card 的轉換
  2. 提供單一 Scheduler 實例與產品參數
  3. 佇列排序用的可提取率計算

產品參數（依規格）：
  - desired_retention = 0.9
      目標記憶率。越接近 1，每日複習量會急遽上升；0.9 是記憶率與負擔的平衡點。
  - learning_steps = (10 分, 30 分)
      新卡當日只做短期重複一次即畢業，不要同一天重複五六次
      （短時間內連續答對，對長期記憶價值有限）。

欄位對照（已實測 py-fsrs 6.3.1）：
  State  : Learning=1, Review=2, Relearning=3（無 new；新卡即 Learning）
  Rating : Again=1, Hard=2, Good=3, Easy=4
  新卡    : step=0, stability=None, difficulty=None
  進入 Review 後 step 變為 None
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fsrs import Card, Rating, Scheduler, State

DESIRED_RETENTION = 0.9

# 模組層級單一實例；FSRS 參數為純函式運算，無狀態，可安全共用
scheduler = Scheduler(
    desired_retention=DESIRED_RETENTION,
    learning_steps=(timedelta(minutes=10), timedelta(minutes=30)),
    relearning_steps=(timedelta(minutes=10),),
)

RATING_BY_VALUE = {r.value: r for r in Rating}


def build_card(row: Any) -> Card:
    """由 srs_cards 的一列組出 fsrs.Card。"""
    return Card(
        state=State(row["state"]),
        step=row["step"],
        stability=row["stability"],
        difficulty=row["difficulty"],
        due=row["due"],
        last_review=row["last_review"],
    )


def review(
    card: Card,
    rating: int,
    *,
    now: Optional[datetime] = None,
    response_ms: Optional[int] = None,
) -> Card:
    """套用一次評分，回傳更新後的 Card（排程數學全部由 py-fsrs 負責）。"""
    if rating not in RATING_BY_VALUE:
        raise ValueError(f"rating must be 1-4, got {rating}")
    updated, _log = scheduler.review_card(
        card,
        RATING_BY_VALUE[rating],
        review_datetime=now or datetime.now(timezone.utc),
        review_duration=response_ms,
    )
    return updated


def retrievability(card: Card, *, now: Optional[datetime] = None) -> float:
    """
    目前想得起來的機率（0-1）。佇列排序用：R 越低代表越接近遺忘，應優先複習。
    """
    return scheduler.get_card_retrievability(
        card, current_datetime=now or datetime.now(timezone.utc)
    )
