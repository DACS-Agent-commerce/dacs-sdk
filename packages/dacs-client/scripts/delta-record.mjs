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
//     "commitFiles": ["..."],               every path the commit changes (its inventory row)
//     "note": "...",                        optional text about the change
//     "supersedes": ["<record file>"]       optional; earlier records this one replaces
//   }
//
// A record is named `<delta>-<first 12 hex of sha>.json` when it carries a sha,
// and `<delta>-<first 12 hex of sha256(subject)>.json` otherwise.
import { createHash } from 'node:crypto';

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
  'HOLD.json', 'DELTA-LEDGER.json', 'DELTA-COMMITS.json', 'DELTA-MAP.md',
  'LICENSE', 'IMPORT-CUT-MAP.md', 'D15-SOURCES.json', 'PROVENANCE.json',
  'records/.gitkeep',
  'scripts/check-hold.mjs', 'scripts/delta-assemble.mjs', 'scripts/delta-record.mjs', 'scripts/delta-map.mjs',
  'scripts/check-provenance.mjs', 'scripts/pin-delta.mjs', 'scripts/source-git.mjs', 'scripts/publication-text.mjs',
  'scripts/path-mapping.mjs', 'scripts/test.mjs', 'scripts/copy-verbatim.mjs', 'scripts/import-cut-map.mjs',
  'scripts/check-imports.mjs',
  'scripts/check-hold.test.mjs', 'scripts/delta-continuity.test.mjs', 'scripts/delta-frontier.test.mjs',
  'scripts/delta-provenance.test.mjs', 'scripts/check-provenance.test.mjs', 'scripts/test-layout.test.mjs',
  'scripts/delta-record.test.mjs', 'scripts/delta-assemble.test.mjs', 'scripts/core-imports.test.mjs',
  'test/delta-ledger-gate.test.mjs',
]);
export const isCorePath = path => CORE_FILES.includes(path) || path.startsWith('evidence/');
// Sources, tests, the README, the manifest, the notes and scripts outside the core.
const RECORD_NAMED = /^(?:src\/|test\/|scripts\/|README\.md$|package\.json$|DELTA-NOTES\.md$)/;

export const recordName = record => `${record.delta}-${(record.sha ?? createHash('sha256').update(record.subject).digest('hex')).slice(0, 12)}.json`;
export const selects = (record, commit) => record.subject === commit.subject && (record.sha == null || record.sha === commit.sha);

// Why `path` (a full repository path) may not appear in a record's files, or null.
function pathRefusal(path) {
  if (typeof path !== 'string' || !path.startsWith(PACKAGE_PREFIX)) return `${JSON.stringify(path)} is outside ${PACKAGE_PREFIX}`;
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

function commitFileFailures(record) {
  const list = record.commitFiles;
  if (!Array.isArray(list) || list.length === 0 || !list.every(path => typeof path === 'string' && path !== '')) return ['commitFiles must list the paths the commit changes'];
  const failures = isSortedUnique(list) ? [] : ['commitFiles must be sorted and unique'];
  // A commit-only record stands for a commit that changes only core or record files.
  if (record.kind === 'commit-only') for (const path of list) {
    const rel = path.startsWith(PACKAGE_PREFIX) ? path.slice(PACKAGE_PREFIX.length) : null;
    if (rel !== null && !isCorePath(rel) && !rel.startsWith('records/')) failures.push(`a commit-only record's commit changes ${path}`);
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
    failures.push(...fileFailures(record), ...commitFileFailures(record));
    if (name !== recordName(record)) failures.push(`file name must be ${recordName(record)}`);
  }
  return failures.map(failure => `${at}: ${failure}`);
}
