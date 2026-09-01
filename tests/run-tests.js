// tests/run-tests.js — Phase 1 acceptance tests.
// Run with:  node tests/run-tests.js path/to/olympus-data.json
// Tests against the REAL production file, not a fixture — that is the plan's explicit
// instruction and the reason all three codec bugs were found.

import fs from 'fs';
import assert from 'assert';
import {
  encodeForRtdb, decodeFromRtdb, normalizeForCompare, isKeySafe, isPlainObject,
  ARRAY_PATHS, PRIMITIVE_ARRAY_PATHS,
} from '../lib/rtdb-codec.js';
import {
  diffToUpdates, scopeUpdatesToProfile, buildScopedUpdates, applyUpdatesToSnapshot, canWritePath,
} from '../lib/rtdb-diff.js';

const file = process.argv[2] || '/mnt/user-data/uploads/olympus-data.json';
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function deepEqual(a, b, label) { assert.deepStrictEqual(a, b, label || 'deep equality'); }

console.log('\nPhase 1 — codec and differ\n');

// ── 1. Round trip against the real file ─────────────────────
test('1. decodeFromRtdb(encodeForRtdb(data)) deep-equals the real file (normalized)', () => {
  const encoded = encodeForRtdb(raw);
  const decoded = decodeFromRtdb(encoded);
  deepEqual(normalizeForCompare(decoded), normalizeForCompare(raw));
});

test('1a. array ORDER survives — lectures for DT and IDT (most visible if wrong)', () => {
  const decoded = decodeFromRtdb(encodeForRtdb(raw));
  for (const profile of Object.keys(raw.lectures || {})) {
    for (const paper of ['dt', 'idt']) {
      const before = (raw.lectures[profile] || {})[paper];
      if (!Array.isArray(before) || !before.length) continue;
      const after = decoded.lectures[profile][paper];
      deepEqual(after.map((l) => l.id), before.map((l) => l.id), `${profile}/${paper} order`);
    }
  }
});

test('1b. chapter topics[] survive the nested-array conversion', () => {
  const decoded = decodeFromRtdb(encodeForRtdb(raw));
  let checked = 0;
  for (const p of Object.keys(raw.chapters || {})) {
    for (const paper of Object.keys(raw.chapters[p] || {})) {
      (raw.chapters[p][paper] || []).forEach((ch, i) => {
        const after = decoded.chapters[p][paper][i];
        assert(Array.isArray(after.topics), 'topics must decode as an array');
        deepEqual(after.topics, ch.topics || []);
        checked++;
      });
    }
  }
  assert(checked > 0, 'no chapters checked');
});

test('1c. primitive arrays the plan missed — weakSubjects and emoji reactions', () => {
  const decoded = decodeFromRtdb(encodeForRtdb(raw));
  for (const p of Object.keys(raw.profileInfo || {})) {
    const before = raw.profileInfo[p].weakSubjects;
    if (before === undefined) continue;
    assert(Array.isArray(decoded.profileInfo[p].weakSubjects), 'weakSubjects must stay an array');
    deepEqual(decoded.profileInfo[p].weakSubjects, before);
  }
  const msgs = (raw.chat && raw.chat.messages) || [];
  msgs.forEach((m, i) => {
    if (!m.reactions) return;
    const after = decoded.chat.messages[i].reactions;
    for (const emoji of Object.keys(m.reactions)) {
      assert(Array.isArray(after[emoji]), `reactions.${emoji} must stay an array`);
      deepEqual(after[emoji], m.reactions[emoji]);
    }
  });
});

// ── 2-6. The plan's differ tests ────────────────────────────
test('2. differ on identical snapshots returns {}', () => {
  const enc = encodeForRtdb(raw);
  deepEqual(diffToUpdates(enc, clone(enc)), {});
});

test('3. changing one chapter checkbox produces exactly one path', () => {
  const before = encodeForRtdb(raw);
  const next = clone(raw);
  const p = Object.keys(next.chapters)[0];
  const paper = Object.keys(next.chapters[p]).find((k) => (next.chapters[p][k] || []).length);
  const ch = next.chapters[p][paper][0];
  ch.rev1 = !ch.rev1;
  const updates = diffToUpdates(before, encodeForRtdb(next));
  const paths = Object.keys(updates);
  assert.strictEqual(paths.length, 1, `expected 1 path, got ${paths.length}: ${paths.slice(0, 5)}`);
  assert(paths[0].endsWith('/rev1'), `expected a /rev1 path, got ${paths[0]}`);
});

test('4. changing chat.typingUntil produces one path under 100 bytes', () => {
  const before = encodeForRtdb(raw);
  const next = clone(raw);
  next.chat.typingUntil = next.chat.typingUntil || {};
  next.chat.typingUntil.umang = '2026-09-01T18:04:22Z';
  const updates = diffToUpdates(before, encodeForRtdb(next));
  const paths = Object.keys(updates);
  assert.strictEqual(paths.length, 1, `expected 1 path, got ${paths.length}`);
  const bytes = Buffer.byteLength(JSON.stringify(updates), 'utf8');
  assert(bytes < 100, `payload was ${bytes} bytes — the whole point is that this is tiny`);
});

test('5. deleting a log entry produces one null path and no siblings', () => {
  const before = encodeForRtdb(raw);
  const next = clone(raw);
  const p = Object.keys(next.logs).find((k) => (next.logs[k] || []).length > 1);
  const removed = next.logs[p].pop();          // last item — no _o reshuffle of the others
  const updates = diffToUpdates(before, encodeForRtdb(next));
  const paths = Object.keys(updates);
  assert.strictEqual(paths.length, 1, `expected 1 path, got ${paths.length}: ${paths.slice(0, 5)}`);
  assert.strictEqual(updates[paths[0]], null, 'value must be null (RTDB delete)');
  assert(paths[0].includes(String(removed.id)), 'path must target the removed id');
});

test('6. adding a log entry produces one path containing the whole new object', () => {
  const before = encodeForRtdb(raw);
  const next = clone(raw);
  const p = Object.keys(next.logs)[0];
  const entry = { id: 'testid123', date: '2026-09-01', paperId: 'fr', chapterId: null, hours: 2.5 };
  next.logs[p].push(entry);
  const updates = diffToUpdates(before, encodeForRtdb(next));
  const paths = Object.keys(updates);
  assert.strictEqual(paths.length, 1, `expected 1 path, got ${paths.length}`);
  const written = updates[paths[0]];
  assert.strictEqual(written.hours, 2.5);
  assert.strictEqual(written.id, 'testid123');
  assert(!('chapterId' in written), 'null leaf must be stripped — RTDB cannot store null');
});

// ── 7. THE CRITICAL ONE ─────────────────────────────────────
test('7. inbound listener patch then local save does NOT emit a null for the inbound change', () => {
  // Umang is signed in. Chetna adds a chat message; a listener delivers it.
  const me = 'umang';
  const shared = clone(raw);
  let snapshot = encodeForRtdb(shared);

  const inbound = { id: 'inbound1', from: 'chetna', text: 'hi', ts: Date.now(), _o: 999 };
  const inboundPath = '/chat/messages/inbound1';

  // Rule: patch _lastRtdbSnapshot FIRST, then S.shared.
  snapshot = applyUpdatesToSnapshot(snapshot, { [inboundPath]: inbound });
  shared.chat.messages.push({ id: 'inbound1', from: 'chetna', text: 'hi', ts: inbound.ts });

  // Now Umang does something unrelated locally and saves.
  shared.targets[me] = (shared.targets[me] || 4) + 1;
  const { updates } = buildScopedUpdates(snapshot, encodeForRtdb(shared), me);

  for (const [path, value] of Object.entries(updates)) {
    assert(!(path.startsWith('/chat/messages/inbound1') && value === null),
      `inbound change was written back as a delete: ${path}`);
  }
  assert(updates['/targets/' + me] === 5 || Object.keys(updates).some((p) => p.startsWith('/targets/')),
    'the local change itself should still be emitted');
});

test('7a. WITHOUT the snapshot patch, the same scenario DOES emit a delete (proves 7 is real)', () => {
  const me = 'umang';
  const shared = clone(raw);
  const snapshot = encodeForRtdb(shared);            // deliberately NOT patched
  shared.chat.messages.push({ id: 'inbound2', from: 'chetna', text: 'hi', ts: Date.now() });
  shared.chat.messages = shared.chat.messages.filter((m) => m.id !== 'inbound2');
  const stale = clone(snapshot);
  stale.chat.messages.inbound2 = { id: 'inbound2', _o: 999 };   // server has it, we do not
  const { updates } = buildScopedUpdates(stale, encodeForRtdb(shared), me);
  assert.strictEqual(updates['/chat/messages/inbound2'], null,
    'the unpatched case must produce the delete — otherwise test 7 proves nothing');
});

// ── Write-scope filter ──────────────────────────────────────
test('8. write-scope drops the partner\'s paths (the atomic-update landmine)', () => {
  const me = 'umang';
  const before = {};                                   // cold load: snapshot starts empty
  const { updates, dropped } = buildScopedUpdates(before, encodeForRtdb(raw), me);
  const bad = Object.keys(updates).filter((p) => p.includes('/chetna'));
  assert.strictEqual(bad.length, 0, `partner paths leaked into the update: ${bad.slice(0, 3)}`);
  assert(dropped.length > 0, 'expected some paths to be dropped on a cold-load first save');
  assert(dropped.some((p) => p.startsWith('/logs/chetna')), 'chetna logs should be dropped');
});

test('8a. liveStatus (dead legacy key, no rule block) never reaches update()', () => {
  assert.strictEqual(canWritePath('/liveStatus/umang/state', 'umang'), false);
  const { updates } = buildScopedUpdates({}, encodeForRtdb(raw), 'umang');
  assert(!Object.keys(updates).some((p) => p.startsWith('/liveStatus')),
    'liveStatus would fail the whole atomic update');
});

test('8b. shared subtrees stay writable by both', () => {
  for (const me of ['umang', 'chetna']) {
    assert(canWritePath('/chat/messages/abc', me), 'chat');
    assert(canWritePath('/pushState/lastReminderSentDate/' + me, me), 'pushState');
    assert(canWritePath('/examDate', me), 'examDate');
    assert(!canWritePath('/logs', me), 'a whole-subtree write spans both profiles');
  }
});

// ── Key safety ──────────────────────────────────────────────
test('9. every key in the real file is RTDB-safe (no . $ # [ ] /)', () => {
  const bad = [];
  (function scan(node, path) {
    if (Array.isArray(node)) return node.forEach((v, i) => scan(v, path + '/' + i));
    if (!isPlainObject(node)) return;
    for (const k of Object.keys(node)) {
      if (!isKeySafe(k)) bad.push(path + '/' + k);
      scan(node[k], path + '/' + k);
    }
  })(raw, '');
  assert.strictEqual(bad.length, 0, `illegal keys: ${bad.slice(0, 5)}`);
});

test('10. encoded payload is small enough to be worth the migration', () => {
  const before = encodeForRtdb(raw);
  const next = clone(raw);
  next.chat.typingUntil.umang = new Date().toISOString();
  const { updates } = buildScopedUpdates(before, encodeForRtdb(next), 'umang');
  const bytes = Buffer.byteLength(JSON.stringify(updates), 'utf8');
  const whole = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  console.log(`        typing ping: ${bytes} bytes vs ${(whole / 1024).toFixed(0)} KB whole-blob ` +
              `(${Math.round(whole / bytes).toLocaleString()}x smaller)`);
  assert(bytes < 200);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
