// Builds the delta data the gates read: the archive (DELTA-LEDGER.json and
// DELTA-COMMITS.json) followed by the record files under records/. With no
// record files the result is the archive as stored.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCorePath, RECORD_NAME, PACKAGE_PREFIX, validateRecord } from './delta-record.mjs';

/** Reads the archive files of `packageDir` as stored. Returns {ledger, commits}. */
export function readArchive(packageDir) {
  const read = name => JSON.parse(readFileSync(join(packageDir, name), 'utf8'));
  return { ledger: read('DELTA-LEDGER.json'), commits: read('DELTA-COMMITS.json') };
}

// Valid record files as {name, record}; every refused file adds a failure.
function readRecords(packageDir, failures) {
  const dir = join(packageDir, 'records');
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir).sort()) {
    const at = `${PACKAGE_PREFIX}records/${name}`;
    if (isCorePath(`records/${name}`)) continue;
    if (!lstatSync(join(dir, name)).isFile()) { failures.push(`${at}: not a regular file`); continue; }
    if (!RECORD_NAME.test(name)) { failures.push(`${at}: not a record file name (<delta>-<12 hex>.json)`); continue; }
    let record;
    try { record = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch (error) { failures.push(`${at}: not valid JSON: ${error.message}`); continue; }
    const refused = validateRecord(name, record);
    if (refused.length) failures.push(...refused);
    else records.push({ name, record });
  }
  return records;
}

/**
 * Assembles the archive and the record files of `packageDir`. Records follow
 * the archive in file name order, which later commits cannot change. Returns
 * {ledger, commits, failures}: the ledger and commit list in the archive's
 * shape, and the refused record files.
 */
export function assemble(packageDir) {
  const archive = readArchive(packageDir), failures = [];
  const records = readRecords(packageDir, failures);
  if (records.length === 0) return { ...archive, failures };
  const names = new Set(records.map(entry => entry.name)), superseded = new Set();
  for (const { name, record } of records) for (const other of record.supersedes ?? []) {
    if (names.has(other)) superseded.add(other);
    else failures.push(`${PACKAGE_PREFIX}records/${name}: supersedes ${other}, which is not a valid record file`);
  }
  const change = ({ record }) => ({ delta: record.delta, subject: record.subject, ...(record.sha ? { sha: record.sha } : {}), files: record.files });
  const row = ({ record }) => ({ sha: record.sha ?? null, subject: record.subject, files: record.commitFiles });
  const current = records.filter(entry => !superseded.has(entry.name)), replaced = records.filter(entry => superseded.has(entry.name));
  const withFiles = entry => entry.record.files !== undefined;
  const ledger = { ...archive.ledger, changes: [...archive.ledger.changes, ...current.filter(withFiles).map(change)] };
  for (const [key, added] of [['supersededChanges', replaced.filter(withFiles).map(change)], ['supersededCommits', replaced.map(row)]]) {
    if (added.length) ledger[key] = [...(archive.ledger[key] ?? []), ...added];
  }
  return { ledger, commits: [...archive.commits, ...current.map(row)], failures };
}
