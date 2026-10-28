// Internal seller construction, profile validation, retained reads and issued
// challenges. Real fixed-key Listings and authenticated SQLite state; commercial
// proposal, payment and delivery flows are introduced on later branches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@kynesyslabs/dacs';
import { sellerApi as seller } from './helpers/seller-internal-api.mjs';
import { createDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createNativeDemDeliveryCapability } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { createNativePaymentEvidenceConsumer } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { SESSION_CHALLENGE_LIFETIME_MS, vetAnchorReceiptProblem } from '../src/dacs/session-admission.mjs';
import { railAuthorityConfig } from '../src/dacs/rail-authority.mjs';
import { railSteward } from './helpers/rail-authority-fixture.mjs';
import { createSessionAdmissionFixture } from './helpers/session-admission-fixture.mjs';

let nextWallet=90;
function key(){const tag=nextWallet++,privateKey=core.privateKeyFromSeed(new Uint8Array(32).fill(tag)),raw=Buffer.from(core.rawPublicKey(core.publicKeyFromSeed(new Uint8Array(32).fill(tag))));return{privateKey,address:'0x'+raw.toString('hex'),claim:'did:demos:agent:'+raw.toString('hex'),sign:bytes=>Buffer.from(core.ed25519Sign(bytes,privateKey)),signWallet:message=>'0x'+Buffer.from(core.ed25519Sign(Buffer.from(message),privateKey)).toString('hex')};}
const identityFor = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'settlement-profile' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};
// A presentation carrying a given session nonce, signed by the party.
const presentWith = (party, presentedAt, sessionNonce) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'settlement-profile' });
  const bundle = { ...unsigned.bundle, sessionNonce }, bundleHash = core.sha256Hex(core.canonicalize(bundle));
  return seller.attachIdentityPresentation({ bundle, bundleHash }, party.signWallet(unsigned.message.replace(unsigned.bundleHash, bundleHash)));
};

async function world(t, { listingChanges = () => {} } = {}) {
  const sellerKey = key(), buyerKey = key(), now = 1780000000000, reached = [], steward = railSteward();
  const admission = createSessionAdmissionFixture({ seller: sellerKey, buyer: buyerKey, now: () => now });
  const draft = seller.buildListingDraft({ identityBundle: identityFor(sellerKey, now - 1000), displayName: 'Profile seller', publicEndpoint: 'https://seller.invalid/agent',
    listingId: 'settlement-profile', listingVersion: 1, title: 'Settlement profile report', description: 'Settlement profile vectors.',
    expectedSizeBytes: 1024, category: 'services.market-report', tags: ['profile'], priceDem: '2.5', notBefore: now - 60000 });
  listingChanges(draft);
  const listing = seller.attachListingSignature(draft, sellerKey.signWallet(seller.listingSigningMessage(draft)));
  const refuse = (name) => async () => { reached.push(name); throw new Error(`${name} is not reached`); };
  let challengeSnapshot = null;
  // Each independent scenario forks the verifier's authenticated, pre-attempt
  // ledger. This snapshot is made by a real issuer before the buyer signs;
  // no fixture writes a caller-selected nonce into seller state.
  const dir = ({ empty = false } = {}) => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'seller-settlement-profile-')));
    t.after(() => rmSync(path, { recursive: true, force: true }));
    if (challengeSnapshot && !empty) copyFileSync(challengeSnapshot, join(path, 'seller-state.sqlite'));
    return path;
  };
  const capabilities = {
    signer: { claim: sellerKey.claim, sign: sellerKey.sign }, listing, now: () => now,
    buyerAccess: seller.createOperatorBuyerAccess({ openBuyerAccess: true, buyerForJob: candidate => candidate === jobId ? buyerKey.address : null }),
    agreementAnchor: { source: 'settlement-profile/agreement-readback', readAgreement: refuse('readAgreement') },
    nativeArtifactAnchor: { writer: sellerKey.claim, publish: refuse('publish'), readRetained: refuse('readRetained'), verifyReceipt: refuse('verifyReceipt') },
    deliverySchemaVerifier: { schemaUrl: listing.offering.deliverable.schemaUrl, verify: refuse('verifyDeliverySchema') },
    deliverableProducer: () => { reached.push('deliverableProducer'); throw new Error('not reached'); },
    observeDemosTransfer: refuse('observeDemosTransfer'),
    railAuthority: steward.railAuthority(),
    sessionAdmission: admission.sessionAdmission,
  };
  const jobId = core.generateCanonicalJobId(), issuerDirectory = dir();
  const issuer = await seller.createSellerAgent({ ...capabilities, durableDirectory: issuerDirectory,
    now: () => Math.max(now, listing.validity.notBefore) });
  let challenge;
  try { challenge = issuer.issueSessionChallenge({ jobId, buyer: buyerKey.claim }); }
  finally { issuer.close(); }
  challengeSnapshot = join(issuerDirectory, 'seller-state.sqlite');
  const buyerBundle = presentWith(buyerKey, now, challenge.sessionNonce);
  // The operator's Vet context: references to counterparty-verified records
  // (DACS-2 §7.7.2) the seller's session admission keeps, at the canonical
  // composite addresses.
  const synthetic = seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: now });
  const vetted = { ...synthetic, buyer: { ...synthetic.buyer, vetRecordRef: await admission.vetRecord(jobId, buyerKey.claim, buyerBundle, { requirement: listing.buyerRequirement }) },
    seller: { ...synthetic.seller, vetRecordRef: await admission.vetRecord(jobId, sellerKey.claim, listing.seller.identity, { requirement: listing.buyerRequirement }) } };
  // The not-performed references with each counterparty verifier named, as a context could return them.
  const signedSynthetic = { ...synthetic, buyer: { ...synthetic.buyer, vetRecordRef: { ...synthetic.buyer.vetRecordRef, signer: sellerKey.claim } },
    seller: { ...synthetic.seller, vetRecordRef: { ...synthetic.seller.vetRecordRef, signer: buyerKey.claim } } };
  // The delivery runner's Vet requirement invocations for a context input: one
  // per party record, evaluating that party, naming its counterparty verifier
  // and the requirement the record hashes (the Listing's buyer requirement).
  const invocationsFor = (input) => [['buyer', buyerKey.claim, sellerKey.claim], ['seller', sellerKey.claim, buyerKey.claim]].map(([role, evaluatedParty, verifier]) => ({
    vetRecordRef: structuredClone(input[role].vetRecordRef), evaluatedParty, requirement: structuredClone(listing.buyerRequirement), verifier, freshness: [], dealSpecific: [] }));
  // The seller wallet's journal over wallet primitives that refuse: the native
  // settlement chain takes the evidence anchor and its reconciliation only from
  // one createPaymentEvidenceWalletJournal (`journal()`), in the agent as in the host.
  let walletJournal = null;
  const journal = () => {
    if (!walletJournal) {
      walletJournal = seller.createPaymentEvidenceWalletJournal({ path: join(dir(), 'wallet-journal.sqlite'), signCreate: refuse('anchorEvidence'), broadcast: refuse('broadcast'),
        readAccountNonce: refuse('readAccountNonce'), readTransactionState: refuse('readTransactionState') });
      t.after(() => walletJournal.close());
    }
    return walletJournal;
  };
  const chain = {
    journal,
    nativePaymentEvidence: ({ anchorEvidence = journal().anchorEvidence, fetchImpl = refuse('fetch') } = {}) => createNativePaymentEvidenceConsumer({ rpcUrl: 'http://127.0.0.1:9/', anchorEvidence, fetchImpl }),
    get reconcilePaymentEvidence() { return journal().reconcilePaymentEvidence; },
    demDeliveryContext: (input = vetted, vetRequirements = invocationsFor(input)) => createDemDeliveryContext({ authority: 'TEST-settlement-profile', resolveBuyer: refuse('resolveBuyer'),
      resolveSeller: async () => { reached.push('resolveSeller'); return { disposition: 'present', value: { input: structuredClone(input), vetRequirements: structuredClone(vetRequirements) } }; } }),
    nativeDemDelivery: () => createNativeDemDeliveryCapability({ authority: 'TEST-settlement-profile', submit: refuse('submit'), reconcile: refuse('reconcile'), read: refuse('read'), verifyReceipt: refuse('deliveryVerifyReceipt') }),
  };
  const proposalFor = async (input, proposalJobId = jobId) => {
    const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(input));
    const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
    const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
    const transportIdentity = { jobId: proposalJobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
    return { proposal, transportIdentity, buyerIdentityBundle: buyerBundle };
  };
  const payment = { jobId, txHash: 'a'.repeat(64), payerPayingKey: buyerKey.claim };
  const agent = (options) => seller.createSellerAgent(options);
  return { capabilities, chain, dir, reached, jobId, synthetic, signedSynthetic, vetted, proposalFor, payment, listing, signer: capabilities.signer, steward, buyerKey, sellerKey, buyerBundle, admission, now, agent };
}

const complete = (w, extra = {}) => ({ ...w.capabilities, nativePaymentEvidence: w.chain.nativePaymentEvidence(), reconcilePaymentEvidence: w.chain.reconcilePaymentEvidence,
  demDeliveryContext: w.chain.demDeliveryContext(), nativeDemDelivery: w.chain.nativeDemDelivery(), ...extra });

test('without the steward-signed rail authority the native profile is refused before any state is opened', async (t) => {
  const w = await world(t), durableDirectory = w.dir({ empty: true });
  for (const railAuthority of [undefined, null]) {
    await assert.rejects(w.agent(complete(w, { durableDirectory, railAuthority })), { name: 'TypeError', message: /native seller profile needs railAuthority/ });
  }
  assert.deepEqual(readdirSync(durableDirectory), [], 'no durable state is created');
  assert.deepEqual(w.reached, []);
});

test('a rail authority that is not the steward-signed demos-native:DEM PA-1 definition is refused at construction', async (t) => {
  const w = await world(t), other = railSteward();
  const forged = w.steward.railAuthority(); forged.rail.availability = 'live'; forged.rail.parameters = { changed: true };
  const unsigned = w.steward.railAuthority(); delete unsigned.rail.signature;
  for (const [railAuthority, message] of [
    [forged, /not a RailDefinition signed by the steward \(signature-invalid\)/],
    [unsigned, /signed by the steward \(signature-missing\)/],
    [{ ...w.steward.railAuthority(), stewardClaim: other.stewardClaim, stewardPublicKey: other.stewardPublicKey }, /signed by the steward/],
    [w.steward.railAuthority({ changes: { railVersion: 2 } }), /not demos-native:DEM version 1 on pay-dem/],
    // DACS-4 §9.5.9 step 1: a steward-signed definition of another asset,
    // network, rail type or handler is refused before any Agreement is signed
    // (by the SDK's RailDefinition check, or by the package's own DEM guard).
    [w.steward.railAuthority({ changes: { asset: { kind: 'native-dem', symbol: 'DEM', decimals: 18 } } }), /not demos-native:DEM version 1 on pay-dem|is not a RailDefinition/],
    [w.steward.railAuthority({ changes: { asset: { kind: 'native-dem', symbol: 'TEST', decimals: 9 } } }), /not demos-native:DEM version 1 on pay-dem|is not a RailDefinition/],
    [w.steward.railAuthority({ changes: { network: { kind: 'demos', extra: 1 } } }), /not demos-native:DEM version 1 on pay-dem|is not a RailDefinition/],
    [w.steward.railAuthority({ changes: { railType: 'x402' } }), /not demos-native:DEM version 1 on pay-dem|is not a RailDefinition/],
    [w.steward.railAuthority({ changes: { phaseHandler: 'TEST-other' } }), /not demos-native:DEM version 1 on pay-dem|is not a RailDefinition/],
    [w.steward.railAuthority({ changes: { governance: { proposedBy: w.steward.stewardClaim, acceptedAt: 1, anchoring: 'single-signer' } } }), /PA-1 in-code definition/],
    [{ ...w.steward.railAuthority(), production: 'yes' }, /local operator policy/],
    [{ ...w.steward.railAuthority(), extra: 1 }, /railAuthority must be exactly/],
  ]) await assert.rejects(w.agent(complete(w, { durableDirectory: w.dir(), railAuthority })), { name: 'TypeError', message });
  await assert.rejects(seller.createSellerAgent({ signer: w.signer, listing: w.listing, observeDemosTransfer: async () => null, anchors: { read: async () => null, write: async () => null }, simulatedFixture: true, railAuthority: w.steward.railAuthority() }),
    { name: 'TypeError', message: /simulated fixture profile takes no railAuthority/ });
  assert.deepEqual(w.reached, []);
});

test('the seller issues a fresh 256-bit challenge bound to one job and buyer; a nonce is issued once', async (t) => {
  const w = await world(t), agent = await seller.createSellerAgent(complete(w, { durableDirectory: w.dir() }));
  t.after(() => agent.close());
  const issued = agent.issueSessionChallenge({ jobId: w.jobId, buyer: w.buyerKey.claim }), again = agent.issueSessionChallenge({ jobId: w.jobId, buyer: w.buyerKey.claim });
  assert.match(issued.sessionNonce, /^[0-9a-f]{64}$/);
  assert.notEqual(issued.sessionNonce, again.sessionNonce, 'every challenge is fresh');
  assert.deepEqual({ ...issued, sessionNonce: null }, { jobId: w.jobId, buyer: w.buyerKey.claim, sessionNonce: null, issuedAt: w.now, expiresAt: w.now + SESSION_CHALLENGE_LIFETIME_MS });
  const failed = (input) => { try { agent.issueSessionChallenge(input); return null; } catch (error) { return error.code; } };
  assert.equal(failed({ jobId: w.jobId, buyer: w.buyerKey.claim, sessionNonce: issued.sessionNonce }), 'challenge_invalid', 'callers cannot reissue a nonce');
  assert.equal(failed({ jobId: w.jobId, buyer: w.buyerKey.claim, sessionNonce: 'AB'.repeat(32) }), 'challenge_invalid');
  assert.equal(failed({ jobId: w.jobId, buyer: w.buyerKey.claim, sessionNonce: 'ab'.repeat(15) }), 'challenge_invalid', 'fewer than 128 bits');
  assert.equal(failed({ jobId: 'not-a-job', buyer: w.buyerKey.claim }), 'job_invalid');
  assert.equal(failed({ jobId: w.jobId, buyer: w.sellerKey.claim }), 'buyer_invalid', 'the seller is no buyer');
});

test('rail key history authenticates only in-flight pins, including legacy pins, and never trusts a saved key or altered definition', () => {
  const previous = railSteward(), current = railSteward(), stranger = railSteward();
  const old = railAuthorityConfig(previous.railAuthority());
  const pin = old.pin();
  const config = { ...current.railAuthority(), historicalStewards: [{ stewardClaim: previous.stewardClaim, stewardPublicKey: previous.stewardPublicKey }] };
  const rotated = railAuthorityConfig(config);
  config.historicalStewards[0].stewardPublicKey = stranger.stewardPublicKey;
  assert.equal(rotated.evaluate(pin, 'in-flight').decision, 'pass');
  const legacy = structuredClone(pin); delete legacy.stewardClaim; delete legacy.stewardPublicKey;
  assert.equal(rotated.evaluate(legacy, 'in-flight').decision, 'pass');
  assert.equal(rotated.evaluate(pin, 'new').decision, 'fail');
  assert.equal(rotated.evaluate(rotated.pin(), 'new').decision, 'pass');
  assert.equal(railAuthorityConfig(current.railAuthority()).evaluate(pin, 'in-flight').decision, 'fail');
  assert.equal(rotated.evaluate(railAuthorityConfig(stranger.railAuthority()).pin(), 'in-flight').decision, 'fail');
  assert.equal(rotated.evaluate({ ...pin, stewardClaim: current.stewardClaim }, 'in-flight').decision, 'fail');
  assert.equal(rotated.evaluate({ ...pin, stewardPublicKey: stranger.stewardPublicKey }, 'in-flight').decision, 'fail');
  const sameClaim = current.railAuthority({ authority: { stewardClaim: previous.stewardClaim } });
  sameClaim.rail.signature.signer = previous.stewardClaim;
  const sameIdentity = railAuthorityConfig({ ...sameClaim, historicalStewards: [{ stewardClaim: previous.stewardClaim, stewardPublicKey: previous.stewardPublicKey }] });
  assert.equal(sameIdentity.evaluate(pin, 'in-flight').decision, 'pass', 'same claim with a new key');
  assert.equal(sameIdentity.evaluate(legacy, 'in-flight').decision, 'pass', 'legacy pin under a rotated stable identity');
  assert.equal(sameIdentity.evaluate(pin, 'new').decision, 'fail');
  assert.equal(sameIdentity.evaluate(sameIdentity.pin(), 'new').decision, 'pass');
  const altered = structuredClone(pin); altered.rail.parameters = { changed: true };
  assert.equal(rotated.evaluate(altered, 'in-flight').decision, 'fail');
  assert.throws(() => railAuthorityConfig({ ...current.railAuthority(), historicalStewards: {} }), /must be an array/);
  const many = Array.from({ length: 65 }, () => railSteward());
  const completeHistory = railAuthorityConfig({ ...current.railAuthority(), historicalStewards: many.map(({ stewardClaim, stewardPublicKey }) => ({ stewardClaim, stewardPublicKey })) });
  for (const identity of [many[0], many[64]]) assert.equal(completeHistory.evaluate(railAuthorityConfig(identity.railAuthority()).pin(), 'in-flight').decision, 'pass', 'every configured historical identity remains authorized');
});


test('a binding with durable accepted admission may still supply an accepted Vet receipt', async (t) => {
  const w = await world(t), party = w.buyerKey.claim;
  const ref = await w.admission.vetRecord(w.jobId, party, w.buyerBundle, { requirement: w.listing.buyerRequirement });
  const receipt = await w.admission.sessionAdmission.readVetAnchorReceipt({ ref });
  assert.equal(vetAnchorReceiptProblem({ ...receipt, substrate: 'test-durable-admission', state: 'accepted' }, { ref, jobId: w.jobId, party }), null);
});


test('steward history rejects malformed identities at configuration and retains valid old keys', () => {
  const previous = railSteward(), current = railSteward();
  const entry = { stewardClaim: previous.stewardClaim, stewardPublicKey: previous.stewardPublicKey };
  for (const changed of [{ stewardPublicKey: entry.stewardPublicKey + '=' }, { stewardClaim: 'not a claim' }, { stewardPublicKey: Buffer.alloc(31).toString('base64url') }]) {
    assert.throws(() => railAuthorityConfig({ ...current.railAuthority(), historicalStewards: [{ ...entry, ...changed }, entry] }), /historicalStewards/);
  }
  const retained = railAuthorityConfig(previous.railAuthority()).pin();
  delete retained.stewardClaim; delete retained.stewardPublicKey;
  assert.equal(railAuthorityConfig({ ...current.railAuthority(), historicalStewards: [entry] }).evaluate(retained, 'in-flight').decision, 'pass');
});

test('the default store admits job 1001 and atomically reserves the last configured slot', async (t) => {
  const { createSellerDurableState } = await import('../src/dacs/seller-durable-state.mjs');
  const w = await world(t);
  const store = await createSellerDurableState({ dir: w.dir(), signer: w.signer, listingPin: seller.listingPin(w.listing) });
  try {
    for (let i = 0; i < 1001; i++) {
      const jobId = core.generateCanonicalJobId();
      await store.withJob(jobId, () => store.saveSession({ jobId }));
    }
    assert.equal(store.sessions().length, 1001);
  } finally { store.close(); }
  const limited = await createSellerDurableState({ dir: w.dir(), signer: w.signer, listingPin: seller.listingPin(w.listing), maxJobs: 1 });
  try {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { entered = resolve; });
    const first = limited.withJob(core.generateCanonicalJobId(), async () => { entered(); await gate; });
    await pending;
    await assert.rejects(limited.withJob(core.generateCanonicalJobId(), () => assert.fail('capacity must refuse before admission')), { code: 'seller_state_capacity' });
    release(); await first;
    await limited.withJob(core.generateCanonicalJobId(), () => {});
  } finally { limited.close(); }
});


test('capacity reclaims only proven-exited unsaved reservations; live holders and saved sessions still count', async (t) => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createSellerDurableState } = await import('../src/dacs/seller-durable-state.mjs');
  const signer = key(), listingPin = { listingId: 'reservation-recovery', version: 1, contentHash: 'a'.repeat(64) };
  for (const saved of [false, true]) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-reservation-')));
    const jobA = core.generateCanonicalJobId(), jobB = core.generateCanonicalJobId();
    const initial = await createSellerDurableState({ dir, signer, listingPin, maxJobs: 1 });
    initial.retainContext({ admittedAt: 1, validation: { disposition: 'verified' } });
    initial.close();
    const child = fork(new URL('./helpers/seller-durable-state-lock-holder.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(() => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
    const message = async (input) => { const reply = once(child, 'message'); child.send(input); return (await reply)[0]; };
    await once(child, 'message');
    const held = await message({ type: 'hold', dir, listingPin, jobId: jobA, claim: signer.claim, pkcs8: signer.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') });
    assert.equal(held.code, null, JSON.stringify(held));
    if (saved) assert.equal((await message({ type: 'call', op: 'save' })).code, null);
    let store = await createSellerDurableState({ dir, signer, listingPin, maxJobs: 1 });
    try {
      assert.equal(store.inspectLocks()[0].holderExited, false);
      await assert.rejects(store.withJob(jobB, () => assert.fail('live reservation must count')), { code: 'seller_state_capacity' });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      store.close(); store = await createSellerDurableState({ dir, signer, listingPin, maxJobs: 1 });
      assert.equal(store.inspectLocks()[0].holderExited, true);
      assert.equal(store.sessions().length, saved ? 1 : 0);
      if (saved) await assert.rejects(store.withJob(jobB, () => assert.fail('a saved session must count')), { code: 'seller_state_capacity' });
      else {
        await store.withJob(jobB, () => store.saveSession({ jobId: jobB }));
        assert.deepEqual(store.sessions().map(s => s.jobId), [jobB]);
        assert.equal(store.inspectLocks().length, 0, 'dead unsaved reservation reclaimed without requesting its job');
      }
    } finally { store.close(); }
  }
});

test('capacity never reclaims an unproven reservation', async (t) => {
  const { default: DatabaseSync } = await import('better-sqlite3');
  const { createSellerDurableState } = await import('../src/dacs/seller-durable-state.mjs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-unproven-reservation-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await createSellerDurableState({ dir, signer: key(), listingPin: { listingId: 'unproven', version: 1, contentHash: 'a'.repeat(64) }, maxJobs: 1 });
  try {
    const db = new DatabaseSync(join(dir, 'seller-state.sqlite'));
    try { db.prepare('INSERT INTO seller_locks VALUES (?,?,?)').run(core.generateCanonicalJobId(), '1:TEST-legacy-holder', 1); } finally { db.close(); }
    assert.notEqual(store.inspectLocks()[0].reason, 'exited');
    await assert.rejects(store.withJob(core.generateCanonicalJobId(), () => assert.fail('unproven reservation must count')), { code: 'seller_state_capacity' });
    assert.equal(store.inspectLocks().length, 1);
  } finally { store.close(); }
});
