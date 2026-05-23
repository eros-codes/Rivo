export function isValidEmail(email) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidUsername(username) {
	// Server accepts up to 30 characters; keep client in sync to avoid
	// surprise validation failures when editing an existing longer username.
	return /^[a-zA-Z0-9_]{3,30}$/.test(username);
}
