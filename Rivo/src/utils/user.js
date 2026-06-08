export function getCurrentUserId() {
  try {
    const u = JSON.parse(localStorage.getItem("user") || "{}");
    return u?.id ?? null;
  } catch {
    return null;
  }
}
