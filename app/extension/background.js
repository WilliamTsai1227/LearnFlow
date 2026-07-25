/**
 * LearnFlow 擴充 — background service worker
 * 負責：
 *  - 保管 LearnFlow API base（chrome.storage.local）與目標語言
 *  - 用網站的 refresh_token cookie 換取 access token（呼叫 /api/user/extension/token，不輪替）
 *  - 代 content script 執行需驗證的 API 呼叫（translate / capture），令 token 只留在背景
 */

const DEFAULT_API_BASE = "http://localhost";

async function getSettings() {
  const { apiBase, targetLanguage, sourceLanguage } = await chrome.storage.local.get([
    "apiBase",
    "targetLanguage",
    "sourceLanguage",
  ]);
  return {
    apiBase: (apiBase || DEFAULT_API_BASE).replace(/\/$/, ""),
    targetLanguage: targetLanguage || "zh-TW",
    sourceLanguage: sourceLanguage || "japanese",
  };
}

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function readRefreshCookie(apiBase) {
  // 需要 cookies 權限 + host_permissions 涵蓋 apiBase
  const cookie = await chrome.cookies.get({ url: apiBase, name: "refresh_token" });
  return cookie ? cookie.value : null;
}

async function getAccessToken() {
  const { apiBase } = await getSettings();
  const cached = await chrome.storage.session.get(["accessToken", "tokenExp"]);
  if (cached.accessToken && cached.tokenExp && Date.now() < cached.tokenExp - 30000) {
    return cached.accessToken;
  }

  const refreshToken = await readRefreshCookie(apiBase);
  if (!refreshToken) {
    throw new Error("尚未登入 LearnFlow（找不到登入 cookie）");
  }

  const res = await fetch(`${apiBase}/api/user/extension/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    throw new Error("登入已過期，請重新登入 LearnFlow");
  }
  const data = await res.json();
  const token = data.access_token;
  await chrome.storage.session.set({
    accessToken: token,
    tokenExp: decodeJwtExp(token),
  });
  return token;
}

async function apiFetch(path, options = {}) {
  const { apiBase } = await getSettings();
  const token = await getAccessToken();
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    // token 失效，清掉重試一次
    await chrome.storage.session.remove(["accessToken", "tokenExp"]);
    const retryToken = await getAccessToken();
    const retry = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${retryToken}`,
        ...(options.headers || {}),
      },
    });
    if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
    return retry.status === 204 ? null : retry.json();
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// 語音合成（audio/mpeg）需要用 arrayBuffer 讀取，不能像 apiFetch 那樣一律 .json()；
// 回傳 base64，讓 content script 能安全地跨 chrome.runtime 訊息傳遞後還原成 Blob 播放。
async function apiFetchBinary(path, { retry = true } = {}) {
  const { apiBase } = await getSettings();
  const token = await getAccessToken();
  const res = await fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && retry) {
    await chrome.storage.session.remove(["accessToken", "tokenExp"]);
    return apiFetchBinary(path, { retry: false });
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  const buf = await res.arrayBuffer();
  return { mime: res.headers.get("Content-Type") || "audio/mpeg", base64: arrayBufferToBase64(buf) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.action === "getSettings") {
        sendResponse({ ok: true, data: await getSettings() });
      } else if (msg.action === "authStatus") {
        try {
          await getAccessToken();
          sendResponse({ ok: true, data: { loggedIn: true } });
        } catch (err) {
          sendResponse({ ok: true, data: { loggedIn: false, reason: err.message } });
        }
      } else if (msg.action === "translate") {
        const data = await apiFetch("/api/translate", {
          method: "POST",
          body: JSON.stringify(msg.payload),
        });
        sendResponse({ ok: true, data });
      } else if (msg.action === "capture") {
        const data = await apiFetch("/api/captures", {
          method: "POST",
          body: JSON.stringify(msg.payload),
        });
        sendResponse({ ok: true, data });
      } else if (msg.action === "tts") {
        const { text, language } = msg.payload;
        const data = await apiFetchBinary(
          `/api/tts?text=${encodeURIComponent(text)}&language=${encodeURIComponent(language)}`,
        );
        sendResponse({ ok: true, data });
      } else {
        sendResponse({ ok: false, error: "unknown action" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // 非同步回覆
});
