/**
 * 筆記 — Figma 式單一畫布：所有上傳的 PDF / Word 直接攤在同一個點陣白底大空間上，
 * 每份文件都能直接縮放、拖曳、螢光筆標記、選字右鍵留言。
 *
 * comment 呈現方式：不顯示圖標，改在文字下方畫「淡綠色底線」；滑鼠移過去是手指游標，
 * 點一下顯示留言泡泡、再點一下收起；留言存檔後泡泡立即收起，只留下綠色底線。
 *
 * 依賴 app.js（el, clear, createSvgIcon, showToast, viewRoot, render）與
 * auth.js（authFetch, getAccessToken, tryRefreshToken）。
 * PDF 用 /vendor/pdf.min.js；Word 用 /vendor/mammoth.browser.min.js。
 */

const NOTES_API = resolveLearnFlowApiBase();
const NOTE_BASE_SCALE = 1.3;
const HL_COLORS = [
  { id: "yellow", hex: "#ffe066", label: "黃" },
  { id: "green", hex: "#8ce99a", label: "綠" },
  { id: "blue", hex: "#74c0fc", label: "藍" },
  { id: "pink", hex: "#faa2c1", label: "粉" },
  { id: "orange", hex: "#ffc078", label: "橘" },
  { id: "purple", hex: "#b197fc", label: "紫" },
];
const HL_HEX = Object.fromEntries(HL_COLORS.map((c) => [c.id, c.hex]));

const notesState = {
  loading: false,
  error: "",
  docs: [], // [{ meta, kind, pdfDoc?, docxHtml?, annotations:[], error? }]
  tool: "select", // select | highlight | hand
  color: "yellow",
  zoom: 0.9,
  panX: 60,
  panY: 74,
  showComments: false,
  openComments: new Set(),
  fitted: false,
};

let _pdfLibPromise = null;
let _mammothPromise = null;
let _paintToken = 0;
let _notesPanning = false;
let _notesSpace = false;
let _notesPanStart = null;
let _notesGlobalWired = false;
let _draggingDoc = null;

function loadScriptOnce(src, globalCheck) {
  return new Promise((resolve, reject) => {
    if (globalCheck()) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`載入失敗：${src}`));
    document.head.appendChild(s);
  });
}
function ensurePdfLib() {
  if (!_pdfLibPromise) {
    _pdfLibPromise = loadScriptOnce("/vendor/pdf.min.js", () => window.pdfjsLib).then(() => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.js";
    });
  }
  return _pdfLibPromise;
}
function ensureMammoth() {
  if (!_mammothPromise) {
    _mammothPromise = loadScriptOnce("/vendor/mammoth.browser.min.js", () => window.mammoth);
  }
  return _mammothPromise;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function notesJson(path, options = {}) {
  const res = await authFetch(`${NOTES_API}${path}`, options);
  if (!res) return null;
  if (res.status === 204) return { ok: true };
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(detail);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function uploadNoteFile(file) {
  const form = new FormData();
  form.append("file", file);
  const doFetch = () =>
    fetch(`${NOTES_API}/notes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getAccessToken()}` },
      body: form,
      credentials: "include",
    });
  let res = await doFetch();
  if (res.status === 401 && (await tryRefreshToken())) res = await doFetch();
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b.detail) detail = b.detail;
    } catch {}
    throw new Error(detail);
  }
  return res.json();
}

async function fetchNoteFile(noteId) {
  const res = await authFetch(`${NOTES_API}/notes/${noteId}/file`);
  if (!res || !res.ok) throw new Error("無法下載檔案");
  return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// 載入所有文件
// ---------------------------------------------------------------------------

function docById(id) {
  return notesState.docs.find((d) => d.meta.id === id);
}

async function notesOnEnter() {
  await loadAllDocs();
  render();
}

async function loadAllDocs() {
  notesState.loading = true;
  notesState.error = "";
  notesState.fitted = false;
  notesState.openComments = new Set();
  render();
  try {
    const metas = (await notesJson("/notes")) || [];
    const docs = [];
    for (const meta of metas) {
      const doc = { meta, kind: meta.file_type, annotations: [] };
      try {
        doc.annotations = (await notesJson(`/notes/${meta.id}/annotations`)) || [];
        const buffer = await fetchNoteFile(meta.id);
        if (meta.file_type === "pdf") {
          await ensurePdfLib();
          doc.pdfDoc = await window.pdfjsLib.getDocument({ data: buffer }).promise;
        } else {
          await ensureMammoth();
          const r = await window.mammoth.convertToHtml({ arrayBuffer: buffer });
          doc.docxHtml = r.value || "<p>（空白文件）</p>";
        }
      } catch (e) {
        doc.error = e.message || "無法載入";
      }
      docs.push(doc);
    }
    notesState.docs = docs;
  } catch (e) {
    notesState.error = e.message || "無法載入筆記";
    notesState.docs = [];
  } finally {
    notesState.loading = false;
  }
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 上傳（按鈕 + 拖拉）
// ---------------------------------------------------------------------------

function handleUploadFile(file) {
  (async () => {
    try {
      showToast("上傳中…", { type: "info", duration: 2000 });
      const created = await uploadNoteFile(file);
      notesState._focusId = created.id; // 上傳後聚焦到新文件
      await loadAllDocs();
      render();
    } catch (e) {
      showToast(e.message || "上傳失敗", { type: "error", title: "上傳失敗" });
    }
  })();
}

function wireNotesDropZone(zone) {
  let depth = 0;
  const show = (on) => zone.classList.toggle("dragging", on);
  zone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth += 1;
    show(true);
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("dragleave", () => {
    depth -= 1;
    if (depth <= 0) {
      depth = 0;
      show(false);
    }
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    show(false);
    const file = [...((e.dataTransfer && e.dataTransfer.files) || [])].find((f) =>
      /\.(pdf|docx)$/i.test(f.name),
    );
    if (file) handleUploadFile(file);
    else showToast("只支援 PDF 或 Word（.pdf / .docx）", { type: "warning" });
  });
}

async function deleteDoc(meta) {
  if (!confirm(`刪除文件「${meta.title}」？此動作無法復原。`)) return;
  try {
    await notesJson(`/notes/${meta.id}`, { method: "DELETE" });
    notesState.docs = notesState.docs.filter((d) => d.meta.id !== meta.id);
    render();
    await paintAllDocs();
    showToast("已刪除文件", { type: "info", duration: 2000 });
  } catch (e) {
    showToast(e.message || "刪除失敗", { type: "error" });
  }
}

// ---------------------------------------------------------------------------
// 主渲染：畫布 + 底部工具列
// ---------------------------------------------------------------------------

function toolButton(id, label, paths) {
  const b = el("button", `note-tool ${notesState.tool === id ? "active" : ""}`);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.appendChild(createSvgIcon(paths, 18));
  b.addEventListener("click", () => {
    notesState.tool = id;
    updateToolUI();
  });
  return b;
}

function updateToolUI() {
  const map = { select: 0, highlight: 1, hand: 2 };
  const tools = document.querySelectorAll(".note-dock-tools .note-tool");
  tools.forEach((b) => b.classList.remove("active"));
  if (tools[map[notesState.tool]]) tools[map[notesState.tool]].classList.add("active");
  const stage = document.querySelector(".note-stage");
  if (stage) stage.dataset.tool = notesState.tool;
  const sw = document.querySelector(".note-colorbar");
  if (sw) sw.style.display = notesState.tool === "highlight" ? "flex" : "none";
}

function renderNotesView() {
  clear(viewRoot);
  const page = el("div", "notes-page");
  viewRoot.appendChild(page);

  // 點陣白底大畫布
  const stage = el("div", "note-stage");
  stage.dataset.tool = notesState.tool;
  const pages = el("div", "note-pages");
  pages.id = "notePages";
  stage.appendChild(pages);
  page.appendChild(stage);

  // 浮動頂列：標題 + 小型淺灰上傳鈕
  const topbar = el("div", "notes-topbar");
  const text = el("div", "notes-topbar-text");
  text.appendChild(el("h1", null, "筆記"));
  text.appendChild(
    el("p", "muted", "拖拉或上傳 PDF / Word。所有文件都在這張畫布上，可直接縮放、螢光筆標記、選字留言。"),
  );
  topbar.appendChild(text);
  const uploadLabel = el("label", "notes-upload-btn");
  uploadLabel.appendChild(createSvgIcon(["M12 5v14", "M5 12h14"], 15));
  uploadLabel.appendChild(document.createTextNode("上傳文件"));
  const input = el("input");
  input.type = "file";
  input.accept = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  input.hidden = true;
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (file) handleUploadFile(file);
    input.value = "";
  });
  uploadLabel.appendChild(input);
  topbar.appendChild(uploadLabel);
  page.appendChild(topbar);

  // 拖拉提示
  const dropHint = el("div", "notes-drop-hint");
  dropHint.appendChild(createSvgIcon(["M12 5v14", "M5 12h14"], 26));
  dropHint.appendChild(el("span", null, "放開以上傳 PDF / Word"));
  page.appendChild(dropHint);
  wireNotesDropZone(page);

  // 底部中央浮動工具列（Figma 風）
  page.appendChild(buildDock());

  wireGlobalOnce();
  wireStageInteractions(stage);
  applyTransform();
  updateToolUI();

  if (notesState.loading) {
    pages.appendChild(el("div", "notes-center", "載入文件中…"));
  } else if (notesState.error) {
    const box = el("div", "notes-center");
    box.appendChild(el("h2", null, "無法載入筆記"));
    box.appendChild(el("p", "muted", notesState.error));
    pages.appendChild(box);
  } else if (!notesState.docs.length) {
    const empty = el("div", "notes-center notes-empty");
    empty.appendChild(createSvgIcon(["M12 5v14", "M5 12h14"], 34));
    empty.appendChild(el("h2", null, "把 PDF / Word 拖進來"));
    empty.appendChild(el("p", "muted", "或點右上角「上傳文件」。上傳後就直接顯示在這張畫布上，可立即畫重點與留言。"));
    pages.appendChild(empty);
  } else {
    paintAllDocs();
  }
}

function buildDock() {
  const dock = el("div", "note-dock");

  const tools = el("div", "note-dock-tools");
  tools.appendChild(toolButton("select", "選取／文字", ["M4 4l7 16 2-7 7-2z"]));
  tools.appendChild(
    toolButton("highlight", "螢光筆", ["m9 11 6-6 4 4-6 6", "M9 11l-4 4v4h4l4-4", "M14 6l4 4"]),
  );
  tools.appendChild(toolButton("hand", "移動：抓文件可獨立拖曳、抓空白平移畫布", ["M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 8 8 8 8 0 0 0 8-8v-3a2 2 0 0 0-4 0"]));
  dock.appendChild(tools);

  dock.appendChild(el("span", "note-dock-sep"));

  const colorbar = el("div", "note-colorbar");
  HL_COLORS.forEach((c) => {
    const sw = el("button", `note-swatch ${notesState.color === c.id ? "active" : ""}`);
    sw.type = "button";
    sw.title = c.label;
    sw.style.background = c.hex;
    sw.addEventListener("click", () => {
      notesState.color = c.id;
      document.querySelectorAll(".note-swatch").forEach((x) => x.classList.remove("active"));
      sw.classList.add("active");
    });
    colorbar.appendChild(sw);
  });
  dock.appendChild(colorbar);

  const cmtToggle = el("button", `note-cmt-toggle ${notesState.showComments ? "active" : ""}`);
  cmtToggle.type = "button";
  cmtToggle.title = "顯示 / 隱藏所有留言";
  cmtToggle.appendChild(createSvgIcon(["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"], 16));
  cmtToggle.addEventListener("click", () => {
    notesState.showComments = !notesState.showComments;
    cmtToggle.classList.toggle("active", notesState.showComments);
    renderAnnotations();
  });
  dock.appendChild(cmtToggle);

  dock.appendChild(el("span", "note-dock-sep"));

  const zoomBox = el("div", "note-zoom");
  const zOut = el("button", "note-zoom-btn", "−");
  zOut.type = "button";
  zOut.addEventListener("click", () => setZoom(notesState.zoom / 1.2));
  const zLabel = el("button", "note-zoom-label");
  zLabel.type = "button";
  zLabel.id = "noteZoomLabel";
  zLabel.title = "符合寬度";
  zLabel.textContent = `${Math.round(notesState.zoom * 100)}%`;
  zLabel.addEventListener("click", () => fitToWidth(2));
  const zIn = el("button", "note-zoom-btn", "＋");
  zIn.type = "button";
  zIn.addEventListener("click", () => setZoom(notesState.zoom * 1.2));
  zoomBox.appendChild(zOut);
  zoomBox.appendChild(zLabel);
  zoomBox.appendChild(zIn);
  dock.appendChild(zoomBox);

  return dock;
}

// ---------------------------------------------------------------------------
// 畫出所有文件
// ---------------------------------------------------------------------------

async function paintAllDocs() {
  const myToken = ++_paintToken;
  const pages = document.getElementById("notePages");
  if (!pages) return;
  clear(pages);

  for (const doc of notesState.docs) {
    if (myToken !== _paintToken) return;
    const docEl = el("div", "note-doc");
    docEl.dataset.noteId = doc.meta.id;

    const header = el("div", "note-doc-header");
    header.title = "拖曳可移動這份文件";
    const grip = el("span", "note-doc-grip");
    grip.appendChild(createSvgIcon(["M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"], 14));
    header.appendChild(grip);
    header.appendChild(el("span", "note-doc-title", doc.meta.title));
    const del = el("button", "note-doc-del");
    del.type = "button";
    del.title = "刪除此文件";
    del.setAttribute("aria-label", "刪除此文件");
    del.appendChild(createSvgIcon(["M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"], 15));
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteDoc(doc.meta);
    });
    header.appendChild(del);
    header.addEventListener("mousedown", (e) => startDocDrag(e, doc, docEl));
    docEl.appendChild(header);

    const body = el("div", "note-doc-body");
    docEl.appendChild(body);
    pages.appendChild(docEl);

    if (doc.error) {
      body.appendChild(el("div", "note-doc-error", `無法載入：${doc.error}`));
      continue;
    }
    if (doc.kind === "pdf") {
      await paintPdfInto(body, doc, myToken);
    } else {
      paintDocxInto(body, doc);
    }
  }

  if (myToken !== _paintToken) return;
  layoutDocs();
  renderAnnotations();

  if (!notesState.fitted && notesState.docs.some((d) => !d.error)) {
    notesState.fitted = true;
    const target = (notesState._focusId && docById(notesState._focusId)) ||
      notesState.docs.find((d) => !d.error);
    notesState._focusId = null;
    focusDoc(target);
  }
}

// 依 canvas 座標把每份文件放到畫布上（未定位的自動往右排）
function layoutDocs() {
  const pages = document.getElementById("notePages");
  if (!pages) return;
  const GAP = 90;
  let cursorX = 40;
  notesState.docs.forEach((doc) => {
    const el2 = pages.querySelector(`.note-doc[data-note-id="${doc.meta.id}"]`);
    if (!el2) return;
    const w = el2.offsetWidth || 820;
    let x = doc.meta.canvas_x;
    let y = doc.meta.canvas_y;
    if (x == null || y == null) {
      x = cursorX;
      y = 40;
    }
    el2.style.left = `${x}px`;
    el2.style.top = `${y}px`;
    doc._x = x;
    doc._y = y;
    doc._w = w;
    cursorX = Math.max(cursorX, x + w + GAP);
  });
}

function startDocDrag(e, doc, docEl) {
  if (e.button !== 0) return;
  if (e.target.closest(".note-doc-del")) return;
  e.preventDefault();
  e.stopPropagation();
  _draggingDoc = {
    doc,
    el: docEl,
    startX: e.clientX,
    startY: e.clientY,
    origX: doc._x || 0,
    origY: doc._y || 0,
  };
  docEl.classList.add("dragging");
}

async function saveDocPosition(noteId, x, y) {
  try {
    await notesJson(`/notes/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify({ canvas_x: x, canvas_y: y }),
    });
  } catch (e) {
    showToast(e.message || "無法儲存位置", { type: "error" });
  }
}

function focusDoc(doc) {
  const stage = document.querySelector(".note-stage");
  if (!stage || !doc || doc._x == null) return fitToWidth(1);
  const w = doc._w || 820;
  const z = Math.max(0.15, Math.min(1, (stage.clientWidth - 140) / w));
  notesState.zoom = z;
  notesState.panX = 60 - doc._x * z;
  notesState.panY = 74 - doc._y * z;
  applyTransform();
}

async function paintPdfInto(body, doc, myToken) {
  const pdf = doc.pdfDoc;
  for (let n = 1; n <= pdf.numPages; n++) {
    if (myToken !== _paintToken) return;
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: NOTE_BASE_SCALE });
    const pageEl = el("div", "note-page");
    pageEl.dataset.noteId = doc.meta.id;
    pageEl.dataset.page = String(n);
    pageEl.style.width = `${viewport.width}px`;
    pageEl.style.height = `${viewport.height}px`;
    pageEl.style.setProperty("--scale-factor", String(viewport.scale));

    const canvas = document.createElement("canvas");
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    pageEl.appendChild(canvas);

    const textLayer = el("div", "note-textlayer");
    pageEl.appendChild(textLayer);
    const annots = el("div", "note-annots");
    annots.dataset.noteId = doc.meta.id;
    annots.dataset.page = String(n);
    pageEl.appendChild(annots);
    body.appendChild(pageEl);

    await page.render({ canvasContext: ctx, viewport }).promise;
    const textContent = await page.getTextContent();
    window.pdfjsLib
      .renderTextLayer({ textContent, container: textLayer, viewport, textDivs: [] })
      .promise?.catch(() => {});
  }
}

function paintDocxInto(body, doc) {
  const pageEl = el("div", "note-page note-page-docx");
  pageEl.dataset.noteId = doc.meta.id;
  pageEl.dataset.page = "1";
  const content = el("div", "note-docx");
  content.innerHTML = doc.docxHtml;
  pageEl.appendChild(content);
  const annots = el("div", "note-annots");
  annots.dataset.noteId = doc.meta.id;
  annots.dataset.page = "1";
  pageEl.appendChild(annots);
  body.appendChild(pageEl);
  requestAnimationFrame(() => {
    pageEl.style.height = `${pageEl.offsetHeight}px`;
  });
}

// ---------------------------------------------------------------------------
// 標註渲染
// ---------------------------------------------------------------------------

function allAnnotations() {
  return notesState.docs.flatMap((d) => d.annotations);
}

function renderAnnotations() {
  document.querySelectorAll(".note-annots").forEach((layer) => clear(layer));
  allAnnotations().forEach((a) => drawAnnotation(a));
}

function drawAnnotation(a) {
  const layer = document.querySelector(
    `.note-annots[data-note-id="${a.note_id}"][data-page="${a.page}"]`,
  );
  if (!layer || !a.rects || !a.rects.length) return;

  if (a.kind === "comment") {
    // 淡綠色底線覆蓋整行文字，可點選、游標為手指
    a.rects.forEach((r) => {
      const u = el("div", "note-underline");
      u.style.left = `${r.x * 100}%`;
      u.style.top = `${r.y * 100}%`;
      u.style.width = `${r.w * 100}%`;
      u.style.height = `${r.h * 100}%`;
      u.dataset.annotId = a.id;
      u.dataset.noteId = a.note_id;
      u.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleComment(a.id);
      });
      layer.appendChild(u);
    });
    if (notesState.showComments || notesState.openComments.has(a.id)) {
      layer.appendChild(buildCommentBubble(a, a.rects[0]));
    }
    return;
  }

  const hex = HL_HEX[a.color] || HL_HEX.yellow;
  a.rects.forEach((r) => {
    const box = el("div", "note-hl");
    box.style.left = `${r.x * 100}%`;
    box.style.top = `${r.y * 100}%`;
    box.style.width = `${r.w * 100}%`;
    box.style.height = `${r.h * 100}%`;
    box.style.background = hex;
    box.dataset.annotId = a.id;
    box.dataset.noteId = a.note_id;
    layer.appendChild(box);
  });
}

function buildCommentBubble(a, anchor) {
  const bubble = el("div", "note-bubble");
  bubble.style.left = `${anchor.x * 100}%`;
  bubble.style.top = `${anchor.y * 100}%`;
  bubble.dataset.annotId = a.id;

  if (a._editing) {
    const ta = el("textarea", "note-bubble-input");
    ta.value = a.body || "";
    ta.placeholder = "輸入留言…";
    bubble.appendChild(ta);
    const row = el("div", "note-bubble-actions");
    const save = el("button", "note-bubble-save", "儲存");
    save.type = "button";
    save.addEventListener("click", async () => {
      const body = ta.value.trim();
      if (!body) {
        await removeAnnotation(a.id);
        return;
      }
      await saveCommentBody(a, body);
    });
    const cancel = el("button", "note-bubble-cancel", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", async () => {
      if (!a.body) await removeAnnotation(a.id);
      else {
        a._editing = false;
        notesState.openComments.delete(a.id);
        renderAnnotations();
      }
    });
    row.appendChild(save);
    row.appendChild(cancel);
    bubble.appendChild(row);
    requestAnimationFrame(() => ta.focus());
  } else {
    bubble.appendChild(el("p", "note-bubble-body", a.body || "（空白留言）"));
    const row = el("div", "note-bubble-actions");
    const edit = el("button", "note-bubble-edit", "編輯");
    edit.type = "button";
    edit.addEventListener("click", () => {
      a._editing = true;
      notesState.openComments.add(a.id);
      renderAnnotations();
    });
    const del = el("button", "note-bubble-del", "刪除");
    del.type = "button";
    del.addEventListener("click", () => removeAnnotation(a.id));
    row.appendChild(edit);
    row.appendChild(del);
    bubble.appendChild(row);
  }
  return bubble;
}

function toggleComment(id) {
  if (notesState.openComments.has(id)) notesState.openComments.delete(id);
  else notesState.openComments.add(id);
  renderAnnotations();
}

// ---------------------------------------------------------------------------
// 選取 → 正規化座標（含文件 id）
// ---------------------------------------------------------------------------

function pageInfoFromNode(node) {
  let n = node && node.nodeType === 3 ? node.parentElement : node;
  while (n && !(n.classList && n.classList.contains("note-page"))) n = n.parentElement;
  if (!n) return null;
  return { pageEl: n, noteId: n.dataset.noteId, page: Number(n.dataset.page || 1) };
}

function selectionToRects() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const info = pageInfoFromNode(range.startContainer);
  if (!info) return null;
  const pageRect = info.pageEl.getBoundingClientRect();
  const rects = [...range.getClientRects()]
    .filter((r) => r.width > 1 && r.height > 1)
    .map((r) => ({
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      w: r.width / pageRect.width,
      h: r.height / pageRect.height,
    }));
  if (!rects.length) return null;
  return { noteId: info.noteId, page: info.page, rects, quote: sel.toString().trim() };
}

async function createAnnotation(kind, sel, color, body) {
  const doc = docById(sel.noteId);
  if (!doc) return;
  const isDraftComment = kind === "comment" && !body;
  const optimistic = {
    id: `tmp-${Date.now()}`,
    note_id: sel.noteId,
    kind,
    page: sel.page,
    color,
    rects: sel.rects,
    quote: sel.quote,
    body: body ?? null,
    _editing: isDraftComment,
  };
  doc.annotations.push(optimistic);
  if (isDraftComment) notesState.openComments.add(optimistic.id);
  renderAnnotations();
  window.getSelection().removeAllRanges();

  // 留言：先本地暫存，按下「儲存」有內容才寫入 DB（避免空留言與 tmp id 競態）
  if (isDraftComment) return;

  try {
    const saved = await notesJson(`/notes/${sel.noteId}/annotations`, {
      method: "POST",
      body: JSON.stringify({ kind, page: sel.page, color, rects: sel.rects, quote: sel.quote, body: body ?? null }),
    });
    optimistic.id = saved.id;
    renderAnnotations();
  } catch (e) {
    doc.annotations = doc.annotations.filter((x) => x !== optimistic);
    renderAnnotations();
    showToast(e.message || "儲存標註失敗", { type: "error" });
  }
}

async function saveCommentBody(a, body) {
  try {
    if (String(a.id).startsWith("tmp-")) {
      // 尚未寫入 DB 的新留言 → 這時才建立
      const tmpId = a.id;
      const saved = await notesJson(`/notes/${a.note_id}/annotations`, {
        method: "POST",
        body: JSON.stringify({ kind: "comment", page: a.page, color: a.color, rects: a.rects, quote: a.quote, body }),
      });
      a.id = saved.id;
      notesState.openComments.delete(tmpId);
    } else {
      await notesJson(`/annotations/${a.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
      notesState.openComments.delete(a.id);
    }
    a.body = body;
    a._editing = false;
    renderAnnotations(); // 存檔後泡泡收起，只留綠色底線
  } catch (e) {
    showToast(e.message || "儲存留言失敗", { type: "error" });
  }
}

async function recolorAnnotation(a, color) {
  const prev = a.color;
  a.color = color;
  renderAnnotations();
  try {
    await notesJson(`/annotations/${a.id}`, { method: "PATCH", body: JSON.stringify({ color }) });
  } catch (e) {
    a.color = prev;
    renderAnnotations();
    showToast(e.message || "更新顏色失敗", { type: "error" });
  }
}

async function removeAnnotation(id) {
  let doc = null;
  let a = null;
  for (const d of notesState.docs) {
    const found = d.annotations.find((x) => x.id === id);
    if (found) {
      doc = d;
      a = found;
      break;
    }
  }
  if (doc) doc.annotations = doc.annotations.filter((x) => x.id !== id);
  notesState.openComments.delete(id);
  renderAnnotations();
  if (!a || String(id).startsWith("tmp-")) return;
  try {
    await notesJson(`/annotations/${id}`, { method: "DELETE" });
  } catch (e) {
    showToast(e.message || "刪除失敗", { type: "error" });
  }
}

// ---------------------------------------------------------------------------
// 右鍵選單
// ---------------------------------------------------------------------------

function closeContextMenu() {
  document.querySelectorAll(".note-ctx").forEach((m) => m.remove());
}

function openSelectionMenu(x, y, sel) {
  closeContextMenu();
  const menu = el("div", "note-ctx");
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const colorsRow = el("div", "note-ctx-colors");
  HL_COLORS.forEach((c) => {
    const sw = el("button", "note-ctx-swatch");
    sw.type = "button";
    sw.title = `螢光筆：${c.label}`;
    sw.style.background = c.hex;
    sw.addEventListener("click", () => {
      closeContextMenu();
      createAnnotation("highlight", sel, c.id, null);
    });
    colorsRow.appendChild(sw);
  });
  menu.appendChild(colorsRow);

  menu.appendChild(
    ctxItem("留言 Comment", ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"], () => {
      closeContextMenu();
      createAnnotation("comment", sel, "green", "");
    }),
  );
  menu.appendChild(
    ctxItem("複製文字", ["M9 9h10v10H9zM5 15H4V5a1 1 0 0 1 1-1h10v1"], async () => {
      closeContextMenu();
      try {
        await navigator.clipboard.writeText(sel.quote);
        showToast("已複製", { type: "info", duration: 1600 });
      } catch {
        showToast("瀏覽器不允許複製", { type: "warning" });
      }
    }),
  );
  document.body.appendChild(menu);
  clampMenu(menu);
}

function openAnnotationMenu(x, y, a) {
  closeContextMenu();
  const menu = el("div", "note-ctx");
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  if (a.kind === "highlight") {
    const colorsRow = el("div", "note-ctx-colors");
    HL_COLORS.forEach((c) => {
      const sw = el("button", "note-ctx-swatch");
      sw.type = "button";
      sw.title = `改成${c.label}`;
      sw.style.background = c.hex;
      sw.addEventListener("click", () => {
        closeContextMenu();
        recolorAnnotation(a, c.id);
      });
      colorsRow.appendChild(sw);
    });
    menu.appendChild(colorsRow);
  } else {
    menu.appendChild(
      ctxItem("編輯留言", ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"], () => {
        closeContextMenu();
        a._editing = true;
        notesState.openComments.add(a.id);
        renderAnnotations();
      }),
    );
  }
  menu.appendChild(
    ctxItem("刪除標註", ["M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M19 6l-1 14H6L5 6"], () => {
      closeContextMenu();
      removeAnnotation(a.id);
    }),
  );
  document.body.appendChild(menu);
  clampMenu(menu);
}

function ctxItem(label, paths, onClick) {
  const item = el("button", "note-ctx-item");
  item.type = "button";
  item.appendChild(createSvgIcon(paths, 15));
  item.appendChild(document.createTextNode(label));
  item.addEventListener("click", onClick);
  return item;
}

function clampMenu(menu) {
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - r.width - 8}px`;
  if (r.bottom > window.innerHeight - 8) menu.style.top = `${window.innerHeight - r.height - 8}px`;
}

// ---------------------------------------------------------------------------
// 縮放 / 拖曳
// ---------------------------------------------------------------------------

function applyTransform() {
  const pages = document.getElementById("notePages");
  if (pages) pages.style.transform = `translate(${notesState.panX}px, ${notesState.panY}px) scale(${notesState.zoom})`;
  const label = document.getElementById("noteZoomLabel");
  if (label) label.textContent = `${Math.round(notesState.zoom * 100)}%`;
}

function setZoom(z, cx, cy) {
  const stage = document.querySelector(".note-stage");
  const nz = Math.max(0.15, Math.min(6, z));
  if (stage && cx != null) {
    const rect = stage.getBoundingClientRect();
    const px = cx - rect.left;
    const py = cy - rect.top;
    notesState.panX = px - (px - notesState.panX) * (nz / notesState.zoom);
    notesState.panY = py - (py - notesState.panY) * (nz / notesState.zoom);
  }
  notesState.zoom = nz;
  applyTransform();
}

function fitToWidth(maxZoom = 2) {
  const stage = document.querySelector(".note-stage");
  const firstDoc = notesState.docs.find((d) => !d.error);
  const firstPage = document.querySelector(".note-page");
  if (!stage || !firstPage) return;
  const pageW = parseFloat(firstPage.style.width) || firstPage.offsetWidth;
  const z = Math.max(0.15, Math.min(maxZoom, (stage.clientWidth - 140) / pageW));
  notesState.zoom = z;
  notesState.panX = 60 - (firstDoc && firstDoc._x ? firstDoc._x : 0) * z;
  notesState.panY = 74 - (firstDoc && firstDoc._y ? firstDoc._y : 0) * z;
  applyTransform();
}

function hitTestAnnotation(clientX, clientY) {
  const layers = document.querySelectorAll(".note-annots");
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const rect = layer.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    const noteId = layer.dataset.noteId;
    const pageNum = Number(layer.dataset.page || 1);
    const doc = docById(noteId);
    if (!doc) continue;
    const matches = doc.annotations.filter(
      (a) =>
        a.page === pageNum &&
        a.rects.some((r) => nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h),
    );
    if (matches.length) return matches[matches.length - 1];
  }
  return null;
}

function wireGlobalOnce() {
  if (_notesGlobalWired) return;
  _notesGlobalWired = true;

  window.addEventListener("mousemove", (e) => {
    if (_draggingDoc) {
      const z = notesState.zoom || 1;
      const nx = _draggingDoc.origX + (e.clientX - _draggingDoc.startX) / z;
      const ny = _draggingDoc.origY + (e.clientY - _draggingDoc.startY) / z;
      _draggingDoc.doc._x = nx;
      _draggingDoc.doc._y = ny;
      _draggingDoc.el.style.left = `${nx}px`;
      _draggingDoc.el.style.top = `${ny}px`;
      renderAnnotations();
      return;
    }
    if (!_notesPanning) return;
    notesState.panX = _notesPanStart.px + (e.clientX - _notesPanStart.x);
    notesState.panY = _notesPanStart.py + (e.clientY - _notesPanStart.y);
    applyTransform();
  });
  window.addEventListener("mouseup", () => {
    if (_draggingDoc) {
      const { doc, el: docEl } = _draggingDoc;
      docEl.classList.remove("dragging");
      doc.meta.canvas_x = doc._x;
      doc.meta.canvas_y = doc._y;
      saveDocPosition(doc.meta.id, doc._x, doc._y);
      _draggingDoc = null;
      return;
    }
    if (_notesPanning) {
      _notesPanning = false;
      const st = document.querySelector(".note-stage");
      if (st) st.classList.remove("panning");
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && isNotesActive()) {
      const t = e.target;
      if (!t || !/^(INPUT|TEXTAREA)$/.test(t.tagName)) _notesSpace = true;
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") _notesSpace = false;
  });
  document.addEventListener("keydown", notesKeydown);
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".note-ctx")) closeContextMenu();
  });
}

function isNotesActive() {
  return !!document.querySelector(".note-stage");
}

function wireStageInteractions(stage) {
  stage.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom(notesState.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
      } else {
        e.preventDefault();
        notesState.panX -= e.deltaX;
        notesState.panY -= e.deltaY;
        applyTransform();
      }
    },
    { passive: false },
  );

  stage.addEventListener("mousedown", (e) => {
    // 手掌工具按在某份文件上 → 獨立拖曳那份文件；按在空白畫布 → 平移整張畫布
    if (notesState.tool === "hand" && e.button === 0) {
      const overDoc = e.target.closest(".note-doc");
      if (overDoc) {
        const doc = docById(overDoc.dataset.noteId);
        if (doc) {
          startDocDrag(e, doc, overDoc);
          return;
        }
      }
    }
    const wantPan = notesState.tool === "hand" || _notesSpace || e.button === 1;
    if (wantPan) {
      e.preventDefault();
      _notesPanning = true;
      _notesPanStart = { x: e.clientX, y: e.clientY, px: notesState.panX, py: notesState.panY };
      stage.classList.add("panning");
    }
  });

  // 螢光筆：放開滑鼠若有選取 → 自動標記
  stage.addEventListener("mouseup", (e) => {
    if (notesState.tool !== "highlight" || _notesPanning || e.button !== 0) return;
    setTimeout(() => {
      const sel = selectionToRects();
      if (sel && sel.quote) createAnnotation("highlight", sel, notesState.color, null);
    }, 0);
  });

  // 右鍵選單
  stage.addEventListener("contextmenu", (e) => {
    const sel = selectionToRects();
    if (sel && sel.quote) {
      e.preventDefault();
      openSelectionMenu(e.clientX, e.clientY, sel);
      return;
    }
    const annotEl = e.target.closest("[data-annot-id]");
    const a =
      (annotEl &&
        allAnnotations().find((x) => x.id === annotEl.dataset.annotId)) ||
      hitTestAnnotation(e.clientX, e.clientY);
    if (a) {
      e.preventDefault();
      openAnnotationMenu(e.clientX, e.clientY, a);
    }
  });
}

function notesKeydown(e) {
  if (!isNotesActive()) return;
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === "Escape") closeContextMenu();
  if (e.key === "v" || e.key === "V") {
    notesState.tool = "select";
    updateToolUI();
  }
  if (e.key === "h" || e.key === "H") {
    notesState.tool = "highlight";
    updateToolUI();
  }
}

// ---------------------------------------------------------------------------
// 對外
// ---------------------------------------------------------------------------

window.learnflowNotes = {
  onEnter: notesOnEnter,
  renderView: renderNotesView,
};
