// Prints a new message key (32 random bytes, base64) for KEK_V1, KEK_V2, …
//
//   npm run gen-kek
//
// A key is set once and never changed: messages wrapped with it can only be
// read with it. Moving to a new key is a rotation (server/ENCRYPTION.md).
import crypto from "node:crypto";

console.log(crypto.randomBytes(32).toString("base64"));
