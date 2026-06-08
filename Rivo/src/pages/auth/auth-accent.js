(function(){
  const accent = localStorage.getItem("rivo-accent");
  if (accent) {
    document.documentElement.style.setProperty("--accent", accent);
    const d = (hex, p) => {
      const n = parseInt(hex.replace("#", ""), 16);
      const c = v => Math.max(0, v - Math.round(2.55 * p)).toString(16).padStart(2, "0");
      return `#${c(n >> 16)}${c((n >> 8) & 255)}${c(n & 255)}`;
    };
    document.documentElement.style.setProperty("--accent-gradient-top", `radial-gradient(circle at top, ${d(accent, 8)}, ${accent})`);
    document.documentElement.style.setProperty("--accent-gradient-bottom", `radial-gradient(circle at right, ${d(accent, 8)}, ${accent})`);
  }
})();
