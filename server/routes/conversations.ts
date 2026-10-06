import { Router, type Request, type Response } from "express";
import type { Prisma } from "@prisma/client";
import prisma from "../prisma.ts";
import { config } from "../config.ts";
import { requireAuth } from "../middleware/auth.ts";
import { ChangesSince, ClearChat, ConversationIdParam, messagesPage, type PageQuery } from "../../shared/schemas/conversations.ts";
import { check, parse } from "../http/validate.ts";
import { decryptBody, isCapsuleLocked, loadReplySenders, serializeMessage, unavailableMessage } from "../utils/messageView.ts";
import { isMember } from "../services/caches.ts";
import { clearConversation, statusFor } from "../services/messages.ts";
import { RATE_LIMITED, spendBudget } from "../services/actionLimit.ts";
import { log } from "../utils/logger.ts";
import { messageOf } from "../utils/errors.ts";
import { iso } from "../utils/wire.ts";
import type { PinnedItem, WireMessage } from "../../shared/api.ts";
import { reply } from "../http/reply.ts";

const router = Router();

const MESSAGE_INCLUDE = { reactions: { select: { userId: true, emoji: true }, orderBy: { id: "asc" } } } satisfies Prisma.MessageInclude;

/** Which page of a chat: how many messages, older than which one. */
const MessagesPage = messagesPage(config.pages.defaultLimit, config.pages.maxLimit);

/** Messages older than (before, beforeId), newest first then reversed. */
async function loadPage(convId: number, viewerId: number, { limit, before, beforeId }: PageQuery): Promise<{ messages: WireMessage[]; hasMore: boolean }> {
	const where: Prisma.MessageWhereInput = { conversationId: convId, isDeleted: false };
	if (before && beforeId) where.OR = [{ createdAt: { lt: before } }, { createdAt: before, id: { lt: beforeId } }];
	else if (before) where.createdAt = { lt: before };
	const rows = await prisma.message.findMany({
		where,
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: limit + 1,
		include: MESSAGE_INCLUDE,
	});
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit).reverse();
	const replySenders = await loadReplySenders(page);
	const now = new Date();
	const messages = page.map((m): WireMessage => {
		try {
			return serializeMessage(m, viewerId, { now, replySenders });
		} catch (e) {
			// one broken row must not take the page down with it
			log.error("serialize failed", m.id, messageOf(e) || e);
			return unavailableMessage(m);
		}
	});
	return { messages, hasMore };
}

async function memberOr403(req: Request, res: Response): Promise<number | null> {
	const params = check(ConversationIdParam, req.params);
	if (!params.ok) {
		res.status(400).json({ error: params.error });
		return null;
	}
	const convId = params.data.id;
	if (!(await isMember(convId, req.userId))) {
		res.status(403).json({ error: "Forbidden" });
		return null;
	}
	return convId;
}

// ─── A page of messages ───────────────────────────────────────────────────
// { messages (oldest first), hasMore, cursor }: `cursor` is the moment this
// page was read, for /changes later.
router.get("/:id/messages", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		const p = parse(res, MessagesPage, req.query);
		if (!p) return;
		const cursor = new Date().toISOString();
		const page = await loadPage(convId, req.userId, p);
		return void reply(res, "GET /api/conversations/:id/messages", { ...page, cursor });
	} catch (e) {
		log.error("GET /conversations/:id/messages failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Changes since a moment ───────────────────────────────────────────────
// Every message created or changed after `since` (deleted ones as
// tombstones), oldest change first. Looked up a little earlier than `since`
// so a write that was in flight when the cursor was taken is not missed; the
// client applies changes idempotently. Too many changes → { reset: true }
// and the client loads the chat again.
router.get("/:id/changes", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		const query = parse(res, ChangesSince, req.query);
		if (!query) return;
		const { since } = query;
		const cursor = new Date().toISOString();
		const { maxChanges, overlapMs } = config.sync;
		const rows = await prisma.message.findMany({
			where: { conversationId: convId, updatedAt: { gt: new Date(since.getTime() - overlapMs) } },
			orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
			take: maxChanges + 1,
			include: MESSAGE_INCLUDE,
		});
		if (rows.length > maxChanges) return void reply(res, "GET /api/conversations/:id/changes", { reset: true, messages: [], cursor });
		const replySenders = await loadReplySenders(rows.filter((m) => !m.isDeleted));
		const now = new Date();
		const messages = rows.map((m) => serializeMessage(m, req.userId, { now, replySenders }));
		return void reply(res, "GET /api/conversations/:id/changes", { reset: false, messages, cursor });
	} catch (e) {
		log.error("GET /conversations/:id/changes failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Pinned messages (oldest first) ───────────────────────────────────────
async function pinnedOf(convId: number, viewerId: number): Promise<PinnedItem[]> {
	const pinned = await prisma.message.findMany({
		where: { conversationId: convId, isPinned: true, isDeleted: false },
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		select: {
			id: true,
			ciphertext: true,
			iv: true,
			auth_tag: true,
			wrapped_dek: true,
			key_id: true,
			senderId: true,
			createdAt: true,
			isTimeCapsule: true,
			scheduledFor: true,
			openedAt: true,
		},
	});
	const now = new Date();
	return pinned.map((m) => ({
		id: m.id,
		text: isCapsuleLocked(m, now) && m.senderId !== viewerId ? null : decryptBody(m).text,
		senderId: m.senderId,
		createdAt: iso(m.createdAt),
	}));
}

router.get("/:id/pinned", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		return void reply(res, "GET /api/conversations/:id/pinned", { pinned: await pinnedOf(convId, req.userId) });
	} catch (e) {
		log.error("GET /conversations/:id/pinned failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Clear the chat (for both people) ─────────────────────────────────────
// `upToId`: the newest message the user saw when they chose to delete. Ones
// that arrived during the Undo window are not theirs to delete unseen.
router.delete("/:id/messages", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		const query = parse(res, ClearChat, req.query);
		if (!query) return;
		const { upToId } = query;
		if (!spendBudget(req.userId, 1)) return void res.status(429).json(RATE_LIMITED);
		const result = await clearConversation(req.userId, convId, { upToId });
		if ("error" in result) return void res.status(statusFor(result)).json({ error: result.error });
		return void reply(res, "DELETE /api/conversations/:id/messages", { success: true });
	} catch (e) {
		log.error("DELETE /conversations/:id/messages failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

export default router;
