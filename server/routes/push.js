import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import push from '../utils/push.js';

const router = Router();

// Return public VAPID key to clients
router.get('/publicKey', (req, res) => {
  const k = push.getPublicKey();
  if (!k) return res.status(500).json({ error: 'VAPID keys not configured' });
  res.json({ publicKey: k });
});

// Subscribe current user
router.post('/subscribe', requireAuth, async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  try {
    push.addSubscription(req.userId, sub);
    return res.json({ success: true });
  } catch (e) {
    // subscribe failed (suppressed)
    return res.status(500).json({ error: 'Server error' });
  }
});

// Unsubscribe current user's subscription by endpoint
router.post('/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  try {
    push.removeSubscriptionByEndpoint(req.userId, endpoint);
    return res.json({ success: true });
  } catch (e) {
    // unsubscribe failed (suppressed)
    return res.status(500).json({ error: 'Server error' });
  }
});

// Send a test notification to a user (defaults to current user)
router.post('/send', requireAuth, async (req, res) => {
  // Only allow sending to the authenticated user's subscriptions.
  // Ignore any userId provided in the request body to prevent spoofing.
  const { payload } = req.body || {};
  const target = req.userId;
  try {
    const result = await push.sendNotificationToUser(target, payload || { title: 'Rivo', body: 'Notification' });
    return res.json({ success: true, result });
  } catch (e) {
    // push send failed (suppressed)
    return res.status(500).json({ error: 'Push failed' });
  }
});

export default router;
