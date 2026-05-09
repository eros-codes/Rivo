export async function safeFetch(url, opts = {}) {
    const expectJson = opts.expectJson !== false;
    // clone options so we can pass through without our helper key
    const localOpts = { ...opts };
    delete localOpts.expectJson;

    const res = await fetch(url, localOpts);
    if (!res.ok) {
        let bodyText = "";
        try {
            bodyText = await res.clone().text();
        } catch (e) { /* ignore */ }
        let parsedBody = null;
        try {
            parsedBody = JSON.parse(bodyText);
        } catch (e) {
            parsedBody = null;
        }
        const errMessage = (parsedBody && parsedBody.error) ? parsedBody.error : `HTTP ${res.status} ${res.statusText}`;
        const err = new Error(errMessage);
        err.status = res.status;
        err.body = parsedBody ?? bodyText;
        throw err;
    }

    if (!expectJson) return res;

    try {
        return await res.json();
    } catch (e) {
        let body = "";
        try {
            body = await res.clone().text();
        } catch (err2) { /* ignore */ }
        const err = new Error("Invalid JSON response");
        err.body = body;
        throw err;
    }
}
