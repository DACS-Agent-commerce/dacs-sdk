// One Start approval, wallet side (DACS_INTENT_APPROVAL=on): the intent gate
// over the real embedded SDK session. The drafts come from the same functions
// the server uses; every mismatch must stop with nothing signed and a reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, generateCanonicalJobId } from '@kynesyslabs/dacs';
import { gatedWallet, fixturePurchase, withListingHash, viewFor, identityFor, delegationFor, signedMessages, DAY } from './helpers/start-intent.mjs';
import { buildIntent, describeIntent, canonicalJson, IntentMismatch, DEVNET_CREATE_KIND, FEE_CEILING_PER_WRITE_OS, INTENT_MAX_TTL_MS } from '../public/portal-intent/intent.mjs';
import { INTENT_APPROVAL_METHOD } from '../public/portal-intent/gate.mjs';
import { attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { planAgreement } from '../src/dacs/purchase-protocol.mjs';
import { verifyDemosSignature } from '../src/wallet/demos-signature.mjs';
import { renderChallengeMessage, PURPOSES } from '../src/wallet/challenges.mjs';
import { sellerSessionDelegationSigningBytes } from '../src/dacs/seller-transport-auth.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const mismatch = (field) => (error) => error instanceof IntentMismatch && error.field === field && /^Nothing was signed: /.test(error.message);

// One wallet session for the file; each case opens its own intent.
const w = await gatedWallet();
const other = createEphemeralWallet();

async function started({ devnet = false, demContext = false, now = Date.now(), plannedNonce = 7, purchase } = {}) {
  const p = purchase ?? await withListingHash(fixturePurchase({ address: w.address, devnet, demContext, now }));
  const view = viewFor(p, { now, plannedNonce });
  const intent = await buildIntent({ view, start: view.start, wallet: w.address, now });
  await w.gate.open(intent);
  return { p, view, intent };
}

// The identity signature and the SDK plan for it, as the server derives them.
let cached = null;
async function signedPlan() {
  if (cached) return cached;
  const s = await started();
  const unsigned = identityFor(s.p, w.address, s.intent.identity.presentedAt);
  const signature = await w.gate.signIdentity(unsigned.bundle);
  const planned = planAgreement({ jobId: s.p.jobId, listing: s.p.listing, buyerBundle: attachIdentityPresentation(unsigned, signature), generatedAt: s.intent.agreement.generatedAt });
  w.gate.finish();
  cached = { ...s, unsigned, planned };
  return cached;
}

async function reopen(c) {
  const intent = await buildIntent({ view: c.view, start: c.view.start, wallet: w.address, now: Date.now() });
  await w.gate.open(intent);
  await w.gate.noteIdentity(c.unsigned.bundle);
  return intent;
}

test('happy path: one Start dialog, then identity, Agreement and anchor signatures with no further dialog', async () => {
  const before = w.dialogs.length, signedBefore = signedMessages.length;
  const { p, intent } = await started();
  assert.equal(w.dialogs.length, before + 1);
  const dialog = w.dialogs.at(-1);
  assert.equal(dialog.method, INTENT_APPROVAL_METHOD);
  for (const shown of [p.listing.listingId, `version ${p.listing.listingVersion}`, p.terms.listing.contentHash, p.seller.address, p.seller.claim, '2.5 DEM', '2500000000 OS', p.terms.network, 'demos-native:DEM', p.jobId, 'Wallet writes covered: none', 'Sending funds is not included']) {
    assert.ok(dialog.message.includes(shown), `the intent shows ${shown}`);
  }
  const unsigned = identityFor(p, w.address, intent.identity.presentedAt);
  const identity = await w.gate.signIdentity(unsigned.bundle);
  assert.equal(signedMessages.at(-1), unsigned.message, 'the wallet derived the server identity bytes itself');
  assert.ok(verifyDemosSignature({ address: w.address, message: unsigned.message, signature: identity }));
  const planned = planAgreement({ jobId: p.jobId, listing: p.listing, buyerBundle: attachIdentityPresentation(unsigned, identity), generatedAt: intent.agreement.generatedAt });
  const agreement = await w.gate.signAgreement(planned.draft);
  assert.equal(signedMessages.at(-1), planned.agreementMessage, 'the wallet derived the SDK Agreement bytes itself');
  assert.ok(verifyDemosSignature({ address: w.address, message: planned.agreementMessage, signature: agreement }));
  const anchor = await w.gate.signAnchorAuthorization();
  assert.equal(signedMessages.at(-1), planned.anchorMessage);
  assert.ok(verifyDemosSignature({ address: w.address, message: planned.anchorMessage, signature: anchor }));
  assert.equal(signedMessages.length, signedBefore + 3);
  assert.equal(w.dialogs.length, before + 1, 'no dialog after the Start approval');
  assert.deepEqual([...intent.steps], ['identity', 'agreement', 'anchorAuthorization']);
  // Each covered signature once: a second Agreement signature is refused.
  await assert.rejects(w.gate.signAgreement(planned.draft), mismatch('step'));
  w.gate.finish();
});

test('the intent states every bound value and its writes, fee ceiling and expiry', async () => {
  const now = Date.now();
  const p = await withListingHash(fixturePurchase({ address: w.address, devnet: true, now }));
  const view = viewFor(p, { now, plannedNonce: 12 });
  const intent = await buildIntent({ view, start: view.start, wallet: w.address, now });
  assert.equal(intent.purchase, p.id);
  assert.equal(intent.account, 'acct_test_1');
  assert.equal(intent.wallet, w.address);
  assert.deepEqual({ ...intent.listing }, { listingId: p.listing.listingId, version: 1, contentHash: p.terms.listing.contentHash });
  assert.deepEqual({ ...intent.seller }, { did: p.seller.claim, address: p.seller.address });
  assert.deepEqual({ ...intent.network }, { name: 'demos-devnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: p.chainIdentity });
  assert.deepEqual(intent.writes.map((x) => ({ ...x })), [{ step: 'agreementCreate', nonce: 12 }]);
  assert.equal(intent.fees.perWriteOs, FEE_CEILING_PER_WRITE_OS.toString());
  assert.equal(intent.fees.totalOs, FEE_CEILING_PER_WRITE_OS.toString());
  assert.ok(intent.expiresAt <= now + INTENT_MAX_TTL_MS);
  // A server record that claims a longer life does not lengthen the intent.
  const long = await buildIntent({ view, start: { ...view.start, intent: { ...view.start.intent, expiresAt: new Date(now + DAY).toISOString() } }, wallet: w.address, now });
  assert.equal(long.expiresAt, now + INTENT_MAX_TTL_MS);
  const text = describeIntent(intent);
  for (const shown of ['Wallet writes covered: 1', 'nonce 12', '4 DEM per write, 4 DEM in total', `chain ${p.chainIdentity}`, 'the browser session for this one Agreement record']) assert.ok(text.includes(shown), shown);
  assert.ok(Object.isFrozen(intent) && Object.isFrozen(intent.listing) && Object.isFrozen(intent.writes), 'an approved intent cannot widen');
  // Terms the intent cannot state truthfully are refused before any dialog.
  await assert.rejects(buildIntent({ view: { ...view, terms: { ...p.terms, seller: { ...p.terms.seller, payee: other.address } } }, start: view.start, wallet: w.address, now }), mismatch('seller'));
  await assert.rejects(buildIntent({ view, start: view.start, wallet: other.address, now }), mismatch('wallet'));
  // Terms that differ from the hash every later server binding names.
  await assert.rejects(buildIntent({ view: { ...view, terms: { ...p.terms, approvalExpiresAt: new Date(now + 2 * DAY).toISOString() } }, start: view.start, wallet: w.address, now }), mismatch('terms'));
  await assert.rejects(buildIntent({ view: { ...view, terms: { ...p.terms, protocol: { ...p.terms.protocol, agreementContext: 'dacs-chatgpt-plugin/operator-agreement-context/v1' } } }, start: view.start, wallet: w.address, now }), mismatch('profile'));
});

test('a mismatch in each Agreement field stops with nothing signed and says why', async () => {
  const c = await signedPlan();
  const draft = c.planned.draft;
  const tamper = (fn) => { const d = structuredClone(draft); fn(d); return d; };
  const cases = {
    listing: tamper((d) => { d.listingRef.listingId = 'another-listing'; }),
    version: tamper((d) => { d.listingRef.version = 2; }),
    hash: tamper((d) => { d.listingRef.contentHash = 'f'.repeat(64); }),
    price: tamper((d) => { d.terms.price.amount = '2.6'; }),
    seller: tamper((d) => { d.parties[1].primaryClaim = other.claim; }),
    payee: [tamper((d) => { d.terms.payoutBindings[0].payeeAddress = other.address; }), 'seller'],
    parties: tamper((d) => { d.parties[0].primaryClaim = other.claim; }),
    buyerIdentity: [tamper((d) => { d.parties[0].bundleHash = 'e'.repeat(64); }), 'parties'],
    job: tamper((d) => { d.jobId = generateCanonicalJobId(); }),
    network: tamper((d) => { d.terms.rail.railId = 'other-chain:DEM'; }),
    vet: tamper((d) => { d.parties[1].vetRecordRef.contentHash = 'd'.repeat(64); }),
    extraField: [tamper((d) => { d.terms.refund = 'none'; }), 'agreement'],
  };
  for (const [name, value] of Object.entries(cases)) {
    const [bad, field] = Array.isArray(value) ? value : [value, name];
    await reopen(c);
    const before = signedMessages.length, dialogs = w.dialogs.length;
    await assert.rejects(w.gate.signAgreement(bad), mismatch(field), name);
    assert.equal(signedMessages.length, before, `${name}: nothing signed`);
    assert.equal(w.dialogs.length, dialogs, `${name}: no dialog`);
    w.gate.finish();
  }
  // The untampered draft still signs under a fresh intent.
  await reopen(c);
  await w.gate.signAgreement(draft);
  w.gate.finish();
});

test('an Agreement context is not covered: its vet refs name records the wallet cannot verify, so it keeps the per-step flow', async () => {
  const p = await withListingHash(fixturePurchase({ address: w.address, demContext: true }));
  const view = viewFor(p);
  await assert.rejects(buildIntent({ view, start: view.start, wallet: w.address, now: Date.now() }), mismatch('profile'));
});

test('identity drafts for another purchase, job or party are refused', async () => {
  const s = await started();
  const before = signedMessages.length;
  const otherPurchase = identityFor({ ...s.p, id: 'pur_another000000' }, w.address);
  await assert.rejects(w.gate.signIdentity(otherPurchase.bundle), mismatch('job'));
  await assert.rejects(w.gate.signIdentity(identityFor({ ...s.p, jobId: generateCanonicalJobId() }, w.address).bundle), mismatch('job'));
  await assert.rejects(w.gate.signIdentity(identityFor(s.p, other.address).bundle), mismatch('parties'));
  await assert.rejects(w.gate.signIdentity(identityFor(s.p, w.address, Date.now() + 2 * DAY).bundle), mismatch('identity'));
  assert.equal(signedMessages.length, before);
  w.gate.finish();
});

test('during a Start the wallet never signs bytes it did not derive, and refuses other actions without a dialog', async () => {
  await started();
  const before = signedMessages.length, dialogs = w.dialogs.length;
  const opaque = await w.session.request({ method: 'sign', params: [`dacs-payee-bound-agreement:v1:${'a'.repeat(64)}`] });
  assert.equal(opaque.success, false);
  assert.equal(opaque.error.code, 'user_rejected');
  assert.equal(w.gate.lastRefusal.field, 'bytes');
  assert.equal(signedMessages.length, before);
  assert.equal(w.dialogs.length, dialogs, 'no dialog during an active Start');
  w.gate.finish();
  // Outside a Start the normal dialog is shown and decides.
  const shown = await w.session.request({ method: 'sign', params: ['plain sign-in message'] });
  assert.equal(shown.success, true);
  assert.equal(w.dialogs.length, dialogs + 1);
  assert.equal(w.dialogs.at(-1).method, 'sign');
});

test('a Start the buyer rejects signs nothing', async () => {
  const rejecting = await gatedWallet({ dialog: () => false });
  const p = await withListingHash(fixturePurchase({ address: rejecting.address }));
  const view = viewFor(p);
  const intent = await buildIntent({ view, start: view.start, wallet: rejecting.address, now: Date.now() });
  await assert.rejects(rejecting.gate.open(intent), mismatch('rejected'));
  await assert.rejects(rejecting.gate.signIdentity(identityFor(p, rejecting.address).bundle), mismatch('intent'));
  rejecting.session.lock();
});

test('expiry, lock and a new session end the intent: nothing signs without a valid one', async () => {
  let clock = Date.now();
  const timed = await gatedWallet({ now: () => clock });
  const p = await withListingHash(fixturePurchase({ address: timed.address, now: clock }));
  const view = viewFor(p, { now: clock });
  const intent = await buildIntent({ view, start: view.start, wallet: timed.address, now: clock });
  await timed.gate.open(intent);
  clock = intent.expiresAt;
  const before = signedMessages.length;
  await assert.rejects(timed.gate.signIdentity(identityFor(p, timed.address, clock).bundle), mismatch('expiry'));
  assert.equal(timed.gate.active, false, 'an expired intent is dropped');
  clock = Date.now();
  await timed.gate.open(await buildIntent({ view: viewFor(p, { now: clock }), start: viewFor(p, { now: clock }).start, wallet: timed.address, now: clock }));
  timed.session.lock();
  await assert.rejects(timed.gate.signIdentity(identityFor(p, timed.address, clock).bundle), (error) => mismatch('wallet')(error) && /locked or replaced; start again/.test(error.message));
  assert.equal(timed.gate.active, false, 'a lock drops the intent');
  // The same session, now holding another wallet, is not the approved wallet.
  const swap = await gatedWallet();
  const q = await withListingHash(fixturePurchase({ address: swap.address }));
  await swap.gate.open(await buildIntent({ view: viewFor(q), start: viewFor(q).start, wallet: swap.address, now: Date.now() }));
  await swap.session.create();
  await assert.rejects(swap.gate.signIdentity(identityFor(q, q.terms.buyer.wallet).bundle), (error) => mismatch('wallet')(error) && /locked or replaced; start again/.test(error.message));
  swap.session.lock();
  assert.equal(signedMessages.length, before);
  // A reloaded page is a new session with a new, empty gate: it asks again.
  const reloaded = await gatedWallet({ mnemonic: undefined });
  await assert.rejects(reloaded.gate.signIdentity(identityFor(p, reloaded.address).bundle), mismatch('intent'));
  reloaded.session.lock();
});

test('the Agreement CREATE is allowed once, only within the fee ceiling, at the planned nonce, network and Agreement', async () => {
  const now = Date.now();
  const p = await withListingHash(fixturePurchase({ address: w.address, devnet: true, now }));
  const view = viewFor(p, { now, plannedNonce: 7 });
  const unsigned = identityFor(p, w.address, now);
  // Identity and Agreement as already signed (resume): checked and bound only.
  let intent = await buildIntent({ view, start: view.start, wallet: w.address, now });
  await w.gate.open(intent);
  const buyerBundle = attachIdentityPresentation(unsigned, await w.gate.signIdentity(unsigned.bundle));
  w.gate.finish();
  const planned = planAgreement({ jobId: p.jobId, listing: p.listing, buyerBundle, generatedAt: intent.agreement.generatedAt });
  const stored = { ...planned.draft, signatures: [{ party: intent.buyer, algorithm: 'ed25519', value: 'x' }] };
  const content = (patch = {}) => ({ kind: DEVNET_CREATE_KIND, action: 'immutable DACS storage anchor CREATE', artifactKind: 'Agreement', jobId: p.jobId, owner: intent.buyer, wallet: w.address,
    logicalAddress: `dacs3:agreement:${p.jobId}`, contentHash: planned.plan.agreementHash, exactStorageBytes: JSON.stringify(stored), nonce: 7,
    debit: { totalOs: '3000000000' }, network: 'demos-devnet', chainIdentity: p.chainIdentity, ...patch });
  // A CREATE the Start did not arm is refused for that reason.
  await w.gate.open(await buildIntent({ view, start: view.start, wallet: w.address, now: Date.now() }));
  assert.equal(await w.gate.approve({ method: 'sendTransaction', address: w.address, purpose: 'x', content: content() }), false);
  assert.equal(w.gate.lastRefusal.field, 'write');
  w.gate.finish();
  async function attempt(patch) {
    intent = await buildIntent({ view, start: view.start, wallet: w.address, now: Date.now() });
    await w.gate.open(intent);
    await w.gate.noteIdentity(unsigned.bundle);
    await w.gate.noteAgreement(planned.draft);
    w.gate.expectAgreementCreate();
    const ok = await w.gate.approve({ method: 'sendTransaction', address: w.address, purpose: 'x', content: content(patch) });
    const refusal = w.gate.lastRefusal;
    const again = ok ? await w.gate.approve({ method: 'sendTransaction', address: w.address, purpose: 'x', content: content(patch) }) : null;
    w.gate.finish();
    return { ok, refusal, again };
  }
  const good = await attempt();
  assert.equal(good.ok, true);
  assert.equal(good.again, false, 'one covered write, once');
  const cases = {
    fee: { debit: { totalOs: (FEE_CEILING_PER_WRITE_OS + 1n).toString() } },
    nonce: { nonce: 8 },
    network: { network: 'demos-mainnet' },
    chain: [{ chainIdentity: 'cd'.repeat(32) }, 'network'],
    agreement: { contentHash: 'c'.repeat(64) },
    storedBytes: [{ exactStorageBytes: JSON.stringify({ ...stored, terms: { ...stored.terms, price: { amount: '9', currency: 'DEM' } } }) }, 'agreement'],
    owner: [{ owner: other.claim }, 'parties'],
    job: { jobId: generateCanonicalJobId() },
    kind: [{ kind: 'devnet-settlement-evidence-storage-create' }, 'write'],
  };
  for (const [name, value] of Object.entries(cases)) {
    const [patch, field] = Array.isArray(value) ? value : [value, name];
    const r = await attempt(patch);
    assert.equal(r.ok, false, name);
    assert.equal(r.refusal.field, field, `${name}: ${r.refusal.message}`);
  }
  // The total ceiling counts what earlier covered writes already spent.
  const { checkAgreementCreate } = await import('../public/portal-intent/intent.mjs');
  await assert.rejects(checkAgreementCreate(intent, content({ debit: { totalOs: '1' } }), { agreementHash: planned.plan.agreementHash, spentOs: FEE_CEILING_PER_WRITE_OS }), mismatch('fee'));
  assert.ok(await checkAgreementCreate(intent, content(), { agreementHash: planned.plan.agreementHash, spentOs: FEE_CEILING_PER_WRITE_OS - 3_000_000_000n }));
  // A native DEM transfer is never covered by the Start.
  await w.gate.open(await buildIntent({ view, start: view.start, wallet: w.address, now: Date.now() }));
  assert.equal(await w.gate.approve({ method: 'sendTransaction', address: w.address, content: { action: 'native DEM transfer' } }), false);
  assert.equal(w.gate.lastRefusal.field, 'step');
  w.gate.finish();
});

test('the browser Agreement session challenge must be exactly this purchase, account, wallet and Agreement', async () => {
  const now = Date.now();
  const p = await withListingHash(fixturePurchase({ address: w.address, devnet: true, now }));
  const view = viewFor(p, { now });
  const unsigned = identityFor(p, w.address, now);
  let intent = await buildIntent({ view, start: view.start, wallet: w.address, now });
  await w.gate.open(intent);
  const planned = planAgreement({ jobId: p.jobId, listing: p.listing, buyerBundle: attachIdentityPresentation(unsigned, await w.gate.signIdentity(unsigned.bundle)), generatedAt: intent.agreement.generatedAt });
  w.gate.finish();
  const origin = 'http://127.0.0.1:8787';
  const challenge = (patch = {}) => renderChallengeMessage({ origin, purpose: PURPOSES.OFFLINE_AGREEMENT_BROKER, address: w.address, nonce: 'n'.repeat(22), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
    binding: { account: 'acct_test_1', operation: p.id, wallet: w.address, 'terms-hash': view.termsHash, job: p.jobId, 'agreement-hash': planned.plan.agreementHash, network: 'demos-devnet', authorization: 'one immutable Agreement CREATE; no payment or completion', ...patch } });
  const fresh = async () => {
    intent = await buildIntent({ view, start: view.start, wallet: w.address, now: Date.now() });
    await w.gate.open(intent);
    await w.gate.noteIdentity(unsigned.bundle);
    await w.gate.noteAgreement(planned.draft);
  };
  await fresh();
  const message = challenge();
  await w.gate.signBrokerChallenge(message, { origin });
  assert.equal(signedMessages.at(-1), message);
  w.gate.finish();
  for (const [name, patch] of Object.entries({ account: { account: 'acct_another' }, operation: { operation: 'pur_another' }, terms: { 'terms-hash': 'b'.repeat(64) }, agreement: { 'agreement-hash': 'c'.repeat(64) }, authorization: { authorization: 'any CREATE' } })) {
    await fresh();
    const before = signedMessages.length;
    await assert.rejects(w.gate.signBrokerChallenge(challenge(patch), { origin }), mismatch('broker'), name);
    assert.equal(signedMessages.length, before, `${name}: nothing signed`);
    w.gate.finish();
  }
  await fresh();
  await assert.rejects(w.gate.signBrokerChallenge(message, { origin: 'http://127.0.0.1:9999' }), mismatch('broker'), 'another origin');
  w.gate.finish();
});

test('the seller session delegation is bound in the intent, shown in the dialog and compared exactly before signing', async () => {
  const now = Date.now();
  const p = await withListingHash(fixturePurchase({ address: w.address, now }));
  p.terms.protocol.sellerTransport = { delegation: true };
  const payload = delegationFor(p, w.address, { now });
  const view = viewFor(p, { now, delegation: payload });
  const intent = await buildIntent({ view, start: view.start, wallet: w.address, now });
  assert.deepEqual([...intent.steps], ['identity', 'delegation', 'agreement', 'anchorAuthorization']);
  assert.ok(describeIntent(intent).includes(`App session key: ${payload.sessionPublicKey}`), 'the dialog shows the exact session key');
  assert.ok(describeIntent(intent).includes(`until ${new Date(payload.expiresAt).toISOString()}`), 'and its window');
  // A Start without the delegation it needs is refused before the dialog.
  await assert.rejects(buildIntent({ view: viewFor(p, { now }), start: viewFor(p, { now }).start, wallet: w.address, now }), mismatch('delegation'));
  await w.gate.open(intent);
  const before = signedMessages.length;
  await assert.rejects(w.gate.signDelegation({ ...payload, jobId: generateCanonicalJobId() }), mismatch('delegation'));
  await assert.rejects(w.gate.signDelegation({ ...payload, seller: other.claim }), mismatch('delegation'));
  await assert.rejects(w.gate.signDelegation({ ...payload, notBefore: payload.notBefore - 1 }), mismatch('delegation'));
  assert.equal(signedMessages.length, before);
  await w.gate.signDelegation(payload);
  assert.equal(signedMessages.at(-1), sellerSessionDelegationSigningBytes(payload).toString('utf8'), 'the derived bytes are the server signing bytes');
  w.gate.finish();
});

test('a step the intent does not list is refused, even with a matching draft', async () => {
  const now = Date.now();
  const p = await withListingHash(fixturePurchase({ address: w.address, now }));
  const view = viewFor(p, { now });
  const intent = await buildIntent({ view, start: view.start, wallet: w.address, now });
  assert.ok(!intent.steps.includes('delegation'));
  const session = createEphemeralWallet();
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: intent.buyer, sessionPublicKey: session.claim.slice('did:demos:agent:'.length), seller: p.seller.claim,
    listingPin: { listingId: p.listing.listingId, version: 1, contentHash: p.terms.listing.contentHash }, jobId: p.jobId, notBefore: now - 1000, expiresAt: now + 3_600_000 };
  await w.gate.open(intent);
  const before = signedMessages.length;
  await assert.rejects(w.gate.signDelegation(payload), mismatch('step'));
  assert.equal(signedMessages.length, before);
  w.gate.finish();
});

test('a request for other bytes that arrives while a derived signature is pending is refused', async () => {
  const { createIntentGate } = await import('../public/portal-intent/gate.mjs');
  const p = await withListingHash(fixturePurchase({ address: w.address }));
  const view = viewFor(p);
  const intent = await buildIntent({ view, start: view.start, wallet: w.address, now: Date.now() });
  const answers = [];
  const gate = createIntentGate({ approve: async () => true });
  // A session that yields before asking for approval, so a second request can interleave.
  gate.attach({ isLocked: () => false, getPublicAccount: () => ({ address: w.address }), async request({ params }) {
    await new Promise((resolve) => setImmediate(resolve));
    answers.push(['injected', await gate.approve({ method: 'sign', address: w.address, message: 'opaque server bytes' })]);
    answers.push(['derived', await gate.approve({ method: 'sign', address: w.address, message: params[0] })]);
    return { success: false, error: { code: 'user_rejected' } };
  } });
  await gate.open(intent);
  await assert.rejects(gate.signIdentity(identityFor(p, w.address, intent.identity.presentedAt).bundle), mismatch('bytes'));
  assert.deepEqual(answers[0], ['injected', false]);
});

test('the wallet canonical form equals the SDK JCS form', () => {
  const samples = [{ b: 1, a: [true, null, 'x'], c: { 'é': 'Café', z: -5 } }, { 'é': 1, e: 2 }, [1, 'a/b', ' ', { y: 0, x: [] }]];
  for (const value of samples) assert.equal(canonicalJson(value), canonicalize(value));
  assert.throws(() => canonicalJson({ big: 2 ** 60 }), IntentMismatch);
  assert.throws(() => canonicalJson({ s: '\uD800' }), IntentMismatch);
});
