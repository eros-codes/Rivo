import { Router, type Request, type Response } from "express";
import type { Prisma } from "@prisma/client";
import prisma from "../prisma.ts";
import { config } from "../config.ts";
import { requireAuth } from "../middleware/auth.ts";
import { parseId } from "../utils/validators.ts";
import { applyPrivacy, relationsFor } from "../utils/privacy.ts";
import { decryptBody, isCapsuleLocked, loadReplySenders, previewMessage, serializeMessage } from "../utils/messageView.ts";
import { isMember } from "../services/caches.ts";
import { clearConversation, statusFor } from "../services/messages.ts";
import { RATE_LIMITED, spendBudget } from "../services/actionLimit.ts";
import { log } from "../utils/logger.ts";
import { messageOf } from "../utils/errors.ts";

const router = Router();

const MEMBER_USER_SELECT = {
	id: true,
	name: true,
	username: true,
	profilePics: true,
	isOnline: true,
	lastSeen: true,
	isDeleted: true,
	privacyOnline: true,
	privacyProfile: true,
} satisfies Prisma.UserSelect;

const MESSAGE_INCLUDE = { reactions: { select: { userId: true, emoji: true }, orderBy: { id: "asc" } } } satisfies Prisma.MessageInclude;

type MemberRow = Prisma.ConversationMemberGetPayload<{ include: { user: { select: typeof MEMBER_USER_SELECT } } }>;

/** The conversations with each member's details as the viewer may see them. */
async function sanitizeMembers<C extends { members: MemberRow[] }>(conversations: C[], viewerId: number) {
	const ids = conversations.flatMap((c) => (c.members || []).map((m) => m.user?.id)).filter((id): id is number => Number.isInteger(id));
	const rel = await relationsFor(viewerId, ids);
	return conversations.map((c) => ({
		...c,
		members: (c.members || []).map((m) => ({
			...m,
			user: m.user ? applyPrivacy(m.user, m.user.id === viewerId ? { hasViewer: true, blockedViewer: false } : rel.get(m.user.id)) : m.user,
		})),
	}));
}

/** Which page of a chat: how many messages, older than which one. */
export interface PageParams {
	limit: number;
	before: Date | null;
	beforeId: number | null;
}

/** limit / before / beforeId of a page request, or { error }. */
function pageParams(query: Request["query"]): PageParams | { error: string } {
	const { defaultLimit, maxLimit } = config.pages;
	const limit = Math.min(Math.max(parseId(String(query.limit ?? "")) || defaultLimit, 1), maxLimit);
	let before: Date | null = null;
	if (query.before) {
		before = new Date(String(query.before));
		if (Number.isNaN(before.getTime())) return { error: "Invalid before date" };
	}
	const beforeId = query.beforeId ? parseId(String(query.beforeId)) : null;
	if (query.beforeId && !beforeId) return { error: "Invalid beforeId" };
	return { limit, before, beforeId };
}

/** Messages older than (before, beforeId), newest first then reversed. */
export async function loadPage(convId: number, viewerId: number, { limit, before, beforeId }: PageParams) {
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
	const messages = page.map((m) => {
		try {
			return serializeMessage(m, viewerId, { now, replySenders });
		} catch (e) {
			log.error("serialize failed", m.id, messageOf(e) || e);
			return { id: m.id, conversationId: m.conversationId, senderId: m.senderId, text: "Message unavailable", createdAt: m.createdAt, reactions: [] };
		}
	});
	return { messages, hasMore };
}

async function memberOr403(req: Request, res: Response): Promise<number | null> {
	const convId = parseId(req.params.id);
	if (!convId) {
		res.status(400).json({ error: "Invalid conversation id" });
		return null;
	}
	if (!(await isMember(convId, req.userId))) {
		res.status(403).json({ error: "Forbidden" });
		return null;
	}
	return convId;
}

// ─── List (latest first) ──────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
	try {
		const max = parseInt(process.env.MAX_CONVERSATIONS_TAKE || "100", 10);
		const take = Math.min(Math.max(parseId(String(req.query.take ?? "")) || parseInt(process.env.DEFAULT_CONVERSATIONS_TAKE || "50", 10), 1), max);
		const before = req.query.before ? new Date(String(req.query.before)) : null;
		if (before && Number.isNaN(before.getTime())) return void res.status(400).json({ error: "Invalid before date" });
		const beforeId = req.query.beforeId ? parseId(String(req.query.beforeId)) : null;
		const where: Prisma.ConversationWhereInput = { members: { some: { userId: req.userId } } };
		if (before) where.OR = [{ lastMessageAt: { lt: before } }, { lastMessageAt: before, id: { lt: beforeId || 2147483647 } }];
		const conversations = await prisma.conversation.findMany({
			where,
			take,
			orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
			include: {
				members: { include: { user: { select: MEMBER_USER_SELECT } } },
				messages: { where: { isDeleted: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
			},
		});
		const now = new Date();
		const out = (await sanitizeMembers(conversations, req.userId)).map((c) => ({ ...c, messages: c.messages.map((m) => previewMessage(m, req.userId, now)) }));
		return void res.json(out);
	} catch (e) {
		log.error("GET /conversations failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── A page of messages ───────────────────────────────────────────────────
// { messages (oldest first), hasMore, cursor }: `cursor` is the moment this
// page was read, for /changes later.
router.get("/:id/messages", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		const p = pageParams(req.query);
		if ("error" in p) return void res.status(400).json({ error: p.error });
		const cursor = new Date().toISOString();
		const page = await loadPage(convId, req.userId, p);
		return void res.json({ ...page, cursor });
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
		const since = new Date(String(req.query.since || ""));
		if (Number.isNaN(since.getTime())) return void res.status(400).json({ error: "Invalid since" });
		const cursor = new Date().toISOString();
		const { maxChanges, overlapMs } = config.sync;
		const rows = await prisma.message.findMany({
			where: { conversationId: convId, updatedAt: { gt: new Date(since.getTime() - overlapMs) } },
			orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
			take: maxChanges + 1,
			include: MESSAGE_INCLUDE,
		});
		if (rows.length > maxChanges) return void res.json({ reset: true, messages: [], cursor });
		const replySenders = await loadReplySenders(rows.filter((m) => !m.isDeleted));
		const now = new Date();
		const messages = rows.map((m) => serializeMessage(m, req.userId, { now, replySenders }));
		return void res.json({ reset: false, messages, cursor });
	} catch (e) {
		log.error("GET /conversations/:id/changes failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Pinned messages (oldest first) ───────────────────────────────────────
export async function pinnedOf(convId: number, viewerId: number) {
	const pinned = await prisma.message.findMany({
		where: { conversationId: convId, isPinned: true, isDeleted: false },
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		select: {
			id: true,
			text: true,
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
		createdAt: m.createdAt,
	}));
}

router.get("/:id/pinned", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		return void res.json({ pinned: await pinnedOf(convId, req.userId) });
	} catch (e) {
		log.error("GET /conversations/:id/pinned failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

// ─── Conversation with its newest messages (older clients) ────────────────
router.get("/:id", requireAuth, async (req, res) => {
	try {
		const convId = await memberOr403(req, res);
		if (!convId) return;
		const p = pageParams(req.query);
		if ("error" in p) return void res.status(400).json({ error: p.error });
		const conversation = await prisma.conversation.findUnique({
			where: { id: convId },
			include: { members: { include: { user: { select: MEMBER_USER_SELECT } } } },
		});
		if (!conversation) return void res.status(404).json({ error: "Conversation not found" });
		const [withMembers] = await sanitizeMembers([conversation], req.userId);
		return void res.json({ ...withMembers, messages: (await loadPage(convId, req.userId, p)).messages });
	} catch (e) {
		log.error("GET /conversations/:id failed", e);
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
		let upToId = null;
		if (req.query.upToId !== undefined) {
			upToId = parseId(String(req.query.upToId));
			if (!upToId) return void res.status(400).json({ error: "Invalid upToId" });
		}
		if (!spendBudget(req.userId, 1)) return void res.status(429).json(RATE_LIMITED);
		const result = await clearConversation(req.userId, convId, { upToId });
		if (result.error) return void res.status(statusFor(result)).json({ error: result.error });
		return void res.json({ success: true });
	} catch (e) {
		log.error("DELETE /conversations/:id/messages failed", e);
		return void res.status(500).json({ error: "Server error" });
	}
});

export default router;
