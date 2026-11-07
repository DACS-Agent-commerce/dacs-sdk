// P16a0: a lane lock left by our own crashed process is reclaimed only when its
// holder is provably dead. Crashes kill a real child inside the lock callback;
// the identity table injects OS readings through the journal's identity seam
// while every lease file stays real. No network, no keys.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { formatHolderInstance, PROCESS_LEASE_ID, START_UNREADABLE } from '../src/wallet/holder-incarnation.mjs';
import { spawnJournalChild } from './helpers/journal-child-process.mjs';

const LANE = 'devnet/native-wallet/TEST-lane';
const BOOT = '11111111-2222-3333-4444-555555555555';
const NAMESPACE = { ns: '4026531836', boot: BOOT, start: '5000' };
const NOW = 1_800_000_000_000;
const SELF = { ns: NAMESPACE.ns, boot: BOOT, start: '7000', pids: 'proc' };
const PID = 424242;

function tempJournal(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'durable-journal-recovery-'));
  const path = join(dir, 'journal.sqlite');
  const journal = openDurableWalletJournal({ path, mode: 'create', ...options });
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, journal };
}
const reopen = (t, path, options = {}) => { const journal = openDurableWalletJournal({ path, mode: 'open', ...options }); t.after(() => journal.close()); return journal; };
function rawRecords(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT key, seq, value, digest, bytes FROM records ORDER BY seq').all(); } finally { db.close(); }
}
function rawLocks(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT key, token, instance, pid, fence, acquired_at FROM locks ORDER BY key').all(); } finally { db.close(); }
}
// A lock row as another process would have left it.
function forgeLock(path, { key, instance, pid = PID, acquiredAt = new Date(NOW - 1000).toISOString() }) {
  const db = new DatabaseSync(path);
  try {
    const fence = Number(db.prepare("SELECT value FROM meta WHERE key = 'fence'").get().value) + 1;
    db.prepare("UPDATE meta SET value = ? WHERE key = 'fence'").run(String(fence));
    db.prepare('INSERT INTO locks (key, token, instance, pid, fence, acquired_at) VALUES (?, ?, ?, ?, ?, ?)').run(key, randomBytes(16).toString('hex'), instance, pid, fence, acquiredAt);
    return fence;
  } finally { db.close(); }
}
const processOf = (instance) => instance.split(':')[2];
async function exitedChild(t, path) {
  const child = await spawnJournalChild(t, { path });
  child.kill();
  await child.exited;
  return child;
}

test('a real child killed after its record commits inside withWalletLock and before the lock is released leaves one lock row; a new process reopening the same journal reclaims it as exited by compare-and-set and acquires the lane, and every record is byte-identical', async (t) => {
  const { path, journal } = tempJournal(t);
  const child = await spawnJournalChild(t, { path });
  const record = { stage: 'broadcast-started', hash: 'TEST-hash-1' };
  child.request('crashAfterRecord', { key: LANE, record });
  await child.event('recorded');
  assert.equal(await child.exited, 'SIGKILL');
  const left = rawLocks(path);
  assert.equal(left.length, 1);
  assert.equal(left[0].instance, child.instance);
  assert.equal(journal.inspectLocks()[0].holder, 'exited');
  const before = rawRecords(path);
  assert.equal(before.length, 1);

  const reopened = reopen(t, path);
  await reopened.withWalletLock(LANE, async () => {
    const [mine] = rawLocks(path);
    assert.equal(mine.instance, reopened.instance);
    assert.equal(mine.fence, left[0].fence + 1);
    assert.deepEqual(await reopened.get(LANE), record);
  });
  assert.deepEqual(rawLocks(path), []);
  assert.deepEqual(rawRecords(path), before);
});

test('a live holder paused inside its callback is never reclaimed: a second process gets journal-busy within lockTimeoutMs, and the holder later releases normally', async (t) => {
  const { path } = tempJournal(t);
  const holder = await spawnJournalChild(t, { path });
  const held = holder.request('hold', { key: LANE });
  await holder.event('locked');
  const second = await spawnJournalChild(t, { path, lockMs: 100 });
  const refused = await second.request('tryLock', { key: LANE });
  assert.equal(refused.result.acquired, false);
  assert.equal(refused.result.code, 'journal-busy');
  const [row] = rawLocks(path);
  assert.equal(row.instance, holder.instance);

  holder.request('release', { key: LANE });
  assert.equal((await held).ok, true);
  assert.deepEqual(rawLocks(path), []);
  assert.equal((await second.request('tryLock', { key: LANE })).result.acquired, true);
});

test('one table drives the real classifier and journal: classes this-process, live, exited, other-boot, no-identity, lease-unproven and legacy-format against boot id, PID namespace, PID presence, start identity, lease and clock, varying each input alone from a complete control; any single missing reading, foreign identity or unprovable lease stays journal-busy with zero deletes and class not exited. Include absent PID in another namespace with ancestor-mounted /proc; a shared-directory/VM-clone row with matching hostname, machine id, boot id and namespace, absent PID and unprovable lease; other-boot rows with acquiredAt 0 and in the future; missing/backward/future clock readings. Only a same-boot, same-namespace original holder proven gone with a free verified lease is exited and reclaimed by exact compare-and-set with every record kept, including a PID now naming a different start identity; the original start identity still running or a held lease stays busy. inspectLocks reports each class; explicit repair needs the exact key, instance and fence and refuses this live instance. Inject OS readings through the identity seam; exercise real lease states, without replacing the classifier', async (t) => {
  const { path, journal: creator } = tempJournal(t);
  const dead = processOf((await exitedChild(t, path)).instance);
  const living = await spawnJournalChild(t, { path });
  const control = { process: dead, pid: PID, namespace: NAMESPACE, acquiredAt: new Date(NOW - 1000).toISOString() };
  const reading = { self: SELF, runningStart: () => null, now: () => NOW };
  const cases = [
    ['control: same boot and namespace, absent PID, free lease', 'exited', {}],
    ['PID now names a different start identity', 'exited', { runningStart: () => '9999' }],
    ['original start identity still running', 'live', { runningStart: () => NAMESPACE.start }],
    ['PID alive but its start cannot be read', 'live', { runningStart: () => START_UNREADABLE }],
    ['ancient acquiredAt does not release a running holder', 'live', { runningStart: () => NAMESPACE.start, acquiredAt: new Date(0).toISOString() }],
    ['lease held by a running process', 'live', { process: processOf(living.instance) }],
    ['another boot', 'other-boot', { namespace: { ...NAMESPACE, boot: '99999999-2222-3333-4444-555555555555' } }],
    ['another boot, acquiredAt 0', 'other-boot', { namespace: { ...NAMESPACE, boot: '99999999-2222-3333-4444-555555555555' }, acquiredAt: new Date(0).toISOString() }],
    ['another boot, acquiredAt in the future', 'other-boot', { namespace: { ...NAMESPACE, boot: '99999999-2222-3333-4444-555555555555' }, acquiredAt: new Date(NOW + 86_400_000).toISOString() }],
    ['absent PID in another namespace', 'no-identity', { namespace: { ...NAMESPACE, ns: '4026532999' } }],
    ['absent PID with an ancestor-mounted /proc', 'no-identity', { self: { ...SELF, pids: null } }],
    ['absent PID in another namespace with an ancestor-mounted /proc', 'no-identity', { namespace: { ...NAMESPACE, ns: '4026532999' }, self: { ...SELF, pids: null } }],
    ['this process has no identity', 'no-identity', { self: null }],
    ['the row names no namespace', 'no-identity', { namespace: null }],
    ['shared directory or VM clone: matching boot and namespace, absent PID, no provable lease', 'lease-unproven', { process: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }],
    ['clock reading missing', 'lease-unproven', { now: () => undefined }],
    ['clock reading backward of acquiredAt', 'lease-unproven', { now: () => NOW - 10_000_000 }],
    ['acquiredAt in the future', 'lease-unproven', { acquiredAt: new Date(NOW + 86_400_000).toISOString() }],
    ['acquiredAt invalid', 'unrecognised', { acquiredAt: 'not-a-date' }],
    ['row pid differs from its text', 'unrecognised', { rowPid: PID + 1 }],
    ['row text is not an instance', 'unrecognised', { instance: 'TEST-garbage' }],
    ['row written before incarnations existed', 'legacy-format', { instance: randomBytes(16).toString('hex') }],
    ['row of this process', 'this-process', { process: PROCESS_LEASE_ID }],
  ];
  const rows = cases.map(([name, expected, change], i) => {
    const key = `${LANE}/${i}`;
    const row = { ...control, ...change };
    const instance = row.instance ?? formatHolderInstance(randomBytes(16).toString('hex'), { pid: PID, ...row });
    return { name, expected, key, change, instance, pid: row.rowPid ?? PID, acquiredAt: row.acquiredAt };
  });
  for (const { key } of rows) await creator.put(key, { key, kept: true });
  const records = rawRecords(path);
  const fences = new Map(rows.map(({ key, instance, pid, acquiredAt }) => [key, forgeLock(path, { key, instance, pid, acquiredAt })]));

  for (const { name, expected, key, change } of rows) {
    const { self, runningStart, now } = change;
    const identity = { ...reading, ...(self !== undefined && { self }), ...(runningStart && { runningStart }), ...(now && { now }) };
    const journal = reopen(t, path, { lockTimeoutMs: 0, identity });
    assert.equal(journal.inspectLocks().find((row) => row.key === key).holder, expected, name);
    if (expected === 'exited') {
      await journal.withWalletLock(key, async () => assert.equal(rawLocks(path).find((row) => row.key === key).instance, journal.instance, name));
      assert.equal(rawLocks(path).some((row) => row.key === key), false, name);
    } else {
      await assert.rejects(journal.withWalletLock(key, async () => assert.fail(name)), { code: 'journal-busy' }, name);
      assert.equal(rawLocks(path).find((row) => row.key === key).fence, fences.get(key), name);
    }
  }
  assert.equal(rawLocks(path).length, rows.filter((row) => row.expected !== 'exited').length, 'only exited rows were deleted');
  assert.deepEqual(rawRecords(path), records, 'every record kept');

  const [{ key, instance, fence }] = rawLocks(path).map((row) => ({ key: row.key, instance: row.instance, fence: row.fence }));
  assert.throws(() => creator.releaseAbandonedLock({ key, instance, fence: fence + 1 }), { code: 'journal-lock-mismatch' });
  assert.throws(() => creator.releaseAbandonedLock({ key, instance: randomBytes(16).toString('hex'), fence }), { code: 'journal-lock-mismatch' });
  assert.deepEqual(creator.releaseAbandonedLock({ key, instance, fence }), { released: true, recordsChanged: 0 });
  await creator.withWalletLock(LANE, async () => {
    const own = rawLocks(path).find((row) => row.key === LANE);
    assert.throws(() => creator.releaseAbandonedLock({ key: LANE, instance: own.instance, fence: own.fence }), { code: 'journal-lock-live' });
  });
});

test('two processes recovering the same dead holder at once: exactly one compare-and-set succeeds and at most one new owner proceeds', async (t) => {
  const { path } = tempJournal(t);
  const crashed = await spawnJournalChild(t, { path });
  crashed.request('crashAfterRecord', { key: LANE, record: { stage: 'broadcast-started' } });
  await crashed.event('recorded');
  await crashed.exited;
  const [dead] = rawLocks(path);

  const first = await spawnJournalChild(t, { path, lockMs: 300 });
  const second = await spawnJournalChild(t, { path, lockMs: 300 });
  const attempts = [first, second].map((child) => child.request('hold', { key: LANE }));
  const winner = await Promise.race([first.event('locked').then(() => first), second.event('locked').then(() => second)]);
  const loser = winner === first ? second : first;
  const refused = await attempts[winner === first ? 1 : 0];
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'journal-busy');
  const [row] = rawLocks(path);
  assert.equal(row.instance, winner.instance);
  assert.equal(row.fence, dead.fence + 1);
  assert.notEqual(row.instance, loser.instance);
  winner.request('release', { key: LANE });
  assert.equal((await attempts[winner === first ? 0 : 1]).ok, true);
  assert.deepEqual(rawLocks(path), []);
});

test('a timeout never establishes death: retries across many lockTimeoutMs periods never reclaim a live or lease-unproven holder', async (t) => {
  const { path } = tempJournal(t);
  const living = await spawnJournalChild(t, { path });
  living.request('hold', { key: LANE });
  await living.event('locked');
  const unproven = `${LANE}/unproven`;
  forgeLock(path, { key: unproven, instance: formatHolderInstance(randomBytes(16).toString('hex'), { pid: PID, process: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', namespace: NAMESPACE }), acquiredAt: new Date(NOW - 1000).toISOString() });
  const journal = reopen(t, path, { lockTimeoutMs: 0, identity: { self: SELF, runningStart: () => null, now: () => NOW } });
  const before = rawLocks(path);
  for (let period = 0; period < 50; period += 1) {
    for (const key of [LANE, unproven]) await assert.rejects(journal.withWalletLock(key, async () => assert.fail('reclaimed')), { code: 'journal-busy' });
  }
  assert.deepEqual(rawLocks(path), before);
  assert.deepEqual(journal.inspectLocks().map((row) => row.holder).sort(), ['lease-unproven', 'live']);
});

test('opening a journal beside a holders directory that is not private refuses journal-lease-unavailable and creates no journal', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-journal-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'holders'));
  chmodSync(join(dir, 'holders'), 0o755);
  const path = join(dir, 'journal.sqlite');
  assert.throws(() => openDurableWalletJournal({ path, mode: 'create' }), { code: 'journal-lease-unavailable' });
  assert.equal(existsSync(path), false);
});
