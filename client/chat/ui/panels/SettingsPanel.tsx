// Settings: appearance (this device), privacy (the account), notifications,
// archived chats, devices, password and account deletion.
//
// One row at a time opens the part under it (a picker, the password form);
// opening another closes it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { authApi, usersApi } from "../../../shared/api/endpoints";
import { ApiError, errorText } from "../../../shared/api/http";
import type { Me, Privacy } from "../../../shared/api/types";
import { useIsDark, usePresence } from "../../../shared/lib/hooks";
import { toJpegDataUrl } from "../../../shared/lib/images";
import { useStore } from "../../../shared/lib/store";
import { ACCENT_PRESETS, DEFAULT_ACCENT, applyWallpaper, normalizeHex, saveAccent, saveTheme, saveWallpaper, storedAccent, storedWallpaper } from "../../../shared/lib/theme";
import { Icons } from "../../../shared/ui/icons";
import { PasswordInput } from "../../../shared/ui/PasswordInput";
import { showToast } from "../../services/feedback";
import { closePanel, openDialog } from "../../services/navigation";
import { disablePush, enablePush, pushState, type PushState } from "../../services/push";
import { patchMe, setMe } from "../../services/session";
import { contacts, session } from "../../state/stores";
import { useUi } from "../selectors";
import { ResponsivePanel } from "./ResponsivePanel";
import { PASSWORD_MAX_LENGTH as PASSWORD_MAX, PASSWORD_MIN_LENGTH as PASSWORD_MIN } from "../../../../shared/limits.ts";

type Section = "accent" | "wallpaper" | "privacyOnline" | "privacyEmail" | "privacyProfile" | "password";

const PRIVACY_OPTIONS: { value: Privacy; label: string }[] = [
	{ value: "everyone", label: "Everyone" },
	{ value: "contacts", label: "Contacts" },
	{ value: "nobody", label: "Nobody" },
];
const privacyLabel = (v: Privacy | undefined) => PRIVACY_OPTIONS.find((o) => o.value === v)?.label ?? "Everyone";

/** localStorage holds ~5M characters; the wallpaper takes at most half. */
const WALLPAPER_MAX_CHARS = 2_500_000;
const RESET_COOLDOWN_MS = 30_000;
/** survives closing Settings, so the button cannot be hammered */
let resetCooldownUntil = 0;

// ─── Building blocks ──────────────────────────────────────────────────────

function Row({
	id,
	icon,
	label,
	value,
	onClick,
	expanded,
	danger,
	busy,
}: {
	id: string;
	icon: ReactNode;
	label: string;
	value?: ReactNode;
	onClick: () => void;
	expanded?: boolean;
	danger?: boolean;
	busy?: boolean;
}) {
	return (
		<button
			type="button"
			id={id}
			className={`settings-row${danger ? " settings-row-danger" : ""}`}
			aria-expanded={expanded}
			aria-busy={busy || undefined}
			onClick={onClick}
		>
			<span className="settings-row-left">
				{icon}
				<span>{label}</span>
			</span>
			{value !== undefined && <span className="settings-row-value">{value}</span>}
		</button>
	);
}

/** The part under a row, sliding open (its contents exist only while open). */
function Expand({ open, className, children }: { open: boolean; className: string; children: ReactNode }) {
	const { mounted } = usePresence(open, 250);
	return (
		<div className={`settings-expand${open ? " open" : ""}`}>
			<div className="settings-expand-inner">{mounted && <div className={className}>{children}</div>}</div>
		</div>
	);
}

// ─── Appearance ───────────────────────────────────────────────────────────

function AccentPicker({ accent, onPick }: { accent: string; onPick: (hex: string) => void }) {
	const custom = !ACCENT_PRESETS.some((p) => p.hex === accent);
	return (
		<div className="settings-accent-presets" role="radiogroup" aria-label="Accent color">
			{ACCENT_PRESETS.map((p) => (
				<button
					key={p.hex}
					type="button"
					role="radio"
					aria-checked={accent === p.hex}
					aria-label={p.name}
					title={p.name}
					className={`accent-swatch${accent === p.hex ? " active" : ""}`}
					style={{ background: p.hex }}
					onClick={() => onPick(p.hex)}
				/>
			))}
			{/* a label opens the native color picker in every browser (a hidden input's .click() does not) */}
			<label className={`accent-swatch accent-swatch-custom${custom ? " active" : ""}`} title="Custom color">
				<Icons.Eyedropper />
				<input type="color" className="visually-hidden" aria-label="Custom color" value={accent} onChange={(e) => onPick(e.target.value)} />
			</label>
		</div>
	);
}

function WallpaperActions({ has, onChange }: { has: boolean; onChange: (has: boolean) => void }) {
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);

	const choose = async (file: File) => {
		if (file.type && !file.type.startsWith("image/")) {
			showToast("Please choose an image file", { icon: "error" });
			return;
		}
		setBusy(true);
		try {
			// shrunk to a screen-sized JPEG: big enough to look sharp, small enough to keep
			const dataUrl = await toJpegDataUrl(file, { maxSide: 1600, maxChars: WALLPAPER_MAX_CHARS });
			if (saveWallpaper(dataUrl)) showToast("Background updated", { icon: "check" });
			else {
				// no room on this device: shown until the page is closed
				applyWallpaper(dataUrl);
				showToast("Background set, but this device has no room to keep it", { icon: "error", ms: 4000 });
			}
			onChange(true);
		} catch {
			showToast("This image can't be used. Please try another one.", { icon: "error" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="settings-wallpaper-actions">
			<input
				ref={input}
				type="file"
				accept="image/*"
				hidden
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (file) void choose(file);
				}}
			/>
			<button type="button" className="settings-wallpaper-btn" disabled={busy} onClick={() => input.current?.click()}>
				{busy ? "Preparing…" : has ? "Change Image" : "Upload Image"}
			</button>
			{has && (
				<button
					type="button"
					className="settings-wallpaper-btn settings-wallpaper-btn-remove"
					disabled={busy}
					onClick={() => {
						saveWallpaper(null);
						applyWallpaper(null);
						onChange(false);
						showToast("Background removed", { icon: "check" });
					}}
				>
					Remove
				</button>
			)}
		</div>
	);
}

// ─── Privacy ──────────────────────────────────────────────────────────────

type PrivacyField = "privacyOnline" | "privacyEmail" | "privacyProfile";

async function savePrivacy(me: Me, field: PrivacyField, value: Privacy): Promise<void> {
	const before = me[field];
	if (before === value) return;
	patchMe({ [field]: value });
	try {
		setMe(await usersApi.update({ [field]: value }));
		showToast("Saved", { icon: "check" });
	} catch (e) {
		patchMe({ [field]: before });
		showToast(errorText(e, "Couldn't save. Please try again."), { icon: "error" });
	}
}

function PrivacyPicker({ label, value, onPick }: { label: string; value: Privacy; onPick: (v: Privacy) => void }) {
	return (
		<div role="radiogroup" aria-label={`Who can see your ${label.toLowerCase()}`}>
			{PRIVACY_OPTIONS.map((o) => (
				<button
					key={o.value}
					type="button"
					role="radio"
					aria-checked={value === o.value}
					className={`settings-picker-option${value === o.value ? " active" : ""}`}
					onClick={() => onPick(o.value)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

// ─── Notifications ────────────────────────────────────────────────────────

const PUSH_LABEL: Record<PushState, string> = {
	unsupported: "Unavailable",
	blocked: "Blocked",
	off: "Off",
	on: "On",
	working: "…",
};

function isIosBrowserTab(): boolean {
	const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
	const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
	return ios && !standalone;
}

async function togglePush(state: PushState): Promise<void> {
	switch (state) {
		case "working":
			return;
		case "on":
			await disablePush();
			showToast("Notifications turned off", { icon: "bell" });
			return;
		case "unsupported":
			showToast(
				isIosBrowserTab() ? "To get notifications on iPhone, add Rivo to your Home Screen first" : "This browser can't show notifications",
				{ icon: "error", ms: 4500 },
			);
			return;
		case "blocked":
			showToast("Notifications are blocked. Allow them in your browser's site settings.", { icon: "error", ms: 4500 });
			return;
		case "off": {
			const result = await enablePush(true);
			if (result === "on") showToast("Notifications turned on", { icon: "bell" });
			else if (result === "blocked") showToast("Notifications are blocked. Allow them in your browser's site settings.", { icon: "error", ms: 4500 });
			else if (result === "off" && Notification.permission === "granted") showToast("Couldn't turn on notifications. Please try again.", { icon: "error" });
		}
	}
}

// ─── Password ─────────────────────────────────────────────────────────────

function useCooldown(until: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (until <= Date.now()) return undefined;
		const t = window.setInterval(() => {
			setNow(Date.now());
			if (Date.now() >= until) window.clearInterval(t);
		}, 1000);
		return () => window.clearInterval(t);
	}, [until]);
	return Math.max(0, Math.ceil((until - now) / 1000));
}

function ChangePasswordForm({ me, onDone }: { me: Me; onDone: () => void }) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
	const [cooldownUntil, setCooldownUntil] = useState(resetCooldownUntil);
	const [sending, setSending] = useState(false);
	const wait = useCooldown(cooldownUntil);
	const currentRef = useRef<HTMLInputElement>(null);
	const nextRef = useRef<HTMLInputElement>(null);
	const confirmRef = useRef<HTMLInputElement>(null);

	const fail = (text: string, field?: { current: HTMLInputElement | null }) => {
		setFeedback({ ok: false, text });
		field?.current?.focus();
	};

	const submit = async () => {
		if (busy) return;
		if (!current) return fail("Enter your current password.", currentRef);
		if (next.length < PASSWORD_MIN) return fail(`Your new password must be at least ${PASSWORD_MIN} characters.`, nextRef);
		if (next.length > PASSWORD_MAX) return fail("Your new password is too long.", nextRef);
		if (next !== confirm) return fail("The new passwords don't match.", confirmRef);
		if (next === current) return fail("The new password must be different from the current one.", nextRef);
		setBusy(true);
		setFeedback(null);
		try {
			const { signedOut } = await usersApi.changePassword(current, next);
			showToast(signedOut > 0 ? "Password changed. Other devices were signed out." : "Password changed", { icon: "check", ms: 4000 });
			onDone();
		} catch (e) {
			if (e instanceof ApiError && e.status === 403) fail("Your current password is incorrect.", currentRef);
			else fail(errorText(e, "Couldn't change your password. Please try again."));
		} finally {
			setBusy(false);
		}
	};

	const sendReset = async () => {
		if (sending || wait > 0) return;
		setSending(true);
		try {
			await authApi.requestPasswordReset();
			resetCooldownUntil = Date.now() + RESET_COOLDOWN_MS;
			setCooldownUntil(resetCooldownUntil);
			setFeedback({ ok: true, text: `A reset link is on its way to ${me.email}.` });
		} catch (e) {
			setFeedback({ ok: false, text: errorText(e, "Couldn't send the reset link. Please try again.") });
		} finally {
			setSending(false);
		}
	};

	return (
		<form
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			{/* lets password managers file the new password under the right account */}
			<input type="text" name="username" autoComplete="username" value={me.username} readOnly className="visually-hidden" tabIndex={-1} aria-hidden="true" />
			<div className="settings-change-password-field">
				<p className="settings-hint">Your password must be at least {PASSWORD_MIN} characters long.</p>
				<PasswordInput inputRef={currentRef} value={current} onChange={setCurrent} placeholder="Current password" label="Current password" autoComplete="current-password" className="settings-password-input" autoFocus />
			</div>
			<div className="settings-change-password-field">
				<PasswordInput inputRef={nextRef} value={next} onChange={setNext} placeholder="New password" label="New password" autoComplete="new-password" className="settings-password-input" />
			</div>
			<div className="settings-change-password-field">
				<PasswordInput inputRef={confirmRef} value={confirm} onChange={setConfirm} placeholder="Confirm new password" label="Confirm new password" autoComplete="new-password" className="settings-password-input" />
			</div>
			<div className="settings-change-password-actions">
				<button type="submit" className="settings-change-password-submit" disabled={busy}>
					{busy ? "Changing…" : "Change Password"}
				</button>
				<button type="button" className="settings-send-reset-email" disabled={sending || wait > 0} onClick={() => void sendReset()}>
					{sending ? "Sending…" : wait > 0 ? `Send again in ${wait}s` : "Send reset email"}
				</button>
			</div>
			<p className={`settings-change-password-feedback${feedback ? (feedback.ok ? " settings-feedback--ok" : " settings-feedback--error") : ""}`} role="status" aria-live="polite">
				{feedback?.text}
			</p>
		</form>
	);
}

// ─── The panel ────────────────────────────────────────────────────────────

function Settings() {
	const me = useStore(session, (s) => s.me);
	const dark = useIsDark();
	const push = useStore(pushState, (s) => s.state);
	const archivedCount = useStore(contacts, (s) => Object.values(s.byConv).filter((r) => r.isArchived && !r.isSaved).length);
	const [open, setOpen] = useState<Section | null>(null);
	const [accent, setAccent] = useState(() => storedAccent() ?? DEFAULT_ACCENT);
	const [hasWallpaper, setHasWallpaper] = useState(() => storedWallpaper() !== null || document.documentElement.style.getPropertyValue("--chat-wallpaper") !== "");

	if (!me) return null;
	const toggle = (s: Section) => setOpen((o) => (o === s ? null : s));

	const pickAccent = (hex: string) => {
		const color = normalizeHex(hex);
		if (!color) return;
		saveAccent(color);
		setAccent(color);
	};

	const privacyRow = (field: PrivacyField, id: string, label: string, icon: ReactNode) => (
		<>
			<Row id={id} icon={icon} label={label} value={privacyLabel(me[field])} expanded={open === field} onClick={() => toggle(field)} />
			<Expand open={open === field} className="settings-privacy-picker">
				<PrivacyPicker
					label={label}
					value={me[field]}
					onPick={(v) => {
						setOpen(null);
						void savePrivacy(me, field, v);
					}}
				/>
			</Expand>
		</>
	);

	return (
		<>
			<div className="settings-panel-header">
				<button type="button" className="settings-panel-close" aria-label="Close settings" onClick={closePanel}>
					<Icons.Close />
				</button>
				<h2>Settings</h2>
			</div>

			<h3 className="settings-section-label" id="settings-customization">
				Customization
			</h3>
			<div className="settings-group" role="group" aria-labelledby="settings-customization">
				<Row
					id="settings-theme-row"
					icon={<Icons.Theme />}
					label="Theme"
					value={dark ? "Dark" : "Light"}
					onClick={() => {
						setOpen(null);
						saveTheme(dark ? "light" : "dark");
					}}
				/>
				<Row
					id="settings-accent-row"
					icon={<Icons.Palette />}
					label="Accent Color"
					value={<span className="settings-accent-dot" style={{ background: accent }} />}
					expanded={open === "accent"}
					onClick={() => toggle("accent")}
				/>
				<Expand open={open === "accent"} className="settings-accent-panel">
					<AccentPicker accent={accent} onPick={pickAccent} />
				</Expand>
				<Row
					id="settings-wallpaper-row"
					icon={<Icons.Image />}
					label="Chat Background"
					value={hasWallpaper ? "Custom" : "Default"}
					expanded={open === "wallpaper"}
					onClick={() => toggle("wallpaper")}
				/>
				<Expand open={open === "wallpaper"} className="settings-accent-panel">
					<WallpaperActions has={hasWallpaper} onChange={setHasWallpaper} />
				</Expand>
			</div>

			<h3 className="settings-section-label" id="settings-privacy">
				Privacy
			</h3>
			<div className="settings-group" role="group" aria-labelledby="settings-privacy">
				{privacyRow("privacyOnline", "settings-privacy-online", "Online Status", <Icons.Online />)}
				{privacyRow("privacyEmail", "settings-privacy-email", "Email", <Icons.Email />)}
				{privacyRow("privacyProfile", "settings-privacy-profile", "Profile Picture", <Icons.Person />)}
			</div>

			<h3 className="settings-section-label" id="settings-chats">
				Chats
			</h3>
			<div className="settings-group" role="group" aria-labelledby="settings-chats">
				<Row
					id="settings-notifications"
					icon={<Icons.Bell />}
					label="Notifications"
					value={PUSH_LABEL[push]}
					busy={push === "working"}
					onClick={() => {
						setOpen(null);
						void togglePush(push);
					}}
				/>
				<Row
					id="settings-archived"
					icon={<Icons.ArchiveOutline />}
					label="Archived Chats"
					value={archivedCount > 0 ? String(archivedCount) : undefined}
					onClick={() => {
						setOpen(null);
						openDialog("archived");
					}}
				/>
			</div>

			<h3 className="settings-section-label" id="settings-account">
				Account
			</h3>
			<div className="settings-group" role="group" aria-labelledby="settings-account">
				<Row
					id="settings-devices"
					icon={<Icons.Devices />}
					label="Devices"
					onClick={() => {
						setOpen(null);
						openDialog("devices");
					}}
				/>
				<Row id="settings-change-password" icon={<Icons.Lock />} label="Change Password" expanded={open === "password"} onClick={() => toggle("password")} />
				<Expand open={open === "password"} className="settings-change-password-form">
					<ChangePasswordForm me={me} onDone={() => setOpen(null)} />
				</Expand>
				<Row
					id="settings-delete-account"
					icon={<Icons.Delete />}
					label="Delete Account"
					danger
					onClick={() => {
						setOpen(null);
						openDialog("deleteAccount");
					}}
				/>
			</div>
		</>
	);
}

export function SettingsPanel({ phone }: { phone: boolean }) {
	const open = useUi((s) => s.panel === "settings");
	return (
		<ResponsivePanel open={open} phone={phone} panelClass="settings-panel" dialogClass="settings-dialog" onClose={closePanel} label="Settings">
			<Settings />
		</ResponsivePanel>
	);
}
