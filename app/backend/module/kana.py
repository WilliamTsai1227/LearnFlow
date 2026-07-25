"""
假名 → 羅馬拼音（Hepburn 式，純本地、無外部相依）
=================================================
用於免費翻譯流程：Jisho 提供日文單字的假名讀音，這裡把假名轉為羅馬拼音。
支援平假名/片假名、濁音・半濁音、拗音（きゃ/しゃ…）、促音（っ）、長音（ー）。
罕見組合可能不完美，作為輔助顯示已足夠。
"""

from __future__ import annotations

# 基本音（平假名）
_BASE = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "ゐ": "wi", "ゑ": "we", "を": "o", "ん": "n",
    "ゔ": "vu",
}

# 拗音的 i 段假名
_I_ROW = {
    "き": "ki", "ぎ": "gi", "し": "shi", "じ": "ji", "ち": "chi", "ぢ": "ji",
    "に": "ni", "ひ": "hi", "び": "bi", "ぴ": "pi", "み": "mi", "り": "ri",
}
_SMALL_Y = {"ゃ": "a", "ゅ": "u", "ょ": "o"}
_SMALL_VOWEL = {"ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o"}
_SMALL_TSU = "っ"
_LONG = "ー"
_VOWELS = set("aiueo")


def _kata_to_hira(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch)
        # 片假名 U+30A1–U+30F6 → 平假名（減 0x60）
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def kana_to_romaji(text: str) -> str:
    if not text:
        return ""
    s = _kata_to_hira(text)
    result: list[str] = []
    pending_sokuon = False
    i = 0
    n = len(s)

    def emit(rom: str) -> None:
        nonlocal pending_sokuon
        if pending_sokuon and rom:
            first = rom[0]
            result.append("t" if rom.startswith("ch") else first)
            pending_sokuon = False
        result.append(rom)

    while i < n:
        ch = s[i]
        nxt = s[i + 1] if i + 1 < n else ""

        if ch == _SMALL_TSU:
            pending_sokuon = True
            i += 1
            continue

        if ch == _LONG:
            # 長音：重複前一個母音
            for c in reversed("".join(result)):
                if c in _VOWELS:
                    result.append(c)
                    break
            i += 1
            continue

        # 拗音：i 段假名 + 小 ゃゅょ
        if ch in _I_ROW and nxt in _SMALL_Y:
            stem = _I_ROW[ch][:-1]  # 去掉結尾 i
            if stem in ("sh", "ch", "j"):
                emit(stem + _SMALL_Y[nxt])
            else:
                emit(stem + "y" + _SMALL_Y[nxt])
            i += 2
            continue

        if ch in _BASE:
            emit(_BASE[ch])
            i += 1
            continue

        if ch in _SMALL_VOWEL:
            emit(_SMALL_VOWEL[ch])
            i += 1
            continue

        # 未知字元（漢字、標點等）原樣保留
        pending_sokuon = False
        result.append(ch)
        i += 1

    return "".join(result)
