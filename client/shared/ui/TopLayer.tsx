// Things that must stay on top and usable while a modal dialog is open (the
// toasts, the banner for a message in another chat). A modal dialog makes the
// rest of the page inert and covers it with its backdrop, so these are put
// inside the topmost open dialog, as a popover: a popover is drawn in the top
// layer, above that dialog and free of its clipping and transform.
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../lib/store";
import { openDialogs } from "./Dialog";

const canPopover = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

export function TopLayer({ className, style, children }: { className: string; style?: CSSProperties; children: ReactNode }) {
	const host = useStore(openDialogs, (list) => list[list.length - 1] ?? null);
	const ref = useRef<HTMLDivElement>(null);
	const asPopover = host !== null && canPopover;

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || !asPopover) return undefined;
		try {
			el.showPopover();
		} catch {
			/* already shown */
		}
		return () => {
			try {
				el.hidePopover();
			} catch {
				/* already gone */
			}
		};
	}, [asPopover, host]);

	const node = (
		<div ref={ref} className={`top-layer ${className}`} style={style} popover={asPopover ? "manual" : undefined}>
			{children}
		</div>
	);
	// (a browser without popovers still gets it inside the dialog: usable, if clipped)
	return host ? createPortal(node, host) : node;
}
