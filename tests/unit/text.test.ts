// Text in messages: which parts become links (and that nothing but web
// addresses ever does), writing direction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkify, textDirection } from "../../client/shared/lib/text";
import { normalizeHex } from "../../client/shared/lib/theme";

const links = (text: string) => linkify(text).filter((p) => p.kind === "link").map((p) => (p.kind === "link" ? p.href : ""));

test("web addresses become links, sentence punctuation stays outside", () => {
	assert.deepEqual(links("see https://rivo.ir/chat."), ["https://rivo.ir/chat"]);
	assert.deepEqual(links("www.example.com, then"), ["https://www.example.com/"]);
	assert.deepEqual(links("(https://en.wikipedia.org/wiki/Rivo_(app))"), ["https://en.wikipedia.org/wiki/Rivo_(app)"]);
});

test("nothing but http(s) ever becomes a link", () => {
	assert.deepEqual(links("javascript:alert(1)"), []);
	assert.deepEqual(links("data:text/html,<script>alert(1)</script>"), []);
	assert.deepEqual(links("file:///etc/passwd vbscript:x"), []);
});

test("the text is kept exactly, links included", () => {
	const text = "hi  https://a.io/x?y=1 bye";
	assert.equal(linkify(text).map((p) => p.text).join(""), text);
});

test("direction follows the first letter that has one", () => {
	assert.equal(textDirection("سلام hello"), "rtl");
	assert.equal(textDirection("hello سلام"), "ltr");
	assert.equal(textDirection("123 שלום"), "rtl");
	assert.equal(textDirection("🙂"), "ltr");
});

test("an accent color must be a plain hex color (it ends up in CSS)", () => {
	assert.equal(normalizeHex("#FA5F1A"), "#fa5f1a");
	assert.equal(normalizeHex("#abc"), "#aabbcc");
	assert.equal(normalizeHex("red"), null);
	assert.equal(normalizeHex("#fff;background:url(https://x)"), null);
	assert.equal(normalizeHex(42), null);
});

test("an address in brackets or quotes is still a link", () => {
	assert.deepEqual(links("(https://rivo.ir)"), ["https://rivo.ir/"]);
	assert.deepEqual(links('"https://rivo.ir/a"'), ["https://rivo.ir/a"]);
	assert.deepEqual(links("«www.rivo.ir»"), ["https://www.rivo.ir/"]);
});
