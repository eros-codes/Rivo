// Choosing a new password from the emailed link (the same look as sign-in).
import { useRef, useState } from "react";
import { authApi } from "../shared/api/endpoints";
import { ApiError, errorText } from "../shared/api/http";
import { keys, write } from "../shared/lib/storage";
import { PasswordInput } from "../shared/ui/PasswordInput";

const MIN = 8;
const MAX = 128;
const TOKEN_KEY = "rivo.resetToken";

/**
 * The link's token, taken out of the address bar (it should not stay in the
 * history or show on screen); kept for this tab so a reload still works.
 */
function takeToken(): string {
	let token = "";
	try {
		const params = new URLSearchParams(window.location.search);
		token = (params.get("token") || "").trim();
		if (token) {
			sessionStorage.setItem(TOKEN_KEY, token);
			history.replaceState(null, "", window.location.pathname);
		} else token = sessionStorage.getItem(TOKEN_KEY) || "";
	} catch {
		/* storage blocked: the token in memory is enough */
	}
	return token;
}

type Status = { kind: "idle" } | { kind: "error"; text: string } | { kind: "done" } | { kind: "dead"; text: string };

export function ResetApp() {
	const [token] = useState(takeToken);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<Status>(() =>
		token ? { kind: "idle" } : { kind: "dead", text: "This link is not complete. Ask for a new reset link from the sign-in page." },
	);
	const passRef = useRef<HTMLInputElement>(null);
	const confirmRef = useRef<HTMLInputElement>(null);
	const locked = busy || status.kind === "done" || status.kind === "dead";

	const submit = async () => {
		if (locked) return;
		if (password.length < MIN) {
			setStatus({ kind: "error", text: `Password must be at least ${MIN} characters.` });
			return passRef.current?.focus();
		}
		if (password.length > MAX) {
			setStatus({ kind: "error", text: "Password is too long." });
			return passRef.current?.focus();
		}
		if (password !== confirm) {
			setStatus({ kind: "error", text: "Passwords do not match." });
			return confirmRef.current?.focus();
		}
		setBusy(true);
		try {
			await authApi.resetPassword(token, password);
			try {
				sessionStorage.removeItem(TOKEN_KEY);
			} catch {
				/* ignore */
			}
			// every session of the account has ended
			write(keys.user, null);
			setStatus({ kind: "done" });
			window.setTimeout(() => window.location.replace("/auth/?reset=1"), 1500);
		} catch (e) {
			setBusy(false);
			if (e instanceof ApiError && e.status === 400 && /expired/i.test(e.message)) {
				try {
					sessionStorage.removeItem(TOKEN_KEY);
				} catch {
					/* ignore */
				}
				setStatus({ kind: "dead", text: "This link has expired or was already used. Ask for a new one from the sign-in page." });
			} else setStatus({ kind: "error", text: errorText(e, "Something went wrong. Please try again.") });
		}
	};

	const message =
		status.kind === "done" ? (
			<p className="auth-notice" role="status">
				Your password was changed. Taking you to sign in…
			</p>
		) : status.kind === "error" || status.kind === "dead" ? (
			<span className="input-error code-error" id="reset-error" role="alert">
				{status.text}
			</span>
		) : null;

	return (
		<main className="container">
			<div className="circle-top" aria-hidden="true" />
			<form
				className="form password"
				noValidate
				aria-busy={busy || undefined}
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<h1 className="form-title">Set a New Password</h1>
				<p className="form-subtitle">Choose a strong password for your account.</p>
				{message}
				<label htmlFor="new-password" className="form-label">
					New Password
				</label>
				<PasswordInput
					id="new-password"
					name="newPassword"
					inputRef={passRef}
					className="form-input password-input"
					value={password}
					onChange={setPassword}
					autoComplete="new-password"
					placeholder={`${MIN} or more characters`}
					invalid={status.kind === "error"}
					describedBy={status.kind === "error" ? "reset-error" : undefined}
					autoFocus={!!token}
				/>
				<label htmlFor="confirm-password" className="form-label">
					Confirm Password
				</label>
				<PasswordInput
					id="confirm-password"
					name="confirmPassword"
					inputRef={confirmRef}
					className="form-input password-input"
					value={confirm}
					onChange={setConfirm}
					autoComplete="new-password"
					placeholder="Re-enter your password"
				/>
				<button type="submit" className="form-submit" disabled={locked}>
					{busy ? "Saving…" : "Save Password"}
				</button>
				<a className="link-btn loginlink" href="/auth/">
					Back to sign in
				</a>
			</form>
			<div className="circle-bottom" aria-hidden="true" />
		</main>
	);
}
