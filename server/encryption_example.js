"use strict";

import crypto from "node:crypto";
import { generateDEK, encryptMessage, wrapDEK, unwrapDEK, decryptMessage } from "./utils/encryption.js";

// Demo: if no KEK set in env, create an ephemeral one for the demo only.
if (!process.env.KEK_V1) {
  const demoKek = crypto.randomBytes(32).toString("base64");
  console.warn("WARN: KEK_V1 not set. Using ephemeral demo KEK. Do NOT use in production.");
  process.env.KEK_V1 = demoKek;
}

async function main() {
  const plaintext = "This is a super-secret message for storage";

  // 1) Generate a per-message DEK
  const dek = generateDEK();

  // 2) Encrypt the message with the DEK
  const { ciphertext, iv, authTag } = encryptMessage(plaintext, dek);

  // 3) Wrap (encrypt) the DEK with a KEK from env (key id 'v1')
  const keyId = "v1";
  const wrappedDek = wrapDEK(dek, keyId);

  // 4) Simulate storing the DB record
  const dbRecord = {
    ciphertext,
    iv,
    auth_tag: authTag,
    wrapped_dek: wrappedDek,
    key_id: keyId,
    created_at: new Date().toISOString(),
  };

  console.log("--- simulated DB record ---");
  console.log(dbRecord);

  // 5) Later: unwrap DEK and decrypt
  const unwrappedDek = unwrapDEK(dbRecord.wrapped_dek, dbRecord.key_id);
  const recovered = decryptMessage(dbRecord.ciphertext, dbRecord.iv, dbRecord.auth_tag, unwrappedDek);
  console.log("Recovered plaintext:", recovered);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
