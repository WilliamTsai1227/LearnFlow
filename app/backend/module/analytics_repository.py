"""
進度分析 Repository — 懶人追蹤 + 深度數據
=========================================
全自動彙整，使用者零手動輸入。資料來源：
  - srs_cards：卡片狀態、單字量成長、到期
  - srs_reviews：每日複習量（熱力圖）、記憶保留率、評分分佈、連續天數
  - captures：YouTube 收藏數
  - practice_attempts：情境課程作答數（既有學習流程）
"""

from datetime import date, timedelta
from uuid import UUID

import asyncpg


async def overview(conn: asyncpg.Connection, user_id: UUID) -> dict:
    # ── 卡片狀態 / 到期 / 收藏數 ──
    cards = await conn.fetchrow(
        """
        SELECT
            count(*) FILTER (WHERE state = 0)              AS new,
            count(*) FILTER (WHERE state = 1)              AS learning,
            count(*) FILTER (WHERE state = 2)              AS review,
            count(*) FILTER (WHERE state = 3)              AS relearning,
            count(*)                                       AS total,
            count(*) FILTER (WHERE due <= now())           AS due_today
        FROM srs_cards WHERE user_id = $1
        """,
        user_id,
    )
    captures_total = await conn.fetchval(
        "SELECT count(*) FROM captures WHERE user_id = $1", user_id
    )

    # ── 複習量 / 保留率 / 評分分佈（近 30 天）──
    reviews = await conn.fetchrow(
        """
        SELECT
            count(*)                                                         AS total,
            count(*) FILTER (WHERE reviewed_at >= date_trunc('day', now()))  AS today,
            count(*) FILTER (WHERE rating = 1 AND reviewed_at >= now() - interval '30 days') AS again30,
            count(*) FILTER (WHERE rating = 2 AND reviewed_at >= now() - interval '30 days') AS hard30,
            count(*) FILTER (WHERE rating = 3 AND reviewed_at >= now() - interval '30 days') AS good30,
            count(*) FILTER (WHERE rating = 4 AND reviewed_at >= now() - interval '30 days') AS easy30
        FROM srs_reviews WHERE user_id = $1
        """,
        user_id,
    )
    again, hard, good, easy = (
        reviews["again30"],
        reviews["hard30"],
        reviews["good30"],
        reviews["easy30"],
    )
    graded30 = again + hard + good + easy
    # 真實保留率：非 Again（記得起來）佔比
    retention = round((graded30 - again) / graded30, 3) if graded30 else None

    # ── 每日複習熱力圖（近 120 天）──
    heat_rows = await conn.fetch(
        """
        SELECT to_char(date_trunc('day', reviewed_at), 'YYYY-MM-DD') AS day, count(*) AS count
        FROM srs_reviews
        WHERE user_id = $1 AND reviewed_at >= now() - interval '120 days'
        GROUP BY 1 ORDER BY 1
        """,
        user_id,
    )
    daily_reviews = [{"date": r["day"], "count": r["count"]} for r in heat_rows]

    # ── 單字量成長（srs 卡片建立累計）──
    growth_rows = await conn.fetch(
        """
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*) AS count
        FROM srs_cards WHERE user_id = $1
        GROUP BY 1 ORDER BY 1
        """,
        user_id,
    )
    running = 0
    vocab_growth = []
    for r in growth_rows:
        running += r["count"]
        vocab_growth.append({"date": r["day"], "cumulative": running})

    # ── 連續學習天數（有複習的日子）──
    day_rows = await conn.fetch(
        "SELECT DISTINCT (reviewed_at AT TIME ZONE 'UTC')::date AS d FROM srs_reviews WHERE user_id = $1",
        user_id,
    )
    review_days = {r["d"] for r in day_rows}
    streak = 0
    cursor = date.today()
    # 今天沒複習也允許從昨天起算（避免早上顯示 0）
    if cursor not in review_days and (cursor - timedelta(days=1)) in review_days:
        cursor = cursor - timedelta(days=1)
    while cursor in review_days:
        streak += 1
        cursor -= timedelta(days=1)

    # ── 情境課程作答（既有學習流程）──
    lessons = await conn.fetchrow(
        """
        SELECT count(*) AS total, count(*) FILTER (WHERE is_correct) AS correct
        FROM practice_attempts WHERE user_id = $1
        """,
        user_id,
    )

    return {
        "kpis": {
            "due_today": cards["due_today"],
            "total_cards": cards["total"],
            "known_cards": cards["review"],
            "captures_total": captures_total,
            "reviews_total": reviews["total"],
            "reviews_today": reviews["today"],
            "streak_days": streak,
            "retention": retention,
        },
        "cards_by_state": {
            "new": cards["new"],
            "learning": cards["learning"],
            "review": cards["review"],
            "relearning": cards["relearning"],
        },
        "rating_breakdown": {"again": again, "hard": hard, "good": good, "easy": easy},
        "daily_reviews": daily_reviews,
        "vocab_growth": vocab_growth,
        "lesson_attempts": {
            "total": lessons["total"],
            "correct": lessons["correct"],
        },
    }
