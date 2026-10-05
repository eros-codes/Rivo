// Clickable elements that are not buttons (cards, list items) still work
// with the keyboard: Enter and Space act like a click.
import type { KeyboardEvent, MouseEvent } from "react";

export function pressable(fn: (e?: MouseEvent | KeyboardEvent) => void) {
	return {
		role: "button" as const,
		tabIndex: 0,
		onClick: (e: MouseEvent) => fn(e),
		onKeyDown: (e: KeyboardEvent) => {
			if (e.target !== e.currentTarget) return;
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				fn(e);
			}
		},
	};
}
