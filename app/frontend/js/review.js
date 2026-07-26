/**
 * 固化記憶 — FSRS 雙軌翻卡複習
 * 兩條互不干擾的軌道：YouTube 單字 / 課程單字
 * 題型：recognition（看字回想意思）、cloze（句子挖空回想單字）
 * 依賴 app.js 全域：el, clear, viewRoot, render, navigateTo, createSvgIcon,
 *                  playAudioUrl, playTts, languageLabel, showToast
 * 依賴 auth.js 全域：authFetch, AUTH_API
 */

const TRACKS = [
  { id: "youtube", label: "YouTube 單字" },
  { id: "course", label: "課程單字" },
];

const reviewState = {
  track: "youtube",
  language: "all", // 'all' | 'english' | 'japanese'
  languages: [], // 該軌實際有卡片的語言 [{language, count}]
  loading: false,
  error: "",
  queue: [],
  index: 0,
  flipped: false,
  summary: null,
  grading: false,
  savingLimit: false,
  // 作答訊號
  shownAt: 0, // 卡片顯示的時間戳（用來算 response_ms）
  answerRevealed: false,
};

// py-fsrs Rating：1=Again 2=Hard 3=Good 4=Easy
const RATINGS = [
  { rating: 1, label: "再一次", cls: "again" },
  { rating: 2, label: "困難", cls: "hard" },
  { rating: 3, label: "良好", cls: "good" },
  { rating: 4, label: "簡單", cls: "easy" },
];

async function reviewOnEnter() {
  reviewState.index = 0;
  reviewState.flipped = false;
  await loadReviewQueue();
  render();
}

async function loadReviewQueue() {
  reviewState.loading = true;
  reviewState.error = "";
  render();
  const track = reviewState.track;
  const langParam =
    reviewState.language === "all" ? "" : `&language=${encodeURIComponent(reviewState.language)}`;
  try {
    const [queueRes, summaryRes, langRes] = await Promise.all([
      authFetch(`${AUTH_API}/reviews/today?track=${track}${langParam}&limit=30`),
      authFetch(`${AUTH_API}/reviews/summary?track=${track}${langParam}`),
      authFetch(`${AUTH_API}/reviews/languages?track=${track}`),
    ]);
    if (!queueRes.ok) throw new Error(`HTTP ${queueRes.status}`);
    reviewState.queue = await queueRes.json();
    reviewState.summary = summaryRes.ok ? await summaryRes.json() : null;
    reviewState.languages = langRes.ok ? await langRes.json() : [];
    // 切換軌道後，若原本選的語言在新軌沒有卡片，退回「全部語言」
    if (
      reviewState.language !== "all" &&
      !reviewState.languages.some((l) => l.language === reviewState.language)
    ) {
      reviewState.language = "all";
    }
    reviewState.index = 0;
    reviewState.flipped = false;
    startCardTimer();
  } catch (err) {
    reviewState.error = err.message || "無法載入複習佇列";
  } finally {
    reviewState.loading = false;
  }
}

/** 調整該軌道的每日新卡上限 */
async function updateDailyLimit(nextValue) {
  if (reviewState.savingLimit) return;
  const value = Math.max(0, Math.min(100, nextValue));
  reviewState.savingLimit = true;
  try {
    const res = await authFetch(`${AUTH_API}/reviews/settings?track=${reviewState.track}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daily_new_limit: value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    reviewState.savingLimit = false;
    await loadReviewQueue(); // 額度變了，佇列要重算
    render();
  } catch (err) {
    reviewState.savingLimit = false;
    if (typeof showToast === "function") {
      showToast(err.message || "設定失敗", { type: "error", title: "固化記憶" });
    }
    render();
  }
}

/** 每張卡開始計時（量測從看到題目到評分的反應時間） */
function startCardTimer() {
  reviewState.shownAt = Date.now();
  reviewState.answerRevealed = false;
}

async function gradeCurrentCard(rating) {
  const card = reviewState.queue[reviewState.index];
  if (!card || reviewState.grading) return;
  reviewState.grading = true;
  const responseMs = reviewState.shownAt ? Date.now() - reviewState.shownAt : null;
  try {
    const res = await authFetch(`${AUTH_API}/reviews/${card.card_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rating,
        response_ms: responseMs,
        prompt_type: card.prompt_type,
        hint_used: false,
        answer_revealed: reviewState.answerRevealed,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (reviewState.summary) reviewState.summary.reviewed_today += 1;
    reviewState.index += 1;
    reviewState.flipped = false;
    startCardTimer();
  } catch (err) {
    if (typeof showToast === "function") {
      showToast(err.message || "評分失敗", { type: "error", title: "固化記憶" });
    }
  } finally {
    reviewState.grading = false;
    render();
  }
}

// 只允許 https youtube.com/youtu.be（防止 video_url 被當 href 時執行危險 scheme）
function videoJumpUrl(card) {
  if (card.video_url && /^https:\/\/(www\.youtube\.com|youtu\.be)\//.test(card.video_url)) {
    const t = Math.floor(card.start_seconds || 0);
    const sep = card.video_url.includes("?") ? "&" : "?";
    return `${card.video_url}${sep}t=${t}s`;
  }
  return null;
}

/** 朗讀：課程項目有預錄音檔就用它，否則走 edge-tts */
function speakCard(text, card) {
  if (card.audio_url) playAudioUrl(card.audio_url, { label: "固化記憶" });
  else playTts(text, card.language);
}

function speakerButton(text, card, label) {
  const btn = el("button", "ghost-button review-audio");
  btn.type = "button";
  btn.appendChild(
    createSvgIcon(
      ["M11 5 6 9H2v6h4l5 4z", "M15.54 8.46a5 5 0 0 1 0 7.07", "M19.07 4.93a10 10 0 0 1 0 14.14"],
      16,
    ),
  );
  btn.appendChild(el("span", null, label || "播放發音"));
  btn.addEventListener("click", () => speakCard(text, card));
  return btn;
}

function renderTrackTabs(page) {
  const tabs = el("div", "favorites-tabs review-tabs");
  TRACKS.forEach((t) => {
    const btn = el("button", `favorites-tab ${reviewState.track === t.id ? "active" : ""}`, t.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      if (reviewState.track === t.id) return;
      reviewState.track = t.id;
      reviewOnEnter();
    });
    tabs.appendChild(btn);
  });
  page.appendChild(tabs);
}

/**
 * 工具列：一行內左右對齊 —— 最左為語言篩選、最右為每日新卡上限。
 * 語言只顯示該軌實際有卡片的選項。
 */
function renderToolbar(page) {
  const s = reviewState.summary;
  if (!reviewState.languages.length && !s) return;

  const bar = el("div", "review-toolbar");

  // ── 左：語言篩選 ──
  const left = el("div", "review-toolbar-left");
  if (reviewState.languages.length) {
    left.appendChild(el("span", "review-toolbar-label", "語言"));
    const total = reviewState.languages.reduce((a, l) => a + l.count, 0);
    const options = [
      { id: "all", label: "全部", count: total },
      ...reviewState.languages.map((l) => ({
        id: l.language,
        label: languageLabel(l.language),
        count: l.count,
      })),
    ];
    options.forEach((opt) => {
      const chip = el("button", `review-chip ${reviewState.language === opt.id ? "active" : ""}`);
      chip.type = "button";
      chip.appendChild(el("span", null, opt.label));
      chip.appendChild(el("span", "review-chip-count", String(opt.count)));
      chip.addEventListener("click", () => {
        if (reviewState.language === opt.id) return;
        reviewState.language = opt.id;
        reviewOnEnter();
      });
      left.appendChild(chip);
    });
  }
  bar.appendChild(left);

  // ── 右：每日新卡上限（規格建議初期 5–10、穩定後 10–20）──
  if (s) {
    const right = el("div", "review-toolbar-right");
    right.appendChild(el("span", "review-toolbar-label", "每日新卡"));

    const stepper = el("div", "review-stepper");
    const dec = el("button", null, "−");
    dec.type = "button";
    dec.disabled = reviewState.savingLimit || s.daily_new_limit <= 0;
    dec.addEventListener("click", () => updateDailyLimit(s.daily_new_limit - 5));

    const val = el("span", "review-stepper-value", String(s.daily_new_limit));

    const inc = el("button", null, "＋");
    inc.type = "button";
    inc.disabled = reviewState.savingLimit || s.daily_new_limit >= 100;
    inc.addEventListener("click", () => updateDailyLimit(s.daily_new_limit + 5));

    stepper.appendChild(dec);
    stepper.appendChild(val);
    stepper.appendChild(inc);
    right.appendChild(stepper);

    // 說明改成 tooltip，不佔版面
    const info = el("span", "review-info");
    info.textContent = "?";
    info.title = "每日新卡上限為整條軌道共用（不分語言）；到期複習不受此限制。";
    right.appendChild(info);

    bar.appendChild(right);
  }

  page.appendChild(bar);
}

function renderReviewView() {
  clear(viewRoot);
  const page = el("div", "review-page");
  viewRoot.appendChild(page);

  const header = el("header", "review-header");
  header.appendChild(el("h1", null, "固化記憶"));
  header.appendChild(
    el("p", null, "主動回想並評分，系統用 FSRS 依你的記憶曲線安排下一次複習。"),
  );
  page.appendChild(header);

  renderTrackTabs(page);
  renderToolbar(page);

  if (reviewState.summary) {
    const s = reviewState.summary;
    const stats = el("div", "review-stats");
    stats.appendChild(el("span", "review-stat", `待複習 ${s.due_count}`));
    stats.appendChild(el("span", "review-stat", `今日已複習 ${s.reviewed_today}`));
    stats.appendChild(
      el("span", "review-stat muted", `新卡額度 ${s.new_remaining_today}/${s.daily_new_limit}`),
    );
    stats.appendChild(el("span", "review-stat muted", `卡片總數 ${s.total_cards}`));
    page.appendChild(stats);
  }

  if (reviewState.loading) {
    const wrap = el("div", "review-card-wrap");
    const panel = el("section", "panel");
    panel.appendChild(el("p", "muted", "載入複習卡中…"));
    wrap.appendChild(panel);
    page.appendChild(wrap);
    return;
  }

  if (reviewState.error) {
    const wrap = el("div", "review-card-wrap");
    const panel = el("section", "panel favorites-setup-error");
    panel.appendChild(el("h2", null, "無法載入固化記憶"));
    panel.appendChild(el("p", "muted", reviewState.error));
    panel.appendChild(
      el("p", "muted", "若剛建立資料表：請執行 spec/database/005_fsrs.sql，並重啟後端。"),
    );
    wrap.appendChild(panel);
    page.appendChild(wrap);
    return;
  }

  if (!reviewState.queue.length || reviewState.index >= reviewState.queue.length) {
    renderDonePanel(page);
    return;
  }

  renderCard(page, reviewState.queue[reviewState.index]);
}

function renderDonePanel(page) {
  const wrap = el("div", "review-card-wrap");
  page.appendChild(wrap);
  const done = el("section", "panel review-done");
  const reviewedNow = reviewState.index;
  if (reviewState.queue.length) {
    done.appendChild(el("h2", null, "這輪完成 🎉"));
    done.appendChild(el("p", "muted", `複習了 ${reviewedNow} 張卡，記憶已再固化一次。`));
  } else {
    done.appendChild(el("h2", null, "目前沒有到期的卡片"));
    const hint =
      reviewState.track === "youtube"
        ? "用 Chrome 擴充在 YouTube 收藏單字，就會自動進入這裡的複習排程。"
        : "在課程中收藏單字或句子，就會自動進入這裡的複習排程。";
    done.appendChild(el("p", "muted", hint));
  }
  const actions = el("div", "review-done-actions");
  const reload = el("button", "primary-button", "重新整理");
  reload.type = "button";
  reload.addEventListener("click", () => reviewOnEnter());
  actions.appendChild(reload);
  const goFav = el("button", "ghost-button", "查看收藏");
  goFav.type = "button";
  goFav.addEventListener("click", () => navigateTo("favorites"));
  actions.appendChild(goFav);
  done.appendChild(actions);
  wrap.appendChild(done);
}

function renderCard(page, card) {
  // 卡片另外包一層限制寬度並置中；工具列維持滿版
  const wrap = el("div", "review-card-wrap");
  page.appendChild(wrap);

  const progress = el(
    "div",
    "review-progress",
    `${reviewState.index + 1} / ${reviewState.queue.length}`,
  );
  wrap.appendChild(progress);

  const cardEl = el("section", "review-card");

  // 標籤：新卡/題型/語言
  const badges = el("div", "review-card-badges");
  if (card.is_new) badges.appendChild(el("span", "tag violet", "新卡"));
  badges.appendChild(
    el("span", "tag blue", card.prompt_type === "cloze" ? "填空回想" : "辨認"),
  );
  if (card.language) badges.appendChild(el("span", "tag", languageLabel(card.language)));
  cardEl.appendChild(badges);

  // ── 正面：依題型呈現 ──
  if (card.prompt_type === "cloze") {
    cardEl.appendChild(el("p", "review-cloze", card.prompt_text));
    cardEl.appendChild(el("p", "review-prompt-hint", "這個空格應該填哪個字？"));
    cardEl.appendChild(speakerButton(card.context_sentence || card.term, card, "朗讀整句"));
  } else {
    cardEl.appendChild(el("h2", "review-card-term", card.term));
    if (card.romaji) cardEl.appendChild(el("p", "review-card-romaji", card.romaji));
    if (card.reading && card.reading !== card.term) {
      cardEl.appendChild(el("p", "review-card-reading", card.reading));
    }
    cardEl.appendChild(el("p", "review-prompt-hint", "還記得這個字的意思嗎？"));
    cardEl.appendChild(speakerButton(card.term, card, "播放發音"));
  }

  // ── 背面：翻開後才顯示答案 ──
  if (reviewState.flipped) {
    const back = el("div", "review-card-back");

    if (card.prompt_type === "cloze") {
      back.appendChild(el("h2", "review-card-term", card.term));
      if (card.romaji) back.appendChild(el("p", "review-card-romaji", card.romaji));
    }
    back.appendChild(el("p", "review-card-answer", card.translation || "（無翻譯）"));

    if (card.context_sentence) {
      back.appendChild(el("p", "review-card-context", card.context_sentence));
      if (card.sentence_translation) {
        back.appendChild(el("p", "review-card-context-tr", card.sentence_translation));
      }
    }

    // 來源：YouTube 可跳回影片；課程顯示情境
    const source = el("div", "review-card-source");
    const url = videoJumpUrl(card);
    if (url) {
      const link = el("a", "review-video-link", `▶ 跳回影片${card.video_title ? "：" + card.video_title : ""}`);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      source.appendChild(link);
    } else if (card.scenario_title || card.course_title) {
      source.appendChild(
        el("span", "muted", [card.scenario_title, card.course_title].filter(Boolean).join(" · ")),
      );
    }
    if (source.childNodes.length) back.appendChild(source);

    cardEl.appendChild(back);
  }

  // ── 操作區 ──
  const actions = el("div", "review-actions");
  if (!reviewState.flipped) {
    const showBtn = el("button", "primary-button review-flip", "顯示答案");
    showBtn.type = "button";
    showBtn.addEventListener("click", () => {
      reviewState.flipped = true;
      reviewState.answerRevealed = true; // 記錄「看過答案」供分析
      render();
    });
    actions.appendChild(showBtn);
  } else {
    const grades = el("div", "review-grades");
    RATINGS.forEach((r) => {
      const btn = el("button", `review-grade review-grade-${r.cls}`, r.label);
      btn.type = "button";
      btn.disabled = reviewState.grading;
      btn.addEventListener("click", () => gradeCurrentCard(r.rating));
      grades.appendChild(btn);
    });
    actions.appendChild(grades);
  }
  cardEl.appendChild(actions);

  wrap.appendChild(cardEl);
}

window.learnflowReview = {
  onEnter: reviewOnEnter,
  renderView: renderReviewView,
};
