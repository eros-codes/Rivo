export function getCurrentUser() {
	try {
		const parsed = JSON.parse(localStorage.getItem("user") || "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}