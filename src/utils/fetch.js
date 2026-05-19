export function getCsrfToken() {
    // Try common cookie names used by the server or libraries.
    const parts = document.cookie.split(";").map((c) => c.trim());
    const candidates = ["csrfToken", "_csrf", "csrf"];
    for (const name of candidates) {
        const kv = parts.find((p) => p.startsWith(name + "="));
        if (kv) return decodeURIComponent(kv.split("=").slice(1).join("=") || "");
    }
    return "";
}

export function buildHeaders(isJson = true) {
    const h = { "x-csrf-token": getCsrfToken() };
    if (isJson) h["Content-Type"] = "application/json";
    return h;
}

export async function safeFetch(url, opts = {}) {
    // If the caller provided custom headers, avoid forcing a JSON
    // `Content-Type` so callers can send FormData (multipart) safely.
    const defaultHeaders = buildHeaders(opts.headers ? false : true);
    const res = await fetch(url, {
        credentials: "include",
        ...opts,
        headers: { ...defaultHeaders, ...(opts.headers ?? {}) },
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw Object.assign(new Error(err.error ?? res.statusText), { status: res.status });
    }
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("application/json") ? res.json() : res.text();
}
