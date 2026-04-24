import { contacts, messages } from "./state.js";

// ─── Contacts ─────────────────────────────────────────────────────────────────

export async function getContacts() {
	// TODO: return await fetch("/api/contacts").then(r => r.json());
	return contacts; // DELETE WHEN BACKEND IS READY
}

export async function updateContact(contactId, changes) {
	// TODO: await fetch(`/api/contacts/${contactId}`, {
	// method: "PATCH",
	// headers: { "Content-Type": "application/json" },
	// body: JSON.stringify(changes),
	// });
	const contact = contacts.find((c) => c.id === contactId); // DELETE WHEN BACKEND IS READY
	if (contact) Object.assign(contact, changes); // DELETE WHEN BACKEND IS READY
	return contact; // DELETE WHEN BACKEND IS READY
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function getMessages(contactId) {
	// TODO: return await fetch(`/api/messages/${contactId}`).then(r => r.json());
	return messages[contactId] ?? []; // DELETE WHEN BACKEND IS READY
}

export async function sendMessage(contactId, msg) {
	// TODO: return await fetch("/api/messages", {
	// method: "POST",
	// headers: { "Content-Type": "application/json" },
	// body: JSON.stringify({ contactId, ...msg }),
	// }).then(r => r.json());
	if (!messages[contactId]) messages[contactId] = []; // DELETE WHEN BACKEND IS READY
	msg.index = messages[contactId].length; // DELETE WHEN BACKEND IS READY
	messages[contactId].push(msg); // DELETE WHEN BACKEND IS READY
	return msg; // DELETE WHEN BACKEND IS READY
}

export async function deleteMessage(contactId, index) {
	// TODO: await fetch(`/api/messages/${messageId}`, { method: "DELETE" });
	messages[contactId]?.splice(index, 1); // DELETE WHEN BACKEND IS READY
}

export async function editMessage(contactId, index, text) {
	// TODO: await fetch(`/api/messages/${messageId}`, {
	// method: "PATCH",
	// headers: { "Content-Type": "application/json" },
	// body: JSON.stringify({ text }),
	// });
	const msg = messages[contactId]?.[index]; // DELETE WHEN BACKEND IS READY
	if (!msg) return; // DELETE WHEN BACKEND IS READY
	msg.text = text; // DELETE WHEN BACKEND IS READY
	msg.isEdited = true; // DELETE WHEN BACKEND IS READY
}

export async function pinMessage(contactId, index) {
	// TODO: await fetch(`/api/messages/${messageId}/pin`, { method: "POST" });
	const msg = messages[contactId]?.[index]; // DELETE WHEN BACKEND IS READY
	if (!msg) return; // DELETE WHEN BACKEND IS READY
	msg.isPinned = !msg.isPinned; // DELETE WHEN BACKEND IS READY
	return msg.isPinned; // DELETE WHEN BACKEND IS READY
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function login(identifier, password) {
	// TODO: return await fetch("/api/auth/login", {
	// method: "POST",
	// headers: { "Content-Type": "application/json" },
	// body: JSON.stringify({ identifier, password }),
	// }).then(r => r.json());
	return { success: true, token: "mock-token" }; // DELETE WHEN BACKEND IS READY
}

export async function register(name, email, username, password) {
	// TODO: return await fetch("/api/auth/register", {
	// method: "POST",
	// headers: { "Content-Type": "application/json" },
	// body: JSON.stringify({ name, email, username, password }),
	// }).then(r => r.json());
	return { success: true }; // DELETE WHEN BACKEND IS READY
}

export async function logout() {
	// TODO: await fetch("/api/auth/logout", { method: "POST" });
	sessionStorage.clear(); // DELETE WHEN BACKEND IS READY
}
