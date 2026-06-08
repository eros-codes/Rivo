export function getCurrentUser() {
	try {
		return JSON.parse(localStorage.getItem("user") || "{}");
	} catch {
		return null;
	}
}