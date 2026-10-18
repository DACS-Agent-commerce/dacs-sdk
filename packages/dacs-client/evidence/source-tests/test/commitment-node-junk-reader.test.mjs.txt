// the source change, reader level: node answers that parse but do not authenticate (a block
// not found or pending, a transaction without content or with corrupted
// signature bytes, native metadata that differs from the signed CREATE) at
// every commitment read of a fresh readback are `indeterminate`, never
// `rejected` and never thrown (the anchor's own read included). Authenticated
// contradictions are still rejected: a commitment signature that does not verify
// (CounterpartyError), a seller-signed transaction that binds another artifact
// (the anchor's invalid), the seller's pinned signed CREATE of another kind at
// the first read (the reader's mark), and a seller-signed record that binds
// another Listing pin, parties or pattern (the SDK's CA-3/CA-7). Foreign throws
// outside an SDK callback, and the first read's own unmarked refusals, are
// indeterminate.
// Review findings: PR the source change an earlier review, code P2-1 / P3-1, a review P2 / P3; an earlier review,
// a review P2-2; final review, findings 1 and 2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, FINALITY_COMMITMENT_SEPARATOR, signedBytes } from '@kynesyslabs/dacs';
import { createDevnetNativeCommitmentCapability, readDevnetNativeCommitment } from '../src/devnet-demo/commitment-consumer.mjs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { JUNK_KINDS, capabilityOver, createsOf, junkFaults, sign, start } from './helpers/commitment-node-junk.mjs';

for (const commitOnSignature of [false, true]) {
  const mode = `DACS_COMMIT_ON_SIGNATURE=${commitOnSignature ? 'on' : 'off'}`;

  test(`${mode}: node junk at any commitment read is never rejected; an authenticated contradiction is`, { timeout: 600000 }, async (t) => {
    const f = junkFaults(JUNK_KINDS[0]), h = await start(t, f, commitOnSignature), a = await sign(t, h);
    assert.equal((await a.approve()).state, 'completed');
    await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
    assert.equal((await a.verify()).status, 'awaiting_approval');
    const p = a.operation().state.protocol, scope = { agreement: p.agreement.artifact, listing: p.listing, fresh: true };
    const read = (capability, extra = {}) => readDevnetNativeCommitment(capability, { ...scope, ...extra });
    const composed = h.composition.nativeSellerCommitment;

    const lines = [];
    for (const kind of JUNK_KINDS) {
      f.setKind(kind);
      f.arm(0); assert.equal((await read(composed)).status, 'verified', kind); const total = f.seen(); f.disarm();
      assert.ok(total >= 3, `${kind}: the readback reads the commitment ${total} times`);
      const results = [];
      for (let at = 1; at <= total; at++) {
        f.arm(at);
        const r = await read(composed);
        f.disarm();
        results.push(`${kind} #${at}/${total}: ${r.status} (${String(r.reason ?? '').slice(0, 90)})`);
      }
      lines.push(...results);
      assert.ok(results.every((line) => /: (verified|indeterminate) \(/.test(line)), results.join('\n'));
      assert.match(results.at(-3), /: indeterminate \(/, results.join('\n'));
      // The anchor's own read, its receipt check, then the SDK's re-read: all reached.
      assert.doesNotMatch(results.at(-3), /native demo receipt|commitment receipt proof/, results.join('\n'));
      assert.match(results.at(-2), /: indeterminate \(native demo receipt is indeterminate\)/, results.join('\n'));
      assert.match(results.at(-1), /: indeterminate \(commitment receipt proof is not established/, results.join('\n'));
      assert.equal((await read(composed)).status, 'verified', `${kind}: a clean read verifies`);
    }
    t.diagnostic(lines.join('\n'));

    // Kept contradiction 1: the commitment's own signature does not verify
    // (the SDK's CounterpartyError from the plugin's verifier).
    const forged = capabilityOver(h, { readRetained: (r) => {
      const artifact = structuredClone(r.artifact), value = artifact.signature.value;
      artifact.signature.value = `${value.slice(0, 10)}${value[10] === 'a' ? 'b' : 'a'}${value.slice(11)}`;
      return { ...r, artifact };
    } });
    const counterparty = await read(forged);
    assert.equal(counterparty.status, 'rejected', JSON.stringify(counterparty));
    assert.match(counterparty.reason, /signature is not verified \(invalid\)/);

    // Kept contradiction 2: the receipt names a transaction the seller really
    // signed (its Listing CREATE), which binds another kind and job. The real
    // anchor authenticates it and answers invalid.
    const [listingCreate] = createsOf(h, 'Listing');
    const signedListing = { hash: listingCreate.hash, content: listingCreate.content, signature: listingCreate.signature };
    const receiptContradiction = capabilityOver(h, { verifyReceipt: (input, real) => real.verifyReceipt({ ...input, signedProjection: signedListing,
      receipt: { ...input.receipt, transactionRef: { ...input.receipt.transactionRef, value: listingCreate.hash } } }) });
    const contradicted = await read(receiptContradiction);
    assert.equal(contradicted.status, 'rejected', JSON.stringify(contradicted));
    assert.match(contradicted.reason, /commitment receipt proof is invalid/);

    // Kept contradiction, the SDK's whole CA-3/CA-7 binding (re-review r3,
    // a review P2-2): a record the seller really signed for this job and
    // Agreement, but with another Listing pin, other parties or another pattern,
    // is rejected. Unsigned, it authenticates nothing; malformed (CA-9), it
    // contradicts nothing: both indeterminate.
    const resign = (record) => {
      const { signature, ...unsigned } = record;
      return { ...unsigned, signature: { ...signature, value: Buffer.from(h.sellerActor.signer.signBytes(signedBytes(FINALITY_COMMITMENT_SEPARATOR, contentHash(unsigned)))).toString('base64url') } };
    };
    for (const [label, mutate] of [
      ['another Listing version', (r) => ({ ...r, listingRef: { ...r.listingRef, version: r.listingRef.version + 1 } })],
      ['another Listing content hash', (r) => ({ ...r, listingRef: { ...r.listingRef, contentHash: 'e'.repeat(64) } })],
      ['the parties swapped', (r) => ({ ...r, parties: [...r.parties].reverse() })],
      ['another buyer', (r) => ({ ...r, parties: [h.sellerActor.signer.claim.replace(/.$/, (c) => (c === '0' ? '1' : '0')), r.parties[1]] })],
      ['another pattern', (r) => ({ ...r, pattern: 'rfq' })],
    ]) {
      const seller = await read(capabilityOver(h, { readRetained: (r) => ({ ...r, artifact: resign(mutate(structuredClone(r.artifact))) }) }));
      assert.equal(seller.status, 'rejected', `${label}: ${JSON.stringify(seller)}`);
      assert.match(seller.reason, /CA-3\/CA-7/, label);
      const unsigned = await read(capabilityOver(h, { readRetained: (r) => ({ ...r, artifact: mutate(structuredClone(r.artifact)) }) }));
      assert.equal(unsigned.status, 'indeterminate', `${label}, not re-signed: ${JSON.stringify(unsigned)}`);
    }
    const malformed = await read(capabilityOver(h, { readRetained: (r) => ({ ...r, artifact: resign({ ...structuredClone(r.artifact), pattern: 'other' }) }) }));
    assert.equal(malformed.status, 'indeterminate', JSON.stringify(malformed));
    assert.match(malformed.reason, /CA-9/);


    // A record naming another Agreement whose signature no longer verifies: the
    // SDK's binding fault (CA-3/CA-7) comes before its signature check, so it
    // authenticates nothing and is indeterminate.
    const rebound = capabilityOver(h, { readRetained: (r) => ({ ...r, artifact: { ...structuredClone(r.artifact), agreementHash: 'f'.repeat(64) } }) });
    const unboundRead = await read(rebound);
    assert.equal(unboundRead.status, 'indeterminate', JSON.stringify(unboundRead));
    assert.match(unboundRead.reason, /CA-3\/CA-7/);

    // Foreign throws outside any SDK callback (the injected clock): indeterminate.
    for (const [label, thrown] of [['TypeError', new TypeError('fetch failed')], ['a string', 'clock unavailable'], ['null', null], ['a look-alike', { category: 'permanent' }]]) {
      const r = await read(composed, { now: () => { throw thrown; } });
      assert.equal(r.status, 'indeterminate', `${label}: ${JSON.stringify(r)}`);
    }

    // The first read: an unmarked refusal (a local scope or journal fault) is
    // indeterminate; only the anchor's marked contradiction is rejected.
    const local = capabilityOver(h, { readRetained: () => ({ status: 'rejected', reason: 'retained demo CREATE scope differs' }) });
    assert.deepEqual(await read(local), { status: 'indeterminate', address: (await read(composed)).address, reason: 'retained demo CREATE scope differs' });
    const marked = capabilityOver(h, { readRetained: () => ({ status: 'rejected', contradiction: true, reason: 'native demo receipt is invalid' }) });
    assert.equal((await read(marked)).status, 'rejected');

    // Kept contradiction 3 at the first read (final review, finding 1): the
    // anchor's reader, given the seller's own signed CREATE the anchor retained
    // (pinned), finds it binds another kind than the caller asked for: marked,
    // so rejected, not thrown. (Unpinned, this node's executed rendering never
    // authenticates; the node-chosen case is dacs-demos-sr2's unit test.)
    const reader = createDemosSr2Adapter({ rpcUrl: h.transport.capability.pins.endpoint, journal: createInMemoryDemosSr2Journal(), sourceCapability: h.transport.capability });
    const firstRead = (expectedArtifactKind) => createDevnetNativeCommitmentCapability({ authority: h.composition.authority, anchor: { authority: h.composition.anchor.authority,
      readRetained: async (input) => {
        const r = await h.composition.anchor.readRetained(input);
        await reader.read(input.logicalAddress, { expectedWriter: h.composition.anchor.writer, expectedArtifactKind, signedProjection: r.signedProjection });
        return r;
      }, verifyReceipt: (input) => h.composition.anchor.verifyReceipt(input) } });
    assert.equal((await read(firstRead('FinalityCommitmentRecord'))).status, 'verified', 'pinned control');
    const kind = await read(firstRead('Listing'));
    assert.deepEqual([kind.status, kind.reason], ['rejected', 'native readback binds another artifact kind'], JSON.stringify(kind));
    assert.equal((await read(composed)).status, 'verified');
    assert.equal(createsOf(h, 'FinalityCommitmentRecord').length, 1);
  });
}
