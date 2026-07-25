/**
 * YouTube 收藏 — 顯示 Chrome 擴充從 YouTube 擷取的單字/句子
 * 依賴 app.js 全域：el, clear, render, navigateTo, createSvgIcon, languageLabel
 * 依賴 auth.js 全域：authFetch, AUTH_API
 */

const capturesState = {
  loading: false,
  loaded: false,
  error: "",
  items: [],
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
function captureJumpUrl(item) {
  if (!/^https:\/\/(www\.youtube\.com|youtu\.be)\//.test(item.video_url)) return null;
  const t = Math.floor(item.start_seconds || 0);
  const sep = item.video_url.includes("?") ? "&" : "?";
  return `${item.video_url}${sep}t=${t}s`;
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
      el("p", "muted", "安裝 LearnFlow Chrome 擴充，在 YouTube 開啟字幕、點單字看翻譯並收藏，就會出現在這裡並自動進入複習排程。"),
    );
    page.appendChild(empty);
    return;
  }

  const list = el("section", "favorites-list");
  capturesState.items.forEach((item) => {
    const card = el("article", "favorite-card");

    const top = el("div", "favorite-card-top");
    const tags = el("div", "tag-row");
    tags.appendChild(el("span", "tag blue", item.kind === "word" ? "單字" : "句子"));
    tags.appendChild(el("span", "tag", languageLabel(item.language)));
    top.appendChild(tags);

    const removeBtn = el("button", "favorite-remove-btn");
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", "移除收藏");
    removeBtn.appendChild(createSvgIcon(["M18 6 6 18", "M6 6l12 12"], 16));
    removeBtn.addEventListener("click", () => removeCapture(item.id));
    top.appendChild(removeBtn);
    card.appendChild(top);

    card.appendChild(el("h3", "favorite-card-title", item.term));
    if (item.romaji) card.appendChild(el("p", "favorite-card-romaji", item.romaji));
    if (item.reading && item.reading !== item.term) {
      card.appendChild(el("p", "favorite-card-reading", item.reading));
    }
    if (item.translation) card.appendChild(el("p", "favorite-card-meaning", item.translation));
    if (item.context_sentence && item.context_sentence !== item.term) {
      card.appendChild(el("p", "favorite-card-example", item.context_sentence));
    }

    const meta = el("div", "favorite-card-meta");
    meta.appendChild(el("span", null, item.video_title || "YouTube"));
    card.appendChild(meta);

    const actions = el("div", "favorite-card-actions cap-actions");

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

    // 免費發音（瀏覽器語音合成）
    const speak = el("button", "cap-action");
    speak.type = "button";
    speak.appendChild(
      createSvgIcon(["M11 5 6 9H2v6h4l5 4z", "M15.54 8.46a5 5 0 0 1 0 7.07", "M19.07 4.93a10 10 0 0 1 0 14.14"], 15),
    );
    speak.appendChild(el("span", null, "播放"));
    speak.addEventListener("click", () => playTts(item.term, item.language));
    actions.appendChild(speak);

    card.appendChild(actions);

    list.appendChild(card);
  });
  page.appendChild(list);
}

window.learnflowCaptures = {
  onEnter: capturesOnEnter,
  renderInto: renderCapturesInto,
};
