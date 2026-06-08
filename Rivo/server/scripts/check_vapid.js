#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
import webpush from 'web-push';

const pub = process.env.VAPID_PUBLIC;
const priv = process.env.VAPID_PRIVATE;
const contact = process.env.VAPID_CONTACT || 'mailto:admin@example.com';

if (!pub || !priv) {
  console.error('VAPID not configured');
  process.exit(2);
}
try {
  webpush.setVapidDetails(contact, pub, priv);
  console.log('VAPID check: OK');
} catch (e) {
  console.error('VAPID check: FAILED', e && e.message ? e.message : e);
  process.exit(2);
}
