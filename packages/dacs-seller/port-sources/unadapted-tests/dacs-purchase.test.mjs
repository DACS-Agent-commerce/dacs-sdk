// Offline DACS fixed-price pay-dem purchase, protocol level: the buyer side
// (src/dacs/purchase-protocol.mjs) against the seller agent
// (src/dacs/seller-agent.mjs over seller-http.mjs) on SIMULATED loopback
// fixtures: the Demos chain fixture for the native transfer and the fixture
// SR-2 substrate for anchors. Fresh ephemeral keys for buyer and seller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attestationBundleHash, contentHash, generateCanonicalJobId, bundleAddress, paymentEvidenceAddress, finalityCommitmentAddress, signComponentArtifact, signedBytes, ARTIFACT_SEPARATORS } from '@kynesyslabs/dacs';
import { startChainFixture } from './fixtures/chain-server.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { startAnchorFixture, startSellerFixture } from './dacs-loopback-fixture.test.mjs';
import { createFixtureAnchorClient, anchorWriteMessage, canonicalSignature } from '../src/dacs/fixture-anchors.mjs';
import { createSellerAgentClient, SellerRefusedError } from '../src/dacs/seller-http.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { buildUnsignedIdentityBundle, attachIdentityPresentation } from '../src/dacs/listing.mjs';
import {
  planAgreement,
  exchangeAgreement,
  readCommitment,
  agreementTerms,
  verifyPaymentEvidence,
  verifyDelivery,
  bundleSession,
  bundleSigningPlan,
  assembleBundleCopies,
  verifyAnchoredCopy,
  deliverableAddress,
  deliveryEvidenceAddress,
  PROTOCOL_LIMITS,
} from '../src/dacs/purchase-protocol.mjs';
import * as shippedProtocol from '../src/dacs/purchase-protocol.mjs';

async function world(t, options = {}) {
  const chain = await startChainFixture();
  const anchors = await startAnchorFixture(options.anchor);
  const seller = await startSellerFixture({ anchorUrl: anchors.url, chainUrl: chain.url, ...options.seller });
  t.after(async () => {
    await seller.close();
    await anchors.close();
    await chain.close();
  });
  const buyer = createEphemeralWallet();
  const reader = createDemosChainReader({ rpcUrl: chain.url, network: 'testnet' });
  return { chain, anchors, seller, buyer, reader, anchorClient: createFixtureAnchorClient({ url: anchors.url }), sellerClient: createSellerAgentClient({ url: seller.url }) };
}

function buyerBundle(wallet) {
  const unsigned = buildUnsignedIdentityBundle({ address: wallet.address, presentedAt: Date.now(), sessionSeed: 'dacs-purchase-test' });
  return attachIdentityPresentation(unsigned, wallet.signHex(unsigned.message));
}

// Steps 1-3: Agreement exchange (buyer-anchored) and seller commitment.
async function agree(w, { jobId = generateCanonicalJobId(), bundle = buyerBundle(w.buyer), tamper } = {}) {
  const planned = planAgreement({ jobId, listing: w.seller.listing, buyerBundle: bundle, generatedAt: Date.now() });
  let { plan, draft } = planned;
  let messages = planned;
  if (tamper) {
    draft = tamper(structuredClone(draft));
    const { createFixedPriceAgreementSigningPlan, fixedPriceAgreementSignedBytes } = await import('@kynesyslabs/dacs');
    plan = createFixedPriceAgreementSigningPlan(draft);
    messages = { agreementMessage: Buffer.from(fixedPriceAgreementSignedBytes(plan)).toString('utf8'), anchorMessage: anchorWriteMessage(planned.anchorAddress, plan.agreementHash) };
  }
  const progress = await exchangeAgreement({
    plan,
    draft,
    buyerClaim: w.buyer.claim,
    buyerBundle: bundle,
    agreementSignature: w.buyer.signHex(messages.agreementMessage),
    anchorSignature: w.buyer.signHex(messages.anchorMessage),
    seller: w.sellerClient,
    anchors: w.anchorClient,
  });
  return { jobId, progress, bundle };
}

async function pay(w, agreement, { amountOs, to } = {}) {
  const terms = agreementTerms(agreement);
  const payload = buildNativeTransferPayload({ from: w.buyer.address, to: to ?? terms.payee, amountOs: amountOs ?? terms.price.amountOs, nonce: w.chain.nonceOf(w.buyer.address) + 1, timestamp: Date.now(), encoding: 'os-string' });
  const txHash = w.chain.walletBroadcast(payload);
  const observed = await w.reader.observeTransfer(txHash);
  assert.equal(observed.status, 'included');
  return { txHash, observed: { txHash: observed.txHash, blockNumber: observed.blockNumber } };
}

test('accepting control: one complete offline DACS purchase through SDK buyer and seller steps', async (t) => {
  const w = await world(t);
  const { jobId, progress } = await agree(w);
  assert.equal(progress.disposition, 'anchored', JSON.stringify(progress));
  const agreement = progress.result.agreement;
  const terms = agreementTerms(agreement);
  assert.equal(terms.payee, `0x${w.seller.wallet.claim.slice('did:demos:agent:'.length)}`);
  assert.equal(terms.price.amountOs, '2500000000');

  // No commitment yet: readback reports absence (payment must not start).
  assert.equal((await readCommitment({ agreement, listing: w.seller.listing, anchors: w.anchorClient })).status, 'absent');
  const committed = await w.sellerClient.commit(jobId);
  assert.equal(committed.status, 'committed');
  const commitment = await readCommitment({ agreement, listing: w.seller.listing, anchors: w.anchorClient });
  assert.equal(commitment.status, 'verified', JSON.stringify(commitment));
  assert.equal(commitment.signer, w.seller.wallet.claim);

  const { txHash, observed } = await pay(w, agreement);
  const delivered = await w.sellerClient.submitPayment({ jobId, txHash, payerPayingKey: w.buyer.claim });
  assert.equal(delivered.status, 'delivered', JSON.stringify(delivered));

  const evidenceRecord = await w.anchorClient.read(paymentEvidenceAddress(jobId, terms.rail, terms.paymentPhaseIndex));
  const payment = await verifyPaymentEvidence({ agreement, record: evidenceRecord, observed });
  assert.equal(payment.status, 'verified', JSON.stringify(payment));
  assert.equal(payment.model, 'bft-final');

  const delivery = await verifyDelivery({ agreement, deliverable: await w.anchorClient.read(deliverableAddress(jobId)), evidenceRecord: await w.anchorClient.read(deliveryEvidenceAddress(jobId)) });
  assert.equal(delivery.status, 'verified', JSON.stringify(delivery));
  assert.equal(delivery.report.jobId, jobId);

  // DACS-5: the buyer re-derives the session facts itself; the seller only proposes finalisedAt.
  const request = await w.sellerClient.bundleRequest(jobId);
  const session = bundleSession({ agreement, agreementRef: progress.result.agreementRef, commitmentRef: commitment.ref, payment: payment.ref, delivery: delivery.evidenceRef, observed, finalisedAt: request.finalisedAt });
  const signing = await bundleSigningPlan(session);
  assert.equal(signing.bundleHash, request.bundleHash);
  const buyerSignature = w.buyer.signHex(signing.message);
  const { copies, problems } = await assembleBundleCopies(session, { buyer: buyerSignature, seller: request.sellerSignature });
  assert.deepEqual(problems, []);
  const buyerAddress = bundleAddress(jobId, 'buyer');
  await w.anchorClient.write({ logicalAddress: buyerAddress, artifact: copies.buyerCopy, writer: w.buyer.claim, writerSignature: w.buyer.signHex(anchorWriteMessage(buyerAddress, contentHash(copies.buyerCopy))) });
  const sellerSide = await w.sellerClient.countersign(jobId, buyerSignature);
  assert.equal(sellerSide.status, 'seller-copy-anchored');
  const sellerCopy = await verifyAnchoredCopy({ record: await w.anchorClient.read(bundleAddress(jobId, 'seller')), role: 'seller', jobId, writer: w.seller.wallet.claim, expectedHash: signing.bundleHash, ownCopy: copies.buyerCopy });
  assert.equal(sellerCopy.status, 'verified', JSON.stringify(sellerCopy));
  const sellerConfirm = await w.sellerClient.confirmBuyerCopy(jobId);
  assert.equal(sellerConfirm.status, 'verified', JSON.stringify(sellerConfirm));
  assert.equal(PROTOCOL_LIMITS.vet, 'not-performed');
});

test('signature encoding: a base64url signature that begins with "0x" is not read as hex', () => {
  // 0xd3 0x10 encode to base64url "0x…"; the wallet decoder would strip that prefix.
  const value = Buffer.concat([Buffer.from([0xd3, 0x10]), Buffer.alloc(62, 7)]).toString('base64url');
  assert.ok(value.startsWith('0x'));
  assert.equal(canonicalSignature(value), value);
  assert.equal(canonicalSignature(`0x${Buffer.from(value, 'base64url').toString('hex')}`), value, 'hex form decodes to the same bytes');
});

// ---------------- DACS-3: altered terms, job reuse, commitment ----------------

test('price, payee, Listing alteration: the seller re-derives the Agreement and refuses to contribute', async (t) => {
  const w = await world(t);
  const cases = {
    price: (draft) => ({ ...draft, terms: { ...draft.terms, price: { ...draft.terms.price, amount: '0.5' } } }),
    payee: (draft) => ({ ...draft, terms: { ...draft.terms, payoutBindings: [{ ...draft.terms.payoutBindings[0], payeeAddress: w.buyer.address }] } }),
    listing: (draft) => ({ ...draft, listingRef: { ...draft.listingRef, contentHash: 'f'.repeat(64) } }),
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const { progress, jobId } = await agree(w, { tamper });
    assert.equal(progress.disposition, 'rejected', `${name}: ${JSON.stringify(progress)}`);
    assert.equal((await w.anchorClient.read(finalityCommitmentAddress(jobId))).status, 'absent', `${name}: nothing committed`);
  }
});

test('job alteration: a job already bound to one buyer cannot be taken over by another', async (t) => {
  const w = await world(t);
  const first = await agree(w);
  assert.equal(first.progress.disposition, 'anchored');
  const intruder = { ...w, buyer: createEphemeralWallet() };
  const second = await agree(intruder, { jobId: first.jobId });
  assert.equal(second.progress.disposition, 'rejected', JSON.stringify(second.progress));
});

test('commitment: absent before the seller commits, rejected when the anchored record changes', async (t) => {
  const w = await world(t);
  const { jobId, progress } = await agree(w);
  const agreement = progress.result.agreement;
  assert.equal((await readCommitment({ agreement, listing: w.seller.listing, anchors: w.anchorClient })).status, 'absent');
  await w.sellerClient.commit(jobId);
  w.anchors.faults.alter.set(finalityCommitmentAddress(jobId), (record) => ({ ...record, agreementHash: 'e'.repeat(64) }));
  const changed = await readCommitment({ agreement, listing: w.seller.listing, anchors: w.anchorClient });
  assert.equal(changed.status, 'rejected', JSON.stringify(changed));
  w.anchors.faults.unavailable = true;
  assert.equal((await readCommitment({ agreement, listing: w.seller.listing, anchors: w.anchorClient })).status, 'unavailable');
  w.anchors.faults.unavailable = false;
  w.anchors.faults.alter.clear();
  assert.equal((await readCommitment({ agreement, listing: w.seller.listing, anchors: w.anchorClient })).status, 'verified');
});

// ---------------- DACS-4 seller intake ----------------

async function committedJob(w) {
  const { jobId, progress } = await agree(w);
  assert.equal(progress.disposition, 'anchored');
  await w.sellerClient.commit(jobId);
  return { jobId, agreement: progress.result.agreement };
}

test('payment before commitment: refused before commit, and a transfer included before the finalized commitment is rejected', async (t) => {
  const w = await world(t);
  const { jobId, progress } = await agree(w);
  const agreement = progress.result.agreement;
  const { txHash } = await pay(w, agreement);
  await assert.rejects(w.sellerClient.submitPayment({ jobId, txHash, payerPayingKey: w.buyer.claim }), (error) => error instanceof SellerRefusedError && error.code === 'not_committed');
  // The commitment finalizes (substrate clock) after the transfer's block time.
  w.anchors.faults.clock = () => Date.now() + 10 * 60 * 1000;
  await w.sellerClient.commit(jobId);
  const late = await w.sellerClient.submitPayment({ jobId, txHash, payerPayingKey: w.buyer.claim });
  assert.deepEqual(late, { status: 'rejected', reason: 'payment-before-finalized-commitment' });
});

test('replayed transaction across jobs: one transfer counts for one session only (SB-2)', async (t) => {
  const w = await world(t);
  // Several pairs, so both orders of the SDK receipt store's evidence-hash
  // tie-break are exercised; the agent must refuse the replay either way.
  for (let pair = 0; pair < 4; pair += 1) {
    const a = await committedJob(w);
    const b = await committedJob(w);
    const { txHash } = await pay(w, a.agreement);
    assert.equal((await w.sellerClient.submitPayment({ jobId: a.jobId, txHash, payerPayingKey: w.buyer.claim })).status, 'delivered');
    const replay = await w.sellerClient.submitPayment({ jobId: b.jobId, txHash, payerPayingKey: w.buyer.claim });
    assert.equal(replay.status, 'rejected', `pair ${pair}: ${JSON.stringify(replay)}`);
    const terms = agreementTerms(b.agreement);
    assert.equal((await w.anchorClient.read(paymentEvidenceAddress(b.jobId, terms.rail, terms.paymentPhaseIndex))).status, 'absent', 'no evidence for the replayed job');
    assert.equal((await w.sellerClient.submitPayment({ jobId: a.jobId, txHash, payerPayingKey: w.buyer.claim })).status, 'delivered', 'the paying job keeps its payment');
  }
});

test('wrong transfer, failed or uncertain send, unavailable chain: the seller never evidences the payment', async (t) => {
  const w = await world(t);
  const claim = (jobId, txHash) => w.sellerClient.submitPayment({ jobId, txHash, payerPayingKey: w.buyer.claim });
  const underpaid = await committedJob(w);
  const short = await pay(w, underpaid.agreement, { amountOs: '2400000000' });
  assert.deepEqual(await claim(underpaid.jobId, short.txHash), { status: 'rejected', reason: 'payment-amount-mismatch' });
  const elsewhere = await committedJob(w);
  const misdirected = await pay(w, elsewhere.agreement, { to: createEphemeralWallet().address });
  assert.equal((await claim(elsewhere.jobId, misdirected.txHash)).status, 'rejected');
  const failed = await committedJob(w);
  const terms = agreementTerms(failed.agreement);
  const payload = buildNativeTransferPayload({ from: w.buyer.address, to: terms.payee, amountOs: terms.price.amountOs, nonce: w.chain.nonceOf(w.buyer.address) + 1, timestamp: Date.now(), encoding: 'os-string' });
  const failedHash = w.chain.walletBroadcast(payload, { failOnChain: true });
  assert.deepEqual(await claim(failed.jobId, failedHash), { status: 'rejected', reason: 'demos-transfer-failed' });
  const pending = await committedJob(w);
  const pendingTx = await pay(w, pending.agreement);
  w.chain.faults.pendingHashes.add(pendingTx.txHash);
  assert.equal((await claim(pending.jobId, pendingTx.txHash)).status, 'indeterminate');
  w.chain.faults.pendingHashes.clear();
  w.chain.faults.unavailable = true;
  assert.equal((await claim(pending.jobId, pendingTx.txHash)).status, 'indeterminate');
  w.chain.faults.unavailable = false;
  assert.equal((await claim(pending.jobId, pendingTx.txHash)).status, 'delivered', 'the same transaction is accepted once observable');
});

test('unavailable seller: transport faults are indeterminate, never a refusal or an accepted step', async (t) => {
  const w = await world(t);
  w.seller.state.unavailable = true;
  const { progress } = await agree(w);
  assert.equal(progress.disposition, 'indeterminate', JSON.stringify(progress));
  w.seller.state.unavailable = false;
});

// ---------------- DACS-4 buyer verification of the seller's evidence ----------------

// One committed, paid job whose payment evidence the test itself signs (with
// the seller key or another key) and anchors, so each wrong field is isolated.
async function evidenceCase(w, mutate = (e) => e, { signer = w.seller.wallet, phaseIndexOverride } = {}) {
  const { jobId, agreement } = await committedJob(w);
  const { observed } = await pay(w, agreement);
  const terms = agreementTerms(agreement);
  const now = Date.now();
  const evidence = mutate({
    evidenceVersion: '1',
    jobId,
    phase: 'pay-dem',
    outcome: 'success',
    paymentTxRefs: [{ kind: 'demos', txHash: observed.txHash, blockNumber: observed.blockNumber }],
    paymentAmount: { amount: terms.price.amount, currency: 'DEM' },
    settlementFinality: { model: 'bft-final', finalityObservedAt: now },
    observedAt: now,
  });
  const signed = await signComponentArtifact(evidence, ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: signer.claim, sign: (bytes) => signer.signBytes(bytes) });
  const address = paymentEvidenceAddress(jobId, terms.rail, phaseIndexOverride ?? terms.paymentPhaseIndex);
  await w.anchorClient.write({ logicalAddress: address, artifact: signed, writer: w.seller.wallet.claim, writerSignature: w.seller.wallet.signHex(anchorWriteMessage(address, contentHash(signed))) });
  return { agreement, observed, record: await w.anchorClient.read(address) };
}

async function evidenceCases(w) {
  return {
    control: await evidenceCase(w),
    wrongAddress: await evidenceCase(w, (e) => e, { phaseIndexOverride: 3 }),
    wrongPhase: await evidenceCase(w, (e) => ({ ...e, phase: 'pay-x402' })),
    wrongTx: await evidenceCase(w, (e) => ({ ...e, paymentTxRefs: [{ ...e.paymentTxRefs[0], txHash: 'ab'.repeat(32) }] })),
    wrongBlock: await evidenceCase(w, (e) => ({ ...e, paymentTxRefs: [{ ...e.paymentTxRefs[0], blockNumber: e.paymentTxRefs[0].blockNumber + 1 }] })),
    wrongAmount: await evidenceCase(w, (e) => ({ ...e, paymentAmount: { ...e.paymentAmount, amount: '2.4' } })),
    wrongSigner: await evidenceCase(w, (e) => e, { signer: w.buyer }),
  };
}

test('DACS-4 evidence: wrong address, phase, transaction, block, amount or signer is rejected; the exact record verifies', async (t) => {
  const w = await world(t);
  const cases = await evidenceCases(w);
  assert.equal((await verifyPaymentEvidence(cases.control)).status, 'verified');
  for (const name of ['wrongAddress', 'wrongPhase', 'wrongTx', 'wrongBlock', 'wrongAmount', 'wrongSigner']) {
    const verdict = await verifyPaymentEvidence(cases[name]);
    assert.equal(verdict.status, 'rejected', `${name}: ${JSON.stringify(verdict)}`);
  }
  // A tampered signature value on otherwise exact evidence (one decoded byte
  // flipped, so the signature bytes always differ).
  const tampered = structuredClone(cases.control.record);
  const bytes = Buffer.from(tampered.artifact.signature.value, 'base64url');
  bytes[0] ^= 0xff;
  tampered.artifact.signature.value = bytes.toString('base64url');
  assert.equal((await verifyPaymentEvidence({ ...cases.control, record: tampered })).status, 'rejected');
  // Absent evidence is absence, never verification.
  assert.equal((await verifyPaymentEvidence({ ...cases.control, record: { status: 'absent' } })).status, 'absent');
});

// ---------------- DACS-5 copies ----------------

function resign(copy, buyer, seller) {
  const bytes = signedBytes(ARTIFACT_SEPARATORS.FaultAttestationBundle, attestationBundleHash(copy));
  return { ...copy, signatures: [buyer, seller].map((wallet) => ({ party: wallet.claim, algorithm: 'ed25519', value: wallet.signBytes(bytes).toString('base64url') })) };
}

// A delivered job and a seller copy (exact, divergent or changed) the test anchors at the seller address.
async function bundleCase(w, variant) {
  const { jobId, agreement } = await committedJob(w);
  const commitment = await readCommitment({ agreement, listing: w.seller.listing, anchors: w.anchorClient });
  const { txHash, observed } = await pay(w, agreement);
  await w.sellerClient.submitPayment({ jobId, txHash, payerPayingKey: w.buyer.claim });
  const terms = agreementTerms(agreement);
  const payment = await verifyPaymentEvidence({ agreement, record: await w.anchorClient.read(paymentEvidenceAddress(jobId, terms.rail, terms.paymentPhaseIndex)), observed });
  const delivery = await verifyDelivery({ agreement, deliverable: await w.anchorClient.read(deliverableAddress(jobId)), evidenceRecord: await w.anchorClient.read(deliveryEvidenceAddress(jobId)) });
  const request = await w.sellerClient.bundleRequest(jobId);
  const agreementRef = { anchor: { kind: 'storage-program', locator: `dacs3:agreement:${jobId}` }, contentHash: contentHash(agreement) };
  const session = bundleSession({ agreement, agreementRef, commitmentRef: commitment.ref, payment: payment.ref, delivery: delivery.evidenceRef, observed, finalisedAt: request.finalisedAt });
  const plan = await bundleSigningPlan(session);
  const { copies, problems } = await assembleBundleCopies(session, { buyer: w.buyer.signHex(plan.message), seller: request.sellerSignature });
  assert.deepEqual(problems, []);
  let sellerCopy = copies.sellerCopy;
  if (variant === 'divergent') sellerCopy = resign({ ...sellerCopy, phaseSummary: sellerCopy.phaseSummary.map((p) => (p.kind === 'deliver-storage-program' ? { ...p, outcome: 'fail', errorClass: 'counterparty' } : p)) }, w.buyer, w.seller.wallet);
  if (variant === 'changed') sellerCopy = resign({ ...sellerCopy, finalisedAt: sellerCopy.finalisedAt + 1 }, w.buyer, w.seller.wallet);
  const address = bundleAddress(jobId, 'seller');
  await w.anchorClient.write({ logicalAddress: address, artifact: sellerCopy, writer: w.seller.wallet.claim, writerSignature: w.seller.wallet.signHex(anchorWriteMessage(address, contentHash(sellerCopy))) });
  return { record: await w.anchorClient.read(address), role: 'seller', jobId, writer: w.seller.wallet.claim, expectedHash: plan.bundleHash, ownCopy: copies.buyerCopy };
}

async function bundleCases(w) {
  return { good: await bundleCase(w, 'good'), divergent: await bundleCase(w, 'divergent'), changed: await bundleCase(w, 'changed') };
}

test('DACS-5 copies: an exact counterparty copy verifies; divergent or changed copies are rejected', async (t) => {
  const w = await world(t);
  const cases = await bundleCases(w);
  assert.equal((await verifyAnchoredCopy(cases.good)).status, 'verified');
  const divergent = await verifyAnchoredCopy(cases.divergent);
  assert.equal(divergent.status, 'rejected');
  assert.ok(divergent.reasons.includes('copies diverge'), JSON.stringify(divergent));
  const changed = await verifyAnchoredCopy(cases.changed);
  assert.equal(changed.status, 'rejected');
  assert.ok(changed.reasons.some((r) => /different bundle/.test(r)), JSON.stringify(changed));
});

// ---------------- guard witnesses ----------------
// Buyer-verification contract run against the shipped purchase-protocol.mjs
// (no violations) and against disposable copies with one guard removed each
// (the named rule must break). The shipped source is never modified.

const DACS_SRC = new URL('../src/dacs/', import.meta.url);
const PROTOCOL_SOURCE = readFileSync(new URL('purchase-protocol.mjs', DACS_SRC), 'utf8');
const SDK = import.meta.resolve('@kynesyslabs/dacs');

const SDK_TX_BINDING = "      result: { ok: true, txRefs: [{ kind: 'demos', txHash: observed.txHash, blockNumber: observed.blockNumber }] },\n";
const PROTOCOL_MUTANTS = [
  {
    name: 'transaction not bound to the buyer observation',
    edits: [["    if (tx?.txHash?.toLowerCase() !== observed.txHash.toLowerCase()) reasons.push('evidence transaction is not the buyer-observed transfer');\n", ''], [SDK_TX_BINDING, '      result: { ok: true },\n']],
    expect: ['wrong tx refused'],
  },
  {
    name: 'block not bound to the buyer observation',
    edits: [["    if (tx?.blockNumber !== observed.blockNumber) reasons.push('evidence block differs from the buyer-observed block');\n", ''], [SDK_TX_BINDING, "      result: { ok: true, txRefs: [{ kind: 'demos', txHash: observed.txHash, blockNumber: tx?.blockNumber }] },\n"]],
    expect: ['wrong block refused'],
  },
  {
    name: 'amount taken from the evidence instead of the Agreement',
    edits: [
      ["    if (evidence.paymentAmount?.amount !== terms.price.amount || evidence.paymentAmount?.currency !== 'DEM') reasons.push('evidence amount differs from the Agreement price');\n", ''],
      ['      agreement: { amount: terms.price.amount, currency: terms.price.currency },\n      rail: demRailContext(),', '      agreement: { amount: evidence.paymentAmount.amount, currency: evidence.paymentAmount.currency },\n      rail: demRailContext(),'],
    ],
    expect: ['wrong amount refused'],
  },
  {
    name: 'evidence verified where it was found instead of at the canonical SB-1 address',
    edits: [
      ["  if (verifyFixtureRecord(record, { logicalAddress: address, expectedWriter: terms.seller }) !== 'valid') reasons.push('evidence anchor receipt does not verify for the seller at the SB-1 address');\n", ''],
      ['      paymentAddress: { railId: terms.rail, phaseIndex: terms.paymentPhaseIndex },\n', "      paymentAddress: { railId: terms.rail, phaseIndex: Number(record.receipt.logicalAddress.split(':').pop()) },\n"],
      ['      attestationRef: fixtureRef(address, contentHash(evidence)),\n', '      attestationRef: fixtureRef(record.receipt.logicalAddress, contentHash(evidence)),\n'],
    ],
    expect: ['wrong address refused'],
  },
  {
    name: 'evidence signer not bound to the seller (phase orchestrator)',
    edits: [
      ["    if (evidence.signature?.signer !== terms.seller) reasons.push('evidence is not signed by the seller (phase orchestrator)');\n", ''],
      ['      orchestrator: terms.seller,\n      agreement: { amount: terms.price.amount, currency: terms.price.currency },\n      rail: demRailContext(),', '      orchestrator: evidence.signature.signer,\n      agreement: { amount: terms.price.amount, currency: terms.price.currency },\n      rail: demRailContext(),'],
    ],
    expect: ['non-seller signature refused'],
  },
  {
    name: 'counterparty copy accepted without scope and divergence checks',
    edits: [["  if (attestationBundleHash(copy) !== expectedHash) reasons.push(`${role} copy signs a different bundle`);\n  if (ownCopy && bundlesDiverge(ownCopy, copy)) reasons.push('copies diverge');\n", '']],
    expect: ['divergent copy refused', 'changed copy refused'],
  },
];

async function loadProtocolCopy(dir, label, mutant) {
  let text = PROTOCOL_SOURCE;
  for (const [find, replace] of mutant?.edits ?? []) {
    assert.equal(text.split(find).length, 2, `mutation anchor appears exactly once: ${mutant.name}`);
    text = text.replace(find, () => replace);
  }
  text = text
    .replace(/from '(\.\.?\/[^']+)'/g, (_, p) => `from '${new URL(p, DACS_SRC).href}'`)
    .replace("from '@kynesyslabs/dacs'", () => `from '${SDK}'`);
  const file = join(dir, `purchase-protocol-${label}.mjs`);
  writeFileSync(file, text);
  return import(pathToFileURL(file).href);
}

// The buyer-verification contract, independent of the implementation's wording.
async function buyerViolations(mod, evidence, copies) {
  const broken = [];
  const status = async (fn, input) => (await fn(input)).status;
  if (await status(mod.verifyPaymentEvidence, evidence.control) !== 'verified') broken.push('control accepted');
  const refused = { wrongTx: 'wrong tx refused', wrongBlock: 'wrong block refused', wrongAmount: 'wrong amount refused', wrongAddress: 'wrong address refused', wrongPhase: 'wrong phase refused', wrongSigner: 'non-seller signature refused' };
  for (const [name, rule] of Object.entries(refused)) if (await status(mod.verifyPaymentEvidence, evidence[name]) === 'verified') broken.push(rule);
  if (await status(mod.verifyAnchoredCopy, copies.good) !== 'verified') broken.push('good copy accepted');
  if (await status(mod.verifyAnchoredCopy, copies.divergent) === 'verified') broken.push('divergent copy refused');
  if (await status(mod.verifyAnchoredCopy, copies.changed) === 'verified') broken.push('changed copy refused');
  return broken;
}

test('guard witnesses: each removed buyer-verification guard breaks its named rule; the shipped module breaks none', async (t) => {
  const w = await world(t);
  const evidence = await evidenceCases(w);
  const copies = await bundleCases(w);
  const dir = mkdtempSync(join(tmpdir(), 'dacs-protocol-witness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await buyerViolations(shippedProtocol, evidence, copies), [], 'shipped module');
  assert.deepEqual(await buyerViolations(await loadProtocolCopy(dir, 'identity'), evidence, copies), [], 'unmutated copy');
  for (const [index, mutant] of PROTOCOL_MUTANTS.entries()) {
    const broken = await buyerViolations(await loadProtocolCopy(dir, `m${index}`, mutant), evidence, copies);
    for (const rule of mutant.expect) assert.ok(broken.includes(rule), `${mutant.name}: expected "${rule}" broken, got ${JSON.stringify(broken)}`);
    assert.ok(!broken.includes('control accepted') && !broken.includes('good copy accepted'), `${mutant.name} still accepts the exact records`);
  }
});
