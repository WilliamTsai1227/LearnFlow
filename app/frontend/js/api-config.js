/**
 * 解析後端 API 基底 URL（/api 前綴）與音檔基底 URL。
 *
 * 可選覆寫（在載入本檔之前設定）：
 * - window.LEARNFLOW_API_BASE = '/api' 或完整 URL
 * - window.API_BACKEND_PORT = 8002            本機 backend port
 * - window.LEARNFLOW_AUDIO_BASE = '' 或 Blob 容器網址（'' 表示同網域）
 */
// 前端部署在 Static Web Apps 時，後端在另一個網域（Container Apps），必須指定完整位址。
// 之後接上自訂網域（app.xxx / api.xxx）後，前後端同站，這個分支就不會再被用到。
const LEARNFLOW_CONTAINER_APP_API =
    'https://learnflow-backend.redcliff-a88da9ee.westus2.azurecontainerapps.io/api';

function resolveLearnFlowApiBase() {
    if (typeof window.LEARNFLOW_API_BASE === 'string' && window.LEARNFLOW_API_BASE) {
        return window.LEARNFLOW_API_BASE.replace(/\/$/, '');
    }

    // Static Web Apps 的 /api 指向它自己的 Managed Functions，不是我們的後端
    if (window.location.hostname.endsWith('.azurestaticapps.net')) {
        return LEARNFLOW_CONTAINER_APP_API;
    }

    if (window.location.protocol === 'https:') {
        return `${window.location.origin}/api`;
    }

    const port = window.location.port;
    if (!port || port === '80') {
        return `${window.location.origin}/api`;
    }

    const raw = window.API_BACKEND_PORT;
    const backendPort =
        typeof raw === 'number' ? raw
        : typeof raw === 'string' ? parseInt(raw, 10) || 8002
        : 8002;
    const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
    let host = window.location.hostname;
    if (!host || host === '') {
        host = '127.0.0.1';
    }
    return `${proto}//${host}:${backendPort}/api`;
}

// ── 音檔位置 ──────────────────────────────────────────────────────────
// DB 的 audio_url 存的是相對路徑，例如 audio/japanese/kana/katakana/wa.mp3。
// 本機／nginx 同網域部署：直接沿用根目錄相對路徑（音檔在 app/frontend/audio）。
// 雲端：音檔不隨 Static Web Apps 部署（142MB、8458 個檔案），改放 Blob Storage。
//
// 容器名稱為 media，音檔連同 audio/ 前綴一起上傳，因此路徑可直接串接。
const LEARNFLOW_AUDIO_BASE_CLOUD =
    'https://learnflowstorage.blob.core.windows.net/media';

function resolveLearnFlowAudioBase() {
    if (typeof window.LEARNFLOW_AUDIO_BASE === 'string') {
        return window.LEARNFLOW_AUDIO_BASE.replace(/\/$/, '');
    }
    if (window.location.hostname.endsWith('.azurestaticapps.net')) {
        return LEARNFLOW_AUDIO_BASE_CLOUD;
    }
    return '';
}

/**
 * 把 DB 的 audio_url 轉成可播放的完整網址。
 * 已是完整 http(s) 網址則原樣返回，方便日後 DB 直接存絕對路徑。
 */
function learnflowAudioUrl(path) {
    const clean = String(path || '').replace(/^\/+/, '');
    if (!clean) return '';
    if (/^https?:\/\//i.test(clean)) return clean;
    const base = resolveLearnFlowAudioBase();
    return base ? `${base}/${clean}` : `/${clean}`;
}
