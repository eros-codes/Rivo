// In-process notifications between modules that must not import each other
// (e.g. the session store tells the socket layer to close a device's sockets).
import { EventEmitter } from "node:events";

/** Every event on the bus and what it carries. */
export interface BusEvents {
	/** a signed-in device was signed out: its live connections end */
	"session:revoked": [{ sid: string; userId: number }];
}

export const bus = new EventEmitter<BusEvents>();
bus.setMaxListeners(50);
