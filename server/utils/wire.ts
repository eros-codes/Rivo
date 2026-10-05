// Small conversions for what the server sends: the contract (shared/api.ts)
// says dates are ISO strings and privacy settings are one of three words.
import type { Me, Privacy } from "../../shared/api.ts";
import { PRIVACY } from "../../shared/schemas/account.ts";

/** A date as the wire carries it (a stored date: always present and valid). */
export function iso(d: Date | string): string {
	return (d instanceof Date ? d : new Date(d)).toISOString();
}

/** A date that may be missing (or invalid) as the wire carries it. */
export function isoOrNull(d: Date | string | null | undefined): string | null {
	if (!d) return null;
	const date = d instanceof Date ? d : new Date(d);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A stored privacy setting (the database keeps text; only these three are ever written). */
export function privacyOf(v: string | null | undefined, fallback: Privacy = "everyone"): Privacy {
	return (PRIVACY as readonly string[]).includes(v ?? "") ? (v as Privacy) : fallback;
}

/** What the user record must have for meOf (the rest is optional). */
interface MeFields {
	id: number;
	name: string;
	username: string;
	email: string;
	bio: string | null;
	profilePics: string[] | null;
	privacyOnline: string;
	privacyEmail: string;
	privacyProfile: string;
	isOnline?: boolean;
	lastSeen?: Date | null;
	createdAt?: Date;
}

/** The signed-in user, as GET /api/users/me and the sign-in answer describe them. */
export function meOf(u: MeFields): Me {
	const me: Me = {
		id: u.id,
		name: u.name,
		username: u.username,
		email: u.email,
		bio: u.bio || "",
		profilePics: u.profilePics || [],
		privacyOnline: privacyOf(u.privacyOnline),
		privacyEmail: privacyOf(u.privacyEmail, "contacts"),
		privacyProfile: privacyOf(u.privacyProfile),
	};
	if (u.isOnline !== undefined) me.isOnline = u.isOnline;
	if (u.lastSeen !== undefined) me.lastSeen = isoOrNull(u.lastSeen);
	if (u.createdAt !== undefined) me.createdAt = iso(u.createdAt);
	return me;
}
