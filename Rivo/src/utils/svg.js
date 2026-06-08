export function parseSvg(svgString) {
  if (!svgString) return null;
  try {
    const s = String(svgString).trim();
    if (!s.startsWith('<')) return null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(s, 'image/svg+xml');
    // documentElement should be the <svg> node
    const el = doc.documentElement;
    if (!el || el.nodeName.toLowerCase() !== 'svg') return null;
    return el;
  } catch (e) {
    console.error('parseSvg failed', e);
    return null;
  }
}
