// api/import-rtdb.js — PHASE 2, one-time import. Drive → RTDB.
//
// Reads olympus-data.json from Drive with the service account, runs the codec over it, writes
// it to RTDB with firebase-admin, reads the whole tree back, decodes it, and deep-diffs
// against the source. Reports the result. Refuses to leave the database in a half-written
// state without telling you.
//
// The plan called for a local Node script. This is an endpoint instead: the service account
// and Firebase credentials already live in Vercel env vars, so nothing has to be installed
// locally and no admin key touches a laptop. It is re-runnable, which was the plan's stated
// reason for preferring a script.
//
// The codec below is INLINED rather than imported from lib/rtdb-codec.js. That is deliberate
// and follows this repo's existing convention: an earlier shared api/_lib/session.js was
// silently left out of Vercel's deployment bundle (ERR_MODULE_NOT_FOUND at runtime despite
// existing in the repo), which is why auth.js and sync.js duplicate their session logic.
// lib/ sits outside api/ and would hit the same class of problem. IF YOU CHANGE THE CODEC IN
// lib/, CHANGE IT HERE TOO — tests/run-tests.js only covers the lib/ copy.
//
// USAGE — two steps, deliberately. A dry run first, then the real thing.
//
//   Dry run (writes NOTHING, reports what would happen):
//     POST /api/import-rtdb   Authorization: Bearer <session token>
//     body { "mode": "dry-run" }
//
//   Real import:
//     body { "mode": "import", "confirm": "yes-overwrite-rtdb" }
//
// The confirm phrase is required because this does set() at the ROOT — it replaces the entire
// database. Harmless today (RTDB is empty) and catastrophic if run by accident after Phase 3
// has started. It also refuses to run if the database is already non-empty unless you pass
// "allowOverwrite": true.
//
// Env vars (all already set): GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
// FIREBASE_SERVICE_ACCOUNT, FIREBASE_DB_URL, SESSION_SECRET.

import { createHmac, timingSafeEqual } from 'crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import pkg from 'googleapis';

const { google } = pkg;
const FOLDER_ID = '1Wr2t2KJUw5vEi0Vbi2290m09kacBdM0s';
const DATA_FILE_NAME = 'olympus-data.json';

// ── session verification (sixth copy — see the note above) ──
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

// ═══ INLINED CODEC — keep in sync with lib/rtdb-codec.js ═══
// '*' matches exactly one key level.

// Arrays of OBJECTS that carry a stable `id`. Verified against the real data file: every one
// of these has 100% id coverage and zero duplicates (logs 169, tasks 150, habits 10,
// chapters 238, lectures 417, chat messages 84). The four that are empty today
// (plannerTargets, questions, notes, mockScores) were confirmed by reading their creation
// sites in index.html — every push() assigns uid(). No Phase 2 backfill is needed for any of
// them, which removes a whole step from that phase.
const ARRAY_PATHS = [
  'logs/*',
  'tasks/*',
  'plannerTargets/*',
  'habits/*',
  'questions',
  'notes/*',
  'chapters/*/*',
  'lectures/*/*',
  'mockScores/*/*',
  'chat/messages',
];

// Arrays of OBJECTS nested inside an array item, keyed by the parent pattern.
const NESTED_ARRAY_KEYS = {
  'chapters/*/*': ['topics'],
};

// Arrays of PRIMITIVES (strings). Encoded as index-keyed maps of raw values — no _o field,
// because the index IS the order. See finding 3 above.
const PRIMITIVE_ARRAY_PATHS = [
  'profileInfo/*/weakSubjects',
  'chat/messages/*/reactions/*',
];

// uid() in index.html is Date.now().toString(36) + Math.random().toString(36).slice(2,6),
// which is base36 only and therefore always RTDB-key-safe. Kept here so the import script and
// tests can generate matching ids without pulling in index.html.
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const ILLEGAL_KEY_CHARS = /[.$#[\]/]/;
function isKeySafe(key) {
  return typeof key === 'string' && key.length > 0 && !ILLEGAL_KEY_CHARS.test(key);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Does a concrete path (array of keys) match a pattern with '*' wildcards?
function pathMatches(parts, pattern) {
  const pp = pattern.split('/');
  if (pp.length !== parts.length) return false;
  for (let i = 0; i < pp.length; i++) {
    if (pp[i] !== '*' && pp[i] !== parts[i]) return false;
  }
  return true;
}

function matchesAny(parts, patterns) {
  return patterns.some((p) => pathMatches(parts, p));
}

function nestedKeysFor(parts) {
  for (const pattern of Object.keys(NESTED_ARRAY_KEYS)) {
    if (pathMatches(parts, pattern)) return NESTED_ARRAY_KEYS[pattern];
  }
  return null;
}

// ── Array ⇄ map ─────────────────────────────────────────────

// Objects-with-ids → id-keyed map. `_o` preserves display order, since RTDB returns object
// keys in lexicographic order and uid()s are not lexicographically ordered by creation time.
function arrToMap(arr) {
  const out = {};
  const seen = new Set();
  arr.forEach((item, i) => {
    let key = isPlainObject(item) && item.id != null && item.id !== '' ? String(item.id) : 'k' + i;
    if (!isKeySafe(key) || seen.has(key)) key = 'k' + i; // collision / illegal char fallback
    seen.add(key);
    out[key] = { ...item, _o: i };
  });
  return out;
}

function mapToArr(obj) {
  if (!obj) return [];
  return Object.values(obj)
    .slice()
    .sort((a, b) => (a && a._o != null ? a._o : 0) - (b && b._o != null ? b._o : 0))
    .map((item) => {
      if (!isPlainObject(item)) return item;
      const { _o, ...rest } = item;
      return rest;
    });
}

// Primitives → index-keyed map. Index is the order, so no _o.
function primArrToMap(arr) {
  const out = {};
  arr.forEach((v, i) => { out[String(i)] = v; });
  return out;
}

function mapToPrimArr(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj.slice(); // RTDB may hand back a real array for 0..n keys
  return Object.keys(obj)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => obj[k]);
}

// ── Encode / decode ─────────────────────────────────────────

function encodeNode(value, parts) {
  if (Array.isArray(value)) {
    if (matchesAny(parts, PRIMITIVE_ARRAY_PATHS)) return primArrToMap(value);
    if (matchesAny(parts, ARRAY_PATHS)) {
      const mapped = arrToMap(value);
      const nested = nestedKeysFor(parts);
      const out = {};
      for (const [k, item] of Object.entries(mapped)) {
        out[k] = encodeNode(item, parts.concat(k));
        if (nested && isPlainObject(item)) {
          for (const nk of nested) {
            if (Array.isArray(item[nk])) out[k][nk] = arrToMap(item[nk]);
          }
        }
      }
      return out;
    }
    // An array in a location no pattern covers. Encoded index-keyed so it survives rather
    // than being silently mangled; audit-data.js reports these so a new one gets a pattern.
    return primArrToMap(value);
  }

  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue; // RTDB cannot store null — see header
      const enc = encodeNode(v, parts.concat(k));
      if (enc === undefined) continue;
      out[k] = enc;
    }
    return out;
  }

  return value === null ? undefined : value;
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
        for (const nk of nested) {
          if (decoded[nk] !== undefined && !Array.isArray(decoded[nk])) {
            decoded[nk] = mapToArr(decoded[nk]);
          }
        }
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

function encodeForRtdb(shared) {
  return encodeNode(shared, []);
}

function decodeFromRtdb(raw) {
  if (!raw) return {};
  return decodeNode(raw, []);
}

// Canonical form for comparing the Drive blob against the decoded RTDB tree. Strips null and
// undefined leaves and empty containers that RTDB cannot represent, so the nightly soak diff
// compares like with like. Use this on BOTH sides — never compare a raw Drive blob directly
// against a decoded RTDB tree, or all 852 nulls show up as differences.
function normalizeForCompare(value) {
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      out[k] = normalizeForCompare(v);
    }
    return out;
  }
  return value;
}
// lib/rtdb-diff.js — Phase 1
// Turns two encoded snapshots into a flat { '/path/to/leaf': value } update object suitable
// for a single multi-location update(). Pure functions, no Firebase import.


// ── The differ ──────────────────────────────────────────────
//
// null means DELETE — RTDB treats it that way natively.
//
// THE ONE BUG THAT WOULD LOSE DATA (from the plan, and it is right to shout about it):
// diffToUpdates compares against _lastRtdbSnapshot. That snapshot MUST be patched by inbound
// listeners too. Otherwise a change arriving from the partner's device looks like a local
// deletion on the next save and gets written back as null. Every listener callback in Phase 4
// patches _lastRtdbSnapshot BEFORE it patches S.shared. Test 7 covers exactly this.
//
// NULL/UNDEFINED EQUIVALENCE: the real data file has 852 null leaves and RTDB stores none of
// them — a null round-trips as absent. Treating those as different would emit a spurious
// delete for every one of them on the first save after every app open. Both are "not there".
function diffToUpdates(oldObj, newObj, prefix = '', out = {}) {
  const keys = new Set([
    ...Object.keys(oldObj || {}),
    ...Object.keys(newObj || {}),
  ]);

  for (const k of keys) {
    const path = prefix + '/' + k;
    const a = oldObj ? oldObj[k] : undefined;
    const b = newObj ? newObj[k] : undefined;

    const aMissing = a === undefined || a === null;
    const bMissing = b === undefined || b === null;

    if (aMissing && bMissing) continue;          // both absent — nothing to say
    if (a === b) continue;                       // identical scalars (and identical refs)

    if (bMissing) { out[path] = null; continue; }            // deleted

    if (aMissing || !isPlainObject(a) || !isPlainObject(b)) {
      if (!isPlainObject(b) && !isPlainObject(a) && a === b) continue;

      // COLD-LOAD GRANULARITY. On the first save of a session _lastRtdbSnapshot is empty, so
      // every top-level key is "new" and would be emitted wholesale as '/logs', '/chapters',
      // and so on. Those paths span BOTH profiles, so the write-scope filter has to drop them
      // entirely — including this profile's own half — and the first save would write almost
      // nothing. Descending two levels first yields '/logs/umang' and '/logs/chetna'
      // separately, so the filter keeps mine and drops only the partner's.
      const depth = path.split('/').filter(Boolean).length;
      if (isPlainObject(b) && depth < 2) {
        diffToUpdates(isPlainObject(a) ? a : {}, b, path, out);
        continue;
      }

      out[path] = b;                                          // new value, or scalar change
      continue;
    }

    diffToUpdates(a, b, path, out);                           // recurse into objects
  }

  return out;
}

// ── Write-scope filter ──────────────────────────────────────
//
// WHY THIS EXISTS — a landmine in the plan's Phase 3 that would have failed every save.
//
// Phase 3 calls update(ref(db), updates) at the ROOT with a flat multi-path object. RTDB
// evaluates a multi-location update ATOMICALLY: if ANY single path in it is denied, the
// ENTIRE update fails. Meanwhile every per-profile subtree rule is `.write: auth.uid === $p`.
//
// S.shared holds the PARTNER's data in memory, and _lastRtdbSnapshot starts empty on a cold
// load. So the first save after every app open would emit /logs/chetna/..., /diary/chetna/...
// and dozens more from Umang's device — all denied, taking every legitimate path down with
// them. Not an edge case: it is the default behaviour on the first save of every session.
//
// So the differ output is filtered to paths this profile is actually allowed to write before
// it ever reaches update(). Dropped paths are not lost data — they are the partner's own
// writes, which arrive through their own device and, from Phase 4, through listeners.
//
// These three sets MUST stay in sync with database.rules.json. If a rule changes and this
// does not, the symptom is a whole failing save rather than one rejected path.

// Top-level keys whose SECOND path segment is a profile id, writable only by that profile.
const PROFILE_SCOPED_KEYS = new Set([
  'logs', 'chapters', 'lectures', 'timerState', 'habits', 'habitLog', 'tasks',
  'plannerTargets', 'mockScores', 'targets', 'papers', 'profileInfo', 'prefs',
  'dailyTargetOverride', 'celebratedMilestones', 'lectureCompletionTarget', 'pushPrefs',
  'diary', 'pushSubscriptions',
]);

// Top-level keys both profiles may write.
const SHARED_WRITE_KEYS = new Set([
  'chat', 'pushState', 'notes', 'questions', 'qStats', 'examDate', 'dailyQuote',
  'adminAnnouncement', 'money',
]);

// Anything else is denied by the rules and must never be sent. 'liveStatus' is the live
// example: dead legacy data still sitting in olympus-data.json, renamed to timerState by
// migrateShared() long ago but never deleted from the stored blob. It has no rule block, so
// including it would fail the whole update.
function canWritePath(path, me) {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return false;
  const top = parts[0];
  if (SHARED_WRITE_KEYS.has(top)) return true;
  if (!PROFILE_SCOPED_KEYS.has(top)) return false;
  // A write to the whole subtree (e.g. '/logs') spans both profiles — never allowed.
  if (parts.length < 2) return false;
  return parts[1] === me;
}

// Returns { updates, dropped } — dropped is kept for logging during the Phase 3 soak, so an
// unexpected pattern shows up rather than vanishing silently.
function scopeUpdatesToProfile(updates, me) {
  const out = {};
  const dropped = [];
  for (const [path, value] of Object.entries(updates)) {
    if (canWritePath(path, me)) out[path] = value;
    else dropped.push(path);
  }
  return { updates: out, dropped };
}

// Convenience: diff, then scope, in one call. This is what Phase 3's saveShared() uses.
function buildScopedUpdates(lastSnapshot, nextEncoded, me) {
  const all = diffToUpdates(lastSnapshot || {}, nextEncoded || {});
  return scopeUpdatesToProfile(all, me);
}

// Applies a flat update object to a snapshot in place-ish (returns a new object), so listener
// callbacks can patch _lastRtdbSnapshot with exactly what they received. Phase 4 needs this.
function applyUpdatesToSnapshot(snapshot, updates) {
  const root = snapshot ? JSON.parse(JSON.stringify(snapshot)) : {};
  for (const [path, value] of Object.entries(updates)) {
    const parts = path.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (!isPlainObject(node[k])) node[k] = {};
      node = node[k];
    }
    const last = parts[parts.length - 1];
    if (value === null) delete node[last];
    else node[last] = value;
  }
  return root;
}

// ═══ Drive + Firebase ═══════════════════════════════════════
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

// Deep diff producing a flat list of differing paths, for the verification step.
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

  const { mode, confirm, allowOverwrite } = req.body || {};
  const dryRun = mode !== 'import';
  if (!dryRun && confirm !== 'yes-overwrite-rtdb') {
    res.status(400).json({ error: 'Real import requires confirm: "yes-overwrite-rtdb"' });
    return;
  }

  const report = { mode: dryRun ? 'dry-run' : 'import', ranAs: profile, steps: [] };
  const step = (name, detail) => report.steps.push({ name, ...detail });

  try {
    ensureAdminApp();
    const db = getDatabase();

    // 1. Read Drive
    const { data: driveData, modifiedTime } = await readDriveData();
    if (!driveData || typeof driveData !== 'object' || !driveData.logs || !driveData.targets) {
      throw new Error('Drive file did not look like valid Olympus data — aborting.');
    }
    step('read-drive', { modifiedTime, topLevelKeys: Object.keys(driveData).length });

    // 2. Is RTDB already populated?
    const existing = await db.ref('/').get();
    const existingKeys = existing.exists() ? Object.keys(existing.val() || {}) : [];
    step('check-rtdb', { alreadyPopulated: existingKeys.length > 0, keys: existingKeys.length });
    if (existingKeys.length > 0 && !allowOverwrite) {
      res.status(409).json({
        error: 'RTDB already contains data. Re-run with "allowOverwrite": true if that is intended.',
        report,
      });
      return;
    }

    // 3. Drop keys with no rule block. liveStatus is the known one: dead legacy data that
    //    migrateShared() stopped reading long ago but never deleted from the stored blob.
    const writable = new Set([...PROFILE_SCOPED_KEYS, ...SHARED_WRITE_KEYS]);
    const source = {};
    const skipped = [];
    for (const k of Object.keys(driveData)) {
      if (writable.has(k)) source[k] = driveData[k];
      else skipped.push(k);
    }
    step('filter-unwritable', { skipped });

    // 4. Encode + round-trip check BEFORE writing anything.
    const encoded = encodeForRtdb(source);
    const localRoundTrip = deepDiffPaths(
      normalizeForCompare(source),
      normalizeForCompare(decodeFromRtdb(encoded))
    );
    step('local-round-trip', { differences: localRoundTrip.length, sample: localRoundTrip.slice(0, 5) });
    if (localRoundTrip.length > 0) {
      throw new Error('Codec round trip is lossy on this data — refusing to import. See local-round-trip.');
    }

    if (dryRun) {
      step('dry-run', { wouldWriteBytes: Buffer.byteLength(JSON.stringify(encoded), 'utf8') });
      res.status(200).json({ ok: true, note: 'Nothing was written. Re-run with mode:"import" and the confirm phrase.', report });
      return;
    }

    // 5. Write at the root.
    await db.ref('/').set(encoded);
    step('write', { bytes: Buffer.byteLength(JSON.stringify(encoded), 'utf8') });

    // 6. Read back and verify against the source.
    const back = await db.ref('/').get();
    const decoded = decodeFromRtdb(back.val());
    const diffs = deepDiffPaths(normalizeForCompare(source), normalizeForCompare(decoded));
    step('verify', { differences: diffs.length, sample: diffs.slice(0, 10) });

    // 7. Order spot-check on the most visible subtrees.
    const orderIssues = [];
    for (const p of Object.keys(source.lectures || {})) {
      for (const paper of ['dt', 'idt']) {
        const before = ((source.lectures[p] || {})[paper] || []).map((l) => l.id);
        const after = (((decoded.lectures || {})[p] || {})[paper] || []).map((l) => l.id);
        if (JSON.stringify(before) !== JSON.stringify(after)) orderIssues.push(`lectures/${p}/${paper}`);
      }
    }
    step('order-check', { subtreesChecked: 'lectures dt+idt', issues: orderIssues });

    const ok = diffs.length === 0 && orderIssues.length === 0;
    res.status(ok ? 200 : 500).json({
      ok,
      note: ok
        ? 'Import verified. RTDB matches Drive exactly. Drive is still the live store — nothing reads RTDB yet.'
        : 'Import completed but verification FAILED. Do not proceed to Phase 3. See the verify step.',
      report,
    });
  } catch (err) {
    console.error('import-rtdb failed:', err);
    res.status(500).json({ ok: false, error: err.message, report });
  }
}
