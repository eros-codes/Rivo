export async function loginUser(identifier, password) {
	const res = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ identifier, password }),
	});
	const data = await res.json();
	return { ok: res.ok, data };
}

export async function registerUser(name, email, username, password) {
	const res = await fetch("/api/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, email, username, password }),
	});
	const data = await res.json();
	return { ok: res.ok, data };
}

export async function resetPassword(identifier, newPassword) {
	const res = await fetch("/api/auth/reset-password", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ identifier, newPassword }),
	});
	const data = await res.json();
	return { ok: res.ok, data };
}