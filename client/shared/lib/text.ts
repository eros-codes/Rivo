// Text helpers: links in messages, writing direction, initials.

export type TextPart = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

// a word that is a web address: "https://…", "http://…" or "www.…"
const LINK_RE = /^(?:https?:\/\/[^\s]+|www\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#][^\s]*)?)$/i;
// punctuation that ends a sentence rather than the address
const TRAILING_RE = /[.,!?;:'"»”’)\]}>]+$/;
// and that opens one: "(https://…)"
const LEADING_RE = /^[(\[{<«“‘"']+/;

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** Splits text into plain parts and links (only http(s) addresses become links). */
export function linkify(text: string): TextPart[] {
	const parts: TextPart[] = [];
	const push = (kind: "text", t: string) => {
		if (!t) return;
		const last = parts[parts.length - 1];
		if (last && last.kind === "text") last.text += t;
		else parts.push({ kind, text: t });
	};
	for (const word of text.split(/(\s+)/)) {
		if (!word) continue;
		const lead = LEADING_RE.exec(word)?.[0] ?? "";
		let core = word.slice(lead.length);
		let tail = "";
		const trail = TRAILING_RE.exec(core);
		if (trail) {
			core = core.slice(0, core.length - trail[0].length);
			tail = trail[0];
		}
		// a closing bracket the address opened itself is part of it: ".../Rivo_(app)"
		while (tail.startsWith(")") && count(core, "(") > count(core, ")")) {
			core += ")";
			tail = tail.slice(1);
		}
		if (core && LINK_RE.test(core)) {
			const href = /^https?:\/\//i.test(core) ? core : `https://${core}`;
			let safe: string | null = null;
			try {
				const u = new URL(href);
				if (u.protocol === "http:" || u.protocol === "https:") safe = u.href;
			} catch {
				safe = null;
			}
			if (safe) {
				push("text", lead);
				parts.push({ kind: "link", text: core, href: safe });
				push("text", tail);
				continue;
			}
		}
		push("text", word);
	}
	return parts;
}

const RTL_CHAR = /[֐-׿؀-ۿ܀-ݏݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/** Direction of the first letter that has one (like dir="auto"). */
export function textDirection(text: string): "rtl" | "ltr" {
	for (const ch of text) {
		if (RTL_CHAR.test(ch)) return "rtl";
		if (LTR_CHAR.test(ch)) return "ltr";
	}
	return "ltr";
}

export function isArabicScript(ch: string): boolean {
	return /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(ch);
}

type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
let segmenter: Segmenter | null | undefined;

/** The first user-perceived character (keeps emoji and accents whole). */
export function firstGrapheme(text: string): string {
	const s = text.trim();
	if (!s) return "";
	if (segmenter === undefined) {
		const Ctor = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => Segmenter }).Segmenter;
		segmenter = Ctor ? new Ctor(undefined, { granularity: "grapheme" }) : null;
	}
	if (segmenter) {
		for (const { segment } of segmenter.segment(s)) return segment;
	}
	return Array.from(s)[0] ?? "";
}

/** Case-insensitive "contains" that ignores accents and Arabic/Persian letter variants. */
export function normalizeForSearch(text: string): string {
	return text
		.toLocaleLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ًͯ-ٰٟ]/g, "")
		.replace(/[يى]/g, "ی")
		.replace(/ك/g, "ک")
		.replace(/[أإآ]/g, "ا")
		.replace(/‌/g, " ");
}

/** A one-line version of a message for previews. */
export function oneLine(text: string, max = 200): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
