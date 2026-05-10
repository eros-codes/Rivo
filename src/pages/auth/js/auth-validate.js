export function isValidEmail(email) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidUsername(username) {
	return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}
