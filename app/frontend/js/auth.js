// Auth Module — RT Cookie + AT 記憶體（對齊 Stock-Insight-Chat 三重刷新機制）

const AUTH_API = resolveLearnFlowApiBase();

let _isRefreshing = false;
let _refreshPromise = null;
let _accessToken = null;
let _refreshTimer = null;

function setAccessToken(token) {
    _accessToken = token;
    _scheduleProactiveRefresh(token);
}

function getAccessToken() {
    return _accessToken;
}

function clearAccessToken() {
    _accessToken = null;
    if (_refreshTimer) {
        clearTimeout(_refreshTimer);
        _refreshTimer = null;
    }
}

function getUser() {
    try {
        return JSON.parse(localStorage.getItem('user'));
    } catch {
        return null;
    }
}

function isLoggedIn() {
    return !!_accessToken;
}

function decodeJwtPayload(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(
            atob(base64).split('').map(c =>
                '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
            ).join('')
        );
        return JSON.parse(jsonPayload);
    } catch {
        return null;
    }
}

function _scheduleProactiveRefresh(token) {
    if (_refreshTimer) {
        clearTimeout(_refreshTimer);
        _refreshTimer = null;
    }
    if (!token) return;

    const payload = decodeJwtPayload(token);
    if (!payload || !payload.exp) return;

    const nowMs = Date.now();
    const expMs = payload.exp * 1000;
    const refreshAtMs = expMs - 60 * 1000;
    const delayMs = refreshAtMs - nowMs;

    if (delayMs <= 0) {
        _silentRefresh();
        return;
    }

    _refreshTimer = setTimeout(() => {
        _refreshTimer = null;
        _silentRefresh();
    }, delayMs);
}

async function _silentRefresh() {
    const ok = await tryRefreshToken();
    if (!ok) {
        logout();
    }
}

async function tryRefreshToken() {
    if (_isRefreshing) {
        return _refreshPromise;
    }

    _isRefreshing = true;
    _refreshPromise = (async () => {
        try {
            const res = await fetch(`${AUTH_API}/user/refresh`, {
                method: 'POST',
                credentials: 'include',
            });

            if (!res.ok) return false;

            const data = await res.json();
            setAccessToken(data.access_token);
            return true;
        } catch {
            return false;
        } finally {
            _isRefreshing = false;
            _refreshPromise = null;
        }
    })();

    return _refreshPromise;
}

async function authFetch(url, options = {}) {
    let token = getAccessToken();
    if (!token) {
        window.location.href = 'login.html';
        return;
    }

    const payload = decodeJwtPayload(token);
    if (payload && payload.exp) {
        const currentTime = Math.floor(Date.now() / 1000);
        if (payload.exp - currentTime <= 90) {
            const refreshed = await tryRefreshToken();
            if (refreshed) {
                token = getAccessToken();
            } else {
                logout();
                return;
            }
        }
    }

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {}),
    };

    let res = await fetch(url, { ...options, headers, credentials: 'include' });

    if (res.status === 401) {
        const refreshed = await tryRefreshToken();
        if (refreshed) {
            headers['Authorization'] = `Bearer ${getAccessToken()}`;
            res = await fetch(url, { ...options, headers, credentials: 'include' });
        } else {
            logout();
            return;
        }
    }

    return res;
}

async function logout() {
    clearAccessToken();
    try {
        await fetch(`${AUTH_API}/user/logout`, {
            method: 'POST',
            credentials: 'include',
        });
    } catch {
        // 離線登出也要能清本地狀態
    }
    localStorage.removeItem('user');
    window.location.href = 'login.html';
}

function formatTierLabel(tierName) {
    const labels = { free: 'Free', pro: 'Pro', ultra: 'Ultra' };
    const key = (tierName || 'free').toLowerCase();
    return labels[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

function applyUserTierBadge(user) {
    const badge = document.getElementById('user-tier-badge');
    if (badge) {
        badge.textContent = formatTierLabel(user.subscription_tier);
    }
}

function initUserMenu() {
    const user = getUser();
    if (!user) return;

    const avatarEl = document.getElementById('user-avatar');
    const nameEl = document.getElementById('user-display-name');
    const dropdownNameEl = document.getElementById('user-display-name-dropdown');
    const dropdownAvatar = document.getElementById('dropdown-avatar-char');
    const displayName = user.display_name || user.username || user.email || 'U';
    const initial = displayName.charAt(0).toUpperCase();

    if (avatarEl) avatarEl.textContent = initial;
    if (dropdownAvatar) dropdownAvatar.textContent = initial;
    if (nameEl) nameEl.textContent = displayName;
    if (dropdownNameEl) dropdownNameEl.textContent = displayName;
    applyUserTierBadge(user);

    const trigger = document.getElementById('user-menu-trigger');
    const dropdown = document.getElementById('user-dropdown');
    if (trigger && dropdown) {
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('show');
        });
        document.addEventListener('click', () => {
            dropdown.classList.remove('show');
        });
        dropdown.addEventListener('click', (e) => e.stopPropagation());
    }

    const logoutBtn = document.getElementById('menu-logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            logout();
        });
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    const ok = await tryRefreshToken();
    if (!ok) {
        localStorage.removeItem('user');
        window.location.href = 'login.html';
        return;
    }

    try {
        const res = await authFetch(`${AUTH_API}/user`);
        if (res && res.ok) {
            const profile = await res.json();
            localStorage.setItem('user', JSON.stringify(profile));
        }
    } catch {
        // 非致命錯誤
    }

    initUserMenu();

    const user = getUser();
    if (user) {
        applyUserTierBadge(user);
    }

    window.dispatchEvent(new CustomEvent('learnflow:auth-ready'));
});
