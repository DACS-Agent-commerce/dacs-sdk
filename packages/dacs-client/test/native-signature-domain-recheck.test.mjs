// The signature domain is checked on current evidence wherever bytes can reach the node. Two confirmations
// in flight under one lease cannot replace an active answer with a late inactive one, and a CREATE recovery
// checks the signature again before it reserves its resend, reading the domain afresh once the kept answer
// is past its lifetime. The real transport, boundary and durable journal run in this process against a
// scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedCreateWorld } from './helpers/native-create-boundary.mjs';
import { JOB_IDS, NOW } from './helpers/native-create-world.mjs';
import { nativeWorld } from './helpers/native-effect-world.mjs';
import { networkInfo } from './helpers/network-info.mjs';

const ONE_MINUTE_MS = 60_000;
const domainForm = chainId => hash => `demos-tx:v1:${chainId}:${hash}`;
const refusedWith = code => error => error.code === code;
const pending = tx => ({ disposition: 'pending', hash: tx.hash, noResend: true });

test('an inactive answer that arrives after an active one under the same lease does not replace it: bare-hash signatures stay refused', async t => {
  const w = nativeWorld(t);
  // Holds the next getNetworkInfo answer, already read from the node, until `release()`.
  let held = null;
  const fetchImpl = async (url, init) => {
    const answer = w.node.fetch(url, init);
    if (held && JSON.parse(init.body).params[0].message === 'getNetworkInfo') {
      const { reached, released } = held;
      held = null;
      reached();
      await released;
    }
    return answer;
  };
  w.open({}, { fetchImpl });
  const lease = await w.lease();
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const readInFlight = new Promise(resolve => { held = { reached: resolve, released }; });
  const late = w.confirm(w.signedTransfer(1)).catch(error => error);
  await readInFlight;
  w.node.networkInfo = networkInfo(true, 7);
  assert.equal((await w.confirm(w.signedTransfer(1, undefined, domainForm(7)))).result, 200, 'the active answer confirms the domain-form signature');
  release();
  assert.ok(refusedWith('native_only')(await late), 'the bare-hash signature is refused by the signature-domain check');
  assert.equal(w.node.networkInfoReads, 2);
  await assert.rejects(w.confirm(w.signedTransfer(2)), refusedWith('native_only'));
  assert.equal(w.node.networkInfoReads, 2, 'the kept active answer was used, not the late inactive one');
  assert.equal(w.node.confirms, 1, 'only the domain-form signature reached the node');
  await w.release(lease.leaseId);
});

// Sends one CREATE under an inactive domain, then recovers it. During the recovery's confirmation the clock moves
// past the inactive answer's lifetime and the node's domain becomes `after`.
async function recoverAcrossExpiry(t, after) {
  let at = NOW, info = networkInfo(), reads = 0;
  const c = await boundedCreateWorld(t, { now: () => at, networkInfoAnswer: () => info });
  const { tx } = await c.send(JOB_IDS[0], 1);
  assert.equal(c.calls.broadcastTx, 1);
  c.nodeHook = async message => {
    if (message === 'getNetworkInfo') reads++;
    if (message === 'confirmTx') { at += ONE_MINUTE_MS; info = after; }
  };
  const result = await c.world.recover(tx);
  return { c, tx, result, reads };
}

test('a CREATE recovery whose domain becomes active after its confirmation refuses the resend before broadcastTx and reserves nothing', async t => {
  const { c, tx, result, reads } = await recoverAcrossExpiry(t, networkInfo(true, 7));
  assert.deepEqual(result, pending(tx));
  assert.equal(c.calls.confirmTx, 2, 'the recovery confirmation was sent under the inactive answer');
  assert.equal(c.calls.broadcastTx, 1, 'nothing was resent');
  assert.equal((await c.journal.get(`devnet/native-transfer/${tx.hash}`)).storageWriteResends ?? 0, 0, 'the resend was not reserved');
  assert.equal(reads, 1, 'the expired answer was read again before the resend');
});

test('a CREATE recovery whose domain is unchanged after its confirmation resends once', async t => {
  const { c, tx, result, reads } = await recoverAcrossExpiry(t, networkInfo());
  assert.deepEqual(result, pending(tx));
  assert.equal(reads, 1, 'the expired answer was read again before the resend');
  assert.equal(c.calls.broadcastTx, 2, 'the resend was sent once');
  assert.equal((await c.journal.get(`devnet/native-transfer/${tx.hash}`)).storageWriteResends, 1);
});
