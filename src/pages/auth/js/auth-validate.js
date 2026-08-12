export function isValidEmail(email) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidUsername(username) {
	// Server accepts up to 30 characters; keep client in sync to avoid
	// surprise validation failures when editing an existing longer username.
	return /^[a-zA-Z0-9_]{3,30}$/.test(username);
}

export function isValidPassword(password) {
	// Keep client-side validation aligned with the server.
	return typeof password === "string" && password.length >= 8;
}
