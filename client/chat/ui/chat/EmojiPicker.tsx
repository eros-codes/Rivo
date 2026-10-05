// The emoji picker (a web component, loaded the first time it is opened).
import { useEffect, useRef, useState } from "react";
import { useEvent } from "../../../shared/lib/hooks";

let loading: Promise<unknown> | null = null;
function loadPicker(): Promise<unknown> {
	loading ??= import("emoji-picker-element").catch((e) => {
		loading = null;
		throw e;
	});
	return loading;
}

export function EmojiPicker({ onPick, dark }: { onPick: (emoji: string) => void; dark: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const [failed, setFailed] = useState(false);
	const pick = useEvent(onPick);

	useEffect(() => {
		let alive = true;
		let picker: HTMLElement | null = null;
		const onClick = (e: Event) => {
			const unicode = (e as CustomEvent<{ unicode?: string }>).detail?.unicode;
			if (unicode) pick(unicode);
		};
		loadPicker()
			.then(() => {
				if (!alive || !host.current) return;
				picker = document.createElement("emoji-picker");
				picker.className = `emoji-picker ${dark ? "dark" : "light"}`;
				picker.setAttribute("data-source", "/assets/data.json");
				picker.addEventListener("emoji-click", onClick);
				host.current.appendChild(picker);
			})
			.catch(() => alive && setFailed(true));
		return () => {
			alive = false;
			picker?.removeEventListener("emoji-click", onClick);
			picker?.remove();
		};
	}, [dark, pick]);

	return (
		<div ref={host} className="emoji-picker-host">
			{failed && <p className="emoji-picker-failed">Couldn&apos;t load emojis.</p>}
		</div>
	);
}
