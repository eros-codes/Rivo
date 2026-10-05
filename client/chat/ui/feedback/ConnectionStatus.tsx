// "Connecting..." at the bottom while the live connection is down (after a
// short delay, so a quick reconnect does not flash it).
import { useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "../../../shared/lib/store";
import { connection } from "../../state/stores";

const DELAY_MS = 1500;

function subscribeOnline(cb: () => void): () => void {
	window.addEventListener("online", cb);
	window.addEventListener("offline", cb);
	return () => {
		window.removeEventListener("online", cb);
		window.removeEventListener("offline", cb);
	};
}

export function ConnectionStatus() {
	const status = useStore(connection, (s) => s.status);
	const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
	const down = status !== "online";
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		if (!down) {
			setVisible(false);
			return undefined;
		}
		const t = window.setTimeout(() => setVisible(true), DELAY_MS);
		return () => window.clearTimeout(t);
	}, [down]);

	return (
		<div className={`connection-status${visible ? " visible" : ""}`} role="status" aria-live="polite" aria-hidden={!visible}>
			<span className="connection-status-text">{visible ? (online ? "Connecting..." : "Waiting for network...") : ""}</span>
		</div>
	);
}
