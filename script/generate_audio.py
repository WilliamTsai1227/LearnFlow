#!/usr/bin/env python3
"""
從 PostgreSQL 讀取 course_sentences / course_vocabulary，
以 Google Cloud TTS 產生 MP3 並上傳 S3。

audio_url 維持策略 A（相對路徑），S3 object key 與 DB 一致，例如：
  audio/english/en-cafe/en-cafe-l01/s01.mp3

用法：
  cd script
  python3 -m venv .venv && source .venv/bin/activate
  pip install -r requirements.txt
  cp .env.example .env   # 填好環境變數

  python generate_audio.py              # 只處理 S3 上還沒有的檔
  python generate_audio.py --dry-run    # 預覽
  python generate_audio.py --force      # 全部重產並覆蓋
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import boto3
import psycopg2
from botocore.exceptions import ClientError
from dotenv import load_dotenv
from google.cloud import texttospeech

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent

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


@dataclass
class AudioJob:
    language: str
    source_type: str
    item_id: str
    text: str
    audio_url: str

    @property
    def s3_key(self) -> str:
        key = self.audio_url.strip().lstrip("/")
        prefix = os.getenv("S3_PREFIX", "").strip().strip("/")
        if prefix:
            return f"{prefix}/{key}"
        return key

    @property
    def local_path(self) -> Path | None:
        base = os.getenv("LOCAL_AUDIO_DIR", "").strip()
        if not base:
            return None
        path = Path(base)
        if not path.is_absolute():
            path = (SCRIPT_DIR / path).resolve()
        return path / self.s3_key


def load_config() -> None:
    load_dotenv(SCRIPT_DIR / ".env")

    required = [
        "DATABASE_URL",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
        "S3_BUCKET",
    ]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        print("缺少必要環境變數：", ", ".join(missing), file=sys.stderr)
        print("請參考 script/.env.example", file=sys.stderr)
        sys.exit(1)

    creds = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "")
    if not Path(creds).is_file():
        print(f"找不到 Google 金鑰檔：{creds}", file=sys.stderr)
        sys.exit(1)


def fetch_jobs(database_url: str) -> list[AudioJob]:
    with psycopg2.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(AUDIO_QUERY)
            rows = cur.fetchall()

    jobs: list[AudioJob] = []
    seen_keys: set[str] = set()
    for language, source_type, item_id, text, audio_url in rows:
        job = AudioJob(
            language=language,
            source_type=source_type,
            item_id=item_id,
            text=text.strip(),
            audio_url=audio_url.strip(),
        )
        if job.s3_key in seen_keys:
            continue
        seen_keys.add(job.s3_key)
        jobs.append(job)
    return jobs


def voice_for_language(language: str) -> texttospeech.VoiceSelectionParams:
    if language == "japanese":
        return texttospeech.VoiceSelectionParams(
            language_code="ja-JP",
            name=os.getenv("GOOGLE_TTS_VOICE_JA", "ja-JP-Neural2-B"),
        )
    if language == "english":
        return texttospeech.VoiceSelectionParams(
            language_code="en-US",
            name=os.getenv("GOOGLE_TTS_VOICE_EN", "en-US-Neural2-J"),
        )
    raise ValueError(f"Unsupported language: {language}")


def synthesize_mp3(client: texttospeech.TextToSpeechClient, job: AudioJob) -> bytes:
    speaking_rate = float(os.getenv("GOOGLE_TTS_SPEAKING_RATE", "0.9"))
    response = client.synthesize_speech(
        input=texttospeech.SynthesisInput(text=job.text),
        voice=voice_for_language(job.language),
        audio_config=texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
            speaking_rate=speaking_rate,
        ),
    )
    return response.audio_content


def s3_object_exists(s3_client, bucket: str, key: str) -> bool:
    try:
        s3_client.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def upload_to_s3(s3_client, bucket: str, key: str, data: bytes) -> None:
    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=data,
        ContentType="audio/mpeg",
        CacheControl="public, max-age=31536000, immutable",
    )


def write_local_copy(job: AudioJob, data: bytes) -> None:
    local_path = job.local_path
    if local_path is None:
        return
    local_path.parent.mkdir(parents=True, exist_ok=True)
    local_path.write_bytes(data)


def run(force: bool, dry_run: bool) -> int:
    load_config()

    database_url = os.environ["DATABASE_URL"]
    bucket = os.environ["S3_BUCKET"]

    jobs = fetch_jobs(database_url)
    if not jobs:
        print("資料庫沒有需要處理的句子或單字（確認 SQL 種子已寫入）。")
        return 0

    print(f"共 {len(jobs)} 筆 audio 任務（english + japanese）")

    if dry_run:
        for job in jobs:
            print(f"[DRY-RUN] {job.language:8} {job.source_type:10} {job.s3_key}")
            print(f"          text: {job.text[:60]}{'...' if len(job.text) > 60 else ''}")
        return 0

    tts_client = texttospeech.TextToSpeechClient()
    s3_client = boto3.client(
        "s3",
        region_name=os.environ["AWS_REGION"],
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )

    created = 0
    skipped = 0
    failed = 0

    for index, job in enumerate(jobs, start=1):
        label = f"[{index}/{len(jobs)}] {job.s3_key}"
        try:
            if not force and s3_object_exists(s3_client, bucket, job.s3_key):
                print(f"SKIP  {label}（S3 已存在）")
                skipped += 1
                continue

            print(f"WORK  {label}")
            print(f"      {job.source_type} / {job.item_id} / {job.text[:80]}")

            mp3_bytes = synthesize_mp3(tts_client, job)
            upload_to_s3(s3_client, bucket, job.s3_key, mp3_bytes)
            write_local_copy(job, mp3_bytes)
            created += 1
        except Exception as exc:  # noqa: BLE001 — batch job continues on single failure
            print(f"FAIL  {label}: {exc}", file=sys.stderr)
            failed += 1

    print("")
    print(f"完成：新增/更新 {created}，跳過 {skipped}，失敗 {failed}")
    return 1 if failed else 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Google TTS 批次產生 MP3 並上傳 S3")
    parser.add_argument(
        "--force",
        action="store_true",
        help="即使 S3 已有檔案也重新產生並覆蓋",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只列出將處理的項目，不呼叫 TTS 也不上傳",
    )
    args = parser.parse_args()
    raise SystemExit(run(force=args.force, dry_run=args.dry_run))


if __name__ == "__main__":
    main()
