/**
 * 解析後端 API 基底 URL（/api 前綴）。
 *
 * 可選覆寫（在載入本檔之前設定）：
 * - window.LEARNFLOW_API_BASE = '/api' 或完整 URL
 * - window.API_BACKEND_PORT = 8002            本機 backend port
 */
function resolveLearnFlowApiBase() {
    if (typeof window.LEARNFLOW_API_BASE === 'string' && window.LEARNFLOW_API_BASE) {
        return window.LEARNFLOW_API_BASE.replace(/\/$/, '');
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
