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

// A child process that holds `job` until killed, with its lease held.
async function startHolder(t, dir, job, { save = false } = {}) {
  const child = fork(HOLDER, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const message = async (input) => { const reply = once(child, 'message'); child.send(input); return (await reply)[0]; };
  await once(child, 'message');
  const held = await message({ type: 'hold', dir, listingPin: LISTING_PIN, jobId: job, claim, pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') });
  assert.equal(held.code, null, JSON.stringify(held));
  if (save) assert.equal((await message({ type: 'call', op: 'save' })).code, null);
  return { kill: async () => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } };
}

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
