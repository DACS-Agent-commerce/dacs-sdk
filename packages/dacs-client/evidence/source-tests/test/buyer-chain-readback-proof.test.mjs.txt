// DACS_BUYER_CHAIN_READBACK=on with DACS_COMMIT_ON_SIGNATURE=on, an earlier review (the
// code review's P2-1 and its probe proof-indeterminate, a review P2):
// the commitment readback authenticates the commitment, then asks the SDK to
// resume it, and the SDK re-reads the receipt proof. A re-read that comes back
// indeterminate (a node 503, or a fence refused at the source change's shutdown drain) makes
// the SDK throw a SubstrateError. That is not a rejection: the purchase stays
// pending and the next recheck reads again. Only the SDK's counterparty and
// plain permanent verdicts on the authenticated record reject it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalityCommitmentAddress } from '@kynesyslabs/dacs';
import { createBuyerChainReadback } from '../src/dacs/buyer-chain-readback.mjs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { agree, context, start } from './helpers/buyer-chain-readback-flow.mjs';

const BOTH = { commitOnSignature: true, buyerChainReadback: 'on' };
const commitmentOf = (h, jobId) => h.transport.chain.wire.record.accepted.find((tx) => tx.content.data[1].metadata.artifactKind === 'FinalityCommitmentRecord'
  && tx.content.data[1].metadata.logicalAddress === finalityCommitmentAddress(jobId));
// TEST chain fault: answers the Nth getTxByHash for one transaction (counted
// from arm) with a node 503, as the reviewer's probe does.
function cutRead(h) {
  let hash = null, failAt = 0, seen = 0;
  h.testHooks.rpcOverride = (body) => {
    const call = body?.params?.[0];
    if (hash === null || call?.message !== 'getTxByHash' || call.data?.hash !== hash) return undefined;
    seen += 1;
    return seen === failAt ? { result: 503, response: null, require_reply: false, extra: null } : undefined;
  };
  return { arm(txHash, at) { hash = txHash; failAt = at; seen = 0; }, disarm() { hash = null; }, seen: () => seen };
}

test('both on, reader: an indeterminate receipt re-read at any position is never a rejection; the SDK\'s definite verdicts still reject', { timeout: 600000 }, async (t) => {
  const h = await start(t, BOTH), f = await agree(t, h);
  await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  assert.equal((await f.verify()).status, 'awaiting_approval');
  const c = context(h, f), address = finalityCommitmentAddress(c.jobId), pointer = c.p.chainReadback[address], tx = commitmentOf(h, c.jobId);
  const read = (chain = h.app.services.protocol.chainReadback) => chain.readCommitment({ agreement: c.agreement, listing: c.listing, seller: c.seller, signedProjection: pointer, fresh: true });

  // Every getTxByHash of the commitment the reader makes, cut in turn.
  const cut = cutRead(h);
  cut.arm(tx.hash, 0);
  assert.equal((await read()).status, 'verified');
  const total = cut.seen(), results = [];
  assert.ok(total >= 3, 'the read, its receipt verification and the SDK\'s own receipt re-read');
  for (let at = 1; at <= total; at++) {
    cut.arm(tx.hash, at);
    const result = await read();
    results.push(`#${at}/${total}: ${result.status} (${String(result.reason ?? '').slice(0, 100)})`);
    assert.equal(result.status, 'indeterminate', results.at(-1));
  }
  cut.disarm();
  assert.match(results.at(-1), /SubstrateError: commitment receipt proof is not established \(indeterminate\)/, 'the last read is the SDK\'s re-read');
  assert.equal((await read()).status, 'verified', 'the next read verifies');

  // The SDK's own classification, on a real commitment: the second receipt
  // verification (the SDK's) answers as given.
  const adapter = createDemosSr2Adapter({ rpcUrl: h.transport.capability.pins.endpoint, sourceCapability: h.transport.capability, journal: createInMemoryDemosSr2Journal() });
  const withSecondProof = (second) => {
    let proofs = 0;
    return createBuyerChainReadback({ sourceCapability: h.transport.capability, reader: { read: (...args) => adapter.read(...args),
      verifyReceipt: async (...args) => { proofs += 1; return proofs === 1 ? adapter.verifyReceipt(...args) : second(); } } });
  };
  const indeterminate = await read(withSecondProof(() => 'indeterminate'));
  assert.equal(indeterminate.status, 'indeterminate'); assert.match(indeterminate.reason, /SubstrateError: commitment receipt proof is not established \(indeterminate\)/);
  const thrown = await read(withSecondProof(() => { throw new TypeError('TEST local fault'); }));
  assert.equal(thrown.status, 'indeterminate', 'a proof verifier that throws is a substrate fault'); assert.match(thrown.reason, /SubstrateError: commitment receipt proof verification errored/);
  const invalid = await read(withSecondProof(() => 'invalid'));
  assert.equal(invalid.status, 'rejected', 'a definite invalid proof is the SDK\'s permanent verdict'); assert.equal(invalid.authenticated, true);
  assert.match(invalid.reason, /DacsError: commitment receipt proof is invalid/);
  assert.equal(h.transport.chain.wire.record.accepted.filter((created) => created.content.data[1].metadata.artifactKind === 'FinalityCommitmentRecord').length, 1, 'one commitment CREATE');
});

test('both on, purchase: the buyer\'s commitment readback cut at each getTxByHash of the commitment never ends at agreement_rejected', { timeout: 900000 }, async (t) => {
  // One harness; a fresh purchase for each position, until the position is
  // past the last read of the commitment that verify_deal makes.
  const h = await start(t, BOTH), cut = cutRead(h), outcomes = [];
  for (let at = 1; at <= 16; at++) {
    const f = await agree(t, h);
    await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
    const jobId = f.operation().terms.protocol.jobId, tx = commitmentOf(h, jobId);
    assert.ok(tx, 'the seller committed on the Agreement signature');
    cut.arm(tx.hash, at);
    let result;
    try { result = await f.verify(); } finally { cut.disarm(); }
    const seen = cut.seen(), last = f.operation().state.protocol.attempts.at(-1);
    outcomes.push(`cut #${at} of ${seen}: ${result.status} ${last.step}/${last.outcome} ${String(last.reason ?? '').slice(0, 100)}`);
    assert.notEqual(result.status, 'agreement_rejected', outcomes.at(-1));
    assert.notEqual(f.operation().status, 'agreement_rejected', outcomes.at(-1));
    // The next recheck, with nothing cut, verifies the same commitment.
    if (result.status !== 'awaiting_approval') assert.equal((await f.verify()).status, 'awaiting_approval', outcomes.at(-1));
    assert.equal(f.operation().state.protocol.commitment.address, finalityCommitmentAddress(jobId));
    if (seen < at) break;
  }
  t.diagnostic(outcomes.join('\n'));
  assert.ok(outcomes.some((line) => /SubstrateError: commitment receipt proof is not established/.test(line)), `the SDK's own receipt re-read was cut at one position:\n${outcomes.join('\n')}`);
  assert.equal(h.transport.chain.wire.record.broadcastAttempts.length, h.transport.chain.wire.record.accepted.length, 'no broadcast retry');
});
