import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { recordName, validateRecord } from './delta-record.mjs';

const at = 'packages/dacs-client/';
const blobA = 'a'.repeat(40), blobB = 'b'.repeat(40);
const subject = 'delta(client): WF TEST change';
function change(overrides = {}) {
  const record = {
    schema: 'dacs-client-delta-record/v1', delta: 'WF', subject, kind: 'change',
    files: [{ path: at + 'src/purchases.mjs', before: blobA, after: blobB }],
    commitFiles: [at + 'records/WF-000000000000.json', at + 'src/purchases.mjs'],
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete record[key];
  return record;
}
const failures = record => validateRecord(recordName(record), record);
const refuses = (record, pattern) => assert.ok(failures(record).some(failure => pattern.test(failure)), JSON.stringify(failures(record)));

test('a record is named by its delta id and the start of the sha256 of its subject, or of its sha', () => {
  assert.equal(recordName(change()), `WF-${createHash('sha256').update(subject).digest('hex').slice(0, 12)}.json`);
  assert.equal(recordName(change({ sha: 'c'.repeat(40) })), `WF-${'c'.repeat(12)}.json`);
});

test('a valid change record is accepted, and a renamed copy is refused', () => {
  assert.deepEqual(failures(change()), []);
  assert.deepEqual(failures(change({ note: 'why the change was made', sha: 'c'.repeat(40) })), []);
  assert.deepEqual(validateRecord('WF-000000000000.json', change()), [`${at}records/WF-000000000000.json: file name must be ${recordName(change())}`]);
});

test('a record that changes only README.md, package.json, the notes or a script outside the core is accepted', () => {
  for (const path of ['README.md', 'package.json', 'DELTA-NOTES.md', 'scripts/generate-payload-helpers.mjs', 'test/purchase-integrity.test.mjs']) {
    assert.deepEqual(failures(change({ files: [{ path: at + path, before: blobA, after: blobB }] })), [], path);
  }
});

test('a change record whose only file has before equal to after is refused; a checkpoint or resolution record may', () => {
  const same = [{ path: at + 'README.md', before: blobA, after: blobA }];
  refuses(change({ files: same }), /names no file whose before differs from after/);
  for (const kind of ['checkpoint', 'resolution']) assert.deepEqual(failures(change({ kind, files: same })), [], kind);
  assert.deepEqual(failures(change({ files: [{ path: at + 'src/new.mjs', before: null, after: blobA }] })), []);
});

test('a record may not name a core path, a record file, a path outside the package or an unlisted package path', () => {
  for (const [path, pattern] of [
    [at + 'scripts/check-hold.mjs', /is a core path/],
    [at + 'scripts/delta-assemble.mjs', /is a core path/],
    [at + 'test/delta-ledger-gate.test.mjs', /is a core path/],
    [at + 'HOLD.json', /is a core path/],
    [at + 'evidence/publication-history.json', /is a core path/],
    [at + 'records/WF-111111111111.json', /is a record file/],
    ['src/index.ts', /is outside packages\/dacs-client\//],
    [at + 'notes.txt', /is not a path a record may name/],
  ]) refuses(change({ files: [{ path, before: blobA, after: blobB }] }), pattern);
});

test('a record may not name a path with an empty, . or .. segment', () => {
  for (const path of ['src/../package.json', '../../package.json', 'src/./purchases.mjs', 'test//purchases.test.mjs', 'scripts/./generate-payload-helpers.mjs', 'src/', 'src/..']) {
    refuses(change({ files: [{ path: at + path, before: blobA, after: blobB }] }), /is not a canonical path/);
  }
  refuses(change({ files: [{ path: at + 'src/../../package.json', before: blobA, after: blobB }] }), /is not a canonical path/);
  refuses(change({ commitFiles: [at + 'src/purchases.mjs', 'docs//outside.md'] }), /is not a canonical path/);
});

test('a commit-only record has no files and stands for a commit that changes only core or record files', () => {
  const commitOnly = change({ kind: 'commit-only', files: undefined, commitFiles: ['docs/outside.md', at + 'DELTA-MAP.md', at + 'HOLD.json', at + 'records/WF-000000000000.json'] });
  assert.deepEqual(failures(commitOnly), []);
  refuses({ ...commitOnly, files: change().files }, /a commit-only record has no files/);
  refuses({ ...commitOnly, commitFiles: [at + 'HOLD.json', at + 'src/purchases.mjs'] }, /commit changes packages\/dacs-client\/src\/purchases\.mjs/);
  refuses(change({ files: undefined }), /files must list at least one file/);
});

test('malformed records are refused field by field', () => {
  for (const [record, pattern] of [
    [change({ extra: true }), /unknown field extra/],
    [change({ schema: 'dacs-client-delta-record/v0' }), /schema must be/],
    [change({ delta: 'wf' }), /delta must be an id/],
    [change({ subject: 'two\nlines' }), /subject must be one non-empty line/],
    [change({ sha: 'c'.repeat(39) }), /sha must be a full commit hash/],
    [change({ sha: null }), /sha must be a full commit hash/],
    [change({ kind: 'other' }), /kind must be one of/],
    [change({ note: '' }), /note must be non-empty text/],
    [change({ supersedes: [] }), /supersedes must list other record file names/],
    [change({ supersedes: ['README.md'] }), /supersedes must list other record file names/],
    [change({ commitFiles: [] }), /commitFiles must list/],
    [change({ commitFiles: [at + 'src/purchases.mjs', at + 'records/WF-000000000000.json'] }), /commitFiles must be sorted and unique/],
    [change({ files: [{ path: at + 'README.md', before: blobA }] }), /exactly path, before and after/],
    [change({ files: [{ path: at + 'README.md', before: 'x', after: blobB }] }), /before is not a blob id or null/],
    [change({ files: [{ path: at + 'README.md', before: blobA, after: blobB }, { path: at + 'README.md', before: blobB, after: blobA }] }), /a path appears twice/],
  ]) refuses(record, pattern);
  assert.deepEqual(validateRecord('WF-000000000000.json', []), [`${at}records/WF-000000000000.json: a record is a JSON object`]);
});

test('a record may not supersede itself', () => {
  const record = change();
  assert.ok(validateRecord(recordName(record), { ...record, supersedes: [recordName(record)] }).some(failure => /supersedes must list other/.test(failure)));
});
