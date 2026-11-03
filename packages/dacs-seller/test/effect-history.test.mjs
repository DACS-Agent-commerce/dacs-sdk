// P15a1: the kit's append-only effect history (DS-4). These cases run the real
// effect-history.mjs on real files through a filesystem seam that records which
// creates and syncs completed. The power-loss cut is a model: after a cut, every
// directory entry no completed sync of its parent covers is removed before restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { DEFAULT_HISTORY_IO, MAX_RECORDS_PER_LANE, MAX_RECORD_BYTES, createEffectHistory, initHistory } from '../src/dacs/effect-history.mjs';

const LANE = 'lane-1';
const PIN = 'dacs-demos-testnet-identity/2026-10-21';
const record = (state, extra = {}) => ({ state, operationId: 'op-1', pinVersion: PIN, artifactHash: createHash('sha256').update(Buffer.from('AQIDBA==', 'base64')).digest('hex'), ...extra });
const SIGNED = record('signed', { bytes: 'AQIDBA==' });
const STARTED = record('dispatch-started');
// The one table of paths this adapter creates under dataDirectory, with the composition that owns each (P15b1r and P18b add theirs at their heads).
const PATH_OWNERS = [
  { path: 'effects', owner: 'effect-history: the history root' },
  { path: `effects/${LANE}`, owner: 'effect-history: one lane' },
];
const TEMPORARY = /\.\d+\.[0-9a-f]+\.tmp$/;
const powerLoss = Object.assign(new Error('TEST power loss'), { code: 'EPOWER' });
const ioFailure = (message) => Object.assign(new Error(message), { code: 'EIO' });
const recordFile = (seq) => `${String(seq).padStart(8, '0')}.json`;

function newDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-effect-history-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Records each completed create and sync. `fail(event, events)` may return an error to throw instead of performing the step.
function tracedIo(events, { fail = null, skipSyncOf = null } = {}) {
  const step = async (type, path, run) => {
    const error = fail?.({ type, path }, events);
    if (error) throw error;
    const result = await run();
    events.push({ type, path });
    return result;
  };
  return {
    ...DEFAULT_HISTORY_IO,
    mkdir: (path) => step('mkdir', path, () => DEFAULT_HISTORY_IO.mkdir(path)),
    sync: {
      file: async (handle, path) => {
        events.push({ type: 'write', path });
        return step('syncFile', path, () => DEFAULT_HISTORY_IO.sync.file(handle, path));
      },
      directory: async (path) => {
        const temporary = events.findLast((entry) => entry.type === 'write');
        const published = temporary?.path.replace(TEMPORARY, '');
        if (published && existsSync(published) && !events.some((entry) => entry.type === 'link' && entry.path === published))
          events.push({ type: 'link', path: published });
        return path === skipSyncOf ? undefined : step('syncDirectory', path, () => DEFAULT_HISTORY_IO.sync.directory(path));
      },
    },
  };
}
const createdPath = (event) => (event.type === 'link' || event.type === 'mkdir' ? event.path : null);
// Created paths that no later completed sync of their parent covers, within `events`.
function uncovered(events) {
  return events.flatMap((event, index) => {
    const path = createdPath(event);
    return path !== null && !events.slice(index + 1).some((later) => later.type === 'syncDirectory' && later.path === dirname(path)) ? [path] : [];
  });
}
// The model of power loss: keep only what a completed parent sync covers (files first, then directories, deepest first).
function applyPowerLoss(events) {
  const lost = uncovered(events).sort((a, b) => b.length - a.length);
  for (const path of lost) rmSync(path, { recursive: true, force: true });
}
const relativeTo = (directory, paths) => paths.map((path) => relative(directory, path)).sort();

async function twoAppends(history, acknowledged, events) {
  for (const next of [SIGNED, STARTED]) {
    const stored = await history.append(LANE, next);
    acknowledged.push(stored.record);
    events?.push({ type: 'ack', path: LANE });
  }
}

test('one table drives every directory created by this adapter under dataDirectory (effects/ and each effects/<lane>): all use initHistory’s exported helper; on a fresh start a create/sync trace has no created path without its parent sync, and directory and parent syncs complete before acknowledgement; for each create and sync, failure-then-retry and power-loss cuts lose no acknowledged record; deleting any parent sync fails. P15b1r and P18b extend the same path-owner table for consumption keys and suspensions at their heads; host seller/ and transport/ rows remain deferred by the P15b1 (both parts) ceiling', async (t) => {
  const source = readFileSync(new URL('../src/dacs/effect-history.mjs', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/io\.mkdir\(/g)].length, 1, 'one mkdir call site');
  const helper = source.slice(source.indexOf('export async function initHistory'));
  assert.ok(helper.slice(0, helper.indexOf('\n}\n')).includes('io.mkdir('), 'the only directory creation is inside initHistory');

  const baselineDirectory = newDirectory(t);
  const events = [];
  await twoAppends(createEffectHistory({ dataDirectory: baselineDirectory, io: tracedIo(events) }), [], events);
  const made = events.filter((event) => event.type === 'mkdir').map((event) => event.path);
  assert.deepEqual(relativeTo(baselineDirectory, made), PATH_OWNERS.map((row) => row.path).sort(), 'every created directory is in the owner table');
  for (const path of made) assert.equal(statSync(path).mode & 0o777, 0o700, 'history directories are private');
  assert.equal(statSync(join(baselineDirectory, 'effects', LANE, recordFile(1))).mode & 0o777, 0o600);
  assert.deepEqual(uncovered(events), [], 'no created path lacks its parent sync');
  const firstAck = events.findIndex((event) => event.type === 'ack');
  assert.deepEqual(uncovered(events.slice(0, firstAck)), [], 'syncs complete before the first acknowledgement');

  // Deleting any parent sync is caught by the same trace check.
  for (const row of PATH_OWNERS) {
    const directory = newDirectory(t);
    const skipped = [];
    const target = join(directory, row.path);
    await createEffectHistory({ dataDirectory: directory, io: tracedIo(skipped, { skipSyncOf: dirname(target) }) }).append(LANE, SIGNED);
    assert.ok(uncovered(skipped).includes(target), `without the sync of ${dirname(row.path)}, ${row.path} is uncovered`);
  }

  // Failure-then-retry at each create and sync of one append. A caller retries as the boundary does: it reads the lane
  // (which re-syncs what it lists) and appends only when nothing is there.
  const singleAppend = [];
  await createEffectHistory({ dataDirectory: newDirectory(t), io: tracedIo(singleAppend) }).append(LANE, SIGNED);
  for (const cut of singleAppend.flatMap((entry, index) => ['mkdir', 'syncFile', 'syncDirectory'].includes(entry.type) ? [index] : [])) {
    const directory = newDirectory(t);
    let used = false;
    const run = [];
    const history = createEffectHistory({ dataDirectory: directory, io: tracedIo(run, { fail: (event, so) => (!used && so.length === cut ? (used = true, ioFailure('TEST EIO')) : undefined) }) });
    await assert.rejects(history.append(LANE, SIGNED), { code: 'eb_persist_failed' }, `step ${cut} (${singleAppend[cut].type}) fails the append`);
    let retained = await history.read(LANE);
    if (retained.length === 0) retained = [(await history.append(LANE, SIGNED)).record];
    assert.deepEqual(retained.map((entry) => [entry.seq, entry.state]), [[1, 'signed']], `step ${cut}: exactly one record`);
    assert.deepEqual(uncovered(run), [], `step ${cut}: every created path is covered once the record is relied on`);
  }
  for (let cut = 0; cut <= events.length; cut += 1) {
    const directory = newDirectory(t);
    const run = [];
    const acknowledged = [];
    const dead = tracedIo(run, { fail: (event, so) => (so.filter((entry) => entry.type !== 'ack').length >= cut ? powerLoss : undefined) });
    await twoAppends(createEffectHistory({ dataDirectory: directory, io: dead }), acknowledged, run).catch(() => {});
    applyPowerLoss(run.filter((entry) => entry.type !== 'ack'));
    const restarted = await createEffectHistory({ dataDirectory: directory }).read(LANE);
    assert.deepEqual(restarted.slice(0, acknowledged.length).map((entry) => entry.seq), acknowledged.map((entry) => entry.seq), `power loss after step ${cut} keeps every acknowledged record`);
  }

  // A failed sync is retried even though the directory already exists.
  const directory = newDirectory(t);
  const retried = [];
  mkdirSync(join(directory, 'effects'), { mode: 0o700 });
  await initHistory(join(directory, 'effects'), tracedIo(retried));
  assert.deepEqual(retried.map((event) => event.type), ['syncDirectory', 'syncDirectory'], 'an existing directory and its parent are synced again');
  assert.deepEqual(retried.map((event) => relative(directory, event.path)), ['effects', '']);
});

test('restart cuts around sequence allocation and publication: an identical existing record from our own prior run is idempotent and grants no new send, and a conflicting one refuses eb_persist_failed with zero transmissions; when a directory sync throws after the link, the record stays unacknowledged and the pass transmits nothing; retry re-syncs the existing identical record before acknowledgement, with transmission only after a successful sync; run the same failure-then-retry cut for the lane directory and its parent, counting at least one sync on each existing-record branch', async (t) => {
  // A listing that hides the newest record, as allocation sees after a restart cut: the allocated sequence already exists.
  const staleList = (control) => async (path) => {
    const names = await DEFAULT_HISTORY_IO.list(path);
    return control.stale && path.endsWith(LANE) ? names.slice(0, 1) : names;
  };
  const laneFile = (directory, seq) => join(directory, 'effects', LANE, recordFile(seq));

  const directory = newDirectory(t);
  const first = createEffectHistory({ dataDirectory: directory });
  await first.append(LANE, SIGNED);
  await first.append(LANE, STARTED);
  const events = [];
  const control = { stale: true };
  const stale = createEffectHistory({ dataDirectory: directory, io: { ...tracedIo(events), list: staleList(control) } });
  const same = await stale.append(LANE, STARTED);
  assert.deepEqual([same.created, same.record.seq], [false, 2], 'an identical record is idempotent and reports it created nothing');
  const existingSyncs = events.slice(events.findLastIndex((event) => event.type === 'syncFile') + 1);
  for (const path of [join(directory, 'effects', LANE), join(directory, 'effects')])
    assert.ok(existingSyncs.some((event) => event.type === 'syncDirectory' && event.path === path), `${path} synced after the exclusive publisher found the existing record`);
  const before = readFileSync(laneFile(directory, 2), 'utf8');
  await assert.rejects(stale.append(LANE, record('dispatch-started', { operationId: 'another-operation' })), { code: 'eb_persist_failed' }, 'a different record at the allocated sequence is a conflict');
  assert.equal(readFileSync(laneFile(directory, 2), 'utf8'), before, 'the existing record is never replaced');

  // The existing-record branch's lane and parent syncs, each failing once then retried.
  for (const target of [`effects/${LANE}`, 'effects']) {
    const run = [];
    let used = false;
    const failing = createEffectHistory({ dataDirectory: directory, io: { ...tracedIo(run, { fail: (event, so) => {
      const onExistingBranch = event.type === 'syncDirectory' && event.path === join(directory, target) && so.some((entry) => entry.type === 'syncFile');
      return !used && onExistingBranch ? (used = true, ioFailure('TEST sync failure')) : undefined;
    } }), list: staleList(control) } });
    await assert.rejects(failing.append(LANE, STARTED), { code: 'eb_persist_failed' }, `${target}: unacknowledged`);
    const retry = await failing.append(LANE, STARTED);
    assert.equal(retry.created, false);
    const retrySyncs = run.slice(run.findLastIndex((event) => event.type === 'syncFile') + 1);
    for (const path of [join(directory, 'effects', LANE), join(directory, 'effects')])
      assert.ok(retrySyncs.some((event) => event.type === 'syncDirectory' && event.path === path), `${target}: ${path} re-synced on the retry's existing-record branch`);
  }

  // A publication that linked the record but could not sync it is unacknowledged.
  const linkedDirectory = newDirectory(t);
  const linkedEvents = [];
  let armed = true;
  const failing = createEffectHistory({ dataDirectory: linkedDirectory, io: tracedIo(linkedEvents, { fail: (event, so) =>
    armed && event.type === 'syncDirectory' && event.path.endsWith(`effects/${LANE}`) && so.some((entry) => entry.type === 'syncFile')
      ? ioFailure('TEST sync failure') : undefined,
  }) });
  await assert.rejects(failing.append(LANE, SIGNED), (error) => error.code === 'eb_persist_failed' && error.cause?.code === 'EIO');
  assert.equal(readdirSync(join(linkedDirectory, 'effects', LANE)).filter((name) => name.endsWith('.json')).length, 1);
  armed = false;
  const beforeRetry = linkedEvents.length;
  const retained = await createEffectHistory({ dataDirectory: linkedDirectory, io: tracedIo(linkedEvents) }).read(LANE);
  assert.deepEqual(retained.map((entry) => [entry.seq, entry.bytes]), [[1, SIGNED.bytes]], 'restart retains the exact bytes without a second signature');
  for (const path of [join(linkedDirectory, 'effects', LANE), join(linkedDirectory, 'effects')])
    assert.ok(linkedEvents.slice(beforeRetry).some((entry) => entry.type === 'syncDirectory' && entry.path === path));
  assert.equal((await failing.append(LANE, STARTED)).record.seq, 2, 'restart allocates from retained history');
});

test('an unreadable, truncated, oversized, gapped or foreign history is unavailable, and nothing is appended to it', async (t) => {
  const valid = (seq, extra = {}) => `${JSON.stringify({ seq, lane: LANE, ...SIGNED, ...extra })}\n`;
  const bad = [
    ['a truncated record', { [recordFile(1)]: '{"seq":1,"lane":' }],
    ['a gap in the sequence', { [recordFile(1)]: valid(1), [recordFile(3)]: valid(3) }],
    ['a record over the byte bound', { [recordFile(1)]: valid(1, { bytes: 'A'.repeat(MAX_RECORD_BYTES) }) }],
    ['a signed record whose bytes disagree with its hash', { [recordFile(1)]: valid(1, { bytes: 'AAAA' }) }],
    ['a foreign temporary file', { 'other.tmp': 'x' }],
    ['an empty identity', { [recordFile(1)]: valid(1, { operationId: '' }) }],
    ['an unknown state', { [recordFile(1)]: valid(1, { state: 'sent' }) }],
    ['a sequence that disagrees with its file name', { [recordFile(1)]: valid(2) }],
    ['a record of another lane', { [recordFile(1)]: valid(1, { lane: 'lane-2' }) }],
    ['a stray file', { [recordFile(1)]: valid(1), 'notes.txt': 'x' }],
    ['a record under a foreign file name', { 'record-one.json': valid(1) }],
    ['more records than the bound', Object.fromEntries(Array.from({ length: MAX_RECORDS_PER_LANE + 1 }, (_, index) => [recordFile(index + 1), valid(index + 1)]))],
  ];
  for (const [name, files] of bad) {
    const directory = newDirectory(t);
    const lane = join(directory, 'effects', LANE);
    mkdirSync(lane, { recursive: true, mode: 0o700 });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(lane, file), text);
    const history = createEffectHistory({ dataDirectory: directory });
    await assert.rejects(history.read(LANE), { code: 'eb_history_unavailable' }, name);
    await assert.rejects(history.append(LANE, STARTED), { code: 'eb_history_unavailable' }, name);
  }

  const linked = newDirectory(t);
  mkdirSync(join(linked, 'effects', LANE), { recursive: true, mode: 0o700 });
  writeFileSync(join(linked, 'target.json'), valid(1));
  symlinkSync(join(linked, 'target.json'), join(linked, 'effects', LANE, recordFile(1)));
  await assert.rejects(createEffectHistory({ dataDirectory: linked }).read(LANE), { code: 'eb_history_unavailable' }, 'a link is not a record');

  const directory = newDirectory(t);
  await createEffectHistory({ dataDirectory: directory }).append(LANE, SIGNED);
  const refused = Object.assign(new Error('TEST read refused'), { code: 'EACCES' });
  await assert.rejects(createEffectHistory({ dataDirectory: directory, io: { ...DEFAULT_HISTORY_IO, read: async () => { throw refused; } } }).read(LANE),
    (error) => error.code === 'eb_history_unavailable' && error.cause === refused, 'an unreadable record keeps its cause');
  await assert.rejects(createEffectHistory({ dataDirectory: directory, io: { ...DEFAULT_HISTORY_IO, list: async () => { throw refused; } } }).read(LANE),
    (error) => error.code === 'eb_history_unavailable' && error.cause === refused, 'an unlistable lane is not an empty one');

  const crashed = join(newDirectory(t), 'effects', LANE);
  mkdirSync(crashed, { recursive: true, mode: 0o700 });
  writeFileSync(join(crashed, `${recordFile(1)}.123.abcdef123456.tmp`), '{"torn');
  assert.deepEqual(await createEffectHistory({ dataDirectory: dirname(dirname(crashed)) }).read(LANE), [], 'an unpublished temporary file left by a crash is never read');
});

test('a lane that was never written reads as empty, and a lane name cannot leave effects/', async (t) => {
  const history = createEffectHistory({ dataDirectory: newDirectory(t) });
  assert.deepEqual(await history.read(LANE), []);
  for (const lane of ['', '..', '../other', 'a/b', '.hidden', 7, undefined]) {
    await assert.rejects(history.read(lane), { code: 'eb_history_unavailable' }, `${String(lane)} is not a lane`);
    await assert.rejects(history.append(lane, SIGNED), { code: 'eb_history_unavailable' }, `${String(lane)} is not a lane`);
  }
});

test('fields cannot choose the sequence or lane, and an invalid record is never written', async (t) => {
  for (const fields of [{ ...SIGNED, seq: 9 }, { ...SIGNED, lane: 'foreign' }, { ...SIGNED, bytes: 'AAAA' }, record('sent'), null]) {
    const directory = newDirectory(t);
    await assert.rejects(createEffectHistory({ dataDirectory: directory }).append(LANE, fields), { code: 'eb_persist_failed' });
    assert.deepEqual(await createEffectHistory({ dataDirectory: directory }).read(LANE), []);
  }
});

test('record and lane limits admit their exact bounds and refuse the next byte or record', async (t) => {
  const directory = newDirectory(t);
  const history = createEffectHistory({ dataDirectory: directory });
  const signed = { ...SIGNED, padding: '' };
  const encodedBytes = Buffer.byteLength(JSON.stringify({ seq: 1, lane: LANE, ...signed }) + '\n');
  signed.padding = 'x'.repeat(MAX_RECORD_BYTES - encodedBytes);
  await history.append(LANE, signed);
  assert.equal(statSync(join(directory, 'effects', LANE, recordFile(1))).size, MAX_RECORD_BYTES);
  assert.equal((await history.read(LANE)).length, 1, 'a record of exactly the bound reads back');
  await assert.rejects(history.append(LANE, { ...signed, padding: `${signed.padding}x` }), { code: 'eb_persist_failed' });

  const lane = join(newDirectory(t), 'effects', LANE);
  mkdirSync(lane, { recursive: true });
  for (let seq = 1; seq <= MAX_RECORDS_PER_LANE; seq += 1)
    writeFileSync(join(lane, recordFile(seq)), JSON.stringify({ seq, lane: LANE, ...SIGNED }));
  const full = createEffectHistory({ dataDirectory: dirname(dirname(lane)) });
  assert.equal((await full.read(LANE)).length, MAX_RECORDS_PER_LANE);
  await assert.rejects(full.append(LANE, STARTED), { code: 'eb_persist_failed' });
});
