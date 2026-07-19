#!/usr/bin/env python3
"""
從 PostgreSQL 讀取 course_sentences / course_vocabulary，
以 edge-tts（微軟 Edge 類神經語音，免費、免金鑰）產生 MP3 寫入本地
app/frontend/audio/，路徑與 DB 的 audio_url 完全一致。

開發用替代方案；正式上線請用 generate_audio.py（Google TTS → S3）。
兩者產出的檔案路徑相同，可無縫切換。

用法：
  cd script
  pip install edge-tts psycopg2-binary python-dotenv

  python generate_audio_local.py --dry-run     # 預覽
  python generate_audio_local.py               # 只補缺少的檔
  python generate_audio_local.py --force       # 全部重產
  python generate_audio_local.py --limit 50    # 只處理前 N 筆（試聽用）
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

try:
    import edge_tts
except ImportError:
    print("缺少 edge-tts，請先：pip install edge-tts", file=sys.stderr)
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
DEFAULT_OUT_DIR = PROJECT_ROOT / "app" / "frontend"

# 與 generate_audio.py 相同的查詢
AUDIO_QUERY = """
SELECT
    s.language::text AS language,
    'sentence'::text AS source_type,
    cs.id AS item_id,
    cs.target_text AS text,
    cs.audio_url AS audio_url
FROM course_sentences cs
JOIN courses c ON c.id = cs.course_id
JOIN scenarios s ON s.id = c.scenario_id
WHERE s.language IN ('english', 'japanese')
  AND s.is_published = true
  AND cs.audio_url IS NOT NULL
  AND TRIM(cs.audio_url) <> ''
  AND TRIM(cs.target_text) <> ''

UNION ALL

SELECT
    s.language::text AS language,
    'vocabulary'::text AS source_type,
    cv.id AS item_id,
    cv.term AS text,
    cv.audio_url AS audio_url
FROM course_vocabulary cv
JOIN courses c ON c.id = cv.course_id
JOIN scenarios s ON s.id = c.scenario_id
WHERE s.language IN ('english', 'japanese')
  AND s.is_published = true
  AND cv.audio_url IS NOT NULL
  AND TRIM(cv.audio_url) <> ''
  AND TRIM(cv.term) <> ''

ORDER BY audio_url
"""

VOICES = {
    "japanese": os.getenv("EDGE_TTS_VOICE_JA", "ja-JP-NanamiNeural"),
    "english": os.getenv("EDGE_TTS_VOICE_EN", "en-US-JennyNeural"),
}
# 學習用略慢語速
RATE = os.getenv("EDGE_TTS_RATE", "-10%")

CONCURRENCY = int(os.getenv("EDGE_TTS_CONCURRENCY", "6"))
MAX_RETRIES = 3


@dataclass
class AudioJob:
    language: str
    source_type: str
    item_id: str
    text: str
    audio_url: str

    def local_path(self, out_dir: Path) -> Path:
        return out_dir / self.audio_url.strip().lstrip("/")


def fetch_jobs(database_url: str) -> list[AudioJob]:
    with psycopg2.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(AUDIO_QUERY)
            rows = cur.fetchall()

    jobs: list[AudioJob] = []
    seen: set[str] = set()
    for language, source_type, item_id, text, audio_url in rows:
        key = audio_url.strip()
        if key in seen:
            continue
        # 跳過沒有任何字母/假名/漢字的項目（例如種子資料中 term 為「!」），TTS 唸不出來
        if not re.search(r"[A-Za-z぀-ヿ一-鿿]", text):
            print(f"SKIP  {key}（純標點，無法發音：{text!r}）")
            continue
        seen.add(key)
        jobs.append(
            AudioJob(
                language=language,
                source_type=source_type,
                item_id=item_id,
                text=text.strip(),
                audio_url=key,
            )
        )
    return jobs


async def synthesize(job: AudioJob, path: Path) -> None:
    voice = VOICES[job.language]
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            communicate = edge_tts.Communicate(job.text, voice, rate=RATE)
            tmp = path.with_suffix(".tmp")
            path.parent.mkdir(parents=True, exist_ok=True)
            await communicate.save(str(tmp))
            if tmp.stat().st_size == 0:
                raise RuntimeError("empty file")
            tmp.rename(path)
            return
        except Exception as exc:  # noqa: BLE001 — 重試後才放棄
            last_error = exc
            await asyncio.sleep(1.5 * attempt)
    raise RuntimeError(f"TTS failed after {MAX_RETRIES} retries: {last_error}")


async def run_async(jobs: list[AudioJob], out_dir: Path, force: bool) -> tuple[int, int, int]:
    semaphore = asyncio.Semaphore(CONCURRENCY)
    created = skipped = failed = 0
    lock = asyncio.Lock()
    total = len(jobs)

    async def worker(index: int, job: AudioJob) -> None:
        nonlocal created, skipped, failed
        path = job.local_path(out_dir)
        if not force and path.is_file() and path.stat().st_size > 0:
            async with lock:
                skipped += 1
            return
        async with semaphore:
            try:
                await synthesize(job, path)
                async with lock:
                    created += 1
                    done = created + skipped + failed
                    if created % 50 == 0 or done == total:
                        print(f"[{done}/{total}] 已生成 {created}、跳過 {skipped}、失敗 {failed}")
            except Exception as exc:  # noqa: BLE001 — 批次繼續
                async with lock:
                    failed += 1
                print(f"FAIL  {job.audio_url}: {exc}", file=sys.stderr)

    await asyncio.gather(*(worker(i, job) for i, job in enumerate(jobs)))
    return created, skipped, failed


def main() -> None:
    parser = argparse.ArgumentParser(description="edge-tts 批次產生 MP3 到本地 frontend")
    parser.add_argument("--force", action="store_true", help="即使檔案已存在也重產")
    parser.add_argument("--dry-run", action="store_true", help="只列出將處理的項目")
    parser.add_argument("--limit", type=int, default=0, help="只處理前 N 筆（0 = 全部）")
    parser.add_argument(
        "--out-dir",
        default=str(DEFAULT_OUT_DIR),
        help="輸出根目錄（預設 app/frontend，會在其下建立 audio/...）",
    )
    args = parser.parse_args()

    load_dotenv(SCRIPT_DIR / ".env")
    load_dotenv(PROJECT_ROOT / ".env")
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("缺少 DATABASE_URL（script/.env 或專案根目錄 .env）", file=sys.stderr)
        sys.exit(1)

    jobs = fetch_jobs(database_url)
    if args.limit:
        jobs = jobs[: args.limit]
    if not jobs:
        print("資料庫沒有需要處理的句子或單字（確認 SQL 種子已寫入）。")
        return

    out_dir = Path(args.out_dir).resolve()
    print(f"共 {len(jobs)} 筆 audio 任務 → {out_dir}/audio/…")
    print(f"語音：ja={VOICES['japanese']}  en={VOICES['english']}  rate={RATE}  併發={CONCURRENCY}")

    if args.dry_run:
        for job in jobs[:20]:
            print(f"[DRY-RUN] {job.language:8} {job.source_type:10} {job.audio_url}")
            print(f"          text: {job.text[:60]}{'...' if len(job.text) > 60 else ''}")
        if len(jobs) > 20:
            print(f"…及其餘 {len(jobs) - 20} 筆")
        return

    created, skipped, failed = asyncio.run(run_async(jobs, out_dir, args.force))
    print("")
    print(f"完成：新增/更新 {created}，跳過 {skipped}，失敗 {failed}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
