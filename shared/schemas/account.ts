// One's own account: profile, password, deleting it, finding people, signed-in
// devices, notification subscriptions (/api/users, /api/sessions, /api/push).
import { z } from "zod";
import { BIO_MAX_LENGTH, NAME_MAX_LENGTH, NAME_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USER_SEARCH_MAX, USER_SEARCH_MIN } from "../limits.ts";
import { usernameLike } from "./common.ts";

export const PRIVACY = ["everyone", "contacts", "nobody"] as const;
export type Privacy = (typeof PRIVACY)[number];
const privacy = (key: string) => z.enum(PRIVACY, { error: `Invalid value for ${key}` }).optional();

const NAME_ERROR = `Name must be between ${NAME_MIN_LENGTH} and ${NAME_MAX_LENGTH} characters`;

/** What PATCH /api/users/me may change; at least one of them. */
export const UpdateProfile = z
	.object({
		name: z.string({ error: NAME_ERROR }).trim().min(NAME_MIN_LENGTH, { error: NAME_ERROR }).max(NAME_MAX_LENGTH, { error: NAME_ERROR }).optional(),
		username: usernameLike("Username must be 3-30 letters, numbers or underscores").optional(),
		// null or "" clears it
		bio: z
			.string({ error: "Invalid bio" })
			.nullable()
			.optional()
			.transform((v) => (v === undefined ? undefined : (v ?? "").trim()))
			.refine((v) => v === undefined || v.length <= BIO_MAX_LENGTH, { error: `Bio must be ${BIO_MAX_LENGTH} characters or fewer` }),
		privacyOnline: privacy("privacyOnline"),
		privacyEmail: privacy("privacyEmail"),
		privacyProfile: privacy("privacyProfile"),
		// only taking the picture away happens here; uploads go to /me/avatar
		profilePics: z
			.tuple([], { error: "Upload pictures through /me/avatar" })
			.transform((): string[] => [])
			.optional(),
	})
	.refine((p) => Object.values(p).some((v) => v !== undefined), { error: "Nothing to change" });
export type UpdateProfileData = z.output<typeof UpdateProfile>;

export const ChangePassword = z.object({
	currentPassword: z.string({ error: "Missing fields" }).min(1, { error: "Missing fields" }),
	newPassword: z
		.string({ error: "Missing fields" })
		.min(1, { error: "Missing fields" })
		.min(PASSWORD_MIN_LENGTH, { error: `New password must be at least ${PASSWORD_MIN_LENGTH} characters` })
		.max(PASSWORD_MAX_LENGTH, { error: "New password is too long" }),
});

/** Deleting the account asks for the password again. */
export const DeleteAccount = z.object({
	password: z.string({ error: "Password is required" }).min(1, { error: "Password is required" }),
});

/** Finding people by username ("@sara" works too). */
export const SearchUsers = z.object({
	q: z
		.unknown()
		.optional()
		.transform((v) => (typeof v === "string" ? v.trim().replace(/^@/, "") : ""))
		.refine((q) => q.length >= USER_SEARCH_MIN, { error: "Query too short" })
		.refine((q) => q.length <= USER_SEARCH_MAX, { error: "Query too long" }),
});

/** A signed-in device (DELETE /api/sessions/:id). */
export const SessionParam = z.object({
	id: z.string({ error: "Invalid session id" }).regex(/^[A-Za-z0-9_-]{8,64}$/, { error: "Invalid session id" }),
});

/** What a browser gives as its push subscription (the server also checks where `endpoint` points). */
export const PushSubscriptionInput = z.object({
	endpoint: z.string({ error: "Invalid subscription" }).min(1, { error: "Invalid subscription" }).max(2048, { error: "Invalid subscription" }),
	keys: z.object(
		{
			p256dh: z.string({ error: "Invalid subscription" }).max(256, { error: "Invalid subscription" }),
			auth: z.string({ error: "Invalid subscription" }).max(256, { error: "Invalid subscription" }),
		},
		{ error: "Invalid subscription" },
	),
});
export type PushSubscriptionData = z.output<typeof PushSubscriptionInput>;

export const PushUnsubscribe = z.object({
	endpoint: z.string({ error: "Missing endpoint" }).min(1, { error: "Missing endpoint" }),
});
