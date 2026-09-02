// api/soak-diff.js — Phase 3 soak verification.
//
// Reads the current olympus-data.json from Drive AND the current RTDB tree, normalizes both
// through normalizeForCompare() (the same function the Phase 1 tests use), and returns a
// summary of any differences. A clean soak shows zero differences for several days across
// real use by both profiles.
//
// Call this nightly — or any time you want to confirm RTDB is in sync — from the browser
// console:
//
//   const tok = JSON.parse(localStorage.getItem('olympus:appSession')).token;
//   fetch('/api/soak-diff', {
//     method: 'POST',
//     headers: { 'Authorization': 'Bearer ' + tok }
//   }).then(r => r.json()).then(r => console.log(JSON.stringify(r, null, 2)));
//
// If differences appear:
//   - Transient diffs (paths that come and go) are almost certainly drift from the 30-day
//     archive sweep or normal user activity between the Drive snapshot and the RTDB snapshot
//     — re-run immediately after an app save to confirm they cleared.
//   - Persistent diffs with the same paths on every run may be a codec bug, a rules mismatch,
//     or a new top-level key with no rules block. Check the browser console for
//     '[rtdb] Phase 3 soak — dropped N paths' and cross-reference.
//   - Before Phase 5 the diff will correctly show diary and profileInfo for the PARTNER
//     profile — those arrive via their device, not this one. That is expected and correct.
//
// Required env vars (all already set from Phase 0 + earlier):
//   SESSION_SECRET, FIREBASE_SERVICE_ACCOUNT, FIREBASE_DB_URL,
//   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//
// The codec is INLINED here, same as api/import-rtdb.js — see that file's header for why.
// This is copy 4 of the inlined codec. Change lib/rtdb-codec.js → change all 4 copies.

import { createHmac, timingSafeEqual } from 'crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import pkg from 'googleapis';

const { google } = pkg;
const FOLDER_ID = '1Wr2t2KJUw5vEi0Vbi2290m09kacBdM0s';
const DATA_FILE_NAME = 'olympus-data.json';

// ── Session verification (same pattern as all other api/ files) ──────────────────────────────
function sign(payload) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
}
function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  let payload;
  try { payload = Buffer.from(encodedPayload, 'base64url').toString('utf8'); }
  catch (e) { return null; }
  if (!safeEqual(signature, sign(payload))) return null;
  const [profile, expiresAtStr] = payload.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  if (profile !== 'umang' && profile !== 'chetna') return null;
  return profile;
}

// ── Firebase + Drive setup ───────────────────────────────────────────────────────────────────
function ensureAdminApp() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const parsed = JSON.parse(raw);
  if (parsed.private_key && parsed.private_key.includes('\\n')) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  initializeApp({ credential: cert(parsed), databaseURL: process.env.FIREBASE_DB_URL });
}
function getDrive() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}
async function readDriveData() {
  const drive = getDrive();
  const q = `name='${DATA_FILE_NAME}' and '${FOLDER_ID}' in parents and trashed=false`;
  const list = await drive.files.list({ q, fields: 'files(id, name, modifiedTime)' });
  const file = list.data.files && list.data.files[0];
  if (!file) throw new Error(`${DATA_FILE_NAME} not found in the Drive folder`);
  const content = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' });
  return { data: JSON.parse(content.data), modifiedTime: file.modifiedTime };
}

// ═══ INLINED CODEC — keep in sync with lib/rtdb-codec.js ═══════════════════════════════════

const ARRAY_PATHS = [
  'logs/*', 'tasks/*', 'plannerTargets/*', 'habits/*', 'questions', 'notes/*',
  'chapters/*/*', 'lectures/*/*', 'mockScores/*/*', 'chat/messages',
];
const NESTED_ARRAY_KEYS = { 'chapters/*/*': ['topics'] };
const PRIMITIVE_ARRAY_PATHS = [
  'profileInfo/*/weakSubjects', 'chat/messages/*/reactions/*',
];
const PROFILE_SCOPED_KEYS = new Set([
  'logs', 'chapters', 'lectures', 'timerState', 'habits', 'habitLog', 'tasks',
  'plannerTargets', 'mockScores', 'targets', 'papers', 'profileInfo', 'prefs',
  'dailyTargetOverride', 'celebratedMilestones', 'lectureCompletionTarget', 'pushPrefs',
  'diary', 'pushSubscriptions',
]);
const SHARED_WRITE_KEYS = new Set([
  'chat', 'pushState', 'notes', 'questions', 'qStats', 'examDate', 'dailyQuote',
  'adminAnnouncement', 'money',
]);
const ALL_WRITABLE = new Set([...PROFILE_SCOPED_KEYS, ...SHARED_WRITE_KEYS]);

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function pathMatches(parts, pattern) {
  const pp = pattern.split('/');
  if (pp.length !== parts.length) return false;
  for (let i = 0; i < pp.length; i++) if (pp[i] !== '*' && pp[i] !== parts[i]) return false;
  return true;
}
function matchesAny(parts, patterns) { return patterns.some((p) => pathMatches(parts, p)); }
function nestedKeysFor(parts) {
  for (const p of Object.keys(NESTED_ARRAY_KEYS)) if (pathMatches(parts, p)) return NESTED_ARRAY_KEYS[p];
  return null;
}
function mapToArr(obj) {
  if (!obj) return [];
  return Object.values(obj).slice()
    .sort((a, b) => (a && a._o != null ? a._o : 0) - (b && b._o != null ? b._o : 0))
    .map((item) => { if (!isPlainObject(item)) return item; const { _o, ...rest } = item; return rest; });
}
function mapToPrimArr(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj.slice();
  return Object.keys(obj).sort((a, b) => Number(a) - Number(b)).map((k) => obj[k]);
}
function decodeNode(value, parts) {
  if (matchesAny(parts, PRIMITIVE_ARRAY_PATHS)) return mapToPrimArr(value);
  if (matchesAny(parts, ARRAY_PATHS)) {
    const arr = mapToArr(value);
    const nested = nestedKeysFor(parts);
    return arr.map((item, i) => {
      if (!isPlainObject(item)) return item;
      const decoded = decodeNode(item, parts.concat(String(i)));
      if (nested && isPlainObject(decoded)) {
        for (const nk of nested) if (!Array.isArray(decoded[nk])) decoded[nk] = mapToArr(decoded[nk]);
      }
      return decoded;
    });
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeNode(v, parts.concat(k));
    return out;
  }
  return value;
}
function decodeFromRtdb(raw) { if (!raw) return {}; return decodeNode(raw, []); }

function normalizeForCompare(value) {
  if (Array.isArray(value)) {
    const arr = value.map(normalizeForCompare).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      const n = normalizeForCompare(v);
      if (n === undefined) continue;
      out[k] = n;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

// ═══ end inlined codec ═══════════════════════════════════════════════════════════════════════

// Deep diff that terminates after 200 differing paths so the response stays readable.
function deepDiffPaths(a, b, prefix = '', out = []) {
  if (out.length > 200) return out;
  const aObj = isPlainObject(a) || Array.isArray(a);
  const bObj = isPlainObject(b) || Array.isArray(b);
  if (!aObj && !bObj) {
    if (a !== b) out.push({ path: prefix || '/', drive: a, rtdb: b });
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path: prefix || '/', drive: Array.isArray(a) ? 'array' : typeof a, rtdb: Array.isArray(b) ? 'array' : typeof b });
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push({ path: prefix, drive: `len ${a.length}`, rtdb: `len ${b.length}` });
    for (let i = 0; i < Math.max(a.length, b.length); i++) deepDiffPaths(a[i], b[i], `${prefix}/${i}`, out);
    return out;
  }
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) deepDiffPaths((a || {})[k], (b || {})[k], `${prefix}/${k}`, out);
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const profile = verifyToken(bearer);
  if (!profile) { res.status(401).json({ error: 'Not signed in' }); return; }

  try {
    ensureAdminApp();
    const db = getDatabase();

    // 1. Read both stores in parallel.
    const [{ data: driveRaw, modifiedTime }, rtdbSnap] = await Promise.all([
      readDriveData(),
      db.ref('/').get(),
    ]);

    const rtdbAt = new Date().toISOString();

    // 2. Strip unwritable keys from Drive side (liveStatus, etc.) so the diff compares the
    //    same scope that RTDB actually holds. These keys are rightly absent from RTDB.
    const driveFiltered = {};
    const driveSkipped = [];
    for (const k of Object.keys(driveRaw)) {
      if (ALL_WRITABLE.has(k)) driveFiltered[k] = driveRaw[k];
      else driveSkipped.push(k);
    }

    // 3. Decode RTDB.
    const rtdbDecoded = rtdbSnap.exists() ? decodeFromRtdb(rtdbSnap.val()) : {};

    // 4. Normalize both sides identically — MUST compare through normalizeForCompare() or
    //    the 800+ null leaves in Drive appear as differences against RTDB's absent nodes.
    const driveNorm  = normalizeForCompare(driveFiltered)  || {};
    const rtdbNorm   = normalizeForCompare(rtdbDecoded)    || {};

    // 5. Diff.
    const diffs = deepDiffPaths(driveNorm, rtdbNorm);

    // 6. Per-profile summary — useful during the soak to tell own-profile drift from
    //    partner-profile drift (partner writes arrive via their device only, not this one,
    //    so some delay is expected and not a bug).
    const diffsByProfile = { umang: [], chetna: [], shared: [] };
    for (const d of diffs) {
      const top = d.path.split('/').filter(Boolean)[1]; // e.g. 'umang' in /logs/umang/...
      if (top === 'umang') diffsByProfile.umang.push(d.path);
      else if (top === 'chetna') diffsByProfile.chetna.push(d.path);
      else diffsByProfile.shared.push(d.path);
    }

    const clean = diffs.length === 0;
    res.status(200).json({
      ok: clean,
      summary: clean
        ? 'RTDB matches Drive exactly (within the writable scope).'
        : `${diffs.length} difference(s) found — see the diffs array.`,
      ranAs: profile,
      driveModifiedTime: modifiedTime,
      rtdbReadAt: rtdbAt,
      driveSkippedKeys: driveSkipped,
      diffCount: diffs.length,
      diffsByProfile: {
        umang: diffsByProfile.umang.length,
        chetna: diffsByProfile.chetna.length,
        shared: diffsByProfile.shared.length,
      },
      // First 30 paths only — enough to diagnose; cap avoids a huge response.
      diffs: diffs.slice(0, 30),
      note: diffs.length > 30 ? `Showing first 30 of ${diffs.length} differences.` : undefined,
    });
  } catch (err) {
    console.error('soak-diff failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
