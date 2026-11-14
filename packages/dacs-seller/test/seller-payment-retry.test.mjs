// A payment answer that is not final is never cached as final. The real HTTP
// handler, SQLite transport journal and buyer/seller transport signatures; the
// agent is a counting facade that returns the seller agent's own transient
// answers (indeterminate before the evidence checkpoint, held after it, a
// delivery not done yet), then the delivered answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireContinuationFixture, wireRouteFixture } from './helpers/wire-continuation-fixture.mjs';
import { testWallet, NOW, JOB, buyer as fixtureBuyer, seller as fixtureSeller } from './helpers/protocol-fixture.mjs';
import * as listingApi from '../src/dacs/listing.mjs';
import { agreementInput, listingPin } from '../src/dacs/purchase-protocol.mjs';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as core from '@kynesyslabs/dacs';
import * as transport from '../src/index.mjs';
import { createSellerTransportStore } from './helpers/bound-transport-store.mjs';
import { transportOutcome } from '../src/dacs/seller-agent.mjs';
const seller={...transport,...listingApi,agreementInput,listingPin,createSellerTransportStore};
import { DACS_SELLER_HTTP_DOMAINS, inspectWireOperation } from '@kynesyslabs/dacs/wire';

let walletSequence=60;
function key() { const w=testWallet(walletSequence++);return {...w,sign:w.signBytes,signWallet:message=>'0x'+w.signBytes(Buffer.from(message)).toString('hex')}; }
const DELIVERED = { status: 'payment-evidenced', delivery: { status: 'delivered' } };
const LEASE_MS = 1000;

async function world(t, answers, { proposalAnswers = [{ disposition: 'complete', contribution: null }] } = {}) {
  const retained = await wireContinuationFixture(t);
  const sellerKey = { ...fixtureSeller, sign: fixtureSeller.signBytes }, buyerKey = { ...fixtureBuyer, sign: fixtureBuyer.signBytes };
  const listing=retained.listing,pin=listingPin(listing);
  const jobId = JOB, buyerBundle = retained.request.buyerIdentityBundle;
  const plan = retained.request.proposal.plan;
  const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
  const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
  const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-payment-retry-')));
  let time = NOW;
  const clock = () => time;
  const store = seller.createSellerTransportStore({ path: join(dir, 'peer.sqlite'),now:clock });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = [];
  let proposalCalls = 0;
  // The durable agent already committed this job; the host holds it from the proposal its wire route admitted, which is when the store keeps the tuple.
  const facade = { claim: sellerKey.claim, listingPin: pin, transportAgreementOf: id => proposalCalls === 0 ? null : retained.agent().transportAgreementOf(id), continuationEvidenceOf: id => retained.agent().continuationEvidenceOf(id),
    receiveProposal: async () => structuredClone(proposalAnswers[Math.min(proposalCalls++, proposalAnswers.length - 1)]),
    retainsPaymentClaim:()=>false, retainsProposalWork: () => false, revalidateCompletedAnswer: async () => {}, assertSettlementCredit: () => {},
    submitPayment: async (body) => {
      calls.push(body.txHash);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer === THROW) throw new Error('TEST the claim outcome is unknown');
      return structuredClone(answer);
    },
    // An explicit reconciliation-capable double: it runs the command again and classifies the answer as a first run does.
    reconcileTransport: async ({ request, body, transport }) => {
      transport.claim();
      const answer = await (request.path === '/dacs/v1/payments' ? facade.submitPayment(body) : facade.receiveProposal(body));
      const outcome = transportOutcome(request.path, { answer }, { retained: false });
      await transport.settle(outcome);
      return outcome;
    } };
  const { wire, buyerWire } = await wireRouteFixture(t, { agent: facade, listing, buyer: buyerKey, seller: sellerKey, store, now: clock, leaseMs: LEASE_MS });
  const handle = seller.createSellerHttpHandler(facade, { wire, authentication: seller.createSellerTransportServerAuth({ sellerSigner: { claim: sellerKey.claim, sign: sellerKey.sign }, listingPin: pin, store,now:()=>NOW }) });
  const fetchImpl = async (url, init) => {
    const req = Readable.from([Buffer.from(init.body)]);
    Object.assign(req, { url: new URL(url).pathname, method: init.method, headers: { ...init.headers }, socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } });
    const res = { destroyed: false, writableEnded: false, headersSent: false, status: 0, headers: {}, text: '',
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(text) { this.text = String(text); this.writableEnded = true; } };
    await handle(req, res);
    return new Response(res.text, { status: res.status, headers: res.headers });
  };
  const client = seller.createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl,
    authentication: buyerWire.authentication(() => plan.agreementHash) });
  await client.propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle });
  const claim = { jobId, txHash: 'a1'.repeat(32), payerPayingKey: buyerKey.claim, nativePaymentEvidence: 'sdk-pay-dem-intake-native-evidence/loopback-v1' };
  const pay = async (body = claim) => { try { return await client.submitPayment(body); } catch (error) { return { error: error.code, status: error.status }; } };
  // The open attempt's lease ends: the next request recovers it.
  const lapse = () => { time += LEASE_MS; };
  return { calls, claim, pay, lapse, wire, proposalCalls: () => proposalCalls,
    propose: () => client.propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle }) };
}

test('a payment answered indeterminate before the evidence checkpoint ends null, and the next request is recover; with a reconciliation-capable agent double the same claim and a corrected claim reach intake again', async (t) => {
  const w = await world(t, [{ status: 'indeterminate', reason: 'demos-pending' }, DELIVERED]);
  assert.deepEqual(await w.pay(), { status: 'indeterminate', reason: 'demos-pending' });
  assert.deepEqual(await w.pay(), DELIVERED, 'the null end let the next request recover at once: the transfer, now included, reaches payment intake');
  assert.deepEqual(await w.pay(), DELIVERED, 'the completed delivery is authenticated again by the agent');
  assert.equal(w.calls.length, 3);
  const corrected = await world(t, [{ status: 'indeterminate', reason: 'demos-not-found' }, DELIVERED]);
  await corrected.pay({ ...corrected.claim, txHash: 'b2'.repeat(32) });
  assert.deepEqual(await corrected.pay(), DELIVERED, 'nothing was bound to the first body');
  assert.deepEqual(corrected.calls, ['b2'.repeat(32), corrected.claim.txHash]);
});

const HELD = { status: 'held', reason: 'native-payment-evidence-not-anchored', readback: 'absent' };

test('a held answer is recovered by the next request on a fresh nonce, without waiting for a lease', async (t) => {
  const w = await world(t, [HELD, HELD, DELIVERED]);
  assert.deepEqual(await w.pay(), HELD);
  assert.deepEqual(await w.pay({ ...w.claim, txHash: `0x${w.claim.txHash}` }), HELD, 'the same transaction in its other form reads back again');
  assert.deepEqual(await w.pay(), DELIVERED, 'the agent\'s retained work reads the anchor back and delivers');
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.equal(w.calls.length, 4, 'every request reached the agent, and the delivered claim is put to the agent again');
});

// The journal allows 16 superseded attempts, meant for crashes; a normal "not final yet" answer must never spend one.
const HELD_POLLS = 20;
const journalOf = (w) => inspectWireOperation(w.wire.journal, { seller: fixtureSeller.claim, jobId: JOB, path: '/dacs/v1/payments' });

test('a payment held twenty times is answered by the agent each time and then delivered, without spending crash attempts', async (t) => {
  const w = await world(t, [...Array(HELD_POLLS).fill(HELD), DELIVERED]);
  for (let poll = 0; poll < HELD_POLLS; poll++) assert.deepEqual(await w.pay(), HELD, `poll ${poll}`);
  const view = journalOf(w);
  assert.deepEqual([view.state, view.attempt, view.superseded], ['ended', HELD_POLLS - 1, 0], 'every held poll ended its attempt cleanly');
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.equal(w.calls.length, HELD_POLLS + 1, 'the agent saw every poll');
});

test('an uncertain payment answer keeps its attempt open until the lease, then the next request recovers', async (t) => {
  const w = await world(t, [THROW, DELIVERED]);
  assert.deepEqual(await w.pay(), { error: 'seller_unavailable', status: undefined });
  assert.equal(journalOf(w).state, 'pending', 'an unsettled attempt is not ended by the host');
  assert.deepEqual(await w.pay(), { error: 'seller_unavailable', status: undefined }, 'inside the lease the open attempt is pending');
  w.lapse();
  assert.deepEqual(await w.pay(), DELIVERED, 'the lease ran out; the next request recovers');
  assert.equal(journalOf(w).state, 'completed');
});

test('evidenced payment with a delivery not done yet is retried until the delivery is final', async (t) => {
  const pending = [
    { status: 'payment-evidenced', delivery: { status: 'held', reason: 'delivery readback absent' } },
    { status: 'payment-evidenced', delivery: 'held-missing-consumed-v2-fulfilment-and-Vet-audit' },
    { status: 'payment-evidenced', delivery: { status: 'delivery-ready', evidencePublication: 'held-readback-only' } },
  ];
  const w = await world(t, [...pending, DELIVERED]);
  for (const answer of pending) assert.deepEqual(await w.pay(), answer, 'each poll recovers at once');
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.deepEqual(await w.pay(), DELIVERED);
  assert.equal(w.calls.length, 5);
});

test('a waiting proposal keeps its HTTP retry slot until the durable responder completes', async (t) => {
  const w = await world(t, [], { proposalAnswers: [{ disposition: 'waiting', stage: 'lease', reason: 'TEST another worker holds the lease' }, { disposition: 'complete', contribution: null }] });
  assert.equal(w.proposalCalls(), 1);
  assert.equal((await w.propose()).disposition, 'complete', 'the waiting proposal recovers at once');
  assert.equal(w.proposalCalls(), 2);
  assert.equal((await w.propose()).disposition, 'complete');
  assert.equal(w.proposalCalls(), 2, 'only the completed proposal is stored');
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

// An expired session delegation on a wire effect route refuses before reading back
// what the journal already holds (docs/SELLER-SESSION-DELEGATION.md). Running
// a payment claim again can sign and send (a new evidence CREATE): never then.
const THROW = Symbol('throw');
// `publication` models an agent whose delivery-evidence publication is switched
// on at the operator's request: while enabled, the delivered answer it would
// give carries a new evidence CREATE. The transport must never let an expired
// delegation run the claim again, so that CREATE must never be asked for.
async function delegatedWorld(t, answers, publication = null) {
  const retained = await wireContinuationFixture(t);
  const sellerKey = { ...fixtureSeller, sign: fixtureSeller.signBytes }, buyerKey = { ...fixtureBuyer, sign: fixtureBuyer.signBytes }, sessionKey = key();
  let time = NOW;
  const clock = () => time;
  const listing=retained.listing,pin=listingPin(listing);
  const jobId = JOB, buyerBundle = retained.request.buyerIdentityBundle;
  const plan = retained.request.proposal.plan;
  const buyerContribution = await core.createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyerKey.claim, algorithm: 'ed25519', sign: buyerKey.sign });
  const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: core.sha256Hex(core.canonicalize(material)) };
  const transportIdentity = { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: buyerKey.claim, seller: sellerKey.claim, proposalHash: proposal.proposalHash };
  const deadline = plan.draft.terms.deadline;
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyerKey.claim, sessionPublicKey: sessionKey.claim.slice('did:demos:agent:'.length), seller: sellerKey.claim,
    listingPin: pin, jobId, notBefore: time - 1000, expiresAt: Math.min(time + 600000, deadline) };
  const delegation = { payload, signature: '' };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seller-payment-retry-delegated-')));
  const store = seller.createSellerTransportStore({ path: join(dir, 'peer.sqlite'), now: clock });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = [], reconciles = [];
  let proposed = false;
  // The durable agent already committed this job; the host holds it from the proposal its wire route admitted, which is when the store keeps the tuple.
  const facade = { claim: sellerKey.claim, listingPin: pin, transportAgreementOf: id => proposed ? retained.agent().transportAgreementOf(id) : null, continuationEvidenceOf: id => retained.agent().continuationEvidenceOf(id),
    receiveProposal: async () => { proposed = true; return { disposition: 'complete', contribution: null }; },
    retainsPaymentClaim: () => false, assertSettlementCredit: () => {},
    submitPayment: async (body) => {
      calls.push(body.txHash);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer === THROW) throw new Error('TEST the claim outcome is unknown');
      if (publication?.enabled && answer?.delivery?.status === 'delivered') publication.calls.push(body.txHash);
      return structuredClone(answer);
    },
    // An agent that would run the claim again: the transport must not let it under an expired delegation.
    reconcileTransport: async (input) => { reconciles.push(input.readOnly === true); return { disposition: 'retry', value: DELIVERED }; } };
  const { wire, buyerWire } = await wireRouteFixture(t, { agent: facade, listing, buyer: buyerKey, seller: sellerKey, store, now: clock, requireDelegation: true });
  payload.profile = wire.binding.profile;
  delegation.signature = buyerKey.sign(Buffer.from(DACS_SELLER_HTTP_DOMAINS.delegation + core.canonicalize(payload))).toString('base64url');
  const handle = seller.createSellerHttpHandler(facade, { wire, authentication: seller.createSellerTransportServerAuth({ sellerSigner: { claim: sellerKey.claim, sign: sellerKey.sign }, listingPin: pin, store,
    now: clock, requireDelegation: true }) });
  let lastResponse;
  const fetchImpl = async (url, init) => {
    const req = Readable.from([Buffer.from(init.body)]);
    Object.assign(req, { url: new URL(url).pathname, method: init.method, headers: { ...init.headers }, socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } });
    const res = { destroyed: false, writableEnded: false, headersSent: false, status: 0, headers: {}, text: '',
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(text) { this.text = String(text); this.writableEnded = true; } };
    await handle(req, res);
    lastResponse = { status: res.status, body: JSON.parse(res.text) };
    return new Response(res.text, { status: res.status, headers: res.headers });
  };
  let nonce = 0;
  const client = seller.createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl,
    authentication: {
      request: async (path, body, text) => {
        if (clock() < payload.expiresAt) return buyerWire.signRequest(path, body, { jobId, agreementHash: plan.agreementHash, text, signer: sessionKey, delegation });
        const request = { version: '1', kind: 'request', method: 'POST', path, bodyHash: core.sha256Hex(text), jobId, buyer: buyerKey.claim, seller: sellerKey.claim,
          listingPin: pin, agreementHash: plan.agreementHash, nonce: Buffer.alloc(24, ++nonce).toString('base64url'), expiresAt: clock() + 30000, profile: wire.binding.profile };
        const signature = sessionKey.sign(Buffer.from(DACS_SELLER_HTTP_DOMAINS.request + core.canonicalize(request))).toString('base64url');
        return { payload: request, header: Buffer.from(core.canonicalize({ payload: request, signature, delegation })).toString('base64url') };
      },
      verifyResponse: buyerWire.authentication(() => plan.agreementHash).verifyResponse,
    } });
  assert.equal((await client.propose({ proposal, transportIdentity, buyerIdentityBundle: buyerBundle })).disposition, 'complete');
  const claim = { jobId, txHash: 'a1'.repeat(32), payerPayingKey: buyerKey.claim, nativePaymentEvidence: 'sdk-pay-dem-intake-native-evidence/loopback-v1' };
  const pay = async (body = claim) => { try { return await client.submitPayment(body); } catch (error) { if (clock() >= payload.expiresAt) assert.deepEqual({ status: lastResponse.status, error: lastResponse.body.error }, { status: 408, error: 'peer_delegation_expired' }); return { error: error.code, status: error.status }; } };
  return { calls, reconciles, claim, pay, publication, expire: () => { time = payload.expiresAt + 1; } };
}

test('a held payment claim is not run again once its session delegation expired: the wire refuses and the agent is not called', async (t) => {
  const held = { status: 'held', reason: 'native-payment-evidence-anchor-sent-not-read-back' };
  const w = await delegatedWorld(t, [held, DELIVERED]);
  assert.deepEqual(await w.pay(), held);
  assert.equal(w.calls.length, 1);
  w.expire();
  assert.deepEqual(await w.pay(), { error: 'seller_unavailable', status: undefined });
  assert.deepEqual(await w.pay(), { error: 'seller_unavailable', status: undefined });
  assert.equal(w.calls.length, 1, 'the claim never runs again under the expired delegation');
});

test('an uncertain payment claim is refused before reconciliation once its session delegation expired', async (t) => {
  const w = await delegatedWorld(t, [THROW, DELIVERED]);
  assert.deepEqual(await w.pay(), { error: 'seller_unavailable', status: undefined });
  w.expire();
  assert.deepEqual(await w.pay(), { error: 'seller_unavailable', status: undefined }, 'expired effect is refused');
  assert.deepEqual(w.reconciles, [], 'expired effect never reconciles through the agent');
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
    assert.deepEqual(held, { error: 'seller_unavailable', status: undefined });
  }
  assert.equal(w.calls.length, agentCalls, 'the claim never runs again under the expired delegation');
  assert.equal(publication.calls.length, publications, 'no delivery evidence CREATE is asked for after expiry');
});
