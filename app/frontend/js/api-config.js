/**
 * 解析後端 API 基底 URL（/api 前綴）與音檔基底 URL。
 *
 * 可選覆寫（在載入本檔之前設定）：
 * - window.LEARNFLOW_API_BASE = '/api' 或完整 URL
 * - window.API_BACKEND_PORT = 8002            本機 backend port
 * - window.LEARNFLOW_AUDIO_BASE = '' 或 Blob 容器網址（'' 表示同網域）
 */
// 前端部署在 Static Web Apps 時，後端在另一個網域（Container Apps），必須指定完整位址。
// 自訂網域上 /api/* 由 Cloudflare Worker 轉發到後端，與前端同源，這個分支就不會被用到。
const LEARNFLOW_CONTAINER_APP_API =
    'https://learnflow-backend.redcliff-a88da9ee.westus2.azurecontainerapps.io/api';

/**
 * 唯一需要特別對待的環境是「本機開發」：音檔在磁碟上、後端可能跑在另一個 port。
 * 其餘一律視為正式環境，不綁定任何特定雲端網域——換自訂網域時才不用回頭改這裡。
 */
function isLocalHostname() {
    const host = window.location.hostname;
    return (
        !host ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '[::1]' ||
        host.endsWith('.local') ||
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)
    );
}

function resolveLearnFlowApiBase() {
    if (typeof window.LEARNFLOW_API_BASE === 'string' && window.LEARNFLOW_API_BASE) {
        return window.LEARNFLOW_API_BASE.replace(/\/$/, '');
    }

    // Static Web Apps 的 /api 被平台保留給它自己的 Managed Functions，永遠打不到我們的後端。
    // 這是平台限制而非環境判斷，所以這個 host 比對必須留著。
    if (window.location.hostname.endsWith('.azurestaticapps.net')) {
        return LEARNFLOW_CONTAINER_APP_API;
    }

    // 正式環境（自訂網域）：/api/* 由 Cloudflare Worker 轉發到 Container Apps，與前端同源。
    if (!isLocalHostname()) {
        return `${window.location.origin}/api`;
    }

    // 以下皆為本機開發
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
// 本機開發：直接沿用根目錄相對路徑（音檔在 app/frontend/audio，由 nginx／dev server 供應）。
// 其餘一律走 Blob Storage：音檔 142MB、8458 個檔案，不隨前端一起部署，
// 且 .dockerignore 也排除了 app/frontend/audio，所以任何雲端環境都拿不到本地檔案。
//
// 容器名稱為 media，音檔連同 audio/ 前綴一起上傳，因此路徑可直接串接。
const LEARNFLOW_AUDIO_BASE_CLOUD =
    'https://learnflowstorage.blob.core.windows.net/media';

function resolveLearnFlowAudioBase() {
    if (typeof window.LEARNFLOW_AUDIO_BASE === 'string') {
        return window.LEARNFLOW_AUDIO_BASE.replace(/\/$/, '');
    }
    return isLocalHostname() ? '' : LEARNFLOW_AUDIO_BASE_CLOUD;
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
