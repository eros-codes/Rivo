// Fills an empty database with the test data in data.ts, the way the server
// itself would have stored it: encrypted messages (with this .env's KEK),
// one conversation per pair shared by both contact rows, unread counters
// that match the messages, Saved Messages for everyone.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import { config } from "../../server/config.ts";
import prisma from "../../server/prisma.ts";
import { encryptMessage, generateDEK, initKeyStore, sealText, wrapDEK } from "../../server/utils/encryption.ts";
import { MAIN, PASSWORD, chats, friends, mainList, people, saved, side, type Entry, type Keeping, type Line, type Opts } from "./data.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const AVATAR_SOURCE = path.join(ROOT, "prisma", "seed", "avatars");
// where the server keeps uploaded pictures (server/routes/users.ts)
const AVATAR_DIR = path.join(ROOT, "public", "assets", "images", "user-profiles");
const AVATAR_URL_PREFIX = "/assets/images/user-profiles/";
const PHOTO_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

const KEY_ID = process.env.ACTIVE_KEY_ID || "v1";
const MAX_LEN = config.messages.maxLength;
const MINUTE = 60_000;

// ─── Small helpers ─────────────────────────────────────────────────────────

/** The same "random" choices on every run. */
function randomFrom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const UNIT = { m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE } as const;

/** "12m", "3h", "2d" → milliseconds. */
function span(s: string): number {
	const m = /^(\d+)(m|h|d)$/.exec(s);
	if (!m) throw new Error(`bad time span "${s}" (use e.g. 15m, 3h, 2d)`);
	return Number(m[1]) * UNIT[m[2] as keyof typeof UNIT];
}

function dayAt(now: Date, daysAgo: number, at: string): Date {
	const m = /^(\d{1,2}):(\d{2})$/.exec(at);
	if (!m) throw new Error(`bad time "${at}" (use HH:MM)`);
	const d = new Date(now);
	d.setDate(d.getDate() - daysAgo);
	d.setHours(Number(m[1]), Number(m[2]), 0, 0);
	return d;
}

/** Message text → the stored, encrypted columns (as services/messages.ts does). */
function encrypt(text: string) {
	const dek = generateDEK();
	const body = encryptMessage(text, dek);
	return {
		dek,
		columns: { ciphertext: body.ciphertext, iv: body.iv, auth_tag: body.authTag, wrapped_dek: wrapDEK(dek, KEY_ID), key_id: KEY_ID },
	};
}

function isLine(entry: Entry): entry is Line {
	return Array.isArray(entry);
}

// ─── Checking the data and laying it out in time ─────────────────────────────

interface Timed {
	from: number;
	to: number;
	text: string;
	at: Date;
	opts: Opts;
	seen: boolean;
}
type Who = Record<">" | "<", number>;

/**
 * A conversation's entries → messages with times, in order, all in the past.
 * `who` maps ">" and "<" to the two people.
 */
function timeline(label: string, entries: readonly Entry[], who: Who, now: Date, random: () => number): Timed[] {
	const out: Timed[] = [];
	// (the end of the previous message or block; `as` keeps TypeScript from
	// treating it as always null inside the loop)
	let t = null as Date | null;
	for (const entry of entries) {
		if (!isLine(entry)) {
			const start = "ago" in entry ? new Date(now.getTime() - span(entry.ago)) : dayAt(now, entry.day, entry.at);
			// a block never starts before the previous one ended
			t = t !== null && start <= t ? new Date(t.getTime() + MINUTE) : start;
			continue;
		}
		const [dir, text, opts = {}] = entry;
		if (t === null) throw new Error(`${label}: the first entry must be day(...) or ago(...)`);
		if (dir !== ">" && dir !== "<") throw new Error(`${label}: "${String(dir)}" is neither ">" nor "<"`);
		if (typeof text !== "string" || !text.trim() || text.length > MAX_LEN) throw new Error(`${label}: message ${out.length + 1} is empty or longer than ${MAX_LEN}`);
		if (out.length > 0 || opts.gap !== undefined) {
			const gap = opts.gap !== undefined ? opts.gap : 0.3 + random() * 2.7;
			t = new Date(t.getTime() + gap * MINUTE);
		}
		if (opts.reply !== undefined && (!Number.isInteger(opts.reply) || opts.reply >= 0 || !out[out.length + opts.reply])) {
			throw new Error(`${label}: message ${out.length + 1} replies to a message that is not there (${opts.reply})`);
		}
		if (opts.once && opts.capsule) throw new Error(`${label}: a message cannot be one-time and a capsule`);
		out.push({ from: who[dir], to: who[dir === ">" ? "<" : ">"], text: text.trim(), at: t, opts, seen: true });
	}
	// everything already happened (a long block that started minutes ago)
	const last = out[out.length - 1];
	const over = last ? last.at.getTime() - (now.getTime() - MINUTE) : 0;
	if (over > 0) for (const m of out) m.at = new Date(m.at.getTime() - over);
	return out;
}

/** Marks the trailing unread / unseen messages, checking they are who the data says. */
function markSeen(label: string, msgs: Timed[], { unread = 0, unseen = 0 }: { unread?: number; unseen?: number }, mainId: number): void {
	for (const m of msgs) m.seen = true;
	const tail = (n: number, fromMain: boolean) => {
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

/** Empties every table (the migrations stay) and the uploaded pictures. */
export async function wipe() {
	// children before parents
	const removed = {
		messageReaction: (await prisma.messageReaction.deleteMany({})).count,
		pushSubscription: (await prisma.pushSubscription.deleteMany({})).count,
		session: (await prisma.session.deleteMany({})).count,
		passwordResetToken: (await prisma.passwordResetToken.deleteMany({})).count,
		emailVerification: (await prisma.emailVerification.deleteMany({})).count,
		message: (await prisma.message.deleteMany({})).count,
		contact: (await prisma.contact.deleteMany({})).count,
		conversationMember: (await prisma.conversationMember.deleteMany({})).count,
		conversation: (await prisma.conversation.deleteMany({})).count,
		user: (await prisma.user.deleteMany({})).count,
	};
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

async function loadSharp() {
	return (await import("sharp")).default;
}
type Sharp = Awaited<ReturnType<typeof loadSharp>>;

async function storeAvatar(sharp: Sharp, userId: number, source: string): Promise<string> {
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

function photoFor(username: string): string | null {
	for (const ext of PHOTO_EXTS) {
		const p = path.join(AVATAR_SOURCE, `${username}${ext}`);
		if (fs.existsSync(p)) return p;
	}
	return null;
}

/** What seed() wrote, for the console. */
export interface Summary {
	users: number;
	contacts: number;
	conversations: number;
	messages: number;
	photos: { added: string[]; missing: string[] };
	sharpMissing: boolean;
}

/** Writes everything. The database must be empty of users. */
export async function seed({ now = new Date() }: { now?: Date } = {}): Promise<Summary> {
	await initKeyStore();
	// fails here, before anything is written, if the KEK is missing or wrong
	wrapDEK(generateDEK(), KEY_ID);

	const random = randomFrom(1405);
	const usernames = new Set(people.map((p) => p.username));
	if (!usernames.has(MAIN)) throw new Error(`MAIN "${MAIN}" is not in people`);
	for (const name of [...Object.keys(mainList), ...friends.flat(), ...chats.map((c) => c.with), ...side.flatMap((s) => s.between)]) {
		if (!usernames.has(name)) throw new Error(`"${name}" is used in data.ts but not in people`);
	}

	// ── the people
	const passwordHash = await bcrypt.hash(PASSWORD, 10);
	const ids = new Map<string, number>();
	const idOf = (username: string): number => {
		const id = ids.get(username);
		if (id === undefined) throw new Error(`"${username}" was not created`);
		return id;
	};
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
	const mainId = idOf(MAIN);
	const nameOf = new Map(people.map((p) => [idOf(p.username), p.name]));

	// ── Saved Messages, for everyone (registration makes one)
	const savedConv = new Map<number, number>();
	for (const p of people) {
		const uid = idOf(p.username);
		const conv = await prisma.conversation.create({ data: { createdAt: new Date(now.getTime() - 30 * 24 * 60 * MINUTE), members: { create: [{ userId: uid }] } } });
		await prisma.contact.create({ data: { ownerId: uid, contactId: uid, conversationId: conv.id, isSaved: true } });
		savedConv.set(uid, conv.id);
	}

	// ── who keeps whom: the main user has everyone and everyone has him;
	// the others also keep a few of each other
	const keeps = new Map(people.map((p) => [p.username, new Set<string>()]));
	const keptBy = (username: string): Set<string> => keeps.get(username) as Set<string>;
	for (const p of people) {
		if (p.username === MAIN) continue;
		keptBy(MAIN).add(p.username);
		keptBy(p.username).add(MAIN);
	}
	for (const [a, b] of friends) {
		keptBy(a).add(b);
		keptBy(b).add(a);
	}
	const blockedByMain = new Set(Object.entries(mainList).filter(([, h]) => h?.blocked).map(([n]) => n));
	const others = people.map((p) => p.username).filter((n) => n !== MAIN && !blockedByMain.has(n));
	for (const name of others) {
		const want = 1 + Math.floor(random() * 3);
		const pool = others.filter((n) => n !== name);
		while ([...keptBy(name)].filter((n) => n !== MAIN).length < want && pool.length) {
			keptBy(name).add(pool.splice(Math.floor(random() * pool.length), 1)[0] as string);
		}
	}

	// one conversation per pair, shared by both rows; a person in someone's
	// list they never chose has addedByOwner false (the server does the same)
	const pairConv = new Map<string, number>();
	const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
	const convOf = (a: string, b: string): number | undefined => pairConv.get(pairKey(a, b));
	for (const [owner, set] of keeps) {
		for (const other of set) {
			const key = pairKey(owner, other);
			if (!pairConv.has(key)) {
				const conv = await prisma.conversation.create({
					data: {
						createdAt: new Date(now.getTime() - (20 + Math.floor(random() * 15)) * 24 * 60 * MINUTE),
						members: { create: [{ userId: idOf(owner) }, { userId: idOf(other) }] },
					},
				});
				pairConv.set(key, conv.id);
			}
		}
	}
	let contactRows = 0;
	for (const [a, b] of [...pairConv.keys()].map((k) => k.split(":") as [string, string])) {
		for (const [owner, other] of [
			[a, b],
			[b, a],
		] as const) {
			const chose = keptBy(owner).has(other);
			const how: Keeping = owner === MAIN ? (mainList[other as keyof typeof mainList] ?? {}) : {};
			await prisma.contact.create({
				data: {
					ownerId: idOf(owner),
					contactId: idOf(other),
					conversationId: pairConv.get(pairKey(owner, other)) as number,
					addedByOwner: owner === MAIN ? how.addedByOwner !== false : chose,
					nickname: how.nickname ?? null,
					isPinned: how.pinned !== undefined,
					pinOrder: how.pinned ?? null,
					isMuted: !!how.muted,
					isBlocked: !!how.blocked,
					isArchived: !!how.archived,
				},
			});
			contactRows++;
		}
	}

	// ── the messages
	const conversations = [
		...chats.map((c) => ({
			label: `chat with ${c.with}`,
			convId: convOf(MAIN, c.with),
			who: { ">": mainId, "<": idOf(c.with) },
			entries: c.messages,
			seen: c,
			self: false,
		})),
		{ label: "Saved Messages", convId: savedConv.get(mainId), who: { ">": mainId, "<": mainId }, entries: saved, seen: {}, self: true },
		...side.map((s) => ({
			label: `${s.between[0]} ↔ ${s.between[1]}`,
			convId: convOf(s.between[0], s.between[1]),
			who: { ">": idOf(s.between[0]), "<": idOf(s.between[1]) },
			entries: s.messages,
			seen: {},
			self: false,
		})),
	];
	let messageCount = 0;
	const lastHeard = new Map<number, Date>();
	for (const c of conversations) {
		const convId = c.convId;
		if (!convId) throw new Error(`${c.label}: these two are not in each other's lists`);
		const msgs = timeline(c.label, c.entries, c.who, now, random);
		markSeen(c.label, msgs, c.seen, mainId);
		const stored: { id: number; msg: Timed }[] = [];
		for (const m of msgs) {
			const { dek, columns } = encrypt(m.text);
			let reply = {};
			if (m.opts.reply) {
				const target = stored[stored.length + m.opts.reply];
				if (!target) throw new Error(`${c.label}: a reply to a message that is not there`);
				const quotable = !target.msg.opts.once && !target.msg.opts.capsule;
				reply = { replyToId: target.id, replyToName: nameOf.get(target.msg.from) ?? null, replyToText: quotable ? sealText(target.msg.text, dek) : null };
			}
			const capsuleAt = m.opts.capsule ? new Date(Math.ceil((now.getTime() + span(m.opts.capsule)) / MINUTE) * MINUTE) : null;
			const row = await prisma.message.create({
				data: {
					conversationId: convId,
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
					forwardedText: m.opts.fwd ? sealText(m.text, dek) : null,
					createdAt: m.at,
					updatedAt: m.opts.edited ? new Date(m.at.getTime() + 2 * MINUTE) : m.at,
				},
				select: { id: true },
			});
			stored.push({ id: row.id, msg: m });
			if (m.opts.react && !c.self) {
				await prisma.messageReaction.create({ data: { messageId: row.id, userId: m.to, emoji: m.opts.react, createdAt: new Date(m.at.getTime() + MINUTE) } });
			}
			const heard = lastHeard.get(m.from);
			if (!heard || heard < m.at) lastHeard.set(m.from, m.at);
			messageCount++;
		}
		const last = msgs[msgs.length - 1];
		if (last) await prisma.conversation.update({ where: { id: convId }, data: { lastMessageAt: last.at } });
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
		if (!u?.lastSeen || u.lastSeen < at) await prisma.user.update({ where: { id: uid }, data: { lastSeen: new Date(at.getTime() + MINUTE) } });
	}

	// ── pictures from prisma/seed/avatars/<username>.jpg|png|webp
	let sharp: Sharp | null = null;
	const photos: Summary["photos"] = { added: [], missing: [] };
	try {
		sharp = await loadSharp();
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
		const uid = idOf(p.username);
		const url = await storeAvatar(sharp, uid, file);
		await prisma.user.update({ where: { id: uid }, data: { profilePics: [url] } });
		photos.added.push(p.username);
	}

	return {
		users: people.length,
		contacts: contactRows,
		conversations: pairConv.size,
		messages: messageCount,
		photos,
		sharpMissing: !sharp,
	};
}

export { prisma, people, PASSWORD, MAIN };
