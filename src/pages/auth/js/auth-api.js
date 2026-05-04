import { safeFetch } from "../../main/js/api.js";

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
		return { ok: false, data: err.body || { error: err.message } };
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
		return { ok: false, data: err.body || { error: err.message } };
	}
}

export async function resetPassword(identifier, newPassword) {
	try {
		const data = await safeFetch("/api/auth/reset-password", {
			credentials: "include",
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier, newPassword }),
		});
		return { ok: true, data };
	} catch (err) {
		return { ok: false, data: err.body || { error: err.message } };
	}
}