import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { JOB, seller } from './helpers/protocol-fixture.mjs';

const directory = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'TEST-seller-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const config = dir => ({ dir, signer: { claim: seller.claim, sign: seller.signBytes }, listingPin: { contentHash: 'a'.repeat(64) } });
function worker(t, dir, phase) {
  const child = fork(new URL('./helpers/durable-init-worker.mjs', import.meta.url), [dir, phase], { stdio: ['pipe', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  const ready = () => Promise.race([once(child, 'message'), exit.then(() => { throw new Error(stderr || 'TEST worker exited before publication'); })]);
  return { child, exit, ready, error: () => stderr };
}

test('an unretained application context survives close and reopen', async t => {
  const dir = await directory(t), first = await createSellerDurableState(config(dir));
  assert.equal(first.context(), null); first.close();
  const reopened = await createSellerDurableState(config(dir));
  try {
    assert.equal(reopened.context(), null);
    reopened.retainContext({ TEST: 'retained' });
    assert.deepEqual(reopened.context(), { TEST: 'retained' });
  } finally { reopened.close(); }
});

for (const phase of ['file', 'schema', 'publish', 'opened']) test(`first use recovers after a process dies at ${phase}`, async t => {
  const dir = await directory(t), run = worker(t, dir, phase);
  const [code, signal] = await run.exit;
  assert.equal(signal, 'SIGKILL', `exit ${code}: ${run.error()}`);
  const reopened = await createSellerDurableState(config(dir));
  try {
    assert.equal(reopened.context(), null);
    reopened.retainContext({ TEST: 'recovered' });
    await reopened.withJob(JOB, () => reopened.saveSession({ jobId: JOB, TEST: 'saved' }));
    assert.equal(reopened.loadSession(JOB).TEST, 'saved');
  } finally { reopened.close(); }
});

test('a failed first SDK-store open can be retried', async t => {
  const dir = await directory(t), run = worker(t, dir, 'sdk-failure');
  const [code, signal] = await run.exit;
  assert.equal(signal, null, run.error()); assert.equal(code, 0, run.error());
});

test('concurrent first initializers share one immutable application context', async t => {
  const dir = await directory(t), first = worker(t, dir, 'concurrent');
  assert.deepEqual((await first.ready())[0], { ready: true });
  const second = worker(t, dir, 'concurrent');
  assert.deepEqual((await second.ready())[0], { ready: true });
  // Both databases are initialized, but neither has published its final path.
  first.child.stdin.end('go');
  assert.deepEqual(await first.exit, [0, null], first.error());
  second.child.stdin.end('go');
  assert.deepEqual(await second.exit, [0, null], second.error());
  const reopened = await createSellerDurableState(config(dir));
  try {
    assert.deepEqual(reopened.context(), { TEST: 'shared' });
    assert.throws(() => reopened.retainContext({ TEST: 'replacement' }), e => e.code === 'seller_state_context_conflict');
    assert.deepEqual((await readdir(dir)).sort(), ['holders', 'sdk-agreements', 'sdk-receipts', 'seller-state.sqlite']);
  } finally { reopened.close(); }
});

test('a missing initial signed context in an empty established database still refuses', async t => {
  const dir = await directory(t), first = await createSellerDurableState(config(dir)); first.close();
  const db = new Database(join(dir, 'seller-state.sqlite'));
  try { db.exec("DELETE FROM seller_meta WHERE key='context'"); } finally { db.close(); }
  await assert.rejects(createSellerDurableState(config(dir)), e => e.code === 'seller_state_corrupt');
});
