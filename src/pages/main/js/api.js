// Use credentials (cookies) for auth; no Authorization header from localStorage.
function getCsrfToken() {
	const m = document.cookie.match(/(?:^|; )csrfToken=([^;]+)/);
	return m ? decodeURIComponent(m[1]) : null;
}

function buildHeaders(isJson = true) {
	const h = {};
	if (isJson) h["Content-Type"] = "application/json";
	const t = getCsrfToken();
	if (t) h["X-CSRF-Token"] = t;
	return h;
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
export async function getContacts() {
	return await fetch("/api/contacts", {
		credentials: "include",
		headers: buildHeaders(),
	}).then((r) => r.json());
}

export async function updateContact(contactId, changes) {
	return await fetch(`/api/contacts/${contactId}`, {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify(changes),
	}).then((r) => r.json());
}

// ─── Messages ─────────────────────────────────────────────────────────────────
export async function getMessages(conversationId) {
	return await fetch(`/api/messages/${conversationId}`, {
		credentials: "include",
		headers: buildHeaders(),
	}).then((r) => r.json());
}

export async function sendMessage(conversationId, msg) {
	return await fetch("/api/messages", {
		method: "POST",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify({ conversationId, ...msg }),
	}).then((r) => r.json());
}

export async function deleteMessage(messageId) {
	await fetch(`/api/messages/${messageId}`, {
		method: "DELETE",
		credentials: "include",
		headers: buildHeaders(),
	});
}

export async function editMessage(messageId, text) {
	await fetch(`/api/messages/${messageId}`, {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify({ text }),
	});
}

export async function pinMessage(messageId) {
	return await fetch(`/api/messages/${messageId}/pin`, {
		method: "POST",
		credentials: "include",
		headers: buildHeaders(),
	}).then((r) => r.json());
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export async function login(identifier, password) {
	return await fetch("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ identifier, password }),
	}).then((r) => r.json());
}

export async function register(name, email, username, password) {
	return await fetch("/api/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, email, username, password }),
	}).then((r) => r.json());
}

export async function logout() {
	await fetch("/api/auth/logout", {
		method: "POST",
		credentials: "include",
		headers: buildHeaders(),
	});
	// remove only auth data so site-wide preferences (theme, rememberedUser) persist
	localStorage.removeItem("user");
}

// ─── Users ────────────────────────────────────────────────────────────────────
export async function getMe() {
	return await fetch("/api/users/me", {
		credentials: "include",
		headers: buildHeaders(),
	}).then((r) => r.json());
}

export async function updateMe(changes) {
	return await fetch("/api/users/me", {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify(changes),
	}).then((r) => r.json());
}

export async function deleteContact(contactId) {
	await fetch(`/api/contacts/${contactId}`, {
		method: "DELETE",
		credentials: "include",
		headers: buildHeaders(),
	});
}

export async function deleteChat(conversationId) {
	await fetch(`/api/conversations/${conversationId}/messages`, {
		method: "DELETE",
		credentials: "include",
		headers: buildHeaders(),
	});
}

export async function uploadAvatar(formData) {
	return await fetch("/api/users/me/avatar", {
		method: "POST",
		credentials: "include",
		// multipart formdata; do not set Content-Type so the browser sets boundary
		headers: buildHeaders(false),
		body: formData,
	}).then((r) => r.json());
}

export async function deleteAvatar() {
	return await fetch("/api/users/me", {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify({ profilePics: [] }),
	}).then((r) => r.json());
}

export async function updatePrivacy(changes) {
	return await fetch("/api/users/me", {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify(changes),
	}).then((r) => r.json());
}

export async function deleteAccount(password) {
	return await fetch("/api/users/me", {
		method: "DELETE",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify({ password }),
	}).then((r) => r.json());
}

export async function changePassword(currentPassword, newPassword) {
	return await fetch(`/api/users/me/password`, {
		method: "PATCH",
		credentials: "include",
		headers: buildHeaders(),
		body: JSON.stringify({ currentPassword, newPassword }),
	}).then((r) => r.json());
}