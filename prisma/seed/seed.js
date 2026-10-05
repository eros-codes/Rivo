// Fills an empty database with the test data in data.js, the way the server
// itself would have stored it: encrypted messages (with this .env's KEK),
// one conversation per pair shared by both contact rows, unread counters
// that match the messages, Saved Messages for everyone.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import prisma from "../../server/prisma.js";
import { encryptMessage, generateDEK, initKeyStore, wrapDEK } from "../../server/utils/encryption.js";
import { MAIN, PASSWORD, chats, friends, mainList, people, saved, side } from "./data.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const AVATAR_SOURCE = path.join(ROOT, "prisma", "seed", "avatars");
// where the server keeps uploaded pictures (server/routes/users.js)
const AVATAR_DIR = path.join(ROOT, "public", "assets", "images", "user-profiles");
const AVATAR_URL_PREFIX = "/assets/images/user-profiles/";
const PHOTO_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

const KEY_ID = process.env.ACTIVE_KEY_ID || "v1";
const MAX_LEN = parseInt(process.env.MAX_MESSAGE_LENGTH || "1500", 10);
const MINUTE = 60_000;

// ─── Small helpers ─────────────────────────────────────────────────────────

/** The same "random" choices on every run. */
function randomFrom(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** "12m", "3h", "2d" → milliseconds. */
function span(s) {
	const m = /^(\d+)(m|h|d)$/.exec(String(s));
	if (!m) throw new Error(`bad time span "${s}" (use e.g. 15m, 3h, 2d)`);
	return Number(m[1]) * { m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE }[m[2]];
}

function dayAt(now, daysAgo, at) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(at));
	if (!m) throw new Error(`bad time "${at}" (use HH:MM)`);
	const d = new Date(now);
	d.setDate(d.getDate() - daysAgo);
	d.setHours(Number(m[1]), Number(m[2]), 0, 0);
	return d;
}

/** Message text → the stored, encrypted columns (as services/messages.js does). */
function encrypt(text) {
	const dek = generateDEK();
	const body = encryptMessage(text, dek);
	return {
		dek,
		columns: { text: null, ciphertext: body.ciphertext, iv: body.iv, auth_tag: body.authTag, wrapped_dek: wrapDEK(dek, KEY_ID), key_id: KEY_ID },
	};
}

/** A quote or forwarded text, sealed with its message's key. */
function sealed(text, dek) {
	const r = encryptMessage(text, dek);
	return JSON.stringify({ c: r.ciphertext, iv: r.iv, t: r.authTag });
}

// ─── Checking the data and laying it out in time ─────────────────────────────

/**
 * A conversation's entries → messages with times, in order, all in the past.
 * `who` maps ">" and "<" to the two people.
 */
function timeline(label, entries, who, now, random) {
	const out = [];
	let t = null;
	for (const entry of entries) {
		if (!Array.isArray(entry)) {
			const start = entry.ago !== undefined ? new Date(now.getTime() - span(entry.ago)) : dayAt(now, entry.day, entry.at);
			// a block never starts before the previous one ended
			t = t && start <= t ? new Date(t.getTime() + MINUTE) : start;
			continue;
		}
		const [dir, text, opts = {}] = entry;
		if (t === null) throw new Error(`${label}: the first entry must be day(...) or ago(...)`);
		if (dir !== ">" && dir !== "<") throw new Error(`${label}: "${dir}" is neither ">" nor "<"`);
		if (typeof text !== "string" || !text.trim() || text.length > MAX_LEN) throw new Error(`${label}: message ${out.length + 1} is empty or longer than ${MAX_LEN}`);
		if (out.length > 0 || opts.gap !== undefined) {
			const gap = opts.gap !== undefined ? opts.gap : 0.3 + random() * 2.7;
			t = new Date(t.getTime() + gap * MINUTE);
		}
		if (opts.reply !== undefined && (!Number.isInteger(opts.reply) || opts.reply >= 0 || !out[out.length + opts.reply])) {
			throw new Error(`${label}: message ${out.length + 1} replies to a message that is not there (${opts.reply})`);
		}
		if (opts.once && opts.capsule) throw new Error(`${label}: a message cannot be one-time and a capsule`);
		out.push({ from: who[dir], to: who[dir === ">" ? "<" : ">"], text: text.trim(), at: t, opts });
	}
	// everything already happened (a long block that started minutes ago)
	const latest = new Date(now.getTime() - MINUTE);
	const over = out.length ? out[out.length - 1].at.getTime() - latest.getTime() : 0;
	if (over > 0) for (const m of out) m.at = new Date(m.at.getTime() - over);
	return out;
}

/** Marks the trailing unread / unseen messages, checking they are who the data says. */
function markSeen(label, msgs, { unread = 0, unseen = 0 }, mainId) {
	for (const m of msgs) m.seen = true;
	const tail = (n, fromMain) => {
		const last = msgs.slice(msgs.length - n);
		if (last.length !== n || last.some((m) => (m.from === mainId) !== fromMain)) {
			throw new Error(`${label}: the last ${n} messages must all be ${fromMain ? "the main user's (unseen)" : "theirs (unread)"}`);
		}
		for (const m of last) m.seen = false;
	};
	if (unread && unseen) throw new Error(`${label}: only one of unread / unseen can be set`);
	if (unread) tail(unread, false);
	if (unseen) tail(unseen, true);
}

// ─── Writing ───────────────────────────────────────────────────────────────

const MODELS_IN_DELETE_ORDER = [
	"messageReaction",
	"pushSubscription",
	"session",
	"passwordResetToken",
	"emailVerification",
	"message",
	"contact",
	"conversationMember",
	"conversation",
	"user",
];

/** Empties every table (the migrations stay) and the uploaded pictures. */
export async function wipe() {
	const removed = {};
	for (const model of MODELS_IN_DELETE_ORDER) removed[model] = (await prisma[model].deleteMany({})).count;
	let files = 0;
	if (fs.existsSync(AVATAR_DIR)) {
		for (const f of fs.readdirSync(AVATAR_DIR)) {
			// only what the server writes there (keeps .gitkeep and anything else)
			if (/^(av-\d+-[0-9a-f]+\.jpg(\.part)?|up-\d+-[0-9a-f]+\.tmp|\d+\.(jpg|jpeg|png|webp|gif))$/.test(f)) {
				fs.unlinkSync(path.join(AVATAR_DIR, f));
				files++;
			}
		}
	}
	return { removed, files };
}

async function storeAvatar(sharp, userId, source) {
	const outName = `av-${userId}-${crypto.randomBytes(12).toString("hex")}.jpg`;
	fs.mkdirSync(AVATAR_DIR, { recursive: true });
	// the same processing as an upload: upright, at most 1024px, JPEG without metadata
	await sharp(source, { limitInputPixels: 25_000_000 })
		.rotate()
		.resize({ width: 1024, height: 1024, fit: "inside" })
		.jpeg({ quality: 80 })
		.toFile(path.join(AVATAR_DIR, outName));
	return `${AVATAR_URL_PREFIX}${outName}`;
}

function photoFor(username) {
	for (const ext of PHOTO_EXTS) {
		const p = path.join(AVATAR_SOURCE, `${username}${ext}`);
		if (fs.existsSync(p)) return p;
	}
	return null;
}

/**
 * Writes everything. The database must be empty of users.
 * @returns a summary for the console
 */
export async function seed({ now = new Date() } = {}) {
	await initKeyStore();
	// fails here, before anything is written, if the KEK is missing or wrong
	wrapDEK(generateDEK(), KEY_ID);

	const random = randomFrom(1405);
	const byName = new Map(people.map((p) => [p.username, p]));
	if (!byName.has(MAIN)) throw new Error(`MAIN "${MAIN}" is not in people`);
	for (const name of [...Object.keys(mainList), ...friends.flat(), ...chats.map((c) => c.with), ...side.flatMap((s) => s.between)]) {
		if (!byName.has(name)) throw new Error(`"${name}" is used in data.js but not in people`);
	}

	// ── the people
	const passwordHash = await bcrypt.hash(PASSWORD, 10);
	const ids = new Map();
	for (const p of people) {
		const createdAt = new Date(now.getTime() - (40 + Math.floor(random() * 60)) * 24 * 60 * MINUTE);
		const user = await prisma.user.create({
			data: {
				name: p.name,
				username: p.username,
				email: (p.email || `${p.username}@rivo.test`).toLowerCase(),
				bio: p.bio ?? null,
				passwordHash,
				privacyOnline: p.privacyOnline || "everyone",
				lastSeen: p.lastSeen ? new Date(now.getTime() - span(p.lastSeen)) : null,
				createdAt,
			},
			select: { id: true },
		});
		ids.set(p.username, user.id);
	}
	const mainId = ids.get(MAIN);
	const nameOf = new Map(people.map((p) => [ids.get(p.username), p.name]));

	// ── Saved Messages, for everyone (registration makes one)
	const savedConv = new Map();
	for (const p of people) {
		const uid = ids.get(p.username);
		const conv = await prisma.conversation.create({ data: { createdAt: new Date(now.getTime() - 30 * 24 * 60 * MINUTE), members: { create: [{ userId: uid }] } } });
		await prisma.contact.create({ data: { ownerId: uid, contactId: uid, conversationId: conv.id, isSaved: true } });
		savedConv.set(uid, conv.id);
	}

	// ── who keeps whom: the main user has everyone and everyone has him;
	// the others also keep a few of each other
	const keeps = new Map(people.map((p) => [p.username, new Set()]));
	for (const p of people) {
		if (p.username === MAIN) continue;
		keeps.get(MAIN).add(p.username);
		keeps.get(p.username).add(MAIN);
	}
	for (const [a, b] of friends) {
		keeps.get(a).add(b);
		keeps.get(b).add(a);
	}
	const blockedByMain = new Set(Object.entries(mainList).filter(([, h]) => h.blocked).map(([n]) => n));
	const others = people.map((p) => p.username).filter((n) => n !== MAIN && !blockedByMain.has(n));
	for (const name of others) {
		const want = 1 + Math.floor(random() * 3);
		const pool = others.filter((n) => n !== name);
		while ([...keeps.get(name)].filter((n) => n !== MAIN).length < want && pool.length) {
			keeps.get(name).add(pool.splice(Math.floor(random() * pool.length), 1)[0]);
		}
	}

	// one conversation per pair, shared by both rows; a person in someone's
	// list they never chose has addedByOwner false (the server does the same)
	const pairConv = new Map();
	const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
	const contactRows = [];
	for (const [owner, set] of keeps) {
		for (const other of set) {
			const key = pairKey(owner, other);
			if (!pairConv.has(key)) {
				const conv = await prisma.conversation.create({
					data: {
						createdAt: new Date(now.getTime() - (20 + Math.floor(random() * 15)) * 24 * 60 * MINUTE),
						members: { create: [{ userId: ids.get(owner) }, { userId: ids.get(other) }] },
					},
				});
				pairConv.set(key, conv.id);
			}
		}
	}
	for (const [a, b] of [...pairConv.keys()].map((k) => k.split(":"))) {
		for (const [owner, other] of [
			[a, b],
			[b, a],
		]) {
			const chose = keeps.get(owner).has(other);
			const how = owner === MAIN ? mainList[other] || {} : {};
			contactRows.push({
				ownerId: ids.get(owner),
				contactId: ids.get(other),
				conversationId: pairConv.get(pairKey(owner, other)),
				addedByOwner: owner === MAIN ? how.addedByOwner !== false : chose,
				nickname: how.nickname ?? null,
				isPinned: how.pinned !== undefined,
				pinOrder: how.pinned ?? null,
				isMuted: !!how.muted,
				isBlocked: !!how.blocked,
				isArchived: !!how.archived,
			});
		}
	}
	for (const row of contactRows) await prisma.contact.create({ data: row });

	// ── the messages
	const conversations = [
		...chats.map((c) => ({
			label: `chat with ${c.with}`,
			convId: pairConv.get(pairKey(MAIN, c.with)),
			who: { ">": mainId, "<": ids.get(c.with) },
			entries: c.messages,
			seen: c,
		})),
		{ label: "Saved Messages", convId: savedConv.get(mainId), who: { ">": mainId, "<": mainId }, entries: saved, seen: {}, self: true },
		...side.map((s) => ({
			label: `${s.between[0]} ↔ ${s.between[1]}`,
			convId: pairConv.get(pairKey(s.between[0], s.between[1])),
			who: { ">": ids.get(s.between[0]), "<": ids.get(s.between[1]) },
			entries: s.messages,
			seen: {},
		})),
	];
	let messageCount = 0;
	const lastHeard = new Map();
	for (const c of conversations) {
		if (!c.convId) throw new Error(`${c.label}: these two are not in each other's lists`);
		const msgs = timeline(c.label, c.entries, c.who, now, random);
		markSeen(c.label, msgs, c.seen, mainId);
		const stored = [];
		for (const m of msgs) {
			const { dek, columns } = encrypt(m.text);
			let reply = {};
			if (m.opts.reply) {
				const target = stored[stored.length + m.opts.reply];
				const quotable = !target.msg.opts.once && !target.msg.opts.capsule;
				reply = { replyToId: target.id, replyToName: nameOf.get(target.msg.from), replyToText: quotable ? sealed(target.msg.text, dek) : null };
			}
			const capsuleAt = m.opts.capsule ? new Date(Math.ceil((now.getTime() + span(m.opts.capsule)) / MINUTE) * MINUTE) : null;
			const row = await prisma.message.create({
				data: {
					conversationId: c.convId,
					senderId: m.from,
					...columns,
					isSeen: c.self ? false : m.seen,
					isEdited: !!m.opts.edited,
					isPinned: !!m.opts.pin,
					isOneTime: !!m.opts.once,
					isTimeCapsule: !!capsuleAt,
					scheduledFor: capsuleAt,
					...reply,
					forwardedFrom: m.opts.fwd ?? null,
					forwardedText: m.opts.fwd ? sealed(m.text, dek) : null,
					createdAt: m.at,
					updatedAt: m.opts.edited ? new Date(m.at.getTime() + 2 * MINUTE) : m.at,
				},
				select: { id: true },
			});
			stored.push({ id: row.id, msg: m });
			if (m.opts.react && !c.self) {
				await prisma.messageReaction.create({ data: { messageId: row.id, userId: m.to, emoji: m.opts.react, createdAt: new Date(m.at.getTime() + MINUTE) } });
			}
			if (!lastHeard.has(m.from) || lastHeard.get(m.from) < m.at) lastHeard.set(m.from, m.at);
			messageCount++;
		}
		if (msgs.length) await prisma.conversation.update({ where: { id: c.convId }, data: { lastMessageAt: msgs[msgs.length - 1].at } });
	}

	// unread counters: exactly what each owner has not read
	for (const row of await prisma.contact.findMany({ where: { isSaved: false }, select: { id: true, ownerId: true, conversationId: true } })) {
		const unread = await prisma.message.count({ where: { conversationId: row.conversationId, senderId: { not: row.ownerId }, isSeen: false, isDeleted: false } });
		if (unread) await prisma.contact.update({ where: { id: row.id }, data: { unreadCount: unread } });
	}
	// nobody was last seen before their own last message
	for (const [uid, at] of lastHeard) {
		if (uid === mainId) continue;
		const u = await prisma.user.findUnique({ where: { id: uid }, select: { lastSeen: true } });
		if (!u.lastSeen || u.lastSeen < at) await prisma.user.update({ where: { id: uid }, data: { lastSeen: new Date(at.getTime() + MINUTE) } });
	}

	// ── pictures from prisma/seed/avatars/<username>.jpg|png|webp
	let sharp = null;
	const photos = { added: [], missing: [] };
	try {
		sharp = (await import("sharp")).default;
	} catch {
		/* no sharp: no pictures (reported below) */
	}
	for (const p of people) {
		const file = photoFor(p.username);
		if (!file) {
			if (p.photo) photos.missing.push(p.username);
			continue;
		}
		if (!sharp) {
			photos.missing.push(p.username);
			continue;
		}
		const uid = ids.get(p.username);
		const url = await storeAvatar(sharp, uid, file);
		await prisma.user.update({ where: { id: uid }, data: { profilePics: [url] } });
		photos.added.push(p.username);
	}

	return {
		users: people.length,
		contacts: contactRows.length,
		conversations: pairConv.size,
		messages: messageCount,
		photos,
		sharpMissing: !sharp,
	};
}

export { prisma, people, PASSWORD, MAIN };
