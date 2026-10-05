// Every HTTP endpoint the clients use, typed.
import { http } from "./http";
import type {
	ChangesResult,
	ContactRow,
	DeviceSession,
	Me,
	MessagePage,
	PinnedItem,
	Privacy,
	SearchHit,
} from "./types";

const q = (params: Record<string, string | number | null | undefined>) => {
	const s = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") s.set(k, String(v));
	const out = s.toString();
	return out ? `?${out}` : "";
};

/** The signed-in user as the login answer describes them. */
export type PublicUser = Me;

export const authApi = {
	login: (identifier: string, password: string) => http.post<{ success: true; user: PublicUser }>("/api/auth/login", { identifier, password }),
	logout: (endpoint: string | null) => http.post<{ success: true }>("/api/auth/logout", endpoint ? { endpoint } : {}),
	/** usernames only: whether an email has an account is never told (see send-code) */
	checkAvailability: (username: string) => http.post<{ usernameTaken: boolean }>("/api/auth/check-availability", { username }),
	sendCode: (email: string) => http.post<{ success: true }>("/api/auth/send-code", { email }),
	verifyCode: (email: string, code: string) => http.post<{ success: true }>("/api/auth/verify-code", { email, code }),
	register: (data: { name: string; email: string; username: string; password: string }) =>
		http.post<{ success: true; userId: number }>("/api/auth/register", data),
	requestPasswordReset: (identifier?: string) =>
		http.post<{ success: true }>("/api/auth/request-password-reset", identifier ? { identifier } : {}),
	resetPassword: (token: string, newPassword: string) =>
		http.post<{ success: true }>("/api/auth/reset-password-with-token", { token, newPassword }),
};

export interface ProfilePatch {
	name?: string;
	username?: string;
	bio?: string;
	profilePics?: [];
	privacyOnline?: Privacy;
	privacyEmail?: Privacy;
	privacyProfile?: Privacy;
}

export const usersApi = {
	me: (signal?: AbortSignal) => http.get<Me>("/api/users/me", { signal }),
	update: (patch: ProfilePatch) => http.patch<Me>("/api/users/me", patch),
	uploadAvatar: (file: Blob) => {
		const form = new FormData();
		form.append("avatar", file, "avatar.jpg");
		return http.post<{ url: string }>("/api/users/me/avatar", form);
	},
	changePassword: (currentPassword: string, newPassword: string) =>
		http.patch<{ success: true; signedOut: number }>("/api/users/me/password", { currentPassword, newPassword }),
	deleteAccount: (password: string) => http.del<{ success: true }>("/api/users/me", { password }),
};

export const sessionsApi = {
	list: () => http.get<{ sessions: DeviceSession[] }>("/api/sessions"),
	revoke: (id: string) => http.del<{ success: true }>(`/api/sessions/${encodeURIComponent(id)}`),
	revokeOthers: () => http.post<{ success: true; revoked: number }>("/api/sessions/revoke-others"),
};

export interface ContactPatch {
	isPinned?: boolean;
	pinOrder?: number | null;
	isMuted?: boolean;
	isBlocked?: boolean;
	isArchived?: boolean;
	nickname?: string | null;
}

export const contactsApi = {
	page: (limit: number, skip: number, signal?: AbortSignal) => http.get<ContactRow[]>(`/api/contacts${q({ limit, skip })}`, { signal }),
	get: (rowId: number) => http.get<ContactRow>(`/api/contacts/${rowId}`),
	add: (username: string, name?: string) => http.post<ContactRow>("/api/contacts", { username, name: name || undefined }),
	update: (rowId: number, patch: ContactPatch) => http.patch<ContactRow>(`/api/contacts/${rowId}`, patch),
	remove: (rowId: number, keepalive = false) => http.del<{ success: true }>(`/api/contacts/${rowId}`, undefined, { keepalive }),
};

export const conversationsApi = {
	page: (convId: number, p: { limit: number; before?: string; beforeId?: number }, signal?: AbortSignal) =>
		http.get<MessagePage>(`/api/conversations/${convId}/messages${q(p)}`, { signal }),
	changes: (convId: number, since: string, signal?: AbortSignal) =>
		http.get<ChangesResult>(`/api/conversations/${convId}/changes${q({ since })}`, { signal }),
	pinned: (convId: number, signal?: AbortSignal) => http.get<{ pinned: PinnedItem[] }>(`/api/conversations/${convId}/pinned`, { signal }),
	/** clears the chat for both people */
	/** clears the chat for both people, up to `upToId` (everything when null) */
	clear: (convId: number, upToId: number | null, keepalive = false) =>
		http.del<{ success: true }>(`/api/conversations/${convId}/messages${upToId ? `?upToId=${upToId}` : ""}`, undefined, { keepalive }),
};

export const messagesApi = {
	search: (text: string, signal?: AbortSignal) =>
		http.get<{ results: SearchHit[]; truncated: boolean }>(`/api/messages/search${q({ q: text })}`, { signal }),
	deleteMany: (messageIds: number[], keepalive = false) =>
		http.post<{ success: true; deleted: number[] }>("/api/messages/delete", { messageIds }, { keepalive }),
};

export const pushApi = {
	publicKey: () => http.get<{ publicKey: string }>("/api/push/publicKey"),
	subscribe: (sub: PushSubscriptionJSON) => http.post<{ success: true }>("/api/push/subscribe", sub),
	unsubscribe: (endpoint: string) => http.post<{ success: true }>("/api/push/unsubscribe", { endpoint }),
};
