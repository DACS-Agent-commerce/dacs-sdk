// A seller CREATE the node may include after the wallet's own inclusion wait is
// read back, never sent again, until a verified outcome, a closed authorization,
// proven exclusion or 30 minutes after the wallet's answer. Exclusion is proven
// only from the reference block R the transport keeps for this exact CREATE:
// blocks R+1 and R+2 do not list it, the account nonce has not reached its nonce
// and a last status read no longer knows it. Loopback fixtures only: the clock
// moves only when the anchor waits between readbacks, and the chain's head moves
// with that clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalityCommitmentAddress } from '@kynesyslabs/dacs';
import { anchorFixture, signSdkCreate } from './helpers/anchor-isolated-fixture.mjs';

const T0 = 1800000000000, JOB_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const WATCH_MS = 30 * 60_000, BLOCK_MS = 10_000, R = 100;
const OTHER_HASH = 'e'.repeat(64);

// One CREATE the wallet signs and the node accepts. Its readback answers pending,
// with the transport's kept reference block (chain.reference), until chain.included
// is set. The chain's head is chain.start when the wallet answers and moves one block
// every blockMs; chain.listsWrite names the blocks that list the write, and
// chain.answer(message, data) may replace a node answer. The one recovery check a
// pending first read makes is answered "not sent" unless onRecovery says otherwise.
async function lateWriteWorld({ blockMs = BLOCK_MS, onSleep = () => {}, onRecovery = () => ({ resent: false }) } = {}) {
  let clock = T0, written = null;
  const sleeps = [], reads = [], recoveries = [], rpc = [];
  const chain = { start: R, reference: R, listsWrite: new Set(), accountNonce: 0, status: { state: 'unknown' }, included: false, answer: null };
  const head = () => chain.start + Math.floor((clock - T0) / blockMs);
  const w = await anchorFixture({ signRpc: async () => 'TEST rpc authentication', now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; onSleep(sleeps.length); } });
  w.source.observeBinding = async () => {};
  w.source.binding = async ({ hash }) => {
    reads.push(hash);
    if (chain.included) return { disposition: 'included' };
    return { disposition: 'pending', hash, nonce: 1, noResend: true, ...(chain.reference === undefined ? {} : { referenceBlock: chain.reference }) };
  };
  w.source.recoverStorageWrite = async ({ signedTransaction }) => { recoveries.push(signedTransaction.hash); return onRecovery(chain); };
  w.source.readRpc = async (path, body) => {
    const { message, data } = body.params[0];
    rpc.push(message === 'getBlockByNumber' ? data.blockNumber : message);
    const replaced = chain.answer?.(message, data);
    const response = replaced !== undefined ? replaced
      : message === 'getAddressNonce' ? chain.accountNonce
      : message === 'getTransactionStatus' ? chain.status
      : message === 'getBlockByNumber' && data.blockNumber <= head()
        ? { number: data.blockNumber, status: 'confirmed', content: { ordered_transactions: [OTHER_HASH, ...(chain.listsWrite.has(data.blockNumber) ? [written] : [])] } }
        : null;
    return { result: 200, response, require_reply: false, extra: null };
  };
  w.controls.reader.read = async (logicalAddress) => {
    const row = [...w.journal.rows.values()].find((r) => r.input?.logicalAddress === logicalAddress);
    return { status: 'present', artifact: row.input.artifact, receipt: { contentHash: row.input.receiptContentHash, transactionRef: { value: 'a'.repeat(64) } }, demosEvidence: {} };
  };
  w.controls.reader.verifyReceipt = async () => 'valid';
  w.controls.request = async (request) => {
    const signed = await signSdkCreate(request.transaction);
    written = signed.hash;
    await w.journal.put('demo/wallet/lane', { stage: 'broadcast-accepted', hash: signed.hash, signedTransaction: signed });
    await w.sourceJournal.put(`source/${signed.hash}`, { stage: 'signed', hash: signed.hash, signedTransaction: signed });
    return { success: true, data: { hash: signed.hash } };
  };
  const artifact = await w.artifact(JOB_ID);
  // anchor: a fresh anchor on the same journals stands for a restarted process.
  const publish = ({ anchor = w.open(), authorize = async () => true } = {}) => anchor.publish({ logicalAddress: finalityCommitmentAddress(JOB_ID),
    artifact, artifactKind: 'FinalityCommitmentRecord', authorize, awaitInclusion: true });
  const stage = () => [...w.journal.rows.values()].find((row) => row.input?.logicalAddress === finalityCommitmentAddress(JOB_ID))?.stage;
  return { ...w, chain, sleeps, reads, recoveries, rpc, publish, stage, written: () => written,
    advance: (ms) => { clock += ms; }, elapsed: () => clock - T0, blockReads: () => rpc.filter((entry) => typeof entry === 'number') };
}

const EXCLUDED = /no authenticated inclusion readback \(excluded: /;
const UNRESOLVED = /no authenticated inclusion readback \(pending/;

test('a CREATE whose blocks R+1 and R+2 do not list it is reported excluded once the chain reaches R+2, after one last status read', async () => {
  const w = await lateWriteWorld();
  const out = await w.publish();
  assert.equal(out.status, 'indeterminate');
  assert.match(out.reason, EXCLUDED);
  assert.equal(w.elapsed(), 2 * BLOCK_MS, 'the wait ends when block R+2 is confirmed');
  assert.deepEqual(w.rpc.slice(-4), [R + 2, R + 1, 'getAddressNonce', 'getTransactionStatus'], 'the status read is the last read before exclusion');
  assert.deepEqual([...new Set(w.rpc.filter((entry) => typeof entry === 'string'))].sort(), ['getAddressNonce', 'getTransactionStatus']);
  assert.equal(w.captured.length, 1, 'one wallet request');
  assert.equal(w.recoveries.length, 1, 'only the first readback\'s existing recovery check');
  assert.equal(w.stage(), 'issued', 'the retained intent is unchanged');
});

test('a CREATE listed in block R+1 is not excluded when block R+2 does not list it', async () => {
  const w = await lateWriteWorld();
  w.chain.listsWrite.add(R + 1);
  const out = await w.publish();
  assert.match(out.reason, UNRESOLVED);
  assert.equal(w.elapsed(), WATCH_MS, 'read back until the bound');
  assert.equal(w.captured.length, 1);
  assert.equal(w.recoveries.length, 1);
});

test('an inclusion seen once is remembered: a later read whose blocks no longer list the CREATE does not prove exclusion', async () => {
  const w = await lateWriteWorld({ onSleep: (count) => { if (count === 5) w.chain.listsWrite.clear(); } });
  w.chain.listsWrite.add(R + 2);
  const out = await w.publish();
  assert.match(out.reason, UNRESOLVED);
  assert.equal(w.elapsed(), WATCH_MS);
  assert.ok(w.reads.length > 5, 'read back after the listing went away');
});

test('the last status read turns a would-be exclusion into an inclusion, and the CREATE answers present once it reads back included', async () => {
  const w = await lateWriteWorld({ onSleep: (count) => { if (count === 8) w.chain.included = true; } });
  w.chain.status = { state: 'included', blockNumber: R + 2 };
  const out = await w.publish();
  assert.equal(out.status, 'present', JSON.stringify(out));
  assert.equal(w.rpc.filter((entry) => entry === 'getTransactionStatus').length, 1, 'the inclusion is remembered after the status read');
  assert.equal(w.stage(), 'verified');
  assert.equal(w.captured.length, 1);
});

test("after a recovery reconfirms the same bytes, exclusion is judged from the reconfirmation's reference block", async () => {
  const later = R + 100;
  const w = await lateWriteWorld({ onSleep: (count) => { if (count === 3) w.chain.included = true; },
    onRecovery: (chain) => { chain.reference = later; return { resent: true }; } });
  w.chain.start = R + 50;
  const out = await w.publish();
  assert.equal(out.status, 'present', JSON.stringify(out));
  assert.equal(w.recoveries.length, 1);
  assert.deepEqual([...new Set(w.blockReads())], [later + 2], 'blocks R+1 and R+2 of the first confirmation are never read');
});

test('a CREATE with no usable reference block is never reported excluded and ends unresolved at the bound', async () => {
  for (const reference of [undefined, null, -1, '100', 100.5]) {
    const w = await lateWriteWorld();
    w.chain.start = R + 50;
    w.chain.reference = reference;
    const out = await w.publish();
    assert.match(out.reason, UNRESOLVED, String(reference));
    assert.equal(w.elapsed(), WATCH_MS, String(reference));
    assert.deepEqual(w.blockReads(), [], `${reference}: no block is read`);
  }
});

test('a reference block on a readback that names another CREATE is never used', async () => {
  const w = await lateWriteWorld();
  w.chain.start = R + 50;
  const binding = w.source.binding;
  w.source.binding = async (request) => ({ ...await binding(request), hash: OTHER_HASH });
  const out = await w.publish();
  assert.match(out.reason, UNRESOLVED);
  assert.deepEqual(w.blockReads(), []);
});

test('a CREATE whose account nonce is used is never reported excluded', async () => {
  const w = await lateWriteWorld({ onSleep: (count) => { if (count === 1) w.chain.accountNonce = 1; } });
  const out = await w.publish();
  assert.match(out.reason, UNRESOLVED);
  assert.equal(w.elapsed(), WATCH_MS);
});

test('a node read that fails or is oversized during the exclusion check proves nothing, and the wait keeps reading back', async () => {
  let checks = 0;
  const w = await lateWriteWorld();
  w.chain.answer = (message, data) => {
    if (message !== 'getBlockByNumber' || data.blockNumber !== R + 2 || w.elapsed() < 2 * BLOCK_MS) return undefined;
    checks++;
    if (checks === 1) throw new Error('TEST node read failed');
    if (checks === 2) return { number: R + 2, status: 'confirmed', content: { ordered_transactions: Array.from({ length: 20_000 }, () => OTHER_HASH) } };
    return undefined;
  };
  const out = await w.publish();
  assert.match(out.reason, EXCLUDED);
  assert.equal(checks, 3);
  assert.equal(w.elapsed(), 2 * BLOCK_MS + 2 * 5_000, 'excluded at the first check whose reads succeed');
  assert.equal(w.captured.length, 1);
});

test('a throw from the authorization check ends the late-write wait with no further readback', async () => {
  let readsAtSleep = null;
  const w = await lateWriteWorld({ blockMs: Infinity, onSleep: () => { readsAtSleep = w.reads.length; } });
  const out = await w.publish({ authorize: async () => {
    if (w.sleeps.length > 0) throw new Error('TEST authorization check failed');
    return true;
  } });
  assert.match(out.reason, UNRESOLVED);
  assert.equal(w.sleeps.length, 1, 'one poll, then the wait ended');
  assert.equal(w.reads.length, readsAtSleep, 'no readback after the check failed');
  assert.equal(w.captured.length, 1);
});

test('a restart during the late-write wait resumes readback only, with no new wallet request, signature or recovery send', async () => {
  let stopped = false;
  const w = await lateWriteWorld({ blockMs: Infinity, onSleep: (count) => {
    if (count === 3 && !stopped) { stopped = true; throw new Error('TEST process stopped during the wait'); }
    if (count === 6) w.chain.included = true;
  } });
  await assert.rejects(w.publish(), /TEST process stopped/);
  assert.equal(w.stage(), 'issued');
  const readsBefore = w.reads.length;
  const out = await w.publish();
  assert.equal(out.status, 'present', JSON.stringify(out));
  assert.ok(w.reads.length > readsBefore + 1, 'the resumed wait read back more than once');
  assert.equal(w.captured.length, 1, 'no new wallet request or signature');
  assert.equal(w.recoveries.length, 1, 'no recovery send after the restart');
});

test("a late-write wait resumed after a restart still ends 30 minutes after the wallet's original answer", async () => {
  let stopped = false;
  const w = await lateWriteWorld({ blockMs: Infinity, onSleep: (count) => {
    if (count === 2 && !stopped) { stopped = true; throw new Error('TEST process stopped during the wait'); }
  } });
  await assert.rejects(w.publish(), /TEST process stopped/);
  w.advance(10 * 60_000);
  const out = await w.publish();
  assert.match(out.reason, UNRESOLVED);
  assert.equal(w.elapsed(), WATCH_MS);
  assert.equal(w.captured.length, 1);
  assert.equal(w.recoveries.length, 1);
});

test('a retained CREATE whose late-write wait has ended is not waited for again after a restart', async () => {
  let stopped = false;
  const w = await lateWriteWorld({ blockMs: Infinity, onSleep: () => {
    if (!stopped) { stopped = true; throw new Error('TEST process stopped during the wait'); }
  } });
  await assert.rejects(w.publish(), /TEST process stopped/);
  w.advance(WATCH_MS);
  const sleeps = w.sleeps.length;
  const out = await w.publish();
  assert.match(out.reason, UNRESOLVED);
  assert.equal(w.sleeps.length, sleeps, 'no wait');
  assert.equal(w.captured.length, 1, 'no new wallet request');
});

test('a restart after the wallet answered but before its answer was recorded reads the CREATE back once and starts no late-write wait', async () => {
  const w = await lateWriteWorld({ blockMs: Infinity });
  const put = w.journal.put;
  w.journal.put = async (key, value) => {
    if (value?.stage === 'issued') throw new Error('TEST process stopped before the answer was recorded');
    return put.call(w.journal, key, value);
  };
  await assert.rejects(w.publish(), /TEST process stopped/);
  w.journal.put = put;
  assert.notEqual(w.stage(), 'issued');
  const out = await w.publish();
  assert.match(out.reason, UNRESOLVED);
  assert.equal(w.sleeps.length, 0, 'no wait');
  assert.equal(w.captured.length, 1, 'no new wallet request');
  assert.equal(w.recoveries.length, 1, 'only the retained CREATE\'s one recovery check');
});
