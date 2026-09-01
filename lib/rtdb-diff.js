// lib/rtdb-diff.js — Phase 1
// Turns two encoded snapshots into a flat { '/path/to/leaf': value } update object suitable
// for a single multi-location update(). Pure functions, no Firebase import.

import { isPlainObject } from './rtdb-codec.js';

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
export function diffToUpdates(oldObj, newObj, prefix = '', out = {}) {
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
export const PROFILE_SCOPED_KEYS = new Set([
  'logs', 'chapters', 'lectures', 'timerState', 'habits', 'habitLog', 'tasks',
  'plannerTargets', 'mockScores', 'targets', 'papers', 'profileInfo', 'prefs',
  'dailyTargetOverride', 'celebratedMilestones', 'lectureCompletionTarget', 'pushPrefs',
  'diary', 'pushSubscriptions',
]);

// Top-level keys both profiles may write.
export const SHARED_WRITE_KEYS = new Set([
  'chat', 'pushState', 'notes', 'questions', 'qStats', 'examDate', 'dailyQuote',
  'adminAnnouncement', 'money',
]);

// Anything else is denied by the rules and must never be sent. 'liveStatus' is the live
// example: dead legacy data still sitting in olympus-data.json, renamed to timerState by
// migrateShared() long ago but never deleted from the stored blob. It has no rule block, so
// including it would fail the whole update.
export function canWritePath(path, me) {
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
export function scopeUpdatesToProfile(updates, me) {
  const out = {};
  const dropped = [];
  for (const [path, value] of Object.entries(updates)) {
    if (canWritePath(path, me)) out[path] = value;
    else dropped.push(path);
  }
  return { updates: out, dropped };
}

// Convenience: diff, then scope, in one call. This is what Phase 3's saveShared() uses.
export function buildScopedUpdates(lastSnapshot, nextEncoded, me) {
  const all = diffToUpdates(lastSnapshot || {}, nextEncoded || {});
  return scopeUpdatesToProfile(all, me);
}

// Applies a flat update object to a snapshot in place-ish (returns a new object), so listener
// callbacks can patch _lastRtdbSnapshot with exactly what they received. Phase 4 needs this.
export function applyUpdatesToSnapshot(snapshot, updates) {
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
