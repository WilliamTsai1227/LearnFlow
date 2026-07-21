"""
學習流程步驟機 — 題目自動生成
================================
把一堂課的 course_sentences + course_vocabulary 展開成步驟序列，
題型生成規則見 spec/document/LEARNING_FLOW_SPEC.md §1–2。

以 random.Random(course_id) 作種子，同一課每次產生相同題目。
"""

import random
import re
from typing import Any, Optional

OPTION_IDS = ["a", "b", "c", "d"]

_JP_PUNCT = "、。！？!?…"
_JP_PUNCT_ONLY = set(_JP_PUNCT + "・「」　 ")

BLANK = "＿＿＿"

MAX_LISTEN_QUESTIONS = 5
MAX_APPLY_EXERCISES = 6
MAX_WRITE_EXERCISES = 3
MIN_REORDER_TOKENS = 3
MAX_REORDER_TOKENS_EN = 10
MAX_REORDER_TOKENS_JP = 8


def _mcq_options(rng: random.Random, correct: str, distractors: list[str]) -> tuple[list[dict], str]:
    """組出選項列表與正解 id。干擾項不足時允許少於 4 個選項。"""
    pool = []
    seen = {correct}
    for text in distractors:
        if text and text not in seen:
            pool.append(text)
            seen.add(text)
    picked = pool[:3]
    texts = [correct, *picked]
    rng.shuffle(texts)
    options = [
        {"id": OPTION_IDS[index], "text": text}
        for index, text in enumerate(texts)
    ]
    answer_id = next(option["id"] for option in options if option["text"] == correct)
    return options, answer_id


def _shuffled_differently(rng: random.Random, tokens: list[str]) -> Optional[list[str]]:
    if len(set(tokens)) < 2:
        return None
    for _ in range(10):
        shuffled = tokens[:]
        rng.shuffle(shuffled)
        if shuffled != tokens:
            return shuffled
    return None


def _english_tokens(text: str) -> list[str]:
    return text.split()


def _japanese_chunks(text: str, terms: list[str]) -> list[str]:
    """以本課單字詞組貪婪匹配 + 標點邊界切塊。"""
    usable_terms = sorted(
        {term for term in terms if term and term in text},
        key=len,
        reverse=True,
    )
    chunks: list[str] = []
    buffer = ""
    index = 0
    while index < len(text):
        matched = next(
            (term for term in usable_terms if text.startswith(term, index)),
            None,
        )
        if matched:
            if buffer:
                chunks.append(buffer)
                buffer = ""
            chunks.append(matched)
            index += len(matched)
            continue
        char = text[index]
        buffer += char
        if char in _JP_PUNCT:
            chunks.append(buffer)
            buffer = ""
        index += 1
    if buffer:
        chunks.append(buffer)

    merged: list[str] = []
    for chunk in chunks:
        if merged and all(char in _JP_PUNCT_ONLY for char in chunk):
            merged[-1] += chunk
        else:
            merged.append(chunk)
    return merged


def _find_english_term(sentence_text: str, term: str) -> Optional[re.Match]:
    pattern = r"(?<![A-Za-z])" + re.escape(term) + r"(?![A-Za-z])"
    return re.search(pattern, sentence_text, re.IGNORECASE)


def _mask_sentence(sentence_text: str, term: str, language: str) -> Optional[str]:
    if language == "english":
        match = _find_english_term(sentence_text, term)
        if not match:
            return None
        return sentence_text[: match.start()] + BLANK + sentence_text[match.end():]
    if term in sentence_text:
        return sentence_text.replace(term, BLANK, 1)
    return None


def _cloze_candidates(
    sentences: list[dict],
    vocabulary: list[dict],
    language: str,
) -> list[dict]:
    """回傳可挖空的 (vocab, sentence, masked_text) 組合，每個單字取第一個命中的句子。"""
    candidates = []
    for vocab in vocabulary:
        for sentence in sentences:
            masked = _mask_sentence(sentence["target_text"], vocab["term"], language)
            if masked:
                candidates.append(
                    {"vocab": vocab, "sentence": sentence, "masked_text": masked}
                )
                break
    return candidates


def _build_blind_listen(
    rng: random.Random,
    sentences: list[dict],
    scenario_title: str,
    other_scenario_titles: list[str],
    other_course_translations: list[str],
) -> Optional[dict]:
    audio_urls = [row["audio_url"] for row in sentences if row["audio_url"]]
    quiz = []

    if other_scenario_titles:
        options, answer_id = _mcq_options(rng, scenario_title, other_scenario_titles)
        if len(options) >= 2:
            quiz.append(
                {
                    "kind": "scenario_choice",
                    "prompt": "這段對話最可能發生在什麼情境？",
                    "options": options,
                    "answer_id": answer_id,
                    "item_type": None,
                    "item_id": None,
                }
            )

    if sentences and other_course_translations:
        target = rng.choice(sentences)
        options, answer_id = _mcq_options(
            rng, target["translation"], other_course_translations
        )
        if len(options) >= 2:
            quiz.append(
                {
                    "kind": "sentence_choice",
                    "prompt": "下列哪一句的意思「有」出現在對話中？",
                    "options": options,
                    "answer_id": answer_id,
                    "item_type": "sentence",
                    "item_id": target["id"],
                }
            )

    if not audio_urls:
        return None
    return {"audio_urls": audio_urls, "quiz": quiz}


def _build_listen_check(rng: random.Random, sentences: list[dict]) -> Optional[dict]:
    with_audio = [row for row in sentences if row["audio_url"]]
    if len(with_audio) < 2:
        return None
    picked = rng.sample(with_audio, min(MAX_LISTEN_QUESTIONS, len(with_audio)))
    quiz = []
    for sentence in picked:
        distractors = [
            row["translation"] for row in sentences if row["id"] != sentence["id"]
        ]
        rng.shuffle(distractors)
        options, answer_id = _mcq_options(rng, sentence["translation"], distractors)
        if len(options) < 2:
            continue
        quiz.append(
            {
                "kind": "listen_choice",
                "prompt": "聽音檔，選出正確的意思",
                "audio_url": sentence["audio_url"],
                "options": options,
                "answer_id": answer_id,
                "item_type": "sentence",
                "item_id": sentence["id"],
            }
        )
    if not quiz:
        return None
    return {"quiz": quiz}


def _build_reorder(
    rng: random.Random,
    sentence: dict,
    vocabulary: list[dict],
    language: str,
) -> Optional[dict]:
    if language == "english":
        tokens = _english_tokens(sentence["target_text"])
        max_tokens = MAX_REORDER_TOKENS_EN
    else:
        terms = [row["term"] for row in vocabulary]
        tokens = _japanese_chunks(sentence["target_text"], terms)
        max_tokens = MAX_REORDER_TOKENS_JP

    if not (MIN_REORDER_TOKENS <= len(tokens) <= max_tokens):
        return None
    shuffled = _shuffled_differently(rng, tokens)
    if not shuffled:
        return None
    return {
        "kind": "reorder",
        "prompt": "把詞塊排成正確的句子",
        "tokens": shuffled,
        "answer": tokens,
        "translation": sentence["translation"],
        "audio_url": sentence["audio_url"],
        "item_type": "sentence",
        "item_id": sentence["id"],
    }


def _build_cloze_choice(
    rng: random.Random,
    candidate: dict,
    vocabulary: list[dict],
) -> Optional[dict]:
    vocab = candidate["vocab"]
    distractors = [row["term"] for row in vocabulary if row["id"] != vocab["id"]]
    rng.shuffle(distractors)
    options, answer_id = _mcq_options(rng, vocab["term"], distractors)
    if len(options) < 2:
        return None
    return {
        "kind": "cloze_choice",
        "prompt": "選出正確的詞填入空格",
        "masked_text": candidate["masked_text"],
        "translation": candidate["sentence"]["translation"],
        "options": options,
        "answer_id": answer_id,
        "item_type": "vocabulary",
        "item_id": vocab["id"],
    }


def _build_apply(
    rng: random.Random,
    sentences: list[dict],
    vocabulary: list[dict],
    language: str,
) -> Optional[dict]:
    cloze_pool = _cloze_candidates(sentences, vocabulary, language)
    rng.shuffle(cloze_pool)

    reorder_pool = sentences[:]
    rng.shuffle(reorder_pool)

    exercises: list[dict] = []
    used_sentence_ids: set[str] = set()

    reorder_target = MAX_APPLY_EXERCISES // 2
    for sentence in reorder_pool:
        if len(exercises) >= reorder_target:
            break
        if sentence["id"] in used_sentence_ids:
            continue
        exercise = _build_reorder(rng, sentence, vocabulary, language)
        if exercise:
            exercises.append(exercise)
            used_sentence_ids.add(sentence["id"])

    for candidate in cloze_pool:
        if len(exercises) >= MAX_APPLY_EXERCISES:
            break
        if candidate["sentence"]["id"] in used_sentence_ids:
            continue
        exercise = _build_cloze_choice(rng, candidate, vocabulary)
        if exercise:
            exercises.append(exercise)
            used_sentence_ids.add(candidate["sentence"]["id"])

    # 某類不足時以另一類補滿
    if len(exercises) < MAX_APPLY_EXERCISES:
        for sentence in reorder_pool:
            if len(exercises) >= MAX_APPLY_EXERCISES:
                break
            if sentence["id"] in used_sentence_ids:
                continue
            exercise = _build_reorder(rng, sentence, vocabulary, language)
            if exercise:
                exercises.append(exercise)
                used_sentence_ids.add(sentence["id"])

    if not exercises:
        return None
    rng.shuffle(exercises)
    return {"exercises": exercises}


def _dictation_answers(vocab: dict, language: str) -> list[str]:
    answers = [vocab["term"]]
    reading = vocab.get("reading")
    if language == "japanese" and reading and reading not in answers:
        answers.append(reading)
    return answers


def _build_write(
    rng: random.Random,
    sentences: list[dict],
    vocabulary: list[dict],
    language: str,
) -> Optional[dict]:
    candidates = [
        candidate
        for candidate in _cloze_candidates(sentences, vocabulary, language)
        if candidate["sentence"]["audio_url"]
    ]
    if not candidates:
        return None
    rng.shuffle(candidates)

    exercises = []
    used_sentence_ids: set[str] = set()
    for candidate in candidates:
        if len(exercises) >= MAX_WRITE_EXERCISES:
            break
        if candidate["sentence"]["id"] in used_sentence_ids:
            continue
        vocab = candidate["vocab"]
        exercises.append(
            {
                "kind": "dictation",
                "prompt": "聽音檔，把缺少的詞打出來",
                "masked_text": candidate["masked_text"],
                "translation": candidate["sentence"]["translation"],
                "audio_url": candidate["sentence"]["audio_url"],
                "answers": _dictation_answers(vocab, language),
                "item_type": "vocabulary",
                "item_id": vocab["id"],
            }
        )
        used_sentence_ids.add(candidate["sentence"]["id"])

    if not exercises:
        return None
    return {"exercises": exercises}


def build_lesson_steps(
    course: dict,
    scenario_title: str,
    sentences: list[dict],
    vocabulary: list[dict],
    language: str,
    other_scenario_titles: list[str],
    other_course_translations: list[str],
) -> list[dict[str, Any]]:
    rng = random.Random(course["id"])

    steps: list[dict[str, Any]] = [
        {
            "type": "mission",
            "title": "情境任務",
            "data": {
                "scenario_title": scenario_title,
                "story": course["description"],
                "objectives": {
                    "sentence_count": len(sentences),
                    "vocabulary_count": len(vocabulary),
                    "estimated_minutes": course["estimated_minutes"],
                },
            },
        }
    ]

    if vocabulary:
        steps.append(
            {
                "type": "vocab_preview",
                "title": "單字預習",
                "data": {"vocabulary_count": len(vocabulary)},
            }
        )

    blind_listen = _build_blind_listen(
        rng, sentences, scenario_title, other_scenario_titles, other_course_translations
    )
    if blind_listen:
        steps.append({"type": "blind_listen", "title": "盲聽", "data": blind_listen})

    steps.append({"type": "sentence_study", "title": "逐句理解", "data": {}})

    listen_check = _build_listen_check(rng, sentences)
    if listen_check:
        steps.append({"type": "listen_check", "title": "聽力驗證", "data": listen_check})

    shadowing_ids = [row["id"] for row in sentences if row["audio_url"]]
    if shadowing_ids:
        steps.append(
            {
                "type": "shadowing",
                "title": "跟讀",
                "data": {"sentence_ids": shadowing_ids},
            }
        )

    apply_step = _build_apply(rng, sentences, vocabulary, language)
    if apply_step:
        steps.append({"type": "apply", "title": "靈活應用", "data": apply_step})

    write_step = _build_write(rng, sentences, vocabulary, language)
    if write_step:
        steps.append({"type": "write", "title": "寫", "data": write_step})

    steps.append({"type": "result", "title": "完成", "data": {}})

    for index, step in enumerate(steps):
        step["step_index"] = index
    return steps
