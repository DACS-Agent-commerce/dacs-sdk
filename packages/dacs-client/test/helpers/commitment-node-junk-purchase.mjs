// the source change, purchase level (shared by the commit-on-signature off and on files).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JUNK_KINDS, assertPendingThenCompletes, contradictingCommitmentPublisher, createsOf, junkPurchase, setCold } from './commitment-node-junk.mjs';

// chainReadback: the calling file runs with DACS_BUYER_CHAIN_READBACK=on, so
// the buyer's commitment reader is buyer-chain-readback.mjs and its reasons
// name the artifact kind (an earlier review, code P2-1 / a review P2-1).
const READER_WORDING = {
  off: { anchor: /^indeterminate: /, notAnchor: /native demo receipt|commitment receipt proof/, receipt: /^indeterminate: native demo receipt is indeterminate/, proof: /^indeterminate: commitment receipt proof is not established/ },
  on: { anchor: /^indeterminate: native FinalityCommitmentRecord read: invalid: /, notAnchor: /receipt is indeterminate|commitment receipt proof/,
    receipt: /^indeterminate: native FinalityCommitmentRecord receipt is indeterminate/, proof: /^indeterminate: commitment resume: SubstrateError: commitment receipt proof is not established/ },
};

export function nodeJunkPurchaseTests(commitOnSignature, { chainReadback = false } = {}) {
  const mode = `DACS_COMMIT_ON_SIGNATURE=${commitOnSignature ? 'on' : 'off'}${chainReadback ? ', DACS_BUYER_CHAIN_READBACK=on' : ''}`;
  if (chainReadback) assert.equal(process.env.DACS_BUYER_CHAIN_READBACK, 'on', 'the calling file turns the switch on');
  const wording = READER_WORDING[chainReadback ? 'on' : 'off'];

  // The last three commitment reads of verify_deal's readback, with a cold
  // proof cache: the anchor's read, its receipt check (the first read's
  // verdict) and the SDK's receipt re-read.
  for (const kind of JUNK_KINDS) {
    test(`${mode}: ${kind} at the buyer's first read or the SDK's re-read leaves the purchase agreement_pending; a clean readback completes it`, { timeout: 600000 }, async (t) => {
      t.after(() => setCold(false));
      const clean = await junkPurchase(t, { kind, commitOnSignature, at: 0 });
      assert.equal(clean.op.status, 'awaiting_approval', clean.line);
      const total = clean.seen, lines = [clean.line], outcomes = new Map();
      assert.ok(total >= 3, clean.line);
      for (let at = total - 2; at <= total; at++) {
        const r = await junkPurchase(t, { kind, commitOnSignature, at });
        lines.push(r.line);
        outcomes.set(at, r.attempts.filter((x) => x.step === 'commitment').map((x) => `${x.outcome}: ${x.reason ?? ''}`).at(-1) ?? '');
        await assertPendingThenCompletes(r, lines);
      }
      t.diagnostic(lines.join('\n'));
      // The anchor's own read (final review, finding 1): recorded, not thrown.
      assert.match(outcomes.get(total - 2), wording.anchor, lines.join('\n'));
      assert.doesNotMatch(outcomes.get(total - 2), wording.notAnchor, lines.join('\n'));
      assert.match(outcomes.get(total - 1), wording.receipt, lines.join('\n'));
      assert.match(outcomes.get(total), wording.proof, lines.join('\n'));
    });
  }

  // The Agreement receipt check (protocol-purchases verifyAnchorReceipt) uses
  // the same adapter: a block the node does not establish at any read of the
  // Agreement's block over approve and one verify_deal never ends the purchase.
  test(`${mode}: block-not-found at any read of the Agreement's block never ends the purchase; a clean readback completes it`, { timeout: 900000 }, async (t) => {
    t.after(() => setCold(false));
    const clean = await junkPurchase(t, { kind: 'block-not-found', commitOnSignature, at: 0, artifactKind: 'Agreement' });
    assert.equal(clean.op.status, 'awaiting_approval', clean.line);
    const lines = [clean.line];
    for (let at = 1; at <= Math.min(clean.seen, 16); at++) {
      const r = await junkPurchase(t, { kind: 'block-not-found', commitOnSignature, at, artifactKind: 'Agreement' });
      lines.push(r.line);
      // The seller's own read of the Agreement (its commit request) holds the
      // seller, not the purchase: the buyer stays agreement_pending, never
      // rejected, and that seller-side recovery is outside this readback.
      if (r.attempts.some((x) => x.step === 'commit-request' && x.outcome === 'unavailable')) {
        assert.notEqual(r.op.status, 'agreement_rejected', lines.join('\n'));
        assert.ok(!r.attempts.some((x) => x.outcome === 'rejected'), r.line);
      } else await assertPendingThenCompletes(r, lines);
    }
    t.diagnostic(lines.join('\n'));
    assert.ok(lines.slice(1).some((line) => /agreement\/indeterminate \(agreement-anchor: agreement anchor receipt authentication was indeterminate/.test(line)), `the Agreement receipt check was reached:\n${lines.join('\n')}`);
  });

  if (chainReadback && !commitOnSignature) {
    // Code review an earlier review, P3-2: with the switch on, the buyer reads a
    // commitment only through the signed CREATE bytes a seller answer offers.
    // A commitment published outside the seller's commit route (as the forged
    // ones below are) is never pointed to, so nothing is read: the purchase
    // stays agreement_pending, fail-closed, until its approval window ends.
    test(`${mode}: a seller-signed commitment for another Agreement that no seller answer points to is not read; the purchase stays agreement_pending`, { timeout: 600000 }, async (t) => {
      t.after(() => setCold(false));
      const { seen } = await junkPurchase(t, { kind: 'block-not-found', commitOnSignature, at: 0, artifactKind: 'Agreement' });
      const r = await junkPurchase(t, { kind: 'block-not-found', commitOnSignature, at: seen, artifactKind: 'Agreement' });
      assert.ok(r.attempts.some((x) => x.step === 'commit-request' && x.outcome === 'unavailable'), r.line);
      await contradictingCommitmentPublisher(r.h)(r.op.state.protocol.agreement.artifact);
      await r.a.verify();
      await r.h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
      const op = r.a.operation(), last = op.state.protocol.attempts.filter((x) => x.step === 'commitment').at(-1);
      assert.equal(op.status, 'agreement_pending', JSON.stringify(op.state.protocol.attempts.slice(-4)));
      assert.equal(last.outcome, 'indeterminate');
      assert.match(last.reason, /signed FinalityCommitmentRecord CREATE is not available yet/);
      assert.equal(createsOf(r.h, 'FinalityCommitmentRecord').length, 1, 'only the contradicting commitment; the seller wrote no other');
    });
  }

  if (!commitOnSignature && !chainReadback) {
    // An authenticated contradiction still ends the purchase: the seller's own
    // wallet anchored, for this job, a commitment it signed for another Agreement.
    test(`${mode}: a seller-signed commitment for another Agreement ends the purchase at agreement_rejected`, { timeout: 600000 }, async (t) => {
      t.after(() => setCold(false));
      // The seller's own last read of the Agreement's block finds none: the
      // Agreement is anchored and the seller has not committed. The forged
      // commitment is then published through the seller's own anchor.
      const { seen } = await junkPurchase(t, { kind: 'block-not-found', commitOnSignature, at: 0, artifactKind: 'Agreement' });
      const r = await junkPurchase(t, { kind: 'block-not-found', commitOnSignature, at: seen, artifactKind: 'Agreement' });
      assert.ok(r.attempts.some((x) => x.step === 'commit-request' && x.outcome === 'unavailable'), r.line);
      assert.equal(createsOf(r.h, 'FinalityCommitmentRecord').length, 0, r.line);
      await contradictingCommitmentPublisher(r.h)(r.op.state.protocol.agreement.artifact);
      await r.a.verify();
      await r.h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
      const h = r.h, op = r.a.operation(), last = op.state.protocol.attempts.filter((x) => x.step === 'commitment').at(-1);
      assert.equal(op.status, 'agreement_rejected', JSON.stringify(op.state.protocol.attempts.slice(-4)));
      assert.equal(last.outcome, 'rejected');
      assert.match(last.reason, /binds different authenticated session content \(CA-3\/CA-7\)/);
      assert.equal(createsOf(h, 'FinalityCommitmentRecord').length, 1, 'only the contradicting commitment; the seller wrote no other');
    });

    // The rest of the SDK's CA-3/CA-7 binding (re-review r3, a review P2-2): a
    // commitment the seller signed and anchored for this job and Agreement, but
    // with another Listing pin or other parties, ends the purchase at
    // agreement_rejected on the next readback, not at expiry. (Another pattern
    // is reader-level only: the seller's packaged wallet anchors only a
    // fixed-price commitment, sdk-provider.mjs devnetDemoArtifactMatches.)
    test(`${mode}: a seller-signed commitment binding another Listing or other parties ends the purchase at agreement_rejected`, { timeout: 900000 }, async (t) => {
      t.after(() => setCold(false));
      const { seen } = await junkPurchase(t, { kind: 'block-not-found', commitOnSignature, at: 0, artifactKind: 'Agreement' });
      for (const [label, mutate] of [
        ['another Listing version', (u) => ({ ...u, listingRef: { ...u.listingRef, version: u.listingRef.version + 1 } })],
        ['the parties swapped', (u) => ({ ...u, parties: [...u.parties].reverse() })],
      ]) {
        const r = await junkPurchase(t, { kind: 'block-not-found', commitOnSignature, at: seen, artifactKind: 'Agreement' });
        assert.ok(r.attempts.some((x) => x.step === 'commit-request' && x.outcome === 'unavailable'), `${label}: ${r.line}`);
        await contradictingCommitmentPublisher(r.h, mutate)(r.op.state.protocol.agreement.artifact);
        await r.a.verify();
        await r.h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
        const op = r.a.operation(), last = op.state.protocol.attempts.filter((x) => x.step === 'commitment').at(-1);
        assert.equal(op.status, 'agreement_rejected', `${label}: ${JSON.stringify(op.state.protocol.attempts.slice(-4))}`);
        assert.equal(last.outcome, 'rejected', label);
        assert.match(last.reason, /binds different authenticated session content \(CA-3\/CA-7\)/, label);
        assert.equal(createsOf(r.h, 'FinalityCommitmentRecord').length, 1, `${label}: only the contradicting commitment`);
      }
    });
  }
}
