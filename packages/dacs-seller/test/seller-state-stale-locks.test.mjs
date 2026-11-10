import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import * as core from '@kynesyslabs/dacs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';

const LISTING_PIN = { listingId: 'stale-locks', version: 1, contentHash: 'a'.repeat(64) };
const HOLDER = new URL('./helpers/seller-durable-state-lock-holder.mjs', import.meta.url);
const seed = new Uint8Array(32).fill(23);
const privateKey = core.privateKeyFromSeed(seed);
const claim = `did:demos:agent:${Buffer.from(core.rawPublicKey(core.publicKeyFromSeed(seed))).toString('hex')}`;
const signer = { claim, sign: (bytes) => Buffer.from(core.ed25519Sign(bytes, privateKey)) };

function plantLock(dir, job, owner) {
  const db = new DatabaseSync(join(dir, 'seller-state.sqlite'));
  try { db.prepare('INSERT INTO seller_locks VALUES (?,?,?)').run(job, owner, Number(owner.split(':')[0])); } finally { db.close(); }
}
const reasons = (store) => Object.fromEntries(store.inspectLocks().map((row) => [row.job, row.reason]));

// A child process that has not opened a store yet; `hold` asks it to take `job` until it is killed.
async function forkHolder(t, dir, { maxJobs } = {}) {
  const child = fork(HOLDER, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const message = async (input) => { const reply = once(child, 'message'); child.send(input); return (await reply)[0]; };
  await once(child, 'message');
  return {
    message,
    hold: (job) => message({ type: 'hold', dir, listingPin: LISTING_PIN, jobId: job, maxJobs, claim, pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }),
    kill: async () => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; },
  };
}

// A child process that holds `job` until killed, with its lease held.
async function startHolder(t, dir, job, { save = false } = {}) {
  const holder = await forkHolder(t, dir);
  const held = await holder.hold(job);
  assert.equal(held.code, null, JSON.stringify(held));
  if (save) assert.equal((await holder.message({ type: 'call', op: 'save' })).code, null);
  return { kill: holder.kill };
}

async function openStore(t, prefix, options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await createSellerDurableState({ dir, signer, listingPin: LISTING_PIN, ...options });
  t.after(() => store.close());
  store.retainContext({ TEST: 'context' });
  return { dir, store };
}
const lockOf = (store, job) => store.inspectLocks().find((row) => row.job === job);

test('releaseStaleLocks releases rows of holders that are gone, keeps live and unproven holders, and changes no saved record', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stale-locks-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await createSellerDurableState({ dir, signer, listingPin: LISTING_PIN });
  t.after(() => store.close());
  store.retainContext({ TEST: 'context' });
  const [exitedJob, liveJob, otherBootJob, earlierFormatJob, unprovenJob, ownJob] = Array.from({ length: 6 }, () => core.generateCanonicalJobId());
  const exited = await startHolder(t, dir, exitedJob, { save: true });
  await startHolder(t, dir, liveJob);
  await exited.kill();
  let released;
  await store.withJob(ownJob, async () => {
    const own = store.inspectLocks().find((row) => row.job === ownJob);
    const [pid, , , , namespace] = own.owner.split(':');
    const [ns, boot, start] = namespace.split('.');
    // Same boot, a lease no file backs: nothing here can prove it gone.
    plantLock(dir, unprovenJob, `${pid}:${randomUUID()}:${Date.now()}:${randomUUID()}:${ns}.${boot}.${Number(start) + 1}`);
    plantLock(dir, otherBootJob, `4242:${randomUUID()}:${Date.now()}:${randomUUID()}:${ns}.${randomUUID()}.1`);
    plantLock(dir, earlierFormatJob, `4243:${randomUUID()}`);
    assert.deepEqual(reasons(store), { [exitedJob]: 'exited', [liveJob]: 'live', [otherBootJob]: 'other-boot', [earlierFormatJob]: 'legacy-format', [unprovenJob]: 'lease-unproven', [ownJob]: 'this-process' });
    released = store.releaseStaleLocks();
  });
  assert.deepEqual(released.map(({ job, reason }) => [job, reason]).sort(), [[exitedJob, 'exited'], [otherBootJob, 'other-boot'], [earlierFormatJob, 'legacy-format']].sort());
  assert.deepEqual(store.inspectLocks().map((row) => row.job).sort(), [liveJob, unprovenJob].sort(), 'the live and unproven rows stay; the finished own job released itself');
  assert.deepEqual(store.sessions().map((session) => session.jobId), [exitedJob], 'the released holder\'s saved session is untouched');
  assert.deepEqual(store.releaseStaleLocks(), [], 'a second call has nothing left to release');
  await assert.rejects(store.withJob(liveJob, () => assert.fail('a live holder is never taken over')), { code: 'seller_state_busy' });
});

test('releaseStaleLocks keeps this process\'s own acquisition fenced and held', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stale-locks-own-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await createSellerDurableState({ dir, signer, listingPin: LISTING_PIN });
  t.after(() => store.close());
  store.retainContext({ TEST: 'context' });
  const job = core.generateCanonicalJobId();
  await store.withJob(job, async () => {
    assert.deepEqual(store.releaseStaleLocks(), []);
    assert.equal(store.assertHeld(job), true);
    store.saveSession({ jobId: job });
  });
});

test('releaseAbandonedLock releases the row of a holder that has exited and changes no saved record', async (t) => {
  const { dir, store } = await openStore(t, 'abandoned-exited-');
  const [exitedJob, otherJob] = Array.from({ length: 2 }, () => core.generateCanonicalJobId());
  const exited = await startHolder(t, dir, exitedJob, { save: true });
  await startHolder(t, dir, otherJob);
  const { owner } = lockOf(store, exitedJob);
  await exited.kill();
  assert.equal(lockOf(store, exitedJob).reason, 'exited');
  assert.deepEqual(store.releaseAbandonedLock({ job: exitedJob, owner }), { released: true, recordsChanged: 0 });
  assert.deepEqual(store.inspectLocks().map((row) => row.job), [otherJob], 'only the named row is removed');
  assert.deepEqual(store.sessions().map((session) => session.jobId), [exitedJob], 'the saved session is untouched');
  assert.throws(() => store.releaseAbandonedLock({ job: exitedJob, owner }), { code: 'seller_state_lock_mismatch' }, 'the row is gone, so a second release names nothing');
});

test('releaseAbandonedLock refuses a live holder and this process\'s own lock', async (t) => {
  const { dir, store } = await openStore(t, 'abandoned-live-');
  const [liveJob, ownJob] = Array.from({ length: 2 }, () => core.generateCanonicalJobId());
  await startHolder(t, dir, liveJob);
  const live = lockOf(store, liveJob);
  assert.equal(live.reason, 'live');
  assert.throws(() => store.releaseAbandonedLock({ job: liveJob, owner: live.owner }), { code: 'seller_state_lock_live' });
  await store.withJob(ownJob, async () => {
    const own = lockOf(store, ownJob);
    assert.equal(own.reason, 'this-process');
    assert.throws(() => store.releaseAbandonedLock({ job: ownJob, owner: own.owner }), { code: 'seller_state_lock_live' });
    assert.equal(store.assertHeld(ownJob), true, 'the refused release leaves the acquisition held');
  });
  assert.equal(lockOf(store, liveJob).owner, live.owner, 'the live holder\'s row stays');
  await assert.rejects(store.withJob(liveJob, () => assert.fail('a live holder is never taken over')), { code: 'seller_state_busy' });
});

test('releaseAbandonedLock refuses a holder on this boot whose lease cannot be checked', async (t) => {
  const { dir, store } = await openStore(t, 'abandoned-unproven-');
  const [unprovenJob, ownJob] = Array.from({ length: 2 }, () => core.generateCanonicalJobId());
  await store.withJob(ownJob, async () => {
    const [pid, , , , namespace] = lockOf(store, ownJob).owner.split(':');
    const [ns, boot, start] = namespace.split('.');
    const owner = `${pid}:${randomUUID()}:${Date.now()}:${randomUUID()}:${ns}.${boot}.${Number(start) + 1}`;
    plantLock(dir, unprovenJob, owner);
    assert.equal(lockOf(store, unprovenJob).reason, 'lease-unproven');
    assert.throws(() => store.releaseAbandonedLock({ job: unprovenJob, owner }), { code: 'seller_state_lock_unproven' });
    assert.equal(lockOf(store, unprovenJob).owner, owner, 'the unproven row stays');
  });
});

test('releaseAbandonedLock refuses a wrong owner or an unknown job and removes nothing', async (t) => {
  const { dir, store } = await openStore(t, 'abandoned-mismatch-');
  const [exitedJob, unknownJob] = Array.from({ length: 2 }, () => core.generateCanonicalJobId());
  const exited = await startHolder(t, dir, exitedJob);
  const { owner } = lockOf(store, exitedJob);
  await exited.kill();
  const rightOwnerWrongJob = { job: unknownJob, owner };
  const rightJobWrongOwner = { job: exitedJob, owner: `${owner}x` };
  for (const request of [rightOwnerWrongJob, rightJobWrongOwner]) {
    assert.throws(() => store.releaseAbandonedLock(request), { code: 'seller_state_lock_mismatch' });
  }
  assert.equal(lockOf(store, exitedJob).owner, owner, 'the dead holder\'s row is still there');
  assert.deepEqual(store.releaseAbandonedLock({ job: exitedJob, owner }), { released: true, recordsChanged: 0 });
});

test('releaseAbandonedLock refuses a malformed job or owner', async (t) => {
  const { store } = await openStore(t, 'abandoned-invalid-');
  const job = core.generateCanonicalJobId();
  for (const request of [undefined, {}, { job }, { owner: 'x' }, { job: 'not-a-job', owner: 'x' }, { job, owner: 7 }]) {
    assert.throws(() => store.releaseAbandonedLock(request), { code: 'seller_state_lock_invalid' });
  }
});

test('two processes competing for the last job slot: one gets it, the other is refused with seller_state_capacity', async (t) => {
  const { dir, store } = await openStore(t, 'last-slot-', { maxJobs: 2 });
  const [firstJob, jobB, jobC] = Array.from({ length: 3 }, () => core.generateCanonicalJobId());
  const [childB, childC] = await Promise.all([forkHolder(t, dir, { maxJobs: 2 }), forkHolder(t, dir, { maxJobs: 2 })]);
  await store.withJob(firstJob, async () => {
    const [replyB, replyC] = await Promise.all([childB.hold(jobB), childC.hold(jobC)]);
    assert.deepEqual([replyB.code, replyC.code].sort(), [null, 'seller_state_capacity'], JSON.stringify([replyB, replyC]));
    const [winnerJob, loserJob] = replyB.code === null ? [jobB, jobC] : [jobC, jobB];
    assert.deepEqual(store.inspectLocks().map((row) => row.job).sort(), [firstJob, winnerJob].sort(), 'the refused process holds no lock');
    assert.equal(store.inspectLocks().some((row) => row.job === loserJob), false);
  });
  assert.deepEqual(store.sessions(), [], 'no job record was created for either process');
});
