/**
 * 單字 — 語言切換（像情境頁）→ 單字集（五十音、常用單字）
 * 五十音：平假名 / 片假名分頁，每個音可播放發音 + 羅馬拼音
 * 常用單字：每個字有羅馬拼音、可隱藏/顯示中文、可播放發音
 *
 * 依賴 app.js 全域：el, clear, createSvgIcon, playAudioUrl, api, viewRoot, state, render,
 * renderLanguageFilters, createPageHeader, languageLabel。
 */

const vocabState = {
  sub: "list", // list | deck
  loading: false,
  error: "",
  decks: [],
  deck: null, // 詳情
  group: null, // 五十音目前分頁
  showMeaning: false, // 常用單字：全域是否顯示中文
  revealed: new Set(), // 常用單字：個別已顯示中文的 id
};

const GROUP_LABEL = { hiragana: "平假名", katakana: "片假名" };

// 五十音表格：三個分區（清音 / 濁音・半濁音 / 拗音）與各自的欄（子音）、列（母音）
const KANA_SECTIONS = [
  { key: "seion", title: "清音", cols: ["K", "S", "T", "N", "H", "M", "Y", "R", "W"], rows: ["a", "i", "u", "e", "o"] },
  { key: "dakuon", title: "濁音・半濁音", cols: ["G", "Z", "D", "B", "P"], rows: ["a", "i", "u", "e", "o"] },
  { key: "yoon", title: "拗音", cols: ["KY", "SH", "CH", "NY", "HY", "MY", "RY", "GY", "J", "DY", "BY", "PY"], rows: ["a", "u", "o"] },
];

async function vocabOnEnter() {
  vocabState.sub = "list";
  vocabState.deck = null;
  await loadVocabDecks();
  render();
}

async function loadVocabDecks() {
  vocabState.loading = true;
  vocabState.error = "";
  render();
  try {
    const q = state.vocabLanguage === "all" ? "" : `?language=${state.vocabLanguage}`;
    vocabState.decks = await api(`/api/vocab/decks${q}`);
  } catch (e) {
    vocabState.error = e.message || "無法載入單字集";
    vocabState.decks = [];
  } finally {
    vocabState.loading = false;
  }
}

async function openVocabDeck(deckId) {
  vocabState.sub = "deck";
  vocabState.deck = null;
  vocabState.loading = true;
  vocabState.error = "";
  vocabState.group = null;
  vocabState.showMeaning = false;
  vocabState.revealed = new Set();
  render();
  try {
    const deck = await api(`/api/vocab/decks/${encodeURIComponent(deckId)}`);
    vocabState.deck = deck;
    const groups = [...new Set(deck.items.map((i) => i.group_key).filter(Boolean))];
    vocabState.group = groups.length ? groups[0] : null;
  } catch (e) {
    vocabState.error = e.message || "無法載入單字集";
  } finally {
    vocabState.loading = false;
  }
  render();
  scrollViewToTop();
}

function backToVocabList() {
  vocabState.sub = "list";
  vocabState.deck = null;
  render();
  scrollViewToTop();
}

// ---------------------------------------------------------------------------

function vocabPlayButton(item, opts = {}) {
  const b = el("button", `vocab-play ${opts.big ? "vocab-play-big" : ""}`);
  b.type = "button";
  b.setAttribute("aria-label", "播放發音");
  b.appendChild(createSvgIcon(["M6 4l14 8-14 8z"], opts.big ? 18 : 14));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    playAudioUrl(item.audio_url, { label: "發音" });
  });
  return b;
}

// ---------------------------------------------------------------------------
// 單字集列表
// ---------------------------------------------------------------------------

function renderVocabList() {
  clear(viewRoot);
  const page = el("div", "vocab-page");
  viewRoot.appendChild(page);

  const header = el("header", "vocab-header");
  header.appendChild(el("h1", null, "單字"));
  header.appendChild(el("p", null, "選一個單字集，逐字聽發音、看羅馬拼音、練習記憶。"));
  page.appendChild(header);

  const toolbar = el("div", "explore-toolbar");
  toolbar.appendChild(el("span", "explore-toolbar-label", "語言篩選"));
  renderLanguageFilters(
    toolbar,
    async (lang) => {
      state.vocabLanguage = lang;
      await loadVocabDecks();
      render();
    },
    { compact: true, languageKey: "vocabLanguage" },
  );
  page.appendChild(toolbar);

  if (vocabState.loading) {
    const p = el("section", "panel");
    p.appendChild(el("p", "muted", "載入中…"));
    page.appendChild(p);
    return;
  }
  if (vocabState.error) {
    const p = el("section", "panel");
    p.appendChild(el("h2", null, "無法載入單字集"));
    p.appendChild(el("p", "muted", vocabState.error));
    page.appendChild(p);
    return;
  }
  if (!vocabState.decks.length) {
    const empty = el("section", "panel vocab-empty");
    const label = state.vocabLanguage === "english" ? "英文" : "";
    empty.appendChild(el("h2", null, `${label}單字集即將推出`));
    empty.appendChild(el("p", "muted", "日文已提供「五十音」與「常用單字」，切換到日文即可開始。"));
    page.appendChild(empty);
    return;
  }

  const grid = el("section", "vocab-deck-grid");
  const accents = ["accent-blue", "accent-green", "accent-violet", "accent-amber"];
  vocabState.decks.forEach((deck, index) => {
    const card = el("article", "vocab-deck-card");
    const cover = el("div", `vocab-deck-cover ${accents[index % accents.length]}`);
    cover.appendChild(el("span", "vocab-deck-mark", deck.kind === "kana" ? "あ" : "語"));
    cover.appendChild(el("span", "vocab-deck-count", `${deck.item_count} 個`));
    card.appendChild(cover);
    const body = el("div", "vocab-deck-body");
    const tags = el("div", "tag-row");
    tags.appendChild(el("span", "tag blue", languageLabel(deck.language)));
    tags.appendChild(el("span", "tag", deck.kind === "kana" ? "假名" : "單字"));
    body.appendChild(tags);
    body.appendChild(el("h3", null, deck.title));
    body.appendChild(el("p", "vocab-deck-desc", deck.description));
    const btn = el("button", "vocab-deck-link", "開始學習");
    btn.type = "button";
    btn.addEventListener("click", () => openVocabDeck(deck.id));
    body.appendChild(btn);
    card.appendChild(body);
    grid.appendChild(card);
  });
  page.appendChild(grid);
}

// ---------------------------------------------------------------------------
// 單字集詳情
// ---------------------------------------------------------------------------

function renderVocabDeck() {
  clear(viewRoot);
  const page = el("div", "vocab-page");
  viewRoot.appendChild(page);

  if (vocabState.loading) {
    page.appendChild(createPageHeader("載入中…", "", "返回單字集", backToVocabList));
    return;
  }
  if (vocabState.error || !vocabState.deck) {
    page.appendChild(createPageHeader("無法載入", vocabState.error || "", "返回單字集", backToVocabList));
    return;
  }

  const deck = vocabState.deck;
  page.appendChild(createPageHeader(deck.title, deck.description, "返回單字集", backToVocabList));

  if (deck.kind === "kana") renderKanaDeck(page, deck);
  else renderWordDeck(page, deck);
}

function kanaCell(item) {
  const cell = el("button", "kana-cell");
  cell.type = "button";
  cell.setAttribute("aria-label", `${item.term}，發音 ${item.romaji}`);
  cell.appendChild(el("span", "kana-char", item.term));
  cell.appendChild(el("span", "kana-romaji", item.romaji || ""));
  cell.addEventListener("click", () => playAudioUrl(item.audio_url, { label: "發音" }));
  return cell;
}

function renderKanaDeck(page, deck) {
  const groups = [...new Set(deck.items.map((i) => i.group_key).filter(Boolean))];

  const tabs = el("div", "vocab-tabs");
  groups.forEach((g) => {
    const tab = el("button", `vocab-tab ${vocabState.group === g ? "active" : ""}`, GROUP_LABEL[g] || g);
    tab.type = "button";
    tab.addEventListener("click", () => {
      vocabState.group = g;
      render();
    });
    tabs.appendChild(tab);
  });
  page.appendChild(tabs);
  page.appendChild(el("p", "vocab-hint", "點任一格即可播放發音；格內小字是羅馬拼音。"));

  const items = deck.items.filter((i) => i.group_key === vocabState.group);

  KANA_SECTIONS.forEach((sec) => {
    const catItems = items.filter((i) => i.category === sec.key);
    if (!catItems.length) return;
    const find = (row, col) => catItems.find((i) => i.kana_row === row && i.kana_col === col);

    const section = el("section", "kana-section");
    section.appendChild(el("h3", "kana-section-title", sec.title));

    const wrap = el("div", "kana-table-wrap");
    const table = el("div", "kana-table");
    table.style.gridTemplateColumns = `repeat(${sec.cols.length + 1}, 58px)`;

    // 表頭：角落 + 子音列
    table.appendChild(el("span", "kana-corner", "音"));
    sec.cols.forEach((c) => table.appendChild(el("span", "kana-colhead", c)));

    // 每一列（母音）
    sec.rows.forEach((row) => {
      if (sec.key === "seion") {
        const vowel = find(row, "");
        table.appendChild(vowel ? kanaCell(vowel) : el("span", "kana-empty"));
      } else {
        table.appendChild(el("span", "kana-rowhead", row));
      }
      sec.cols.forEach((col) => {
        const item = find(row, col);
        table.appendChild(item ? kanaCell(item) : el("span", "kana-empty"));
      });
    });
    wrap.appendChild(table);
    section.appendChild(wrap);

    // 撥音 ん（清音區）
    if (sec.key === "seion") {
      const nItem = catItems.find((i) => i.kana_row === "n");
      if (nItem) {
        const extra = el("div", "kana-extra");
        extra.appendChild(el("span", "kana-extra-label", "撥音"));
        extra.appendChild(kanaCell(nItem));
        section.appendChild(extra);
      }
    }
    page.appendChild(section);
  });
}

function renderWordDeck(page, deck) {
  const bar = el("div", "vocab-word-bar");
  bar.appendChild(el("span", "vocab-word-count", `${deck.items.length} 個單字`));
  const toggle = el(
    "button",
    `translation-toggle ${vocabState.showMeaning ? "is-visible" : ""}`,
    vocabState.showMeaning ? "隱藏中文" : "顯示中文",
  );
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    vocabState.showMeaning = !vocabState.showMeaning;
    render();
  });
  bar.appendChild(toggle);
  page.appendChild(bar);

  const grid = el("section", "word-grid");
  deck.items.forEach((item) => {
    const card = el("article", "word-card");

    const top = el("div", "word-card-top");
    const termBlock = el("div", "word-term-block");
    termBlock.appendChild(el("strong", "word-term", item.term));
    if (item.romaji) termBlock.appendChild(el("span", "word-romaji", item.romaji));
    top.appendChild(termBlock);
    top.appendChild(vocabPlayButton(item));
    card.appendChild(top);

    const meaning = el("p", "word-meaning");
    const paint = () => {
      if (vocabState.showMeaning || vocabState.revealed.has(item.id)) {
        meaning.classList.remove("is-hidden");
        meaning.textContent = item.meaning || "";
      } else {
        meaning.classList.add("is-hidden");
        meaning.textContent = "點擊顯示中文";
      }
    };
    paint();
    if (!vocabState.showMeaning) {
      card.classList.add("word-card-clickable");
      card.addEventListener("click", () => {
        // 點一下顯示、再點一下隱藏
        if (vocabState.revealed.has(item.id)) vocabState.revealed.delete(item.id);
        else vocabState.revealed.add(item.id);
        paint();
      });
    }
    card.appendChild(meaning);

    grid.appendChild(card);
  });
  page.appendChild(grid);
}

// ---------------------------------------------------------------------------

function renderVocabView() {
  if (vocabState.sub === "deck") renderVocabDeck();
  else renderVocabList();
}

window.learnflowVocab = {
  onEnter: vocabOnEnter,
  renderView: renderVocabView,
};
