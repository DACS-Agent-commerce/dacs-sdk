// A native-profile seller behind the wire handler, run by the real standalone host. The artifact anchor is the shipped one, the delivery
// capability is the shipped devnet capability with its evidence reader on, and the payment evidence goes through the shipped wallet journal.
// Only the network is scripted (native-payment-node.mjs). Nothing prefills a payment: grants, signatures, CREATEs and deliveries are the
// seller's own steps, counted here.
import { mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import { inspectWireOperation, openWireRequestJournal } from '@kynesyslabs/dacs/wire';
import { NOW, testWallet } from './protocol-fixture.mjs';
import { sellerApi as seller } from './seller-internal-api.mjs';
import { anchorFixture, signSdkCreate } from './anchor-isolated-fixture.mjs';
import { scriptedDemosNode } from './native-payment-node.mjs';
import { createSessionAdmissionFixture } from './session-admission-fixture.mjs';
import { mixedAuthentication, wireBuyer } from './wire-buyer.mjs';
import { SELLER_TRANSPORT_HEADER } from '../../src/dacs/seller-transport-auth.mjs';
import { finalizedCommitmentReader } from './finalized-commitment-reader.mjs';
import { createNativeRetrySeam } from './native-retry-seam.mjs';
import { railSteward } from './rail-authority-fixture.mjs';
import { testNetwork, FIXTURE_PROFILE } from './wire-authority-fixture.mjs';
import { createSellerDurableState } from '../../src/dacs/seller-durable-state.mjs';
import { createDemDeliveryContext } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { KIT_TP1_VET_MODE, startSellerHost } from '../../src/host.mjs';
import { createNativePaymentEvidenceConsumer, NATIVE_PAYMENT_EVIDENCE } from '../../src/dacs/native-payment-evidence-consumer.mjs';
import { createDevnetDemoDeliveryCapability } from '../../src/devnet-demo/native-delivery.mjs';
import { createDevnetPurchasedReportProducer } from '../../src/devnet-demo/deliverable.mjs';
import { SELLER_REQUIREMENT } from '../../src/devnet-demo/agreement-context.mjs';

const AUTHORITY = 'TEST-native-payment-wire';
const PAYMENTS_PATH = '/dacs/v1/payments';
const CLIENT_TIMEOUT_MS = 60_000;
const JOURNAL_LEASE_MS = 300_000;
const PRICE_DEM = '2.5';
const clone = (value) => structuredClone(value);
const demToOs = (amount) => { const [whole, fraction = ''] = amount.split('.'); return (BigInt(whole) * 10n ** 9n + BigInt(fraction.padEnd(9, '0'))).toString(); };
const walletOf = (tag) => { const wallet = testWallet(tag); return { ...wallet, sign: wallet.signBytes, signWallet: (message) => `0x${wallet.signBytes(Buffer.from(message)).toString('hex')}` }; };
const identityFor = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'native-payment-wire' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};
const presentChallenge = (party, presentedAt, sessionNonce) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'native-payment-wire' });
  const bundle = { ...unsigned.bundle, sessionNonce }, bundleHash = core.sha256Hex(core.canonicalize(bundle));
  return seller.attachIdentityPresentation({ bundle, bundleHash }, party.signWallet(unsigned.message.replace(unsigned.bundleHash, bundleHash)));
};
let jobSequence = 0;

/**
 * One native seller on its own directories. Returns `purchase()` (a signed, committed Agreement with its payment ready), `claim(p, txHash)`
 * (the buyer's signed payment request), `restart()` and `lapse()` (the open attempt's lease ends), the `faults` that fail the seller's next
 * evidence signature, and what the seller really did: `counts`, `evidenceCreates`, `deliverableWrites`, `deliveryEvidenceWrites`, `work`.
 */
export async function nativePaymentWorld(t) {
  const sellerKey = walletOf(17), buyerKey = walletOf(12);
  let wallClock = NOW, advancedMs = 0;
  // The host's clock is wall time and never behind the node's latest block, which the node stamps two seconds apart.
  let node = null;
  const clock = () => Math.max(wallClock, node?.latestBlockMs() ?? 0);
  node = scriptedDemosNode(clock);
  const advance = (milliseconds) => { wallClock = clock() + milliseconds; advancedMs += milliseconds; };
  const admission = createSessionAdmissionFixture({ seller: sellerKey, buyer: buyerKey, now: clock });
  const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, NOW - 1000), displayName: 'Native payment seller', publicEndpoint: 'https://seller.invalid',
    listingId: 'native-payment-wire', listingVersion: 1, title: 'Native payment report', description: 'A paid report delivered through the wire handler.',
    category: 'services.market-report', tags: ['native'], priceDem: PRICE_DEM, notBefore: NOW - 60000 });
  delete draft.offering.deliverable.schemaUrl;
  const pinOf = (listing) => ({ listingId: listing.listingId, version: listing.listingVersion, contentHash: core.contentHash(listing) });
  const produce = createDevnetPurchasedReportProducer({ producer: sellerKey.claim, produce: () => 'A report bought through the wire handler.' });
  const sample = produce({ agreement: { jobId: '0'.repeat(26), listingRef: pinOf(draft) }, listing: draft, settlementId: `demos:${'0'.repeat(64)}` });
  draft.offering.deliverable.expectedSizeBytes = Buffer.byteLength(core.canonicalize(sample));
  const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft))), pin = seller.listingPin(listing);

  const counts = { evidenceSignatures: 0, walletSignatures: 0, walletBroadcasts: 0 };
  const faults = { evidenceSignature: 0, walletSignature: 0, walletBroadcast: 0 };
  const sellerSigner = { claim: sellerKey.claim, sign: (bytes) => {
    const text = Buffer.from(bytes).toString('utf8');
    if (text.startsWith(core.ARTIFACT_SEPARATORS.SettlementEvidence)) {
      counts.evidenceSignatures++;
      if (faults.evidenceSignature > 0) { faults.evidenceSignature--; throw new Error('TEST the seller signer failed'); }
    }
    return sellerKey.sign(bytes);
  } };

  const buyerBundles = new Map(), inputs = new Map(), agreements = new Map();
  const buyerBundleFor = async (jobId) => {
    if (!buyerBundles.has(jobId)) {
      const challenge = await host.issueSessionChallenge({ jobId, buyer: buyerKey.claim });
      buyerBundles.set(jobId, presentChallenge(buyerKey, NOW, challenge.sessionNonce));
    }
    return buyerBundles.get(jobId);
  };
  const vettedInput = async (jobId) => {
    if (!inputs.has(jobId)) {
      const buyerBundle = await buyerBundleFor(jobId), input = seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: clock() });
      inputs.set(jobId, { ...input, buyer: { ...input.buyer, vetRecordRef: await admission.vetRecord(jobId, buyerKey.claim, buyerBundle, { requirement: listing.buyerRequirement }) },
        seller: { identityBundle: listing.seller.identity, vetRecordRef: await admission.vetRecord(jobId, sellerKey.claim, listing.seller.identity, { requirement: SELLER_REQUIREMENT, verifier: sellerKey }) } });
    }
    return clone(inputs.get(jobId));
  };
  const agreementAnchor = { source: 'TEST-native-payment-wire/agreement',
    readAgreement: async ({ logicalAddress }) => (agreements.has(logicalAddress)
      ? { disposition: 'present', artifact: clone(agreements.get(logicalAddress)), ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: core.contentHash(agreements.get(logicalAddress)) },
        native: { source: 'TEST-native-payment-wire/agreement', evidenceMode: 'TEST-scripted', nativeAddress: 'TEST-native-agreement', txRef: { kind: 'demos', txHash: 'c3'.repeat(32), blockNumber: 1 } } }
      : { disposition: 'absent', reason: 'TEST not anchored' }) };

  // The shipped artifact anchor over the scripted node: the wallet signs the CREATE as the SDK does, and the node applies what it is sent.
  const finalized = finalizedCommitmentReader(node.reader, sellerKey, { substrate: 'demos' });
  const anchors = await anchorFixture({ writer: { claim: sellerKey.claim, sign: sellerKey.sign }, now: clock,
    artifactKinds: ['FinalityCommitmentRecord', 'CompositeVerificationRecord', 'Deliverable', 'SettlementEvidence'] });
  const readerFor = (kind) => (kind === 'FinalityCommitmentRecord' ? finalized : node.reader);
  anchors.controls.reader = { read: (address, options) => readerFor(options?.expectedArtifactKind).read(address, options),
    verifyReceipt: (input) => readerFor(input.artifactKind).verifyReceipt(input) };
  anchors.source.readRpc = async () => ({ result: 200, response: node.accountNonce(sellerKey.address), require_reply: false, extra: null });
  anchors.source.binding = async ({ hash }) => ({ disposition: node.hasTransaction(hash) ? 'included' : 'absent' });
  anchors.source.observeBinding = async () => anchors.source.transportBinding;
  anchors.controls.request = async ({ transaction }) => {
    const signed = await signSdkCreate(transaction, { writer: sellerKey });
    await anchors.sourceJournal.put(`source/${signed.hash}`, { stage: 'observed', hash: signed.hash, signedTransaction: signed });
    node.apply(signed);
    const { metadata, data } = signed.content.data[1];
    if (metadata.artifactKind === 'FinalityCommitmentRecord') {
      const included = node.inclusion(signed.hash);
      finalized.record({ logicalAddress: metadata.logicalAddress, artifact: data, signedProjection: signed,
        blockRef: { id: core.sha256Hex(`TEST-finalized-block:${included.blockNumber}`), height: String(included.blockNumber), timestamp: included.includedAt } });
    }
    return { success: true, data: { hash: signed.hash, writeProof: { disposition: 'included' } } };
  };
  let artifactAnchor = anchors.open();

  const walletDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-payment-wallet-')));
  const openWallet = () => seller.createPaymentEvidenceWalletJournal({ path: join(walletDirectory, 'wallet-journal.sqlite'),
    signCreate: async ({ logicalAddress, artifact, artifactKind }) => {
      // A wallet that fails before it signs: nothing is signed and nothing is sent.
      if (faults.walletSignature > 0) { faults.walletSignature--; throw new Error('TEST wallet failed before signing'); }
      counts.walletSignatures++;
      const signed = node.create(sellerKey, { logicalAddress, artifact, artifactKind }, { land: false });
      return { signedTransaction: JSON.stringify(signed), txHash: signed.hash, nonce: signed.content.nonce };
    },
    readAccountNonce: async () => ({ nonce: node.accountNonce(sellerKey.address), blockHeight: node.blockHeight() }),
    readTransactionState: async ({ txHash }) => ({ state: node.transactionState(txHash), checkedThroughBlock: node.blockHeight() }),
    broadcast: async ({ signedTransaction, txHash }) => {
      counts.walletBroadcasts++;
      // A broadcast that fails before the node receives anything: the signed CREATE stays in the wallet journal.
      if (faults.walletBroadcast > 0) { faults.walletBroadcast--; throw new Error('TEST wallet broadcast failed'); }
      if (JSON.parse(signedTransaction).hash === txHash) node.rebroadcast(txHash);
    } });
  let wallet = openWallet();
  const demDeliveryContext = createDemDeliveryContext({ authority: AUTHORITY, vetMode: KIT_TP1_VET_MODE,
    resolveBuyer: async () => { throw new Error('TEST the buyer resolver is not the seller\'s'); },
    resolveSeller: async ({ jobId }) => {
      const input = await vettedInput(jobId);
      const invocation = (party, claim, verifier) => ({ vetRecordRef: input[party].vetRecordRef, evaluatedParty: claim, requirement: clone(party === 'buyer' ? listing.buyerRequirement : SELLER_REQUIREMENT),
        verifier, freshness: [], dealSpecific: [] });
      return { disposition: 'present', value: { input, vetRequirements: [invocation('buyer', buyerKey.claim, sellerKey.claim), invocation('seller', sellerKey.claim, sellerKey.claim)] } };
    } });
  const readCommitmentReceipt = Object.assign(async (commitment) => artifactAnchor.verifyReceipt({
    logicalAddress: commitment.anchorReceipt.logicalAddress, artifact: commitment.record, artifactKind: 'FinalityCommitmentRecord', receipt: commitment.anchorReceipt,
    signedProjection: await artifactAnchor.retainedSignedCreate({ logicalAddress: commitment.anchorReceipt.logicalAddress, artifactKind: 'FinalityCommitmentRecord' }) }), { chainIdentity: FIXTURE_PROFILE.chainIdentity });
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-payment-seller-')));
  const rails = { authority: railSteward().railAuthority() };
  const hosts = [];
  t.after(async () => { try { for (const running of hosts) await running.close(); } finally { wallet.close(); rmSync(dataDirectory, { recursive: true, force: true }); rmSync(walletDirectory, { recursive: true, force: true }); } });
  const capabilities = () => ({ readCommitmentReceipt, signer: sellerSigner, listing, buyerAccess: seller.createOperatorBuyerAccess({ buyerForJob: (jobId) => (buyerBundles.has(jobId) ? buyerKey.address : null), openBuyerAccess: true }),
    agreementAnchor, deliverableProducer: produce, deliveryEvidenceEnabled: true,
    nativePaymentEvidence: createNativePaymentEvidenceConsumer({ rpcUrl: node.rpcUrl, fetchImpl: node.fetchImpl, anchorEvidence: wallet.anchorEvidence, now: clock }),
    reconcilePaymentEvidence: wallet.reconcilePaymentEvidence, demDeliveryContext,
    nativeDemDelivery: createDevnetDemoDeliveryCapability({ authority: AUTHORITY, anchor: { ...artifactAnchor, authority: AUTHORITY }, deliveryEvidenceEnabled: true }),
    railAuthority: rails.authority, sessionAdmission: admission.sessionAdmission, tp1Network: testNetwork(), now: clock, artifactAnchor, dataDirectory });
  const start = async () => { const running = await startSellerHost(capabilities()); hosts.push(running); return running; };
  let host = await start();
  // The commitment the buyer attaches to a request: the seller's CREATE as the node and its finality reader show it.
  const evidenceFor = async (path, jobId) => {
    if (!['/dacs/v1/payments', '/dacs/v1/bundles/request', '/dacs/v1/bundles/countersignature', '/dacs/v1/bundles/buyer-copy'].includes(path)) return {};
    const logicalAddress = `dacs3:commit:${jobId}`;
    const signed = await artifactAnchor.retainedSignedCreate({ logicalAddress, artifactKind: 'FinalityCommitmentRecord' });
    const row = await finalized.read(logicalAddress, { expectedWriter: sellerKey.claim, expectedArtifactKind: 'FinalityCommitmentRecord', signedProjection: signed });
    const anchorTxRef = { kind: 'demos', txHash: signed.hash, blockNumber: node.inclusion(signed.hash).blockNumber };
    return { commitment: Buffer.from(JSON.stringify({ record: row.artifact, nativeAddress: row.receipt.nativeAddress, anchorTxRef, anchorReceipt: row.receipt })),
      agreement: Buffer.from(JSON.stringify(agreements.get(core.fixedPriceAgreementLogicalAddress(jobId)))), signedListing: Buffer.from(JSON.stringify(listing)) };
  };
  const openLeaseUntil = () => {
    const directory = join(dataDirectory, 'wire-journal');
    if (!existsSync(directory)) return null;
    const names = readdirSync(directory);
    const leases = names.filter((name) => /^o-[0-9a-f]+-\d+$/.test(name) && !names.includes(`${name}.end`)).map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')).leaseUntil);
    return leases.length === 0 ? null : Math.max(...leases);
  };
  const retrySeam = createNativeRetrySeam({ wallNow: clock, monotonicNow: () => advancedMs, advance, leaseUntil: openLeaseUntil, mode: 'wire', establishCut: async () => {} });
  const purchase = async () => {
    const jobId = `01J8N4YV7YVYQ4DB7M8T${String(++jobSequence).padStart(6, '0')}`;
    const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(await vettedInput(jobId)));
    const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
    const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
    const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
    const client = () => seller.createSellerAgentClient({ url: host.url, timeoutMs: CLIENT_TIMEOUT_MS, authentication: mixedAuthentication(
      { buyer: buyerKey, seller: sellerKey, listingPin: pin, clock, evidenceFor, readCommitmentReceipt, publicEndpoint: listing.seller.publicEndpoint }, () => plan.agreementHash, seller.createSellerTransportClientAuth({
        buyerSigner: { claim: buyerKey.claim, sign: buyerKey.sign }, seller: sellerKey.claim, resolveJob: () => ({ listingPin: pin, agreementHash: plan.agreementHash }), now: clock })) });
    const answer = await client().propose({ proposal, transportIdentity, buyerIdentityBundle: await buyerBundleFor(jobId) });
    assert.equal(answer.disposition, 'complete', `the seller signs the vetted Agreement: ${JSON.stringify(answer)}`);
    const agreement = await core.finalizeFixedPriceAgreementContributions(plan, [buyerContribution, answer.contribution], seller.contributionVerifier);
    agreements.set(core.fixedPriceAgreementLogicalAddress(jobId), agreement);
    assert.equal((await client().commit(jobId)).status, 'committed');
    const payout = agreement.terms.payoutBindings[0], amountOs = demToOs(agreement.terms.price.amount);
    // The same signed request without the client library, so a test sees the status and the body the seller signed.
    const send = async (txHash) => {
      retrySeam.beforeRetry();
      const body = { jobId, txHash, payerPayingKey: buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE }, text = JSON.stringify(body);
      const buyerWire = await wireBuyer({ buyer: buyerKey, seller: sellerKey, listingPin: pin, clock, evidenceFor, readCommitmentReceipt, publicEndpoint: listing.seller.publicEndpoint });
      const { header } = await buyerWire.signRequest(PAYMENTS_PATH, body, { jobId, agreementHash: plan.agreementHash, text });
      const response = await fetch(`${host.url}${PAYMENTS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', [SELLER_TRANSPORT_HEADER]: header }, body: text });
      const answerText = await response.text();
      return { status: response.status, text: answerText, body: JSON.parse(answerText) };
    };
    return { jobId, agreement, agreementHash: plan.agreementHash, payout, amountOs, send,
      pay: () => node.pay({ from: buyerKey.address, to: payout.payeeAddress, amountOs }),
      claim: async (txHash) => { retrySeam.beforeRetry(); try { return await client().submitPayment({ jobId, txHash, payerPayingKey: buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE }); }
        catch (error) { return { error: error.code, status: error.status, causeCode: error.causeCode }; } } };
  };
  // A restart closes the host and reopens the wallet journal and the artifact anchor over the same stores, as a new process would.
  const restart = async () => {
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    wallet.close();
    wallet = openWallet();
    artifactAnchor = anchors.open();
    host = await start();
  };
  // The seller's durable state with the host stopped, then the host started again over it.
  const inDurableState = async (work) => {
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    const state = await createSellerDurableState({ dir: join(dataDirectory, 'seller'), signer: sellerSigner, listingPin: pin });
    try { return await work(state); } finally { state.close(); host = await start(); }
  };
  const createsAt = (logicalAddress) => node.applied.filter((entry) => entry.logicalAddress === logicalAddress).length;
  const receiptsFile = join(dataDirectory, 'seller', 'sdk-receipts', 'seller-receipts.json');
  return { node, anchors, artifactAnchor, purchase, restart, faults, counts, dataDirectory, listing, sellerKey, buyerKey, advance, host: () => host, beforeRetry: retrySeam.beforeRetry,
    sessionOf: (p) => inDurableState((state) => state.withJob(p.jobId, (session) => clone(session))),
    work: (p) => inDurableState((state) => state.withJob(p.jobId, (session) => clone(session.nativeEvidenceWork))),
    /** Another job takes the transfer's settlement, so this job loses its settlement credit. */
    withdrawCredit: (p, otherJobId) => inDurableState((state) => state.withJob(p.jobId, (session) => {
      const { settlementId } = session.nativeEvidenceWork.intake;
      return state.withJob(otherJobId, () => state.bindSettlement(settlementId, otherJobId, { jobId: otherJobId, phaseIndex: 2 }));
    })),
    receiptsFile,
    wireState: (p) => { const journal = openWireRequestJournal(join(dataDirectory, 'wire-journal'), { leaseMs: JOURNAL_LEASE_MS, clock }); return inspectWireOperation(journal, { seller: sellerKey.claim, jobId: p.jobId, path: PAYMENTS_PATH }); },
    evidenceCreates: (p) => createsAt(core.paymentEvidenceAddress(p.jobId, p.payout.railId, p.payout.phaseIndex)),
    deliverableWrites: (p) => createsAt(`dacs4:deliverable:${p.jobId}`), deliveryEvidenceWrites: (p) => createsAt(`dacs4:evidence:${p.jobId}`) };
}
