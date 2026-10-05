// Every HTTP endpoint the clients use, typed by the contract in shared/api.ts
// (the server's routes are checked against the same entries): what each one
// takes is Body<"METHOD /path">, what it answers Answer<"METHOD /path">.
import { http } from "./http";
import type { Answer, Body, Me } from "./types";

const q = (params: Record<string, string | number | null | undefined>) => {
	const s = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") s.set(k, String(v));
	const out = s.toString();
	return out ? `?${out}` : "";
};

/** The signed-in user as the login answer describes them. */
export type PublicUser = Me;

export const authApi = {
	login: (identifier: string, password: string) =>
		http.post<Answer<"POST /api/auth/login">>("/api/auth/login", { identifier, password } satisfies Body<"POST /api/auth/login">),
	logout: (endpoint: string | null) =>
		http.post<Answer<"POST /api/auth/logout">>("/api/auth/logout", (endpoint ? { endpoint } : {}) satisfies Body<"POST /api/auth/logout">),
	/** usernames only: whether an email has an account is never told (see send-code) */
	checkAvailability: (username: string) =>
		http.post<Answer<"POST /api/auth/check-availability">>("/api/auth/check-availability", { username } satisfies Body<"POST /api/auth/check-availability">),
	sendCode: (email: string) => http.post<Answer<"POST /api/auth/send-code">>("/api/auth/send-code", { email } satisfies Body<"POST /api/auth/send-code">),
	verifyCode: (email: string, code: string) =>
		http.post<Answer<"POST /api/auth/verify-code">>("/api/auth/verify-code", { email, code } satisfies Body<"POST /api/auth/verify-code">),
	register: (data: Body<"POST /api/auth/register">) => http.post<Answer<"POST /api/auth/register">>("/api/auth/register", data),
	requestPasswordReset: (identifier?: string) =>
		http.post<Answer<"POST /api/auth/request-password-reset">>(
			"/api/auth/request-password-reset",
			(identifier ? { identifier } : {}) satisfies Body<"POST /api/auth/request-password-reset">,
		),
	resetPassword: (token: string, newPassword: string) =>
		http.post<Answer<"POST /api/auth/reset-password-with-token">>(
			"/api/auth/reset-password-with-token",
			{ token, newPassword } satisfies Body<"POST /api/auth/reset-password-with-token">,
		),
};

/** What can be changed of one's profile (all optional). */
export type ProfilePatch = Body<"PATCH /api/users/me">;

export const usersApi = {
	me: (signal?: AbortSignal) => http.get<Answer<"GET /api/users/me">>("/api/users/me", { signal }),
	update: (patch: ProfilePatch) => http.patch<Answer<"PATCH /api/users/me">>("/api/users/me", patch),
	uploadAvatar: (file: Blob) => {
		const form = new FormData();
		form.append("avatar", file, "avatar.jpg");
		return http.post<Answer<"POST /api/users/me/avatar">>("/api/users/me/avatar", form);
	},
	changePassword: (currentPassword: string, newPassword: string) =>
		http.patch<Answer<"PATCH /api/users/me/password">>("/api/users/me/password", { currentPassword, newPassword } satisfies Body<"PATCH /api/users/me/password">),
	deleteAccount: (password: string) => http.del<Answer<"DELETE /api/users/me">>("/api/users/me", { password } satisfies Body<"DELETE /api/users/me">),
};

export const sessionsApi = {
	list: () => http.get<Answer<"GET /api/sessions">>("/api/sessions"),
	revoke: (id: string) => http.del<Answer<"DELETE /api/sessions/:id">>(`/api/sessions/${encodeURIComponent(id)}`),
	revokeOthers: () => http.post<Answer<"POST /api/sessions/revoke-others">>("/api/sessions/revoke-others"),
};

/** What can be changed of a contact row (all optional). */
export type ContactPatch = Body<"PATCH /api/contacts/:id">;

export const contactsApi = {
	page: (limit: number, skip: number, signal?: AbortSignal) => http.get<Answer<"GET /api/contacts">>(`/api/contacts${q({ limit, skip })}`, { signal }),
	get: (rowId: number) => http.get<Answer<"GET /api/contacts/:id">>(`/api/contacts/${rowId}`),
	add: (username: string, name?: string) =>
		http.post<Answer<"POST /api/contacts">>("/api/contacts", { username, name: name || undefined } satisfies Body<"POST /api/contacts">),
	update: (rowId: number, patch: ContactPatch) => http.patch<Answer<"PATCH /api/contacts/:id">>(`/api/contacts/${rowId}`, patch),
	remove: (rowId: number, keepalive = false) => http.del<Answer<"DELETE /api/contacts/:id">>(`/api/contacts/${rowId}`, undefined, { keepalive }),
};

export const conversationsApi = {
	page: (convId: number, p: { limit: number; before?: string; beforeId?: number }, signal?: AbortSignal) =>
		http.get<Answer<"GET /api/conversations/:id/messages">>(`/api/conversations/${convId}/messages${q(p)}`, { signal }),
	changes: (convId: number, since: string, signal?: AbortSignal) =>
		http.get<Answer<"GET /api/conversations/:id/changes">>(`/api/conversations/${convId}/changes${q({ since })}`, { signal }),
	pinned: (convId: number, signal?: AbortSignal) => http.get<Answer<"GET /api/conversations/:id/pinned">>(`/api/conversations/${convId}/pinned`, { signal }),
	/** clears the chat for both people, up to `upToId` (everything when null) */
	clear: (convId: number, upToId: number | null, keepalive = false) =>
		http.del<Answer<"DELETE /api/conversations/:id/messages">>(`/api/conversations/${convId}/messages${upToId ? `?upToId=${upToId}` : ""}`, undefined, { keepalive }),
};

export const messagesApi = {
	search: (text: string, signal?: AbortSignal) => http.get<Answer<"GET /api/messages/search">>(`/api/messages/search${q({ q: text })}`, { signal }),
	deleteMany: (messageIds: number[], keepalive = false) =>
		http.post<Answer<"POST /api/messages/delete">>("/api/messages/delete", { messageIds } satisfies Body<"POST /api/messages/delete">, { keepalive }),
};

export const pushApi = {
	publicKey: () => http.get<Answer<"GET /api/push/publicKey">>("/api/push/publicKey"),
	subscribe: (sub: PushSubscriptionJSON) => http.post<Answer<"POST /api/push/subscribe">>("/api/push/subscribe", sub),
	unsubscribe: (endpoint: string) => http.post<Answer<"POST /api/push/unsubscribe">>("/api/push/unsubscribe", { endpoint } satisfies Body<"POST /api/push/unsubscribe">),
};
