// The sole CREATE recovery resend is reserved on the lane and the intent before it is made. Whatever
// happens after the reservation (a stop, a lost answer, a process that stops with only
// recovery-dispatch-started durable, a concurrent recovery) consumes it: no later recovery, restart
// or overlapping call resends. A reservation that cannot be written sends nothing and leaves the
// resend available. The real transport, effect boundary and durable journal run in this process
// against a scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutAppend } from './helpers/effect-boundary-fixture.mjs';
import { JOB_IDS, NOW } from './helpers/native-create-world.mjs';
import { guardedCreateWorld } from './helpers/native-guarded-create-world.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

const pending = (tx) => ({ disposition:'pending', hash:tx.hash, noResend:true });

// Each recovery signs fresh RPC auth, and the node accepts a stamp once: the world's stamps rise.
async function retainedCreate(t, worldOptions = {}) {
  let stamp = 0;
  const options = { stamps: { next: () => NOW + (stamp += 1) }, ...worldOptions };
  const dir = mkdtempSync(join(tmpdir(), 'native-recovery-cuts-')), path = join(dir, 'journal.sqlite');
  let journal = openDurableWalletJournal({ path, mode:'create' });
  t.after(() => { journal.close(); rmSync(dir, { recursive:true, force:true }); });
  const c = await guardedCreateWorld(t, { journal, ...options }), tx = await c.makeCreate(JOB_IDS[0], 1);
  await c.retain(tx, 'broadcast-accepted');
  const reopen = async () => { journal.close(); journal = openDurableWalletJournal({ path, mode:'open' }); return guardedCreateWorld(t, { journal, ...options }); };
  return { c, tx, reopen, lane:() => journal.get(c.laneKey), journal:() => journal };
}

async function assertNoFurtherResend(world, tx, broadcastsBefore) {
  assert.deepEqual(await world.recover(tx), pending(tx));
  assert.equal(world.sent.broadcasts.length, broadcastsBefore, 'no further resend');
}

test('a stop arriving after the reservation withholds the resend and no later recovery or restart resends', async (t) => {
  const { c, tx, reopen, lane } = await retainedCreate(t);
  cutAppend({ history:c.history }, 'recovery-dispatch-started', { mutate:() => { c.state.stopped = true; } });
  assert.deepEqual(await c.recover(tx), pending(tx));
  assert.deepEqual([c.sent.broadcasts, (await lane()).storageWriteResends, (await c.states()).at(-1)], [[], 1, 'p2/recovery-dispatch-withheld']);

  c.state.stopped = false;
  await assertNoFurtherResend(c, tx, 0);
  await assertNoFurtherResend(await reopen(), tx, 0);
});

test('a lost resend answer counts as a possible send and no later recovery or restart resends', async (t) => {
  let attempts = 0, lose = true;
  const { c, tx, reopen, lane } = await retainedCreate(t, { onNode:async (message) => { if (message === 'broadcastTx' && lose) { attempts++; throw new Error('TEST connection lost'); } } });
  assert.deepEqual(await c.recover(tx), pending(tx));
  assert.deepEqual([attempts, (await lane()).storageWriteResends, (await c.states()).at(-1)], [1, 1, 'p2/recovery-dispatch-unknown']);

  lose = false;
  await assertNoFurtherResend(c, tx, 0);
  await assertNoFurtherResend(await reopen(), tx, 0);
  assert.equal(attempts, 1);
});

test('a process that stops with only recovery-dispatch-started durable is never resent after the restart', async (t) => {
  const { c, tx, reopen, lane } = await retainedCreate(t, { onNode:async (message) => { if (message === 'broadcastTx') throw new Error('TEST process stopped'); } });
  cutAppend({ history:c.history }, 'recovery-dispatch-unknown');
  assert.deepEqual(await c.recover(tx), pending(tx));
  assert.deepEqual([(await lane()).storageWriteResends, (await c.states()).at(-1)], [1, 'p2/recovery-dispatch-started']);

  const restarted = await reopen();
  await assertNoFurtherResend(restarted, tx, 0);
  assert.equal((await restarted.states()).at(-1), 'p2/recovery-dispatch-started', 'the restart invents no record');
});

test('two recoveries started together resend once', async (t) => {
  const { c, tx } = await retainedCreate(t);
  const outcomes = await Promise.all([c.recover(tx), c.recover(tx)]);
  assert.deepEqual(outcomes, [pending(tx), pending(tx)]);
  assert.deepEqual(c.sent.broadcasts, [tx.hash]);
});

test('a reservation that cannot be written sends nothing and leaves the sole resend available', async (t) => {
  const { c, tx, lane, journal } = await retainedCreate(t);
  const put = journal().put.bind(journal());
  const cut = Object.assign(new Error('TEST-journal-cut'), { code:'journal-capacity' });
  journal().put = async (key, value) => {
    if (value?.storageWriteResends === 1) { journal().put = put; throw cut; }
    return put(key, value);
  };
  await assert.rejects(c.recover(tx), (error) => error === cut);
  assert.deepEqual([c.sent.broadcasts, (await lane()).storageWriteResends], [[], undefined]);

  assert.deepEqual(await c.recover(tx), pending(tx));
  assert.deepEqual(c.sent.broadcasts, [tx.hash], 'the next recovery sends once');
});
