// A panel that is a full-screen page sliding in on phones and a centered
// dialog on larger screens (profile, edit profile, settings).
import type { ReactNode } from "react";
import { useEscape, usePresence } from "../../../shared/lib/hooks";
import { Dialog } from "../../../shared/ui/Dialog";

export function ResponsivePanel({
	open,
	phone,
	panelClass,
	dialogClass,
	onClose,
	label,
	children,
}: {
	open: boolean;
	phone: boolean;
	panelClass: string;
	dialogClass: string;
	onClose: () => void;
	label: string;
	children: ReactNode;
}) {
	const { mounted, state } = usePresence(open && phone, 300);
	// (a dialog opened from the panel takes Escape first)
	useEscape(() => {
		if (!document.querySelector("dialog[open]")) onClose();
	}, open && phone);

	if (!phone) {
		if (!open) return null;
		return (
			<Dialog className={dialogClass} onClose={onClose} label={label}>
				<div className={panelClass}>{children}</div>
			</Dialog>
		);
	}
	if (!mounted) return null;
	const anim = state === "enter" ? " slide-in" : state === "exit" ? " slide-out" : "";
	return (
		<div className={`${panelClass}${anim}`} style={{ display: "flex" }} role="dialog" aria-modal="true" aria-label={label}>
			{children}
		</div>
	);
}
