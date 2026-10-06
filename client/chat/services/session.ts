// Who is signed in, and leaving: logging out, or the session ending
// elsewhere (signed out from another device, password changed).
import { authApi, usersApi } from "../../shared/api/endpoints";
import { ApiError } from "../../shared/api/http";
import type { Me } from "../../shared/api/types";
import { keys, readJson, write, writeJson } from "../../shared/lib/storage";
import { session } from "../state/stores";
import { clearPersistedOutbox } from "./outboxStore";
import { currentEndpoint, disablePush, withTimeout } from "./push";
import * as realtime from "./realtime";

export const SIGN_IN_PAGE = "/auth/";

function isMe(v: unknown): v is Me {
	return !!v && typeof v === "object" && typeof (v as Me).id === "number" && typeof (v as Me).username === "string";
}

/** The copy of the user kept on this device for an instant first paint. */
export function cachedMe(): Me | null {
	const me = readJson(keys.user, isMe);
	if (!me) return null;
	return {
		id: me.id,
		name: me.name || "",
		username: me.username,
		email: me.email || "",
		bio: me.bio || "",
		profilePics: Array.isArray(me.profilePics) ? me.profilePics : [],
		privacyOnline: me.privacyOnline || "everyone",
		privacyEmail: me.privacyEmail || "everyone",
		privacyProfile: me.privacyProfile || "everyone",
	};
}

export function setMe(me: Me): void {
	session.set({ me });
	writeJson(keys.user, {
		id: me.id,
		name: me.name,
		username: me.username,
		// (the email is not kept on the device)
		bio: me.bio,
		profilePics: me.profilePics,
		privacyOnline: me.privacyOnline,
		privacyEmail: me.privacyEmail,
		privacyProfile: me.privacyProfile,
	});
}

export function patchMe(patch: Partial<Me>): void {
	const me = session.get().me;
	if (me) setMe({ ...me, ...patch });
}

export function meId(): number | null {
	return session.get().me?.id ?? null;
}

let finishing: Promise<void> | null = null;

/**
 * Ends the account's time on this device: the live connection closed, its
 * notifications off, everything of it forgotten, the sign-in page opened.
 * Once, however many ways the end is noticed: a logout also reaches this
 * device as "session:ended" over the live connection, often before the
 * logout's own answer, and two page loads one after the other would cut the
 * first one off.
 */
function finish(): Promise<void> {
	finishing ??= (async () => {
		realtime.disconnect();
		// (the server already dropped this device's notifications with the session)
		await withTimeout(disablePush(false), 2000, undefined);
		const uid = meId();
		write(keys.user, null);
		if (uid !== null) clearPersistedOutbox(uid);
		window.location.replace(SIGN_IN_PAGE);
	})();
	return finishing;
}

/**
 * The server stopped accepting this device. When `certain` is false (a
 * refused connection), the session is checked first: it may be fine.
 */
export async function sessionEnded(certain: boolean): Promise<void> {
	if (finishing) return;
	if (!certain) {
		try {
			await usersApi.me();
			realtime.retrySoon();
			return;
		} catch (e) {
			if (!(e instanceof ApiError) || e.status !== 401) {
				realtime.retrySoon();
				return;
			}
		}
	}
	await finish();
}

let loggingOut = false;

/** Logs out this device. Throws when the server could not be reached (nothing changed). */
export async function logout(): Promise<void> {
	if (loggingOut) return;
	loggingOut = true;
	try {
		const endpoint = await withTimeout(currentEndpoint(), 1500, null);
		// the session cookie is HttpOnly: only the server can end it
		await authApi.logout(endpoint);
	} catch (e) {
		loggingOut = false;
		throw e;
	}
	await finish();
}

/** After the account was deleted. */
export function accountDeleted(): Promise<void> {
	return finish();
}
