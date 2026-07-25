const DEFAULT_API_BASE = "http://localhost";

const apiBaseInput = document.getElementById("apiBase");
const sourceSel = document.getElementById("sourceLanguage");
const targetSel = document.getElementById("targetLanguage");
const statusEl = document.getElementById("status");
const savedEl = document.getElementById("saved");
const openSite = document.getElementById("openSite");

async function load() {
  const cfg = await chrome.storage.local.get(["apiBase", "sourceLanguage", "targetLanguage"]);
  apiBaseInput.value = cfg.apiBase || DEFAULT_API_BASE;
  sourceSel.value = cfg.sourceLanguage || "japanese";
  targetSel.value = cfg.targetLanguage || "zh-TW";
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
  await chrome.storage.local.set({
    apiBase,
    sourceLanguage: sourceSel.value,
    targetLanguage: targetSel.value,
  });
  await chrome.storage.session.remove(["accessToken", "tokenExp"]);
  openSite.href = apiBase;
  savedEl.textContent = "已儲存 ✓";
  setTimeout(() => (savedEl.textContent = ""), 1500);
  refreshStatus();
});

load();
