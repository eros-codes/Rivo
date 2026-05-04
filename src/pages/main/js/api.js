// Use credentials (cookies) for auth; no Authorization header from localStorage.
export function getCsrfToken() {
	const m = document.cookie.match(/(?:^|; )csrfToken=([^;]+)/);
	return m ? decodeURIComponent(m[1]) : null;
}

export function buildHeaders(isJson = true) {
	const h = {};
	if (isJson) h["Content-Type"] = "application/json";
	const t = getCsrfToken();
	if (t) h["X-CSRF-Token"] = t;
	return h;
}

async function safeFetch(url, opts = {}) {
	const expectJson = opts.expectJson !== false;
	// clone options so we can pass through without our helper key
	const localOpts = { ...opts };
	delete localOpts.expectJson;

	const res = await fetch(url, localOpts);
	if (!res.ok) {
		let body = "";
		try {
			body = await res.clone().text();
		} catch (e) { /* ignore */ }
		const err = new Error(`HTTP ${res.status} ${res.statusText}`);
		err.status = res.status;
		err.body = body;
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

// ─── Contacts ─────────────────────────────────────────────────────────────────
export async function getContacts() {
	return await safeFetch("/api/contacts", {
		credentials: "include",
		headers: buildHeaders(),
	});
}

export async function updateContact(contactId, changes) {
	return await safeFetch(`/api/contacts/${contactId}`, {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify(changes),
	});
}

// ─── Messages ─────────────────────────────────────────────────────────────────
export async function getMessages(conversationId) {
	return await safeFetch(`/api/messages/${conversationId}`, {
		credentials: "include",
		headers: buildHeaders(),
	});
}

export async function sendMessage(conversationId, msg) {
	return await safeFetch("/api/messages", {
		method: "POST",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify({ conversationId, ...msg }),
	});
}

export async function deleteMessage(messageId) {
	await safeFetch(`/api/messages/${messageId}`, {
		method: "DELETE",
		credentials: "include",
		headers: buildHeaders(),
		expectJson: false,
	});
}

export async function editMessage(messageId, text) {
	await safeFetch(`/api/messages/${messageId}`, {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify({ text }),
		expectJson: false,
	});
}

export async function pinMessage(messageId) {
	return await safeFetch(`/api/messages/${messageId}/pin`, {
		method: "POST",
		credentials: "include",
		headers: buildHeaders(),
	});
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export async function login(identifier, password) {
	return await safeFetch("/api/auth/login", {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ identifier, password }),
	});
}

export async function register(name, email, username, password) {
	return await safeFetch("/api/auth/register", {
		credentials: "include",
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, email, username, password }),
	});
}

export async function logout() {
	await safeFetch("/api/auth/logout", {
		method: "POST",
		credentials: "include",
		headers: buildHeaders(),
		expectJson: false,
	});
	// remove only auth data so site-wide preferences (theme, rememberedUser) persist
	localStorage.removeItem("user");
}

// ─── Users ────────────────────────────────────────────────────────────────────
export async function getMe() {
	return await safeFetch("/api/users/me", {
		credentials: "include",
		headers: buildHeaders(),
	});
}

export async function updateMe(changes) {
	return await safeFetch("/api/users/me", {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify(changes),
	});
}

export async function deleteContact(contactId) {
	await safeFetch(`/api/contacts/${contactId}`, {
		method: "DELETE",
		credentials: "include",
		headers: buildHeaders(),
		expectJson: false,
	});
}

export async function deleteChat(conversationId) {
	await safeFetch(`/api/conversations/${conversationId}/messages`, {
		method: "DELETE",
		credentials: "include",
		headers: buildHeaders(),
		expectJson: false,
	});
}

export async function uploadAvatar(formData) {
	return await safeFetch("/api/users/me/avatar", {
		method: "POST",
		credentials: "include",
		// multipart formdata; do not set Content-Type so the browser sets boundary
		headers: buildHeaders(false),
		body: formData,
	});
}

export async function deleteAvatar() {
	return await safeFetch("/api/users/me", {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify({ profilePics: [] }),
	});
}

export async function updatePrivacy(changes) {
	return await safeFetch("/api/users/me", {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify(changes),
	});
}

export async function deleteAccount(password) {
	return await safeFetch("/api/users/me", {
		method: "DELETE",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify({ password }),
	});
}

export async function changePassword(currentPassword, newPassword) {
	return await safeFetch(`/api/users/me/password`, {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify({ currentPassword, newPassword }),
	});
}

export { safeFetch };