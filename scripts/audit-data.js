// scripts/audit-data.js
// Reports the shape of a real olympus-data.json against what the codec expects.
// Run with:  node scripts/audit-data.js path/to/olympus-data.json
//
// Re-run this before Phase 2 on a FRESH download. The data grows daily, and a new array
// subtree or an unsafe key introduced between now and then would otherwise only surface as a
// failed import.

import fs from 'fs';
import {
  ARRAY_PATHS, PRIMITIVE_ARRAY_PATHS, NESTED_ARRAY_KEYS,
  encodeForRtdb, decodeFromRtdb, normalizeForCompare, isKeySafe, isPlainObject,
} from '../lib/rtdb-codec.js';
import { PROFILE_SCOPED_KEYS, SHARED_WRITE_KEYS } from '../lib/rtdb-diff.js';

const file = process.argv[2] || '/mnt/user-data/uploads/olympus-data.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const bytes = fs.statSync(file).size;

console.log(`\nAuditing ${file}  (${(bytes / 1024).toFixed(0)} KB)\n`);

// ── 1. Every array location, matched or not ─────────────────
const known = new Set([...ARRAY_PATHS, ...PRIMITIVE_ARRAY_PATHS]);
// A nested array sits inside an ITEM of the parent array, so the concrete path carries an
// extra segment for the item's index: chapters/<p>/<paper>/<i>/topics, not
// chapters/<p>/<paper>/topics. Register both so the report collapses them correctly.
for (const [parent, keys] of Object.entries(NESTED_ARRAY_KEYS)) {
  for (const k of keys) {
    known.add(parent + '/' + k);
    known.add(parent + '/*/' + k);
  }
}
function patternOf(parts) {
  // Collapse a concrete path into its pattern by replacing id-ish segments with '*'.
  return parts.map((p, i) => (i === 0 ? p : '*')).join('/');
}

const arrayLocs = new Map();
(function scan(node, parts) {
  if (Array.isArray(node)) {
    const generic = genericPattern(parts);
    const e = arrayLocs.get(generic) || { count: 0, items: 0, withId: 0, primitive: 0 };
    e.count++; e.items += node.length;
    node.forEach((it) => {
      if (isPlainObject(it)) { if (it.id != null && it.id !== '') e.withId++; }
      else e.primitive++;
    });
    arrayLocs.set(generic, e);
    node.forEach((v, i) => scan(v, parts.concat(String(i))));
    return;
  }
  if (!isPlainObject(node)) return;
  for (const k of Object.keys(node)) scan(node[k], parts.concat(k));
})(data, []);

// Build the generic pattern by testing each known pattern first, else wildcarding.
function genericPattern(parts) {
  for (const pat of known) {
    const pp = pat.split('/');
    if (pp.length !== parts.length) continue;
    let ok = true;
    for (let i = 0; i < pp.length; i++) if (pp[i] !== '*' && pp[i] !== parts[i]) { ok = false; break; }
    if (ok) return pat;
  }
  return parts.map((p, i) => (i === 0 ? p : (/^\d+$/.test(p) || p.length > 8 ? '*' : p))).join('/');
}

console.log('ARRAY SUBTREES');
let unknownArrays = 0;
for (const [pat, e] of [...arrayLocs.entries()].sort()) {
  const isKnown = known.has(pat);
  const kind = PRIMITIVE_ARRAY_PATHS.includes(pat) ? 'primitive'
    : e.primitive > 0 && e.withId === 0 ? 'primitive'
    : 'objects';
  const idCov = kind === 'objects' && e.items ? `${e.withId}/${e.items} ids` : `${e.items} values`;
  console.log(`  ${isKnown ? 'known  ' : 'UNKNOWN'}  ${pat.padEnd(34)} locs=${String(e.count).padStart(3)}  ${idCov.padEnd(16)} ${kind}`);
  if (!isKnown) unknownArrays++;
}
if (unknownArrays) {
  console.log(`\n  !! ${unknownArrays} array location(s) have no codec pattern.`);
  console.log('     Add each to ARRAY_PATHS or PRIMITIVE_ARRAY_PATHS in lib/rtdb-codec.js.');
}

// ── 2. Key safety ───────────────────────────────────────────
const badKeys = [];
(function scan(node, path) {
  if (Array.isArray(node)) return node.forEach((v, i) => scan(v, `${path}/${i}`));
  if (!isPlainObject(node)) return;
  for (const k of Object.keys(node)) {
    if (!isKeySafe(k)) badKeys.push(`${path}/${k}`);
    scan(node[k], `${path}/${k}`);
  }
})(data, '');
console.log(`\nKEY SAFETY (RTDB rejects . $ # [ ] /)`);
console.log(badKeys.length ? `  !! ${badKeys.length} illegal: ${badKeys.slice(0, 10).join(', ')}`
                           : '  all keys safe');

// ── 3. Nulls ────────────────────────────────────────────────
let nulls = 0;
(function scan(node) {
  if (Array.isArray(node)) return node.forEach(scan);
  if (!isPlainObject(node)) return;
  for (const v of Object.values(node)) { if (v === null) nulls++; else scan(v); }
})(data);
console.log(`\nNULL LEAVES`);
console.log(`  ${nulls} null values — RTDB cannot store these; the codec strips them and`);
console.log('  normalizeForCompare() must be used on BOTH sides of any Drive-vs-RTDB diff.');

// ── 4. Rule coverage ────────────────────────────────────────
const covered = new Set([...PROFILE_SCOPED_KEYS, ...SHARED_WRITE_KEYS]);
const uncovered = Object.keys(data).filter((k) => !covered.has(k));
console.log(`\nRULE COVERAGE (top-level keys vs database.rules.json)`);
console.log(uncovered.length
  ? `  !! not writable by anyone, will NOT be imported: ${uncovered.join(', ')}`
  : '  every top-level key has a rule block');

// ── 5. Round trip ───────────────────────────────────────────
const rt = normalizeForCompare(decodeFromRtdb(encodeForRtdb(data)));
const ref = normalizeForCompare(data);
const identical = JSON.stringify(rt) === JSON.stringify(ref);
console.log(`\nROUND TRIP`);
console.log(`  encode → decode is ${identical ? 'LOSSLESS' : 'LOSSY — DO NOT PROCEED TO PHASE 2'}`);
const encBytes = Buffer.byteLength(JSON.stringify(encodeForRtdb(data)), 'utf8');
console.log(`  encoded size ${(encBytes / 1024).toFixed(0)} KB (vs ${(bytes / 1024).toFixed(0)} KB on Drive)\n`);

process.exit(identical && !badKeys.length && !unknownArrays ? 0 : 1);
