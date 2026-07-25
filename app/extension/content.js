/**
 * LearnFlow 擴充 — content script（YouTube）
 * 讓字幕可點：點字幕上的字 → 呼叫翻譯 → 顯示浮動卡，可儲存單字/整句與影片時間點。
 * 所有需驗證的 API 呼叫都交給 background（token 只留在背景）。
 */

(function () {
  let settings = { apiBase: "http://localhost", targetLanguage: "zh-TW", sourceLanguage: "japanese" };

  chrome.runtime.sendMessage({ action: "getSettings" }, (resp) => {
    if (resp && resp.ok) settings = resp.data;
  });

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
    const saveWord = document.createElement("button");
    saveWord.className = "lf-btn lf-btn-primary";
    saveWord.textContent = "＋ 儲存單字";
    saveWord.addEventListener("click", () => saveCapture("word", saveWord));
    const saveSentence = document.createElement("button");
    saveSentence.className = "lf-btn";
    saveSentence.textContent = "＋ 儲存整句";
    saveSentence.addEventListener("click", () => saveCapture("sentence", saveSentence));
    actions.appendChild(saveWord);
    actions.appendChild(saveSentence);
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

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp);
        }
      });
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

  async function saveCapture(kind, btn) {
    btn.disabled = true;
    setStatus("儲存中…", "");
    let translation = cardState.translation === "翻譯失敗" ? null : cardState.translation;

    if (kind === "sentence") {
      // 整句翻譯在點字時已平行取得；萬一失敗才補查一次
      if (!cardState.lineTranslation) {
        const resp = await translateReq(cardState.line);
        if (resp && resp.ok) cardState.lineTranslation = resp.data.translation;
      }
      translation = cardState.lineTranslation || null;
    }

    const payload = {
      kind,
      language: settings.sourceLanguage,
      term: kind === "word" ? cardState.term : cardState.line || cardState.term,
      context_sentence: cardState.line || null,
      translation: translation || null,
      reading: kind === "word" ? cardState.reading : null,
      romaji: kind === "word" ? cardState.romaji : null,
      video_id: cardState.videoId,
      video_url: cardState.videoUrl,
      video_title: cardState.videoTitle,
      start_seconds: cardState.time,
    };
    const resp = await sendMessage({ action: "capture", payload });
    btn.disabled = false;
    if (resp && resp.ok) {
      setStatus("已收藏，已排入複習 ✓", "ok");
    } else {
      setStatus((resp && resp.error) || "收藏失敗", "error");
    }
  }

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
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    if (!text) return;
    const anchor = sel.anchorNode && sel.anchorNode.parentElement;
    if (!anchor || !anchor.closest(".ytp-caption-window-container, .caption-window, .ytp-caption-segment")) return;
    const seg = anchor.closest(".ytp-caption-segment");
    const line = seg ? captionLineText(seg) : text;
    openCard(text, line, e.clientX, e.clientY);
  });
})();
