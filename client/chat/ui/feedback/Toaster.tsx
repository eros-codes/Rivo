// The short message at the bottom ("Message copied", "Chat deleted · Undo").
// It sits just above the message box when a chat is open, and above any open
// dialog (an error in Edit Profile, say), where it can still be read and used.
import { useEffect, useLayoutEffect, useState, type ComponentType } from "react";
import { useStore } from "../../../shared/lib/store";
import { Icons, type IconProps } from "../../../shared/ui/icons";
import { TopLayer } from "../../../shared/ui/TopLayer";
import { hideToast } from "../../services/feedback";
import { toasts } from "../../state/stores";
import type { Toast, ToastIcon } from "../../state/types";
import { bottomBarRef } from "../refs";

const ICONS: Record<ToastIcon, ComponentType<IconProps>> = {
	delete: Icons.Delete,
	copy: Icons.Copy,
	archive: Icons.Archive,
	pin: Icons.Pin,
	mute: Icons.Mute,
	block: Icons.Block,
	error: Icons.Failed,
	check: Icons.Check,
	bell: Icons.Bell,
};

const GAP = 14;
const FADE_MS = 150;

/** Distance from the bottom of the window: above the message box when one is on screen. */
function bottomOffset(): number {
	const box = bottomBarRef.current;
	if (!box) return GAP;
	const r = box.getBoundingClientRect();
	if (r.height === 0 || r.top >= window.innerHeight) return GAP;
	return Math.max(GAP, window.innerHeight - r.top + GAP);
}

export function Toaster() {
	const toast = useStore(toasts, (s) => s.current);
	// the last toast stays while it fades out
	const [shown, setShown] = useState<Toast | null>(toast);
	const [bottom, setBottom] = useState(GAP);

	useLayoutEffect(() => {
		if (toast) {
			setShown(toast);
			setBottom(bottomOffset());
		}
	}, [toast]);

	useEffect(() => {
		if (toast) return undefined;
		const t = window.setTimeout(() => setShown(null), FADE_MS);
		return () => window.clearTimeout(t);
	}, [toast]);

	const Icon = shown?.icon ? ICONS[shown.icon] : null;

	return (
		<TopLayer className="toast-layer">
			{/* read out by screen readers */}
			<div className="visually-hidden" role="status" aria-live="polite">
				{toast?.text ?? ""}
			</div>
			{shown && (
				<div className={`toaster${toast ? "" : " leaving"}`} style={{ bottom }}>
					<div className="toast">
						{Icon && (
							<span className="toast-icon">
								<Icon />
							</span>
						)}
						<span className="toast-message">{shown.text}</span>
						{shown.action && (
							<button
								type="button"
								className="undo-btn"
								onClick={() => {
									const run = shown.action?.run;
									hideToast();
									run?.();
								}}
							>
								{shown.action.label}
							</button>
						)}
					</div>
				</div>
			)}
		</TopLayer>
	);
}
