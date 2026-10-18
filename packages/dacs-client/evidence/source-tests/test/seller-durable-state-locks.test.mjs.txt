// Seller-state job locks (seller_locks): every row names the process that
// took it and that process's PID namespace, boot and start time, and that
// process holds a lifetime lease (an exclusive SQLite lock on
// holders/<process>.sqlite) until it exits. A row is reclaimed, or released by
// the operator, only once its holder's lease can be taken and its PID, in this
// namespace, no longer runs it; a lease that cannot be checked keeps the row
// busy. Rows naming no process (main's format) are never reclaimed: their PID
// may be a live holder in another PID namespace. Every job-scoped write,
// effect completions included, is fenced on the acquisition running it, and
// the fence is checked again last before each effect. SIMULATED: ephemeral
// TEST keys, private temporary directories, an in-memory fixture anchor
// substrate, forked TEST children as other live processes, dead holders
// modelled either by SIGKILLing a child or by an unlocked lease file, a
// holder in a sibling PID namespace modelled by a row whose PID names no
// process here, and a host without /proc (macOS, the BSDs) modelled by TEST
// children that preload helpers/seller-state-no-procfs.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { contentHash, generateCanonicalJobId, sha256Hex, storAddress } from '@kynesyslabs/dacs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { FIXTURE_FINALITY, FIXTURE_SUBSTRATE, canonicalSignature, fixtureWriteHash, signAnchorWrite } from '../src/dacs/fixture-anchors.mjs';
import { commitWorld } from './helpers/review-commit-retry-coverage-world.mjs';

const MODULE = new URL('../src/dacs/seller-durable-state.mjs', import.meta.url);
const HOLDER = new URL('./helpers/seller-durable-state-lock-holder.mjs', import.meta.url);
const NO_PROCFS = new URL('./helpers/seller-state-no-procfs.mjs', import.meta.url);
const MAIN_FIXTURE = new URL('./fixtures/seller-durable-state.main-06958bb.mjs', import.meta.url);
const PIN = { listingId: 'seller-locks-test', version: 1, contentHash: 'ab'.repeat(32) };
const CONTEXT = { admittedAt: 1, validation: { disposition: 'verified' } };
const reclaimLine = (jobId) => `seller-state: reclaimed the lock on job ${jobId} left by a process that has exited\n`;
const busyLine = (jobId, reason) => `seller-state: job ${jobId} stays busy: its lock row (${reason}) names no holder this process can prove exited; see inspectLocks() and releaseAbandonedLock()\n`;
const code = (expected) => (error) => error?.code === expected;
const jobs = (n) => Array.from({ length: n }, () => generateCanonicalJobId());
// A process's start second as `ps` lists it (UTC), parsed independently of the module under test.
const BSD_TOOLS = { PATH: '/bin:/usr/bin:/sbin:/usr/sbin', LC_ALL: 'C', TZ: 'UTC0' };
const psStartOf = (pid) => String(Date.parse(`${execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: BSD_TOOLS, encoding: 'utf8' }).trim()} UTC`) / 1000);
// This process's PID namespace, boot and start time, read independently of
// the module under test: on Linux the inode of /proc/self/ns/pid, the boot id
// and the start ticks; without /proc `0`, kern.boottime and the ps start second.
const startOf = (stat) => stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
const HERE = (() => {
  try { return { ns: statSync('/proc/self/ns/pid', { bigint: true }).ino.toString(), boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), start: startOf(readFileSync('/proc/self/stat', 'utf8')) }; } catch { /* no /proc */ }
  try {
    const [, sec] = /sec = (\d+),/.exec(execFileSync('sysctl', ['-n', 'kern.boottime'], { env: BSD_TOOLS, encoding: 'utf8' }));
    return { ns: '0', boot: `bt${sec}`, start: psStartOf(process.pid) };
  } catch { return null; }
})();
// This boot's time, for the no-/proc TEST children (Linux hosts only).
const BTIME = (() => { try { return /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))[1]; } catch { return null; } })();
// A holder that ran in this PID namespace on this boot with a start time no
// process here has (a PID's earlier process, or any process since gone).
const GONE = HERE && { ...HERE, start: '0' };
// Owner values as a process of this version, and as main, wrote them. With
// `namespace: null` the row names none (a process that could not read /proc).
const ownerOf = (pid, identity, { at = Date.now(), namespace = GONE } = {}) => `${pid}:${identity}:${at}:${randomUUID()}${namespace ? `:${namespace.ns}.${namespace.boot}.${namespace.start}` : ''}`;
const mainOwner = (pid) => `${pid}:${randomUUID()}`;
// A PID that names no process in this namespace: what a live holder in a
// sibling PID namespace (another container on the same volume) looks like here.
function invisiblePid() {
  let max = 4194304;
  try { max = Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8')); } catch { /* the kernel's largest default */ }
  for (let pid = max - 1; pid > 1; pid -= 1) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return pid; }
  }
  throw new Error('TEST no free PID');
}
// Whether another process can take the lease of the process `identity` on
// `dir` right now ('free') or not ('held'), checked directly on the lease
// file, independently of any row or PID.
function leaseFromAnotherProcess(dir, identity) {
  const script = "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); try { db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE'); db.exec('ROLLBACK'); process.stdout.write('free'); } catch { process.stdout.write('held'); }";
  return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script, join(dir, 'holders', `${identity}.sqlite`)], { encoding: 'utf8' });
}
// An in-memory loopback fixture substrate with the fixture's own receipts:
// write-once, and `afterWrite` runs once the external write has committed,
// before the writer gets its answer.
function memoryAnchors(writer) {
  const records = new Map(), sink = { writes: 0, reads: 0, afterWrite: null };
  sink.write = async ({ logicalAddress, artifact, writer: claimed, writerSignature }) => {
    assert.equal(claimed, writer);
    sink.writes += 1;
    const hash = contentHash(artifact), signature = canonicalSignature(writerSignature), at = Date.now();
    const receipt = { receiptVersion: '1', substrate: FIXTURE_SUBSTRATE, finalityProfile: FIXTURE_FINALITY, logicalAddress, nativeAddress: storAddress(logicalAddress), contentHash: hash,
      transactionRef: { kind: 'fixture-sr2-write', value: fixtureWriteHash({ logicalAddress, contentHash: hash, writer, writerSignature: signature }) }, writer, state: 'finalized',
      observationDisposition: 'established', observedAt: at, blockRef: { id: `fixture-block-${sink.writes}`, height: String(sink.writes), timestamp: at }, evidence: { kind: 'fixture-writer-signature', value: signature } };
    records.set(logicalAddress, { artifact: structuredClone(artifact), receipt });
    const after = sink.afterWrite; sink.afterWrite = null; after?.();
    return receipt;
  };
  sink.read = async (logicalAddress) => { sink.reads += 1; const record = records.get(logicalAddress); return record ? { status: 'present', ...structuredClone(record) } : { status: 'absent' }; };
  return sink;
}
// The seller agent's anchor authorization: the write message signed through signOnce.
const authorizeIn = (store, logicalAddress, artifact) => () => signAnchorWrite((bytes) => store.signOnce(`signature:${sha256Hex(bytes)}`, bytes), logicalAddress, contentHash(artifact));

function privateDirectory(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sellerKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  return { claim: `did:demos:agent:${raw}`, pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), sign: (bytes) => sign(null, Buffer.from(bytes), privateKey) };
}

async function world(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-locks-')));
  const key = sellerKey(), stores = [];
  // failSign: these exact protocol bytes get an unknown signer outcome.
  // duringSign: runs once while the signer handles the next protocol bytes.
  const w = { dir, key, children: [], failSign: null, duringSign: null, signs: 0 };
  w.signer = { claim: key.claim, sign: (bytes) => {
    const text = Buffer.from(bytes).toString();
    if (text === w.failSign) throw new Error('TEST signer outcome unknown');
    if (!text.startsWith('dacs-chatgpt-plugin:')) { w.signs += 1; const during = w.duringSign; w.duringSign = null; during?.(); }
    return key.sign(bytes);
  } };
  // Like the seller agent, every store retains (or re-verifies) its admission context.
  w.open = async (create = createSellerDurableState) => { const store = await create({ dir, signer: w.signer, listingPin: PIN }); stores.push(store); store.retainContext(CONTEXT); return store; };
  t.after(async () => {
    for (const child of w.children) await child.kill();
    for (const store of stores) { try { store.close(); } catch { /* a TEST hold is still open */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  const database = (work) => { const db = new DatabaseSync(join(dir, 'seller-state.sqlite')); try { return work(db); } finally { db.close(); } };
  // Writes or removes a lock row directly, as a killed process, main's code or
  // the documented rollback DELETE leaves it.
  w.plant = (job, owner, pid) => database((db) => db.prepare('INSERT INTO seller_locks VALUES (?,?,?)').run(job, owner, pid));
  w.unplant = (job) => database((db) => db.prepare('DELETE FROM seller_locks WHERE job=?').run(job));
  w.repid = (job, pid) => database((db) => db.prepare('UPDATE seller_locks SET pid=? WHERE job=?').run(pid, job));
  w.effectState = (id) => database((db) => JSON.parse(db.prepare('SELECT value FROM seller_effects WHERE id=?').get(id).value).payload.body.state);
  w.table = (name) => database((db) => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
  w.schema = () => database((db) => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all());
  w.records = () => Object.fromEntries(['seller_meta', 'seller_jobs', 'seller_effects', 'seller_settlements'].map((name) => [name, w.table(name)]));
  // The lease file a process that has exited leaves: present, private, unlocked.
  w.exitedHolder = () => { const identity = randomUUID(); closeSync(openSync(join(dir, 'holders', `${identity}.sqlite`), 'wx', 0o600)); return identity; };
  return w;
}

// Holds a job in this process until release() resolves the action; inside(fn)
// runs fn in the held acquisition's async context.
function hold(store, jobId) {
  let release, snapshot;
  const done = store.withJob(jobId, (session) => new Promise((resolve) => { snapshot = AsyncLocalStorage.snapshot(); release = () => { resolve(session); return done; }; }));
  return { done, release: () => release(), inside: (fn) => snapshot(fn) };
}

// A live store in another OS process holding `jobId` (TEST child over IPC).
// `umask`: the child's file-creation mask. `noProcfs`: the child sees no /proc.
async function holder(w, jobId, options = {}, { noProcfs = false } = {}) {
  const h = await spawnHolder(w, { noProcfs });
  const held = await h.take(jobId, options);
  assert.equal(held.code, null, 'TEST holder took the job');
  assert.notEqual(held.pid, process.pid);
  return Object.assign(h, { pid: held.pid, session: held.session, row: held.locks.find((row) => row.job === jobId) });
}

async function spawnHolder(w, { noProcfs = false } = {}) {
  const child = fork(HOLDER, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: ['--disable-warning=ExperimentalWarning', ...(noProcfs ? [`--import=${NO_PROCFS.href}`] : [])] });
  const exited = new Promise((resolve) => child.once('exit', (exitCode, signal) => resolve({ exitCode, signal })));
  const answer = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', on); reject(new Error(`TEST holder did not answer ${type}`)); }, 15000);
    function on(message) {
      if (message.type !== type && message.type !== 'error') return;
      clearTimeout(timer); child.off('message', on);
      if (message.type === 'error') reject(new Error(`TEST holder failed: ${message.error}`)); else resolve(message);
    }
    child.on('message', on);
  });
  const ask = (type, extra = {}) => { const reply = answer(type); child.send({ type, ...extra }); return reply; };
  const h = { ask, call: (op) => ask('call', { op }), kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); return exited; },
    // Opens the state directory in the child and tries to take `jobId`: `code` is null once it holds it.
    take: (jobId, options = {}) => ask('hold', { dir: w.dir, claim: w.key.claim, pkcs8: w.key.pkcs8, listingPin: PIN, jobId, ...options }) };
  w.children.push(h);
  await answer('ready');
  return h;
}

// Captures this store's own stderr lines while `work` runs.
async function sellerStateLines(work) {
  const lines = [], write = process.stderr.write;
  process.stderr.write = function capture(chunk, ...rest) {
    if (String(chunk).startsWith('seller-state:')) { lines.push(String(chunk)); return true; }
    return write.call(this, chunk, ...rest);
  };
  try { return { value: await work(), lines }; } finally { process.stderr.write = write; }
}

// Main's store, copied into a private directory with its two imports pinned to
// this tree (see fixtures/seller-durable-state.main-06958bb.README.md).
async function mainStoreFactory(t) {
  let source = readFileSync(MAIN_FIXTURE, 'utf8');
  for (const [from, to] of [["from './fixture-anchors.mjs'", `from '${new URL('../src/dacs/fixture-anchors.mjs', import.meta.url).href}'`],
    ["from '@kynesyslabs/dacs'", `from '${import.meta.resolve('@kynesyslabs/dacs')}'`]]) {
    assert.equal(source.split(from).length, 2, `main fixture import occurs once: ${from}`);
    source = source.replace(from, () => to);
  }
  const file = join(privateDirectory(t, 'dacs-seller-locks-main-'), 'seller-durable-state-main.mjs');
  writeFileSync(file, source, { mode: 0o600 });
  return (await import(pathToFileURL(file).href)).createSellerDurableState;
}

test('a row whose holder has exited (its lease is free) is reclaimed in the entry transaction whatever its PID, this process\'s reused PID included; logged by job only; retained intents stay readback-only', async (t) => {
  const w = await world(t);
  const earlier = await w.open(), [job, otherPid] = jobs(2);
  // The earlier process retained a session, then a signing intent and an
  // anchor write whose outcomes are unknown, and was killed inside withJob.
  let writes = 0;
  const anchor = { jobId: job, logicalAddress: `demo/locks/${job}`, artifact: { kind: 'TEST' }, authorize: () => 'TEST' };
  await earlier.withJob(job, async () => {
    earlier.saveSession({ jobId: job, stage: 'retained' });
    w.failSign = 'earlier-bytes';
    assert.throws(() => earlier.signOnce('signature:earlier', Buffer.from('earlier-bytes')), /TEST signer outcome unknown/);
    w.failSign = null;
    await assert.rejects(earlier.anchor({ ...anchor, anchors: { write: async () => { writes += 1; throw new Error('TEST answer lost'); } } }), code('seller_anchor_reconciliation_required'));
  });
  const dead = ownerOf(process.pid, w.exitedHolder());
  w.plant(job, dead, process.pid);
  w.plant(otherPid, ownerOf(process.ppid, w.exitedHolder()), process.ppid);
  const effects = w.table('seller_effects');
  assert.deepEqual(earlier.inspectLocks().map((row) => row.holderExited), [true, true]);

  const restarted = await w.open();
  const { value, lines } = await sellerStateLines(async () => {
    const session = await restarted.withJob(job, async (retained) => {
      const rows = restarted.inspectLocks().filter((row) => row.job === job);
      assert.equal(rows.length, 1); assert.notEqual(rows[0].owner, dead);
      assert.equal(rows[0].thisInstance, true); assert.equal(rows[0].thisProcess, true); assert.equal(rows[0].holderExited, false);
      // Readback only: the unknown signature is never made again and the anchor is only read.
      assert.throws(() => restarted.signOnce('signature:earlier', Buffer.from('earlier-bytes')), code('seller_signature_reconciliation_required'));
      await assert.rejects(restarted.anchor({ ...anchor, anchors: { write: async () => { writes += 1; }, read: async () => ({ status: 'absent' }) } }), code('seller_anchor_reconciliation_required'));
      restarted.saveSession({ ...retained, stage: 'resumed' });
      return retained;
    });
    await restarted.withJob(otherPid, async () => {});
    return session;
  });
  assert.deepEqual(value, { jobId: job, stage: 'retained' }, 'the job resumed from its retained session');
  assert.deepEqual(lines, [reclaimLine(job), reclaimLine(otherPid)], 'one fixed line per job, naming only the job; a live PID does not keep an exited holder\'s row');
  assert.equal(writes, 1, 'the anchor was written once, before the kill, and never again');
  assert.deepEqual(w.table('seller_effects'), effects, 'retained intents unchanged');
  assert.deepEqual(restarted.inspectLocks(), []);
  assert.deepEqual(restarted.loadSession(job), { jobId: job, stage: 'resumed' });
});

test('fail closed: a row of this boot whose holder lease is missing, not a private regular file, or unreadable stays busy, says so once per row, and is refused release as unproven', async (t) => {
  const w = await world(t);
  const store = await w.open(), holders = join(w.dir, 'holders');
  const cases = {
    missing: () => randomUUID(),
    directory: () => { const id = randomUUID(); mkdirSync(join(holders, `${id}.sqlite`), { mode: 0o700 }); return id; },
    symlink: () => { const id = randomUUID(); symlinkSync(join(holders, `${w.exitedHolder()}.sqlite`), join(holders, `${id}.sqlite`)); return id; },
    shared: () => { const id = w.exitedHolder(); chmodSync(join(holders, `${id}.sqlite`), 0o644); return id; },
    unreadable: () => { const id = w.exitedHolder(); chmodSync(join(holders, `${id}.sqlite`), 0o000); return id; },
    corrupt: () => { const id = randomUUID(); writeFileSync(join(holders, `${id}.sqlite`), 'not a database, and not empty', { mode: 0o600 }); return id; },
  };
  for (const [label, make] of Object.entries(cases)) {
    const [job] = jobs(1), owner = ownerOf(process.pid, make());
    w.plant(job, owner, process.pid);
    const { lines } = await sellerStateLines(async () => {
      for (let i = 0; i < 2; i += 1) await assert.rejects(store.withJob(job, async () => {}), code('seller_state_busy'), label);
    });
    assert.deepEqual(lines, [busyLine(job, 'lease-unproven')], `${label}: one line for the row, not one per request`);
    assert.throws(() => store.releaseAbandonedLock({ job, owner }), code('seller_state_lock_unproven'), label);
    const row = store.inspectLocks().find((r) => r.job === job);
    assert.deepEqual([row.holderExited, row.reason, row.boot], [false, 'lease-unproven', HERE ? 'this' : null], label);
  }
  assert.equal(store.inspectLocks().length, Object.keys(cases).length);
});

test('a row from another boot, or naming no PID namespace, is never reclaimed: withJob() stays busy and says so once per row and interval, inspectLocks() gives the reason, and the operator releases it', async (t) => {
  const w = await world(t);
  const store = await w.open(), [another, none, legacy] = jobs(3);
  // Free leases, but nothing proves their holders gone: another boot's (or
  // another kernel's) lock table is not this one, and a row naming no
  // namespace names no boot.
  const rows = {
    [another]: [ownerOf(process.pid, w.exitedHolder(), { namespace: HERE && { ...HERE, boot: randomUUID() } }), HERE ? 'other-boot' : 'no-identity', HERE ? 'other' : null],
    [none]: [ownerOf(process.pid, w.exitedHolder(), { namespace: null }), 'no-identity', null],
    [legacy]: [mainOwner(process.pid), 'legacy-format', null],
  };
  for (const [job, [owner]] of Object.entries(rows)) w.plant(job, owner, process.pid);
  const busy = async () => { for (const job of Object.keys(rows)) await assert.rejects(store.withJob(job, async () => {}), code('seller_state_busy'), job); };
  const expected = Object.entries(rows).map(([job, [, reason]]) => busyLine(job, reason));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  assert.deepEqual((await sellerStateLines(async () => { await busy(); await busy(); })).lines, expected, 'one line per row, however many requests');
  t.mock.timers.tick(10 * 60 * 1000 - 1);
  assert.deepEqual((await sellerStateLines(busy)).lines, [], 'still within the interval');
  t.mock.timers.tick(1);
  assert.deepEqual((await sellerStateLines(busy)).lines, expected, 'again once the interval has passed');
  t.mock.timers.reset();
  for (const row of store.inspectLocks()) {
    const [, reason, boot] = rows[row.job];
    assert.deepEqual({ holderExited: row.holderExited, reason: row.reason, boot: row.boot, pidNamespace: row.pidNamespace }, { holderExited: row.process ? false : null, reason, boot, pidNamespace: null }, row.job);
  }
  // The operator's word (no process that could hold them runs) releases each exact row; the job then runs.
  const records = w.records();
  for (const [job, [owner]] of Object.entries(rows)) {
    assert.deepEqual(store.releaseAbandonedLock({ job, owner }), { released: true, recordsChanged: 0 }, job);
    assert.equal(await store.withJob(job, async () => 'ran'), 'ran');
  }
  assert.deepEqual(w.records(), records);
  assert.deepEqual(store.inspectLocks(), []);
});

test('a live holder in another process stays busy for this process and for a second copy of the module, and is never released, even in the reused-PID shape, seen from a sibling PID namespace or recorded under another boot; once SIGKILLed, the rows naming it on this boot are reclaimed, and a main-format row with its gone PID and the other-boot row are not', async (t) => {
  const w = await world(t);
  const store = await w.open(), [live, shaped, legacy, sibling, rebooted] = jobs(5);
  const other = await holder(w, live);
  // The shape the earlier build reclaimed: this process's PID, another process.
  w.plant(shaped, ownerOf(process.pid, other.row.process), process.pid);
  w.plant(legacy, mainOwner(other.pid), other.pid);
  // The same live holder as another container on this host would record it: a
  // PID not visible here, in another PID namespace on this boot. Only its
  // lease can show it alive.
  const hidden = invisiblePid();
  w.plant(sibling, ownerOf(hidden, other.row.process, { namespace: HERE && { ...HERE, ns: String(BigInt(HERE.ns) + 1n) } }), hidden);
  // The same live holder under another boot id (another kernel sharing the
  // directory): its held lease still shows it alive.
  w.plant(rebooted, ownerOf(hidden, other.row.process, { namespace: HERE && { ...HERE, boot: randomUUID() } }), hidden);
  assert.equal(leaseFromAnotherProcess(w.dir, other.row.process), 'held');
  const copy = await w.open((await import(`${MODULE.href}?second-copy`)).createSellerDurableState);
  for (const s of [store, copy]) {
    const { lines } = await sellerStateLines(async () => {
      for (const job of [live, shaped, sibling, rebooted]) await assert.rejects(s.withJob(job, async () => {}), code('seller_state_busy'), job);
    });
    assert.deepEqual(lines, [], 'a live holder is the ordinary busy answer: no line');
    await assert.rejects(s.withJob(legacy, async () => {}), code('seller_state_busy'));
    const rows = s.inspectLocks();
    for (const job of [live, shaped, sibling, rebooted]) {
      const row = rows.find((r) => r.job === job);
      assert.equal(row.holderExited, false); assert.equal(row.thisProcess, false); assert.equal(row.reason, 'live', job);
      assert.throws(() => s.releaseAbandonedLock({ job, owner: row.owner }), code('seller_state_lock_live'));
    }
  }
  assert.equal(store.inspectLocks().length, 5);
  await other.kill();
  assert.equal(leaseFromAnotherProcess(w.dir, other.row.process), 'free');
  assert.deepEqual(Object.fromEntries(store.inspectLocks().map((row) => [row.job, [row.holderExited, row.reason]])),
    { [live]: [true, 'exited'], [shaped]: [true, 'exited'], [sibling]: [true, 'exited'], [legacy]: [null, 'legacy-format'], [rebooted]: [false, HERE ? 'other-boot' : 'no-identity'] }, 'its lease was freed by the kernel');
  const { lines } = await sellerStateLines(async () => {
    for (const job of [live, shaped, sibling]) await store.withJob(job, async () => assert.equal(store.inspectLocks().find((row) => row.job === job).thisInstance, true));
  });
  assert.deepEqual(lines.sort(), [reclaimLine(live), reclaimLine(shaped), reclaimLine(sibling)].sort());
  // A gone PID proves nothing about a main-format row: its holder may be alive
  // in another PID namespace. A free lease proves nothing about another boot.
  await assert.rejects(store.withJob(legacy, async () => {}), code('seller_state_busy'), 'main\'s row is never reclaimed by its PID');
  await assert.rejects(store.withJob(rebooted, async () => {}), code('seller_state_busy'), 'another boot\'s row is never reclaimed');
  assert.deepEqual(store.inspectLocks().map((row) => [row.job, row.holderExited]).sort(), [[legacy, null], [rebooted, false]].sort());
});

test('one process value per realm: sibling stores, re-entry and a second module copy stay busy on this process\'s rows however old, and a worker thread cannot open seller state', async (t) => {
  const w = await world(t);
  const a = await w.open(), b = await w.open(), [job, old] = jobs(2);
  const copy = await w.open((await import(`${MODULE.href}?realm-copy`)).createSellerDurableState);
  const held = hold(a, job);
  const { lines } = await sellerStateLines(async () => {
    await assert.rejects(b.withJob(job, async () => {}), code('seller_state_busy'), 'sibling store');
    await assert.rejects(copy.withJob(job, async () => {}), code('seller_state_busy'), 'second module copy');
    await assert.rejects(a.withJob(job, async () => {}), code('seller_state_busy'), 're-entry');
  });
  assert.deepEqual(lines, []);
  const [row] = a.inspectLocks();
  assert.equal(row.pid, process.pid); assert.equal(row.thisInstance, true); assert.equal(row.thisProcess, true); assert.equal(row.holderExited, false);
  assert.deepEqual(b.inspectLocks(), [{ ...row, thisInstance: false }]);
  assert.deepEqual(copy.inspectLocks(), [{ ...row, thisInstance: false }], 'the module copy shares this realm\'s process value');
  for (const s of [a, b, copy]) assert.throws(() => s.releaseAbandonedLock({ job, owner: row.owner }), code('seller_state_lock_live'));
  held.inside(() => a.saveSession({ jobId: job, stage: 'held' }));
  await held.release();
  // A row of this live process taken long ago is never reclaimed by age.
  w.plant(old, ownerOf(process.pid, row.process, { at: 1 }), process.pid);
  await assert.rejects(b.withJob(old, async () => {}), code('seller_state_busy'));
  assert.equal(b.inspectLocks()[0].acquiredAt, '1970-01-01T00:00:00.001Z');

  const signing = `import { workerData, parentPort } from 'node:worker_threads';
    const { createSellerDurableState } = await import(workerData.module);
    try { await createSellerDurableState({ ...workerData.options, signer: { claim: workerData.claim, sign: () => Buffer.alloc(64) } }); parentPort.postMessage('opened'); } catch (error) { parentPort.postMessage(error.code ?? error.message); }`;
  const signed = new Worker(new URL(`data:text/javascript,${encodeURIComponent(signing)}`), { workerData: { module: MODULE.href, claim: w.key.claim, options: { dir: w.dir, listingPin: PIN } } });
  assert.equal(await new Promise((resolve, reject) => { signed.once('message', resolve); signed.once('error', reject); }), 'seller_state_main_thread_required');
  assert.deepEqual(a.inspectLocks().map((r) => r.job), [old]);
});

test('inspectLocks lists every row with its PID, process, acquisition time, PID namespace and holder state; a row whose owner PID and pid column differ names no process and stays busy', async (t) => {
  const w = await world(t);
  const a = await w.open(), b = await w.open(), [mine, legacy, exited, mismatched] = jobs(4);
  const held = hold(a, mine);
  const at = Date.UTC(2026, 9, 1, 12), identity = w.exitedHolder(), legacyOwner = mainOwner(process.pid), exitedRow = ownerOf(process.pid, identity, { at });
  // Owner PID differs from the pid column (which is alive); its named holder's lease is free.
  const mismatchedRow = ownerOf(process.pid + 1, w.exitedHolder(), { at });
  w.plant(legacy, legacyOwner, process.pid); w.plant(exited, exitedRow, process.pid); w.plant(mismatched, mismatchedRow, process.pid);
  const own = a.inspectLocks().find((row) => row.job === mine);
  const suffix = HERE ? `:${HERE.ns}.${HERE.boot}.${HERE.start}`.replaceAll('.', '\\.') : '';
  assert.match(own.owner, new RegExp(`^${process.pid}:${own.process}:\\d+:[0-9a-f-]{36}${suffix}$`));
  assert.ok(Math.abs(Date.parse(own.acquiredAt) - Date.now()) < 60000);
  const here = HERE ? 'this' : null;
  const expected = [
    { job: mine, owner: own.owner, pid: process.pid, process: own.process, acquiredAt: own.acquiredAt, boot: here, pidNamespace: here, holderExited: false, reason: 'this-process', thisProcess: true, thisInstance: true },
    { job: legacy, owner: legacyOwner, pid: process.pid, process: null, acquiredAt: null, boot: null, pidNamespace: null, holderExited: null, reason: 'legacy-format', thisProcess: false, thisInstance: false },
    { job: exited, owner: exitedRow, pid: process.pid, process: identity, acquiredAt: new Date(at).toISOString(), boot: here, pidNamespace: here, holderExited: Boolean(HERE), reason: HERE ? 'exited' : 'no-identity', thisProcess: false, thisInstance: false },
    { job: mismatched, owner: mismatchedRow, pid: process.pid, process: null, acquiredAt: null, boot: null, pidNamespace: null, holderExited: null, reason: 'unrecognised', thisProcess: false, thisInstance: false },
  ].sort((x, y) => (x.job < y.job ? -1 : 1));
  assert.deepEqual(a.inspectLocks(), expected);
  assert.deepEqual(b.inspectLocks(), expected.map((row) => ({ ...row, thisInstance: false })));
  await assert.rejects(b.withJob(mismatched, async () => {}), code('seller_state_busy'), 'its pid column answers');
  await held.release();
});

test('releaseAbandonedLock removes only the exact named row once its holder has exited; it refuses a mismatched job, owner or acquisition and any live holder', async (t) => {
  const w = await world(t);
  const a = await w.open(), b = await w.open(), [legacy, exited, mine, other] = jobs(4);
  await a.withJob(legacy, async () => {
    a.saveSession({ jobId: legacy, stage: 'retained' });
    assert.equal(a.bindSettlement('TEST-settlement', legacy), true);
  });
  const identity = w.exitedHolder(), legacyOwner = mainOwner(process.pid), exitedRow = ownerOf(process.pid, identity);
  w.plant(legacy, legacyOwner, process.pid); w.plant(exited, exitedRow, process.pid);
  const held = hold(a, mine), own = a.inspectLocks().find((row) => row.job === mine);
  const locks = w.table('seller_locks'), records = w.records();
  const [pid, , time, acquisition] = exitedRow.split(':');
  const refused = [
    [undefined, 'seller_state_lock_invalid'],
    [{ job: legacy }, 'seller_state_lock_invalid'],
    [{ job: 'not-a-job', owner: legacyOwner }, 'seller_state_lock_invalid'],
    [{ job: other, owner: legacyOwner }, 'seller_state_lock_mismatch'],
    [{ job: exited, owner: legacyOwner }, 'seller_state_lock_mismatch'],
    [{ job: legacy, owner: mainOwner(process.pid) }, 'seller_state_lock_mismatch'],
    [{ job: exited, owner: `${pid}:${identity}:${time}:${randomUUID()}` }, 'seller_state_lock_mismatch'], // another acquisition (the fence)
    [{ job: exited, owner: `${Number(pid) + 1}:${identity}:${time}:${acquisition}` }, 'seller_state_lock_mismatch'],
    [{ job: exited, owner: `${pid}:${randomUUID()}:${time}:${acquisition}` }, 'seller_state_lock_mismatch'],
    [{ job: mine, owner: own.owner }, 'seller_state_lock_live'],
  ];
  for (const [store, label] of [[a, 'holder'], [b, 'sibling']]) {
    for (const [request, expected] of refused) assert.throws(() => store.releaseAbandonedLock(request), code(expected), `${label} ${JSON.stringify(request)}`);
  }
  assert.deepEqual(w.table('seller_locks'), locks, 'every refusal changed nothing');
  assert.deepEqual(b.releaseAbandonedLock({ job: legacy, owner: legacyOwner }), { released: true, recordsChanged: 0 });
  assert.deepEqual(b.releaseAbandonedLock({ job: exited, owner: exitedRow }), { released: true, recordsChanged: 0 });
  assert.throws(() => b.releaseAbandonedLock({ job: legacy, owner: legacyOwner }), code('seller_state_lock_mismatch'), 'released once');
  assert.deepEqual(w.records(), records, 'sessions, effects, settlements and context unchanged');
  assert.deepEqual(a.inspectLocks().map((row) => row.job), [mine]);
  held.inside(() => a.saveSession({ jobId: mine, stage: 'still held' }));
  await held.release();
  assert.deepEqual(await b.withJob(legacy, async (session) => session), { jobId: legacy, stage: 'retained' }, 'the released job resumes from its retained session');
});

test('a holder that lost its row, or runs outside its acquisition, is fenced on every job-scoped write before any external call', async (t) => {
  const w = await world(t);
  const a = await w.open(), b = await w.open(), [job, other] = jobs(2);
  let writes = 0, reads = 0;
  const anchors = { write: async () => { writes += 1; throw new Error('TEST answer lost'); }, read: async () => { reads += 1; return { status: 'absent' }; } };
  const anchorAt = (logicalAddress) => ({ jobId: job, logicalAddress, artifact: { kind: 'TEST' }, anchors, authorize: () => 'TEST' });
  const held = hold(a, job);
  // Retained before the row is lost: an anchor intent (for reconcileAnchor) and a buyer slot.
  await held.inside(() => assert.rejects(a.anchor(anchorAt(`TEST/retained/${job}`)), code('seller_anchor_reconciliation_required')));
  held.inside(() => a.reserveSignatureCommitment('did:demos:agent:TEST-buyer', job));
  const base = { signs: w.signs, writes, reads };
  const writesFor = {
    saveSession: () => a.saveSession({ jobId: job, stage: 'lost' }),
    signOnce: () => a.signOnce('signature:fenced', Buffer.from('fenced-bytes')),
    anchor: () => a.anchor(anchorAt(`TEST/new/${job}`)),
    reconcileAnchor: () => a.reconcileAnchor(`anchor:TEST/retained/${job}`, anchors),
    readAnchor: () => a.readAnchor({ jobId: job, logicalAddress: `TEST/retained/${job}`, anchors }),
    bindSettlement: () => a.bindSettlement('TEST-fenced-settlement', job),
    reserveSignatureCommitment: () => a.reserveSignatureCommitment('did:demos:agent:TEST-other-buyer', job),
    releaseSignatureCommitment: () => a.releaseSignatureCommitment('did:demos:agent:TEST-buyer', job),
    assertHeld: () => a.assertHeld(job),
  };
  assert.equal(held.inside(() => a.assertHeld(job)), true, 'control: the holder holds its row');
  const fenced = async (label, run) => { await assert.rejects(async () => run(), code('seller_state_fenced'), label); };
  // Outside any acquisition: fenced, whatever the store holds.
  // Readbacks outside any acquisition are the lock-free reconcile seam: allowed, as before.
  for (const [label, write] of Object.entries(writesFor)) if (!/^re(concile|ad)Anchor$/.test(label)) await fenced(`outside: ${label}`, write);
  // Inside the acquisition, for another job: fenced.
  await held.inside(() => fenced('other job', () => a.bindSettlement('TEST-fenced-settlement', other)));
  // The row is lost while the holder lives (the rollback DELETE, or main's
  // code reclaiming across PID namespaces), and another store takes the job.
  w.unplant(job);
  const next = hold(b, job);
  for (const [label, write] of Object.entries(writesFor)) await held.inside(() => fenced(`released: ${label}`, write));
  assert.deepEqual({ signs: w.signs, writes, reads }, base, 'no signer, anchor write or anchor read call');
  await held.release();
  // A straggler from a finished acquisition is fenced too.
  await held.inside(() => fenced('straggler', () => a.saveSession({ jobId: job, stage: 'late' })));
  assert.equal(b.inspectLocks().find((row) => row.job === job).thisInstance, true, 'the old holder\'s exit left the next holder\'s row');
  next.inside(() => b.saveSession({ jobId: job, stage: 'next holder' }));
  await next.release();
  assert.deepEqual(b.loadSession(job), { jobId: job, stage: 'next holder' }, 'no fenced write landed');
  assert.equal(w.table('seller_settlements').length, 0);
  // The same store takes the job again: a straggler from its earlier acquisition is still fenced.
  const again = hold(a, job);
  await held.inside(() => fenced('straggler while its store holds the job again', () => a.saveSession({ jobId: job, stage: 'late' })));
  await held.inside(() => fenced('straggler check while its store holds the job again', () => a.assertHeld(job)));
  again.inside(() => a.saveSession({ jobId: job, stage: 'again' }));
  await again.release();
  assert.deepEqual(a.loadSession(job), { jobId: job, stage: 'again' }, 'only the current acquisition wrote');
});

test('a holder in another process: its release is refused while it lives; if its row is lost anyway, each of its job-scoped writes is fenced with no external call', async (t) => {
  const w = await world(t);
  const store = await w.open(), [job] = jobs(1);
  await store.withJob(job, async () => store.saveSession({ jobId: job, stage: 'retained' }));
  const other = await holder(w, job);
  assert.deepEqual(other.session, { jobId: job, stage: 'retained' });
  const [row] = store.inspectLocks();
  assert.equal(row.pid, other.pid); assert.equal(row.thisProcess, false); assert.equal(row.holderExited, false);
  await assert.rejects(store.withJob(job, async () => {}), code('seller_state_busy'));
  assert.throws(() => store.releaseAbandonedLock({ job, owner: row.owner }), code('seller_state_lock_live'), 'the operator cannot release a live holder');
  assert.deepEqual((await other.call('save')), { type: 'call', code: null, signs: 0, writes: 0, reads: 0 }, 'control: the live holder writes');
  w.unplant(job);
  for (const op of ['save', 'sign', 'anchor', 'bind', 'reserve', 'releaseCommitment']) {
    assert.deepEqual(await other.call(op), { type: 'call', code: 'seller_state_fenced', signs: 0, writes: 0, reads: 0 }, op);
  }
  assert.equal((await other.call('reenter')).code, 'seller_state_busy', 'it cannot take the job again while that step runs');
  const next = hold(store, job);
  const finished = await other.ask('finish');
  assert.equal(finished.code, null);
  assert.deepEqual(finished.locks.map((lock) => [lock.job, lock.thisInstance]), [[job, false]], 'its exit removed only its own row');
  next.inside(() => store.saveSession({ jobId: job, stage: 'next holder' }));
  await next.release();
  assert.deepEqual(store.loadSession(job), { jobId: job, stage: 'next holder' }, 'no fenced write landed');
});

test('a database written by main\'s store opens unchanged and works; each version keeps the other\'s live rows busy', async (t) => {
  const w = await world(t);
  const old = await w.open(await mainStoreFactory(t)), [kept, legacy] = jobs(2);
  await old.withJob(kept, async () => old.saveSession({ jobId: kept, stage: 'retained' }));
  const signature = old.signOnce('signature:main', Buffer.from('main-bytes'));
  assert.equal(old.bindSettlement('TEST-main-settlement', kept), true);
  const oldHold = hold(old, legacy);
  const records = w.records(), [mainRow] = w.table('seller_locks');
  const schema = w.schema();
  assert.match(mainRow.owner, new RegExp(`^${process.pid}:[0-9a-f-]{36}$`), 'main\'s row names no process');

  const current = await w.open();
  assert.deepEqual(w.schema(), schema, 'no table added, dropped or rewritten');
  assert.deepEqual(w.records(), records);
  assert.deepEqual(current.context(), CONTEXT);
  assert.deepEqual(current.sessions(), [{ jobId: kept, stage: 'retained' }]);
  assert.deepEqual(await current.withJob(kept, async () => current.signOnce('signature:main', Buffer.from('main-bytes'))), signature);
  assert.equal(current.settlementJob('TEST-main-settlement'), kept);
  // Main's row with this live PID (the restarted container's PID) stays busy.
  await assert.rejects(current.withJob(legacy, async () => {}), code('seller_state_busy'));
  assert.deepEqual(current.inspectLocks(), [{ job: legacy, owner: mainRow.owner, pid: process.pid, process: null, acquiredAt: null, boot: null, pidNamespace: null, holderExited: null, reason: 'legacy-format', thisProcess: false, thisInstance: false }]);
  const currentHold = hold(current, kept);
  await assert.rejects(old.withJob(kept, async () => {}), code('seller_state_busy'), 'main keeps the current store\'s live row busy');
  currentHold.inside(() => current.saveSession({ jobId: kept, stage: 'current' }));
  await currentHold.release();
  assert.deepEqual(await old.withJob(kept, async (session) => session), { jobId: kept, stage: 'current' }, 'main reads what the current store wrote');
  // Only the operator's release frees main's row, and its live holder is then fenced.
  assert.deepEqual(current.releaseAbandonedLock({ job: legacy, owner: mainRow.owner }), { released: true, recordsChanged: 0 });
  assert.throws(() => old.saveSession({ jobId: legacy }), code('seller_state_fenced'));
  await oldHold.release();
  assert.deepEqual(await current.withJob(legacy, async (session) => session), null);
  assert.deepEqual(w.schema(), schema);
});

test('a live holder running main\'s code is never taken over when its PID names no process here, as from a sibling PID namespace; only the operator\'s exact-row release frees its row', async (t) => {
  const w = await world(t);
  const old = await w.open(await mainStoreFactory(t)), current = await w.open(), [job] = jobs(1);
  const oldHold = hold(old, job);
  old.saveSession({ jobId: job, stage: 'main holder' });
  // Seen from another container on the same volume, the live holder's PID is
  // one this namespace does not have.
  const hidden = invisiblePid();
  w.repid(job, hidden);
  await assert.rejects(current.withJob(job, async () => {}), code('seller_state_busy'), 'a PID that is not visible here proves nothing about its holder');
  const [row] = current.inspectLocks();
  assert.deepEqual({ pid: row.pid, process: row.process, pidNamespace: row.pidNamespace, holderExited: row.holderExited }, { pid: hidden, process: null, pidNamespace: null, holderExited: null });
  old.saveSession({ jobId: job, stage: 'main holder, still live' });
  assert.deepEqual(current.loadSession(job), { jobId: job, stage: 'main holder, still live' }, 'the live holder was never fenced');
  // After every process of the earlier version has stopped, the operator releases the exact row.
  assert.deepEqual(current.releaseAbandonedLock({ job, owner: row.owner }), { released: true, recordsChanged: 0 });
  assert.throws(() => old.saveSession({ jobId: job, stage: 'late' }), code('seller_state_fenced'));
  await oldHold.release();
  assert.deepEqual(await current.withJob(job, async (session) => session), { jobId: job, stage: 'main holder, still live' });
});

test('each row records its holder\'s PID namespace, boot and start time; a row\'s PID is consulted only in its own namespace, and only to keep the row busy', async (t) => {
  if (!HERE) { t.skip('this host has no /proc'); return; }
  const w = await world(t);
  const store = await w.open(), [mine, runs, reused, elsewhere] = jobs(4);
  const held = hold(store, mine);
  const [own] = store.inspectLocks();
  assert.ok(own.owner.endsWith(`:${HERE.ns}.${HERE.boot}.${HERE.start}`), `the row names this PID namespace, boot and start time: ${own.owner}`);
  assert.equal(own.pidNamespace, 'this');
  const hidden = invisiblePid();
  // Each planted row names a holder whose lease is free.
  const planted = {
    // This PID, here, still runs the process with the recorded start time: alive, whatever its lease shows.
    [runs]: [ownerOf(process.pid, w.exitedHolder(), { namespace: HERE }), process.pid],
    // This PID now runs a later process: the one that took the row has exited.
    [reused]: [ownerOf(process.pid, w.exitedHolder(), { namespace: { ...HERE, start: String(BigInt(HERE.start) - 1n) } }), process.pid],
    // Another PID namespace: its PID is never looked up here, and the lease decides.
    [elsewhere]: [ownerOf(hidden, w.exitedHolder(), { namespace: { ...HERE, ns: String(BigInt(HERE.ns) + 1n) } }), hidden],
  };
  for (const [job, [owner, pid]] of Object.entries(planted)) w.plant(job, owner, pid);
  assert.deepEqual(Object.fromEntries(store.inspectLocks().map((row) => [row.job, [row.pidNamespace, row.holderExited]])),
    { [mine]: ['this', false], [runs]: ['this', false], [reused]: ['this', true], [elsewhere]: ['other', true] });
  await assert.rejects(store.withJob(runs, async () => {}), code('seller_state_busy'), 'its PID still runs it here');
  assert.throws(() => store.releaseAbandonedLock({ job: runs, owner: planted[runs][0] }), code('seller_state_lock_live'));
  const { lines } = await sellerStateLines(async () => { for (const job of [reused, elsewhere]) await store.withJob(job, async () => {}); });
  assert.deepEqual(lines, [reclaimLine(reused), reclaimLine(elsewhere)]);
  await held.release();
});

test('a holder that loses its row while the signer runs keeps no signature and records no completion; the next holder finds the intent and never signs again', async (t) => {
  const w = await world(t);
  const a = await w.open(), b = await w.open(), [job] = jobs(1);
  const held = hold(a, job);
  let next;
  // The row is lost while the signer runs (a raw DELETE, or the earlier
  // version's code), and another store takes the job.
  w.duringSign = () => { w.unplant(job); next = hold(b, job); };
  assert.throws(() => held.inside(() => a.signOnce('signature:in-flight', Buffer.from('in-flight-bytes'))), code('seller_state_fenced'));
  assert.equal(w.signs, 1, 'the signer ran once');
  assert.equal(w.effectState('signature:in-flight'), 'intent', 'no completion landed');
  assert.deepEqual(b.signature('signature:in-flight'), { disposition: 'indeterminate', reason: 'retained signer outcome is unknown' });
  assert.throws(() => next.inside(() => b.signOnce('signature:in-flight', Buffer.from('in-flight-bytes'))), code('seller_signature_reconciliation_required'));
  assert.equal(w.signs, 1, 'never signed again');
  await next.release();
  await held.release();
});

test('a holder that loses its row while its anchor write is in flight records no completion; the next holder completes it by readback and nothing is written twice', async (t) => {
  const w = await world(t);
  const a = await w.open(), b = await w.open(), [job] = jobs(1);
  const sink = memoryAnchors(w.key.claim), logicalAddress = `TEST/in-flight/${job}`, artifact = { kind: 'TEST', jobId: job };
  const held = hold(a, job);
  let next;
  // The external write commits; then the row is lost and another store takes
  // the job before the old holder hears back.
  sink.afterWrite = () => { w.unplant(job); next = hold(b, job); };
  await assert.rejects(held.inside(() => a.anchor({ jobId: job, logicalAddress, artifact, anchors: sink, authorize: authorizeIn(a, logicalAddress, artifact) })), code('seller_state_fenced'));
  assert.equal(sink.writes, 1);
  assert.equal(w.effectState(`anchor:${logicalAddress}`), 'intent', 'the stale holder recorded no completion');
  const read = await next.inside(() => b.readAnchor({ jobId: job, logicalAddress, anchors: sink }));
  assert.deepEqual(read.artifact, artifact);
  assert.equal(w.effectState(`anchor:${logicalAddress}`), 'complete', 'completed by the next holder\'s authenticated readback');
  await next.inside(() => b.anchor({ jobId: job, logicalAddress, artifact, anchors: sink, authorize: authorizeIn(b, logicalAddress, artifact) }));
  assert.equal(sink.writes, 1, 'written once in total');
  await next.release();
  await held.release();
});

test('the row is checked again last before an anchor write leaves: a holder that loses it while authorizing the write sends nothing, and the next holder only reads back', async (t) => {
  const w = await world(t);
  const a = await w.open(), b = await w.open(), [job] = jobs(1);
  const sink = memoryAnchors(w.key.claim), logicalAddress = `TEST/authorizing/${job}`, artifact = { kind: 'TEST', jobId: job };
  const held = hold(a, job);
  let next;
  const authorize = () => { const writerSignature = authorizeIn(a, logicalAddress, artifact)(); w.unplant(job); next = hold(b, job); return writerSignature; };
  await assert.rejects(held.inside(() => a.anchor({ jobId: job, logicalAddress, artifact, anchors: sink, authorize })), code('seller_state_fenced'));
  assert.equal(sink.writes, 0, 'nothing was written');
  assert.equal(w.effectState(`anchor:${logicalAddress}`), 'intent');
  await assert.rejects(next.inside(() => b.anchor({ jobId: job, logicalAddress, artifact, anchors: sink, authorize: authorizeIn(b, logicalAddress, artifact) })), code('seller_anchor_reconciliation_required'));
  assert.equal(sink.writes, 0, 'the retained intent is only read back');
  await next.release();
  await held.release();
});

// The native publisher's authorize contract (devnet-demo/artifact-anchor.mjs):
// under the address lock, after its awaited reads and before it stores its
// CREATE intent, it calls authorize; a throw or anything but true refuses with
// no intent stored and nothing sent; without authorize it publishes as before.
// `loseRow` removes the job's row first, as a raw DELETE or the earlier
// version's reclaim from another PID namespace would.
function honourAuthorize(w, { loseRow }) {
  const anchor = w.buildOptions.nativeArtifactAnchor, publish = anchor.publish, seen = { authorize: 'not asked' };
  anchor.publish = async (input) => {
    if (loseRow) {
      const db = new DatabaseSync(join(w.buildOptions.durableDirectory, 'seller-state.sqlite'));
      try { db.prepare('DELETE FROM seller_locks WHERE job=?').run(w.jobId); } finally { db.close(); }
    }
    if (input.authorize) {
      try { seen.authorize = input.authorize(); } catch (error) { seen.authorize = error.code; throw error; }
      if (seen.authorize !== true) throw new Error('TEST not-authorized: no intent was stored and nothing was sent');
    } else seen.authorize = 'no authorize hook';
    return publish(input);
  };
  return seen;
}

test('the seller agent checks its job lock last before a native CREATE: a holder that lost its row stores no intent and sends nothing', async (t) => {
  const control = await commitWorld(t), allowed = honourAuthorize(control, { loseRow: false });
  await control.agent.commit({ jobId: control.jobId });
  assert.equal(allowed.authorize, true, 'control: the holder that keeps its row is authorized');
  assert.equal(control.effects.publish, 1, 'control: one CREATE');

  const w = await commitWorld(t), seen = honourAuthorize(w, { loseRow: true });
  await assert.rejects(w.agent.commit({ jobId: w.jobId }), /ambiguous|seller_state_fenced/);
  assert.equal(seen.authorize, 'seller_state_fenced', 'the publisher was told no before its intent');
  assert.equal(w.effects.publish, 0, 'no CREATE intent and nothing sent');
  assert.equal(w.native.stored, null);
});

test('a holder whose umask masks owner-write still takes an exclusive lease: other processes keep its row busy until it exits', async (t) => {
  const w = await world(t);
  const store = await w.open(), [job] = jobs(1);
  const other = await holder(w, job, { umask: 0o277 });
  assert.equal(statSync(join(w.dir, 'holders', `${other.row.process}.sqlite`)).mode & 0o777, 0o600, 'its lease file is private and writable');
  assert.equal(leaseFromAnotherProcess(w.dir, other.row.process), 'held', 'its lease is exclusive');
  await assert.rejects(store.withJob(job, async () => {}), code('seller_state_busy'));
  assert.equal(store.inspectLocks()[0].holderExited, false);
  assert.throws(() => store.releaseAbandonedLock({ job, owner: other.row.owner }), code('seller_state_lock_live'));
  await other.kill();
  assert.equal(leaseFromAnotherProcess(w.dir, other.row.process), 'free');
  assert.equal(store.inspectLocks()[0].holderExited, true, 'freed by the kernel once it exits');
});

test('a process never opens its own lease file through a second path: that open is refused and the lease stays held for every other process', async (t) => {
  const w = await world(t);
  const store = await w.open(), [job] = jobs(1);
  const held = hold(store, job);
  const own = store.inspectLocks()[0];
  // A second directory whose holders/ reaches this process's lease file, as a
  // second mount of the same directory would.
  const alias = privateDirectory(t, 'dacs-seller-locks-alias-');
  closeSync(openSync(join(alias, 'seller-state.sqlite'), 'wx', 0o600));
  mkdirSync(join(alias, 'holders'), { mode: 0o700 });
  linkSync(join(w.dir, 'holders', `${own.process}.sqlite`), join(alias, 'holders', `${own.process}.sqlite`));
  await assert.rejects(createSellerDurableState({ dir: alias, signer: w.signer, listingPin: PIN }), code('seller_state_lease_unavailable'));
  assert.equal(leaseFromAnotherProcess(w.dir, own.process), 'held', 'this process still holds its lease');
  const other = await spawnHolder(w);
  assert.equal((await other.take(job)).code, 'seller_state_busy', 'another process still finds this live holder busy');
  await held.release();
});

test('without /proc (as on macOS and the BSDs) rows name the kern.boottime boot and the ps start second: a live holder stays busy, a PID that still runs its holder keeps its row busy, a reused PID does not, and a SIGKILLed holder\'s row is reclaimed', async (t) => {
  if (!BTIME) { t.skip('the no-/proc TEST children model it from Linux /proc/stat'); return; }
  const w = await world(t);
  const [job, runs, reused] = jobs(3);
  const first = await holder(w, job, {}, { noProcfs: true });
  const bsd = { ns: '0', boot: `bt${BTIME}` };
  assert.match(first.row.owner, new RegExp(`^${first.pid}:${first.row.process}:\\d+:[0-9a-f-]{36}:0\\.bt${BTIME}\\.${psStartOf(first.pid)}$`), 'boot from kern.boottime (whole seconds), start from ps');
  assert.deepEqual([first.row.boot, first.row.pidNamespace, first.row.reason], ['this', 'this', 'this-process']);
  const second = await spawnHolder(w, { noProcfs: true });
  assert.equal((await second.take(job)).code, 'seller_state_busy', 'its lease shows the holder alive');
  // Rows with free leases naming this process's PID: with its own ps start
  // second the PID still runs the holder; one second earlier, it is a later process.
  const started = psStartOf(process.pid);
  w.plant(runs, ownerOf(process.pid, w.exitedHolder(), { namespace: { ...bsd, start: started } }), process.pid);
  w.plant(reused, ownerOf(process.pid, w.exitedHolder(), { namespace: { ...bsd, start: String(Number(started) - 1) } }), process.pid);
  assert.equal((await second.take(runs)).code, 'seller_state_busy', 'its PID still runs the process that took it');
  const later = await second.take(reused);
  assert.equal(later.code, null, 'a reused PID does not keep an exited holder\'s row');
  await first.kill();
  const taken = await second.take(job);
  assert.equal(taken.code, null, 'reclaimed once its holder was SIGKILLed');
  const row = taken.locks.find((r) => r.job === job);
  assert.notEqual(row.owner, first.row.owner);
  assert.match(row.owner, new RegExp(`:0\\.bt${BTIME}\\.\\d+$`));
  assert.equal(taken.locks.find((r) => r.job === runs).reason, 'live');
});

test('a host with no boot and start identity at all warns once when seller state opens, writes rows naming none, and never reclaims them', async (t) => {
  if (!BTIME) { t.skip('the no-identity TEST child models it from Linux /proc/stat'); return; }
  const dir = privateDirectory(t, 'dacs-seller-locks-no-identity-'), [job, left] = jobs(2);
  const script = `const { generateKeyPairSync, sign } = await import('node:crypto');
    const { createSellerDurableState } = await import(process.argv[1]);
    const [dir, pin, job, left] = process.argv.slice(2);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const signer = { claim: 'did:demos:agent:' + publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'), sign: (bytes) => sign(null, Buffer.from(bytes), privateKey) };
    const open = () => createSellerDurableState({ dir, signer, listingPin: JSON.parse(pin) });
    const a = await open(), b = await open();
    const rows = await a.withJob(job, async () => b.inspectLocks());
    let busy = null;
    try { await b.withJob(left, async () => {}); } catch (error) { busy = error.code; }
    process.stdout.write(JSON.stringify({ rows, busy, left: b.inspectLocks() }));
    a.close(); b.close();`;
  // A row a process of this host left: no identity, and its lease is free.
  const run = (extra = []) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${NO_PROCFS.href}`, '--input-type=module', '-e', script, MODULE.href, dir, JSON.stringify(PIN), job, left, ...extra],
    { encoding: 'utf8', env: { ...process.env, TEST_SELLER_STATE_SYSCTL: 'absent' } });
  const opened = run();
  assert.equal(opened.status, 0, opened.stderr);
  const warning = 'seller-state: this host gives no boot and process start identity (no /proc, or kern.boottime and ps): a job lock left by a killed process is never reclaimed automatically; see inspectLocks() and releaseAbandonedLock()';
  assert.deepEqual(opened.stderr.split('\n').filter((line) => line.startsWith('seller-state:')), [warning], 'once per process, not per store');
  const { rows: [row] } = JSON.parse(opened.stdout);
  assert.match(row.owner, /^\d+:[0-9a-f-]{36}:\d+:[0-9a-f-]{36}$/, 'the row names no boot or start');
  assert.deepEqual([row.boot, row.pidNamespace, row.reason], [null, null, 'this-process']);
  const db = new DatabaseSync(join(dir, 'seller-state.sqlite'));
  try { db.prepare('INSERT INTO seller_locks VALUES (?,?,?)').run(left, `${row.pid}:${row.process}:1:${randomUUID()}`, row.pid); } finally { db.close(); }
  const again = run();
  assert.equal(again.status, 0, again.stderr);
  const answer = JSON.parse(again.stdout);
  assert.equal(answer.busy, 'seller_state_busy', 'its exited holder\'s row is never reclaimed without an identity');
  assert.deepEqual(answer.left.map((r) => [r.job, r.reason]), [[left, 'no-identity']]);
  assert.ok(again.stderr.includes(busyLine(left, 'no-identity')), 'and withJob() says so');
});

test('opening seller state prunes the lease files of exited processes that no row names and that predate the opening process by a minute; it keeps held (with or without a row), named, newer, recent, foreign and its own', async (t) => {
  const w = await world(t);
  const store = await w.open(), holders = join(w.dir, 'holders'), [mine, live, named, spare] = jobs(4);
  const held = hold(store, mine), own = store.inspectLocks()[0].process;
  await held.release();
  const other = await holder(w, live);
  // A live process holding no job: no row names its lease, which only its lock keeps.
  const idle = await holder(w, spare);
  assert.equal((await idle.ask('finish')).code, null);
  const past = new Date(performance.timeOrigin - 3600 * 1000), recent = new Date(performance.timeOrigin - 30 * 1000);
  const aged = (id, at = past) => { utimesSync(join(holders, `${id}.sqlite`), at, at); return id; };
  const files = {
    exited: aged(w.exitedHolder()),
    named: aged(w.exitedHolder()),
    newer: w.exitedHolder(),
    recent: aged(w.exitedHolder(), recent),
    held: aged(other.row.process),
    idle: aged(idle.row.process),
    shared: (() => { const id = aged(w.exitedHolder()); chmodSync(join(holders, `${id}.sqlite`), 0o644); return id; })(),
    own: aged(own),
  };
  writeFileSync(join(holders, 'notes.txt'), 'TEST foreign file', { mode: 0o600 });
  utimesSync(join(holders, 'notes.txt'), past, past);
  // An exited holder's row from another boot, which no free lease here can clear: its lease must stay.
  w.plant(named, ownerOf(process.pid, files.named, { namespace: HERE && { ...HERE, boot: randomUUID() } }), process.pid);
  const present = () => Object.fromEntries(Object.entries(files).map(([label, id]) => [label, existsSync(join(holders, `${id}.sqlite`))]));
  assert.deepEqual(present(), { exited: true, named: true, newer: true, recent: true, held: true, idle: true, shared: true, own: true });
  await w.open();
  assert.deepEqual(present(), { exited: false, named: true, newer: true, recent: true, held: true, idle: true, shared: true, own: true }, 'only the exited, unnamed lease older than the opener by a minute is removed');
  assert.equal(existsSync(join(holders, 'notes.txt')), true);
  assert.equal(leaseFromAnotherProcess(w.dir, own), 'held', 'this process still holds its own lease');
  assert.equal(leaseFromAnotherProcess(w.dir, other.row.process), 'held', 'the live holder still holds its lease');
  assert.equal(leaseFromAnotherProcess(w.dir, idle.row.process), 'held', 'and so does the idle live process');
  assert.equal(store.inspectLocks().find((row) => row.job === named).reason, HERE ? 'other-boot' : 'no-identity', 'the named row still reads its lease, not lease-unproven');
  // Once the live holder exits, its row is reclaimed; then nothing names its lease, and the next open removes it.
  await other.kill();
  assert.equal(store.inspectLocks().find((row) => row.job === live).reason, 'exited');
  await w.open();
  assert.equal(present().held, true, 'kept while its row names it');
  await store.withJob(live, async () => {});
  await w.open();
  assert.equal(present().held, false);
  assert.deepEqual(readdirSync(holders).filter((name) => !name.endsWith('.sqlite')), ['notes.txt']);
});

test('a process whose new lease file is removed before it locks it (a pruner in between) refuses to open rather than hold a lease no other process can see', async (t) => {
  const dir = privateDirectory(t, 'dacs-seller-locks-lease-race-');
  const script = `const { generateKeyPairSync, sign } = await import('node:crypto');
    const { createSellerDurableState } = await import(process.argv[1]);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const signer = { claim: 'did:demos:agent:' + publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'), sign: (bytes) => sign(null, Buffer.from(bytes), privateKey) };
    try { await createSellerDurableState({ dir: process.argv[2], signer, listingPin: JSON.parse(process.argv[3]) }); process.stdout.write('opened'); } catch (error) { process.stdout.write(String(error.code)); }`;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${new URL('./helpers/seller-state-lease-race.mjs', import.meta.url).href}`, '--input-type=module', '-e', script, MODULE.href, dir, JSON.stringify(PIN)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'seller_state_lease_unavailable');
});
