// The delta record file: one file under records/ describes one commit, as one
// DELTA-LEDGER.json change and one DELTA-COMMITS.json row do in the archive.
//
//   {
//     "schema": "dacs-client-delta-record/v1",
//     "delta": "WF",                        delta id
//     "subject": "delta(client): WF ...",   exact commit subject (the selector)
//     "sha": "<40 hex>",                    optional; selects that commit, whose subject must match
//     "kind": "change",                     change | checkpoint | resolution | commit-only
//     "files": [{"path", "before", "after"}],  blobs, or null for an absent file; not in commit-only
//     "commitFiles": ["..."],               every path the commit changes (the package README may be left out)
//     "note": "...",                        optional text about the change
//     "supersedes": ["<record file>"]       optional; earlier records this one replaces
//   }
//
// A record is named `<delta>-<first 12 hex of sha>.json` when it carries a sha,
// and `<delta>-<first 12 hex of sha256(subject)>.json` otherwise.
//
// records/ANCHOR.json is not a record. It holds the blob of each record-named
// path outside src/ and test/ at one commit, and stands in for their history
// before that commit:
//
//   {"schema": "dacs-client-anchor/v1", "commit": "<40 hex>", "files": {"<path>": "<blob>"}}
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RECORD_SCHEMA = 'dacs-client-delta-record/v1';
export const PACKAGE_PREFIX = 'packages/dacs-client/';
export const RECORD_NAME = /^([A-Z][A-Z0-9]*)-([0-9a-f]{12})\.json$/;
const BLOB = /^[0-9a-f]{40}$/;
const KINDS = ['change', 'checkpoint', 'resolution', 'commit-only'];
const KEYS = ['schema', 'delta', 'subject', 'sha', 'kind', 'files', 'commitFiles', 'note', 'supersedes'];

// Package paths the freeze pins by exact blob. A change to one needs a reviewed
// re-pin, so no record names one. Every module a core script loads is core
// (core-imports.test.mjs).
export const CORE_FILES = Object.freeze([
  'HOLD.json', 'DELTA-LEDGER.json', 'DELTA-COMMITS.json',
  'LICENSE', 'IMPORT-CUT-MAP.md', 'D15-SOURCES.json', 'PROVENANCE.json',
  'records/ANCHOR.json',
  'scripts/check-hold.mjs', 'scripts/delta-freeze.mjs', 'scripts/delta-assemble.mjs', 'scripts/delta-record.mjs', 'scripts/delta-map.mjs',
  'scripts/check-provenance.mjs', 'scripts/pin-delta.mjs', 'scripts/source-git.mjs', 'scripts/publication-text.mjs',
  'scripts/path-mapping.mjs', 'scripts/test.mjs', 'scripts/copy-verbatim.mjs', 'scripts/import-cut-map.mjs',
  'scripts/check-imports.mjs',
  'scripts/check-hold.test.mjs', 'scripts/delta-continuity.test.mjs', 'scripts/delta-frontier.test.mjs',
  'scripts/delta-provenance.test.mjs', 'scripts/check-provenance.test.mjs', 'scripts/test-layout.test.mjs',
  'scripts/delta-record.test.mjs', 'scripts/delta-assemble.test.mjs', 'scripts/core-imports.test.mjs',
  'scripts/delta-freeze.test.mjs', 'scripts/delta-anchor.test.mjs', 'scripts/delta-switch.test.mjs',
  'test/delta-ledger-gate.test.mjs',
]);
export const isCorePath = path => CORE_FILES.includes(path) || path.startsWith('evidence/') || path === 'records/.gitkeep';
// Sources, tests, the README, the manifest, the notes and scripts outside the core.
const RECORD_NAMED = /^(?:src\/|test\/|scripts\/|README\.md$|package\.json$|DELTA-NOTES\.md$)/;
/**
 * True when records may name the package-relative `path` (core paths never
 * are). The package README is exempt from these blob checks.
 */
export const isRecordNamed = path => !isCorePath(path) && RECORD_NAMED.test(path);
// Only the package README is exempt from record/anchor/baseline blob checks.
// Use repository-relative paths so the root README and nested READMEs do not match.
export const isUnrecordedRepositoryPath = path => path === `${PACKAGE_PREFIX}README.md`;
/** True for a record-named path outside src/ and test/: the anchor holds its blob before any record. */
export const isAnchored = path => isRecordNamed(path) && !/^(?:src|test)\//.test(path);
/** True for a package-relative path under records/ that is a record file, not a core pin. */
export const isRecordFile = path => path.startsWith('records/') && !isCorePath(path);

export const recordName = record => `${record.delta}-${(record.sha ?? createHash('sha256').update(record.subject).digest('hex')).slice(0, 12)}.json`;
export const selects = (record, commit) => record.subject === commit.subject && (record.sha == null || record.sha === commit.sha);

// Git reports paths with no empty, `.` or `..` segment; a record names them the same way.
const isCanonicalPath = path => path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
const notCanonical = path => `${JSON.stringify(path)} is not a canonical path`;

// Why `path` (a full repository path) may not appear in a record's files, or null.
function pathRefusal(path) {
  if (typeof path !== 'string' || !path.startsWith(PACKAGE_PREFIX)) return `${JSON.stringify(path)} is outside ${PACKAGE_PREFIX}`;
  if (!isCanonicalPath(path)) return notCanonical(path);
  const rel = path.slice(PACKAGE_PREFIX.length);
  if (isCorePath(rel)) return `${path} is a core path`;
  if (rel.startsWith('records/')) return `${path} is a record file`;
  if (!RECORD_NAMED.test(rel)) return `${path} is not a path a record may name`;
  return null;
}

const isSortedUnique = list => list.every((item, i) => i === 0 || list[i - 1] < item);

function fileFailures(record) {
  const { files, kind } = record;
  if (kind === 'commit-only') return files === undefined ? [] : ['a commit-only record has no files'];
  if (!Array.isArray(files) || files.length === 0) return ['files must list at least one file'];
  const failures = [];
  for (const file of files) {
    const keys = file && typeof file === 'object' ? Object.keys(file).sort().join() : '';
    if (keys !== 'after,before,path') { failures.push('each file has exactly path, before and after'); continue; }
    for (const side of ['before', 'after']) if (file[side] !== null && !BLOB.test(file[side])) failures.push(`${file.path}: ${side} is not a blob id or null`);
    const refusal = pathRefusal(file.path);
    if (refusal) failures.push(refusal);
  }
  if (new Set(files.map(file => file?.path)).size !== files.length) failures.push('a path appears twice in files');
  if (kind === 'change' && !files.some(file => file?.before !== file?.after)) failures.push('a change record names no file whose before differs from after');
  return failures;
}

// DELTA-MAP.md was a core file while the package stored the rendered map; these commit-only records predate that change and name it.
const MAP_COMMIT_ONLY_RECORDS = Object.freeze(['D77-5963710ebcba.json', 'WF-2fdae2f97472.json']);

function commitFileFailures(name, record) {
  const list = record.commitFiles;
  if (!Array.isArray(list) || list.length === 0 || !list.every(path => typeof path === 'string' && path !== '')) return ['commitFiles must list the paths the commit changes'];
  const failures = isSortedUnique(list) ? [] : ['commitFiles must be sorted and unique'];
  for (const path of list) if (!isCanonicalPath(path)) failures.push(notCanonical(path));
  // A commit-only record stands for a commit that changes only core or record files, and perhaps the package README.
  if (record.kind === 'commit-only') for (const path of list) {
    const rel = path.startsWith(PACKAGE_PREFIX) ? path.slice(PACKAGE_PREFIX.length) : null;
    if (rel === 'DELTA-MAP.md' && MAP_COMMIT_ONLY_RECORDS.includes(name)) continue;
    if (rel !== null && !isCorePath(rel) && !rel.startsWith('records/') && !isUnrecordedRepositoryPath(path)) failures.push(`a commit-only record's commit changes ${path}`);
  }
  return failures;
}

/**
 * Checks one record file against the schema. `name` is the file name under
 * records/. Returns the failures, each prefixed with the record path; an empty
 * list means the record is valid.
 */
export function validateRecord(name, record) {
  const at = `${PACKAGE_PREFIX}records/${name}`;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return [`${at}: a record is a JSON object`];
  const failures = [];
  for (const key of Object.keys(record)) if (!KEYS.includes(key)) failures.push(`unknown field ${key}`);
  if (record.schema !== RECORD_SCHEMA) failures.push(`schema must be ${RECORD_SCHEMA}`);
  if (typeof record.delta !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(record.delta)) failures.push('delta must be an id such as D11 or WF');
  if (typeof record.subject !== 'string' || record.subject.trim() === '' || /[\r\n]/.test(record.subject)) failures.push('subject must be one non-empty line');
  if (record.sha !== undefined && !(typeof record.sha === 'string' && BLOB.test(record.sha))) failures.push('sha must be a full commit hash when present');
  if (!KINDS.includes(record.kind)) failures.push(`kind must be one of ${KINDS.join(', ')}`);
  if (record.note !== undefined && (typeof record.note !== 'string' || record.note.trim() === '')) failures.push('note must be non-empty text when present');
  const supersedes = record.supersedes;
  if (supersedes !== undefined && !(Array.isArray(supersedes) && supersedes.length > 0 && supersedes.every(other => RECORD_NAME.test(other) && other !== name) && new Set(supersedes).size === supersedes.length)) failures.push('supersedes must list other record file names once each');
  if (failures.length === 0) {
    failures.push(...fileFailures(record), ...commitFileFailures(name, record));
    if (name !== recordName(record)) failures.push(`file name must be ${recordName(record)}`);
  }
  return failures.map(failure => `${at}: ${failure}`);
}

/**
 * Reads records/ANCHOR.json of `packageDir`. Returns {commit, files}, where
 * files maps full repository paths to blobs. Throws when the file is missing,
 * not JSON, or names a path that is not anchored or a value that is not a blob.
 */
export function readAnchor(packageDir) {
  const at = `${PACKAGE_PREFIX}records/ANCHOR.json`;
  let anchor;
  try { anchor = JSON.parse(readFileSync(join(packageDir, 'records/ANCHOR.json'), 'utf8')); } catch (error) { throw new Error(`${at}: ${error.message}`); }
  const valid = anchor?.schema === 'dacs-client-anchor/v1' && BLOB.test(anchor.commit) && anchor.files !== null && typeof anchor.files === 'object'
    && Object.entries(anchor.files).every(([path, blob]) => path.startsWith(PACKAGE_PREFIX) && isAnchored(path.slice(PACKAGE_PREFIX.length)) && BLOB.test(blob));
  if (!valid) throw new Error(`${at}: not an anchor (schema, a commit and anchored paths with their blobs)`);
  return { commit: anchor.commit, files: anchor.files };
}

/** Reads lane declarations by id; malformed files are reported in `failures`. */
export function readDeclarations(packageDir, failures = []) {
  const dir = join(packageDir, 'records/ids'), declarations = new Map();
  if (!existsSync(dir)) return declarations;
  if (!lstatSync(dir).isDirectory()) { failures.push(`${PACKAGE_PREFIX}records/ids: not an id directory`); return declarations; }
  for (const name of readdirSync(dir).sort()) {
    const at = `${PACKAGE_PREFIX}records/ids/${name}`;
    let value;
    try { if (lstatSync(join(dir, name)).isFile()) value = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { /* invalid declaration */ }
    if (!/^[A-Z][A-Z0-9]*\.json$/.test(name) || !value || Object.keys(value).sort().join() !== 'delta,registration,schema,subject' ||
        value.schema !== 'dacs-client-delta-id/v1' || name !== `${value.delta}.json` ||
        ![value.registration, value.subject].every(text => typeof text === 'string' && text.trim() && !/[\r\n]/.test(text))) {
      failures.push(`${at}: invalid id declaration`); continue;
    }
    declarations.set(value.delta, value);
  }
  return declarations;
}
