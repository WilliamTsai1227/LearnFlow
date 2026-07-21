const STORAGE_KEY = "lf-sidebar-collapsed";

const state = {
  view: "home",
  language: "all",
  scenarios: [],
  scenarioDetail: null,
  courseDetail: null,
  selectedSentenceIndex: 0,
  showTranslation: false,
  apiOnline: false,
  errorMessage: "",
  sidebarCollapsed: localStorage.getItem(STORAGE_KEY) === "1",
  savedFilter: "all",
  savedLanguage: "all",
  savedItems: [],
  savedVocabIds: new Set(),
  savedSentenceIds: new Set(),
  savedCount: 0,
  savedLoading: false,
  savedError: "",
  savedApiReady: null,
};

const navItems = [
  { id: "home", icon: "home", label: "首頁", enabled: true },
  { id: "learn", icon: "book-open", label: "學習", enabled: true },
  { id: "ai-chat", icon: "message-circle", label: "AI 對話", enabled: false },
  { id: "review", icon: "refresh-cw", label: "複習", enabled: false },
  { id: "flashcards", icon: "layers", label: "單字卡", enabled: false },
  { id: "sentences", icon: "message-square-text", label: "句子練習", enabled: false },
  { id: "progress", icon: "bar-chart-3", label: "進度分析", enabled: false },
  { id: "favorites", icon: "bookmark", label: "收藏", enabled: true },
  { id: "settings", icon: "settings", label: "設定", enabled: false },
];

const homeMock = {
  userName: "Alex",
  progressPercent: 72,
  stats: [
    { label: "學習時間", value: "25 分鐘", hint: "目標 35" },
    { label: "學習課程", value: "2 / 3", hint: "今日" },
    { label: "連續學習", value: "7 天", hint: "最佳 14" },
  ],
  currentCourse: {
    title: "旅行：在咖啡廳點餐",
    description: "學習在咖啡廳點餐的常用單字與句子，並與 AI 練習對話吧！",
    level: "初級",
    lesson: "Lesson 3 / 12",
    progress: 25,
  },
  shortcuts: [
    { title: "單字卡", meta: "128 張待複習", icon: "layers" },
    { title: "句子練習", meta: "24 句待練習", icon: "message-square-text" },
    { title: "AI 對話", meta: "開始練習", icon: "message-circle" },
    { title: "我的收藏", meta: "18 項", icon: "bookmark" },
  ],
  recommended: [
    { title: "Daily life intro", level: "初級", progress: 40 },
    { title: "Shopping", level: "中級", progress: 10 },
    { title: "Work meeting", level: "中級", progress: 0 },
  ],
  calendar: {
    monthLabel: "2024 / 05",
    weekdays: ["一", "二", "三", "四", "五", "六", "日"],
    days: [
      { day: 29, muted: true },
      { day: 30, muted: true },
      { day: 1, done: true },
      { day: 2, done: true },
      { day: 3, active: true },
      { day: 4 },
      { day: 5 },
      { day: 6, done: true },
      { day: 7, done: true },
      { day: 8 },
      { day: 9, done: true },
      { day: 10 },
      { day: 11, done: true },
      { day: 12 },
      { day: 13 },
      { day: 14, done: true },
      { day: 15 },
      { day: 16 },
      { day: 17, done: true },
      { day: 18 },
      { day: 19 },
      { day: 20, done: true },
      { day: 21 },
      { day: 22 },
      { day: 23 },
      { day: 24 },
      { day: 25 },
      { day: 26 },
      { day: 27 },
      { day: 28 },
      { day: 29 },
      { day: 30 },
      { day: 31 },
      { day: 1, muted: true },
    ],
  },
  chatPreview: [
    { role: "ai", text: "いらっしゃいませ。ご注文はお決まりですか？", sub: "歡迎光臨，請問決定好要點什麼了嗎？" },
    { role: "user", text: "ラテを一つお願いします。", sub: "請給我一杯拿鐵。" },
  ],
  analysis: {
    score: 86,
    strengths: ["發音穩定度提升", "常用句型掌握良好"],
    improvements: ["敬語運用可再加強", "聽力反應速度"],
  },
};

function syncSavedStateFromModule() {
  const mod = window.learnflowSavedState;
  if (!mod) return;
  state.savedItems = mod.savedItems;
  state.savedVocabIds = mod.savedVocabIds;
  state.savedSentenceIds = mod.savedSentenceIds;
  state.savedCount = mod.savedCount;
}

function isVocabularySaved(vocabularyId) {
  return state.savedVocabIds.has(vocabularyId);
}

function isSentenceSaved(sentenceId) {
  return state.savedSentenceIds.has(sentenceId);
}

function createFavoriteButton(options) {
  const { itemType, itemId, isSaved, compact = false } = options;
  const button = el(
    "button",
    `favorite-btn ${isSaved ? "is-saved" : ""}${compact ? " favorite-btn-compact" : ""}`,
  );
  button.type = "button";
  button.dataset.itemType = itemType;
  button.dataset.itemId = itemId;
  button.setAttribute("aria-label", isSaved ? "取消收藏" : "加入收藏");
  button.setAttribute("aria-pressed", isSaved ? "true" : "false");
  button.appendChild(createSvgIcon(["M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"], compact ? 16 : 18));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFavorite(itemType, itemId);
  });
  return button;
}

function updateFavoriteButtonState(itemType, itemId, isSaved) {
  document
    .querySelectorAll(`.favorite-btn[data-item-type="${itemType}"][data-item-id="${itemId}"]`)
    .forEach((button) => {
      button.classList.toggle("is-saved", isSaved);
      button.setAttribute("aria-pressed", isSaved ? "true" : "false");
      button.setAttribute("aria-label", isSaved ? "取消收藏" : "加入收藏");
    });
}

async function toggleFavorite(itemType, itemId) {
  const api = window.learnflowSavedApi;
  if (!api) return;

  const isSaved =
    itemType === "vocabulary" ? isVocabularySaved(itemId) : isSentenceSaved(itemId);

  try {
    if (itemType === "vocabulary") {
      if (isSaved) await api.unfavoriteVocabulary(itemId);
      else await api.favoriteVocabulary(itemId);
    } else if (isSaved) {
      await api.unfavoriteSentence(itemId);
    } else {
      await api.favoriteSentence(itemId);
    }

    await api.refreshSavedState();
    syncSavedStateFromModule();
    updateFavoriteButtonState(itemType, itemId, !isSaved);
    showToast(isSaved ? "已取消收藏" : "已加入收藏", { type: "info", duration: 2600 });
  } catch (error) {
    showToast(error.message || "收藏操作失敗", {
      type: "error",
      title: "收藏失敗",
    });
  }
}

async function loadSavedItems() {
  const api = window.learnflowSavedApi;
  if (!api) return;

  state.savedLoading = true;
  state.savedError = "";
  renderNav();

  try {
    const options = {};
    if (state.savedFilter !== "all") options.type = state.savedFilter;
    if (state.savedLanguage !== "all") options.language = state.savedLanguage;
    await api.refreshSavedState(options);
    syncSavedStateFromModule();
  } catch (error) {
    state.savedError = error.message || "無法載入收藏";
    state.savedItems = [];
    state.savedCount = 0;
  } finally {
    state.savedLoading = false;
  }
}

async function removeFavoriteItem(savedId) {
  const api = window.learnflowSavedApi;
  if (!api) return;

  try {
    await api.removeSavedItem(savedId);
    await api.refreshSavedState({
      type: state.savedFilter !== "all" ? state.savedFilter : undefined,
      language: state.savedLanguage !== "all" ? state.savedLanguage : undefined,
    });
    syncSavedStateFromModule();
    showToast("已移除收藏", { type: "info", duration: 2600 });
    render();
  } catch (error) {
    showToast(error.message || "無法移除收藏", { type: "error", title: "收藏失敗" });
  }
}

async function openSavedItem(item) {
  try {
    await loadCourseDetail(item.scenario_id, item.course_id);
    state.view = "course";
    state.errorMessage = "";

    if (item.item_type === "sentence") {
      const index = state.courseDetail.sentences.findIndex((sentence) => sentence.id === item.item_id);
      state.selectedSentenceIndex = index >= 0 ? index : 0;
    }

    resetSentenceView();
    render();
  } catch (error) {
    showToast(error.message || "無法開啟課程", { type: "warning" });
  }
}

async function bootstrapSavedState() {
  if (!window.learnflowSavedApi) return;
  try {
    await window.learnflowSavedApi.refreshSavedState();
    syncSavedStateFromModule();
  } catch {
    // 收藏載入失敗不阻擋主流程
  }
}

function getDisplayName() {
  const user = typeof getUser === "function" ? getUser() : null;
  if (!user) return homeMock.userName;
  return user.display_name || user.username || user.email || homeMock.userName;
}

const appShell = document.querySelector("#appShell");
const sidebar = document.querySelector("#sidebar");
const sidebarCollapseBtn = document.querySelector("#sidebarCollapseBtn");
const sidebarToggleBtn = document.querySelector("#sidebarToggleBtn");
const sidebarBackdrop = document.querySelector("#sidebarBackdrop");
const viewRoot = document.querySelector("#viewRoot");
const navList = document.querySelector("#navList");
const mobileTabbar = document.querySelector("#mobileTabbar");
const apiStatus = document.querySelector("#apiStatus");

const audioPlayer = new Audio();
const toastStack = document.querySelector("#toastStack");
const toastTimers = new WeakMap();

function createSvgIcon(pathList, size = 18) {
  const paths = Array.isArray(pathList) ? pathList : [pathList];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  paths.forEach((pathData) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
  });

  return svg;
}

function dismissToast(toast) {
  const timer = toastTimers.get(toast);
  if (timer) clearTimeout(timer);
  toastTimers.delete(toast);

  if (toast.classList.contains("leaving")) return;
  toast.classList.remove("visible");
  toast.classList.add("leaving");

  window.setTimeout(() => {
    toast.remove();
  }, 280);
}

function showToast(message, options = {}) {
  const { duration = 4200, type = "warning", title } = options;
  if (!toastStack) return;

  toastStack.querySelectorAll(".toast.visible").forEach((existing) => dismissToast(existing));

  const toast = el("div", `toast toast-${type}`);
  const iconWrap = el("span", "toast-icon");
  iconWrap.appendChild(
    createSvgIcon(
      type === "warning"
        ? ["M11 5 6 9H2v6h4l5 4V5z", "M22 9l-6 6", "M16 9l6 6"]
        : type === "info"
          ? ["M20 6 9 17l-5-5"]
          : type === "error"
            ? ["M12 8v4", "M12 16h.01", "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z"]
            : ["M12 8v4", "M12 16h.01", "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z"],
      20,
    ),
  );
  toast.appendChild(iconWrap);

  const defaultTitle =
    type === "warning"
      ? "語音無法播放"
      : type === "info"
        ? "完成"
        : type === "error"
          ? "操作失敗"
          : "提示";

  const body = el("div", "toast-body");
  body.appendChild(el("p", "toast-title", title || defaultTitle));
  body.appendChild(el("p", "toast-message", message));
  toast.appendChild(body);

  const closeButton = el("button", "toast-close");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "關閉提示");
  closeButton.appendChild(createSvgIcon(["M18 6 6 18", "M6 6l12 12"], 16));
  closeButton.addEventListener("click", () => dismissToast(toast));
  toast.appendChild(closeButton);

  const progress = el("span", "toast-progress");
  progress.style.setProperty("--toast-duration", `${duration}ms`);
  toast.appendChild(progress);

  toastStack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));

  const timer = window.setTimeout(() => dismissToast(toast), duration);
  toastTimers.set(toast, timer);
}

function playAudioUrl(url, options = {}) {
  const { label = "語音" } = options;

  if (!url) {
    showToast(`此${label}尚未提供語音檔。`, { type: "warning" });
    return;
  }

  audioPlayer.src = `/${url.replace(/^\//, "")}`;
  audioPlayer.play().catch(() => {
    showToast(`${label}語音檔尚未準備好，請稍後再試。`, { type: "warning" });
  });
}

function languageLabel(value) {
  return { english: "英文", japanese: "日文", all: "全部語言" }[value] || value;
}

function levelLabel(value) {
  return { beginner: "初級", intermediate: "中級", advanced: "高級" }[value] || value;
}

function levelTagClass(value) {
  if (value === "advanced") return "amber";
  if (value === "intermediate") return "violet";
  return "blue";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function icon(name) {
  const span = el("span", "nav-icon");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const paths = {
    home: "M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V9.5z",
    "book-open": "M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3H3z",
    "message-circle": "M7.9 20A9 9 0 1 0 4 16.1L2 22z",
    "refresh-cw":
      "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M3 21v-5h5",
    layers: "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
    "message-square-text": "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM13 8H7M17 12H7",
    "bar-chart-3": "M3 3v18h18M18 17V9M13 17V5M8 17v-3",
    bookmark: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
    settings: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  };

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name] || paths.home);
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function backChevronIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m15 18-6-6 6-6");
  svg.appendChild(path);
  return svg;
}

function translationToggleIcon(visible) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    visible
      ? "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
      : "M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20",
  );
  svg.appendChild(path);
  return svg;
}

function createTranslationToggle(translation) {
  const row = el("div", "translation-row");
  const toggleButton = el(
    "button",
    `translation-toggle ${state.showTranslation ? "is-visible" : ""}`,
  );
  toggleButton.type = "button";
  toggleButton.setAttribute(
    "aria-label",
    state.showTranslation ? "隱藏中文翻譯" : "顯示中文翻譯",
  );
  toggleButton.appendChild(translationToggleIcon(state.showTranslation));
  toggleButton.appendChild(
    document.createTextNode(state.showTranslation ? "隱藏翻譯" : "顯示翻譯"),
  );
  toggleButton.addEventListener("click", () => {
    state.showTranslation = !state.showTranslation;
    render();
  });
  row.appendChild(toggleButton);

  if (state.showTranslation) {
    row.appendChild(el("p", "lesson-translation", translation));
  }

  return row;
}

function resetSentenceView() {
  state.showTranslation = false;
}

function createPageHeader(title, description, backLabel, onBack) {
  const header = el("div", "view-header");
  const backButton = el("button", "page-back-btn");
  backButton.type = "button";
  backButton.appendChild(backChevronIcon());
  backButton.appendChild(document.createTextNode(backLabel));
  backButton.addEventListener("click", onBack);
  header.appendChild(backButton);

  const titleBlock = el("div", "view-title");
  titleBlock.appendChild(el("h1", null, title));
  titleBlock.appendChild(el("p", null, description));
  header.appendChild(titleBlock);
  return header;
}

const renderContext = {
  view: null,
  scenarioId: null,
  courseId: null,
};

function shouldScrollToTop() {
  const scenarioId = state.scenarioDetail?.id ?? null;
  const courseId = state.courseDetail?.id ?? null;
  const changed =
    renderContext.view !== state.view ||
    renderContext.scenarioId !== scenarioId ||
    renderContext.courseId !== courseId;

  renderContext.view = state.view;
  renderContext.scenarioId = scenarioId;
  renderContext.courseId = courseId;
  return changed;
}

function scrollViewToTop() {
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

function refreshIcons() {
  if (window.lucide) lucide.createIcons();
}

function activeNavId() {
  if (state.view === "scenario" || state.view === "course" || state.view === "lesson") return "learn";
  return state.view;
}

function applySidebarState() {
  appShell.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  sidebarCollapseBtn.setAttribute("aria-expanded", state.sidebarCollapsed ? "false" : "true");
  sidebarCollapseBtn.setAttribute(
    "aria-label",
    state.sidebarCollapsed ? "展開側邊欄" : "收合側邊欄",
  );
}

function closeMobileSidebar() {
  state.mobileSidebarOpen = false;
  appShell.classList.remove("sidebar-open");
  sidebarBackdrop.setAttribute("aria-hidden", "true");
  sidebarToggleBtn.setAttribute("aria-expanded", "false");
}

function toggleMobileSidebar() {
  state.mobileSidebarOpen = !state.mobileSidebarOpen;
  appShell.classList.toggle("sidebar-open", state.mobileSidebarOpen);
  sidebarBackdrop.setAttribute("aria-hidden", state.mobileSidebarOpen ? "false" : "true");
  sidebarToggleBtn.setAttribute("aria-expanded", state.mobileSidebarOpen ? "true" : "false");
}

function toggleSidebarCollapse() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem(STORAGE_KEY, state.sidebarCollapsed ? "1" : "0");
  applySidebarState();
}

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

async function checkHealth() {
  try {
    const health = await api("/api/health");
    state.apiOnline = health.status === "ok";
    state.savedApiReady = health.saved ?? null;
    state.errorMessage =
      health.database === "connected" ? "" : "資料庫未連線，請確認 DATABASE_URL 與 SQL 種子資料";
    apiStatus.textContent = health.database === "connected" ? "API 已連線" : "DB 未設定";
    apiStatus.className = health.database === "connected" ? "tag blue api-tag" : "tag api-tag";
  } catch (error) {
    state.apiOnline = false;
    state.savedApiReady = null;
    state.errorMessage = "無法連線 API，請確認後端已啟動";
    apiStatus.textContent = "API 離線";
    apiStatus.className = "tag api-tag";
  }
}

async function loadScenarios() {
  const query = state.language === "all" ? "" : `?language=${state.language}`;
  state.scenarios = await api(`/api/scenarios${query}`);
}

async function loadScenarioDetail(scenarioId) {
  state.scenarioDetail = await api(`/api/scenarios/${scenarioId}`);
  state.courseDetail = null;
  state.selectedSentenceIndex = 0;
}

async function loadCourseDetail(scenarioId, courseId) {
  state.courseDetail = await api(`/api/scenarios/${scenarioId}/courses/${courseId}`);
  state.selectedSentenceIndex = 0;
  state.showTranslation = false;
}

function navigateTo(view) {
  const item = navItems.find((entry) => entry.id === view);
  if (item && !item.enabled) return;

  state.view = view;
  if (view !== "learn" && view !== "scenario" && view !== "course" && view !== "lesson") {
    state.scenarioDetail = null;
    state.courseDetail = null;
  }
  closeMobileSidebar();
  render();

  if (view === "favorites") {
    loadSavedItems().then(() => render());
  }
}

function renderNav() {
  clear(navList);
  const current = activeNavId();

  navItems.forEach((item) => {
    const button = el(
      "button",
      `nav-item ${current === item.id ? "active" : ""}${item.enabled ? "" : " is-disabled"}`,
    );
    button.type = "button";
    button.dataset.view = item.id;
    if (!item.enabled) button.disabled = true;

    button.appendChild(icon(item.icon));
    button.appendChild(el("span", "nav-label", item.label));
    if (!item.enabled) {
      button.appendChild(el("span", "nav-soon", "即將推出"));
    }
    navList.appendChild(button);
  });

  clear(mobileTabbar);
  navItems.slice(0, 5).forEach((item) => {
    const button = el("button", current === item.id ? "active" : "");
    button.type = "button";
    button.dataset.view = item.id;
    button.disabled = !item.enabled;
    button.appendChild(el("span", null, item.label));
    mobileTabbar.appendChild(button);
  });
}

function renderErrorPanel(message) {
  const panel = el("section", "panel");
  panel.appendChild(el("h2", null, "無法載入資料"));
  panel.appendChild(el("p", "muted", message));
  return panel;
}

function renderComingSoon(title) {
  clear(viewRoot);
  const panel = el("section", "coming-soon-panel");
  panel.appendChild(el("h2", null, title));
  panel.appendChild(
    el("p", null, "此功能尚在開發中，API 完成後即可使用。目前可先從「學習」探索情境課程。"),
  );
  const button = el("button", "primary-button", "前往情境探索");
  button.type = "button";
  button.addEventListener("click", () => navigateTo("learn"));
  panel.appendChild(button);
  viewRoot.appendChild(panel);
}

function renderLanguageFilters(container, onChange, options = {}) {
  const activeLang =
    options.languageKey && Object.prototype.hasOwnProperty.call(state, options.languageKey)
      ? state[options.languageKey]
      : state.language;
  const row = el("div", `filter-row${options.compact ? " filter-row-compact" : ""}`);
  ["all", "english", "japanese"].forEach((lang) => {
    const button = el(
      "button",
      `chip-button ${activeLang === lang ? "active" : ""}`,
      languageLabel(lang),
    );
    button.type = "button";
    button.addEventListener("click", () => onChange(lang));
    row.appendChild(button);
  });
  container.appendChild(row);
}

const exploreAccents = ["accent-blue", "accent-green", "accent-violet", "accent-amber"];

function exploreLanguageMark(language) {
  return { english: "EN", japanese: "JP", all: "ALL" }[language] || "LF";
}

function renderMeter(progress) {
  const meter = el("div", "meter");
  const fill = el("span");
  fill.style.width = `${progress}%`;
  meter.appendChild(fill);
  return meter;
}

function renderHome() {
  clear(viewRoot);

  const dashboard = el("div", "home-dashboard");

  const greeting = el("header", "home-greeting");
  greeting.appendChild(el("h1", null, `早安，${getDisplayName()}`));
  greeting.appendChild(el("p", null, "今天也一起累積一點進步。"));
  dashboard.appendChild(greeting);

  const layout = el("div", "home-layout");
  const main = el("div", "home-main");
  const aside = el("aside", "home-aside");

  const progressPanel = el("section", "panel home-panel");
  const progressHeader = el("div", "panel-header");
  progressHeader.appendChild(el("h2", null, "今日學習進度"));
  const dateNav = el("div", "date-nav");
  dateNav.appendChild(el("button", null, "‹"));
  dateNav.appendChild(el("span", null, homeMock.calendar.monthLabel));
  dateNav.appendChild(el("button", null, "›"));
  progressHeader.appendChild(dateNav);
  progressPanel.appendChild(progressHeader);

  const statsPanel = el("div", "home-stats");
  const ring = el("div", "progress-ring home-progress-ring");
  ring.style.background = `conic-gradient(var(--blue) 0 ${homeMock.progressPercent}%, #e9edf5 ${homeMock.progressPercent}% 100%)`;
  ring.appendChild(el("span", null, `${homeMock.progressPercent}%`));
  statsPanel.appendChild(ring);

  const statGrid = el("div", "home-stat-grid");
  homeMock.stats.forEach((stat) => {
    const card = el("div", "stat-card");
    card.appendChild(el("span", "stat-label", stat.label));
    card.appendChild(el("strong", null, stat.value));
    card.appendChild(el("span", "stat-hint", stat.hint));
    statGrid.appendChild(card);
  });
  statsPanel.appendChild(statGrid);
  progressPanel.appendChild(statsPanel);
  main.appendChild(progressPanel);

  const calendarPanel = el("section", "panel home-panel home-calendar-panel");
  calendarPanel.appendChild(el("h2", null, "學習日曆"));
  const calendar = el("div", "calendar-grid");
  homeMock.calendar.weekdays.forEach((day) => {
    calendar.appendChild(el("span", "weekday", day));
  });
  homeMock.calendar.days.forEach((entry) => {
    let className = "calendar-day";
    if (entry.muted) className += " muted-day";
    if (entry.active) className += " active-day";
    if (entry.done) className += " done-day";
    calendar.appendChild(el("span", className, String(entry.day)));
  });
  calendarPanel.appendChild(calendar);
  const legend = el("div", "calendar-legend");
  [
    ["solid", "已完成"],
    ["", "部分完成"],
    ["empty", "未開始"],
  ].forEach(([type, label]) => {
    const item = el("span");
    item.appendChild(el("span", `legend-dot ${type}`.trim()));
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  });
  calendarPanel.appendChild(legend);

  const coursePanel = el("section", "panel home-panel");
  const courseHeader = el("div", "panel-header");
  courseHeader.appendChild(el("h2", null, "當前課程"));
  coursePanel.appendChild(courseHeader);

  const courseCard = el("article", "featured-course");
  courseCard.appendChild(el("div", "featured-course-thumb"));
  const courseBody = el("div", "featured-course-body");
  const tags = el("div", "tag-row");
  tags.appendChild(el("span", "tag blue", homeMock.currentCourse.level));
  courseBody.appendChild(tags);
  courseBody.appendChild(el("h3", null, homeMock.currentCourse.title));
  courseBody.appendChild(el("p", "featured-course-desc", homeMock.currentCourse.description));
  const courseProgress = el("div", "featured-course-progress");
  courseProgress.appendChild(renderMeter(homeMock.currentCourse.progress));
  courseProgress.appendChild(el("span", "featured-course-lesson", homeMock.currentCourse.lesson));
  courseBody.appendChild(courseProgress);
  const courseActions = el("div", "featured-course-actions");
  const continueBtn = el("button", "primary-button", "繼續學習");
  continueBtn.type = "button";
  continueBtn.addEventListener("click", () => navigateTo("learn"));
  courseActions.appendChild(continueBtn);
  const bookmarkBtn = el("button", "ghost-button icon-only", "☆");
  bookmarkBtn.type = "button";
  bookmarkBtn.disabled = true;
  bookmarkBtn.setAttribute("aria-label", "收藏課程");
  courseActions.appendChild(bookmarkBtn);
  courseBody.appendChild(courseActions);
  courseCard.appendChild(courseBody);
  coursePanel.appendChild(courseCard);
  main.appendChild(coursePanel);

  const lowerRow = el("div", "home-lower-row");

  const shortcutPanel = el("section", "panel home-panel");
  shortcutPanel.appendChild(el("h2", null, "學習捷徑"));
  const shortcutGrid = el("div", "shortcut-grid");
  homeMock.shortcuts.forEach((item) => {
    const card = el("article", "shortcut");
    if (item.icon === "bookmark") {
      card.classList.add("shortcut-clickable");
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.addEventListener("click", () => navigateTo("favorites"));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigateTo("favorites");
        }
      });
    }
    const iconWrap = el("span", "shortcut-icon");
    iconWrap.appendChild(icon(item.icon));
    card.appendChild(iconWrap);
    const copy = el("div", "shortcut-copy");
    copy.appendChild(el("strong", null, item.title));
    const metaText = item.icon === "bookmark" ? `${state.savedCount} 項` : item.meta;
    copy.appendChild(el("p", null, metaText));
    card.appendChild(copy);
    shortcutGrid.appendChild(card);
  });
  shortcutPanel.appendChild(shortcutGrid);
  lowerRow.appendChild(shortcutPanel);

  const recommendPanel = el("section", "panel home-panel");
  recommendPanel.appendChild(el("h2", null, "推薦課程"));
  const recommendRow = el("div", "recommended-row");
  homeMock.recommended.forEach((item) => {
    const card = el("article", "recommended-card");
    card.appendChild(el("div", "recommended-thumb"));
    const body = el("div", "recommended-body");
    const cardTags = el("div", "tag-row");
    cardTags.appendChild(el("span", "tag blue", item.level));
    body.appendChild(cardTags);
    body.appendChild(el("h3", null, item.title));
    body.appendChild(renderMeter(item.progress));
    card.appendChild(body);
    recommendRow.appendChild(card);
  });
  recommendPanel.appendChild(recommendRow);
  lowerRow.appendChild(recommendPanel);
  main.appendChild(lowerRow);

  aside.appendChild(calendarPanel);

  const chatPanel = el("section", "panel home-panel home-side-panel");
  chatPanel.appendChild(el("h2", null, "AI 對話練習"));
  const chatPreview = el("div", "chat-preview");
  homeMock.chatPreview.forEach((message) => {
    const bubble = el("div", `message ${message.role}`);
    bubble.appendChild(el("p", null, message.text));
    bubble.appendChild(el("p", "message-sub", message.sub));
    chatPreview.appendChild(bubble);
  });
  chatPanel.appendChild(chatPreview);
  const chatBtn = el("button", "ghost-button home-side-action", "開始對話練習");
  chatBtn.type = "button";
  chatBtn.disabled = true;
  chatPanel.appendChild(chatBtn);
  aside.appendChild(chatPanel);

  const analysisPanel = el("section", "panel home-panel home-side-panel");
  analysisPanel.appendChild(el("h2", null, "學習分析"));
  const analysis = el("div", "analysis-score");
  const scoreRing = el("div", "score-ring");
  scoreRing.style.background = `conic-gradient(var(--blue) 0 ${homeMock.analysis.score}%, #e8edf5 ${homeMock.analysis.score}% 100%)`;
  scoreRing.appendChild(el("span", null, `${homeMock.analysis.score}`));
  analysis.appendChild(scoreRing);
  const analysisText = el("div", "analysis-copy");
  analysisText.appendChild(el("p", "analysis-heading", "做得好的地方"));
  const strengths = el("ul");
  homeMock.analysis.strengths.forEach((line) => {
    strengths.appendChild(el("li", null, line));
  });
  analysisText.appendChild(strengths);
  analysisText.appendChild(el("p", "analysis-heading", "可以加強的地方"));
  const improvements = el("ul");
  homeMock.analysis.improvements.forEach((line) => {
    improvements.appendChild(el("li", null, line));
  });
  analysisText.appendChild(improvements);
  analysis.appendChild(analysisText);
  analysisPanel.appendChild(analysis);
  aside.appendChild(analysisPanel);

  layout.appendChild(main);
  layout.appendChild(aside);
  dashboard.appendChild(layout);
  viewRoot.appendChild(dashboard);
}

function renderExplore() {
  clear(viewRoot);
  const page = el("div", "explore-page");
  viewRoot.appendChild(page);

  const header = el("header", "explore-header");
  header.appendChild(el("h1", null, "情境探索"));
  header.appendChild(el("p", null, "選擇一個情境，由淺入深完成各堂課程。"));
  if (state.scenarios.length) {
    header.appendChild(el("span", "explore-count", `${state.scenarios.length} 個情境`));
  }
  page.appendChild(header);

  if (state.errorMessage) {
    page.appendChild(renderErrorPanel(state.errorMessage));
  }

  const toolbar = el("div", "explore-toolbar");
  toolbar.appendChild(el("span", "explore-toolbar-label", "語言篩選"));
  renderLanguageFilters(
    toolbar,
    async (lang) => {
      state.language = lang;
      try {
        await loadScenarios();
        state.errorMessage = "";
      } catch (error) {
        state.errorMessage = error.message;
      }
      render();
    },
    { compact: true },
  );
  page.appendChild(toolbar);

  const list = el("section", "explore-grid");
  if (!state.scenarios.length) {
    const empty = el("div", "explore-empty panel");
    empty.appendChild(el("h2", null, "尚無情境"));
    empty.appendChild(el("p", "muted", "請執行 spec/operate/SQL.md 寫入種子資料。"));
    list.appendChild(empty);
  } else {
    state.scenarios.forEach((scenario, index) => {
      const card = el("article", "explore-card");
      const accent = exploreAccents[index % exploreAccents.length];

      const cover = el("div", `explore-card-cover ${accent}`);
      cover.appendChild(el("span", "explore-card-mark", exploreLanguageMark(scenario.language)));
      cover.appendChild(el("span", "explore-card-count", `${scenario.course_count} 堂`));
      card.appendChild(cover);

      const body = el("div", "explore-card-body");
      const tags = el("div", "tag-row");
      tags.appendChild(el("span", "tag blue", languageLabel(scenario.language)));
      tags.appendChild(el("span", "tag", `${scenario.course_count} 堂課`));
      body.appendChild(tags);
      body.appendChild(el("h3", null, scenario.title));
      body.appendChild(el("p", "explore-card-desc", scenario.description));
      card.appendChild(body);

      const footer = el("div", "explore-card-footer");
      footer.appendChild(el("span", "explore-card-meta", "情境課程"));
      const button = el("button", "explore-card-link", "查看課程");
      button.type = "button";
      button.addEventListener("click", async () => {
        try {
          await loadScenarioDetail(scenario.id);
          state.view = "scenario";
          state.errorMessage = "";
        } catch (error) {
          state.errorMessage = error.message;
        }
        render();
      });
      footer.appendChild(button);
      card.appendChild(footer);

      list.appendChild(card);
    });
  }
  page.appendChild(list);
}

function renderSavedTypeFilters(container, onChange) {
  const row = el("div", "filter-row filter-row-compact");
  [
    ["all", "全部"],
    ["vocabulary", "單字"],
    ["sentence", "句子"],
  ].forEach(([value, label]) => {
    const button = el(
      "button",
      `chip-button ${state.savedFilter === value ? "active" : ""}`,
      label,
    );
    button.type = "button";
    button.addEventListener("click", () => onChange(value));
    row.appendChild(button);
  });
  container.appendChild(row);
}

function renderFavorites() {
  clear(viewRoot);
  const page = el("div", "favorites-page");
  viewRoot.appendChild(page);

  const header = el("header", "favorites-header");
  header.appendChild(el("h1", null, "我的收藏"));
  header.appendChild(
    el("p", null, "複習你標記的單字與句子，或回到原課程繼續學習。"),
  );
  if (state.savedCount > 0 && !state.savedLoading) {
    header.appendChild(el("span", "favorites-count", `${state.savedItems.length} 項`));
  }
  page.appendChild(header);

  const toolbar = el("div", "favorites-toolbar");
  renderSavedTypeFilters(toolbar, async (filter) => {
    state.savedFilter = filter;
    await loadSavedItems();
    render();
  });
  renderLanguageFilters(
    toolbar,
    async (lang) => {
      state.savedLanguage = lang;
      await loadSavedItems();
      render();
    },
    { compact: true, languageKey: "savedLanguage" },
  );
  page.appendChild(toolbar);

  if (state.savedLoading) {
    const loading = el("section", "panel favorites-loading");
    loading.appendChild(el("p", "muted", "載入收藏中…"));
    page.appendChild(loading);
    return;
  }

  if (state.savedError) {
    const panel = el("section", "panel favorites-setup-error");
    panel.appendChild(el("h2", null, "無法載入收藏"));
    panel.appendChild(el("p", "muted", state.savedError));
    if (state.savedApiReady === "tables_missing") {
      panel.appendChild(
        el(
          "p",
          "muted",
          "請在資料庫執行 spec/database/schema.sql 建立 user_saved_vocabulary 與 user_saved_sentences。",
        ),
      );
    } else {
      panel.appendChild(
        el(
          "p",
          "muted",
          "若使用 Docker：cd deploy && docker compose up -d --build backend。若用 uvicorn：重啟後端程序。",
        ),
      );
    }
    page.appendChild(panel);
    return;
  }

  if (!state.savedItems.length) {
    const empty = el("section", "panel favorites-empty");
    empty.appendChild(el("h2", null, "尚無收藏"));
    empty.appendChild(
      el("p", "muted", "在「學習」課程中，點句子或單字旁的書籤圖示即可加入收藏。"),
    );
    const button = el("button", "primary-button", "前往情境探索");
    button.type = "button";
    button.addEventListener("click", () => navigateTo("learn"));
    empty.appendChild(button);
    page.appendChild(empty);
    return;
  }

  const list = el("section", "favorites-list");
  state.savedItems.forEach((item) => {
    const card = el("article", "favorite-card");
    const isVocab = item.item_type === "vocabulary";

    const top = el("div", "favorite-card-top");
    const tags = el("div", "tag-row");
    tags.appendChild(el("span", "tag blue", isVocab ? "單字" : "句子"));
    tags.appendChild(el("span", "tag", languageLabel(item.language)));
    top.appendChild(tags);

    const removeBtn = el("button", "favorite-remove-btn");
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", "移除收藏");
    removeBtn.appendChild(createSvgIcon(["M18 6 6 18", "M6 6l12 12"], 16));
    removeBtn.addEventListener("click", () => removeFavoriteItem(item.id));
    top.appendChild(removeBtn);
    card.appendChild(top);

    if (isVocab) {
      card.appendChild(el("h3", "favorite-card-title", item.term));
      if (item.romaji) {
        card.appendChild(el("p", "favorite-card-romaji", item.romaji));
      }
      if (item.reading && item.reading !== item.term) {
        card.appendChild(el("p", "favorite-card-reading", item.reading));
      }
      card.appendChild(el("p", "favorite-card-meaning", item.meaning));
      if (item.example_sentence) {
        card.appendChild(el("p", "favorite-card-example", item.example_sentence));
      }
    } else {
      card.appendChild(el("h3", "favorite-card-title", item.target_text));
      if (item.romaji) {
        card.appendChild(el("p", "favorite-card-romaji", item.romaji));
      }
      if (item.reading && item.reading !== item.target_text) {
        card.appendChild(el("p", "favorite-card-reading", item.reading));
      }
      card.appendChild(el("p", "favorite-card-meaning", item.translation));
    }

    const meta = el("div", "favorite-card-meta");
    meta.appendChild(el("span", null, item.scenario_title));
    meta.appendChild(el("span", "favorite-card-meta-sep", "·"));
    meta.appendChild(el("span", null, item.course_title));
    card.appendChild(meta);

    const actions = el("div", "favorite-card-actions");
    const openBtn = el("button", "primary-button favorite-open-btn", "查看課程");
    openBtn.type = "button";
    openBtn.addEventListener("click", () => openSavedItem(item));
    actions.appendChild(openBtn);

    const audioUrl = isVocab ? item.audio_url : item.audio_url;
    if (audioUrl) {
      const playBtn = el("button", "ghost-button", "播放語音");
      playBtn.type = "button";
      playBtn.addEventListener("click", () => {
        playAudioUrl(audioUrl, { label: isVocab ? "單字" : "句子" });
      });
      actions.appendChild(playBtn);
    }

    card.appendChild(actions);
    list.appendChild(card);
  });
  page.appendChild(list);
}

function renderScenarioDetail() {
  clear(viewRoot);
  const page = el("div", "scenario-page");
  viewRoot.appendChild(page);

  const scenario = state.scenarioDetail;
  if (!scenario) {
    page.appendChild(renderErrorPanel("找不到情境"));
    return;
  }

  page.appendChild(
    createPageHeader(scenario.title, scenario.description, "返回情境列表", () => {
      state.view = "learn";
      state.scenarioDetail = null;
      render();
    }),
  );

  const meta = el("div", "scenario-meta-row");
  meta.appendChild(el("span", "scenario-count", `${scenario.courses.length} 堂課`));
  meta.appendChild(el("span", "scenario-lang", languageLabel(scenario.language)));
  page.appendChild(meta);

  const list = el("section", "course-grid");
  scenario.courses.forEach((course) => {
    const card = el("article", "course-card");

    const top = el("div", "course-card-top");
    top.appendChild(el("span", "course-lesson-no", `第 ${course.order_index} 課`));
    top.appendChild(el("span", `tag ${levelTagClass(course.level)}`, levelLabel(course.level)));
    card.appendChild(top);

    card.appendChild(el("h3", null, course.title));
    card.appendChild(el("p", "course-card-desc", course.description));

    const stats = el("div", "course-card-stats");
    stats.appendChild(el("span", null, `${course.estimated_minutes} 分鐘`));
    stats.appendChild(el("span", null, `${course.sentence_count} 句`));
    stats.appendChild(el("span", null, `${course.vocabulary_count} 字`));
    card.appendChild(stats);

    const footer = el("div", "course-card-footer");
    const button = el("button", "course-card-link", "開始這堂課");
    button.type = "button";
    button.addEventListener("click", () => {
      window.learnflowLesson.start(scenario.id, course.id);
    });
    footer.appendChild(button);

    const browseButton = el("button", "course-card-browse", "瀏覽內容");
    browseButton.type = "button";
    browseButton.addEventListener("click", async () => {
      try {
        await loadCourseDetail(scenario.id, course.id);
        state.view = "course";
        state.errorMessage = "";
      } catch (error) {
        state.errorMessage = error.message;
      }
      render();
    });
    footer.appendChild(browseButton);
    card.appendChild(footer);

    list.appendChild(card);
  });
  page.appendChild(list);
}

function playSentence(sentence) {
  playAudioUrl(sentence.audio_url, { label: "句子" });
}

function renderCourseDetail() {
  clear(viewRoot);
  const page = el("div", "lesson-page");
  viewRoot.appendChild(page);

  const course = state.courseDetail;
  if (!course) {
    page.appendChild(renderErrorPanel("找不到課程"));
    return;
  }

  page.appendChild(
    createPageHeader(course.title, course.description, "返回課程列表", () => {
      state.view = "scenario";
      state.courseDetail = null;
      render();
    }),
  );

  const meta = el("div", "lesson-meta-row");
  meta.appendChild(el("span", "lesson-meta-item", `第 ${course.order_index} 課`));
  meta.appendChild(el("span", "lesson-meta-item", `${course.sentences.length} 句`));
  meta.appendChild(el("span", "lesson-meta-item", `${course.vocabulary.length} 字`));
  meta.appendChild(el("span", `tag ${levelTagClass(course.level)}`, levelLabel(course.level)));
  const startFlowBtn = el("button", "primary-button lesson-start-flow-btn", "開始學習流程");
  startFlowBtn.type = "button";
  startFlowBtn.addEventListener("click", () => {
    window.learnflowLesson.start(course.scenario_id, course.id);
  });
  meta.appendChild(startFlowBtn);
  page.appendChild(meta);

  const layout = el("div", "lesson-layout");
  const main = el("section", "lesson-main");
  const sentences = course.sentences;
  const current = sentences[state.selectedSentenceIndex];

  if (current) {
    const nav = el("div", "sentence-nav");
    const navHeader = el("div", "sentence-nav-header");
    navHeader.appendChild(el("span", "sentence-nav-label", "句子進度"));
    navHeader.appendChild(
      el("span", "sentence-nav-count", `${state.selectedSentenceIndex + 1} / ${sentences.length}`),
    );
    nav.appendChild(navHeader);

    const tabs = el("div", "sentence-nav-tabs");
    sentences.forEach((sentence, index) => {
      const tab = el(
        "button",
        `sentence-tab ${state.selectedSentenceIndex === index ? "active" : ""}`,
        `${index + 1}`,
      );
      tab.type = "button";
      tab.setAttribute("aria-label", `第 ${index + 1} 句`);
      tab.addEventListener("click", () => {
        state.selectedSentenceIndex = index;
        resetSentenceView();
        render();
      });
      tabs.appendChild(tab);
    });
    nav.appendChild(tabs);
    main.appendChild(nav);

    const stage = el("div", "lesson-stage");
    const content = el("div", "lesson-stage-content");

    content.appendChild(el("p", "lesson-eyebrow", `句子 ${current.order_index}`));
    content.appendChild(el("div", "target", current.target_text));

    if (current.romaji) {
      content.appendChild(el("p", "lesson-romaji", current.romaji));
    }
    if (current.reading && current.reading !== current.target_text) {
      content.appendChild(el("p", "lesson-reading", current.reading));
    }
    content.appendChild(createTranslationToggle(current.translation));

    const actions = el("div", "lesson-actions");
    actions.appendChild(
      createFavoriteButton({
        itemType: "sentence",
        itemId: current.id,
        isSaved: isSentenceSaved(current.id),
      }),
    );

    const playButton = el("button", "lesson-btn lesson-btn-primary", "播放語音");
    playButton.type = "button";
    playButton.addEventListener("click", () => playSentence(current));
    actions.appendChild(playButton);

    if (state.selectedSentenceIndex > 0) {
      const prevButton = el("button", "lesson-btn lesson-btn-secondary", "上一句");
      prevButton.type = "button";
      prevButton.addEventListener("click", () => {
        state.selectedSentenceIndex -= 1;
        resetSentenceView();
        render();
      });
      actions.appendChild(prevButton);
    }

    if (state.selectedSentenceIndex < sentences.length - 1) {
      const nextButton = el("button", "lesson-btn lesson-btn-secondary", "下一句");
      nextButton.type = "button";
      nextButton.addEventListener("click", () => {
        state.selectedSentenceIndex += 1;
        resetSentenceView();
        render();
      });
      actions.appendChild(nextButton);
    }

    content.appendChild(actions);
    stage.appendChild(content);
    main.appendChild(stage);
  } else {
    main.appendChild(el("p", "muted", "此課程尚無句子"));
  }

  layout.appendChild(main);

  const aside = el("aside", "lesson-aside");
  const vocabPanel = el("section", "vocab-panel");
  const vocabHeader = el("div", "vocab-panel-header");
  vocabHeader.appendChild(el("h2", null, "本課單字"));
  vocabHeader.appendChild(el("span", "vocab-panel-count", `${course.vocabulary.length}`));
  vocabPanel.appendChild(vocabHeader);

  const sideList = el("div", "vocab-list");
  if (!course.vocabulary.length) {
    sideList.appendChild(el("p", "muted", "此課程尚無單字"));
  } else {
    course.vocabulary.forEach((item) => {
      const card = el("article", "vocab-card");
      const top = el("div", "vocab-card-top");

      const termBlock = el("div", "vocab-term-block");
      termBlock.appendChild(el("strong", null, item.term));
      if (item.romaji) {
        termBlock.appendChild(el("span", "vocab-romaji", item.romaji));
      }
      if (item.reading && item.reading !== item.term) {
        termBlock.appendChild(el("span", "vocab-reading", item.reading));
      }
      top.appendChild(termBlock);

      if (item.audio_url) {
        const vocabPlay = el("button", "vocab-play-btn", "播放");
        vocabPlay.type = "button";
        vocabPlay.addEventListener("click", () => {
          playAudioUrl(item.audio_url, { label: "單字" });
        });
        top.appendChild(vocabPlay);
      }

      top.appendChild(
        createFavoriteButton({
          itemType: "vocabulary",
          itemId: item.id,
          isSaved: isVocabularySaved(item.id),
          compact: true,
        }),
      );
      card.appendChild(top);

      card.appendChild(el("p", "vocab-meaning", item.meaning));
      if (item.example_sentence) {
        card.appendChild(el("p", "vocab-example", item.example_sentence));
      }

      sideList.appendChild(card);
    });
  }
  vocabPanel.appendChild(sideList);
  aside.appendChild(vocabPanel);
  layout.appendChild(aside);

  page.appendChild(layout);
}

function render() {
  const scrollTop = shouldScrollToTop();

  renderNav();
  applySidebarState();

  if (state.view === "home") renderHome();
  else if (state.view === "learn") renderExplore();
  else if (state.view === "scenario") renderScenarioDetail();
  else if (state.view === "course") renderCourseDetail();
  else if (state.view === "lesson") window.learnflowLesson.renderView();
  else if (state.view === "favorites") renderFavorites();
  else {
    const item = navItems.find((entry) => entry.id === state.view);
    renderComingSoon(item ? item.label : "功能");
  }

  refreshIcons();

  if (scrollTop) scrollViewToTop();
}

function handleNavClick(event) {
  const button = event.target.closest("[data-view]");
  if (!button || button.disabled) return;
  navigateTo(button.dataset.view);
}

navList.addEventListener("click", handleNavClick);
mobileTabbar.addEventListener("click", handleNavClick);
sidebarCollapseBtn.addEventListener("click", toggleSidebarCollapse);
sidebarToggleBtn.addEventListener("click", toggleMobileSidebar);
sidebarBackdrop.addEventListener("click", closeMobileSidebar);

async function init() {
  applySidebarState();
  await checkHealth();
  await bootstrapSavedState();
  try {
    await loadScenarios();
  } catch (error) {
    state.errorMessage = error.message;
  }
  render();
}

window.addEventListener("learnflow:auth-ready", () => {
  init();
});
