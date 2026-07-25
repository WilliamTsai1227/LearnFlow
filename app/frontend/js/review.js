/**
 * 複習 — FSRS 翻卡複習
 * 依賴 app.js 全域：el, clear, viewRoot, render, navigateTo, createSvgIcon, playAudioUrl, languageLabel
 * 依賴 auth.js 全域：authFetch, AUTH_API
 */

const reviewState = {
  loading: false,
  error: "",
  queue: [],
  index: 0,
  flipped: false,
  summary: null,
  grading: false,
};

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
  try {
    const [queueRes, summaryRes] = await Promise.all([
      authFetch(`${AUTH_API}/review/queue?limit=30`),
      authFetch(`${AUTH_API}/review/summary`),
    ]);
    if (!queueRes.ok) throw new Error(`HTTP ${queueRes.status}`);
    reviewState.queue = await queueRes.json();
    reviewState.summary = summaryRes.ok ? await summaryRes.json() : null;
    reviewState.index = 0;
    reviewState.flipped = false;
  } catch (err) {
    reviewState.error = err.message || "無法載入複習佇列";
  } finally {
    reviewState.loading = false;
  }
}

async function gradeCurrentCard(rating) {
  const card = reviewState.queue[reviewState.index];
  if (!card || reviewState.grading) return;
  reviewState.grading = true;
  try {
    const res = await authFetch(`${AUTH_API}/review/${card.card_id}/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (reviewState.summary) reviewState.summary.reviewed_today += 1;
    reviewState.index += 1;
    reviewState.flipped = false;
  } catch (err) {
    if (typeof showToast === "function") {
      showToast(err.message || "評分失敗", { type: "error", title: "複習" });
    }
  } finally {
    reviewState.grading = false;
    render();
  }
}

// 只允許 https youtube.com/youtu.be，避免存進 DB 的 video_url 被當成 href 時
// 執行 javascript:/data: 等危險 scheme（後端已驗證，這裡是第二層保險）。
function videoJumpUrl(card) {
  if (card.video_url && /^https:\/\/(www\.youtube\.com|youtu\.be)\//.test(card.video_url)) {
    const t = Math.floor(card.start_seconds || 0);
    const sep = card.video_url.includes("?") ? "&" : "?";
    return `${card.video_url}${sep}t=${t}s`;
  }
  return null;
}

function renderReviewView() {
  clear(viewRoot);
  const page = el("div", "review-page");
  viewRoot.appendChild(page);

  const header = el("header", "review-header");
  header.appendChild(el("h1", null, "複習"));
  header.appendChild(el("p", null, "翻卡自評，系統用 FSRS 幫你安排最有效率的複習曲線。"));
  if (reviewState.summary) {
    const stats = el("div", "review-stats");
    stats.appendChild(el("span", "review-stat", `待複習 ${reviewState.summary.due_count}`));
    stats.appendChild(el("span", "review-stat", `今日已複習 ${reviewState.summary.reviewed_today}`));
    stats.appendChild(el("span", "review-stat muted", `卡片總數 ${reviewState.summary.total_cards}`));
    header.appendChild(stats);
  }
  page.appendChild(header);

  if (reviewState.loading) {
    const panel = el("section", "panel");
    panel.appendChild(el("p", "muted", "載入複習卡中…"));
    page.appendChild(panel);
    return;
  }

  if (reviewState.error) {
    const panel = el("section", "panel favorites-setup-error");
    panel.appendChild(el("h2", null, "無法載入複習"));
    panel.appendChild(el("p", "muted", reviewState.error));
    panel.appendChild(
      el("p", "muted", "若剛建立資料表：請執行 spec/database/002_srs.sql，並重啟後端。"),
    );
    page.appendChild(panel);
    return;
  }

  // 佇列已完成或原本就空
  if (!reviewState.queue.length || reviewState.index >= reviewState.queue.length) {
    const done = el("section", "panel review-done");
    const reviewedNow = reviewState.index;
    if (reviewState.queue.length) {
      done.appendChild(el("h2", null, "今日複習完成 🎉"));
      done.appendChild(el("p", "muted", `這輪複習了 ${reviewedNow} 張卡，休息一下吧。`));
    } else {
      done.appendChild(el("h2", null, "目前沒有到期的卡片"));
      done.appendChild(
        el("p", "muted", "用 Chrome 擴充在 YouTube 收藏單字/句子，或在課程中收藏內容，就會自動進入複習排程。"),
      );
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
    page.appendChild(done);
    return;
  }

  const card = reviewState.queue[reviewState.index];
  const progress = el("div", "review-progress", `${reviewState.index + 1} / ${reviewState.queue.length}`);
  page.appendChild(progress);

  const cardEl = el("section", "review-card");

  const badges = el("div", "review-card-badges");
  const isCapture = card.item_type === "capture";
  badges.appendChild(el("span", "tag blue", isCapture ? "YouTube" : card.item_type === "vocabulary" ? "單字" : "句子"));
  if (card.language) badges.appendChild(el("span", "tag", languageLabel(card.language)));
  cardEl.appendChild(badges);

  // 正面：詞/句
  cardEl.appendChild(el("h2", "review-card-term", card.term));
  if (card.romaji) cardEl.appendChild(el("p", "review-card-romaji", card.romaji));
  if (card.reading && card.reading !== card.term) {
    cardEl.appendChild(el("p", "review-card-reading", card.reading));
  }
  if (card.context_sentence && card.context_sentence !== card.term) {
    cardEl.appendChild(el("p", "review-card-context", card.context_sentence));
  }

  // 情境來源 / 影片跳轉
  const source = el("div", "review-card-source");
  if (isCapture) {
    const url = videoJumpUrl(card);
    if (url) {
      const link = el("a", "review-video-link", `▶ 跳回影片${card.video_title ? "：" + card.video_title : ""}`);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      source.appendChild(link);
    }
  } else if (card.scenario_title || card.course_title) {
    source.appendChild(el("span", "muted", [card.scenario_title, card.course_title].filter(Boolean).join(" · ")));
  }
  if (source.childNodes.length) cardEl.appendChild(source);

  {
    // 課程項目用預錄音檔；YouTube 收藏（無音檔）用免費瀏覽器語音合成發音。
    const play = el("button", "ghost-button review-audio");
    play.type = "button";
    play.appendChild(
      createSvgIcon(["M11 5 6 9H2v6h4l5 4z", "M15.54 8.46a5 5 0 0 1 0 7.07", "M19.07 4.93a10 10 0 0 1 0 14.14"], 16),
    );
    play.appendChild(el("span", null, "播放發音"));
    play.addEventListener("click", () => {
      if (card.audio_url) playAudioUrl(card.audio_url, { label: "複習" });
      else playTts(card.term, card.language);
    });
    cardEl.appendChild(play);
  }

  // 背面：翻譯
  if (reviewState.flipped) {
    const back = el("div", "review-card-back");
    back.appendChild(el("p", "review-card-answer", card.translation || "（無翻譯）"));
    cardEl.appendChild(back);
  }

  // 操作區
  const actions = el("div", "review-actions");
  if (!reviewState.flipped) {
    const showBtn = el("button", "primary-button review-flip", "顯示答案");
    showBtn.type = "button";
    showBtn.addEventListener("click", () => {
      reviewState.flipped = true;
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

  page.appendChild(cardEl);
}

window.learnflowReview = {
  onEnter: reviewOnEnter,
  renderView: renderReviewView,
};
