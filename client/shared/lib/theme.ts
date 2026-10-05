// Light/dark theme, accent color and chat wallpaper. Applied to <html>
// before the first paint by the boot script, and again whenever the user
// changes them in Settings.
import { keys, read, write } from "./storage";

export type Theme = "light" | "dark";

export const ACCENT_PRESETS = [
	{ name: "Orange", hex: "#fa5f1a" },
	{ name: "Blue", hex: "#2d6be4" },
	{ name: "Crimson", hex: "#c0392b" },
	{ name: "Forest", hex: "#1a7a4a" },
	{ name: "Purple", hex: "#7c3aed" },
	{ name: "Navy", hex: "#1b3a6b" },
	{ name: "Pink", hex: "#e91e8c" },
] as const;

export const DEFAULT_ACCENT = "#fa5f1a";
const BACKGROUND: Record<Theme, string> = { light: "#f7f0f0", dark: "#1a1a1a" };

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#abc" / "#AABBCC" → "#aabbcc", or null when not a color. */
export function normalizeHex(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim();
	if (!HEX_RE.test(v)) return null;
	const h = v.slice(1).toLowerCase();
	return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}

function rgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function darken(hex: string, percent: number): string {
	const d = Math.round(2.55 * percent);
	return `#${rgb(hex)
		.map((v) => Math.max(0, v - d).toString(16).padStart(2, "0"))
		.join("")}`;
}

function alpha(hex: string, a: number): string {
	const [r, g, b] = rgb(hex);
	return `rgba(${r},${g},${b},${a})`;
}

export function storedTheme(): Theme {
	return read(keys.theme) === "dark" ? "dark" : "light";
}

export function storedAccent(): string | null {
	return normalizeHex(read(keys.accent));
}

export function currentTheme(): Theme {
	return document.documentElement.classList.contains("dark-mode") ? "dark" : "light";
}

const ACCENT_VARS = [
	"--accent",
	"--messages-outgoing",
	"--active-chat-bg-color",
	"--active-chat-bg-color-hover",
	"--bold-active-chat-bg-color",
	"--bold-active-chat-bg-color-hover",
	"--accent-gradient-top",
	"--accent-gradient-bottom",
	"--accent-glass",
];

/** The accent's derived colors on <html> (null: the stylesheet defaults). */
export function applyAccent(hex: string | null): void {
	const style = document.documentElement.style;
	const color = normalizeHex(hex);
	if (!color) {
		for (const v of ACCENT_VARS) style.removeProperty(v);
		return;
	}
	// a slightly deeper shade reads better on the dark background
	const base = currentTheme() === "dark" ? darken(color, 8) : color;
	style.setProperty("--accent", base);
	style.setProperty("--messages-outgoing", base);
	style.setProperty("--active-chat-bg-color", base);
	style.setProperty("--active-chat-bg-color-hover", darken(base, 5));
	style.setProperty("--bold-active-chat-bg-color", darken(base, 10));
	style.setProperty("--bold-active-chat-bg-color-hover", darken(base, 15));
	style.setProperty("--accent-gradient-top", `radial-gradient(circle at top, ${darken(base, 8)}, ${base})`);
	style.setProperty("--accent-gradient-bottom", `radial-gradient(circle at right, ${darken(base, 8)}, ${base})`);
	style.setProperty("--accent-glass", `linear-gradient(to right, ${alpha(base, 0.21)}, ${alpha(base, 0.21)})`);
}

export function applyTheme(theme: Theme): void {
	const root = document.documentElement;
	root.classList.toggle("dark-mode", theme === "dark");
	root.style.colorScheme = theme;
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute("content", BACKGROUND[theme]);
	// the accent's shade depends on the theme
	applyAccent(storedAccent());
}

export function saveTheme(theme: Theme): void {
	write(keys.theme, theme);
	applyTheme(theme);
}

export function saveAccent(hex: string): void {
	const color = normalizeHex(hex);
	if (!color) return;
	// the default needs no stored value
	write(keys.accent, color === DEFAULT_ACCENT ? null : color);
	applyAccent(color === DEFAULT_ACCENT ? null : color);
}

// ─── Wallpaper ────────────────────────────────────────────────────────────
const WALLPAPER_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export function storedWallpaper(): string | null {
	const v = read(keys.wallpaper);
	return v && WALLPAPER_RE.test(v) ? v : null;
}

/** The chat background as a CSS variable on <html> (read by .chat-section). */
export function applyWallpaper(dataUrl: string | null): void {
	const style = document.documentElement.style;
	if (dataUrl && WALLPAPER_RE.test(dataUrl)) style.setProperty("--chat-wallpaper", `url("${dataUrl}")`);
	else style.removeProperty("--chat-wallpaper");
}

/** Stores and shows a wallpaper; false when the device has no room for it. */
export function saveWallpaper(dataUrl: string | null): boolean {
	if (dataUrl !== null && !WALLPAPER_RE.test(dataUrl)) return false;
	const ok = write(keys.wallpaper, dataUrl);
	if (ok) applyWallpaper(dataUrl);
	return ok;
}

/** Everything stored, applied at once (boot). */
export function applyStoredAppearance(): void {
	applyTheme(storedTheme());
	applyWallpaper(storedWallpaper());
}
