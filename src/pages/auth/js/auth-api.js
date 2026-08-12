import { safeFetch } from "../../../utils/fetch.js";

export async function loginUser(identifier, password) {
	try {
		const data = await safeFetch("/api/auth/login", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier, password }),
		});
		return { ok: true, data };
	} catch (err) {
		return { ok: false, data: { error: err?.message || 'Unknown error' } };
	}
}

export async function registerUser(name, email, username, password) {
	try {
		const data = await safeFetch("/api/auth/register", {
			credentials: "include",
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, email, username, password }),
		});
		return { ok: true, data };
	} catch (err) {
		return { ok: false, data: { error: err?.message || 'Unknown error' } };
	}
}

export async function requestPasswordReset(identifier) {
	try {
		const data = await safeFetch("/api/auth/request-password-reset", {
			credentials: "include",
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier }),
		});
		return { ok: true, data };
	} catch (err) {
		return { ok: false, data: { error: err?.message || 'Unknown error' } };
	}
}

export async function resetPassword(token, newPassword) {
	try {
		const data = await safeFetch("/api/auth/reset-password-with-token", {
			credentials: "include",
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token, newPassword }),
		});
		return { ok: true, data };
	} catch (err) {
		return { ok: false, data: { error: err?.message || 'Unknown error' } };
	}
}