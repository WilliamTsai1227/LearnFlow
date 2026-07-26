/**
 * LearnFlow 擴充 — content script（YouTube）
 * 讓字幕可點：點字幕上的字 → 呼叫翻譯 → 顯示浮動卡，可儲存單字/整句與影片時間點。
 * 所有需驗證的 API 呼叫都交給 background（token 只留在背景）。
 */

(function () {
  // ── 設定 ──────────────────────────────────────────────────
  // content script 可直接讀寫 chrome.storage.local，不必繞 background；
  // 監聽 onChanged 讓 popup 與播放器內設定面板兩邊即時同步。
  const DEFAULT_SETTINGS = {
    apiBase: "http://localhost",
    targetLanguage: "zh-TW",
    sourceLanguage: "japanese",
    enabled: true,
    showSubtitleTranslation: true,
    hoverPause: false,
    captionScale: 100,
  };
  let settings = { ...DEFAULT_SETTINGS };

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS), (cfg) => {
          settings = { ...DEFAULT_SETTINGS, ...(cfg || {}) };
          if (settings.apiBase) settings.apiBase = String(settings.apiBase).replace(/\/$/, "");
          resolve(settings);
        });
      } catch (err) {
        resolve(settings); // context 失效：用預設值，稍後提示重整
      }
    });
  }

  function saveSetting(key, value) {
    settings[key] = value;
    try {
      chrome.storage.local.set({ [key]: value });
    } catch (err) {
      if (isContextInvalidated(err)) handleContextInvalidated();
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let touched = false;
      for (const k of Object.keys(changes)) {
        if (k in DEFAULT_SETTINGS) {
          settings[k] = changes[k].newValue;
          touched = true;
        }
      }
      if (touched) applySettings();
    });
  } catch (err) {
    /* context 失效，忽略 */
  }

  // ── 影片資訊 ──────────────────────────────────────────────
  function getVideoId() {
    return new URLSearchParams(location.search).get("v") || "";
  }
  function getVideoUrl() {
    const id = getVideoId();
    return id ? `https://www.youtube.com/watch?v=${id}` : location.href;
  }
  function getCurrentTime() {
    const v = document.querySelector("video");
    return v ? Math.max(0, Math.floor(v.currentTime)) : 0;
  }
  function getVideoTitle() {
    const h1 = document.querySelector("h1.ytd-watch-metadata, h1.title");
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();
    return document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();
  }

  // ── 字幕文字擷取 ──────────────────────────────────────────
  function wordAtPoint(x, y) {
    const range = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(x, y)
      : null;
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const text = range.startContainer.textContent || "";
    const i = range.startOffset;
    const isBoundary = (c) => /[\s.,!?;:"'—…、。！？，「」（）()]/.test(c);
    let start = i;
    let end = i;
    while (start > 0 && !isBoundary(text[start - 1])) start--;
    while (end < text.length && !isBoundary(text[end])) end++;
    return text.slice(start, end).trim();
  }

  function captionLineText(seg) {
    const line = seg.closest(".caption-visual-line") || seg.parentElement;
    if (!line) return seg.textContent.trim();
    const segs = line.querySelectorAll(".ytp-caption-segment");
    if (!segs.length) return line.textContent.trim();
    return Array.from(segs).map((s) => s.textContent).join("").trim();
  }

  // ── 發音（免費瀏覽器語音合成）────────────────────────────
  function speakerSvg() {
    const NS = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", "15");
    s.setAttribute("height", "15");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    ["M11 5 6 9H2v6h4l5 4z", "M15.54 8.46a5 5 0 0 1 0 7.07", "M19.07 4.93a10 10 0 0 1 0 14.14"].forEach((d) => {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      s.appendChild(p);
    });
    return s;
  }
  function speakBrowserFallback(text) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = settings.sourceLanguage === "english" ? "en-US" : "ja-JP";
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  let ttsAudioEl = null;
  function base64ToBlobUrl(base64, mime) {
    const bytes = atob(base64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mime }));
  }

  // 發音優先走後端 edge-tts（跟 LearnFlow 課程音檔同一套類神經語音，比瀏覽器內建好聽很多）；
  // 失敗（離線/未登入/服務問題）才退回瀏覽器內建語音，確保至少有聲音。
  async function speakOut(text) {
    if (!text) return;
    const resp = await sendMessage({
      action: "tts",
      payload: { text, language: settings.sourceLanguage },
    });
    if (resp && resp.ok) {
      if (ttsAudioEl) {
        ttsAudioEl.pause();
        if (ttsAudioEl.src) URL.revokeObjectURL(ttsAudioEl.src);
      }
      const url = base64ToBlobUrl(resp.data.base64, resp.data.mime);
      ttsAudioEl = new Audio(url);
      ttsAudioEl.play().catch(() => speakBrowserFallback(text));
      return;
    }
    speakBrowserFallback(text);
  }

  // ── 浮動卡 ────────────────────────────────────────────────
  let card = null;
  const cardState = {
    term: "",
    line: "",
    translation: null,
    reading: null,
    romaji: null,
    lineTranslation: null,
    time: 0,
    videoId: "",
    videoUrl: "",
    videoTitle: "",
  };

  function ensureCard() {
    if (card) return card;
    card = document.createElement("div");
    card.id = "lf-card";
    card.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(card);
    return card;
  }

  function hideCard() {
    if (card) card.style.display = "none";
  }

  function positionCard(x, y) {
    const c = ensureCard();
    c.style.display = "block";
    const pad = 12;
    const w = 300;
    let left = x - w / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    let top = y - 20 - c.offsetHeight;
    if (top < pad) top = y + 24;
    c.style.left = `${left}px`;
    c.style.top = `${top}px`;
  }

  function renderCard() {
    const c = ensureCard();
    c.innerHTML = "";

    const close = document.createElement("button");
    close.className = "lf-card-close";
    close.textContent = "×";
    close.addEventListener("click", hideCard);
    c.appendChild(close);

    const termRow = document.createElement("div");
    termRow.className = "lf-card-term-row";
    const term = document.createElement("div");
    term.className = "lf-card-term";
    term.textContent = cardState.term;
    termRow.appendChild(term);
    const speak = document.createElement("button");
    speak.className = "lf-speak";
    speak.title = "發音";
    speak.appendChild(speakerSvg());
    speak.addEventListener("click", () => speakOut(cardState.term));
    termRow.appendChild(speak);
    c.appendChild(termRow);

    // 單字（在句中的字義）
    const wordLabel = document.createElement("div");
    wordLabel.className = "lf-card-label";
    wordLabel.textContent = "單字";
    c.appendChild(wordLabel);

    const tr = document.createElement("div");
    tr.className = "lf-card-translation";
    tr.textContent =
      cardState.translation == null ? "翻譯中…" : cardState.translation || "（無翻譯）";
    c.appendChild(tr);

    if (cardState.romaji) {
      const r = document.createElement("div");
      r.className = "lf-card-romaji";
      r.textContent = cardState.romaji;
      c.appendChild(r);
    }
    if (cardState.reading && cardState.reading !== cardState.term) {
      const rd = document.createElement("div");
      rd.className = "lf-card-reading";
      rd.textContent = cardState.reading;
      c.appendChild(rd);
    }

    // 整句（這句話真正要表達的意思）— 有整句且不等於單字時才顯示
    if (cardState.line && cardState.line !== cardState.term) {
      const sentLabel = document.createElement("div");
      sentLabel.className = "lf-card-label";
      sentLabel.textContent = "整句";
      c.appendChild(sentLabel);

      const sentCtx = document.createElement("div");
      sentCtx.className = "lf-card-context";
      sentCtx.textContent = cardState.line;
      c.appendChild(sentCtx);

      const sentRow = document.createElement("div");
      sentRow.className = "lf-card-sentence-row";
      const sentTr = document.createElement("div");
      sentTr.className = "lf-card-sentence";
      sentTr.textContent =
        cardState.lineTranslation == null ? "翻譯中…" : cardState.lineTranslation || "（無翻譯）";
      sentRow.appendChild(sentTr);

      const sentSpeak = document.createElement("button");
      sentSpeak.className = "lf-speak";
      sentSpeak.title = "朗讀整句";
      sentSpeak.appendChild(speakerSvg());
      sentSpeak.addEventListener("click", () => speakOut(cardState.line));
      sentRow.appendChild(sentSpeak);
      c.appendChild(sentRow);
    }

    const actions = document.createElement("div");
    actions.className = "lf-card-actions";
    // 只有「收藏單字」一個選項；系統實際會連整句與前後文一起保存
    const saveWord = document.createElement("button");
    saveWord.className = "lf-btn lf-btn-primary";
    saveWord.textContent = "＋ 收藏單字";
    saveWord.addEventListener("click", () => saveCapture(saveWord));
    actions.appendChild(saveWord);
    c.appendChild(actions);

    const status = document.createElement("div");
    status.className = "lf-card-status";
    status.id = "lf-card-status";
    c.appendChild(status);
  }

  function setStatus(text, kind) {
    const s = document.getElementById("lf-card-status");
    if (s) {
      s.textContent = text;
      s.className = `lf-card-status ${kind || ""}`;
    }
  }

  // 擴充被重新載入（chrome://extensions 按 reload）後，舊分頁裡殘留的 content script
  // 會與已被替換的擴充失去連線，呼叫 chrome.runtime.* 會「同步拋出」
  // Extension context invalidated。這裡統一攔下來，提示使用者重整分頁，
  // 而不是讓未捕捉的錯誤一直噴。
  let contextInvalidated = false;

  function isContextInvalidated(err) {
    return /Extension context invalidated|Receiving end does not exist|message port closed/i.test(
      String((err && err.message) || err || ""),
    );
  }

  function handleContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    hideOverlay();
    hideCard();
    showPlayerToast("LearnFlow 已更新，請重新整理此分頁以繼續使用");
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      if (contextInvalidated) {
        resolve({ ok: false, error: "擴充已更新，請重新整理分頁" });
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            if (isContextInvalidated(err)) handleContextInvalidated();
            resolve({ ok: false, error: err.message });
          } else {
            resolve(resp);
          }
        });
      } catch (err) {
        // context 失效時是同步拋出，callback 不會被呼叫
        if (isContextInvalidated(err)) handleContextInvalidated();
        resolve({ ok: false, error: (err && err.message) || String(err) });
      }
    });
  }

  function translateReq(text) {
    return sendMessage({
      action: "translate",
      payload: {
        term: text,
        context_sentence: cardState.line,
        source_language: settings.sourceLanguage,
        target_language: settings.targetLanguage,
      },
    });
  }

  async function openCard(term, line, x, y) {
    if (!term) return;
    const pausedTime = getCurrentTime();
    Object.assign(cardState, {
      term,
      line,
      translation: null,
      reading: null,
      romaji: null,
      lineTranslation: null,
      time: pausedTime,
      videoId: getVideoId(),
      videoUrl: getVideoUrl(),
      videoTitle: getVideoTitle(),
    });
    const hasSentence = !!(line && line !== term);
    renderCard();
    positionCard(x, y);

    // 平行翻譯：整句（真正意思）+ 單字（句中字義）
    const [wordResp, sentResp] = await Promise.all([
      translateReq(term),
      hasSentence ? translateReq(line) : Promise.resolve(null),
    ]);

    if (wordResp && wordResp.ok) {
      cardState.translation = wordResp.data.translation || "";
      cardState.reading = wordResp.data.reading || null;
      cardState.romaji = wordResp.data.romaji || null;
    } else {
      cardState.translation = "翻譯失敗";
      setStatus((wordResp && wordResp.error) || "翻譯失敗，請確認已登入 LearnFlow", "error");
    }
    if (hasSentence) {
      cardState.lineTranslation =
        sentResp && sentResp.ok ? sentResp.data.translation || "" : "";
    }
    renderCard();
    positionCard(x, y);
  }

  // 只收藏「單字」，但實際寫入的是：單字 + 完整句子 + 前兩句（後兩句稍後回填）
  async function saveCapture(btn) {
    btn.disabled = true;
    setStatus("儲存中…", "");

    const line = cardState.line || cardState.term;
    // 整句翻譯在點字時已平行取得；萬一失敗才補查一次
    if (line && !cardState.lineTranslation) {
      const resp = await translateReq(line);
      if (resp && resp.ok) cardState.lineTranslation = resp.data.translation;
    }

    // 前兩句：從字幕歷史取當前句之前的內容
    const before = captionHistory
      .filter((h) => h.text !== line)
      .slice(-CONTEXT_LINES)
      .map((h) => ({ text: h.text, translation: h.translation || null }));

    const payload = {
      kind: "word",
      language: settings.sourceLanguage,
      term: cardState.term,
      context_sentence: line || null,
      translation: cardState.translation === "翻譯失敗" ? null : cardState.translation || null,
      sentence_translation: cardState.lineTranslation || null,
      context_before: before,
      context_after: [],
      reading: cardState.reading,
      romaji: cardState.romaji,
      video_id: cardState.videoId,
      video_url: cardState.videoUrl,
      video_title: cardState.videoTitle,
      start_seconds: cardState.time,
    };
    const resp = await sendMessage({ action: "capture", payload });
    btn.disabled = false;
    if (resp && resp.ok) {
      setStatus("已收藏，已排入複習 ✓", "ok");
      savedTerms.add(normalizeTerm(cardState.term));
      renderCaptionTokens(lastTranslatedText);
      // 後兩句尚未播出，登記等待回填
      if (resp.data && resp.data.id) {
        pendingContexts.push({ captureId: resp.data.id, lines: [], baseText: line });
      }
    } else {
      setStatus((resp && resp.error) || "收藏失敗", "error");
    }
  }

  // ══════════════════════════════════════════════════════════
  //  播放器內控制列：開啟／關閉 pill ＋ 齒輪設定
  // ══════════════════════════════════════════════════════════
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgIcon(paths, size) {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", String(size));
    s.setAttribute("height", String(size));
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    paths.forEach((d) => {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      s.appendChild(p);
    });
    return s;
  }

  function gearIcon() {
    const s = svgIcon(
      [
        "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      ],
      15,
    );
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "12");
    c.setAttribute("cy", "12");
    c.setAttribute("r", "3");
    s.appendChild(c);
    return s;
  }

  function updatePill() {
    const pill = document.getElementById("lf-toggle");
    if (!pill) return;
    pill.classList.toggle("lf-on", !!settings.enabled);
    pill.title = `LearnFlow：${settings.enabled ? "開啟" : "關閉"}`;
    const label = pill.querySelector(".lf-pill-text");
    if (label) label.textContent = settings.enabled ? "開啟" : "關閉";
  }

  function injectPlayerControls() {
    const rightControls = document.querySelector("#movie_player .ytp-right-controls");
    if (!rightControls || document.getElementById("lf-toggle")) return;

    const pill = document.createElement("button");
    pill.id = "lf-toggle";
    pill.className = "ytp-button lf-pill";
    const dot = document.createElement("span");
    dot.className = "lf-pill-dot";
    const text = document.createElement("span");
    text.className = "lf-pill-text";
    pill.appendChild(dot);
    pill.appendChild(text);
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      saveSetting("enabled", !settings.enabled);
      applySettings();
    });

    const gear = document.createElement("button");
    gear.id = "lf-gear";
    gear.className = "ytp-button lf-gear";
    gear.title = "LearnFlow 設定";
    gear.appendChild(gearIcon());
    gear.addEventListener("click", (e) => {
      e.stopPropagation();
      openSettingsModal();
    });

    rightControls.insertBefore(gear, rightControls.firstChild);
    rightControls.insertBefore(pill, rightControls.firstChild);
    updatePill();
  }

  // YouTube 是 SPA：換影片時播放器 DOM 會被重建，按鈕會不見。
  // 用 observer 持續確保按鈕存在（比監聽 yt-navigate-finish 可靠）。
  // YouTube 每秒會產生大量 DOM 變動，因此節流成最多每 500ms 檢查一次，避免卡頓。
  let rescanQueued = false;
  function queueRescan() {
    if (rescanQueued) return;
    rescanQueued = true;
    setTimeout(() => {
      rescanQueued = false;
      injectPlayerControls();
      attachCaptionObserver();
    }, 500);
  }

  function watchPlayerControls() {
    injectPlayerControls();
    const obs = new MutationObserver(queueRescan);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ══════════════════════════════════════════════════════════
  //  斷詞（把字幕拆成一個個可點的單字）
  //  日文：TinySegmenter（vendor/，BSD）——Chrome 內建 Intl.Segmenter 對日文會
  //        過度切分（もらった→も|ら|っ|た），對學習者沒用，故改用它。
  //  英文：Intl.Segmenter（原生，正確處理縮寫如 don't），失敗才退回空白切分。
  // ══════════════════════════════════════════════════════════
  let jaSegmenter = null;
  let enSegmenter = null;

  function tokenize(text, language) {
    if (!text) return [];
    try {
      if (language === "japanese") {
        if (!jaSegmenter && typeof TinySegmenter === "function") {
          jaSegmenter = new TinySegmenter();
        }
        if (jaSegmenter) return jaSegmenter.segment(text).filter((t) => t.trim());
      } else {
        if (!enSegmenter && typeof Intl !== "undefined" && Intl.Segmenter) {
          enSegmenter = new Intl.Segmenter(language === "english" ? "en" : undefined, {
            granularity: "word",
          });
        }
        if (enSegmenter) {
          return [...enSegmenter.segment(text)]
            .map((s) => s.segment)
            .filter((t) => t.trim());
        }
      }
    } catch (err) {
      /* 落到下方退路 */
    }
    // 退路：英文用空白切、日文整句一塊（至少不會壞掉）
    return language === "japanese" ? [text] : text.split(/\s+/).filter(Boolean);
  }

  // 只有「像詞」的 token 才可點（標點、純空白不可點）
  function isWordLike(token) {
    return /[\p{L}\p{N}]/u.test(token);
  }

  // ══════════════════════════════════════════════════════════
  //  已收藏單字標記（對應截圖中被框起來的字）
  // ══════════════════════════════════════════════════════════
  let savedTerms = new Set();

  function normalizeTerm(t) {
    return String(t || "").trim().toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }

  // ── 被動曝光（看到 ≠ 複習）────────────────────────────────
  // 只記錄「使用者已有卡片的詞」在字幕上出現過：
  //   1. 每行字幕的每個詞都記會爆量，且沒有學習意義
  //   2. 「又遇到正在學的字」才是有價值的訊號
  // 後端只寫 context_exposures，永遠不會改動 FSRS 排程。
  const exposureQueue = [];
  const exposureSeen = new Set(); // 同一句同一詞只記一次
  const EXPOSURE_FLUSH_MS = 10000;

  function recordExposures(tokens, sentence) {
    if (!settings.enabled || !savedTerms.size) return;
    const videoId = getVideoId();
    tokens.forEach((tok) => {
      const norm = normalizeTerm(tok);
      if (!norm || !savedTerms.has(norm)) return;
      const key = `${norm}@@${sentence}`;
      if (exposureSeen.has(key)) return;
      exposureSeen.add(key);
      exposureQueue.push({
        term: tok,
        language: settings.sourceLanguage,
        video_id: videoId || null,
        sentence: sentence || null,
      });
    });
  }

  function flushExposures() {
    if (!exposureQueue.length) return;
    const batch = exposureQueue.splice(0, exposureQueue.length);
    sendMessage({ action: "logExposures", payload: { exposures: batch } });
  }

  setInterval(flushExposures, EXPOSURE_FLUSH_MS);
  window.addEventListener("pagehide", flushExposures);

  async function loadSavedTerms() {
    const resp = await sendMessage({ action: "listCaptures" });
    if (resp && resp.ok && Array.isArray(resp.data)) {
      savedTerms = new Set(
        resp.data.filter((c) => c.kind === "word").map((c) => normalizeTerm(c.term)),
      );
      renderCaptionTokens(lastTranslatedText);
    }
  }

  // ══════════════════════════════════════════════════════════
  //  雙字幕覆蓋層
  // ══════════════════════════════════════════════════════════
  const CAPTION_CONTAINER = ".ytp-caption-window-container";
  let subOverlay = null;
  let captionObserver = null;
  let observedContainer = null;
  let debounceTimer = null;
  let lastTranslatedText = "";
  let translateFailures = 0;
  let subtitlesDisabledForSession = false;
  const lineCache = new Map(); // session 內第二層快取，DB 快取之外再擋一次

  // 字幕歷史：收藏時要一併保存「前兩句」；每筆 {text, translation}
  const captionHistory = [];
  const HISTORY_MAX = 8;

  // 收藏當下「後兩句」還沒播出，先記著，等後續字幕出現再回填到後端
  const pendingContexts = []; // {captureId, lines: [...], baseText}
  const CONTEXT_LINES = 2;

  function pushCaptionHistory(text, translation) {
    const last = captionHistory[captionHistory.length - 1];
    if (last && last.text === text) {
      if (translation && !last.translation) last.translation = translation;
      return;
    }
    captionHistory.push({ text, translation: translation || null });
    if (captionHistory.length > HISTORY_MAX) captionHistory.shift();

    // 這句是「新的一句」→ 餵給所有等待後文的收藏
    for (let i = pendingContexts.length - 1; i >= 0; i--) {
      const p = pendingContexts[i];
      if (text === p.baseText) continue; // 同一句重複出現，不算後文
      p.lines.push({ text, translation: translation || null });
      if (p.lines.length >= CONTEXT_LINES) {
        flushPendingContext(p);
        pendingContexts.splice(i, 1);
      }
    }
  }

  function flushPendingContext(p) {
    sendMessage({
      action: "updateCaptureContext",
      payload: { captureId: p.captureId, context_after: p.lines },
    });
  }

  // 離開頁面前，把還沒滿兩句的後文先送出去（有一句總比沒有好）
  window.addEventListener("pagehide", () => {
    while (pendingContexts.length) {
      const p = pendingContexts.pop();
      if (p.lines.length) flushPendingContext(p);
    }
  });

  let tokenRow = null;
  let translationRow = null;

  function ensureOverlay() {
    const player = document.querySelector("#movie_player");
    if (!player) return null;
    if (subOverlay && subOverlay.parentElement === player) return subOverlay;
    subOverlay = document.createElement("div");
    subOverlay.id = "lf-sub-overlay";
    // 懸停暫停也要涵蓋覆蓋層
    subOverlay.addEventListener("mouseenter", onCaptionEnter);
    subOverlay.addEventListener("mouseleave", onCaptionLeave);

    tokenRow = document.createElement("div");
    tokenRow.className = "lf-tokens";
    translationRow = document.createElement("div");
    translationRow.className = "lf-sub-tr";
    subOverlay.appendChild(tokenRow);
    subOverlay.appendChild(translationRow);

    player.appendChild(subOverlay);
    return subOverlay;
  }

  // 把字幕拆成一顆顆可點的單字（截圖中每個字都被框起來的效果）
  function renderCaptionTokens(text) {
    if (!tokenRow || !text) return;
    tokenRow.textContent = "";
    const tokens = tokenize(text, settings.sourceLanguage);
    recordExposures(tokens, text); // 被動曝光：只記已有卡片的詞，不影響排程
    tokens.forEach((tok) => {
      if (!isWordLike(tok)) {
        // 標點：跟在前一個詞後面，不做成可點的框
        const punct = document.createElement("span");
        punct.className = "lf-punct";
        punct.textContent = tok;
        tokenRow.appendChild(punct);
        return;
      }
      const chip = document.createElement("span");
      chip.className = "lf-token";
      if (savedTerms.has(normalizeTerm(tok))) chip.classList.add("lf-token-saved");
      chip.textContent = tok;
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 直接用斷好的詞，不再靠游標位置去猜詞邊界
        openCard(tok, text, e.clientX, e.clientY);
      });
      tokenRow.appendChild(chip);
    });
  }

  function hideOverlay() {
    if (subOverlay) subOverlay.style.display = "none";
    const player = document.querySelector("#movie_player");
    if (player) player.classList.remove("lf-hide-native-cc");
  }

  // 覆蓋層取代原生字幕的位置（我們已把原文以可點單字重繪，原生字幕留著會重複）。
  // 原生字幕用 opacity 隱藏而非 display:none —— 否則它的 boundingRect 會歸零，
  // 我們就失去定位基準了。
  function positionOverlay() {
    const player = document.querySelector("#movie_player");
    const container = document.querySelector(CAPTION_CONTAINER);
    const ov = subOverlay;
    if (!player || !container || !ov || ov.style.display === "none") return;

    const pRect = player.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    if (!cRect.height || !pRect.height) return;

    const scale = (settings.captionScale || 100) / 100;
    ov.style.fontSize = `${Math.round(16 * scale)}px`;

    // 以「底部對齊原生字幕底部」定位：覆蓋層比原生高（多一行翻譯）時往上長，
    // 不會往下撞到播放器控制列。
    let bottom = pRect.height - (cRect.bottom - pRect.top);
    const maxBottom = pRect.height - ov.offsetHeight - 8;
    bottom = Math.max(8, Math.min(bottom, Math.max(8, maxBottom)));
    ov.style.bottom = `${bottom}px`;
  }

  function currentCaptionText() {
    const container = document.querySelector(CAPTION_CONTAINER);
    if (!container) return "";
    const lines = container.querySelectorAll(".caption-visual-line");
    if (lines.length) {
      return Array.from(lines)
        .map((l) =>
          Array.from(l.querySelectorAll(".ytp-caption-segment"))
            .map((s) => s.textContent)
            .join(""),
        )
        .join(" ")
        .trim();
    }
    return Array.from(container.querySelectorAll(".ytp-caption-segment"))
      .map((s) => s.textContent)
      .join(" ")
      .trim();
  }

  function subtitlesActive() {
    return (
      settings.enabled && settings.showSubtitleTranslation && !subtitlesDisabledForSession
    );
  }

  async function translateCaptionLine(text) {
    if (lineCache.has(text)) return lineCache.get(text);
    // 整句翻譯：term === context_sentence，走後端「會寫入 translation_cache」的路徑
    const resp = await sendMessage({
      action: "translate",
      payload: {
        term: text,
        context_sentence: text,
        source_language: settings.sourceLanguage,
        target_language: settings.targetLanguage,
      },
    });
    if (resp && resp.ok) {
      translateFailures = 0;
      const tr = resp.data.translation || "";
      lineCache.set(text, tr);
      return tr;
    }
    translateFailures += 1;
    // 連續失敗（多半是當日翻譯額度用盡）就停掉本次 session 的雙字幕，避免持續洗錯誤
    if (translateFailures >= 3) {
      subtitlesDisabledForSession = true;
      showPlayerToast("字幕翻譯暫停：翻譯額度可能已用盡，重新整理可再試");
      hideOverlay();
    }
    return null;
  }

  function onCaptionMutated() {
    if (!subtitlesActive()) {
      hideOverlay();
      return;
    }
    clearTimeout(debounceTimer);
    // YouTube 自動字幕是逐字增量更新的；停止變動 500ms 才視為整句定稿再翻譯，
    // 否則同一句的每個中間狀態都會送出翻譯，額度會瞬間燒光。
    debounceTimer = setTimeout(async () => {
      const text = currentCaptionText();
      if (!text) {
        hideOverlay();
        lastTranslatedText = "";
        return;
      }
      if (text === lastTranslatedText) {
        positionOverlay();
        return;
      }
      lastTranslatedText = text;

      // 先把可點的單字畫出來（不必等翻譯回來），翻譯稍後補上
      const ov = ensureOverlay();
      if (!ov) return;
      renderCaptionTokens(text);
      translationRow.textContent = "";
      ov.style.display = "block";
      const player = document.querySelector("#movie_player");
      if (player) player.classList.add("lf-hide-native-cc");
      positionOverlay();

      pushCaptionHistory(text, null);

      const tr = await translateCaptionLine(text);
      if (tr) pushCaptionHistory(text, tr); // 補上翻譯（同句不會重複 push）
      if (text !== lastTranslatedText || !subtitlesActive()) return;
      translationRow.textContent = tr || "";
      positionOverlay();
    }, 500);
  }

  function attachCaptionObserver() {
    const container = document.querySelector(CAPTION_CONTAINER);
    if (!container) {
      hideOverlay();
      observedContainer = null;
      return;
    }
    if (container === observedContainer) return;
    // CC 開關時容器會被重建，需重新掛 observer
    if (captionObserver) captionObserver.disconnect();
    observedContainer = container;
    captionObserver = new MutationObserver(onCaptionMutated);
    captionObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    container.addEventListener("mouseenter", onCaptionEnter);
    container.addEventListener("mouseleave", onCaptionLeave);
    onCaptionMutated();
  }

  // ══════════════════════════════════════════════════════════
  //  懸停自動暫停
  // ══════════════════════════════════════════════════════════
  let pausedByHover = false;
  function onCaptionEnter() {
    if (!settings.enabled || !settings.hoverPause) return;
    const v = document.querySelector("video");
    if (v && !v.paused) {
      v.pause();
      pausedByHover = true;
    }
  }
  function onCaptionLeave() {
    // 只有「我們暫停的」才續播，不覆蓋使用者自己按的暫停
    if (!pausedByHover) return;
    pausedByHover = false;
    const v = document.querySelector("video");
    if (v && v.paused) v.play().catch(() => {});
  }

  // ══════════════════════════════════════════════════════════
  //  字幕大小 & 套用設定
  // ══════════════════════════════════════════════════════════
  function applySettings() {
    const player = document.querySelector("#movie_player");
    if (player) {
      // YouTube 在 .ytp-caption-segment 上是 inline font-size，直接改會被蓋掉，
      // 因此改用整塊 transform 縮放。
      player.style.setProperty("--lf-caption-scale", String((settings.captionScale || 100) / 100));
      player.classList.toggle("lf-scaled", (settings.captionScale || 100) !== 100);
    }
    updatePill();
    if (!subtitlesActive()) hideOverlay();
    else onCaptionMutated();
    positionOverlay();
    if (!settings.enabled) hideCard();
  }

  function showPlayerToast(msg) {
    const player = document.querySelector("#movie_player");
    if (!player) return;
    const t = document.createElement("div");
    t.className = "lf-toast";
    t.textContent = msg;
    player.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ══════════════════════════════════════════════════════════
  //  設定 modal
  // ══════════════════════════════════════════════════════════
  let modal = null;

  function modalHost() {
    return document.fullscreenElement || document.body;
  }

  function row(label, hint) {
    const r = document.createElement("div");
    r.className = "lf-row";
    const txt = document.createElement("div");
    txt.className = "lf-row-text";
    const l = document.createElement("div");
    l.className = "lf-row-label";
    l.textContent = label;
    txt.appendChild(l);
    if (hint) {
      const h = document.createElement("div");
      h.className = "lf-row-hint";
      h.textContent = hint;
      txt.appendChild(h);
    }
    r.appendChild(txt);
    return r;
  }

  function toggleControl(key) {
    const btn = document.createElement("button");
    btn.className = "lf-switch";
    const sync = () => btn.classList.toggle("on", !!settings[key]);
    sync();
    btn.addEventListener("click", () => {
      saveSetting(key, !settings[key]);
      sync();
      applySettings();
    });
    return btn;
  }

  function selectControl(key, options) {
    const sel = document.createElement("select");
    sel.className = "lf-select";
    options.forEach(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    });
    sel.value = settings[key];
    sel.addEventListener("change", () => {
      saveSetting(key, sel.value);
      // 語言改變後，之前翻譯的內容不再適用
      lineCache.clear();
      lastTranslatedText = "";
      applySettings();
    });
    return sel;
  }

  function stepperControl() {
    const wrap = document.createElement("div");
    wrap.className = "lf-stepper";
    const dec = document.createElement("button");
    dec.textContent = "−";
    const val = document.createElement("span");
    const inc = document.createElement("button");
    inc.textContent = "+";
    const sync = () => (val.textContent = `${settings.captionScale || 100}%`);
    sync();
    const step = (delta) => {
      const next = Math.min(200, Math.max(75, (settings.captionScale || 100) + delta));
      saveSetting("captionScale", next);
      sync();
      applySettings();
    };
    dec.addEventListener("click", () => step(-25));
    inc.addEventListener("click", () => step(25));
    wrap.appendChild(dec);
    wrap.appendChild(val);
    wrap.appendChild(inc);
    return wrap;
  }

  function buildModal() {
    const backdrop = document.createElement("div");
    backdrop.id = "lf-modal-backdrop";
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeSettingsModal();
    });

    const box = document.createElement("div");
    box.className = "lf-modal";
    backdrop.appendChild(box);

    const head = document.createElement("div");
    head.className = "lf-modal-head";
    const title = document.createElement("h2");
    title.textContent = "擴充功能設定";
    const close = document.createElement("button");
    close.className = "lf-modal-close";
    close.textContent = "×";
    close.addEventListener("click", closeSettingsModal);
    head.appendChild(title);
    head.appendChild(close);
    box.appendChild(head);

    const body = document.createElement("div");
    body.className = "lf-modal-body";
    box.appendChild(body);

    // 母語
    const nativeRow = row("母語", "翻譯與解釋使用的語言");
    nativeRow.classList.add("lf-row-stack");
    nativeRow.appendChild(
      selectControl("targetLanguage", [
        ["zh-TW", "繁體中文"],
        ["zh-CN", "简体中文"],
        ["en", "English"],
      ]),
    );
    body.appendChild(nativeRow);

    // 學習語言
    const learnRow = row("學習語言", "你正在學習的影片語言");
    learnRow.classList.add("lf-row-stack");
    learnRow.appendChild(
      selectControl("sourceLanguage", [
        ["japanese", "日文"],
        ["english", "英文"],
      ]),
    );
    body.appendChild(learnRow);

    // 進階設定（可摺疊）
    const advToggle = document.createElement("button");
    advToggle.className = "lf-adv-toggle";
    advToggle.textContent = "進階設定";
    const adv = document.createElement("div");
    adv.className = "lf-adv";
    advToggle.addEventListener("click", () => {
      adv.classList.toggle("open");
      advToggle.classList.toggle("open");
    });
    body.appendChild(advToggle);
    body.appendChild(adv);

    const trRow = row("顯示字幕翻譯", "在原字幕下方顯示翻譯");
    trRow.appendChild(toggleControl("showSubtitleTranslation"));
    adv.appendChild(trRow);

    const hpRow = row("懸停自動暫停", "滑鼠懸停在字幕上時暫停影片");
    hpRow.appendChild(toggleControl("hoverPause"));
    adv.appendChild(hpRow);

    const sizeRow = row("字幕大小", "調整字幕文字大小");
    sizeRow.appendChild(stepperControl());
    adv.appendChild(sizeRow);

    const info = document.createElement("div");
    info.className = "lf-info";
    info.textContent = "觀看影片時點擊字幕中的任意單字，即可獲取即時釋義並儲存到收藏。";
    body.appendChild(info);

    const done = document.createElement("button");
    done.className = "lf-done";
    done.textContent = "完成";
    done.addEventListener("click", closeSettingsModal);
    body.appendChild(done);

    return backdrop;
  }

  function openSettingsModal() {
    if (!modal) modal = buildModal();
    modalHost().appendChild(modal);
    modal.style.display = "flex";
  }

  function closeSettingsModal() {
    if (modal) modal.style.display = "none";
  }

  // 全螢幕切換時要把 modal 搬到全螢幕元素底下，否則會看不到
  document.addEventListener("fullscreenchange", () => {
    if (modal && modal.style.display === "flex") modalHost().appendChild(modal);
    positionOverlay();
  });
  window.addEventListener("resize", positionOverlay);

  // ── 事件：點字幕 ──────────────────────────────────────────
  document.addEventListener(
    "click",
    (e) => {
      const seg = e.target.closest && e.target.closest(".ytp-caption-segment");
      if (!seg) {
        // 點卡片外部關閉
        if (card && card.style.display === "block" && !card.contains(e.target)) hideCard();
        return;
      }
      if (!settings.enabled) return;
      e.preventDefault();
      e.stopPropagation();
      const word = wordAtPoint(e.clientX, e.clientY) || seg.textContent.trim();
      const line = captionLineText(seg);
      openCard(word, line, e.clientX, e.clientY);
    },
    true,
  );

  // ── 事件：選取字幕文字翻譯 ───────────────────────────────
  document.addEventListener("mouseup", (e) => {
    if (!settings.enabled) return;
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    if (!text) return;
    const anchor = sel.anchorNode && sel.anchorNode.parentElement;
    if (!anchor || !anchor.closest(".ytp-caption-window-container, .caption-window, .ytp-caption-segment")) return;
    const seg = anchor.closest(".ytp-caption-segment");
    const line = seg ? captionLineText(seg) : text;
    openCard(text, line, e.clientX, e.clientY);
  });

  // ── 啟動 ──────────────────────────────────────────────────
  loadSettings().then(() => {
    watchPlayerControls();
    attachCaptionObserver();
    applySettings();
    loadSavedTerms(); // 標記已收藏過的單字（失敗就只是不標記，不影響其他功能）
  });
})();
