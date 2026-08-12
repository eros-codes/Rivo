export function getCsrfToken() {
    // Preferred: read from a meta tag inserted by server-side templates.
    try {
        const meta = document.querySelector('meta[name="csrf-token"], meta[name="csrf"], meta[name="_csrf"]');
        if (meta && meta.content) return String(meta.content).trim();
    } catch (e) {
        /* ignore */
    }

    // Fallback: try common cookie names used by the server or libraries.
    try {
        const raw = typeof document !== 'undefined' && document.cookie ? document.cookie : "";
        const parts = raw.split(";").map((c) => c.trim()).filter(Boolean);
        const candidates = ["csrfToken", "_csrf", "csrf"];
        for (const name of candidates) {
            const kv = parts.find((p) => p.startsWith(name + "="));
            if (kv) return decodeURIComponent(kv.split("=").slice(1).join("=") || "");
        }
    } catch (e) {
        /* ignore cookie parsing errors */
    }

    return "";
}

export function buildHeaders(isJson = true) {
    const h = {};
    const token = getCsrfToken();
    if (token) h["x-csrf-token"] = token;
    if (isJson) h["Content-Type"] = "application/json";
    return h;
}

function _headersContainCsrf(headers) {
    if (!headers) return false;
    try {
        for (const k of Object.keys(headers)) {
            if (String(k).toLowerCase() === 'x-csrf-token' && headers[k]) return true;
        }
    } catch (e) {
        // ignore
    }
    return false;
}

export async function safeFetch(url, opts = {}) {
    // If the caller provided custom headers, avoid forcing a JSON
    // `Content-Type` so callers can send FormData (multipart) safely.
    const defaultHeaders = buildHeaders(opts.headers ? false : true);
    const effectiveHeaders = { ...defaultHeaders, ...(opts.headers ?? {}) };

    // Only require a CSRF token for unsafe (state-changing) methods.
    const method = String((opts.method || 'GET')).toUpperCase();
    const unsafeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (unsafeMethods.includes(method)) {
        // Allow auth endpoints that are intentionally excluded from CSRF
        // protection on the server (e.g., login/register flows). The server
        // implements a double-submit cookie pattern and sets a csrfToken
        // cookie after successful login, so these initial auth endpoints
        // are safe to call without an X-CSRF-Token header.
        let isAuthEndpoint = false;
        try {
            let path = '';
            if (typeof url === 'string') {
                try {
                    path = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').pathname;
                } catch (e) {
                    path = url;
                }
            }
            isAuthEndpoint = typeof path === 'string' && path.startsWith('/api/auth/');
        } catch (e) {
            isAuthEndpoint = false;
        }

        if (!isAuthEndpoint && !_headersContainCsrf(effectiveHeaders)) {
            console.warn(`[safeFetch] Missing CSRF token for ${method} ${url}. ` +
                `Ensure the server sets a csrf cookie or a <meta name="csrf-token"> tag, or pass 'x-csrf-token' in headers.`);
            const err = new Error('Missing CSRF token');
            err.status = 403;
            throw err;
        }
    }

    const res = await fetch(url, {
        credentials: "include",
        ...opts,
        headers: effectiveHeaders,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Expired sessions should redirect the user to the auth page rather than
        // leaving them stuck in the chat UI with a vague error.
        if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/auth')) {
            try { localStorage.removeItem('user'); } catch (e) { /* ignore */ }
            window.location.href = '/auth';
        }
        throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
    }
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("application/json") ? res.json() : res.text();
}
