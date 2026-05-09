let _user = null;

export function setCurrentUser(u) {
	_user = u || null;
}

export function getCurrentUserId() {
	return _user && _user.id ? _user.id : null;
}

export function getCurrentUser() {
	return _user;
}
