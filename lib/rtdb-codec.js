// lib/rtdb-codec.js — Phase 1
// Converts S.shared to and from RTDB shape. Pure functions, no Firebase import, no side
// effects. Nothing in index.html calls this yet.
//
// THE PROBLEM THIS SOLVES
// RTDB stores arrays as objects with numeric keys, and you cannot write element 47 without
// rewriting the whole array — which defeats the entire point of the migration. Arrays become
// id-keyed maps at the RTDB boundary and are converted back on read, so the ~7,000 lines of
// UI code keep seeing plain arrays and never know the difference.
//
// THREE THINGS FOUND IN THE REAL olympus-data.json THAT THE PLAN'S DRAFT DID NOT COVER.
// All three would have failed the Phase 1 round-trip test against production data.
//
//   1. profileInfo/<p>/weakSubjects is an ARRAY (["idt"], ["afm"]). The plan lists
//      profileInfo under "already maps and safe as-is". It is not — it contains an array of
//      plain strings.
//
//   2. chat/messages/<id>/reactions/<emoji> is an ARRAY of profile ids ({"👍": ["umang"]}).
//      A nested array two levels inside a message, keyed by an emoji. Not in the plan at all.
//      (The emoji key itself is fine — RTDB only rejects . $ # [ ] / in keys, and a scan of
//      every key in the real file found zero violations.)
//
//   3. Both of those are arrays of PRIMITIVES, not objects with ids. The plan's arrToMap does
//      `{ ...item, _o: i }`, and spreading a string produces {0:'i',1:'d',2:'t'} — silent
//      corruption rather than an error. Primitive arrays therefore need their own codec,
//      which is what PRIMITIVE_ARRAY_PATHS below is for.
//
// AND THE BIG ONE — NULLS. The real file contains 852 null-valued leaves (mostly
// logs/<p>/<id>/chapterId and paperId). RTDB CANNOT STORE NULL: writing null deletes the key.
// So a null leaf comes back absent, not null, and decode(encode(x)) would never deep-equal x.
// Worse, the differ would see absent-vs-null on every save and emit spurious deletes forever
// — the nightly soak diff would never come back empty and nobody would know why.
// encodeForRtdb() therefore STRIPS null leaves, and normalizeForCompare() produces the
// canonical form both stores are compared in. UI code is unaffected: it reads these fields
// with plain falsy checks, and `undefined` is as falsy as `null`.
//
// THE SAME APPLIES TO EMPTY CONTAINERS, and this one bit during the real Phase 2 import.
// RTDB cannot store an empty object or array: writing {} is IDENTICAL to writing nothing, so
// an empty topics[] came back absent and the verification reported 201 differences. A local
// JSON round-trip does not reproduce this — JSON happily preserves {} — which is exactly why
// the import endpoint reads back from the real database instead of trusting a simulation.
// normalizeForCompare() therefore drops empty containers too, and decodeFromRtdb() restores
// nested arrays as [] so the decoded shape still matches what the UI expects. migrateShared()
// in index.html already does `if(!c.topics) c.topics = []` at line ~2071, so runtime was
// never at risk — only the comparison was unfair.

// ── Path patterns ───────────────────────────────────────────
// '*' matches exactly one key level.

// Arrays of OBJECTS that carry a stable `id`. Verified against the real data file: every one
// of these has 100% id coverage and zero duplicates (logs 169, tasks 150, habits 10,
// chapters 238, lectures 417, chat messages 84). The four that are empty today
// (plannerTargets, questions, notes, mockScores) were confirmed by reading their creation
// sites in index.html — every push() assigns uid(). No Phase 2 backfill is needed for any of
// them, which removes a whole step from that phase.
export const ARRAY_PATHS = [
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
export const NESTED_ARRAY_KEYS = {
  'chapters/*/*': ['topics'],
};

// Arrays of PRIMITIVES (strings). Encoded as index-keyed maps of raw values — no _o field,
// because the index IS the order. See finding 3 above.
export const PRIMITIVE_ARRAY_PATHS = [
  'profileInfo/*/weakSubjects',
  'chat/messages/*/reactions/*',
];

// uid() in index.html is Date.now().toString(36) + Math.random().toString(36).slice(2,6),
// which is base36 only and therefore always RTDB-key-safe. Kept here so the import script and
// tests can generate matching ids without pulling in index.html.
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const ILLEGAL_KEY_CHARS = /[.$#[\]/]/;
export function isKeySafe(key) {
  return typeof key === 'string' && key.length > 0 && !ILLEGAL_KEY_CHARS.test(key);
}

export function isPlainObject(v) {
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
export function arrToMap(arr) {
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

export function mapToArr(obj) {
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
export function primArrToMap(arr) {
  const out = {};
  arr.forEach((v, i) => { out[String(i)] = v; });
  return out;
}

export function mapToPrimArr(obj) {
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
          // Always coerce, including when the node is ABSENT. RTDB cannot store an empty
          // container: an empty topics[] encodes to {}, and writing {} is identical to
          // writing nothing, so it reads back missing rather than empty. mapToArr(undefined)
          // returns [], which restores the shape the UI expects.
          if (!Array.isArray(decoded[nk])) decoded[nk] = mapToArr(decoded[nk]);
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

export function encodeForRtdb(shared) {
  return encodeNode(shared, []);
}

export function decodeFromRtdb(raw) {
  if (!raw) return {};
  return decodeNode(raw, []);
}

// Canonical form for comparing the Drive blob against the decoded RTDB tree. Strips null and
// undefined leaves and empty containers that RTDB cannot represent, so the nightly soak diff
// compares like with like. Use this on BOTH sides — never compare a raw Drive blob directly
// against a decoded RTDB tree, or all 852 nulls show up as differences.
export function normalizeForCompare(value) {
  if (Array.isArray(value)) {
    const arr = value.map(normalizeForCompare).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;      // empty array — RTDB cannot represent it
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      const n = normalizeForCompare(v);
      if (n === undefined) continue;
      out[k] = n;
    }
    return Object.keys(out).length ? out : undefined;   // empty object — same
  }
  return value;
}
