/**
 * 收藏 API — 對接 /api/saved、/api/vocabulary/.../favorite、/api/sentences/.../favorite
 */

const SAVED_API = resolveLearnFlowApiBase();

function formatSavedApiError(message, status) {
  const text = String(message || "");
  if (status === 404 || text === "Not Found") {
    return "收藏 API 尚未啟用。請重新 build 並啟動 backend（docker compose up -d --build backend），或重啟 uvicorn。";
  }
  if (/relation .* does not exist/i.test(text) || /user_saved_/i.test(text)) {
    return "資料庫缺少收藏資料表。請執行：psql \"$DATABASE_URL\" -f spec/database/schema.sql";
  }
  return text || "收藏操作失敗";
}

async function savedRequest(path, options = {}) {
  const response = await authFetch(`${SAVED_API}${path}`, options);
  if (!response) return null;
  if (response.status === 204) return { ok: true };
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body.detail) {
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(formatSavedApiError(detail, response.status));
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchSavedItems(options = {}) {
  const params = new URLSearchParams();
  if (options.type) params.set("type", options.type);
  if (options.language && options.language !== "all") params.set("language", options.language);
  params.set("limit", String(options.limit ?? 100));
  const query = params.toString();
  return savedRequest(`/saved${query ? `?${query}` : ""}`);
}

async function favoriteVocabulary(vocabularyId) {
  return savedRequest(`/vocabulary/${encodeURIComponent(vocabularyId)}/favorite`, {
    method: "POST",
  });
}

async function unfavoriteVocabulary(vocabularyId) {
  return savedRequest(`/vocabulary/${encodeURIComponent(vocabularyId)}/favorite`, {
    method: "DELETE",
  });
}

async function favoriteSentence(sentenceId) {
  return savedRequest(`/sentences/${encodeURIComponent(sentenceId)}/favorite`, {
    method: "POST",
  });
}

async function unfavoriteSentence(sentenceId) {
  return savedRequest(`/sentences/${encodeURIComponent(sentenceId)}/favorite`, {
    method: "DELETE",
  });
}

async function removeSavedItem(savedId) {
  return savedRequest(`/saved/${encodeURIComponent(savedId)}`, {
    method: "DELETE",
  });
}

function applySavedItemsToState(items) {
  const list = Array.isArray(items) ? items : [];
  window.learnflowSavedState.savedItems = list;
  window.learnflowSavedState.savedVocabIds = new Set(
    list.filter((item) => item.item_type === "vocabulary").map((item) => item.item_id),
  );
  window.learnflowSavedState.savedSentenceIds = new Set(
    list.filter((item) => item.item_type === "sentence").map((item) => item.item_id),
  );
  window.learnflowSavedState.savedCount = list.length;
}

async function refreshSavedState(options = {}) {
  const items = await fetchSavedItems(options);
  applySavedItemsToState(items);
  return items;
}

window.learnflowSavedState = {
  savedItems: [],
  savedVocabIds: new Set(),
  savedSentenceIds: new Set(),
  savedCount: 0,
};

window.learnflowSavedApi = {
  fetchSavedItems,
  favoriteVocabulary,
  unfavoriteVocabulary,
  favoriteSentence,
  unfavoriteSentence,
  removeSavedItem,
  refreshSavedState,
  applySavedItemsToState,
  formatSavedApiError,
  isVocabularySaved: (id) => window.learnflowSavedState.savedVocabIds.has(id),
  isSentenceSaved: (id) => window.learnflowSavedState.savedSentenceIds.has(id),
};
