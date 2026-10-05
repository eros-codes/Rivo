// Signing up, signing in and getting back in (/api/auth/…).
import { z } from "zod";
import { CODE_LENGTH, isEmail, NAME_MAX_LENGTH, NAME_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USERNAME_PATTERN } from "../limits.ts";

const EMAIL_ERROR = "Please enter a valid email address";
/** An email address, trimmed (its case is kept: it is how the person wrote it). */
export const email = (error = EMAIL_ERROR) =>
	z
		.string({ error })
		.refine(isEmail, { error })
		.transform((v) => v.trim());

export const SendCode = z.object({ email: email() });

/** The emailed code: six digits (a number is accepted too). */
export const VerifyCode = z.object({
	email: email("Invalid or expired code"),
	code: z
		.union([z.string(), z.number()], { error: "Invalid or expired code" })
		.transform((c) => String(c).trim())
		.refine((c) => new RegExp(`^\\d{${CODE_LENGTH}}$`).test(c), { error: "Invalid or expired code" }),
});

/** Whether a username is free; anything that is not a username is simply "free" (the route reads a bad body as no username). */
export const CheckAvailability = z.object({
	username: z
		.string()
		.optional()
		.transform((v) => (v !== undefined && USERNAME_PATTERN.test(v.trim()) ? v.trim() : null)),
});

const required = "All fields are required";
/** A form field: missing or empty is "required", something that is not text "Invalid fields". */
const field = () =>
	z.string({ error: (issue) => (issue.input === undefined || issue.input === null || issue.input === "" ? required : "Invalid fields") });

export const Register = z.object({
	name: field()
		.min(1, { error: required })
		.trim()
		.min(NAME_MIN_LENGTH, { error: `Name must be between ${NAME_MIN_LENGTH} and ${NAME_MAX_LENGTH} characters` })
		.max(NAME_MAX_LENGTH, { error: `Name must be between ${NAME_MIN_LENGTH} and ${NAME_MAX_LENGTH} characters` }),
	email: field().min(1, { error: required }).pipe(email()),
	username: field()
		.min(1, { error: required })
		.trim()
		.regex(USERNAME_PATTERN, { error: "Username must be 3-30 letters, numbers or underscores" }),
	password: field()
		.min(1, { error: required })
		.min(PASSWORD_MIN_LENGTH, { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` })
		.max(PASSWORD_MAX_LENGTH, { error: "Password is too long" }),
});

export const Login = z.object({
	identifier: field().min(1, { error: required }),
	password: field().min(1, { error: required }),
});

/** Signing out: this device's push address, so its notifications stop too (a bad one is ignored by the route). */
export const Logout = z.object({
	endpoint: z
		.string()
		.nullish()
		.transform((v) => v || null),
});

/** "Forgot password" from the sign-in page names the account; signed in, nothing is needed. */
export const RequestPasswordReset = z.object({
	identifier: z
		.string()
		.optional()
		.transform((v) => (v ?? "").trim()),
});

export const ResetPassword = z
	.object({
		token: z.string({ error: "Missing or invalid fields" }).min(1, { error: "Missing or invalid fields" }),
		newPassword: z.string({ error: "Missing or invalid fields" }).min(PASSWORD_MIN_LENGTH, { error: "Missing or invalid fields" }),
	})
	.refine((f) => f.newPassword.length <= PASSWORD_MAX_LENGTH, { error: "Password is too long" });
