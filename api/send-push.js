// Olympus — send a single Web Push notification. Called directly by the client
// (sendPush() in index.html) for the nudge and event-triggered push types. The scheduled
// evening reminder does NOT go through this route — see check-reminders.js, which calls
// web-push directly since it already has everything it needs server-side.
//
// Requires VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (already set per your setup).
import webpush from 'web-push';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
  // Cross-origin from mangolympus.github.io — mirror whatever CORS handling your existing
  // /api/ask.js already uses for consistency. This is a standalone guess at that, since I
  // don't have that file; replace with your existing helper if you have a shared one.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { subscription, title, body, data } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    res.status(400).json({ error: 'Missing or invalid subscription' });
    return;
  }

  const payload = JSON.stringify({ title: title || 'Olympus', body: body || '', data: data || {} });

  try {
    await webpush.sendNotification(subscription, payload);
    res.status(200).json({ ok: true });
  } catch (err) {
    // 404/410 = the push service itself says this subscription is dead (uninstalled,
    // permission revoked, etc). Distinct response so the client can clear its copy and let
    // the Settings toggle correctly show "off" again — see sendPush() in index.html.
    if (err.statusCode === 404 || err.statusCode === 410) {
      res.status(200).json({ ok: false, expired: true });
      return;
    }
    console.error('send-push error:', err);
    res.status(500).json({ error: 'Failed to send push', detail: err.message });
  }
}
