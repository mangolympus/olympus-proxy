// api/send-push.js
// Sends a single Web Push notification via VAPID — the actual delivery mechanism behind
// nudges, "partner started studying," "partner hit target," and new chat message pushes.
// Regenerated in ES module syntax (matching auth.js/sync.js — this repo's package.json has
// "type": "module", so a CommonJS require()/module.exports version would crash the same way
// the earlier auth.js/sync.js versions did).
//
// Required env vars (already present — same ones referenced by the client-side
// subscribeToPush() flow in index.html):
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT     — typically "mailto:you@example.com", identifies who's sending
//
// Needs the `web-push` package in package.json dependencies — check first; if missing,
// add "web-push": "^3.6.7" the same way googleapis was added for sync.js.
//
// Request:  POST { subscription: PushSubscriptionJSON, title: string, body: string, data?: object }
// Success:  200 { ok: true }
// Expired subscription (recipient uninstalled / revoked permission): 200 { ok: false, expired: true }
//   — the frontend's sendPush() specifically checks this `expired` flag to prune the stale
//   subscription from S.shared.pushSubscriptions, so this shape has to match exactly.
// Failure:  500 { error: string }

import webpush from 'web-push';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { subscription, title, body, data } = req.body || {};
  if (!subscription || !subscription.endpoint || !title) {
    res.status(400).json({ error: 'Missing subscription or title' });
    return;
  }

  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title, body: body || '', data: data || {} })
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    // 404/410 from the push service means the subscription itself is dead (browser
    // uninstalled, permission revoked, etc.) — not a real failure to log loudly, just a
    // signal for the frontend to stop trying to reach that specific subscription.
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      res.status(200).json({ ok: false, expired: true });
      return;
    }
    console.error('send-push failed:', err);
    res.status(500).json({ error: 'Failed to send push' });
  }
}
