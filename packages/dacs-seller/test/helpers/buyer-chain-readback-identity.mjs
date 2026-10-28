// TEST capture for the DACS_BUYER_CHAIN_READBACK=off byte-identity check. It
// records what a switch-off purchase shows, sends, writes and keeps. Every
// request, answer and row is kept, in wire order (object keys, arrays, rows by
// rowid, journal entries by write sequence), so an added or repeated request
// or row changes the capture.
//
// Only values that differ between runs are replaced. normalizeRuns takes the
// raw captures of two or more independent runs (fresh keys, ids and clocks
// each time). A key, hash, signature, address, job id, generated id or key id
// that appears in every run is stable (a chain identity, a fixed hash, a
// constant key) and is kept literally, so two trees that differ in it differ
// in the capture. One that appears in only some runs is run-random (the
// chance that two runs draw the same such value is negligible) and becomes a
// token of its kind numbered by first appearance (<hex#3>, <job#1>), so equal
// values share a token and different values get different ones. A hex value
// keeps its prefix (did:demos:agent:<hex#3> and 0x<hex#3> are the same key).
// Ports, per-request nonces and clock readings are always replaced: a port
// can be reused by chance, and whether two clock readings are equal depends on
// timing, so they become <port#n>, <nonce#n>, <time> or <n>. Of a purchase's
// attempts only step and outcome are kept; their time and reason text are not
// compared. Everything else is kept byte for byte.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '@kynesyslabs/dacs';

// [pattern, replace(token, match, ...groups)] in order; each runs on the
// text the previous ones left. token(kind, raw) numbers raw within its kind.
const PATTERNS = [
  [/did:demos:agent:([0-9a-f]{64})(?![0-9a-f])/g, (token, _, hex) => `did:demos:agent:${token('hex', hex)}`],
  [/0x([0-9a-f]{128}|[0-9a-f]{64})(?![0-9a-f])/g, (token, _, hex) => `0x${token('hex', hex)}`],
  [/stor-([0-9a-f]{40})(?![0-9a-f])/g, (token, _, hex) => `stor-${token('stor', hex)}`],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (token, raw) => token('uuid', raw)],
  // Hashes, keys, signatures and random hex ids (the seller transport's 48-hex effect owner).
  [/(?<![0-9a-f])([0-9a-f]{32,})(?![0-9a-f])/g, (token, _, hex) => token('hex', hex)],
  [/(?:(?<![0-9A-Z])|(?<=%3A))[0-7][0-9A-HJKMNP-TV-Z]{25}(?![0-9A-Z])/g, (token, raw) => token('job', raw)],
  [/(https?:\/\/)?127\.0\.0\.1:(\d+)/g, (token, _, scheme, port) => `${scheme ?? ''}127.0.0.1:${token('port', port)}`],
  [/\nnonce: ([A-Za-z0-9_-]{16,})/g, (token, _, raw) => `\nnonce: ${token('nonce', raw)}`],
  [/dacs-(es|rs)256-([a-z0-9]{8})/g, (token, _, alg, raw) => `dacs-${alg}256-${token('kid', raw)}`],
  [/(?<![A-Za-z0-9_-])([a-z]{2,6})_([A-Za-z0-9_-]{16})(?![A-Za-z0-9_-])/g, (token, _, prefix, raw) => `${prefix}_${token(`id:${prefix}`, raw)}`],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, () => '<time>'],
  // Random base64(url) of 40+ characters has both letter cases and a digit or
  // a lower-to-upper case change (missing both: about 1e-6). Long constants
  // (kinds, profiles, sources, "Listing/Vet/Agreement/...") have neither and are kept.
  [/(?<![A-Za-z0-9_+\/<#-])[A-Za-z0-9_+\/-]{40,}={0,2}(?![A-Za-z0-9_+\/=>-])/g,
    (token, raw) => (/[A-Z]/.test(raw) && /[a-z]/.test(raw) && (/\d/.test(raw) || /[a-z][A-Z]/.test(raw)) ? token('b64', raw) : raw)],
  [/(?<![0-9#])\d{10,}(?![0-9])/g, (token, raw) => (clock(Number(raw)) ? '<n>' : raw)],
];
// Epoch seconds, milliseconds or microseconds of this era; other large
// numbers (amounts, fees) are content and are kept.
const clock = (n) => [1e9, 1e12, 1e15].some((unit) => n >= 1.6 * unit && n < 2.2 * unit);
// Per-request random strings, by field name.
const RANDOM = new Set(['nonce', 'correlation']);
// Clock readings, by field name.
const CLOCK = new Set(['at', 'createdAt', 'updatedAt', 'expiresAt', 'expires_at', 'created_at', 'updated_at', 'observedAt', 'verifiedAt', 'timestampMs', 'durationMs', 'gapMs']);

// Kinds that are only ever run-random (low entropy, or random by field name).
const ALWAYS_RANDOM = new Set(['port', 'nonce', 'correlation']);

// stable: raw values to keep literally (normalizeRuns); onToken(kind, raw)
// observes every classifiable value met.
export function createNormalizer({ stable = new Set(), onToken = null } = {}) {
  const kinds = new Map();
  const token = (kind, raw) => {
    if (!ALWAYS_RANDOM.has(kind)) { onToken?.(kind, raw); if (stable.has(raw)) return raw; }
    let seen = kinds.get(kind);
    if (!seen) kinds.set(kind, seen = new Map());
    if (!seen.has(raw)) seen.set(raw, seen.size + 1);
    return `<${kind.replace(/^id:/, '')}#${seen.get(raw)}>`;
  };
  function normalize(value, key = null) {
    if (key !== null && CLOCK.has(key) && (typeof value === 'string' || typeof value === 'number')) return `<${key}>`;
    if (key !== null && RANDOM.has(key) && typeof value === 'string') return token(key, value);
    if (key === 'attempts' && Array.isArray(value)) return value.map((attempt) => ({ step: normalize(attempt?.step), outcome: normalize(attempt?.outcome) }));
    if (typeof value === 'string') {
      try { const parsed = JSON.parse(value); if (parsed !== null && typeof parsed === 'object') return { json: normalize(parsed) }; } catch { /* plain text */ }
      // A replacer gets (match, ...groups, offset, text); groups are passed on.
      return PATTERNS.reduce((text, [pattern, replace]) => text.replace(pattern, (...match) => replace(token, ...match.slice(0, -2))), value);
    }
    if (typeof value === 'number') return Number.isSafeInteger(value) && clock(value) ? '<n>' : value;
    if (typeof value === 'bigint') return clock(Number(value)) ? '<n>' : value.toString();
    if (value instanceof Uint8Array) return `<bytes:${value.byteLength}:${token('bytes', Buffer.from(value).toString('hex'))}>`;
    // Serialized byte arrays (keys, signatures, hashes as bytes).
    if (Array.isArray(value) && value.length >= 16 && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return `<bytes:${value.length}:${token('bytes', Buffer.from(value).toString('hex'))}>`;
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [normalize(k), normalize(v, k)]));
    return value;
  }
  return normalize;
}

// The first run's capture, with the values every run shares kept literally.
export function normalizeRuns(captures) {
  if (!Array.isArray(captures) || captures.length < 2) throw new Error('two or more independent runs are needed to tell run-random values from stable ones');
  const runs = captures.map((capture) => { const values = new Set(); createNormalizer({ onToken: (_, raw) => values.add(raw) })(capture); return values; });
  const stable = new Set([...runs[0]].filter((raw) => runs.every((values) => values.has(raw))));
  return createNormalizer({ stable })(captures[0]);
}

// Every row of every table, by rowid (write order).
export function sqliteRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    return Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((row) => ({ ...row }))]));
  } finally { db.close(); }
}

export function routeTable(app) {
  const stack = app.router?.stack ?? app._router?.stack ?? [];
  return stack.map((layer) => layer.route ? `${Object.keys(layer.route.methods).sort().join(',')} ${layer.route.path}` : `use ${layer.name}`);
}

// One run's raw capture; normalizeRuns compares it with the other runs'.
export async function captureIdentity(h, { tools, toolOutputs, commitAnswers, sellerAnswer, operation }) {
  const sellerState = join(h.stateDirectory, 'seller-state');
  const sellerFiles = existsSync(sellerState) ? readdirSync(sellerState).filter((name) => name.endsWith('.sqlite')).sort() : [];
  const journals = await h.readSellerJournals();
  return structuredClone({
    routes: routeTable(h.app.app),
    tools,
    toolOutputs,
    listing: h.composition.listing,
    agreement: operation.state.protocol.agreement.artifact,
    createPayloads: h.transport.chain.wire.record.accepted.map((tx) => ({ contentKeys: Object.keys(tx.content), data: tx.content.data })),
    transportBinding: { source: h.transport.capability.transportBinding, terms: operation.terms.protocol.transportBinding },
    sellerAnswers: { commit: commitAnswers, payment: sellerAnswer },
    // Every response the seller sent, as sent and in order.
    servedResponses: h.sellerResponses,
    rows: {
      application: sqliteRows(h.config.databasePath),
      sourceJournal: await h.transport.capability.journal.entries(),
      sellerArtifactJournal: journals.artifacts,
      sellerWalletJournal: journals.wallet,
      sellerTransport: sqliteRows(join(h.stateDirectory, 'seller-transport.sqlite')),
      sellerState: Object.fromEntries(sellerFiles.map((name) => [name, sqliteRows(join(sellerState, name))])),
    },
  });
}

// One SHA-256 per section (and per journal or database) over its JSON text,
// so key order counts. The fixture keeps only these.
export function sectionDigests(capture) {
  const digest = (value) => sha256Hex(JSON.stringify(value));
  const { rows, ...sections } = capture;
  return { ...Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, digest(value)])),
    ...Object.fromEntries(Object.entries(rows).map(([key, value]) => [`rows.${key}`, digest(value)])) };
}
