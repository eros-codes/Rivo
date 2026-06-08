// Centralized HTML escaping utility for client-side rendering
export function escapeHtml(str) {
  if (str === null || typeof str === 'undefined') return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default escapeHtml;
