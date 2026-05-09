export function isValidEmail(email) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidUsername(username) {
	return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

export function isValidPassword(pw) {
	if (typeof pw !== 'string') return false;
	return pw.length >= 8;
}
