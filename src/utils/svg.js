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
    // DOMParser does not execute scripts itself, but any node inserted into the
    // page could still become active; strip the risky bits up front.
    el.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
    el.querySelectorAll('*').forEach((n) => {
      for (const attr of Array.from(n.attributes)) {
        if (/^on/i.test(attr.name)) n.removeAttribute(attr.name);
      }
    });
    return el;
  } catch (e) {
    console.error('parseSvg failed', e);
    return null;
  }
}
