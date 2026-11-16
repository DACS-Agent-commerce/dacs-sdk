import test from 'node:test';
import assert from 'node:assert/strict';
import { commits, git, ledger, selects } from '../scripts/delta-map.mjs';

function blobAt(revision, path) {
  try { return git('rev-parse', '--verify', '--quiet', `${revision}:${path}`); } catch { return null; }
}

test('every ledger record names, for each file, the blobs held before and after the one commit it selects', () => {
  const history = commits();
  const faults = [];
  for (const record of ledger().changes) {
    const selected = history.filter((commit) => selects(record, commit));
    if (selected.length !== 1) { faults.push(`${record.subject}: selects ${selected.length} commits`); continue; }
    const { sha } = selected[0];
    for (const file of record.files) {
      if (blobAt(`${sha}^`, file.path) !== file.before) faults.push(`${file.path}: blob before ${sha} differs from the record`);
      if (blobAt(sha, file.path) !== file.after) faults.push(`${file.path}: blob at ${sha} differs from the record`);
    }
  }
  assert.deepEqual(faults, []);
});
