// popup 只負責「連線設定」與「登入狀態」；
// 學習相關設定（語言、雙字幕、字幕大小…）在 YouTube 播放器內的齒輪設定面板。
const DEFAULT_API_BASE = "http://localhost";

const apiBaseInput = document.getElementById("apiBase");
const statusEl = document.getElementById("status");
const savedEl = document.getElementById("saved");
const openSite = document.getElementById("openSite");

async function load() {
  const cfg = await chrome.storage.local.get(["apiBase"]);
  apiBaseInput.value = cfg.apiBase || DEFAULT_API_BASE;
  openSite.href = apiBaseInput.value.replace(/\/$/, "");
  refreshStatus();
}

function refreshStatus() {
  chrome.runtime.sendMessage({ action: "authStatus" }, (resp) => {
    if (resp && resp.ok && resp.data.loggedIn) {
      statusEl.className = "status ok";
      statusEl.textContent = "已登入 LearnFlow ✓";
    } else {
      statusEl.className = "status no";
      statusEl.textContent = "尚未登入 — 請先在 LearnFlow 網站登入";
    }
  });
}

document.getElementById("save").addEventListener("click", async () => {
  const apiBase = apiBaseInput.value.trim().replace(/\/$/, "") || DEFAULT_API_BASE;
  await chrome.storage.local.set({ apiBase });
  await chrome.storage.session.remove(["accessToken", "tokenExp"]);
  openSite.href = apiBase;
  savedEl.textContent = "已儲存 ✓";
  setTimeout(() => (savedEl.textContent = ""), 1500);
  refreshStatus();
});

load();
