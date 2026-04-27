// ─── Auth header helper ───────────────────────────────────────────────────────
const authHeader = () => ({
	"Content-Type": "application/json",
	Authorization: `Bearer ${sessionStorage.getItem("token")}`,
});

// ─── Contacts ─────────────────────────────────────────────────────────────────
export async function getContacts() {
	return await fetch("/api/contacts", {
		headers: authHeader(),
	}).then((r) => r.json());
}

export async function updateContact(contactId, changes) {
	return await fetch(`/api/contacts/${contactId}`, {
		method: "PATCH",
		headers: authHeader(),
		body: JSON.stringify(changes),
	}).then((r) => r.json());
}

// ─── Messages ─────────────────────────────────────────────────────────────────
export async function getMessages(conversationId) {
	return await fetch(`/api/messages/${conversationId}`, {
		headers: authHeader(),
	}).then((r) => r.json());
}

export async function sendMessage(conversationId, msg) {
	return await fetch("/api/messages", {
		method: "POST",
		headers: authHeader(),
		body: JSON.stringify({ conversationId, ...msg }),
	}).then((r) => r.json());
}

export async function deleteMessage(messageId) {
	await fetch(`/api/messages/${messageId}`, {
		method: "DELETE",
		headers: authHeader(),
	});
}

export async function editMessage(messageId, text) {
	await fetch(`/api/messages/${messageId}`, {
		method: "PATCH",
		headers: authHeader(),
		body: JSON.stringify({ text }),
	});
}

export async function pinMessage(messageId) {
	return await fetch(`/api/messages/${messageId}/pin`, {
		method: "POST",
		headers: authHeader(),
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
		headers: authHeader(),
	});
	sessionStorage.clear();
}

// ─── Users ────────────────────────────────────────────────────────────────────
export async function getMe() {
	return await fetch("/api/users/me", {
		headers: authHeader(),
	}).then((r) => r.json());
}

export async function updateMe(changes) {
	return await fetch("/api/users/me", {
		method: "PATCH",
		headers: authHeader(),
		body: JSON.stringify(changes),
	}).then((r) => r.json());
}

export async function deleteContact(contactId) {
	await fetch(`/api/contacts/${contactId}`, {
		method: "DELETE",
		headers: authHeader(),
	});
}

export async function deleteChat(conversationId) {
	await fetch(`/api/conversations/${conversationId}/messages`, {
		method: "DELETE",
		headers: authHeader(),
	});
}

export async function uploadAvatar(formData) {
	return await fetch("/api/users/me/avatar", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${sessionStorage.getItem("token")}`,
		},
		body: formData,
	}).then((r) => r.json());
}

export async function deleteAvatar() {
	return await fetch("/api/users/me", {
		method: "PATCH",
		headers: authHeader(),
		body: JSON.stringify({ profilePics: [] }),
	}).then((r) => r.json());
}

export async function updatePrivacy(changes) {
	return await fetch("/api/users/me", {
		method: "PATCH",
		headers: authHeader(),
		body: JSON.stringify(changes),
	}).then((r) => r.json());
}

export async function deleteAccount(password) {
	return await fetch("/api/users/me", {
		method: "DELETE",
		headers: authHeader(),
		body: JSON.stringify({ password }),
	}).then((r) => r.json());
}