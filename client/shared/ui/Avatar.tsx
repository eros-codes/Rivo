// A person's picture, or their initial on a colored circle.
import { memo, useEffect, useState } from "react";
import { firstGrapheme, isArabicScript } from "../lib/text";

const ACCENTS = 8;

/** Same color for the same name, everywhere (and as before). */
function accentOf(name: string): number {
	let seed = 0;
	for (let i = 0; i < name.length; i++) seed += name.charCodeAt(i);
	return seed % ACCENTS;
}

/** Only pictures from this site, https, or inline images are shown. */
export function safePicture(url: string | null | undefined): string | null {
	if (!url) return null;
	const u = url.trim();
	// the old placeholder files never existed
	if (/\/profile(?:-light|-dark)?\.(?:jpe?g|png|webp)(?:[#?].*)?$/i.test(u)) return null;
	if (/^data:image\/(?:png|jpe?g|gif|webp);/i.test(u)) return u;
	if (/^https:\/\//i.test(u) || (u.startsWith("/") && !u.startsWith("//"))) return u;
	return null;
}

// ─── Centring non-Latin initials ──────────────────────────────────────────
// The circle centres the font's line box, which puts Latin capitals in the
// middle. Persian/Arabic letters sit differently around the baseline (ر، م،
// ع have tails, آ is tall), so each is moved by its measured ink bounds.
const INITIAL_WEIGHT = 600;
const shifts = new Map<string, number | null>();
let canvas: HTMLCanvasElement | null = null;

function fontSpec(px: number): string {
	const family = (typeof document !== "undefined" && document.body && getComputedStyle(document.body).fontFamily) || "Poppins, Vazirmatn, sans-serif";
	return `${INITIAL_WEIGHT} ${px}px ${family}`;
}

function measureShift(ch: string): number | null {
	if (shifts.has(ch)) return shifts.get(ch) ?? null;
	let shift: number | null = null;
	try {
		canvas ??= document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		if (ctx) {
			const size = 100;
			ctx.font = fontSpec(size);
			const glyph = ctx.measureText(ch);
			const ref = ctx.measureText("H");
			const v = [glyph.actualBoundingBoxAscent, glyph.actualBoundingBoxDescent, ref.fontBoundingBoxAscent, ref.fontBoundingBoxDescent];
			if (v.every(Number.isFinite)) {
				// with line-height 1 the baseline sits (ascent - descent) / 2 below the middle
				const baselineBelowMiddle = (ref.fontBoundingBoxAscent - ref.fontBoundingBoxDescent) / 2;
				const inkMiddleBelowBaseline = (glyph.actualBoundingBoxDescent - glyph.actualBoundingBoxAscent) / 2;
				const s = Math.round((-(baselineBelowMiddle + inkMiddleBelowBaseline) / size) * 1000) / 1000;
				shift = Math.abs(s) > 0.5 ? null : s;
			}
		}
	} catch {
		shift = null;
	}
	shifts.set(ch, shift);
	return shift;
}

function useInitialShift(ch: string): number | null {
	const needs = !!ch && !/^[A-Z0-9?]$/.test(ch);
	const [shift, setShift] = useState<number | null>(() => {
		if (!needs || typeof document === "undefined") return null;
		const fonts = document.fonts;
		try {
			if (fonts && !fonts.check(fontSpec(100), ch)) return null;
		} catch {
			/* measure anyway */
		}
		return measureShift(ch);
	});
	useEffect(() => {
		if (!needs) return undefined;
		const fonts = document.fonts;
		let alive = true;
		// the web font may still be loading: measure again once it is there
		fonts
			?.load(fontSpec(100), ch)
			.catch(() => undefined)
			.then(() => {
				if (!alive) return;
				shifts.delete(ch);
				setShift(measureShift(ch));
			});
		return () => {
			alive = false;
		};
	}, [ch, needs]);
	return needs ? shift : null;
}

function Initial({ ch }: { ch: string }) {
	const shift = useInitialShift(ch);
	return (
		<span
			className={`initial-avatar-char${isArabicScript(ch) ? " initial-avatar-char--arabic" : ""}`}
			style={shift ? { transform: `translateY(${shift}em)` } : undefined}
		>
			{ch}
		</span>
	);
}

export interface AvatarProps {
	/** the name as shown (nickname or name): its initial and color */
	name: string;
	picture?: string | null;
	className: string;
	online?: boolean;
	/** extra class when online ("online-contact" for most avatars) */
	onlineClass?: string;
	deleted?: boolean;
}

export const Avatar = memo(function Avatar({ name, picture, className, online = false, onlineClass = "online-contact", deleted = false }: AvatarProps) {
	const src = deleted ? null : safePicture(picture);
	const [broken, setBroken] = useState<string | null>(null);
	const onlineCls = online ? ` ${onlineClass}` : "";
	if (src && broken !== src) {
		return <img className={className + onlineCls} src={src} alt="" draggable={false} decoding="async" onError={() => setBroken(src)} />;
	}
	const display = name.trim();
	const ch = deleted ? "" : (firstGrapheme(display) || "?").toUpperCase();
	return (
		<div className={`${className} initial-avatar initial-accent-${accentOf(display)}${deleted ? " deleted-account-avatar" : ""}${onlineCls}`} aria-hidden="true">
			{ch ? <Initial ch={ch} /> : null}
		</div>
	);
});
