// A native-profile seller behind the wire handler, run by the real standalone host. The artifact anchor is the shipped one, the delivery
// capability is the shipped devnet capability with its evidence reader on, and the payment evidence goes through the shipped wallet journal.
// The Demos node is scripted (native-payment-node.mjs). Test stand-ins besides the node: the Agreement readback (an in-memory map, so an
// Agreement is served without an Agreement transaction on the node), the finality reader and its test finality oracle for the commitment
// record, the anchor's source and request functions, session admission and the vet records, the buyer's context answer and the vet input
// the delivery context resolves, and the rail authority. Nothing prefills a payment: grants, signatures, CREATEs and deliveries are the seller's own steps, counted here.
import { mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import DatabaseSync from 'better-sqlite3';
import * as core from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, inspectWireOperation, openWireRequestJournal } from '@kynesyslabs/dacs/wire';
import { testWallet } from './protocol-fixture.mjs';
import { T0 } from './reservation-accounting-fixture.mjs';
import { sellerApi as seller } from './seller-internal-api.mjs';
import { anchorFixture, signSdkCreate } from './anchor-isolated-fixture.mjs';
import { scriptedDemosNode } from './native-payment-node.mjs';
import { createSessionAdmissionFixture } from './session-admission-fixture.mjs';
import { presentContextAnswer } from './host-context-callbacks.mjs';
import { hostBuyer } from './host-context-client.mjs';
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
const DELEGATION_MS = 21_600_000;
const SESSION_NOT_BEFORE_SKEW_MS = 30_000;
const PRICE_DEM = '2.5';
const ACCOUNTING_TABLES = ['peer_effects', 'peer_nonces', 'peer_slots', 'kit_reservations'];
/** The world's clock starts here; a session delegation lasts `DELEGATION_MS` from it, and the Agreement deadline is later still. */
export { T0, DELEGATION_MS };
const clone = (value) => structuredClone(value);
const demToOs = (amount) => { const [whole, fraction = ''] = amount.split('.'); return (BigInt(whole) * 10n ** 9n + BigInt(fraction.padEnd(9, '0'))).toString(); };
const walletOf = (tag) => { const wallet = testWallet(tag); return { ...wallet, sign: wallet.signBytes, signWallet: (message) => `0x${wallet.signBytes(Buffer.from(message)).toString('hex')}` }; };
const identityFor = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'native-payment-wire' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};
let jobSequence = 0;

/**
 * One native seller on its own directories, with its clock at `T0` and the host's own 300000 ms journal lease. `advance(ms)` moves the clock
 * (and what `performance.now` reads, which the wire times its admissions with). Unless a request opts out, it first moves the clock to the end of
 * the open attempt's lease.
 *
 * `purchase()` returns a signed, committed Agreement with its payment ready: `p.pay()` makes the buyer's transfer; `p.claim(txHash)` sends the
 * payment request through the client library; `p.sign(txHash, options)` signs one request and `p.post(signed)` sends exactly those bytes, so
 * the same signed request can go twice; `p.send(txHash, options)` does both. `restart()` closes and reopens the seller over the same stores.
 *
 * `faults.walletSignature`, `faults.walletBroadcast` and `faults.responseSignature` each fail that many next steps
 * (the wallet faults fail before the step, so nothing is signed or sent). `hold(point)` stops the seller after that step until `release()`.
 *
 * What the seller really did: `counts` (evidence, wallet, broadcast and response signatures, plus `resends` of an accepted CREATE the node
 * does not show yet and the `rpcSignatures` that authenticated each resend), `evidenceCreates`, `deliverableWrites`,
 * `deliveryEvidenceWrites`, `work`, `wireState`, `steps` (each node read and wallet step in order, with the jobs whose durable lock
 * was held), `transferReads()`, `lockedJobs()`, `grantedReceipts()`, `leaseUntil()` and `snapshot(p)`, which holds what a repeated request must
 * leave as it was.
 *
 * A world for a real process kill takes `directories` (`{ data, wallet }`, real paths made by the caller, who removes them) and
 * `onEvent(name, detail)`, which the world calls as the seller reaches each step: `workSaved` (the work is saved and the wallet is asked to
 * sign), `walletSigned` (the wallet signed a CREATE, with the `bytesHash` of its exact bytes), `evidenceSigned` (the signed CREATE is kept and its
 * broadcast starts) and `write` (the node applied a CREATE, with its `address` and, for a broadcast, the `bytesHash` of the exact bytes it
 * received). A process that starts over directories an earlier process used passes `retained`, the `retain()` of that process: the node's
 * records, the artifact anchor's journals, the finality and Vet records and the Agreements, which the new process rebuilds its sources from.
 * `purchase({ resume: jobId })` returns the handle of a purchase that process made.
 */
export async function nativePaymentWorld(t, { directories = null, retained = null, onEvent = () => {} } = {}) {
  const sellerKey = walletOf(17), buyerKey = walletOf(12);
  const sessionKey = walletOf(3);
  let wallClock = T0, advancedMs = 0;
  // The host's clock is wall time and never behind the node's latest block, which the node stamps two seconds apart.
  let node = null;
  const clock = () => Math.max(wallClock, node?.latestBlockMs() ?? 0);
  node = scriptedDemosNode(clock, { onApply: (entry, bytes) => onEvent('write', { address: entry.logicalAddress, ...(bytes === null ? {} : { bytesHash: core.sha256Hex(bytes) }) }) });
  const advance = (milliseconds) => { wallClock = clock() + milliseconds; advancedMs += milliseconds; };
  // The wire times an admission with `performance.now`, which moves forward with the world's clock.
  const monotonicNow = performance.now.bind(performance);
  mock.method(performance, 'now', () => monotonicNow() + advancedMs);
  t.after(() => mock.restoreAll());
  const admission = createSessionAdmissionFixture({ seller: sellerKey, buyer: buyerKey, now: clock });
  const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, T0 - 1000), displayName: 'Native payment seller', publicEndpoint: 'https://seller.invalid',
    listingId: 'native-payment-wire', listingVersion: 1, title: 'Native payment report', description: 'A paid report delivered through the wire handler.',
    category: 'services.market-report', tags: ['native'], priceDem: PRICE_DEM, notBefore: T0 - 60000, deadlineSecAfterCommit: DELEGATION_MS / 1000 + 1 });
  delete draft.offering.deliverable.schemaUrl;
  const pinOf = (listing) => ({ listingId: listing.listingId, version: listing.listingVersion, contentHash: core.contentHash(listing) });
  const produce = createDevnetPurchasedReportProducer({ producer: sellerKey.claim, produce: () => 'A report bought through the wire handler.' });
  const sample = produce({ agreement: { jobId: '0'.repeat(26), listingRef: pinOf(draft) }, listing: draft, settlementId: `demos:${'0'.repeat(64)}` });
  draft.offering.deliverable.expectedSizeBytes = Buffer.byteLength(core.canonicalize(sample));
  const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft))), pin = seller.listingPin(listing);

  const counts = { evidenceSignatures: 0, walletSignatures: 0, walletBroadcasts: 0, responseSignatures: 0, resends: 0, rpcSignatures: 0 };
  const faults = { walletSignature: 0, walletBroadcast: 0, responseSignature: 0 };
  // `hold(point)` stops the next step at that point once the step has happened and counted, until the test calls `release()`. It returns
  // `reached`, which settles when the seller is stopped there. The points are `responseSignature`, `walletSignature` and `walletBroadcast`.
  const holds = new Map();
  const hold = (point) => {
    const held = {};
    held.reached = new Promise((resolve) => { held.reach = resolve; });
    held.released = new Promise((resolve) => { held.release = resolve; });
    holds.set(point, held);
    return { reached: held.reached, release: held.release };
  };
  const holdHere = async (point) => {
    const held = holds.get(point);
    if (!held) return;
    holds.delete(point);
    held.reach();
    await held.released;
  };
  const sellerSigner = { claim: sellerKey.claim, sign: (bytes) => {
    const text = Buffer.from(bytes).toString('utf8');
    if (text.startsWith(core.ARTIFACT_SEPARATORS.SettlementEvidence)) {
      counts.evidenceSignatures++;
    }
    if (text.startsWith(DACS_SELLER_HTTP_DOMAINS.response)) {
      // The wire awaits its signer, so a response signature may wait for the test.
      if (faults.responseSignature > 0) { faults.responseSignature--; throw new Error('TEST the response signer failed'); }
      counts.responseSignatures++;
      return holds.has('responseSignature') ? holdHere('responseSignature').then(() => sellerKey.sign(bytes)) : sellerKey.sign(bytes);
    }
    return sellerKey.sign(bytes);
  } };

  const buyerBundles = new Map(), inputs = new Map(), agreements = new Map();
  // The buyer asks the host's challenge route for the job's challenge and presents it on the context route, which admits the session.
  const buyerBundleFor = async (jobId) => {
    if (!buyerBundles.has(jobId)) {
      buyerBundles.set(jobId, await (await hostBuyer(host, listing, { jobId, buyer: buyerKey, seller: sellerKey, clock })).admit(jobId));
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
  // A test stand-in: Agreements are read back from `agreements`, not from the node, and carry a made-up transaction reference.
  const agreementAnchor = { source: 'TEST-native-payment-wire/agreement',
    readAgreement: async ({ logicalAddress }) => (agreements.has(logicalAddress)
      ? { disposition: 'present', artifact: clone(agreements.get(logicalAddress)), ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: core.contentHash(agreements.get(logicalAddress)) },
        native: { source: 'TEST-native-payment-wire/agreement', evidenceMode: 'TEST-scripted', nativeAddress: 'TEST-native-agreement', txRef: { kind: 'demos', txHash: 'c3'.repeat(32), blockNumber: 1 } } }
      : { disposition: 'absent', reason: 'TEST not anchored' }) };

  // The shipped artifact anchor over the scripted node, with its source, binding, request and reader functions replaced by test ones. The
  // commitment record's finality comes from the test finality reader, which the test records into when the node applies its CREATE.
  // The evidence and Deliverable CREATEs go through the shipped wallet journal below; the node applies its own copy of what the wallet signed.
  const finalized = finalizedCommitmentReader(node.reader, sellerKey, { substrate: 'demos' });
  const anchors = await anchorFixture({ writer: { claim: sellerKey.claim, sign: sellerKey.sign }, now: clock,
    artifactKinds: ['FinalityCommitmentRecord', 'CompositeVerificationRecord', 'Deliverable', 'SettlementEvidence'],
    signRpc: async () => { counts.rpcSignatures++; return 'TEST rpc authentication'; } });
  // The one resend of an accepted CREATE the node does not show yet: the stored bytes go to the node again, which keeps them once per nonce.
  anchors.source.recoverStorageWrite = async ({ signedTransaction, signRpc }) => {
    await signRpc();
    counts.resends++;
    node.receive(JSON.stringify(signedTransaction));
  };
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
  const anchorJournals = [anchors.journal, anchors.sourceJournal];
  if (retained !== null) {
    node.restore(retained.node);
    finalized.restore(retained.finalized);
    admission.restore(retained.admission);
    retained.journals.forEach((rows, index) => { for (const [key, value] of rows) anchorJournals[index].rows.set(key, value); });
    for (const [name, records] of [['agreements', agreements], ['inputs', inputs], ['buyerBundles', buyerBundles]]) for (const [key, value] of retained[name]) records.set(key, value);
  }
  let artifactAnchor = anchors.open();

  // What the seller did around the wallet and the node, in order, each with the jobs whose durable lock was held at that moment.
  const steps = [];
  node.script.onRead = ({ message, hash }) => steps.push({ step: message, hash, locks: lockedJobs() });
  const walletDirectory = directories?.wallet ?? realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-payment-wallet-')));
  const openWallet = () => seller.createPaymentEvidenceWalletJournal({ path: join(walletDirectory, 'wallet-journal.sqlite'),
    signCreate: async ({ logicalAddress, artifact, artifactKind }) => {
      onEvent('workSaved');
      // A wallet that fails before it signs: nothing is signed and nothing is sent.
      if (faults.walletSignature > 0) { faults.walletSignature--; throw new Error('TEST wallet failed before signing'); }
      counts.walletSignatures++;
      const signed = node.create(sellerKey, { logicalAddress, artifact, artifactKind }), signedTransaction = JSON.stringify(signed);
      onEvent('walletSigned', { bytesHash: core.sha256Hex(signedTransaction) });
      await holdHere('walletSignature');
      return { signedTransaction, txHash: signed.hash, nonce: signed.content.nonce };
    },
    readAccountNonce: async () => ({ nonce: node.accountNonce(sellerKey.address), blockHeight: node.blockHeight() }),
    readTransactionState: async ({ txHash }) => { steps.push({ step: 'walletRead', locks: lockedJobs() }); return { state: node.transactionState(txHash), checkedThroughBlock: node.blockHeight() }; },
    broadcast: async ({ signedTransaction, txHash }) => {
      steps.push({ step: 'walletBroadcast', locks: lockedJobs() });
      counts.walletBroadcasts++;
      onEvent('evidenceSigned');
      // A broadcast that fails before the node receives anything: the signed CREATE stays in the wallet journal.
      if (faults.walletBroadcast > 0) { faults.walletBroadcast--; throw new Error('TEST wallet broadcast failed'); }
      if (JSON.parse(signedTransaction).hash === txHash) node.receive(signedTransaction);
      await holdHere('walletBroadcast');
    } });
  let wallet = openWallet();
  const demDeliveryContext = createDemDeliveryContext({ authority: AUTHORITY, vetMode: KIT_TP1_VET_MODE,
    resolveBuyer: async (input) => presentContextAnswer(input),
    recoverBuyer: async () => null, resumableBuyer: async () => null, bindRetainedScope: () => ({ sellerBundlePresentedBy: sellerKey.claim }),
    resolveSeller: async ({ jobId }) => {
      const input = await vettedInput(jobId);
      const invocation = (party, claim, verifier) => ({ vetRecordRef: input[party].vetRecordRef, evaluatedParty: claim, requirement: clone(party === 'buyer' ? listing.buyerRequirement : SELLER_REQUIREMENT),
        verifier, freshness: [], dealSpecific: [] });
      return { disposition: 'present', value: { input, vetRequirements: [invocation('buyer', buyerKey.claim, sellerKey.claim), invocation('seller', sellerKey.claim, sellerKey.claim)] } };
    } });
  const readCommitmentReceipt = Object.assign(async (commitment) => artifactAnchor.verifyReceipt({
    logicalAddress: commitment.anchorReceipt.logicalAddress, artifact: commitment.record, artifactKind: 'FinalityCommitmentRecord', receipt: commitment.anchorReceipt,
    signedProjection: await artifactAnchor.retainedSignedCreate({ logicalAddress: commitment.anchorReceipt.logicalAddress, artifactKind: 'FinalityCommitmentRecord' }) }), { chainIdentity: FIXTURE_PROFILE.chainIdentity });
  const dataDirectory = directories?.data ?? realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-payment-seller-')));
  // Reads one of the host's SQLite stores while it runs. A store that does not exist yet reads as `empty`.
  const readStore = (file, empty, read) => {
    const path = join(dataDirectory, file);
    if (!existsSync(path)) return empty;
    const db = new DatabaseSync(path, { readonly: true });
    try { return read(db); } finally { db.close(); }
  };
  const lockedJobs = () => readStore(join('seller', 'seller-state.sqlite'), [], (db) => db.prepare('SELECT job FROM seller_locks ORDER BY job').all().map((row) => row.job));
  const rails = { authority: railSteward().railAuthority() };
  const hosts = [];
  t.after(async () => {
    try { for (const running of hosts) await running.close(); } finally {
      wallet.close();
      if (directories === null) { rmSync(dataDirectory, { recursive: true, force: true }); rmSync(walletDirectory, { recursive: true, force: true }); }
    }
  });
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
  const delegationFor = (jobId, profile) => {
    const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyerKey.claim, seller: sellerKey.claim, sessionPublicKey: sessionKey.claim.replace(/^did:demos:agent:/, ''), listingPin: pin, jobId,
      notBefore: T0 - SESSION_NOT_BEFORE_SKEW_MS, expiresAt: T0 + DELEGATION_MS, profile };
    return { payload, signature: buyerKey.sign(Buffer.from(DACS_SELLER_HTTP_DOMAINS.delegation + core.canonicalize(payload))).toString('base64url') };
  };
  const purchase = async ({ resume = null } = {}) => {
    const jobId = resume ?? `01J8N4YV7YVYQ4DB7M8T${String(++jobSequence).padStart(6, '0')}`;
    const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(await vettedInput(jobId)));
    const client = () => seller.createSellerAgentClient({ url: host.url, timeoutMs: CLIENT_TIMEOUT_MS, authentication: mixedAuthentication(
      { buyer: buyerKey, seller: sellerKey, listingPin: pin, clock, evidenceFor, readCommitmentReceipt, publicEndpoint: listing.seller.publicEndpoint }, () => plan.agreementHash, seller.createSellerTransportClientAuth({
        buyerSigner: { claim: buyerKey.claim, sign: buyerKey.sign }, seller: sellerKey.claim, resolveJob: () => ({ listingPin: pin, agreementHash: plan.agreementHash }), now: clock })) });
    if (resume === null) {
      const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
      const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
      const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
      const answer = await client().propose({ proposal, transportIdentity, buyerIdentityBundle: await buyerBundleFor(jobId) });
      assert.equal(answer.disposition, 'complete', `the seller signs the vetted Agreement: ${JSON.stringify(answer)}`);
      agreements.set(core.fixedPriceAgreementLogicalAddress(jobId), await core.finalizeFixedPriceAgreementContributions(plan, [buyerContribution, answer.contribution], seller.contributionVerifier));
      assert.equal((await client().commit(jobId)).status, 'committed');
    }
    const agreement = agreements.get(core.fixedPriceAgreementLogicalAddress(jobId));
    const payout = agreement.terms.payoutBindings[0], amountOs = demToOs(agreement.terms.price.amount);
    // A signed payment request without the client library. By default the open attempt's lease ends first, as for a retry; `lapse: false` keeps
    // it live. `delegated` signs with a session key the buyer delegated for `DELEGATION_MS` from the start of the clock.
    const sign = async (txHash, { lapse = true, delegated = false } = {}) => {
      if (lapse) retrySeam.beforeRetry();
      const body = { jobId, txHash, payerPayingKey: buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE }, text = JSON.stringify(body);
      const buyerWire = await wireBuyer({ buyer: buyerKey, seller: sellerKey, listingPin: pin, clock, evidenceFor, readCommitmentReceipt, publicEndpoint: listing.seller.publicEndpoint });
      const delegation = delegated ? delegationFor(jobId, buyerWire.binding.profile) : null;
      const { header } = await buyerWire.signRequest(PAYMENTS_PATH, body, { jobId, agreementHash: plan.agreementHash, text, delegation, signer: delegated ? sessionKey : buyerKey });
      return { header, text, delegation };
    };
    // Sends the exact bytes of a signed request, as often as it is called, and returns the status and the body the seller signed.
    const post = async ({ header, text }) => {
      steps.push({ step: 'request' });
      const response = await fetch(`${host.url}${PAYMENTS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', [SELLER_TRANSPORT_HEADER]: header }, body: text });
      const answerText = await response.text();
      return { status: response.status, text: answerText, body: JSON.parse(answerText) };
    };
    return { jobId, agreement, agreementHash: plan.agreementHash, payout, amountOs, sign, post, send: async (txHash, options) => post(await sign(txHash, options)),
      pay: () => node.pay({ from: buyerKey.address, to: payout.payeeAddress, amountOs }),
      claim: async (txHash) => { retrySeam.beforeRetry(); steps.push({ step: 'request' }); try { return await client().submitPayment({ jobId, txHash, payerPayingKey: buyerKey.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE }); }
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
  const grantedReceipts = () => (existsSync(receiptsFile) ? Object.keys(JSON.parse(readFileSync(receiptsFile, 'utf8')).records).length : 0);
  const journalHash = () => {
    const directory = join(dataDirectory, 'wire-journal');
    return core.sha256Hex(readdirSync(directory).sort().map((name) => `${name}:${readFileSync(join(directory, name), 'utf8')}`).join('\n'));
  };
  // Everything a repeated request must leave as it was: the receipts granted, the wire journal's bytes, the transactions the node holds for
  // the job's three artifacts, the transport store's accounting rows, job holds and releases, and the job's allocation id, state and revision.
  const snapshot = (p) => ({ receipts: grantedReceipts(), journal: journalHash(),
    sources: [core.paymentEvidenceAddress(p.jobId, p.payout.railId, p.payout.phaseIndex), `dacs4:deliverable:${p.jobId}`, `dacs4:evidence:${p.jobId}`]
      .map((address) => node.applied.filter((entry) => entry.logicalAddress === address).map((entry) => entry.hash)),
    ...readStore(join('transport', 'transport.sqlite'), {}, (db) => ({
      rows: Object.fromEntries(ACCOUNTING_TABLES.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n])),
      holds: db.prepare('SELECT count(*) AS n FROM kit_job_holds').get().n,
      releases: db.prepare('SELECT count(*) AS n FROM kit_slot_retirements WHERE job_retired = 1').get().n,
      allocations: db.prepare('SELECT allocationId, state, rev FROM kit_allocations WHERE jobId = ?').all(p.jobId) })) });
  const retain = () => ({ node: node.retain(), finalized: finalized.retain(), admission: admission.retain(), journals: anchorJournals.map(({ rows }) => [...rows]),
    agreements: [...agreements], inputs: [...inputs], buyerBundles: [...buyerBundles] });
  return { node, anchors, artifactAnchor, purchase, restart, retain, faults, counts, dataDirectory, listing, sellerKey, buyerKey, advance, host: () => host,
    hold, steps, lockedJobs, snapshot, leaseMs: JOURNAL_LEASE_MS, leaseUntil: openLeaseUntil, clock, grantedReceipts,
    /** For each payment request sent so far, the jobs whose durable lock was held at each read of the transfer the seller made for it. */
    transferReads: () => steps.reduce((requests, entry) => {
      if (entry.step === 'request') requests.push([]);
      else if (entry.step === 'getTransactionStatus') requests.at(-1)?.push(entry.locks);
      return requests;
    }, []),
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
