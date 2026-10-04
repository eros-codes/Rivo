import { Router } from "express";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { parseIntSafe } from "../utils/validators.js";
import { decryptBody, isCapsuleLocked, loadReplySenders, serializeMessage } from "../utils/messageView.js";
import { sendMessageAs, editMessageAs, deleteMessageAs, togglePinAs } from "../socket/index.js";

const router = Router();

// Errors returned by the shared message actions → HTTP status codes
function statusFor(result) {
	const e = String(result && result.error || "");
	if (!e) return 200;
	if (e === "Server error") return 500;
	if (e === "Not found" || e === "Message not found") return 404;
	if (e === "Forbidden" || e === "Message could not be delivered" || e === "Unblock this contact to send messages") return 403;
	if (e === "This account no longer exists") return 410;
	return 400;
}

// Searching decrypts many messages on the server, so each user gets a
// limited number of searches per minute (typing already waits between keys).
const SEARCH_WINDOW_MS = 60 * 1000;
const SEARCH_MAX_PER_WINDOW = parseInt(process.env.SEARCH_MAX_PER_MINUTE || "40", 10) || 40;
const _searchLog = new Map(); // userId => timestamps
function _searchAllowed(userId) {
	const now = Date.now();
	const recent = (_searchLog.get(userId) || []).filter((t) => now - t < SEARCH_WINDOW_MS);
	if (recent.length >= SEARCH_MAX_PER_WINDOW) {
		_searchLog.set(userId, recent);
		return false;
	}
	recent.push(now);
	_searchLog.set(userId, recent);
	return true;
}
setInterval(() => {
	const now = Date.now();
	for (const [uid, times] of _searchLog) {
		if (!times.some((t) => now - t < SEARCH_WINDOW_MS)) _searchLog.delete(uid);
	}
}, SEARCH_WINDOW_MS).unref?.();

// ─── Search messages ───────────────────────────────────────────────────────
router.get("/search", requireAuth, async (req, res) => {
	const q = String(req.query.q || "").trim().toLowerCase();
	if (!q || q.length < 2) {
		return res.json({ results: [] });
	}
	if (q.length > 100) {
		return res.status(400).json({ error: "Query too long" });
	}
	if (!_searchAllowed(req.userId)) {
		return res.status(429).json({ error: "Too many searches. Please wait a moment." });
	}

	const MAX_RESULTS = 50;
	const BATCH = 1000;
	const MAX_SCAN = parseInt(process.env.SEARCH_MAX_SCAN || "5000", 10) || 5000;

	try {
		// Only chats this user still has in their list
		const rows = await prisma.contact.findMany({
			where: { ownerId: req.userId },
			select: { conversationId: true },
		});
		const convIds = [...new Set(rows.map((r) => r.conversationId))];
		if (convIds.length === 0) return res.json({ results: [] });

		const results = [];
		const now = new Date();
		let scanned = 0;
		let cursor = null;
		// Messages are encrypted, so they are decrypted and matched here,
		// newest first, in batches.
		while (results.length < MAX_RESULTS && scanned < MAX_SCAN) {
			const batch = await prisma.message.findMany({
				where: {
					conversationId: { in: convIds },
					isDeleted: false,
					...(cursor ? { id: { lt: cursor } } : {}),
				},
				orderBy: { id: "desc" },
				take: BATCH,
				select: {
					id: true,
					conversationId: true,
					senderId: true,
					text: true,
					ciphertext: true,
					iv: true,
					auth_tag: true,
					wrapped_dek: true,
					key_id: true,
					createdAt: true,
					isEdited: true,
					isPinned: true,
					isSeen: true,
					isOneTime: true,
					isTimeCapsule: true,
					scheduledFor: true,
					openedAt: true,
				},
			});
			if (batch.length === 0) break;
			scanned += batch.length;
			cursor = batch[batch.length - 1].id;

			for (const m of batch) {
				if (results.length >= MAX_RESULTS) break;
				const isSender = m.senderId === req.userId;
				// locked time capsules and other people's one-time messages stay hidden
				if (isCapsuleLocked(m, now) && !isSender) continue;
				if (m.isOneTime && !isSender) continue;

				const body = decryptBody(m);
				if (!body.ok) continue;
				if (!body.text.toLowerCase().includes(q)) continue;

				results.push({
					id: m.id,
					messageId: m.id,
					conversationId: m.conversationId,
					senderId: m.senderId,
					text: body.text,
					createdAt: m.createdAt,
					isEdited: m.isEdited,
					isPinned: m.isPinned,
					isSeen: m.isSeen,
					isOneTime: m.isOneTime,
					isTimeCapsule: m.isTimeCapsule,
					isLocked: false,
					scheduledFor: m.scheduledFor ? m.scheduledFor.toISOString() : null,
					openedAt: m.openedAt ? m.openedAt.toISOString() : null,
				});
			}
			if (batch.length < BATCH) break;
		}

		return res.json({ results, truncated: scanned >= MAX_SCAN });
	} catch (err) {
		console.error("Search error:", err);
		return res.status(500).json({ error: "Search failed" });
	}
});

// ─── Get pinned messages for a conversation ──────────────────────────────────
router.get('/:conversationId/pinned', requireAuth, async (req, res) => {
	const convId = parseIntSafe(req.params.conversationId);
	if (!convId) return res.status(400).json({ error: 'Invalid conversationId' });
	const userId = req.userId;

	try {
		const member = await prisma.conversationMember.findFirst({
			where: { conversationId: convId, userId },
		});
		if (!member) return res.status(403).json({ error: 'Not a member' });

		const pinned = await prisma.message.findMany({
			where: { conversationId: convId, isPinned: true, isDeleted: false },
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
		const results = pinned.map((m) => {
			const hidden = isCapsuleLocked(m, now) && m.senderId !== req.userId;
			return {
				id: m.id,
				text: hidden ? null : decryptBody(m).text,
				senderId: m.senderId,
				createdAt: m.createdAt,
			};
		});

		return res.json({ pinned: results });
	} catch (err) {
		console.error('pinned messages error', err);
		return res.status(500).json({ error: 'Server error' });
	}
});

// ─── Get messages of a conversation ──────────────────────────────────────────
router.get("/:conversationId", requireAuth, async (req, res) => {
	const conversationId = parseIntSafe(req.params.conversationId);
	if (!conversationId) return res.status(400).json({ error: "Invalid conversationId" });
	// pagination params
	const MAX_FETCH_LIMIT = parseInt(process.env.MAX_FETCH_LIMIT || "100", 10);
	const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_FETCH_LIMIT || "50", 10);
	let limit = parseInt(req.query.limit, 10) || DEFAULT_LIMIT;
	if (limit < 1) limit = 1;
	if (limit > MAX_FETCH_LIMIT) limit = MAX_FETCH_LIMIT;
	const before = req.query.before ? (() => {
		const d = new Date(req.query.before);
		return isNaN(d.getTime()) ? null : d;
	})() : null;
	if (req.query.before && !before) {
		return res.status(400).json({ error: 'Invalid before date' });
	}
	const beforeId = req.query.beforeId ? parseIntSafe(req.query.beforeId) : null;

	try {
		// check that user is member of this conversation
		const member = await prisma.conversationMember.findFirst({
			where: {
				conversationId,
				userId: req.userId,
			},
		});

		if (!member) {
			return res.status(403).json({ error: "Forbidden" });
		}

		// Build a where clause that supports a createdAt + id tie-breaker so
		// ordering is deterministic when multiple messages share the same timestamp.
		let where = {
			conversationId,
			isDeleted: false,
		};

		if (before && beforeId) {
			where = {
				...where,
				AND: [
					{
						OR: [
							{ createdAt: { lt: before } },
							{
								AND: [
									{ createdAt: before },
									{ id: { lt: beforeId } },
								],
							},
						],
					},
				],
			};
		} else if (before) {
			where = { ...where, createdAt: { lt: before } };
		}

		// fetch newest messages first then reverse so client receives ascending order
		const msgs = await prisma.message.findMany({
			where,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: limit,
			include: {
				sender: {
					select: {
						id: true,
						name: true,
						username: true,
					},
				},
				reactions: {
					select: { userId: true, emoji: true },
				},
			},
		});

		const reversed = msgs.reverse();
		const replySenders = await loadReplySenders(reversed);
		const now = new Date();
		const out = reversed.map((m) => {
			try {
				return serializeMessage(m, req.userId, { now, replySenders });
			} catch (err) {
				console.error(err);
				return { id: m.id, conversationId: m.conversationId, senderId: m.senderId, text: "Message unavailable", createdAt: m.createdAt, reactions: [] };
			}
		});

		return res.json(out);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ error: "Server error" });
	}
});

// ─── Send message ─────────────────────────────────────────────────────────────
// Same rules and real-time delivery as sending over the socket.
router.post("/", requireAuth, async (req, res) => {
	const result = await sendMessageAs({ userId: req.userId, socketId: null }, req.body || {});
	if (result.error) return res.status(statusFor(result)).json({ error: result.error });
	return res.status(201).json(result.message);
});

// ─── Edit message ─────────────────────────────────────────────────────────────
router.patch("/:id", requireAuth, async (req, res) => {
	const result = await editMessageAs({ userId: req.userId, socketId: null }, { messageId: req.params.id, text: (req.body || {}).text });
	if (result.error) return res.status(statusFor(result)).json({ error: result.error });
	return res.json({ success: true });
});

// ─── Delete message ───────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res) => {
	const result = await deleteMessageAs({ userId: req.userId, socketId: null }, { messageId: req.params.id });
	if (result.error) return res.status(statusFor(result)).json({ error: result.error });
	return res.json({ success: true });
});

// ─── Pin message ──────────────────────────────────────────────────────────────
router.post("/:id/pin", requireAuth, async (req, res) => {
	const result = await togglePinAs({ userId: req.userId, socketId: null }, { messageId: req.params.id });
	if (result.error) return res.status(statusFor(result)).json({ error: result.error });
	return res.json({ isPinned: result.isPinned });
});

export default router;
