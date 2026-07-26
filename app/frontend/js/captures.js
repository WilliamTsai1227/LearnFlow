/**
 * YouTube 收藏 — 顯示 Chrome 擴充從 YouTube 擷取的單字
 * 依影片分組；每張卡＝單字 + 所在整句（可展開前後文、可顯示翻譯）
 * 依賴 app.js 全域：el, clear, render, navigateTo, createSvgIcon, languageLabel, playTts, showToast
 * 依賴 auth.js 全域：authFetch, AUTH_API
 */

const capturesState = {
  loading: false,
  loaded: false,
  error: "",
  items: [],
  expandedContext: new Set(), // 展開上下文的卡片 id
  shownTranslation: new Set(), // 已顯示翻譯的卡片 id
};

async function capturesOnEnter() {
  await loadCaptures();
  render();
}

async function loadCaptures() {
  capturesState.loading = true;
  capturesState.error = "";
  render();
  try {
    const res = await authFetch(`${AUTH_API}/captures?limit=100`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    capturesState.items = await res.json();
    capturesState.loaded = true;
  } catch (err) {
    capturesState.error = err.message || "無法載入 YouTube 收藏";
  } finally {
    capturesState.loading = false;
  }
}

async function removeCapture(id) {
  try {
    const res = await authFetch(`${AUTH_API}/captures/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
    capturesState.items = capturesState.items.filter((c) => c.id !== id);
    if (typeof showToast === "function") showToast("已移除收藏", { type: "info", duration: 2000 });
    render();
  } catch (err) {
    if (typeof showToast === "function") {
      showToast(err.message || "移除失敗", { type: "error", title: "YouTube 收藏" });
    }
  }
}

// 防禦性檢查：只允許 https youtube.com/youtu.be，避免 video_url 被當成 href 時
// 執行 javascript:/data: 等危險 scheme（後端已驗證，這裡是第二層保險）。
function captureJumpUrl(item, seconds) {
  if (!/^https:\/\/(www\.youtube\.com|youtu\.be)\//.test(item.video_url)) return null;
  const t = Math.floor(seconds != null ? seconds : item.start_seconds || 0);
  const sep = item.video_url.includes("?") ? "&" : "?";
  return `${item.video_url}${sep}t=${t}s`;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** 把整句中的單字標記出來（其餘原樣顯示）。找不到就整句純文字。 */
function sentenceWithHighlight(sentence, term) {
  const wrap = el("span", "cap-sentence-text");
  if (!sentence) return wrap;
  const idx = term ? sentence.toLowerCase().indexOf(String(term).toLowerCase()) : -1;
  if (!term || idx === -1) {
    wrap.textContent = sentence;
    return wrap;
  }
  if (idx > 0) wrap.appendChild(document.createTextNode(sentence.slice(0, idx)));
  wrap.appendChild(el("span", "cap-term-mark", sentence.slice(idx, idx + term.length)));
  const rest = sentence.slice(idx + term.length);
  if (rest) wrap.appendChild(document.createTextNode(rest));
  return wrap;
}

/** 上下文的一行：原文 + （若有）翻譯 */
function contextLine(line, cls) {
  const box = el("div", `cap-ctx-line ${cls || ""}`);
  box.appendChild(el("div", "cap-ctx-text", line.text));
  if (line.translation) box.appendChild(el("div", "cap-ctx-tr", line.translation));
  return box;
}

function buildCaptureCard(item) {
  const card = el("article", "cap-card");

  // 標頭：語言標籤、時間點、移除
  const top = el("div", "cap-card-top");
  const tags = el("div", "tag-row");
  tags.appendChild(el("span", "tag", languageLabel(item.language)));
  tags.appendChild(el("span", "cap-time", formatTime(item.start_seconds)));
  top.appendChild(tags);

  const removeBtn = el("button", "favorite-remove-btn");
  removeBtn.type = "button";
  removeBtn.setAttribute("aria-label", "移除收藏");
  removeBtn.appendChild(createSvgIcon(["M18 6 6 18", "M6 6l12 12"], 16));
  removeBtn.addEventListener("click", () => removeCapture(item.id));
  top.appendChild(removeBtn);
  card.appendChild(top);

  // 主體：單字（大標）+ 發音
  const head = el("div", "cap-word-row");
  head.appendChild(el("h3", "cap-word", item.term));
  const speak = el("button", "cap-icon-btn");
  speak.type = "button";
  speak.setAttribute("aria-label", "播放發音");
  speak.appendChild(
    createSvgIcon(
      ["M11 5 6 9H2v6h4l5 4z", "M15.54 8.46a5 5 0 0 1 0 7.07", "M19.07 4.93a10 10 0 0 1 0 14.14"],
      15,
    ),
  );
  speak.addEventListener("click", () => playTts(item.term, item.language));
  head.appendChild(speak);
  card.appendChild(head);

  if (item.romaji) card.appendChild(el("p", "cap-romaji", item.romaji));
  if (item.reading && item.reading !== item.term) {
    card.appendChild(el("p", "cap-reading", item.reading));
  }
  if (item.translation) card.appendChild(el("p", "cap-word-tr", item.translation));

  // 整句（單字標記其中）+ 發音 + 展開上下文
  const sentence = item.context_sentence;
  if (sentence) {
    const sentRow = el("div", "cap-sentence-row");
    sentRow.appendChild(sentenceWithHighlight(sentence, item.term));

    const sentSpeak = el("button", "cap-icon-btn");
    sentSpeak.type = "button";
    sentSpeak.setAttribute("aria-label", "朗讀整句");
    sentSpeak.appendChild(
      createSvgIcon(
        ["M11 5 6 9H2v6h4l5 4z", "M15.54 8.46a5 5 0 0 1 0 7.07", "M19.07 4.93a10 10 0 0 1 0 14.14"],
        14,
      ),
    );
    sentSpeak.addEventListener("click", () => playTts(sentence, item.language));
    sentRow.appendChild(sentSpeak);

    const hasContext =
      (item.context_before && item.context_before.length) ||
      (item.context_after && item.context_after.length);
    if (hasContext) {
      const expanded = capturesState.expandedContext.has(item.id);
      const ctxBtn = el("button", "cap-icon-btn");
      ctxBtn.type = "button";
      ctxBtn.title = expanded ? "收合上下文" : "顯示上下文";
      ctxBtn.setAttribute("aria-label", ctxBtn.title);
      ctxBtn.appendChild(createSvgIcon([expanded ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"], 15));
      ctxBtn.addEventListener("click", () => {
        if (expanded) capturesState.expandedContext.delete(item.id);
        else capturesState.expandedContext.add(item.id);
        render();
      });
      sentRow.appendChild(ctxBtn);
    }
    card.appendChild(sentRow);

    // 顯示翻譯（整句）
    const showTr = capturesState.shownTranslation.has(item.id);
    if (item.sentence_translation) {
      if (showTr) {
        card.appendChild(el("p", "cap-sentence-tr", item.sentence_translation));
      } else {
        const trBtn = el("button", "cap-show-tr", "顯示翻譯");
        trBtn.type = "button";
        trBtn.addEventListener("click", () => {
          capturesState.shownTranslation.add(item.id);
          render();
        });
        card.appendChild(trBtn);
      }
    }

    // 上下文展開：前兩句 → 當前句 → 後兩句
    if (capturesState.expandedContext.has(item.id)) {
      const ctx = el("div", "cap-context");
      (item.context_before || []).forEach((l) => ctx.appendChild(contextLine(l)));
      const cur = el("div", "cap-ctx-line cap-ctx-current");
      cur.appendChild(sentenceWithHighlight(sentence, item.term));
      if (item.sentence_translation) {
        cur.appendChild(el("div", "cap-ctx-tr", item.sentence_translation));
      }
      ctx.appendChild(cur);
      (item.context_after || []).forEach((l) => ctx.appendChild(contextLine(l)));
      card.appendChild(ctx);
    }
  }

  // 跳回影片
  const actions = el("div", "cap-card-actions");
  const jumpUrl = captureJumpUrl(item);
  if (jumpUrl) {
    const jump = el("a", "cap-action");
    jump.href = jumpUrl;
    jump.target = "_blank";
    jump.rel = "noopener noreferrer";
    jump.appendChild(createSvgIcon(["m5 3 14 9-14 9V3z"], 15));
    jump.appendChild(el("span", null, "跳回影片"));
    actions.appendChild(jump);
  }
  card.appendChild(actions);

  return card;
}

/** 依影片分組，保留「最近收藏的影片排前面」的順序 */
function groupByVideo(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = item.video_id || "unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        videoId: key,
        title: item.video_title || "YouTube 影片",
        url: item.video_url,
        items: [],
      });
    }
    groups.get(key).items.push(item);
  });
  // 每組內依影片時間軸排序，較符合「重看這支片」的閱讀順序
  groups.forEach((g) => g.items.sort((a, b) => (a.start_seconds || 0) - (b.start_seconds || 0)));
  return [...groups.values()];
}

function renderCapturesInto(page) {
  if (capturesState.loading) {
    const panel = el("section", "panel");
    panel.appendChild(el("p", "muted", "載入 YouTube 收藏中…"));
    page.appendChild(panel);
    return;
  }

  if (capturesState.error) {
    const panel = el("section", "panel favorites-setup-error");
    panel.appendChild(el("h2", null, "無法載入 YouTube 收藏"));
    panel.appendChild(el("p", "muted", capturesState.error));
    page.appendChild(panel);
    return;
  }

  if (!capturesState.loaded) {
    // 尚未觸發載入（首次切到分頁）——由 onEnter 觸發，這裡先顯示空
    capturesOnEnter();
    return;
  }

  if (!capturesState.items.length) {
    const empty = el("section", "panel favorites-empty");
    empty.appendChild(el("h2", null, "尚無 YouTube 收藏"));
    empty.appendChild(
      el(
        "p",
        "muted",
        "安裝 LearnFlow Chrome 擴充，在 YouTube 開啟字幕、點單字看翻譯並收藏，就會出現在這裡並自動進入複習排程。",
      ),
    );
    page.appendChild(empty);
    return;
  }

  groupByVideo(capturesState.items).forEach((group) => {
    const section = el("section", "cap-video-group");

    const header = el("div", "cap-video-header");
    const titleWrap = el("div", "cap-video-title-wrap");
    titleWrap.appendChild(el("h2", "cap-video-title", group.title));
    titleWrap.appendChild(el("span", "cap-video-count", `${group.items.length} 個單字`));
    header.appendChild(titleWrap);

    if (/^https:\/\/(www\.youtube\.com|youtu\.be)\//.test(group.url || "")) {
      const open = el("a", "cap-action cap-video-open");
      open.href = group.url;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.appendChild(createSvgIcon(["m5 3 14 9-14 9V3z"], 14));
      open.appendChild(el("span", null, "開啟影片"));
      header.appendChild(open);
    }
    section.appendChild(header);

    const list = el("div", "cap-card-grid");
    group.items.forEach((item) => list.appendChild(buildCaptureCard(item)));
    section.appendChild(list);

    page.appendChild(section);
  });
}

window.learnflowCaptures = {
  onEnter: capturesOnEnter,
  renderInto: renderCapturesInto,
};
