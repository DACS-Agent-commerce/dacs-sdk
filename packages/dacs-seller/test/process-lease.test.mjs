import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentSellerStateHolder, sellerStateHolderState, acquireSellerStateLock, SELLER_STATE_LOCK_FILE } from '../src/devnet-demo/seller-state-lock.mjs';
import { SellerRecoveryError, DEFAULT_SELLER_MAX_JOBS } from '../src/dacs/seller-durable-state.mjs';
import { leaseInternals } from './helpers/lease-internals.mjs';
const directory = async t => { const path = await mkdtemp(join(tmpdir(), 'TEST-seller-lease-')); t.after(() => rm(path, { recursive: true, force: true })); return path; };
const sameMapping = { readPidMapping: () => true };

test('private lease inspection resolves the challenge-aware state module', async () => {
  const lease = await leaseInternals();
  assert.equal(typeof lease.takeLease, 'function');
  assert.equal(lease.holderState('.', { owner: 'TEST unknown holder' }, null), 'unrecognised');
});
test('current holder captures start time through proc self', async () => {
  const self = currentSellerStateHolder(0), text = await readFile('/proc/self/stat', 'utf8');
  assert.equal(self.processStart, text.slice(text.lastIndexOf(')') + 2).split(' ')[19]);
  assert.equal(sellerStateHolderState(self, self, sameMapping), 'live');
});
test('malformed stored start identity cannot take over a live holder', async t => {
  const dir = await directory(t), lock = await acquireSellerStateLock(dir); t.after(() => lock.release());
  const file = join(dir, SELLER_STATE_LOCK_FILE), holder = JSON.parse(await readFile(file, 'utf8'));
  holder.processStart = 'not-a-start-time'; await writeFile(file, JSON.stringify(holder));
  await assert.rejects(acquireSellerStateLock(dir), error => error.reason === 'doubt');
});
test('non-string start values and failed mapping observations stay doubtful', () => {
  const self = currentSellerStateHolder(0);
  for (const processStart of [Number(self.processStart), {}, [], true]) assert.equal(sellerStateHolderState({ ...self, processStart }, self, sameMapping), 'doubt');
  assert.equal(sellerStateHolderState(self, self, { readPidMapping: () => { throw Object.assign(new Error('TEST mapping missing'), { code: 'ENOENT' }); } }), 'doubt');
});
test('a live clone with another boot and a slower clock remains doubtful', async t => {
  const self = currentSellerStateHolder(2000), holder = { ...self, bootId: 'TEST-other-boot', acquiredAt: 0 };
  assert.equal(sellerStateHolderState(holder, self, { ...sameMapping, readBootTime: () => 1000 }), 'doubt');
  const dir = await directory(t); await writeFile(join(dir, SELLER_STATE_LOCK_FILE), JSON.stringify(holder));
  await assert.rejects(acquireSellerStateLock(dir), error => error.reason === 'doubt');
});
test('ancestor-mounted procfs cannot turn missing PID into exit evidence', () => {
  const self = currentSellerStateHolder(0); let calls = 0;
  assert.equal(sellerStateHolderState(self, self, { readPidMapping: () => false, readStart: () => { calls++; throw Object.assign(new Error('TEST missing'), { code: 'ENOENT' }); } }), 'doubt');
  assert.equal(calls, 0);
});
test('known PID mapping distinguishes exited, replaced and unreadable holders', () => {
  const self = currentSellerStateHolder(0);
  assert.equal(sellerStateHolderState(self, self, { ...sameMapping, isPidAbsent: () => true, readStart: () => { throw Object.assign(new Error('TEST absent'), { code: 'ENOENT' }); } }), 'gone');
  assert.equal(sellerStateHolderState(self, self, { ...sameMapping, readStart: () => String(BigInt(self.processStart) + 1n) }), 'gone');
  assert.equal(sellerStateHolderState(self, self, { ...sameMapping, readStart: () => 'bad' }), 'doubt');
  assert.equal(sellerStateHolderState(self, self, { ...sameMapping, readStart: () => { throw Object.assign(new Error('TEST refused'), { code: 'EACCES' }); } }), 'doubt');
});
const hiddenEntry = () => { throw Object.assign(new Error('TEST hidden by hidepid'), { code: 'ENOENT' }); };
test('a live PID that procfs hides as missing is not judged exited', () => {
  const self = currentSellerStateHolder(0);
  assert.equal(sellerStateHolderState(self, self, { ...sameMapping, readStart: hiddenEntry }), 'doubt');
  assert.equal(sellerStateHolderState({ ...self, pid: 1 }, self, { ...sameMapping, readStart: hiddenEntry }), 'doubt');
  assert.equal(sellerStateHolderState(self, self, { ...sameMapping, isPidAbsent: () => false, readStart: hiddenEntry }), 'doubt');
});
test('an exited holder is judged gone when procfs and the kernel both lack its PID', async () => {
  const self = currentSellerStateHolder(0), child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  assert.equal(sellerStateHolderState({ ...self, pid: child.pid }, self, sameMapping), 'gone');
});
test('live and repeated acquisition refuses; release is idempotent and owner-only', async t => {
  const dir = await directory(t), first = await acquireSellerStateLock(dir);
  await assert.rejects(acquireSellerStateLock(dir), error => error.reason === 'held');
  first.release(); first.release();
  const second = await acquireSellerStateLock(dir); first.release();
  assert.equal((await stat(second.path)).isFile(), true); second.release();
});
test('only one contender can take over an exited holder', async t => {
  const dir = await directory(t); await writeFile(join(dir, SELLER_STATE_LOCK_FILE), 'TEST old lock');
  let resolveBoth; const both = new Promise(resolve => { resolveBoth = resolve; }); let count = 0;
  const holderState = () => { if (++count === 2) resolveBoth(); return 'gone'; };
  const results = await Promise.allSettled([acquireSellerStateLock(dir, { holderState }), acquireSellerStateLock(dir, { holderState })]);
  await both;
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  results.filter(r => r.status === 'fulfilled').forEach(r => r.value.release());
});
test('foreign host, unreadable identity and takeover marker refuse without deleting evidence', async t => {
  const dir = await directory(t), path = join(dir, SELLER_STATE_LOCK_FILE);
  await writeFile(path, 'bad JSON'); await assert.rejects(acquireSellerStateLock(dir), e => e.reason === 'doubt');
  await writeFile(path, JSON.stringify({ ...currentSellerStateHolder(0), host: 'TEST other host' }));
  await assert.rejects(acquireSellerStateLock(dir), e => e.reason === 'doubt');
  await writeFile(path + '.takeover', 'TEST interrupted takeover');
  await assert.rejects(acquireSellerStateLock(dir, { holderState: () => 'gone' }), e => e.reason === 'takeover');
  assert.equal(await readFile(path + '.takeover', 'utf8'), 'TEST interrupted takeover');
});
test('kernel lease stays live until child exit and only same-boot exit is reclaimable', async t => {
  const dir = await directory(t), child = fork(new URL('./helpers/lease-worker.mjs', import.meta.url), [dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [holder] = await once(child, 'message'), lease = await leaseInternals();
  const ns = holder.namespace;
  assert(ns?.boot, 'TEST requires Linux boot identity');
  const row = { pid: holder.pid, owner: `${holder.pid}:${holder.process}:0:00000000-0000-4000-8000-000000000000:${ns.ns}.${ns.boot}.${ns.start}` };
  assert.equal(lease.leaseState(dir, holder.process), 'held');
  assert.equal(lease.holderState(dir, row, lease.lockHolder(row)), 'live');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(lease.leaseState(dir, holder.process), 'free');
  assert.equal(lease.holderState(dir, row, lease.lockHolder(row)), 'exited');
  assert.equal(lease.holderState(dir, row, { ...lease.lockHolder(row), namespace: { ...ns, boot: 'TEST other boot' } }), 'other-boot');
  assert.equal(lease.leaseState(dir, '00000000-0000-4000-8000-000000000000'), 'unchecked');
});
test('a row PID whose process start cannot be read keeps the row live; only a PID the kernel lacks does not', async () => {
  const lease = await leaseInternals(), ns = lease.NAMESPACE;
  assert(ns?.pids, 'TEST requires Linux boot identity');
  const holder = { process: '00000000-0000-4000-8000-000000000000', acquiredAt: 0, namespace: { ...ns, start: 'TEST-other-start' } };
  const unreadable = [hiddenEntry, () => { throw Object.assign(new Error('TEST refused'), { code: 'EACCES' }); }, () => 'TEST malformed stat'];
  for (const readStat of unreadable) assert.equal(lease.holderRunsHere({ pid: process.pid }, holder, readStat), true);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  assert.equal(lease.holderRunsHere({ pid: child.pid }, holder, hiddenEntry), false);
  assert.equal(lease.holderRunsHere({ pid: process.pid }, holder), false);
});
test('recovery errors and default capacity are explicit', () => {
  const error = new SellerRecoveryError('TEST-refusal'); assert.equal(error.code, 'TEST-refusal'); assert.equal(error.status, 503); assert(DEFAULT_SELLER_MAX_JOBS > 0);
});
test('lease implementation imports without the Node 22-only SQLite builtin', async () => {
  const child = fork(new URL('./helpers/minimum-node-import.mjs', import.meta.url), [], { execArgv: ['--experimental-loader', new URL('./helpers/minimum-node-loader.mjs', import.meta.url).href], stdio: ['ignore','ignore','pipe','ipc'] });
  let error='';child.stderr.on('data',data=>{error+=data;});
  const [code]=await once(child,'exit');assert.equal(code,0,error);
});
