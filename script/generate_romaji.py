#!/usr/bin/env python3
"""
為所有日文 course_sentences / course_vocabulary 產生羅馬拼音（romaji），
寫入 DB 的 romaji 欄位。使用 cutlet（fugashi + unidic-lite，Hepburn 式），
能正確處理助詞（は→wa）、分詞與大小寫。

英文內容不處理，romaji 維持 NULL。

用法：
  pip install cutlet unidic-lite psycopg2-binary python-dotenv
  export DATABASE_URL=postgresql://learnflow:learnflow_dev@127.0.0.1:5433/learnflow

  python script/generate_romaji.py --dry-run   # 預覽前幾筆
  python script/generate_romaji.py             # 只補 romaji 為空的
  python script/generate_romaji.py --force      # 全部重算並覆蓋
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

try:
    import cutlet
except ImportError:
    print("缺少 cutlet，請先：pip install cutlet unidic-lite", file=sys.stderr)
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent

SELECT_SQL = {
    "sentence": """
        SELECT cs.id, cs.target_text
        FROM course_sentences cs
        JOIN courses c ON c.id = cs.course_id
        JOIN scenarios s ON s.id = c.scenario_id
        WHERE s.language = 'japanese'
          AND TRIM(cs.target_text) <> ''
          {only_missing}
        ORDER BY cs.id
    """,
    "vocabulary": """
        SELECT cv.id, cv.term
        FROM course_vocabulary cv
        JOIN courses c ON c.id = cv.course_id
        JOIN scenarios s ON s.id = c.scenario_id
        WHERE s.language = 'japanese'
          AND TRIM(cv.term) <> ''
          {only_missing}
        ORDER BY cv.id
    """,
}
UPDATE_SQL = {
    "sentence": "UPDATE course_sentences SET romaji = %s WHERE id = %s",
    "vocabulary": "UPDATE course_vocabulary SET romaji = %s WHERE id = %s",
}


def build_romanizer() -> "cutlet.Cutlet":
    katsu = cutlet.Cutlet()
    katsu.use_foreign_spelling = False  # カタカナ外來語轉羅馬拼音而非還原英文
    return katsu


def run(force: bool, dry_run: bool) -> int:
    load_dotenv(SCRIPT_DIR / ".env")
    load_dotenv(PROJECT_ROOT / ".env")
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("缺少 DATABASE_URL（script/.env 或專案根目錄 .env）", file=sys.stderr)
        return 1

    katsu = build_romanizer()
    only_missing = "" if force else "AND (cs.romaji IS NULL OR TRIM(cs.romaji) = '')"
    only_missing_v = "" if force else "AND (cv.romaji IS NULL OR TRIM(cv.romaji) = '')"

    total_updated = 0
    with psycopg2.connect(database_url) as conn:
        for kind in ("sentence", "vocabulary"):
            miss = only_missing if kind == "sentence" else only_missing_v
            with conn.cursor() as cur:
                cur.execute(SELECT_SQL[kind].format(only_missing=miss))
                rows = cur.fetchall()

            print(f"[{kind}] 待處理 {len(rows)} 筆")
            if dry_run:
                for item_id, text in rows[:10]:
                    print(f"  {item_id}: {text}  →  {katsu.romaji(text)}")
                if len(rows) > 10:
                    print(f"  …及其餘 {len(rows) - 10} 筆")
                continue

            updates = [(katsu.romaji(text).strip(), item_id) for item_id, text in rows]
            with conn.cursor() as cur:
                cur.executemany(UPDATE_SQL[kind], updates)
            conn.commit()
            total_updated += len(updates)
            print(f"[{kind}] 已更新 {len(updates)} 筆")

    if not dry_run:
        print(f"\n完成：共更新 {total_updated} 筆 romaji")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="cutlet 產生日文羅馬拼音寫入 DB")
    parser.add_argument("--force", action="store_true", help="全部重算並覆蓋既有 romaji")
    parser.add_argument("--dry-run", action="store_true", help="只預覽前幾筆，不寫入")
    args = parser.parse_args()
    raise SystemExit(run(force=args.force, dry_run=args.dry_run))


if __name__ == "__main__":
    main()
