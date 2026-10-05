// Signing in, signing up (name, email and username → a code sent to the
// email → a password) and asking for a password reset link.
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { authApi, type PublicUser } from "../shared/api/endpoints";
import { ApiError, errorText } from "../shared/api/http";
import { keys, read, write, writeJson } from "../shared/lib/storage";
import { PasswordInput } from "../shared/ui/PasswordInput";
import { CODE_LENGTH, isEmail, NAME_MAX_LENGTH, PASSWORD_MAX_LENGTH as PASSWORD_MAX, PASSWORD_MIN_LENGTH as PASSWORD_MIN, USERNAME_PATTERN as USERNAME_RE } from "../../shared/limits.ts";

type Step = "login" | "signup" | "verify" | "password" | "forgot";
type Errors = Partial<Record<string, string>>;

const RESEND_MS = 60_000;
const REMEMBERED = "rememberedUser";
const RESEND_KEY = "resendCooldown";
const CHAT_PAGE = "/chat/";

interface SignUp {
	name: string;
	email: string;
	username: string;
}

// ─── Small pieces ─────────────────────────────────────────────────────────

function FieldError({ id, text }: { id: string; text: string | undefined }) {
	if (!text) return null;
	return (
		<span className="input-error" id={id} role="alert">
			{text}
		</span>
	);
}

function TextField({
	id,
	label,
	error,
	value,
	onChange,
	inputRef,
	...rest
}: {
	id: string;
	label: string;
	error: string | undefined;
	value: string;
	onChange: (v: string) => void;
	inputRef?: Ref<HTMLInputElement>;
	type?: string;
	autoComplete?: string;
	placeholder?: string;
	autoFocus?: boolean;
	maxLength?: number;
	autoCapitalize?: string;
	inputMode?: "email" | "text";
	dir?: string;
}) {
	return (
		<>
			<label htmlFor={id} className="form-label">
				{label}
			</label>
			<input
				ref={inputRef}
				id={id}
				name={id}
				className="form-input"
				value={value}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? `${id}-error` : undefined}
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
				{...rest}
				type={rest.type ?? "text"}
			/>
			<FieldError id={`${id}-error`} text={error} />
		</>
	);
}

function PasswordField({
	id,
	label,
	error,
	value,
	onChange,
	autoComplete,
	placeholder,
	inputRef,
	autoFocus,
}: {
	id: string;
	label: string;
	error: string | undefined;
	value: string;
	onChange: (v: string) => void;
	autoComplete: "current-password" | "new-password";
	placeholder: string;
	inputRef?: Ref<HTMLInputElement>;
	autoFocus?: boolean;
}) {
	return (
		<>
			<label htmlFor={id} className="form-label">
				{label}
			</label>
			<PasswordInput
				id={id}
				name={id}
				inputRef={inputRef}
				className="form-input password-input"
				value={value}
				onChange={onChange}
				autoComplete={autoComplete}
				placeholder={placeholder}
				invalid={!!error}
				describedBy={error ? `${id}-error` : undefined}
				autoFocus={autoFocus}
			/>
			<FieldError id={`${id}-error`} text={error} />
		</>
	);
}

function Form({ className, title, onSubmit, children, busy }: { className: string; title: string; onSubmit: () => void; children: ReactNode; busy: boolean }) {
	return (
		<form
			className={`form ${className}`}
			noValidate
			aria-busy={busy || undefined}
			onSubmit={(e) => {
				e.preventDefault();
				if (!busy) onSubmit();
			}}
		>
			<h1 className="form-title">{title}</h1>
			{children}
		</form>
	);
}

// ─── Sign in ──────────────────────────────────────────────────────────────

function saveUserCopy(user: PublicUser): void {
	// a display copy for the chat's first paint (no email, nothing secret)
	writeJson(keys.user, {
		id: user.id,
		name: user.name,
		username: user.username,
		bio: user.bio,
		profilePics: user.profilePics,
		privacyOnline: user.privacyOnline,
		privacyEmail: user.privacyEmail,
		privacyProfile: user.privacyProfile,
	});
}

function Login({
	notice,
	identifier,
	setIdentifier,
	onSignUp,
	onForgot,
}: {
	notice: string;
	identifier: string;
	setIdentifier: (v: string) => void;
	onSignUp: () => void;
	onForgot: () => void;
}) {
	const [password, setPassword] = useState("");
	const [remember, setRemember] = useState(() => !!read(REMEMBERED));
	const [errors, setErrors] = useState<Errors>({});
	const [busy, setBusy] = useState(false);
	const idRef = useRef<HTMLInputElement>(null);
	const passRef = useRef<HTMLInputElement>(null);

	const submit = async () => {
		const next: Errors = {};
		if (!identifier.trim()) next.identifier = "Please enter your email or username.";
		if (password.length < PASSWORD_MIN) next.password = `Password must be at least ${PASSWORD_MIN} characters.`;
		setErrors(next);
		if (next.identifier) return idRef.current?.focus();
		if (next.password) return passRef.current?.focus();
		setBusy(true);
		try {
			const { user } = await authApi.login(identifier.trim(), password);
			write(REMEMBERED, remember ? identifier.trim() : null);
			saveUserCopy(user);
			// replace(): "back" from the chat must not come back to this form
			window.location.replace(CHAT_PAGE);
		} catch (e) {
			setBusy(false);
			setErrors({ identifier: e instanceof ApiError && e.status === 401 ? "Invalid email, username or password." : errorText(e, "Couldn't sign in. Please try again.") });
			idRef.current?.focus();
		}
	};

	return (
		<Form className="login" title="Welcome" onSubmit={() => void submit()} busy={busy}>
			{notice && (
				<p className="auth-notice" role="status">
					{notice}
				</p>
			)}
			<TextField
				id="login-username"
				label="Email or Username"
				inputRef={idRef}
				value={identifier}
				onChange={setIdentifier}
				error={errors.identifier}
				autoComplete="username"
				autoCapitalize="none"
				placeholder="Email or Username"
				autoFocus={!identifier}
			/>
			<PasswordField
				id="login-password"
				label="Password"
				inputRef={passRef}
				value={password}
				onChange={setPassword}
				error={errors.password}
				autoComplete="current-password"
				placeholder="Password"
				autoFocus={!!identifier}
			/>
			<div className="form-row">
				<input type="checkbox" id="remember" className="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
				<label htmlFor="remember" className="form-label">
					Remember Me
				</label>
				<button type="button" className="link-btn forgotpass" onClick={onForgot}>
					Forgot Password?
				</button>
			</div>
			<button type="submit" className="form-submit" disabled={busy}>
				{busy ? "Logging in…" : "Log In"}
			</button>
			<button type="button" className="link-btn signuplink" onClick={onSignUp}>
				Don&apos;t have an account? Sign up
			</button>
		</Form>
	);
}

// ─── Sign up: name, email, username ───────────────────────────────────────

function SignUpForm({ data, setData, onCodeSent, onLogin }: { data: SignUp; setData: (d: SignUp) => void; onCodeSent: () => void; onLogin: () => void }) {
	const [errors, setErrors] = useState<Errors>({});
	const [busy, setBusy] = useState(false);
	const refs = { name: useRef<HTMLInputElement>(null), email: useRef<HTMLInputElement>(null), username: useRef<HTMLInputElement>(null) };

	const submit = async () => {
		const name = data.name.trim();
		const email = data.email.trim();
		const username = data.username.trim().replace(/^@/, "");
		const next: Errors = {};
		if (name.length < 2 || name.length > 100) next.name = "Name must be 2-100 characters.";
		if (!isEmail(email)) next.email = "Please enter a valid email address.";
		if (!USERNAME_RE.test(username)) next.username = "Username must be 3-30 characters, letters, numbers, or underscores only.";
		setErrors(next);
		const first = (["name", "email", "username"] as const).find((k) => next[k]);
		if (first) return refs[first].current?.focus();
		setBusy(true);
		try {
			// a taken username is reported now, not after the code (an email that
			// already has an account gets a "you already have one" email instead)
			try {
				const taken = await authApi.checkAvailability(username);
				if (taken.usernameTaken) {
					setErrors({ username: "This username is already taken." });
					refs.username.current?.focus();
					return;
				}
			} catch (e) {
				if (e instanceof ApiError && e.status === 429) throw e;
				// otherwise the server checks again when the account is created
			}
			await authApi.sendCode(email);
			write(RESEND_KEY, String(Date.now() + RESEND_MS));
			setData({ name, email, username });
			onCodeSent();
		} catch (e) {
			setErrors({ email: errorText(e, "Couldn't send the code. Please try again.") });
			refs.email.current?.focus();
		} finally {
			setBusy(false);
		}
	};

	const set = (k: keyof SignUp) => (v: string) => setData({ ...data, [k]: v });

	return (
		<Form className="signup" title="Sign Up" onSubmit={() => void submit()} busy={busy}>
			<TextField id="name" label="Name" inputRef={refs.name} value={data.name} onChange={set("name")} error={errors.name} autoComplete="name" placeholder="Your name" maxLength={NAME_MAX_LENGTH} dir="auto" autoFocus />
			<TextField
				id="email"
				label="Email"
				type="email"
				inputMode="email"
				inputRef={refs.email}
				value={data.email}
				onChange={set("email")}
				error={errors.email}
				autoComplete="email"
				autoCapitalize="none"
				placeholder="you@example.com"
			/>
			<TextField
				id="username"
				label="Username"
				inputRef={refs.username}
				value={data.username}
				onChange={set("username")}
				error={errors.username}
				autoComplete="username"
				autoCapitalize="none"
				placeholder="your_username"
				maxLength={31}
			/>
			<button type="submit" className="form-submit" disabled={busy}>
				{busy ? "Sending code…" : "Submit"}
			</button>
			<button type="button" className="link-btn loginlink" onClick={onLogin}>
				Already have an account? Log in
			</button>
		</Form>
	);
}

// ─── The emailed code ─────────────────────────────────────────────────────

function useResendWait(): [number, () => void] {
	const [until, setUntil] = useState(() => Number(read(RESEND_KEY)) || 0);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (until <= Date.now()) return undefined;
		const t = window.setInterval(() => {
			const n = Date.now();
			setNow(n);
			if (n >= until) {
				window.clearInterval(t);
				write(RESEND_KEY, null);
			}
		}, 1000);
		return () => window.clearInterval(t);
	}, [until]);
	const restart = () => {
		const u = Date.now() + RESEND_MS;
		write(RESEND_KEY, String(u));
		setNow(Date.now());
		setUntil(u);
	};
	return [Math.max(0, Math.ceil((until - now) / 1000)), restart];
}

function Verify({ email, onVerified, onBack }: { email: string; onVerified: () => void; onBack: () => void }) {
	const [digits, setDigits] = useState<string[]>(() => Array(CODE_LENGTH).fill(""));
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [resending, setResending] = useState(false);
	const [wait, restartWait] = useResendWait();
	const inputs = useRef<(HTMLInputElement | null)[]>([]);

	useEffect(() => {
		inputs.current[0]?.focus();
	}, []);

	const setFrom = (start: number, text: string) => {
		const clean = text.replace(/\D/g, "");
		if (!clean) return;
		setDigits((d) => {
			const next = [...d];
			for (let i = 0; i < clean.length && start + i < CODE_LENGTH; i++) next[start + i] = clean[i]!;
			return next;
		});
		setError("");
		inputs.current[Math.min(start + clean.length, CODE_LENGTH - 1)]?.focus();
	};

	const submit = async () => {
		const code = digits.join("");
		if (code.length < CODE_LENGTH) {
			setError(`Please enter the full ${CODE_LENGTH}-digit code.`);
			inputs.current[digits.findIndex((d) => !d)]?.focus();
			return;
		}
		setBusy(true);
		try {
			await authApi.verifyCode(email, code);
			onVerified();
		} catch (e) {
			setBusy(false);
			setError(e instanceof ApiError && e.status === 400 ? "The code is incorrect. Please try again." : errorText(e, "Couldn't check the code. Please try again."));
			setDigits(Array(CODE_LENGTH).fill(""));
			inputs.current[0]?.focus();
		}
	};

	const resend = async () => {
		// (a double click must not send two emails: the first code would stop working)
		if (wait > 0 || resending) return;
		setResending(true);
		setError("");
		setDigits(Array(CODE_LENGTH).fill(""));
		try {
			await authApi.sendCode(email);
			restartWait();
			inputs.current[0]?.focus();
		} catch (e) {
			setError(errorText(e, "Couldn't resend the code. Please try again."));
		} finally {
			setResending(false);
		}
	};

	const clock = wait > 0 ? `${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, "0")}` : "Resend";

	return (
		<Form className="verify" title="Verify it's you" onSubmit={() => void submit()} busy={busy}>
			<button type="button" className="link-btn go-back" onClick={onBack}>
				Back
			</button>
			<p className="form-subtitle" id="code-help">
				Please enter the code sent to your email address. If it already has a Rivo account, we sent sign-in help there instead.
			</p>
			{error && (
				<span className="input-error code-error" id="code-error" role="alert">
					{error}
				</span>
			)}
			<div className="code-inputs" role="group" aria-label="Verification code" aria-describedby={error ? "code-error" : "code-help"}>
				{digits.map((d, i) => (
					<input
						key={i}
						ref={(el) => {
							inputs.current[i] = el;
						}}
						className="form-input code-digit"
						inputMode="numeric"
						autoComplete={i === 0 ? "one-time-code" : "off"}
						maxLength={i === 0 ? CODE_LENGTH : 1}
						aria-label={`Digit ${i + 1}`}
						aria-invalid={error ? true : undefined}
						value={d}
						onChange={(e) => {
							const v = e.target.value.replace(/\D/g, "");
							// a whole code typed or filled in at once (the phone's suggestion)
							if (v.length > 1) return setFrom(i, v);
							setDigits((all) => {
								const next = [...all];
								next[i] = v;
								return next;
							});
							setError("");
							if (v && i < CODE_LENGTH - 1) inputs.current[i + 1]?.focus();
						}}
						onKeyDown={(e) => {
							if (e.key === "Backspace" && !d && i > 0) inputs.current[i - 1]?.focus();
							else if (e.key === "ArrowLeft" && i > 0) {
								e.preventDefault();
								inputs.current[i - 1]?.focus();
							} else if (e.key === "ArrowRight" && i < CODE_LENGTH - 1) {
								e.preventDefault();
								inputs.current[i + 1]?.focus();
							}
						}}
						onPaste={(e) => {
							e.preventDefault();
							setFrom(i, e.clipboardData.getData("text"));
						}}
						onFocus={(e) => e.currentTarget.select()}
					/>
				))}
			</div>
			<button type="submit" className="form-submit" disabled={busy}>
				{busy ? "Checking…" : "Verify"}
			</button>
			<button type="button" className="timer" disabled={wait > 0 || resending} onClick={() => void resend()} aria-label={wait > 0 ? `Resend the code in ${wait} seconds` : "Resend the code"}>
				{clock}
			</button>
		</Form>
	);
}

// ─── The new account's password ───────────────────────────────────────────

function SetPassword({ data, onDone, onBack }: { data: SignUp; onDone: () => void; onBack: () => void }) {
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [errors, setErrors] = useState<Errors>({});
	const [busy, setBusy] = useState(false);
	const passRef = useRef<HTMLInputElement>(null);
	const confirmRef = useRef<HTMLInputElement>(null);

	const submit = async () => {
		const next: Errors = {};
		if (password.length < PASSWORD_MIN) next.password = `Password must be at least ${PASSWORD_MIN} characters.`;
		else if (password.length > PASSWORD_MAX) next.password = "Password is too long.";
		if (confirm !== password) next.confirm = "Passwords do not match.";
		setErrors(next);
		if (next.password) return passRef.current?.focus();
		if (next.confirm) return confirmRef.current?.focus();
		setBusy(true);
		try {
			await authApi.register({ ...data, password });
			onDone();
		} catch (e) {
			setBusy(false);
			setErrors({ password: errorText(e, "Couldn't create your account. Please try again.") });
			passRef.current?.focus();
		}
	};

	return (
		<Form className="password" title="Set Your Password" onSubmit={() => void submit()} busy={busy}>
			<button type="button" className="link-btn go-back" onClick={onBack}>
				Back
			</button>
			{/* lets password managers save the new password for this account */}
			<input type="text" name="username" autoComplete="username" value={data.username} readOnly className="visually-hidden" tabIndex={-1} aria-hidden="true" />
			<PasswordField
				id="password"
				label="Password"
				inputRef={passRef}
				value={password}
				onChange={setPassword}
				error={errors.password}
				autoComplete="new-password"
				placeholder={`${PASSWORD_MIN} or more characters`}
				autoFocus
			/>
			<PasswordField
				id="confirm-password"
				label="Confirm Password"
				inputRef={confirmRef}
				value={confirm}
				onChange={setConfirm}
				error={errors.confirm}
				autoComplete="new-password"
				placeholder="Re-enter your password"
			/>
			<button type="submit" className="form-submit" disabled={busy}>
				{busy ? "Creating account…" : "Submit"}
			</button>
		</Form>
	);
}

// ─── Forgotten password ───────────────────────────────────────────────────

function Forgot({ initial, onSent, onBack }: { initial: string; onSent: () => void; onBack: () => void }) {
	const [value, setValue] = useState(initial);
	const [error, setError] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	const submit = async () => {
		const v = value.trim();
		if (!isEmail(v) && !USERNAME_RE.test(v.replace(/^@/, ""))) {
			setError("Please enter a valid email or username.");
			input.current?.focus();
			return;
		}
		setBusy(true);
		try {
			await authApi.requestPasswordReset(v.replace(/^@/, ""));
			onSent();
		} catch (e) {
			setBusy(false);
			setError(errorText(e, "Couldn't send the reset link. Please try again."));
			input.current?.focus();
		}
	};

	return (
		<Form className="forget-password" title="We Got You" onSubmit={() => void submit()} busy={busy}>
			<button type="button" className="link-btn go-back" onClick={onBack}>
				Back
			</button>
			<p className="form-subtitle">Please enter your username or email address to reset your password.</p>
			<input
				ref={input}
				id="forgot-identifier"
				className="form-input"
				autoComplete="username"
				autoCapitalize="none"
				spellCheck={false}
				placeholder="Email or Username"
				aria-label="Email or Username"
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? "forgot-identifier-error" : undefined}
				autoFocus
				value={value}
				onChange={(e) => setValue(e.target.value)}
			/>
			<FieldError id="forgot-identifier-error" text={error} />
			<button type="submit" className="form-submit" disabled={busy}>
				{busy ? "Sending…" : "Reset"}
			</button>
		</Form>
	);
}

// ─── The page ─────────────────────────────────────────────────────────────

// What the address asked for: ?reset=1 after a new password, ?forgot=1 from
// the "you already have an account" email. Read once, then removed.
const START = (() => {
	const params = new URLSearchParams(window.location.search);
	const reset = params.get("reset") === "1";
	const forgot = params.get("forgot") === "1";
	if (reset || forgot) history.replaceState(history.state, "", window.location.pathname);
	return {
		step: (forgot ? "forgot" : "login") as Step,
		notice: reset ? "Your password was changed. Sign in with your new password." : "",
	};
})();

export function AuthApp() {
	const [step, setStep] = useState<Step>(START.step);
	const [notice, setNotice] = useState(START.notice);
	const [identifier, setIdentifier] = useState(() => read(REMEMBERED) ?? "");
	const [signUp, setSignUp] = useState<SignUp>({ name: "", email: "", username: "" });

	// a device that is still signed in goes straight to the chats
	useEffect(() => {
		if (!read(keys.user)) return;
		fetch("/api/users/me", { credentials: "same-origin", cache: "no-store" })
			.then((r) => {
				if (r.ok) window.location.replace(CHAT_PAGE);
			})
			.catch(() => undefined);
	}, []);

	// (each step puts the cursor in its first field)
	const go = (s: Step) => setStep(s);

	return (
		<main className="container">
			<div className="circle-top" aria-hidden="true" />
			{step === "login" && (
				<Login
					notice={notice}
					identifier={identifier}
					setIdentifier={setIdentifier}
					onSignUp={() => {
						setNotice("");
						go("signup");
					}}
					onForgot={() => {
						setNotice("");
						go("forgot");
					}}
				/>
			)}
			{step === "signup" && <SignUpForm data={signUp} setData={setSignUp} onCodeSent={() => go("verify")} onLogin={() => go("login")} />}
			{step === "verify" && <Verify email={signUp.email} onVerified={() => go("password")} onBack={() => go("signup")} />}
			{step === "password" && (
				<SetPassword
					data={signUp}
					onBack={() => go("login")}
					onDone={() => {
						setIdentifier(signUp.username);
						setSignUp({ name: "", email: "", username: "" });
						setNotice("Your account is ready. Sign in with your new password.");
						go("login");
					}}
				/>
			)}
			{step === "forgot" && (
				<Forgot
					initial={identifier}
					onBack={() => go("login")}
					onSent={() => {
						setNotice("If the account exists, a password reset link is on its way to its email.");
						go("login");
					}}
				/>
			)}
			<div className="circle-bottom" aria-hidden="true" />
		</main>
	);
}
