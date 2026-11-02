// A payment answer that is not final is never cached as final. The real HTTP
// handler, SQLite transport journal and buyer/seller transport signatures; the
// agent is a counting facade that returns the seller agent's own transient
// answers (indeterminate before the evidence checkpoint, held after it, a
// delivery not done yet), then the delivered answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testWallet, NOW, JOB } from './helpers/protocol-fixture.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import * as listingApi from '../src/dacs/listing.mjs';
import { agreementInput, listingPin } from '../src/dacs/purchase-protocol.mjs';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as core from '@kynesyslabs/dacs';
import * as transport from '../src/index.mjs';
const seller={...transport,...listingApi,agreementInput,listingPin};
import { sellerSessionDelegationSigningBytes } from '../src/dacs/seller-transport-auth.mjs';

let walletSequence=60;
function key() { const w=testWallet(walletSequence++);return {...w,sign:w.signBytes,signWallet:message=>'0x'+w.signBytes(Buffer.from(message)).toString('hex')}; }
const identityFor = (party, presentedAt) => {
  const unsigned = seller.buildUnsignedIdentityBundle({ address: party.address, presentedAt, sessionSeed: 'payment-retry' });
  return seller.attachIdentityPresentation(unsigned, party.signWallet(unsigned.message));
};
const DELIVERED = { status: 'payment-evidenced', delivery: { status: 'delivered' } };

async function world(t, answers, { proposalAnswers = [{ disposition: 'complete', contribution: null }] } = {}) {
  const sellerKey = key(), buyerKey = key(), now = NOW;
  const listing=fixtureListing(sellerKey,{now}),pin=listingPin(listing);
  const jobId = JOB, buyerBundle = identityFor(buyerKey, now);
  const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: now })));
  const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
  const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
  const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-payment-retry-')));
  const store = seller.createSellerTransportStore({ path: join(dir, 'peer.sqlite'),now:()=>NOW });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = [];
  let proposalCalls = 0;
  const facade = { claim: sellerKey.claim, listingPin: pin,
    receiveProposal: async () => structuredClone(proposalAnswers[Math.min(proposalCalls++, proposalAnswers.length - 1)]),
    retainsPaymentClaim:()=>false,
    submitPayment: async (body) => { calls.push(body.txHash); return structuredClone(answers[Math.min(calls.length - 1, answers.length - 1)]); } };
  const handle = seller.createSellerHttpHandler(facade, { authentication: seller.createSellerTransportServerAuth({ sellerSigner: { claim: sellerKey.claim, sign: sellerKey.sign }, listingPin: pin, store,now:()=>NOW }) });
  const fetchImpl = async (url, init) => {
    const req = Readable.from([Buffer.from(init.body)]);
    Object.assign(req, { url: new URL(url).pathname, method: init.method, headers: { ...init.headers }, socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } });
    const res = { destroyed: false, writableEnded: false, headersSent: false, status: 0, headers: {}, text: '',
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(text) { this.text = String(text); this.writableEnded = true; } };
    await handle(req, res);
    return new Response(res.text, { status: res.status, headers: res.headers });
  };
  const client = seller.createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl,
    authentication: seller.createSellerTransportClientAuth({ buyerSigner: { claim: buyerKey.claim, sign: buyerKey.sign }, seller: sellerKey.claim,
      now:()=>NOW,resolveJob: () => ({ listingPin: pin, agreementHash: plan.agreementHash }) }) });
  await client.propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle });
  const claim = { jobId, txHash: 'a1'.repeat(32), payerPayingKey: buyerKey.claim, nativePaymentEvidence: 'sdk-pay-dem-intake-native-evidence/loopback-v1' };
  const pay = async (body = claim) => { try { return await client.submitPayment(body); } catch (error) { return { error: error.code, status: error.status }; } };
  return { calls, claim, pay, proposalCalls: () => proposalCalls,
    propose: () => client.propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle }) };
}

test('an indeterminate answer before the evidence checkpoint keeps nothing: the same claim reaches intake again and the delivery is then final', async (t) => {
  const w = await world(t, [{ status: 'indeterminate', reason: 'demos-pending' }, DELIVERED]);
  assert.deepEqual(await w.pay(), { status: 'indeterminate', reason: 'demos-pending' });
  assert.deepEqual(await w.pay(), DELIVERED, 'the transfer, now included, reaches payment intake');
  assert.deepEqual(await w.pay(), DELIVERED, 'the delivered answer is freshly authenticated');
  assert.equal(w.calls.length, 3);
  assert.deepEqual(await w.pay({ ...w.claim, txHash: `0x${w.claim.txHash}` }), { error: 'peer_operation_conflict', status: 409 }, 'a delivered job takes no other claim');
});

test('a corrected claim after an indeterminate answer is not a conflict: nothing was bound to the first body', async (t) => {
  const w = await world(t, [{ status: 'indeterminate', reason: 'demos-not-found' }, DELIVERED]);
  await w.pay({ ...w.claim, txHash: 'b2'.repeat(32) });
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.deepEqual(w.calls, ['b2'.repeat(32), w.claim.txHash]);
});

test('a held answer after the evidence checkpoint runs the agent again on a fresh nonce; another body still conflicts', async (t) => {
  const held = { status: 'held', reason: 'native-payment-evidence-not-anchored', readback: 'absent' };
  const w = await world(t, [held, held, DELIVERED]);
  assert.deepEqual(await w.pay(), held);
  assert.deepEqual(await w.pay({ ...w.claim, txHash: `0x${w.claim.txHash}` }), { error: 'peer_operation_conflict', status: 409 }, 'the held effect stays bound to its body');
  assert.deepEqual(await w.pay(), held, 'the readback is still absent');
  assert.deepEqual(await w.pay(), DELIVERED, 'the agent\'s retained work reads the anchor back and delivers');
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.equal(w.calls.length, 4, 'the conflicting body is refused; the completed claim authenticates again');
});

// Only payment claims and durable proposals resume through reconciliation.
// Other routes stay read-only; only unstarted payment claims may be released.
test('the transport store permits retained retries for payment claims and proposals, with payment-only release', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-payment-retry-store-')));
  const store = seller.createSellerTransportStore({ path: join(dir, 'peer.sqlite'),now:()=>NOW });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const jobId = JOB, reservation = { disposition: 'uncertain', effectKey: 'TEST-effect', owner: 'TEST-owner' };
  for (const path of ['/dacs/v1/commitments', '/dacs/v1/commitments/signature', '/dacs/v1/bundles/buyer-copy']) {
    assert.throws(() => store.reconcile(reservation, { jobId, path }, 200, '{}', { retry: true }), { code: 'peer_reconciliation_invalid' }, path);
    assert.throws(() => store.reconcile(reservation, { jobId, path }, 200, '{}', { noEffect: true }), { code: 'peer_reconciliation_invalid' }, `${path}: no release either`);
  }
  assert.throws(() => store.reconcile(reservation, { jobId, path: '/dacs/v1/payments' }, 200, '{}', { retry: true, noEffect: true }), { code: 'peer_reconciliation_invalid' });
  for (const path of ['/dacs/v1/payments', '/dacs/v1/agreements/proposals']) {
    assert.throws(() => store.reconcile(reservation, { jobId, path }, 200, '{}', { retry: true }), (error) => error.code !== 'peer_reconciliation_invalid',
      `${path} passes the guard and is checked against its retained effect`);
  }
  assert.throws(() => store.reconcile(reservation, { jobId, path: '/dacs/v1/agreements/proposals' }, 200, '{}', { noEffect: true }), error=>error.code==='peer_reconciliation_conflict');
});

test('evidenced payment with a delivery not done yet is retried until the delivery is final', async (t) => {
  const pending = [
    { status: 'payment-evidenced', delivery: { status: 'held', reason: 'delivery readback absent' } },
    { status: 'payment-evidenced', delivery: 'held-missing-consumed-v2-fulfilment-and-Vet-audit' },
    { status: 'payment-evidenced', delivery: { status: 'delivery-ready', evidencePublication: 'held-readback-only' } },
  ];
  const w = await world(t, [...pending, DELIVERED]);
  for (const answer of pending) assert.deepEqual(await w.pay(), answer);
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.equal(w.calls.length, 5);
});

// A session delegation admits a request after its expiry only to read back
// what the journal already holds (docs/SELLER-SESSION-DELEGATION.md). Running
// a payment claim again can sign and send (a new evidence CREATE): never then.
const THROW = Symbol('throw');
// `publication` models an agent whose delivery-evidence publication is switched
// on at the operator's request: while enabled, the delivered answer it would
// give carries a new evidence CREATE. The transport must never let an expired
// delegation run the claim again, so that CREATE must never be asked for.
async function delegatedWorld(t, answers, publication = null) {
  const sellerKey = key(), buyerKey = key(), sessionKey = key();
  let time = NOW;
  const clock = () => time;
  const listing=fixtureListing(sellerKey,{now:time}),pin=listingPin(listing);
  const jobId = JOB, buyerBundle = identityFor(buyerKey, time);
  const plan = core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(seller.agreementInput({ jobId, listing, buyerBundle, generatedAt: time })));
  const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
  const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
  const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
  const deadline = plan.draft.terms.deadline;
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyerKey.claim, sessionPublicKey: sessionKey.claim.slice('did:demos:agent:'.length), seller: sellerKey.claim,
    listingPin: pin, jobId, notBefore: time - 1000, expiresAt: Math.min(time + 600000, deadline) };
  const delegation = { payload, signature: buyerKey.sign(sellerSessionDelegationSigningBytes(payload)).toString('base64url') };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-payment-retry-delegated-')));
  const store = seller.createSellerTransportStore({ path: join(dir, 'peer.sqlite'), now: clock });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = [], reconciles = [];
  const facade = { claim: sellerKey.claim, listingPin: pin, transportAgreementOf: () => structuredClone(plan.draft),
    receiveProposal: async () => ({ disposition: 'complete', contribution: null }),
    submitPayment: async (body) => {
      calls.push(body.txHash);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer === THROW) throw new Error('TEST the claim outcome is unknown');
      if (publication?.enabled && answer?.delivery?.status === 'delivered') publication.calls.push(body.txHash);
      return structuredClone(answer);
    },
    // An agent that would run the claim again: the transport must not let it under an expired delegation.
    reconcileTransport: async (input) => { reconciles.push(input.readOnly === true); return { disposition: 'retry', value: DELIVERED }; } };
  const handle = seller.createSellerHttpHandler(facade, { authentication: seller.createSellerTransportServerAuth({ sellerSigner: { claim: sellerKey.claim, sign: sellerKey.sign }, listingPin: pin, store,
    now: clock, requireDelegation: true }) });
  const fetchImpl = async (url, init) => {
    const req = Readable.from([Buffer.from(init.body)]);
    Object.assign(req, { url: new URL(url).pathname, method: init.method, headers: { ...init.headers }, socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } });
    const res = { destroyed: false, writableEnded: false, headersSent: false, status: 0, headers: {}, text: '',
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(text) { this.text = String(text); this.writableEnded = true; } };
    await handle(req, res);
    return new Response(res.text, { status: res.status, headers: res.headers });
  };
  const client = seller.createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl,
    authentication: seller.createSellerTransportClientAuth({ sessionSigner: { claim: sessionKey.claim, sign: sessionKey.sign }, delegation, seller: sellerKey.claim,
      resolveJob: () => ({ listingPin: pin, agreementHash: plan.agreementHash, deadline }), now: clock }) });
  assert.equal((await client.propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle })).disposition, 'complete');
  const claim = { jobId, txHash: 'a1'.repeat(32), payerPayingKey: buyerKey.claim, nativePaymentEvidence: 'sdk-pay-dem-intake-native-evidence/loopback-v1' };
  const pay = async (body = claim) => { try { return await client.submitPayment(body); } catch (error) { return { error: error.code, status: error.status }; } };
  return { calls, reconciles, claim, pay, publication, expire: () => { time = payload.expiresAt + 1; } };
}

test('a held payment claim is not run again once its session delegation expired: the journal answers its last answer and the agent is not called', async (t) => {
  const held = { status: 'held', reason: 'native-payment-evidence-anchor-sent-not-read-back' };
  const w = await delegatedWorld(t, [held, DELIVERED]);
  assert.deepEqual(await w.pay(), held);
  assert.equal(w.calls.length, 1);
  w.expire();
  assert.deepEqual(await w.pay(), held, 'the last journaled answer, read back');
  assert.deepEqual(await w.pay(), held);
  assert.equal(w.calls.length, 1, 'the claim never runs again under the expired delegation');
});

test('an uncertain payment claim reconciles read only once its session delegation expired: it is not run again or handed back to the retry', async (t) => {
  const w = await delegatedWorld(t, [THROW, DELIVERED]);
  assert.deepEqual(await w.pay(), { error: 'seller_unavailable', status: undefined });
  w.expire();
  assert.deepEqual(await w.pay(), { error: 'seller_unavailable', status: undefined }, 'still uncertain');
  assert.deepEqual(w.reconciles, [true], 'the agent is asked to reconcile read only');
  assert.equal(w.calls.length, 1, 'and the claim never runs again');
});

// The saved answer alone does not authenticate current payment, Deliverable or
// delivery evidence, and re-running the claim under an expired delegation could
// publish a new evidence CREATE. Neither is allowed: the transport holds.
const DEFERRED = { status: 'payment-evidenced', delivery: { status: 'delivery-ready', evidencePublication: 'deferred-to-explicit-sdk-finaliser' } };
for (const [label, answers, enabled] of [
  ['delivery-ready', [DEFERRED, DELIVERED], false],
  ['delivered', [DELIVERED], true],
]) test(`a completed ${label} answer is held, never replayed unauthenticated, once its session delegation expired`, async (t) => {
  const publication = { enabled, calls: [] };
  const w = await delegatedWorld(t, answers, publication);
  const first = await w.pay();
  assert.equal(first.delivery?.status, label === 'delivered' ? 'delivered' : 'delivery-ready', 'the order completes');
  const agentCalls = w.calls.length, publications = publication.calls.length;
  w.expire();
  publication.enabled = true; // the operator switches publication on for the restarted seller
  for (let attempt = 0; attempt < 2; attempt++) {
    const held = await w.pay();
    assert.equal(held.status, 'held', 'a cached completion is not reported as success under an expired delegation');
    assert.match(held.reason ?? '', /delegation_expired/);
  }
  assert.equal(w.calls.length, agentCalls, 'the claim never runs again under the expired delegation');
  assert.equal(publication.calls.length, publications, 'no delivery evidence CREATE is asked for after expiry');
});

test('a waiting proposal keeps its HTTP retry slot until the durable responder completes', async (t) => {
  const w = await world(t, [], { proposalAnswers: [{ disposition: 'waiting', stage: 'lease', reason: 'TEST another worker holds the lease' }, { disposition: 'complete', contribution: null }] });
  assert.equal(w.proposalCalls(), 1);
  assert.equal((await w.propose()).disposition, 'complete');
  assert.equal(w.proposalCalls(), 2);
  assert.equal((await w.propose()).disposition, 'complete');
  assert.equal(w.proposalCalls(), 2, 'only the completed proposal is cached');
});
