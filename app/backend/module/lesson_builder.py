"""
學習流程步驟機 — 題目自動生成
================================
把一堂課的 course_sentences + course_vocabulary 展開成步驟序列，
題型生成規則見 spec/document/LEARNING_FLOW_SPEC.md §1–2。

每次呼叫都重新隨機出題（不再以 course_id 作固定種子），
讓使用者重複練習同一課時仍需思考，而不是憑記憶直接選答案。
答案、選項與音檔都在同一次生成中一併決定，因此隨機化不會破壞配對正確性。
"""

import random
import re
from typing import Any, Optional

OPTION_IDS = ["a", "b", "c", "d"]

_JP_PUNCT = "、。！？!?…"
_JP_PUNCT_ONLY = set(_JP_PUNCT + "・「」　 ")

BLANK = "＿＿＿"

MAX_LISTEN_QUESTIONS = 5
# 靈活應用：詞塊重組對記憶的幫助最大，因此題數拉高並以重組題為主
MAX_APPLY_EXERCISES = 8
APPLY_REORDER_TARGET = 5
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


# 高頻詞：整個詞組都由這些字組成時，挖空幾乎不用想就填得出來
# （例如 "super sweet"、"how much"、"for me"），練習價值低。
_COMMON_EN = {
    "a", "an", "the", "and", "or", "but", "so", "if", "as", "than", "too", "also",
    "of", "to", "in", "on", "at", "by", "for", "with", "from", "about", "into",
    "up", "down", "out", "off", "over", "under", "top", "back", "here", "there",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "its", "our", "their", "this", "that", "these", "those",
    "am", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "done",
    "will", "would", "can", "could", "should", "shall", "may", "might", "must",
    "what", "which", "who", "when", "where", "why", "how",
    "all", "any", "some", "every", "each", "other", "same", "own", "both",
    "no", "not", "yes", "yeah", "ok", "okay", "sure", "please", "thanks", "thank",
    "very", "really", "just", "only", "even", "still", "again", "ever", "never",
    "always", "often", "now", "then", "well", "right", "much", "many", "more",
    "less", "most", "least", "one", "two", "first", "last", "next", "new", "old",
    "good", "bad", "nice", "great", "fine", "big", "small", "long", "short",
    "sweet", "hot", "cold", "warm", "cool", "super", "pretty", "thing", "things",
    "get", "got", "go", "going", "take", "make", "want", "like", "need", "try",
    "know", "think", "see", "look", "come", "give", "say", "tell", "let", "put",
    "you'd", "i'll", "i'd", "it's", "that's", "what's", "don't", "doesn't",
}

# 日文高頻詞（全部由這些構成的詞組同樣太好填）
_COMMON_JP = {
    "これ", "それ", "あれ", "この", "その", "あの", "ここ", "そこ", "あそこ",
    "です", "ます", "ある", "いる", "する", "なる", "こと", "もの", "とても",
    "すごく", "ちょっと", "はい", "いいえ", "そう", "どう", "なに", "なん",
}


def _blank_difficulty(term: str, language: str) -> int:
    """
    挖空難度評分：分數越高＝越值得拿來當聽寫題。
    目的是避免挖出 "super sweet" 這種一看就會的常見修飾語，
    優先挖 "vanilla latte"、"cut the syrup" 這類有實質詞彙價值的內容詞。
    """
    term = (term or "").strip()
    if not term:
        return 0

    if language == "english":
        words = [w.strip(".,!?;:'\"").lower() for w in term.split()]
        words = [w for w in words if w]
        if not words:
            return 0
        content = [w for w in words if w not in _COMMON_EN]
        if not content:
            return 0  # 全部都是高頻詞 → 最不值得挖
        # 有內容詞就大幅加分，再依最長內容詞的長度細分
        return 10 + max(len(w) for w in content)

    # 日文：含漢字或片假名（外來語）通常是實詞，比純平假名更值得挖
    has_kanji = any("一" <= ch <= "鿿" for ch in term)
    has_katakana = any("゠" <= ch <= "ヿ" for ch in term)
    if term in _COMMON_JP:
        return 0
    score = 0
    if has_kanji:
        score += 12
    if has_katakana:
        score += 10
    if score == 0:
        return max(0, len(term) - 2)  # 純平假名：只用長度稍微區分
    return score + len(term)


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
    sibling_course_translations: Optional[list[str]] = None,
) -> Optional[dict]:
    """
    盲聽測驗：全部都是「內容理解題」，不再出「這段對話發生在什麼情境？」
    ——後者用課程標題就能猜到，測不到聽力。

    干擾項優先取自**同情境的其他課程**（語境同樣合理，無法用主題排除），
    同情境素材不足時才退回其他情境。

    題型：
      1-2. 正向：哪一句的意思「有」出現在對話中
      3.   反向：哪一句的意思「沒有」出現（三個選項是本課真實句子，較難）
    """
    audio_urls = [row["audio_url"] for row in sentences if row["audio_url"]]
    quiz: list[dict] = []

    # 干擾項池：同情境優先，其次其他情境
    distractor_pool = [t for t in (sibling_course_translations or []) if t]
    distractor_pool += [t for t in other_course_translations if t not in distractor_pool]

    own_translations = {row["translation"] for row in sentences if row.get("translation")}
    # 干擾項不能是本課自己的句子（否則會有兩個正解）
    distractor_pool = [t for t in distractor_pool if t not in own_translations]

    if sentences and distractor_pool:
        # ── 正向題 ×2（不同目標句）──
        targets = rng.sample(sentences, min(2, len(sentences)))
        used_distractors: set[str] = set()
        for target in targets:
            if not target.get("translation"):
                continue
            available = [t for t in distractor_pool if t not in used_distractors]
            if len(available) < 1:
                available = distractor_pool
            rng.shuffle(available)
            options, answer_id = _mcq_options(rng, target["translation"], available)
            if len(options) >= 2:
                used_distractors.update(
                    o["text"] for o in options if o["text"] != target["translation"]
                )
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

        # ── 反向題 ×1：正解是「沒出現」的那句，干擾項是本課真實句子 ──
        real_options = [
            row["translation"] for row in sentences if row.get("translation")
        ]
        if len(real_options) >= 3 and distractor_pool:
            foreign = rng.choice(distractor_pool)
            picked_real = rng.sample(real_options, 3)
            options, answer_id = _mcq_options(rng, foreign, picked_real)
            if len(options) >= 3:
                quiz.append(
                    {
                        "kind": "sentence_absent_choice",
                        "prompt": "下列哪一句的意思「沒有」出現在對話中？",
                        "options": options,
                        "answer_id": answer_id,
                        "item_type": None,
                        "item_id": None,
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
    exclude_sentence_ids: Optional[set[str]] = None,
) -> Optional[dict]:
    """
    靈活應用。
    exclude_sentence_ids：「寫」步驟已用掉的句子（先生成），這裡要避開，
    避免同一句在兩關重複出現（已經排過一次再拿來聽寫，練習價值很低）。
    """
    excluded = exclude_sentence_ids or set()

    cloze_pool = [
        c for c in _cloze_candidates(sentences, vocabulary, language)
        if c["sentence"]["id"] not in excluded
    ]
    rng.shuffle(cloze_pool)

    reorder_pool = [s for s in sentences if s["id"] not in excluded]
    rng.shuffle(reorder_pool)

    exercises: list[dict] = []
    used_sentence_ids: set[str] = set()

    # 重組題優先且佔多數
    for sentence in reorder_pool:
        if len(exercises) >= APPLY_REORDER_TARGET:
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
    exclude_sentence_ids: Optional[set[str]] = None,
) -> tuple[Optional[dict], set[str]]:
    """
    寫（聽寫填空）。回傳 (步驟資料, 用掉的句子 id)。

    **先於靈活應用生成**，好讓最後一關優先拿到最值得練的難詞
    （挖空難度見 `_blank_difficulty`）；靈活應用再避開這些句子。
    exclude_sentence_ids：若有指定則優先避開，湊不滿題數時才允許重複。
    """
    candidates = [
        candidate
        for candidate in _cloze_candidates(sentences, vocabulary, language)
        if candidate["sentence"]["audio_url"]
    ]
    if not candidates:
        return None

    # 難度優先，但仍保留隨機性：
    #   1. 先剔除「整組都是高頻詞」的候選（例如 "super sweet"、"how much"），太好填
    #   2. 依難度取出約 3 倍題數的「難詞池」
    #   3. 在池中隨機挑題 → 每次重練題目仍會變，但不會退回簡單詞
    # （若一律取分數最高的前 N 名，題目會完全固定，失去重複練習的意義。）
    scored = [
        (c, _blank_difficulty(c["vocab"]["term"], language)) for c in candidates
    ]
    meaningful = [c for c, s in scored if s > 0] or [c for c, _ in scored]
    meaningful.sort(
        key=lambda c: _blank_difficulty(c["vocab"]["term"], language), reverse=True
    )
    hard_pool = meaningful[: max(MAX_WRITE_EXERCISES * 3, MAX_WRITE_EXERCISES)]
    rng.shuffle(hard_pool)
    candidates = hard_pool + [c for c in meaningful if c not in hard_pool]

    excluded = exclude_sentence_ids or set()
    fresh = [c for c in candidates if c["sentence"]["id"] not in excluded]
    reused = [c for c in candidates if c["sentence"]["id"] in excluded]

    exercises = []
    used_sentence_ids: set[str] = set()
    # 先用沒在靈活應用出現過的句子，不夠才回頭用重複的
    for candidate in fresh + reused:
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
        return None, set()
    return {"exercises": exercises}, used_sentence_ids


def build_lesson_steps(
    course: dict,
    scenario_title: str,
    sentences: list[dict],
    vocabulary: list[dict],
    language: str,
    other_scenario_titles: list[str],
    other_course_translations: list[str],
    sibling_course_translations: Optional[list[str]] = None,
) -> list[dict[str, Any]]:
    # 每次載入課程都重新隨機出題：同一課重複練習時不會因為「背過答案」
    # 而失去思考機會。答案與音檔都由同一份題目資料一起產生，隨機化不影響配對正確性。
    rng = random.Random()

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
        rng,
        sentences,
        scenario_title,
        other_scenario_titles,
        other_course_translations,
        sibling_course_translations,
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

    # 注意生成順序與顯示順序相反：「寫」先挑，才能優先拿到最值得練的難詞
    # （靈活應用素材較多，讓它避開這幾句仍綽綽有餘）。
    write_step, write_used_sentence_ids = _build_write(rng, sentences, vocabulary, language)

    apply_step = _build_apply(
        rng, sentences, vocabulary, language, exclude_sentence_ids=write_used_sentence_ids
    )
    if apply_step:
        steps.append({"type": "apply", "title": "靈活應用", "data": apply_step})
    if write_step:
        steps.append({"type": "write", "title": "寫", "data": write_step})

    steps.append({"type": "result", "title": "完成", "data": {}})

    for index, step in enumerate(steps):
        step["step_index"] = index
    return steps
