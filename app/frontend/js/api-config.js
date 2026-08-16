/**
 * 解析後端 API 基底 URL（/api 前綴）。
 *
 * 可選覆寫（在載入本檔之前設定）：
 * - window.LEARNFLOW_API_BASE = '/api' 或完整 URL
 * - window.API_BACKEND_PORT = 8002            本機 backend port
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
