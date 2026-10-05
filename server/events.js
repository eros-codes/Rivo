// In-process notifications between modules that must not import each other
// (e.g. the session store tells the socket layer to close a device's sockets).
import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(50);
