// Random ids made on this device (a message's clientId: the server stores it
// so a retried send is never stored twice).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 22 random URL-safe characters (132 bits). */
export function randomId(length = 22): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = "";
	for (const b of bytes) out += ALPHABET[b & 63];
	return out;
}
