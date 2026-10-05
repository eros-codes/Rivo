// Prints a new key pair for push notifications, as lines for .env.
//
//   npm run gen-vapid
//
// Make it once per server. A new pair makes every existing subscription
// useless; the app notices the new key and subscribes again.
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC="${keys.publicKey}"`);
console.log(`VAPID_PRIVATE="${keys.privateKey}"`);
