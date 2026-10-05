// Checks the push notification keys (VAPID_PUBLIC / VAPID_PRIVATE) of this .env.
//
//   npm run check-vapid
import "../env.ts";
import webpush from "web-push";
import { messageOf } from "../utils/errors.ts";

const pub = process.env.VAPID_PUBLIC;
const priv = process.env.VAPID_PRIVATE;
const contact = process.env.VAPID_CONTACT || "mailto:admin@example.com";

if (!pub || !priv) {
	console.error("VAPID_PUBLIC / VAPID_PRIVATE are not set (make a pair with: npm run gen-vapid)");
	process.exitCode = 2;
} else {
	try {
		webpush.setVapidDetails(contact, pub, priv);
		console.log("VAPID check: OK");
	} catch (e) {
		console.error("VAPID check: FAILED:", messageOf(e) ?? e);
		process.exitCode = 2;
	}
}
