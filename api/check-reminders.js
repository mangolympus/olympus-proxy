// Olympus — scheduled evening reminder. Triggered by Vercel Cron (see vercel.json), runs
// with nobody logged in, so it reads/writes the shared Drive JSON directly via a service
// account rather than going through the client's normal OAuth flow.
//
// ASSUMES IST (UTC+5:30) — see IST_OFFSET_MINUTES below and the cron schedule in vercel.json.
// If that's wrong, both need updating together.
//
// REQUIRES the service account's Drive share upgraded from Viewer to Editor. As configured
// today (Viewer-only), the download below will succeed but the write-back at the end will
// fail with a 403 — this endpoint needs write access to dedupe reminders via
// lastReminderSentDate (see the "already reminded today" skip reason).
//
// Requires (already set): VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.
// Also checks for CRON_SECRET (see the auth check below) — NOT in your list of five, so it's
// probably not set yet. Add it (any random string) to lock this endpoint down; Vercel sends
// it automatically as a Bearer token on cron-triggered requests once the env var exists.
import crypto from 'crypto';
import webpush from 'web-push';

const DRIVE_FOLDER_ID = '1Wr2t2KJUw5vEi0Vbi2290m09kacBdM0s'; // "Olympus CA Tracker"
const DATA_FILE_NAME = 'olympus-data.json';
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const PROFILE_IDS = ['umang', 'chetna'];

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Ports index.html's todayStr()/localDateStr() — same 5 AM→4:59 AM study-day boundary — but
// shifted for IST manually, since this runs on Vercel's server clock (UTC), not a phone's
// local time the way the client-side original does via plain getHours()/setDate().
function todayStrIST(nowUtc) {
  nowUtc = nowUtc || new Date();
  const shifted = new Date(nowUtc.getTime() + IST_OFFSET_MINUTES * 60000);
  if (shifted.getUTCHours() < 5) shifted.setUTCDate(shifted.getUTCDate() - 1);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Ports effectiveTodayTarget() and hoursOnDate() from index.html exactly (same field names,
// same fallback-to-4 default), just reading from the downloaded JSON instead of S.shared.
function effectiveTodayTarget(data, profileId, todayStr) {
  const ov = data.dailyTargetOverride && data.dailyTargetOverride[profileId];
  if (ov && ov.date === todayStr && Number(ov.hours) > 0) return Number(ov.hours);
  return (data.targets && data.targets[profileId]) || 4;
}
function hoursOnDate(data, profileId, dateStr) {
  const logs = (data.logs && data.logs[profileId]) || [];
  return logs.filter((l) => l.date === dateStr).reduce((s, l) => s + Number(l.hours || 0), 0);
}

async function getServiceAccountAccessToken(scope) {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  // Env vars store multi-line PEM keys with literal "\n" sequences rather than real
  // newlines — convert back, but only if that's actually how it was pasted in.
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iss: email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsigned)
    .sign(privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    // A JWT/invalid_grant error here specifically means the private key needs re-checking —
    // see the note in olympus-handoff conventions about not re-pasting env vars otherwise.
    throw new Error(`Google token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()).access_token;
}

async function findDataFileId(accessToken) {
  const q = encodeURIComponent(
    `'${DRIVE_FOLDER_ID}' in parents and name='${DATA_FILE_NAME}' and trashed=false`
  );
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Drive search failed: ${resp.status} ${await resp.text()}`);
  const { files } = await resp.json();
  if (!files || !files.length) throw new Error(`${DATA_FILE_NAME} not found in folder ${DRIVE_FOLDER_ID}`);
  return files[0].id;
}

async function downloadData(accessToken, fileId) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Drive download failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function uploadData(accessToken, fileId, data) {
  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }
  );
  if (!resp.ok) throw new Error(`Drive write failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

export default async function handler(req, res) {
  if (
    process.env.CRON_SECRET &&
    req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = { today: null, sent: [], skipped: [], errors: [] };
  try {
    const todayIST = todayStrIST();
    result.today = todayIST;

    const accessToken = await getServiceAccountAccessToken('https://www.googleapis.com/auth/drive');
    const fileId = await findDataFileId(accessToken);
    const data = await downloadData(accessToken, fileId);

    // Same spirit as sharedDataHasContent() client-side — refuse to write back anything that
    // doesn't look like real Olympus data, rather than risk clobbering the file with garbage.
    if (!data || typeof data !== 'object' || !data.logs || !data.targets) {
      throw new Error('Downloaded file did not look like valid Olympus data — aborting without writing back.');
    }
    if (!data.pushState) data.pushState = { targetHitDate: {} };
    if (!data.pushState.lastReminderSentDate) data.pushState.lastReminderSentDate = {};
    if (!data.pushSubscriptions) data.pushSubscriptions = {};

    let dirty = false;

    for (const profileId of PROFILE_IDS) {
      const target = effectiveTodayTarget(data, profileId, todayIST);
      const done = hoursOnDate(data, profileId, todayIST);

      if (done >= target) {
        result.skipped.push({ profileId, reason: 'target already met' });
        continue;
      }
      if (data.pushState.lastReminderSentDate[profileId] === todayIST) {
        result.skipped.push({ profileId, reason: 'already reminded today' });
        continue;
      }
      const subscription = data.pushSubscriptions[profileId];
      if (!subscription) {
        result.skipped.push({ profileId, reason: 'not subscribed' });
        continue;
      }

      const payload = JSON.stringify({
        title: `⏰ ${done.toFixed(1)}h of ${target}h logged today`,
        body: "Today's target isn't met yet — still time to log a session.",
        data: { url: './' },
      });
      try {
        await webpush.sendNotification(subscription, payload);
        data.pushState.lastReminderSentDate[profileId] = todayIST;
        dirty = true;
        result.sent.push(profileId);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          delete data.pushSubscriptions[profileId];
          dirty = true;
          result.skipped.push({ profileId, reason: 'subscription expired, cleared' });
        } else {
          result.errors.push({ profileId, error: err.message });
        }
      }
    }

    if (dirty) await uploadData(accessToken, fileId, data);

    res.status(200).json(result);
  } catch (err) {
    console.error('check-reminders failed:', err);
    res.status(500).json({ error: err.message, partial: result });
  }
}
