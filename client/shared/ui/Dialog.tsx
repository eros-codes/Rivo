// A modal dialog on the native <dialog> element: focus is kept inside, the
// rest of the page is inert, Escape and a tap outside close it.
import { useLayoutEffect, useRef, type ReactNode, type SyntheticEvent } from "react";
import { createStore } from "../lib/store";

export interface DialogProps {
	className: string;
	onClose: () => void;
	children: ReactNode;
	/** a tap on the dimmed background closes it (default) */
	closeOnBackdrop?: boolean;
	labelledBy?: string;
	label?: string;
}

/**
 * The modal dialogs open now, the topmost last. While one is open everything
 * outside it is inert, so what must stay usable on top (the toasts) is put
 * inside the topmost one (see TopLayer).
 */
export const openDialogs = createStore<HTMLDialogElement[]>([]);

const forget = (d: HTMLDialogElement) => openDialogs.set((list) => (list.includes(d) ? list.filter((x) => x !== d) : list));
const remember = (d: HTMLDialogElement) => openDialogs.set((list) => [...list.filter((x) => x !== d), d]);

function open(d: HTMLDialogElement): void {
	try {
		d.showModal();
	} catch {
		d.setAttribute("open", "");
	}
	remember(d);
}

/** React passes `cancel` and `close` on to the dialogs a dialog sits in: only a dialog's own counts. */
const own = (e: SyntheticEvent) => e.target === e.currentTarget;

export function Dialog({ className, onClose, children, closeOnBackdrop = true, labelledBy, label }: DialogProps) {
	const ref = useRef<HTMLDialogElement>(null);
	const down = useRef<EventTarget | null>(null);
	const unmounting = useRef(false);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useLayoutEffect(() => {
		const d = ref.current;
		unmounting.current = false;
		if (d && !d.open) open(d);
		return () => {
			unmounting.current = true;
			if (!d) return;
			forget(d);
			if (d.open) d.close();
		};
	}, []);

	return (
		<dialog
			ref={ref}
			className={className}
			aria-labelledby={labelledBy}
			aria-label={label}
			onCancel={(e) => {
				if (!own(e)) return;
				// Escape: the app decides (it also updates the back button)
				e.preventDefault();
				e.stopPropagation();
				onCloseRef.current();
			}}
			onClose={(e) => {
				if (!own(e)) return;
				e.stopPropagation();
				const d = ref.current;
				// (our own close() from an effect cleanup, reported after the dialog
				// was already shown again — as React's development mode does)
				if (unmounting.current || !d || d.open) return;
				// The browser closed it by itself (a second Escape in a row closes
				// a dialog even when the first was refused). The app is told; if
				// it keeps the dialog (busy), the dialog is shown again so what is
				// on screen and what the app thinks agree.
				forget(d);
				onCloseRef.current();
				requestAnimationFrame(() => {
					if (!unmounting.current && ref.current === d && d.isConnected && !d.open) open(d);
				});
			}}
			onPointerDown={(e) => {
				down.current = e.target;
			}}
			onClick={(e) => {
				// only a tap that started and ended on the backdrop (not a text selection dragged out)
				if (closeOnBackdrop && e.target === e.currentTarget && down.current === e.currentTarget) onCloseRef.current();
			}}
		>
			{children}
		</dialog>
	);
}
