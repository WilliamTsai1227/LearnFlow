#!/usr/bin/env python3
"""
種子：單字頁的單字集（vocab_decks / vocab_items）。
- 日文五十音：平假名 46 + 片假名 46（含羅馬拼音，音檔路徑）
- 日文常用單字：curated 清單，羅馬拼音由 cutlet（Hepburn）自動產生

可重跑：先刪掉本腳本建立的 deck（連動刪 items）。

用法：
  pip install cutlet unidic-lite psycopg2-binary python-dotenv
  export DATABASE_URL=postgresql://learnflow:learnflow_dev@127.0.0.1:5433/learnflow
  python spec/operate/seed_vocab.py
"""

from __future__ import annotations

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
PROJECT_ROOT = SCRIPT_DIR.parents[1]

# ---- 五十音：每一格 (平假名, 片假名, 羅馬拼音, 行/母音, 列/子音) ----
# 清音（含母音欄 ''、撥音 ん row='n'）
SEION = [
    ("", [("あ", "ア", "a", "a"), ("い", "イ", "i", "i"), ("う", "ウ", "u", "u"), ("え", "エ", "e", "e"), ("お", "オ", "o", "o")]),
    ("K", [("か", "カ", "ka", "a"), ("き", "キ", "ki", "i"), ("く", "ク", "ku", "u"), ("け", "ケ", "ke", "e"), ("こ", "コ", "ko", "o")]),
    ("S", [("さ", "サ", "sa", "a"), ("し", "シ", "shi", "i"), ("す", "ス", "su", "u"), ("せ", "セ", "se", "e"), ("そ", "ソ", "so", "o")]),
    ("T", [("た", "タ", "ta", "a"), ("ち", "チ", "chi", "i"), ("つ", "ツ", "tsu", "u"), ("て", "テ", "te", "e"), ("と", "ト", "to", "o")]),
    ("N", [("な", "ナ", "na", "a"), ("に", "ニ", "ni", "i"), ("ぬ", "ヌ", "nu", "u"), ("ね", "ネ", "ne", "e"), ("の", "ノ", "no", "o")]),
    ("H", [("は", "ハ", "ha", "a"), ("ひ", "ヒ", "hi", "i"), ("ふ", "フ", "fu", "u"), ("へ", "ヘ", "he", "e"), ("ほ", "ホ", "ho", "o")]),
    ("M", [("ま", "マ", "ma", "a"), ("み", "ミ", "mi", "i"), ("む", "ム", "mu", "u"), ("め", "メ", "me", "e"), ("も", "モ", "mo", "o")]),
    ("Y", [("や", "ヤ", "ya", "a"), ("ゆ", "ユ", "yu", "u"), ("よ", "ヨ", "yo", "o")]),
    ("R", [("ら", "ラ", "ra", "a"), ("り", "リ", "ri", "i"), ("る", "ル", "ru", "u"), ("れ", "レ", "re", "e"), ("ろ", "ロ", "ro", "o")]),
    ("W", [("わ", "ワ", "wa", "a"), ("を", "ヲ", "wo", "o")]),
    ("", [("ん", "ン", "n", "n")]),
]
# 濁音・半濁音
DAKUON = [
    ("G", [("が", "ガ", "ga", "a"), ("ぎ", "ギ", "gi", "i"), ("ぐ", "グ", "gu", "u"), ("げ", "ゲ", "ge", "e"), ("ご", "ゴ", "go", "o")]),
    ("Z", [("ざ", "ザ", "za", "a"), ("じ", "ジ", "ji", "i"), ("ず", "ズ", "zu", "u"), ("ぜ", "ゼ", "ze", "e"), ("ぞ", "ゾ", "zo", "o")]),
    ("D", [("だ", "ダ", "da", "a"), ("ぢ", "ヂ", "di", "i"), ("づ", "ヅ", "du", "u"), ("で", "デ", "de", "e"), ("ど", "ド", "do", "o")]),
    ("B", [("ば", "バ", "ba", "a"), ("び", "ビ", "bi", "i"), ("ぶ", "ブ", "bu", "u"), ("べ", "ベ", "be", "e"), ("ぼ", "ボ", "bo", "o")]),
    ("P", [("ぱ", "パ", "pa", "a"), ("ぴ", "ピ", "pi", "i"), ("ぷ", "プ", "pu", "u"), ("ぺ", "ペ", "pe", "e"), ("ぽ", "ポ", "po", "o")]),
]
# 拗音
YOON = [
    ("KY", [("きゃ", "キャ", "kya", "a"), ("きゅ", "キュ", "kyu", "u"), ("きょ", "キョ", "kyo", "o")]),
    ("SH", [("しゃ", "シャ", "sha", "a"), ("しゅ", "シュ", "shu", "u"), ("しょ", "ショ", "sho", "o")]),
    ("CH", [("ちゃ", "チャ", "cha", "a"), ("ちゅ", "チュ", "chu", "u"), ("ちょ", "チョ", "cho", "o")]),
    ("NY", [("にゃ", "ニャ", "nya", "a"), ("にゅ", "ニュ", "nyu", "u"), ("にょ", "ニョ", "nyo", "o")]),
    ("HY", [("ひゃ", "ヒャ", "hya", "a"), ("ひゅ", "ヒュ", "hyu", "u"), ("ひょ", "ヒョ", "hyo", "o")]),
    ("MY", [("みゃ", "ミャ", "mya", "a"), ("みゅ", "ミュ", "myu", "u"), ("みょ", "ミョ", "myo", "o")]),
    ("RY", [("りゃ", "リャ", "rya", "a"), ("りゅ", "リュ", "ryu", "u"), ("りょ", "リョ", "ryo", "o")]),
    ("GY", [("ぎゃ", "ギャ", "gya", "a"), ("ぎゅ", "ギュ", "gyu", "u"), ("ぎょ", "ギョ", "gyo", "o")]),
    ("J", [("じゃ", "ジャ", "ja", "a"), ("じゅ", "ジュ", "ju", "u"), ("じょ", "ジョ", "jo", "o")]),
    ("DY", [("ぢゃ", "ヂャ", "dya", "a"), ("ぢゅ", "ヂュ", "dyu", "u"), ("ぢょ", "ヂョ", "dyo", "o")]),
    ("BY", [("びゃ", "ビャ", "bya", "a"), ("びゅ", "ビュ", "byu", "u"), ("びょ", "ビョ", "byo", "o")]),
    ("PY", [("ぴゃ", "ピャ", "pya", "a"), ("ぴゅ", "ピュ", "pyu", "u"), ("ぴょ", "ピョ", "pyo", "o")]),
]
KANA_CATEGORIES = [("seion", SEION), ("dakuon", DAKUON), ("yoon", YOON)]

# ---- 常用單字，(單字, 中文意思)；羅馬拼音由 cutlet 產生 ----
WORDS: list[tuple[str, str]] = [
    # 問候・寒暄
    ("こんにちは", "你好"), ("おはよう", "早安"), ("こんばんは", "晚安（傍晚問候）"),
    ("ありがとう", "謝謝"), ("すみません", "不好意思／對不起"), ("ごめんなさい", "對不起"),
    ("さようなら", "再見"), ("はい", "是／對"), ("いいえ", "不是"),
    ("お願いします", "拜託／請"), ("いただきます", "開動了"), ("ごちそうさま", "我吃飽了（謝謝招待）"),
    # 人稱・人
    ("私", "我"), ("あなた", "你"), ("彼", "他"), ("彼女", "她"),
    ("友達", "朋友"), ("家族", "家人"), ("先生", "老師"), ("学生", "學生"),
    ("子供", "小孩"), ("人", "人"),
    ("お父さん", "爸爸"), ("お母さん", "媽媽"), ("兄", "哥哥"), ("姉", "姊姊"),
    ("弟", "弟弟"), ("妹", "妹妹"),
    # 數字
    ("一", "一"), ("二", "二"), ("三", "三"), ("四", "四"), ("五", "五"),
    ("六", "六"), ("七", "七"), ("八", "八"), ("九", "九"), ("十", "十"),
    ("百", "百"), ("千", "千"), ("万", "萬"),
    # 時間
    ("今日", "今天"), ("明日", "明天"), ("昨日", "昨天"), ("今", "現在"),
    ("朝", "早上"), ("昼", "中午"), ("夜", "晚上"), ("年", "年"), ("月", "月"),
    ("日", "日／天"), ("時間", "時間"), ("週", "週"),
    ("月曜日", "星期一"), ("火曜日", "星期二"), ("水曜日", "星期三"), ("木曜日", "星期四"),
    ("金曜日", "星期五"), ("土曜日", "星期六"), ("日曜日", "星期日"),
    # 顏色
    ("赤", "紅色"), ("青", "藍色"), ("白", "白色"), ("黒", "黑色"),
    ("黄色", "黃色"), ("緑", "綠色"),
    # 食物・飲料
    ("水", "水"), ("お茶", "茶"), ("コーヒー", "咖啡"), ("ご飯", "飯"),
    ("パン", "麵包"), ("肉", "肉"), ("魚", "魚"), ("野菜", "蔬菜"),
    ("果物", "水果"), ("卵", "蛋"), ("牛乳", "牛奶"), ("お酒", "酒"),
    # 地點・物品
    ("家", "家"), ("学校", "學校"), ("会社", "公司"), ("駅", "車站"),
    ("病院", "醫院"), ("店", "商店"), ("電車", "電車"), ("車", "車子"),
    ("電話", "電話"), ("本", "書"), ("お金", "錢"), ("財布", "錢包"),
    # 自然
    ("空", "天空"), ("海", "海"), ("山", "山"), ("川", "河川"),
    ("花", "花"), ("木", "樹木"), ("雨", "雨"), ("雪", "雪"),
    ("風", "風"), ("火", "火"),
    # 身體
    ("手", "手"), ("足", "腳"), ("目", "眼睛"), ("耳", "耳朵"),
    ("口", "嘴巴"), ("鼻", "鼻子"), ("頭", "頭"),
    # 動詞
    ("食べる", "吃"), ("飲む", "喝"), ("行く", "去"), ("来る", "來"),
    ("見る", "看"), ("聞く", "聽／問"), ("話す", "說"), ("読む", "讀"),
    ("書く", "寫"), ("買う", "買"), ("帰る", "回家"), ("寝る", "睡覺"),
    ("起きる", "起床"), ("分かる", "懂"), ("する", "做"), ("待つ", "等"),
    ("会う", "見面"), ("使う", "使用"), ("働く", "工作"), ("休む", "休息"),
    # 形容詞
    ("大きい", "大的"), ("小さい", "小的"), ("高い", "高的／貴的"), ("安い", "便宜的"),
    ("新しい", "新的"), ("古い", "舊的"), ("良い", "好的"), ("悪い", "壞的"),
    ("暑い", "熱的（天氣）"), ("寒い", "冷的（天氣）"), ("美味しい", "好吃的"),
    ("楽しい", "開心的"), ("忙しい", "忙碌的"), ("難しい", "困難的"), ("簡単", "簡單"),
    ("好き", "喜歡"), ("嫌い", "討厭"), ("元気", "有精神／健康"),
]

# cutlet 在少數固定語/特殊讀音會出錯，手動修正（は 助詞讀 wa、曜日 讀 ...bi 等）
ROMAJI_OVERRIDE = {
    "こんにちは": "Konnichiwa",
    "こんばんは": "Konbanwa",
    "私": "Watashi",
    "お父さん": "Otousan",
    "お母さん": "Okaasan",
    "明日": "Ashita",
    "月曜日": "Getsuyoubi",
    "火曜日": "Kayoubi",
    "水曜日": "Suiyoubi",
    "木曜日": "Mokuyoubi",
    "金曜日": "Kinyoubi",
    "土曜日": "Doyoubi",
    "日曜日": "Nichiyoubi",
}


def run() -> None:
    load_dotenv(SCRIPT_DIR / ".env")
    load_dotenv(PROJECT_ROOT / ".env")
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("缺少 DATABASE_URL", file=sys.stderr)
        sys.exit(1)

    katsu = cutlet.Cutlet()
    katsu.use_foreign_spelling = False

    conn = psycopg2.connect(database_url)
    conn.autocommit = False
    cur = conn.cursor()

    # 重跑：刪掉本腳本管理的 deck
    cur.execute("DELETE FROM vocab_decks WHERE id IN ('jp-kana', 'jp-common')")

    # 五十音 deck
    cur.execute(
        """INSERT INTO vocab_decks (id, language, kind, title, description, sort_order)
           VALUES ('jp-kana','japanese','kana','五十音',
                   '日文的假名系統，分平假名與片假名。含清音、濁音・半濁音、拗音，每個音都可播放發音、看羅馬拼音。', 1)"""
    )
    kana_rows = []
    for script, char_index in (("hiragana", 0), ("katakana", 1)):
        idx = 0
        for category, table in KANA_CATEGORIES:
            for col, cells in table:
                for cell in cells:
                    hira, kata, romaji, row = cell
                    ch = hira if char_index == 0 else kata
                    idx += 1
                    item_id = f"jp-kana-{script}-{romaji}"
                    audio = f"audio/japanese/kana/{script}/{romaji}.mp3"
                    kana_rows.append(
                        (item_id, "jp-kana", script, idx, ch, romaji, None, None, audio, category, row, col)
                    )
    cur.executemany(
        """INSERT INTO vocab_items
           (id, deck_id, group_key, order_index, term, romaji, reading, meaning, audio_url,
            category, kana_row, kana_col)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        kana_rows,
    )

    # 常用單字 deck
    cur.execute(
        """INSERT INTO vocab_decks (id, language, kind, title, description, sort_order)
           VALUES ('jp-common','japanese','word','常用單字',
                   '日常生活最常用的日文單字，附羅馬拼音與發音，可隱藏／顯示中文意思。', 2)"""
    )
    word_rows = []
    for idx, (term, meaning) in enumerate(WORDS, start=1):
        item_id = f"jp-common-w{idx:03d}"
        romaji = ROMAJI_OVERRIDE.get(term) or katsu.romaji(term).strip()
        audio = f"audio/japanese/word/jp-common/{item_id}.mp3"
        word_rows.append((item_id, "jp-common", None, idx, term, romaji, None, meaning, audio))
    cur.executemany(
        """INSERT INTO vocab_items
           (id, deck_id, group_key, order_index, term, romaji, reading, meaning, audio_url)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        word_rows,
    )

    conn.commit()
    cur.close()
    conn.close()
    print(f"完成：五十音 {len(kana_rows)} 個假名（平假名+片假名），常用單字 {len(word_rows)} 個")


if __name__ == "__main__":
    run()
