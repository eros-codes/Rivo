// One budget of actions per user (send, forward, edit, delete, pin, react,
// join), shared by the socket and the REST routes: the same action costs the
// same whichever way it arrives, so neither can be used to get around it.
import { config } from "../config.js";

const spent = new Map(); // userId → [{ t, cost }] within the window

/** Takes `cost` from the user's budget; false (and nothing taken) when it would run over. */
export function spendBudget(userId, cost = 1) {
	const { windowMs, max } = config.rate.socket;
	const now = Date.now();
	const list = (spent.get(userId) || []).filter((e) => e.t > now - windowMs);
	const used = list.reduce((sum, e) => sum + e.cost, 0);
	if (used + cost > max) {
		spent.set(userId, list);
		return false;
	}
	list.push({ t: now, cost });
	spent.set(userId, list);
	return true;
}

/** Cost of an action on several messages at once (`per` of them cost one). */
export function batchCost(count, per) {
	const n = Number.isInteger(count) && count > 0 ? count : 1;
	return Math.max(1, Math.ceil(n / per));
}

export const RATE_LIMITED = { error: "Rate limit exceeded" };

setInterval(() => {
	const now = Date.now();
	const { windowMs } = config.rate.socket;
	for (const [uid, list] of spent) {
		const recent = list.filter((e) => now - e.t < windowMs);
		if (recent.length) spent.set(uid, recent);
		else spent.delete(uid);
	}
}, 30_000).unref?.();
