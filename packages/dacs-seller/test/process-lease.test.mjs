import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseHolderState, leaseState, PROCESS_LEASE_ID, PROCESS_NAMESPACE, takeLease } from '../src/dacs/process-lease.mjs';
import { acquireSellerStateLock, SELLER_STATE_LOCK_FILE, SELLER_STATE_LOCK_REFUSALS } from '../src/devnet-demo/seller-state-lock.mjs';

const WORKER = new URL('./helpers/lease-worker.mjs', import.meta.url);
const directory = async t => { const path = await mkdtemp(join(tmpdir(), 'TEST-seller-lease-')); t.after(() => rm(path, { recursive: true, force: true })); return path; };
const lockPath = dir => join(dir, SELLER_STATE_LOCK_FILE);
const refused = reason => error => error.code === 'seller_state_locked' && error.reason === reason && error.message === SELLER_STATE_LOCK_REFUSALS[reason];
// Starts a lease-worker child in `mode`; resolves with its report and child.
async function worker(t, dir, mode, ...args) {
  const child = fork(WORKER, [dir, mode, ...args], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [report] = await once(child, 'message');
  return { ...report, child };
}
const kill = async child => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; };
// A lock left by a holder that was killed while holding it; returns its text and record.
async function deadHolder(t, dir) {
  const holder = await worker(t, dir, 'lock');
  assert.equal(holder.outcome, 'taken');
  await kill(holder.child);
  const text = await readFile(lockPath(dir), 'utf8');
  return { text, record: JSON.parse(text), holder };
}
// Makes the next call of fs[name] whose arguments match fail once with EIO.
function faultOnce(t, name, matches = () => true) {
  const real = fs[name];
  let fired = false;
  fs[name] = function (...args) {
    if (!fired && matches(...args)) { fired = true; throw Object.assign(new Error(`TEST injected ${name} fault`), { code: 'EIO' }); }
    return real.apply(this, args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs[name] = real; syncBuiltinESMExports(); });
}
const exists = path => readFile(path).then(() => true, () => false);

test('this host gives the process a boot and namespace identity', () => {
  assert(PROCESS_NAMESPACE?.boot && PROCESS_NAMESPACE.start, 'TEST requires Linux boot identity');
});

test('a live holder process keeps the lock; once it is killed the lock is taken over', async t => {
  const dir = await directory(t), holder = await worker(t, dir, 'lock');
  assert.equal(holder.outcome, 'taken');
  await assert.rejects(acquireSellerStateLock(dir), refused('held'));
  await kill(holder.child);
  const lock = await acquireSellerStateLock(dir);
  assert.equal(JSON.parse(await readFile(lockPath(dir), 'utf8')).process, PROCESS_LEASE_ID);
  lock.release();
  assert.equal(await exists(lockPath(dir)), false);
});

for (const start of ['empty', 'dead-holder']) {
  test(`six concurrent starters on a ${start} directory: exactly one wins, the rest are refused as held`, async t => {
    const dir = await directory(t);
    if (start === 'dead-holder') await deadHolder(t, dir);
    const reports = await Promise.all(Array.from({ length: 6 }, () => worker(t, dir, 'lock')));
    assert.deepEqual(reports.map(r => r.outcome).sort(), ['held', 'held', 'held', 'held', 'held', 'taken']);
    const winner = reports.find(r => r.outcome === 'taken');
    assert.equal(JSON.parse(await readFile(lockPath(dir), 'utf8')).process, winner.process);
  });
}

test('a crash inside the takeover section leaves nothing that blocks the next start', async t => {
  const dir = await directory(t), { text } = await deadHolder(t, dir);
  const section = await worker(t, dir, 'section');
  assert.equal(section.outcome, 'taken');
  await assert.rejects(acquireSellerStateLock(dir), refused('held'));
  assert.equal(await readFile(lockPath(dir), 'utf8'), text);
  await kill(section.child);
  (await acquireSellerStateLock(dir)).release();
});

test('a second acquire in this process is held and leaves the lock bytes unchanged; release frees it', async t => {
  const dir = await directory(t), first = await acquireSellerStateLock(dir), before = await readFile(lockPath(dir));
  await assert.rejects(acquireSellerStateLock(dir), refused('held'));
  assert.deepEqual(await readFile(lockPath(dir)), before);
  first.release(); first.release();
  (await acquireSellerStateLock(dir)).release();
});

test('the lease is taken once and stays held, seen from a child, across repeated acquisitions', async t => {
  const dir = await directory(t);
  for (let round = 0; round < 3; round++) (await acquireSellerStateLock(dir)).release();
  assert.equal(leaseState(dir, PROCESS_LEASE_ID), 'held');
  assert.deepEqual(await readdir(join(dir, 'holders')), [`${PROCESS_LEASE_ID}.sqlite`]);
  assert.equal((await worker(t, dir, 'probe', PROCESS_LEASE_ID)).outcome, 'held');
});

test('an alias path or a trailing slash reaches the same lease and the same lock', async t => {
  const dir = fs.realpathSync(await directory(t)), alias = `${dir}-alias`;
  await symlink(dir, alias); t.after(() => rm(alias, { force: true }));
  assert.equal(takeLease(`${alias}/`), PROCESS_LEASE_ID);
  const lock = await acquireSellerStateLock(dir); t.after(() => lock.release());
  assert.equal(takeLease(`${dir}/`), PROCESS_LEASE_ID);
  await assert.rejects(acquireSellerStateLock(alias), refused('held'));
  assert.deepEqual(await readdir(join(dir, 'holders')), [`${PROCESS_LEASE_ID}.sqlite`]);
});

test('records of another boot, another host, no identity or another shape are doubt and are left in place', async t => {
  const dir = await directory(t), { record } = await deadHolder(t, dir);
  const variants = {
    'another boot': { ...record, namespace: { ...record.namespace, boot: randomUUID() } },
    'another host': { ...record, host: `${record.host}-TEST-other` },
    'no identity': { ...record, namespace: null },
    'v1 format': { ...record, format: 'dacs-seller-state-lock/v1' },
    'numeric start': { ...record, namespace: { ...record.namespace, start: Number(record.namespace.start) } },
    'string pid': { ...record, pid: String(record.pid) },
    'coerced acquiredAt': { ...record, acquiredAt: String(record.acquiredAt) },
    'extra key': { ...record, bootId: record.namespace.boot },
    'missing key': Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'host')),
    'extra namespace key': { ...record, namespace: { ...record.namespace, time: '0' } },
  };
  for (const [name, variant] of Object.entries(variants)) {
    const text = JSON.stringify(variant);
    await writeFile(lockPath(dir), text);
    await assert.rejects(acquireSellerStateLock(dir), refused('doubt'), name);
    assert.equal(await readFile(lockPath(dir), 'utf8'), text, name);
  }
  for (const text of ['', 'TEST not JSON', '[]', 'null']) {
    await writeFile(lockPath(dir), text);
    await assert.rejects(acquireSellerStateLock(dir), refused('doubt'), JSON.stringify(text));
  }
});

test('a record whose lease file is missing is doubt, whatever its PID shows', async t => {
  const dir = await directory(t), { record } = await deadHolder(t, dir);
  await writeFile(lockPath(dir), JSON.stringify({ ...record, process: randomUUID() }));
  await assert.rejects(acquireSellerStateLock(dir), refused('doubt'));
});

test('a PID or start-time read never proves an exit; it only keeps a holder live', async t => {
  const dir = await directory(t), live = await worker(t, dir, 'lease'), dead = await worker(t, dir, 'lease');
  await kill(dead.child);
  const hidden = () => { throw Object.assign(new Error('TEST hidden by hidepid'), { code: 'ENOENT' }); };
  const denied = () => { throw Object.assign(new Error('TEST refused'), { code: 'EPERM' }); };
  const shifted = () => `TEST (node) ${'0 '.repeat(19)}1`;
  // This namespace with /proc naming its PIDs, and as seen through an ancestor's /proc.
  const self = { ...PROCESS_NAMESPACE, pids: 'proc' }, ancestor = { ...PROCESS_NAMESPACE, pids: null };
  const missing = { process: randomUUID(), pid: dead.pid, namespace: dead.namespace };
  // Lease held: whatever the PID shows, including a start shifted by a time namespace.
  for (const readStat of [hidden, denied, shifted]) assert.equal(leaseHolderState(dir, live, { self, readStat }), 'live');
  assert.equal(leaseHolderState(dir, { ...live, namespace: { ...live.namespace, start: '1' } }), 'live');
  // Lease unproven: an absent, hidden, unreadable or restarted PID is never exit evidence.
  for (const readStat of [hidden, denied, shifted]) assert.equal(leaseHolderState(dir, missing, { self, readStat }), 'lease-unproven');
  for (const readStat of [hidden, denied]) assert.equal(leaseHolderState(dir, { ...missing, pid: process.pid }, { self, readStat }), 'live');
  assert.equal(leaseHolderState(dir, { ...missing, pid: process.pid }, { self, readStat: shifted }), 'lease-unproven');
  for (const pid of [dead.pid, process.pid]) assert.equal(leaseHolderState(dir, { ...missing, pid }, { self: ancestor }), 'lease-unproven');
  // Lease free: a PID that still runs something whose start can't be read stays live.
  const reused = { ...dead, pid: process.pid };
  for (const readStat of [hidden, denied]) assert.equal(leaseHolderState(dir, reused, { self, readStat }), 'live');
  assert.equal(leaseHolderState(dir, { ...reused, namespace: PROCESS_NAMESPACE }, { self }), 'live');
  assert.equal(leaseHolderState(dir, reused, { self, readStat: shifted }), 'exited');
  assert.equal(leaseHolderState(dir, dead, { self }), 'exited');
  assert.equal(leaseHolderState(dir, { ...dead, namespace: { ...dead.namespace, boot: randomUUID() } }), 'other-boot');
  assert.equal(leaseHolderState(dir, { ...dead, namespace: null }), 'no-identity');
  assert.equal(leaseHolderState(dir, dead, { self: null }), 'no-identity');
  assert.equal(leaseHolderState(dir, { process: PROCESS_LEASE_ID, pid: 1, namespace: null }), 'this-process');
});

test('BSD-shaped identities: only the same kernel boot with a free lease is exited', async t => {
  const dir = await directory(t), dead = await worker(t, dir, 'lease');
  await kill(dead.child);
  const self = { ns: '0', boot: 'bt1700000000', start: '1700000100', pids: 'ps' };
  const holder = { process: dead.process, pid: dead.pid, namespace: { ns: '0', boot: 'bt1700000000', start: '1700000050' } };
  assert.equal(leaseHolderState(dir, holder, { self }), 'exited');
  assert.equal(leaseHolderState(dir, { ...holder, namespace: { ...holder.namespace, boot: 'bt1700000001' } }, { self }), 'other-boot');
  assert.equal(leaseHolderState(dir, { ...holder, process: randomUUID() }, { self }), 'lease-unproven');
  assert.equal(leaseHolderState(dir, { ...holder, namespace: null }, { self }), 'no-identity');
});

test('leases that cannot be checked are never free', async t => {
  const dir = await directory(t), dead = await worker(t, dir, 'lease');
  await kill(dead.child);
  assert.equal(leaseState(dir, dead.process), 'free');
  assert.equal(leaseState(dir, randomUUID()), 'unchecked');
  await writeFile(join(dir, 'TEST-escape.sqlite'), '', { mode: 0o600 });
  assert.equal(leaseState(dir, '../TEST-escape'), 'unchecked');
  await chmod(join(dir, 'holders', `${dead.process}.sqlite`), 0o644);
  assert.equal(leaseState(dir, dead.process), 'unchecked');
});

test('takeLease refuses an unsafe holders directory, an existing lease file or a non-directory, and registers nothing', async t => {
  const open = await directory(t);
  await mkdir(join(open, 'holders')); await chmod(join(open, 'holders'), 0o755);
  assert.throws(() => takeLease(open), { code: 'seller_state_directory_unsafe' });
  const taken = await directory(t);
  await mkdir(join(taken, 'holders'), { mode: 0o700 });
  await writeFile(join(taken, 'holders', `${PROCESS_LEASE_ID}.sqlite`), '', { mode: 0o600 });
  for (let round = 0; round < 2; round++) assert.throws(() => takeLease(taken), { code: 'seller_state_lease_unavailable' });
  await writeFile(join(open, 'TEST-file'), '');
  assert.throws(() => takeLease(join(open, 'TEST-file')), { code: 'seller_state_directory_unsafe' });
});

const isFile = fd => fs.fstatSync(fd).isFile(), isDirectory = fd => fs.fstatSync(fd).isDirectory();
for (const [name, fault] of [['temporary sync', ['fsyncSync', isFile]], ['link', ['linkSync']], ['directory sync', ['fsyncSync', isDirectory]]]) {
  test(`a fault at ${name} leaves no published lock, and the next acquire works`, async t => {
    const dir = await directory(t);
    takeLease(dir);
    faultOnce(t, ...fault);
    await assert.rejects(acquireSellerStateLock(dir), { code: 'EIO' });
    assert.equal(await exists(lockPath(dir)), false);
    assert.deepEqual((await readdir(dir)).sort(), ['holders']);
    (await acquireSellerStateLock(dir)).release();
  });
}

for (const [name, fault] of [['rename', ['renameSync']], ['directory sync', ['fsyncSync', isDirectory]]]) {
  test(`a fault at takeover ${name} leaves the old lock or none, and the next acquire takes over`, async t => {
    const dir = await directory(t), { text } = await deadHolder(t, dir);
    faultOnce(t, ...fault);
    await assert.rejects(acquireSellerStateLock(dir), { code: 'EIO' });
    const left = await readFile(lockPath(dir), 'utf8').catch(() => null);
    assert(left === null || left === text, 'TEST no lock of this acquisition is left');
    (await acquireSellerStateLock(dir)).release();
  });
}

test('a lock that a live holder replaced after it was judged exited is judged again inside the takeover section', async t => {
  const dir = fs.realpathSync(await directory(t)), path = lockPath(dir), { text, record } = await deadHolder(t, dir);
  const live = await worker(t, dir, 'lease');
  const replaced = JSON.stringify({ ...record, process: live.process, pid: live.pid });
  const real = fs.readFileSync;
  let first = true;
  fs.readFileSync = function (file, ...rest) {
    if (file === path && first) { first = false; fs.writeFileSync(path, replaced); return text; }
    return real.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.readFileSync = real; syncBuiltinESMExports(); });
  await assert.rejects(acquireSellerStateLock(dir), refused('held'));
  assert.equal(real(path, 'utf8'), replaced);
});

test('a stale handle never removes a later holder', async t => {
  const dir = await directory(t), first = await acquireSellerStateLock(dir, { now: () => 1 });
  first.release();
  // The same record bytes as the released handle's.
  const second = await acquireSellerStateLock(dir, { now: () => 1 });
  const text = await readFile(lockPath(dir), 'utf8');
  first.release();
  assert.equal(await readFile(lockPath(dir), 'utf8'), text);
  await writeFile(lockPath(dir), 'TEST another holder');
  second.release();
  assert.equal(await readFile(lockPath(dir), 'utf8'), 'TEST another holder');
});

test('a lock released between the failed link and its read gets one fresh attempt', async t => {
  const dir = fs.realpathSync(await directory(t)), path = lockPath(dir);
  takeLease(dir);
  const real = fs.readFileSync;
  let vanish = 1;
  fs.readFileSync = function (file, ...rest) {
    if (file === path) { if (vanish-- > 0) fs.unlinkSync(path); throw Object.assign(new Error('TEST gone'), { code: 'ENOENT' }); }
    return real.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.readFileSync = real; syncBuiltinESMExports(); });
  await writeFile(path, 'TEST released lock');
  const lock = await acquireSellerStateLock(dir);
  assert.equal(await exists(path), true);
  fs.readFileSync = real; syncBuiltinESMExports();
  lock.release();
  vanish = 0;
  fs.readFileSync = function (file, ...rest) { if (file === path) throw Object.assign(new Error('TEST gone'), { code: 'ENOENT' }); return real.call(this, file, ...rest); };
  syncBuiltinESMExports();
  await writeFile(path, 'TEST flickering lock');
  await assert.rejects(acquireSellerStateLock(dir), refused('doubt'));
});

test('both modules import without the Node 22-only SQLite builtin', async () => {
  const child = fork(new URL('./helpers/minimum-node-import.mjs', import.meta.url), [], { execArgv: ['--experimental-loader', new URL('./helpers/minimum-node-loader.mjs', import.meta.url).href], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let error = ''; child.stderr.on('data', data => { error += data; });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, error);
});
