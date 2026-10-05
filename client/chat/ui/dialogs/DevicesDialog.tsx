// The devices signed in to the account; any other one can be signed out.
import { useCallback, useEffect, useState } from "react";
import { sessionsApi } from "../../../shared/api/endpoints";
import { errorText } from "../../../shared/api/http";
import type { DeviceSession } from "../../../shared/api/types";
import { useNow } from "../../../shared/lib/hooks";
import { shortDate, timeAgo } from "../../../shared/lib/time";
import { Dialog } from "../../../shared/ui/Dialog";
import { Icons } from "../../../shared/ui/icons";
import { showToast } from "../../services/feedback";
import { closeDialog } from "../../services/navigation";
import { useUi } from "../selectors";

/** "Chrome on Android" from a browser's user agent (best effort). */
export function describeDevice(ua: string): { name: string; mobile: boolean } {
	const browser = /Edg(?:e|A|iOS)?\//.test(ua)
		? "Edge"
		: /OPR\/|Opera/.test(ua)
			? "Opera"
			: /SamsungBrowser\//.test(ua)
				? "Samsung Internet"
				: /Firefox\/|FxiOS\//.test(ua)
					? "Firefox"
					: /Chrome\/|CriOS\//.test(ua)
						? "Chrome"
						: /Safari\//.test(ua)
							? "Safari"
							: null;
	const os = /Android/.test(ua)
		? "Android"
		: /iPhone|iPod/.test(ua)
			? "iPhone"
			: /iPad/.test(ua)
				? "iPad"
				: /Windows/.test(ua)
					? "Windows"
					: /CrOS/.test(ua)
						? "ChromeOS"
						: /Mac OS X|Macintosh/.test(ua)
							? "macOS"
							: /Linux/.test(ua)
								? "Linux"
								: null;
	const mobile = /Mobi|Android|iPhone|iPad|iPod/.test(ua);
	if (browser && os) return { name: `${browser} on ${os}`, mobile };
	return { name: browser ?? os ?? "Unknown device", mobile };
}

type Load = { status: "loading" } | { status: "error"; text: string } | { status: "ready"; sessions: DeviceSession[] };

function Devices() {
	const [load, setLoad] = useState<Load>({ status: "loading" });
	const [busy, setBusy] = useState<string | null>(null);
	const now = useNow(60_000);

	const fetchList = useCallback(async () => {
		setLoad({ status: "loading" });
		try {
			const { sessions } = await sessionsApi.list();
			setLoad({ status: "ready", sessions });
		} catch (e) {
			setLoad({ status: "error", text: errorText(e, "Couldn't load your devices.") });
		}
	}, []);

	useEffect(() => {
		void fetchList();
	}, [fetchList]);

	const sessions = load.status === "ready" ? load.sessions : [];
	const others = sessions.filter((s) => !s.current);

	const signOut = async (id: string) => {
		if (busy) return;
		setBusy(id);
		try {
			await sessionsApi.revoke(id);
			setLoad((l) => (l.status === "ready" ? { ...l, sessions: l.sessions.filter((s) => s.id !== id) } : l));
			showToast("Device signed out", { icon: "check" });
		} catch (e) {
			showToast(errorText(e, "Couldn't sign out that device. Please try again."), { icon: "error" });
		} finally {
			setBusy(null);
		}
	};

	const signOutOthers = async () => {
		if (busy) return;
		setBusy("others");
		try {
			const { revoked } = await sessionsApi.revokeOthers();
			setLoad((l) => (l.status === "ready" ? { ...l, sessions: l.sessions.filter((s) => s.current) } : l));
			showToast(revoked === 1 ? "1 device signed out" : `${revoked} devices signed out`, { icon: "check" });
		} catch (e) {
			showToast(errorText(e, "Couldn't sign out the other devices. Please try again."), { icon: "error" });
		} finally {
			setBusy(null);
		}
	};

	return (
		<Dialog className="devices-dialog" onClose={closeDialog} labelledBy="devices-dialog-title">
			<div className="archived-dialog-header">
				<button type="button" className="archived-dialog-close" aria-label="Close" onClick={closeDialog}>
					<Icons.Close size={22} />
				</button>
				<h3 className="archived-dialog-title" id="devices-dialog-title">
					Devices
				</h3>
			</div>
			<div className="devices-list" aria-busy={load.status === "loading"}>
				{load.status === "loading" && (
					<div className="devices-loading" role="status">
						<Icons.Spinner />
						<span>Loading…</span>
					</div>
				)}
				{load.status === "error" && (
					<div className="devices-error">
						<p>{load.text}</p>
						<button type="button" className="settings-wallpaper-btn" onClick={() => void fetchList()}>
							Try again
						</button>
					</div>
				)}
				{sessions.map((s) => {
					const device = describeDevice(s.userAgent);
					return (
						<div key={s.id} className={`device-item${s.current ? " current" : ""}`}>
							<span className="device-icon">{device.mobile ? <Icons.Phone /> : <Icons.Desktop />}</span>
							<div className="device-info">
								<span className="device-name">{device.name}</span>
								<span className="device-meta">
									{s.current ? "This device" : `Active ${timeAgo(s.lastSeenAt, now)}`} · Signed in {shortDate(s.createdAt)}
								</span>
							</div>
							{!s.current && (
								<button type="button" className="device-signout" disabled={busy !== null} onClick={() => void signOut(s.id)}>
									{busy === s.id ? "…" : "Sign out"}
								</button>
							)}
						</div>
					);
				})}
			</div>
			{others.length > 1 && (
				<button type="button" className="devices-signout-all" disabled={busy !== null} onClick={() => void signOutOthers()}>
					{busy === "others" ? "Signing out…" : "Sign out all other devices"}
				</button>
			)}
		</Dialog>
	);
}

export function DevicesDialog() {
	const open = useUi((s) => s.dialog === "devices");
	return open ? <Devices /> : null;
}
