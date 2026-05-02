// ─── Accent presets ───────────────────────────────────────────────────────────
export const ACCENT_PRESETS = [
	{ name: "Orange", hex: "#fa5f1a" },
	{ name: "Blue", hex: "#2D6BE4" },
	{ name: "Crimson", hex: "#C0392B" },
	{ name: "Forest", hex: "#1A7A4A" },
	{ name: "Purple", hex: "#7C3AED" },
	{ name: "Navy", hex: "#1B3A6B" },
	{ name: "Pink", hex: "#E91E8C" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hexToRgb(hex) {
	const n = parseInt(hex.replace("#", ""), 16);
	return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function darken(hex, percent) {
	const { r, g, b } = hexToRgb(hex);
	const d = Math.round(2.55 * percent);
	const clamp = (v) => Math.max(0, v - d);
	return `#${[clamp(r), clamp(g), clamp(b)]
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")}`;
}

function hexWithOpacity(hex, opacity) {
	const { r, g, b } = hexToRgb(hex);
	return `rgba(${r},${g},${b},${opacity})`;
}

// ─── Apply accent ─────────────────────────────────────────────────────────────
export function applyAccentColor(hex) {
	const root = document.documentElement;
	const isDark = document.body.classList.contains("dark-mode");
	const base = isDark ? darken(hex, 8) : hex;

	// root and body (for dark mode) to cover all elements, including those outside of root like modals
	const targets = [root];
	if (isDark) targets.push(document.body);

	targets.forEach((el) => {
		el.style.setProperty("--accent", base);
		el.style.setProperty("--messages-outgoing", base);
		el.style.setProperty("--active-chat-bg-color", base);
		el.style.setProperty("--active-chat-bg-color-hover", darken(base, 5));
		el.style.setProperty("--bold-active-chat-bg-color", darken(base, 10));
		el.style.setProperty(
			"--bold-active-chat-bg-color-hover",
			darken(base, 15),
		);
		el.style.setProperty(
			"--accent-gradient-top",
			`radial-gradient(circle at top, ${darken(base, 8)}, ${base})`,
		);
		el.style.setProperty(
			"--accent-gradient-bottom",
			`radial-gradient(circle at right, ${darken(base, 8)}, ${base})`,
		);
		el.style.setProperty(
			"--accent-glass",
			`linear-gradient(to right, ${hexWithOpacity(base, 0.21)}, ${hexWithOpacity(base, 0.21)})`,
		);
	});
}

// ─── Apply wallpaper ──────────────────────────────────────────────────────────
export function applyWallpaper(value) {
	const chatEl = document.querySelector(".chat-section");
	if (!chatEl) return;
	if (!value) {
		chatEl.style.backgroundImage = "";
		chatEl.style.backgroundSize = "";
		return;
	}
	chatEl.style.backgroundImage = `url(${value})`;
	chatEl.style.backgroundSize = "cover";
	chatEl.style.backgroundPosition = "center";
}

// ─── Load from localStorage ───────────────────────────────────────────────────
export function loadThemeFromStorage() {
	const accent = localStorage.getItem("rivo-accent");
	if (accent) applyAccentColor(accent);

	const wallpaper = localStorage.getItem("rivo-wallpaper");
	if (wallpaper) applyWallpaper(wallpaper);
}