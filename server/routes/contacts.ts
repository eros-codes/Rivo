import { Router, type Request } from "express";
import type { Prisma } from "@prisma/client";
import prisma from "../prisma.ts";
import { config } from "../config.ts";
import { requireAuth } from "../middleware/auth.ts";
import { parseId } from "../utils/validators.ts";
import { findUserByUsername } from "../utils/userLookup.ts";
import { invalidateConversation } from "../services/caches.ts";
import {
	CONTACT_INCLUDE,
	CONTACT_ORDER,
	contactRowFor,
	emitContactUpsert,
	ensureSavedContact,
	serializeContacts,
} from "../services/contacts.ts";
import { emitToUser } from "../realtime/registry.ts";
import { log } from "../utils/logger.ts";
import { codeOf } from "../utils/errors.ts";

const router = Router();

// The device that made a change says which socket it is, so its own
// connection is not told about it again (it already shows the change).
const actingSocket = (req: Request): string | null => {
	const v = req.get("x-socket-id");
	return typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null;
};

// ─── List ─────────────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
	const { contactsDefault, contactsMax } = config.pages;
	const limit = Math.min(Math.max(parseId(String(req.query.limit ?? "")) || contactsDefault, 1), contactsMax);
	const skip = parseId(String(req.query.skip ?? "")) || 0;
	try {
		if (skip === 0) await ensureSavedContact(req.userId);
		const rows = await prisma.contact.findMany({
			where: { ownerId: req.userId },
			include: CONTACT_INCLUDE,
			orderBy: CONTACT_ORDER,
			take: limit,
			skip,
		});
		return void res.json(await serializeContacts(rows, req.userId));
	} catch (e) {
		log.error("GET /contacts failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

router.get("/:id", requireAuth, async (req, res) => {
	const id = parseId(req.params.id);
	if (!id) return void res.status(400).json({ error: "Invalid contact id" });
	try {
		const row = await contactRowFor(req.userId, id);
		if (!row) return void res.status(404).json({ error: "Contact not found" });
		return void res.json(row);
	} catch (e) {
		log.error("GET /contacts/:id failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Add ──────────────────────────────────────────────────────────────────
// One add at a time per pair of people (both adding each other at once must
// not create two conversations). The server runs as a single process.
const pairLocks = new Map<string, Promise<void>>();
async function lockPair(a: number, b: number): Promise<() => void> {
	const key = a < b ? `${a}:${b}` : `${b}:${a}`;
	const prev = pairLocks.get(key) || Promise.resolve();
	let release: () => void = () => {};
	const mine = new Promise<void>((r) => (release = () => r()));
	const tail = prev.then(() => mine);
	pairLocks.set(key, tail);
	await prev;
	return () => {
		release();
		if (pairLocks.get(key) === tail) pairLocks.delete(key);
	};
}

router.post("/", requireAuth, async (req, res) => {
	const { username, name } = req.body || {};
	if (typeof username !== "string" || !username.trim()) return void res.status(400).json({ error: "Username is required" });
	if (name !== undefined && name !== null && typeof name !== "string") return void res.status(400).json({ error: "Name must be a string" });
	const nickname = typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : null;

	try {
		const target = await findUserByUsername(username);
		if (!target || target.isDeleted) return void res.status(404).json({ error: "User not found" });
		if (target.id === req.userId) return void res.status(400).json({ error: "You cannot add yourself" });

		const release = await lockPair(req.userId, target.id);
		let created: { id: number; conversationId: number } | undefined;
		let adopted: number | null = null;
		let theirRowId: number | null = null;
		try {
			const existing = await prisma.contact.findFirst({
				where: { ownerId: req.userId, contactId: target.id, isSaved: false },
				select: { id: true, conversationId: true, addedByOwner: true },
			});
			if (existing?.addedByOwner) return void res.status(409).json({ error: "Contact already exists" });
			if (existing) {
				// already in the list because they added this user: now it is
				// this user's own choice too
				await prisma.contact.update({
					where: { id: existing.id },
					data: { addedByOwner: true, ...(nickname ? { nickname } : {}) },
				});
				invalidateConversation(existing.conversationId);
				adopted = existing.id;
			} else {
				const reciprocal = await prisma.contact.findFirst({
					where: { ownerId: target.id, contactId: req.userId, isSaved: false },
					select: { conversationId: true },
				});
				if (reciprocal) {
					// they already have us: share their conversation
					created = await prisma.contact.create({
						data: { ownerId: req.userId, contactId: target.id, conversationId: reciprocal.conversationId, nickname },
						select: { id: true, conversationId: true },
					});
				} else {
					// both may have removed each other before: reuse that
					// conversation, so the history comes back
					const shared = await prisma.conversation.findFirst({
						where: {
							AND: [
								{ members: { some: { userId: req.userId } } },
								{ members: { some: { userId: target.id } } },
								{ members: { every: { userId: { in: [req.userId, target.id] } } } },
							],
						},
						orderBy: { id: "desc" },
						select: { id: true },
					});
					const rows = await prisma.$transaction(async (tx) => {
						const conversationId = shared
							? shared.id
							: (await tx.conversation.create({ data: { members: { create: [{ userId: req.userId }, { userId: target.id }] } } })).id;
						const mine = await tx.contact.create({
							data: { ownerId: req.userId, contactId: target.id, conversationId, nickname },
							select: { id: true, conversationId: true },
						});
						// in their list too, but not as someone *they* chose
						const theirs = await tx.contact.create({
							data: { ownerId: target.id, contactId: req.userId, conversationId, addedByOwner: false },
							select: { id: true },
						});
						return { mine, theirs };
					});
					created = rows.mine;
					theirRowId = rows.theirs.id;
				}
				invalidateConversation(created.conversationId);
			}
		} finally {
			release();
		}

		if (adopted) {
			const row = await contactRowFor(req.userId, adopted);
			// (it was just updated)
			if (!row) throw new Error("contact row not found");
			emitToUser(req.userId, "contact:upsert", row, { exceptSocketId: actingSocket(req) });
			// what they may see of this user can have changed
			const theirs = await prisma.contact.findFirst({ where: { ownerId: target.id, conversationId: row.conversationId }, select: { id: true } });
			if (theirs) await emitContactUpsert(target.id, theirs.id);
			return void res.status(200).json(row);
		}
		// (set above whenever no existing row was adopted)
		if (!created) throw new Error("contact row not created");
		const row = await contactRowFor(req.userId, created.id);
		// this user's other devices, and the other person's list
		emitToUser(req.userId, "contact:upsert", row, { exceptSocketId: actingSocket(req) });
		if (theirRowId) await emitContactUpsert(target.id, theirRowId);
		return void res.status(201).json(row);
	} catch (e) {
		// the database's own guarantee (one row per person in a list): another
		// request (or server process) added the same contact a moment earlier
		if (codeOf(e) === "P2002") return void res.status(409).json({ error: "Contact already exists" });
		log.error("POST /contacts failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Update (pin, mute, block, archive, nickname) ─────────────────────────
router.patch("/:id", requireAuth, async (req, res) => {
	const id = parseId(req.params.id);
	if (!id) return void res.status(400).json({ error: "Invalid contact id" });
	const { isPinned, pinOrder, isMuted, isBlocked, nickname, isArchived } = req.body || {};
	if (nickname !== undefined && nickname !== null && typeof nickname !== "string") return void res.status(400).json({ error: "nickname must be a string" });
	for (const [key, value] of Object.entries({ isPinned, isMuted, isBlocked, isArchived })) {
		if (value !== undefined && typeof value !== "boolean") return void res.status(400).json({ error: `${key} must be a boolean` });
	}
	if (pinOrder !== undefined && pinOrder !== null && (!Number.isInteger(pinOrder) || pinOrder < 0 || pinOrder > 9999)) {
		return void res.status(400).json({ error: "pinOrder must be an integer between 0 and 9999" });
	}
	const data: Prisma.ContactUncheckedUpdateInput = {};
	if (isPinned !== undefined) data.isPinned = isPinned;
	if (pinOrder !== undefined) data.pinOrder = pinOrder;
	if (isMuted !== undefined) data.isMuted = isMuted;
	if (isBlocked !== undefined) data.isBlocked = isBlocked;
	if (isArchived !== undefined) data.isArchived = isArchived;
	// "" clears the nickname; naming someone makes them one of this user's contacts
	if (nickname !== undefined) data.nickname = typeof nickname === "string" && nickname.trim() ? nickname.trim().slice(0, 100) : null;
	if (data.nickname) data.addedByOwner = true;
	if (Object.keys(data).length === 0) return void res.status(400).json({ error: "Nothing to change" });

	try {
		const contact = await prisma.contact.findFirst({ where: { id, ownerId: req.userId }, select: { id: true, conversationId: true, isSaved: true } });
		if (!contact) return void res.status(404).json({ error: "Contact not found" });
		// Saved Messages can be pinned or muted, nothing else
		if (contact.isSaved && (data.isBlocked !== undefined || data.isArchived !== undefined || data.nickname !== undefined)) {
			return void res.status(400).json({ error: "Saved Messages cannot be changed this way" });
		}
		await prisma.contact.update({ where: { id }, data });
		// mute and block decide who gets messages and notifications
		invalidateConversation(contact.conversationId);
		const row = await contactRowFor(req.userId, id);
		emitToUser(req.userId, "contact:upsert", row, { exceptSocketId: actingSocket(req) });
		return void res.json(row);
	} catch (e) {
		log.error("PATCH /contacts/:id failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Remove ───────────────────────────────────────────────────────────────
// Only this user's own row goes; the other person keeps theirs (and the chat).
router.delete("/:id", requireAuth, async (req, res) => {
	const id = parseId(req.params.id);
	if (!id) return void res.status(400).json({ error: "Invalid contact id" });
	try {
		const contact = await prisma.contact.findFirst({ where: { id, ownerId: req.userId } });
		if (!contact) return void res.status(404).json({ error: "Contact not found" });
		if (contact.isSaved) return void res.status(400).json({ error: "Saved Messages cannot be deleted" });

		await prisma.$transaction(async (tx) => {
			await tx.contact.delete({ where: { id } });
			// nobody has the conversation anymore and it never had a message:
			// it can go (members first, they reference it)
			const remaining = await tx.contact.findFirst({ where: { conversationId: contact.conversationId }, select: { id: true } });
			if (!remaining && (await tx.message.count({ where: { conversationId: contact.conversationId } })) === 0) {
				await tx.conversationMember.deleteMany({ where: { conversationId: contact.conversationId } });
				await tx.conversation.delete({ where: { id: contact.conversationId } });
			}
		});
		invalidateConversation(contact.conversationId);
		emitToUser(req.userId, "contact:removed", {
			contactUserId: contact.contactId,
			contactRowId: contact.id,
			conversationId: contact.conversationId,
		});
		return void res.json({ success: true });
	} catch (e) {
		log.error("DELETE /contacts/:id failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

export default router;
