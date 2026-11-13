import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, generateCanonicalJobId } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_HEADER, DACS_SELLER_HTTP_PATHS as PATHS } from '@kynesyslabs/dacs/wire';
import { CONTINUING_PATHS } from '../../../dist/wire/discovery.js';
import { world, purchase, party, validReceipt, setPurchaseAdmission, PUBLIC_ENDPOINT, T0, JOB } from './helpers/wire-client-fixture.mjs';
import { committedPurchase } from './helpers/wire-committed-purchase.mjs';
// The fixture installs the admission double, so the modules that read admission state load after it.
const { createSellerAgentClient } = await import('../src/dacs/seller-http.mjs');
const { purchaseStore, createSqlitePurchaseStore } = await import('../src/seams/purchase-store-not-wired.mjs');
const { createBuyerChainReadback } = await import('../src/dacs/buyer-chain-readback.mjs');
const { createDevnetAgreementTransport } = await import('../src/wallet/devnet-native-transport.mjs');
const { anchoredTupleMembers, createContinuationEvidence, keepCommitmentTuple, keptTupleBytes } = await import('../src/dacs/continuation-evidence.mjs');

const OTHER_JOB = generateCanonicalJobId({ timestamp: T0, entropy: Buffer.alloc(10, 0x22) });
const BODY = { transportIdentity: { jobId: JOB } }, TEXT = JSON.stringify(BODY);
const { transaction } = purchaseStore(createSqlitePurchaseStore());
const canonicalBytes = (value) => Buffer.from(canonicalize(value));
const MEMBERS = ['commitment', 'agreement', 'signedListing'];
const CONTINUING = [PATHS.payments, PATHS.bundleRequest, PATHS.bundleCountersignature];
const READS = [PATHS.state, PATHS.bundleBuyerCopy];
const MISSING = { commitment: ['continuation_commitment_invalid', 'CONTINUATION-EVIDENCE-REQUIRED'], agreement: ['continuation_agreement_invalid', 'ARTIFACT-NOT-ADMITTED'], signedListing: ['continuation_listing_invalid', 'ARTIFACT-NOT-ADMITTED'] };
const UNCONTINUED = [PATHS.contextChallenge, PATHS.context, PATHS.proposals, PATHS.commitments, PATHS.commitmentSignature];

// A committed purchase row (restart is reopening its SQLite file) and a world whose proof verifies its Listing.
async function scenario(t, { ready, validity, bytes = true, committed = true, noReader = false } = {}) {
  const seen = [];
  const readCommitmentReceipt = noReader ? null : Object.assign(async (tuple) => { seen.push(tuple); return 'valid'; }, { chainIdentity: validReceipt.chainIdentity });
  const made = await committedPurchase({ jobId: JOB, publicEndpoint: PUBLIC_ENDPOINT, validity });
  const w = await world(t, { pin: made.pin, agreementHash: made.agreementHash, ready, readCommitmentReceipt });
  const commitment = bytes ? made.summaryWithBytes : made.summary;
  const p = await purchase(t, w, { signedListing: made.listing, protocolPatch: { stage: committed ? 'seller-committed' : 'agreement-anchored', agreement: { artifact: made.agreement, hash: made.agreementHash }, ...(committed ? { commitment } : {}) } });
  return { ...made, w, p, seen };
}
const noReadback = async () => { throw new Error('no readback expected'); };
const evidenceFor = (p, readCommitment = noReadback) => createContinuationEvidence({ readCommitment, keep: (operation, members) => keepCommitmentTuple({ db: p.db, ops: p.ops, transaction }, operation, members) });
const authFor = (s, evidence) => s.w.createSellerWireAuthentication({ ...s.w.options, evidence });
const rowAuth = (s, readCommitment) => {
  const evidence = evidenceFor(s.p, readCommitment);
  return authFor(s, () => evidence(s.p.get()));
};
const sign = (auth, path) => auth.request(path, BODY, TEXT);
const verifiedReadback = (s, anchored = s.anchored) => async () => ({ status: 'verified', contentHash: s.summary.contentHash, signer: s.summary.signer, committedAt: s.summary.committedAt, anchored });
const refuses = (s, work, expectedCode, detail) => {
  const signed = s.w.state.signs.length;
  return assert.rejects(work, (error) => {
    assert.equal(error.code, expectedCode);
    if (detail)
      assert.equal(error.detail, detail);
    assert.equal(s.w.state.signs.length, signed, 'the session signer was called');
    return true;
  });
};
// The wire asks the receipt reader at both signing entries, so each request is read at least twice.
const sameTuples = (seen, anchored, requests) => {
  assert.ok(seen.length >= requests * 2);
  assert.deepEqual(seen.map((tuple) => canonicalize(tuple)), seen.map(() => canonicalize(anchored)));
};

test('a real payment request through the client is signed with the kept finalized commitment, the two-party Agreement and the signed Listing', async (t) => {
  const s = await scenario(t), fetches = [];
  const client = createSellerAgentClient({ url: PUBLIC_ENDPOINT, authentication: rowAuth(s), fetchImpl: async (url, init) => { fetches.push(init); return new Response('{}', { status: 500 }); } });
  await assert.rejects(client.submitPayment({ jobId: JOB, txHash: 'a'.repeat(64) }));
  assert.equal(fetches.length, 1);
  assert.ok(fetches[0].headers[DACS_SELLER_HTTP_HEADER]);
  assert.equal(s.w.state.signs.length, 1);
  assert.equal(canonicalize(s.seen[0]), canonicalize(s.anchored));
  assert.deepEqual(await evidenceFor(s.p)(s.p.get()), { commitment: canonicalBytes(s.anchored), agreement: canonicalBytes(s.agreement), signedListing: canonicalBytes(s.listing) });
});

test('after a restart the same evidence bytes are rebuilt from the purchase row and the payment request signs with identical evidence', async (t) => {
  const s = await scenario(t), before = await evidenceFor(s.p)(s.p.get());
  await sign(rowAuth(s), PATHS.payments);
  s.p.reopen();
  assert.deepEqual(await evidenceFor(s.p)(s.p.get()), before);
  await sign(rowAuth(s), PATHS.payments);
  assert.equal(s.w.state.signs.length, 2);
  assert.equal(canonicalize(s.seen[1]), canonicalize(s.seen[0]));
});

test('under a fresh readiness-false proof the payment request still signs, with no continuation capability', async (t) => {
  const s = await scenario(t, { ready: false });
  assert.ok((await sign(rowAuth(s), PATHS.payments)).header);
  assert.equal(s.w.state.signs.length, 1);
});

test('missing commitment, Agreement or Listing evidence refuses continuation_commitment_invalid (CONTINUATION-EVIDENCE-REQUIRED) before the signer is called', async (t) => {
  const s = await scenario(t), full = await evidenceFor(s.p)(s.p.get());
  for (const member of MEMBERS) {
    const evidence = { ...full };
    delete evidence[member];
    await refuses(s, sign(authFor(s, () => evidence), PATHS.payments), ...MISSING[member]);
  }
  await refuses(s, sign(authFor(s, () => undefined), PATHS.payments), ...MISSING.commitment);
  const withoutAgreement = { ...s.p.get().state.protocol };
  delete withoutAgreement.agreement;
  await refuses(s, sign(authFor(s, () => evidenceFor(s.p)({ ...s.p.get(), state: { protocol: withoutAgreement } })), PATHS.payments), ...MISSING.agreement);
});

test('a commitment for another job or Agreement, an Agreement without the seller\'s signature, or a Listing for another endpoint refuses before signing', async (t) => {
  const s = await scenario(t), full = await evidenceFor(s.p)(s.p.get());
  const other = await committedPurchase({ jobId: OTHER_JOB, publicEndpoint: PUBLIC_ENDPOINT });
  const elsewhere = await committedPurchase({ jobId: JOB, publicEndpoint: 'https://other.example' });
  const unsigned = { ...s.agreement, signatures: s.agreement.signatures.slice(0, 1) };
  for (const [evidence, expectedCode] of [[{ commitment: canonicalBytes(other.anchored) }, 'continuation_commitment_invalid'], [{ agreement: canonicalBytes(other.agreement) }, 'continuation_agreement_invalid'],
    [{ agreement: canonicalBytes(unsigned) }, 'continuation_agreement_invalid'], [{ signedListing: canonicalBytes(elsewhere.listing) }, 'continuation_listing_invalid']])
    await refuses(s, sign(authFor(s, () => ({ ...full, ...evidence })), PATHS.payments), expectedCode);
});

test('an endpoint proof verified without a commitment-receipt reader refuses the payment before signing', async (t) => {
  const s = await scenario(t, { noReader: true });
  await refuses(s, sign(rowAuth(s), PATHS.payments), 'commitment_reader_required');
});

test('kept commitment bytes that do not match their stored hash refuse before signing and are never re-derived without a fresh authenticated readback', async (t) => {
  const s = await scenario(t, { bytes: false });
  s.p.ops.transition(s.p.op.id, 'agreement_pending', 'agreement_pending', { state: { protocol: { ...s.p.get().state.protocol, commitment: { ...s.summary, anchoredB64: Buffer.from('{}').toString('base64'), anchoredHash: anchoredTupleMembers(s.anchored).anchoredHash } } }, event: 'test_corrupt' });
  const asked = [];
  const unverified = async (operation) => { asked.push(operation.id); return { status: 'indeterminate' }; };
  await refuses(s, sign(rowAuth(s, unverified), PATHS.payments), 'commitment_unverified');
  assert.equal(asked.length, 1);
  assert.equal(s.p.get().state.protocol.commitment.anchoredB64, Buffer.from('{}').toString('base64'));
});

test('a readback summary or a status flag in place of an artifact refuses ARTIFACT-NOT-ADMITTED or CONTINUATION-EVIDENCE-REQUIRED', async (t) => {
  const s = await scenario(t), full = await evidenceFor(s.p)(s.p.get());
  for (const path of [PATHS.payments, ...READS]) {
    await refuses(s, sign(authFor(s, () => ({ ...full, commitment: s.summary })), path), 'continuation_commitment_invalid', 'ARTIFACT-NOT-ADMITTED');
    await refuses(s, sign(authFor(s, () => ({ ...full, agreement: true })), path), 'continuation_agreement_invalid', 'ARTIFACT-NOT-ADMITTED');
  }
});

test('a row with a verified summary and no kept bytes keeps the tuple from one fresh authenticated readback that matches the summary, and refuses when it does not match', async (t) => {
  const s = await scenario(t, { bytes: false }), asked = [];
  const readback = verifiedReadback(s);
  const counted = async (operation) => { asked.push(operation.id); return readback(); };
  const auth = rowAuth(s, counted);
  await sign(auth, PATHS.payments);
  await sign(auth, PATHS.payments);
  assert.equal(asked.length, 1);
  assert.deepEqual(s.p.get().state.protocol.commitment, s.summaryWithBytes);
  const mismatched = await scenario(t, { bytes: false });
  await refuses(mismatched, sign(rowAuth(mismatched, async () => ({ ...(await verifiedReadback(mismatched)()), committedAt: 1 })), PATHS.payments), 'commitment_unverified');
  assert.equal(mismatched.p.get().state.protocol.commitment.anchoredB64, undefined);
});

test('bundle request and bundle countersignature are signed with the same evidence at the adapter, while the protocol\'s countersign stays native_completion_held', async (t) => {
  const s = await scenario(t), auth = rowAuth(s);
  for (const path of [PATHS.bundleRequest, PATHS.bundleCountersignature])
    assert.ok((await sign(auth, path)).header);
  sameTuples(s.seen, s.anchored, 2);
  await assert.rejects(s.p.service.countersign(s.p.get()), (error) => error.code === 'native_completion_held');
});

test('after a restart and under a fresh readiness-false proof, state and buyer-copy reads of a committed purchase carry the real verified commitment tuple, Agreement and Listing bytes from the row and sign with no continuation capability', async (t) => {
  const s = await scenario(t, { ready: false });
  s.p.reopen();
  for (const path of READS)
    assert.ok((await sign(rowAuth(s), path)).header);
  sameTuples(s.seen, s.anchored, 2);
  assert.equal(s.w.state.signs.length, 2);
});

test('after the live Listing eligibility reader becomes unavailable, and separately after the Listing\'s window ends, committed state and buyer-copy reads still sign from the real verified commitment evidence (W-FINISH C26)', async (t) => {
  const down = await scenario(t);
  down.w.state.listingReaderFailure = new Error('listing reader unavailable');
  await assert.rejects(sign(authFor(down, () => undefined), PATHS.state), /listing reader unavailable/);
  for (const path of READS)
    assert.ok((await sign(rowAuth(down), path)).header);
  const ended = await scenario(t, { validity: { notBefore: T0 - 3600000, notAfter: T0 + 10000 } });
  ended.w.state.time = T0 + 20000;
  ended.w.state.listingExpiresAt = T0 + 10000;
  await assert.rejects(sign(authFor(ended, () => undefined), PATHS.state), (error) => error.code === 'listing_unsupported');
  for (const path of READS)
    assert.ok((await sign(rowAuth(ended), path)).header);
});

test('committed reads with wrong evidence (another job\'s commitment, an Agreement without the seller\'s signature, a Listing for another endpoint, or tuple bytes that do not match anchoredHash) refuse before signing', async (t) => {
  const s = await scenario(t), full = await evidenceFor(s.p)(s.p.get());
  const other = await committedPurchase({ jobId: OTHER_JOB, publicEndpoint: PUBLIC_ENDPOINT });
  const elsewhere = await committedPurchase({ jobId: JOB, publicEndpoint: 'https://other.example' });
  const unsigned = { ...s.agreement, signatures: s.agreement.signatures.slice(0, 1) };
  for (const path of READS) {
    for (const [evidence, expectedCode] of [[{ commitment: canonicalBytes(other.anchored) }, 'continuation_commitment_invalid'], [{ agreement: canonicalBytes(unsigned) }, 'continuation_agreement_invalid'],
      [{ signedListing: canonicalBytes(elsewhere.listing) }, 'continuation_listing_invalid']])
      await refuses(s, sign(authFor(s, () => ({ ...full, ...evidence })), path), expectedCode);
    const corrupt = await scenario(t, { bytes: false });
    corrupt.p.ops.transition(corrupt.p.op.id, 'agreement_pending', 'agreement_pending', { state: { protocol: { ...corrupt.p.get().state.protocol, commitment: { ...corrupt.summary, anchoredB64: Buffer.from('{}').toString('base64'), anchoredHash: 'f'.repeat(64) } } }, event: 'test_corrupt' });
    await refuses(corrupt, sign(rowAuth(corrupt, async () => ({ status: 'rejected' })), path), 'commitment_unverified');
  }
});

test('before commitment, state and buyer-copy reads carry no evidence and keep the live Listing eligibility and window checks; challenge, context, proposals, commitments and commitments/signature requests carry none, also on a committed purchase', async (t) => {
  for (const committed of [false, true]) {
    const s = await scenario(t, { committed }), asked = [];
    const evidence = evidenceFor(s.p), auth = authFor(s, async () => { asked.push(1); return evidence(s.p.get()); });
    for (const path of UNCONTINUED)
      assert.ok((await sign(auth, path)).header);
    assert.equal(asked.length, 0);
    assert.equal(s.seen.length, 0);
    if (!committed) {
      assert.ok((await sign(auth, PATHS.state)).header);
      assert.equal(s.seen.length, 0);
      s.w.state.listingExpiresAt = T0 - 1;
      await assert.rejects(sign(auth, PATHS.state), (error) => error.code === 'listing_unsupported');
      await refuses(s, sign(auth, PATHS.bundleBuyerCopy), ...MISSING.commitment);
    } else
      assert.ok((await sign(auth, PATHS.state)).header);
  }
});

// Each of the ten client routes declares what evidence it needs. A route the table does not declare, or one the wire adds to its continuing set, fails the table.
const REQUIREMENT = {
  [PATHS.contextChallenge]: 'none', [PATHS.context]: 'none', [PATHS.proposals]: 'none', [PATHS.commitments]: 'none', [PATHS.commitmentSignature]: 'none',
  [PATHS.state]: 'committed-read', [PATHS.bundleBuyerCopy]: 'committed-read', [PATHS.payments]: 'continuing', [PATHS.bundleRequest]: 'continuing', [PATHS.bundleCountersignature]: 'continuing',
};
const signsOrRefuses = async (auth, path, signs, cell) => {
  if (signs)
    assert.ok((await sign(auth, path)).header, cell);
  else
    await assert.rejects(sign(auth, path), (error) => error instanceof Error && /^(continuation_|commitment_)/.test(error.code), cell);
};

test('one table over the ten client routes, each declaring its evidence requirement (continuing, committed-read or none), with the continuing set read from the wire\'s CONTINUING_PATHS so a new wire route that the table does not declare fails it, signs or refuses by every evidence member present, absent or another job\'s, before commitment and committed', async (t) => {
  assert.deepEqual(Object.keys(REQUIREMENT).sort(), Object.values(PATHS).sort());
  assert.deepEqual(Object.keys(REQUIREMENT).filter((path) => REQUIREMENT[path] === 'continuing').sort(), [...CONTINUING_PATHS].sort());
  assert.deepEqual([...CONTINUING].sort(), [...CONTINUING_PATHS].sort());
  const s = await scenario(t), before = await scenario(t, { committed: false }), noReader = await scenario(t, { noReader: true });
  const full = await evidenceFor(s.p)(s.p.get());
  const other = await committedPurchase({ jobId: OTHER_JOB, publicEndpoint: PUBLIC_ENDPOINT, listingId: 'other-listing' });
  const another = { commitment: canonicalBytes(other.anchored), agreement: canonicalBytes(other.agreement), signedListing: canonicalBytes(other.listing) };
  const changes = [['present', {}], ...MEMBERS.flatMap((member) => [[`${member} absent`, { [member]: undefined }], [`${member} from another job`, { [member]: another[member] }]])];
  for (const [path, requirement] of Object.entries(REQUIREMENT)) {
    for (const [name, change] of changes)
      await signsOrRefuses(authFor(s, async () => ({ ...full, ...change })), path, requirement === 'none' || name === 'present', `${requirement} ${path} committed, ${name}`);
    // Before commitment the row holds no evidence: reads sign under the live checks, except the bundle copy, which the wire gives no new-purchase branch.
    await signsOrRefuses(rowAuth(before), path, requirement === 'none' || path === PATHS.state, `${requirement} ${path} before commitment`);
    await signsOrRefuses(rowAuth(noReader), path, requirement === 'none', `${requirement} ${path} without a receipt reader`);
  }
});

test('the verified commitment readback returns the anchored tuple, whose canonical bytes and hash the commitment summary keeps', async () => {
  const made = await committedPurchase({ jobId: JOB, publicEndpoint: PUBLIC_ENDPOINT }), seller = party(2);
  const projection = { hash: 'b'.repeat(64), content: { from: `0x${seller.raw}`, to: made.anchored.nativeAddress, data: ['storageProgram', { metadata: { logicalAddress: `dacs3:commit:${JOB}`, artifactKind: 'FinalityCommitmentRecord' } }] }, signature: { type: 'ed25519', data: '00' } };
  const receipt = { ...made.anchored.anchorReceipt, writer: seller.claim, transactionRef: { kind: 'demos', value: projection.hash } };
  const sourceCapability = createDevnetAgreementTransport({ expected: { network: 'testnet', chainIdentity: 'f'.repeat(64), pinVersion: 'TEST-1', endpoint: 'https://rpc.invalid/', transportAuthority: 'TEST-owner' },
    transportOwner: { getContext() { throw Error('unused'); }, acquireConnectionFence() { throw Error('unused'); } }, journal: { get: async () => null, put: async () => { throw Error('read only'); }, entries: async () => [], withWalletLock: (_key, work) => work() } });
  const reader = { read: async () => ({ status: 'present', artifact: made.anchored.record, artifactKind: 'FinalityCommitmentRecord', receipt }), verifyReceipt: async () => 'valid' };
  const result = await createBuyerChainReadback({ sourceCapability, reader }).readCommitment({ agreement: made.agreement, listing: made.listing, seller: seller.claim, signedProjection: projection });
  assert.equal(result.status, 'verified', JSON.stringify(result));
  assert.deepEqual(result.anchored, { record: made.anchored.record, nativeAddress: made.anchored.nativeAddress, anchorTxRef: result.anchored.anchorTxRef, anchorReceipt: receipt });
  assert.ok(result.anchored.anchorTxRef);
  assert.deepEqual(keptTupleBytes(anchoredTupleMembers(result.anchored)), canonicalBytes(result.anchored));
});

test('keeping the tuple from a fresh readback leaves the same flow\'s payment answer saved', async (t) => {
  const s = await scenario(t, { bytes: false }), snapshot = s.p.get(), revision = snapshot.state.protocol.revision;
  await evidenceFor(s.p, verifiedReadback(s))(snapshot);
  const stored = s.p.get();
  assert.equal(stored.state.protocol.revision, revision);
  assert.equal(stored.state.protocol.stage, snapshot.state.protocol.stage);
  assert.equal(stored.status, snapshot.status);
  assert.ok(stored.state.protocol.commitment.anchoredHash);
});

test('kept tuple whose hash mismatches is replaced only by a fresh authenticated readback matching the summary, else the paid row stays held and nothing is signed', async (t) => {
  const s = await scenario(t, { bytes: false });
  s.p.ops.transition(s.p.op.id, 'agreement_pending', 'agreement_pending', { state: { protocol: { ...s.p.get().state.protocol, commitment: { ...s.summary, anchoredB64: Buffer.from('{}').toString('base64'), anchoredHash: 'f'.repeat(64) } } }, event: 'test_corrupt' });
  s.p.reopen();
  await refuses(s, sign(rowAuth(s, async () => ({ status: 'indeterminate' })), PATHS.payments), 'commitment_unverified');
  assert.equal(s.p.get().status, 'agreement_pending');
  assert.equal(s.p.get().state.protocol.commitment.anchoredHash, 'f'.repeat(64));
  await sign(rowAuth(s, verifiedReadback(s)), PATHS.payments);
  assert.deepEqual(s.p.get().state.protocol.commitment, s.summaryWithBytes);
  await sign(rowAuth(s), PATHS.payments);
  assert.equal(s.w.state.signs.length, 2);
});

test('a failing evidence readback, or admission re-held while it is awaited, gives zero session-signer calls and keeps the row unchanged', async (t) => {
  const s = await scenario(t, { bytes: false }), before = s.p.get();
  const timedOut = async () => { throw Object.assign(new Error('the node did not answer in time'), { code: 'rpc_timeout' }); };
  await refuses(s, sign(rowAuth(s, timedOut), PATHS.payments), 'rpc_timeout');
  assert.deepEqual(s.p.get(), before);
  const reheld = async () => {
    setPurchaseAdmission('held');
    return verifiedReadback(s)();
  };
  await refuses(s, sign(rowAuth(s, reheld), PATHS.payments), 'profile_not_admitted');
});

