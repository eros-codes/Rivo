import { Router, type Request } from "express";
import type { Prisma } from "@prisma/client";
import prisma from "../prisma.ts";
import { config } from "../config.ts";
import { requireAuth } from "../middleware/auth.ts";
import { AddContact, ContactParam, contactsPage, UpdateContact } from "../../shared/schemas/contacts.ts";
import { parse } from "../http/validate.ts";
import { reply } from "../http/reply.ts";
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
const ContactsPage = contactsPage(config.pages.contactsDefault, config.pages.contactsMax);

router.get("/", requireAuth, async (req, res) => {
	const page = parse(res, ContactsPage, req.query);
	if (!page) return;
	const { limit, skip } = page;
	try {
		if (skip === 0) await ensureSavedContact(req.userId);
		const rows = await prisma.contact.findMany({
			where: { ownerId: req.userId },
			include: CONTACT_INCLUDE,
			orderBy: CONTACT_ORDER,
			take: limit,
			skip,
		});
		return void reply(res, "GET /api/contacts", await serializeContacts(rows, req.userId));
	} catch (e) {
		log.error("GET /contacts failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

router.get("/:id", requireAuth, async (req, res) => {
	const params = parse(res, ContactParam, req.params);
	if (!params) return;
	const { id } = params;
	try {
		const row = await contactRowFor(req.userId, id);
		if (!row) return void res.status(404).json({ error: "Contact not found" });
		return void reply(res, "GET /api/contacts/:id", row);
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
	const body = parse(res, AddContact, req.body);
	if (!body) return;
	const { username } = body;
	const nickname = body.name ?? null;

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
			return void reply(res, "POST /api/contacts", row);
		}
		// (set above whenever no existing row was adopted)
		if (!created) throw new Error("contact row not created");
		// the other person's list gets its new row in any case
		if (theirRowId) await emitContactUpsert(target.id, theirRowId);
		const row = await contactRowFor(req.userId, created.id);
		// (removed again by another request in the meantime)
		if (!row) return void res.status(404).json({ error: "Contact not found" });
		// this user's other devices
		emitToUser(req.userId, "contact:upsert", row, { exceptSocketId: actingSocket(req) });
		return void reply(res, "POST /api/contacts", row, 201);
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
	const params = parse(res, ContactParam, req.params);
	if (!params) return;
	const { id } = params;
	const body = parse(res, UpdateContact, req.body);
	if (!body) return;
	// what was not sent is undefined (Prisma leaves it); "" or null took the
	// nickname away; naming someone makes them one of this user's contacts
	const data: Prisma.ContactUncheckedUpdateInput = { ...body, ...(body.nickname ? { addedByOwner: true } : {}) };

	try {
		const contact = await prisma.contact.findFirst({ where: { id, ownerId: req.userId }, select: { id: true, conversationId: true, isSaved: true } });
		if (!contact) return void res.status(404).json({ error: "Contact not found" });
		// Saved Messages can be pinned or muted, nothing else
		if (contact.isSaved && (body.isBlocked !== undefined || body.isArchived !== undefined || body.nickname !== undefined)) {
			return void res.status(400).json({ error: "Saved Messages cannot be changed this way" });
		}
		await prisma.contact.update({ where: { id }, data });
		// mute and block decide who gets messages and notifications
		invalidateConversation(contact.conversationId);
		const row = await contactRowFor(req.userId, id);
		// (removed by another request in the meantime)
		if (!row) return void res.status(404).json({ error: "Contact not found" });
		emitToUser(req.userId, "contact:upsert", row, { exceptSocketId: actingSocket(req) });
		return void reply(res, "PATCH /api/contacts/:id", row);
	} catch (e) {
		log.error("PATCH /contacts/:id failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Remove ───────────────────────────────────────────────────────────────
// Only this user's own row goes; the other person keeps theirs (and the chat).
router.delete("/:id", requireAuth, async (req, res) => {
	const params = parse(res, ContactParam, req.params);
	if (!params) return;
	const { id } = params;
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
		return void reply(res, "DELETE /api/contacts/:id", { success: true });
	} catch (e) {
		log.error("DELETE /contacts/:id failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

export default router;
