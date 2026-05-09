export function safeSrc(url) {
  if (!url) return "/assets/images/profile.jpeg";
  const u = String(url).trim();
  // allow absolute URLs, site-relative paths and data URIs
  if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("/")) return u;
  if (u.startsWith("data:image/")) return u;
  return "/assets/images/profile.jpeg";
}
