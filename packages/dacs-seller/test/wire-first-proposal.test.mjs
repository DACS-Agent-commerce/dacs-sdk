import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateCanonicalJobId } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS, openWireRequestJournal, signWireResponse } from '@kynesyslabs/dacs/wire';
import { fixtureIdentityBundle, fixtureListing } from './fixtures/listings.mjs';
import { testWallet } from './helpers/protocol-fixture.mjs';
import { FIXTURE_ENDPOINT, wireBuyer } from './helpers/wire-buyer.mjs';
import { exchange } from './helpers/d5-http-fixture.mjs';
import { createSellerAgentClient, createSellerHttpHandler } from '../src/dacs/seller-http.mjs';
import { createSellerAgentClient as createBuyerSellerAgentClient } from '../../dacs-client/src/dacs/seller-http.mjs';
import { createSellerWireClientAuth } from '../src/dacs/seller-wire-client-auth.mjs';
import { createWireContext } from '../src/dacs/seller-wire-requests.mjs';
import { SELLER_TRANSPORT_HEADER, createSellerTransportStore, createSellerTransportServerAuth } from '../src/dacs/seller-transport-auth.mjs';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from '../../dacs-client/test/helpers/purchase-admission-hook.mjs';

installPurchaseAdmissionHook();
const { setPurchaseAdmission } = await loadAdmissionDouble();
setPurchaseAdmission('testnet-tp1');
const { exchangeAgreement, planAgreement, listingPin } = await import('../../dacs-client/src/dacs/purchase-protocol.mjs');
const T0 = Date.UTC(2026, 9, 27, 12);
const JOURNAL_LEASE_MS = 300_000;

// The real buyer coordinator, wire authentication, HTTP client, handler and durable
// transport store. The agent retains the exact proposal; contribution/anchor work
// is deliberately unreachable so each case stops at the boundary under review.
// `clientPackage` drives the buyer's own HTTP client (packages/dacs-client) instead of the seller package's.
async function firstProposalWorld(t, { clientPackage = false, timeoutMs } = {}) {
  mock.method(Date, 'now', () => T0);
  t.after(() => mock.restoreAll());
  const directory = await mkdtemp(join(tmpdir(), 'TEST-first-proposal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const buyer = testWallet(1), seller = testWallet(2);
  const buyerSigner = { claim: buyer.claim, sign: buyer.signBytes };
  const sellerSigner = { claim: seller.claim, sign: seller.signBytes };
  const listing = fixtureListing(seller, { now: T0 });
  const pin = listingPin(listing), buyerBundle = fixtureIdentityBundle(buyer, T0);
  const jobId = generateCanonicalJobId({ timestamp: T0, entropy: new Uint8Array(10).fill(0x11) });
  const planned = planAgreement({ jobId, listing, buyerBundle, generatedAt: T0 });
  const clock = () => T0;
  const wire = await wireBuyer({ buyer: buyerSigner, seller: sellerSigner, listingPin: pin, clock });
  // The binding's local connection is host-owned, and the same as wireBuyer's.
  const { TEST_CONNECTION, authorityReader } = await import('./helpers/wire-authority-fixture.mjs');
  const connection = () => ({ ...TEST_CONNECTION });
  const authentication = createSellerWireClientAuth({ signer: buyerSigner, binding: wire.binding, connection,
    endpointProof: wire.endpointProof, publicEndpoint: FIXTURE_ENDPOINT, seller: seller.claim, now: clock,
    resolveJob: () => ({ listingPin: pin, agreementHash: planned.plan.agreementHash, deadline: planned.draft.terms.deadline }) });
  let request, proposal = null;
  const effects = { proposals: 0, reads: 0, anchors: 0 };
  const responses = [];
  const faults = { before: async () => {}, answer: async (answer) => answer, verify: (auth, ...args) => auth.verifyResponse(...args) };
  const agent = { claim: seller.claim, listingPin: pin,
    transportAgreementOf: () => proposal?.plan.draft ?? null,
    continuationEvidenceOf: () => null,
    assertSettlementCredit: () => {},
    receiveProposal: async (body) => { effects.proposals++; proposal = structuredClone(body.proposal); return { disposition: 'complete' }; },
    agreementState: () => { effects.reads++; return { proposal: structuredClone(proposal), contribution: null }; } };
  const store = createSellerTransportStore({ path: join(directory, 'transport.sqlite'), now: clock });
  t.after(() => store.close());
  const serverAuth = createSellerTransportServerAuth({ sellerSigner, listingPin: pin, store, now: clock });
  const journal = openWireRequestJournal(await mkdtemp(join(directory, 'wire-')), { leaseMs: JOURNAL_LEASE_MS, clock });
  const hostWire = createWireContext({ binding: wire.binding, tp1Network: { connection, readAuthority: authorityReader() }, signer: sellerSigner,
    journal, store, ready: () => true, now: clock, agent, requireDelegation: false,
    readCommitmentReceipt: () => { throw new Error('TEST commitment read must not run'); } });
  const handler = createSellerHttpHandler(agent, { authentication: serverAuth, wire: hostWire });
  const client = (clientPackage ? createBuyerSellerAgentClient : createSellerAgentClient)({ url: 'http://127.0.0.1:1', ...(timeoutMs === undefined ? {} : { timeoutMs }), authentication: {
    request: async (...args) => { const signed = await authentication.request(...args); request = signed.payload; return signed; },
    verifyResponse: (...args) => faults.verify(authentication, ...args),
  }, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    await faults.before(path);
    const answer = await exchange(handler, { url: path, text: options.body, header: options.headers[SELLER_TRANSPORT_HEADER] });
    const final = await faults.answer(answer, path);
    responses.push({ path, status: final.status, error: JSON.parse(final.text).error, signed: Boolean(final.headers[SELLER_TRANSPORT_HEADER]) });
    return new Response(final.text, { status: final.status, headers: final.headers });
  } });
  const signedError = async (code, status) => {
    const text = JSON.stringify({ error: code });
    const signed = await signWireResponse(request, status, text, { signer: sellerSigner, binding: wire.binding,
      local: connection(), purchaseProfile: wire.binding.profile, now: T0 });
    return { text, status, headers: { 'content-type': 'application/json', [SELLER_TRANSPORT_HEADER]: signed } };
  };
  const run = () => exchangeAgreement({ ...planned, buyerClaim: buyer.claim, buyerBundle,
    agreementSignature: buyer.signBytes(Buffer.from(planned.agreementMessage)).toString('hex'), seller: client,
    anchorAdapter: { anchorAgreement: () => { effects.anchors++; throw new Error('TEST anchor must not run'); },
      reconcileAgreementAnchor: () => { throw new Error('TEST anchor read must not run'); }, verifyAnchorReceipt: () => 'indeterminate' } });
  return { run, effects, faults, signedError, client, responses, proposal: () => proposal };
}

test('P11b1L2-T01: the coordinator publishes its first proposal after a verified signed unknown-job state read', async (t) => {
  const w = await firstProposalWorld(t);
  const result = await w.run();
  assert.equal(result.disposition, 'waiting', JSON.stringify({ result, responses: w.responses }));
  assert.equal(result.stage, 'seller-contribution');
  assert.deepEqual(w.responses[0], { path: PATHS.state, status: 404, error: 'peer_unknown_job', signed: true });
  assert.deepEqual(w.effects, { proposals: 1, reads: 2, anchors: 0 });
  assert.ok(w.proposal());
});

test('P11b1L2-T02: unsigned, invalidly signed and changed-body unknown-job answers authorize no proposal', async (t) => {
  const w = await firstProposalWorld(t);
  for (const kind of ['unsigned', 'signature', 'body']) {
    w.faults.answer = async (answer) => {
      if (kind === 'unsigned') delete answer.headers[SELLER_TRANSPORT_HEADER];
      if (kind === 'signature') answer.headers[SELLER_TRANSPORT_HEADER] = 'TEST-invalid-signature';
      if (kind === 'body') answer.text = JSON.stringify({ error: 'peer_unknown_job', message: 'TEST changed body' });
      return answer;
    };
    assert.equal((await w.run()).disposition, 'indeterminate', kind);
    assert.equal(w.client.failureCause, 'response-auth', kind);
    assert.deepEqual(w.effects, { proposals: 0, reads: 0, anchors: 0 });
  }
});

test('P11b1L2-T03: other signed refusals and an unknown-job code with another status retain their classifications', async (t) => {
  const w = await firstProposalWorld(t);
  for (const [code, status, expected] of [['peer_expired', 408, 'indeterminate'], ['peer_listing_mismatch', 409, 'rejected'],
    ['peer_unknown_job', 409, 'rejected'], ['seller_not_ready', 503, 'indeterminate']]) {
    w.faults.answer = () => w.signedError(code, status);
    assert.equal((await w.run()).disposition, expected, code);
    assert.equal(w.effects.proposals, 0);
  }
  assert.equal(w.effects.anchors, 0);
});

test('P11b1L2-T04: a failed state read sends no proposal and a fresh coordinator retries the source read', async (t) => {
  const w = await firstProposalWorld(t);
  w.faults.before = async () => { throw Object.assign(new Error('TEST state read timeout'), { name: 'TimeoutError' }); };
  assert.equal((await w.run()).disposition, 'indeterminate');
  assert.equal(w.client.failureCause, 'timeout');
  assert.equal(w.effects.proposals, 0);
  w.faults.before = async () => {};
  assert.equal((await w.run()).disposition, 'waiting');
  assert.equal(w.effects.proposals, 1);
});

test('P11b1L2-T05: a restart after verified absence and before proposal dispatch publishes exactly once', async (t) => {
  const w = await firstProposalWorld(t);
  w.faults.before = async (path) => { if (path === PATHS.proposals) throw new Error('TEST process ended before dispatch'); };
  assert.equal((await w.run()).disposition, 'indeterminate');
  assert.equal(w.effects.proposals, 0);
  w.faults.before = async () => {};
  assert.equal((await w.run()).disposition, 'waiting');
  assert.equal(w.effects.proposals, 1);
});

test('P11b1L2-T06: a restart after proposal acceptance and a lost answer reads the exact retained proposal without resending', async (t) => {
  const w = await firstProposalWorld(t);
  w.faults.answer = async (answer, path) => { if (path === PATHS.proposals) throw new Error('TEST accepted answer lost'); return answer; };
  assert.equal((await w.run()).disposition, 'indeterminate');
  assert.equal(w.effects.proposals, 1);
  const accepted = structuredClone(w.proposal());
  w.faults.answer = async (answer) => answer;
  assert.equal((await w.run()).disposition, 'waiting');
  assert.equal((await w.run()).disposition, 'waiting');
  assert.equal(w.effects.proposals, 1);
  assert.deepEqual(w.proposal(), accepted);
});

test('P11b1L2-T07: unknown-job during seller-contribution lookup stays rejected and never resends the proposal', async (t) => {
  const w = await firstProposalWorld(t);
  let stateReads = 0;
  w.faults.answer = async (answer, path) => path === PATHS.state && ++stateReads === 3 ? w.signedError('peer_unknown_job', 404) : answer;
  const result = await w.run();
  assert.equal(result.disposition, 'rejected');
  assert.equal(result.stage, 'seller-contribution');
  assert.equal(w.effects.proposals, 1);
});

test('P11b1L2-T08: unknown-job from proposal publication stays rejected with no automatic resend', async (t) => {
  const w = await firstProposalWorld(t);
  w.faults.answer = async (answer, path) => path === PATHS.proposals ? w.signedError('peer_unknown_job', 404) : answer;
  const result = await w.run();
  assert.equal(result.disposition, 'rejected');
  assert.equal(result.stage, 'proposal-publication');
  assert.equal(w.effects.proposals, 1);
});

test('P11b1L2-T09: the buyer package client waits for the wire verifier, so a verified unknown-job answer publishes and a verified refusal stays rejected', async (t) => {
  const w = await firstProposalWorld(t, { clientPackage: true });
  const result = await w.run();
  assert.equal(result.disposition, 'waiting', JSON.stringify({ result, responses: w.responses }));
  assert.deepEqual(w.effects, { proposals: 1, reads: 2, anchors: 0 });
  const refused = await firstProposalWorld(t, { clientPackage: true });
  refused.faults.answer = () => refused.signedError('peer_unknown_job', 409);
  assert.equal((await refused.run()).disposition, 'rejected');
  assert.equal(refused.effects.proposals, 0);
});

test('P11b1L2-T10: the buyer package client treats unsigned, invalidly signed and changed-body unknown-job answers as unavailable, with no proposal', async (t) => {
  const w = await firstProposalWorld(t, { clientPackage: true });
  for (const kind of ['unsigned', 'signature', 'body']) {
    w.faults.answer = async (answer) => {
      if (kind === 'unsigned') delete answer.headers[SELLER_TRANSPORT_HEADER];
      if (kind === 'signature') answer.headers[SELLER_TRANSPORT_HEADER] = 'TEST-invalid-signature';
      if (kind === 'body') answer.text = JSON.stringify({ error: 'peer_unknown_job', message: 'TEST changed body' });
      return answer;
    };
    assert.equal((await w.run()).disposition, 'indeterminate', kind);
    assert.equal(w.client.failureCause, 'response-auth', kind);
    assert.deepEqual(w.effects, { proposals: 0, reads: 0, anchors: 0 });
  }
});

test('P11b1L2-T11: a wire verifier that never answers ends the buyer package client call at its deadline with no proposal', async (t) => {
  const w = await firstProposalWorld(t, { clientPackage: true, timeoutMs: 100 });
  w.faults.verify = () => new Promise(() => {});
  // The abort timer is unref'd; nothing else keeps the test's event loop alive while the verifier hangs.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  assert.equal((await w.run()).disposition, 'indeterminate');
  assert.equal(w.client.failureCause, 'timeout');
  assert.deepEqual(w.effects, { proposals: 0, reads: 0, anchors: 0 });
});
