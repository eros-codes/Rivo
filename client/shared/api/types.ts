// The wire format lives in shared/: the server is type-checked against the
// same files, so the two cannot drift apart. (Kept here so the app's imports
// stay short.)
export type * from "../../../shared/api.ts";
export type { Ack, ClientEvents, ForwardItem, SendPayload, ServerEvents } from "../../../shared/events.ts";
