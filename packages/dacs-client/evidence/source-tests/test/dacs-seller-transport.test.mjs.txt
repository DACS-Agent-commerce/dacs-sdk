// Offline transport tests. Every HTTP endpoint is an ephemeral loopback server;
// every signing key is fresh and local to its owning test peer. No real RPC,
// faucet, broadcast, wallet spend or independently established finality.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, contentHash, createFixedPriceAgreementSignatureContribution, generateCanonicalJobId, sha256Hex, bundleAddress } from '@kynesyslabs/dacs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { startChainFixture } from './fixtures/chain-server.mjs';
import { startAnchorFixture } from './dacs-loopback-fixture.test.mjs';
import { createSellerAgent, SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { createSellerAgentClient, createSellerHttpHandler, SellerRefusedError, SellerUnavailableError } from '../src/dacs/seller-http.mjs';
import { createSellerTransportClientAuth, createSellerTransportServerAuth, createSellerTransportStore, sellerTransportSigningBytes, sellerSessionDelegationSigningBytes, SELLER_TRANSPORT_HEADER } from '../src/dacs/seller-transport-auth.mjs';
import { buildUnsignedIdentityBundle, attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { createFixtureAnchorClient, anchorWriteMessage } from '../src/dacs/fixture-anchors.mjs';
import { planAgreement, listingPin, exchangeAgreement, readCommitment, agreementTerms, bundleSession, bundleSigningPlan, assembleBundleCopies, verifyPaymentEvidence, verifyDelivery, deliverableAddress, deliveryEvidenceAddress } from '../src/dacs/purchase-protocol.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { createPayDemSellerObserver, paymentEvidenceAddress } from '@kynesyslabs/dacs';

const PATHS = { proposal: '/dacs/v1/agreements/proposals', payment: '/dacs/v1/payments', commit: '/dacs/v1/commitments' };
const signer = (wallet) => ({ claim: wallet.claim, sign: wallet.signBytes });
const bundleFor = (wallet) => {
  const unsigned = buildUnsignedIdentityBundle({ address: wallet.address, presentedAt: Date.now(), sessionSeed: 'seller-transport-test' });
  return attachIdentityPresentation(unsigned, wallet.signHex(unsigned.message));
};
const signHeader = (payload, wallet) => Buffer.from(canonicalize({ payload, signature: wallet.signBytes(sellerTransportSigningBytes(payload)).toString('base64url') })).toString('base64url');
const closeServer = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

async function world(t, options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dacs-seller-peer-')));
  const seller = createEphemeralWallet();
  const testBuyer = createEphemeralWallet();
  const buyer = options.delegated ? createEphemeralWallet() : testBuyer;
  const sessions = new Map();
  const listing = fixtureListing(seller, { listingId: 'seller-transport-offline-report', price: '2.5' });
  const jobs = new Map();
  const counts = { proposal: 0, payment: 0, commit: 0, request: 0, countersign: 0, buyerCopy: 0 };
  const faults = { throwAfterPayment: false };
  const w = { directory, seller, buyer, testBuyer, sessions, delegated: options.delegated, listing, jobs, counts, faults, now: () => Date.now() };
  w.agent = options.agent ?? {
    claim: seller.claim, listingPin: listingPin(listing),
    transportAgreementOf: (id) => jobs.get(id)?.draft ?? null,
    receiveProposal: () => { counts.proposal++; return { disposition: 'complete', fixture: true }; },
    agreementState: () => ({ proposal: null, contribution: null }),
    commit: () => { counts.commit++; return { status: 'committed', fixture: true }; },
    submitPayment: () => {
      counts.payment++;
      if (faults.throwAfterPayment) throw new SellerAgentError('commitment_failed', 'write acknowledgement was lost', 422);
      return { status: 'delivered', fixture: true };
    },
    bundleRequest: () => { counts.request++; return { fixture: true, bundleHash: 'e'.repeat(64) }; },
    countersign: () => { counts.countersign++; return { status: 'seller-copy-anchored', fixture: true }; },
    confirmBuyerCopy: () => { counts.buyerCopy++; return { status: 'verified', fixture: true }; },
  };
  w.start = async (limits = options.limits ?? {}) => {
    w.store = createSellerTransportStore({ path: join(directory, 'transport.sqlite'), ...(options.maxRecords ? { maxRecords: options.maxRecords } : {}) });
    w.serverAuth = createSellerTransportServerAuth({ sellerSigner: signer(seller), listingPin: w.agent.listingPin, store: w.store, requireDelegation: Boolean(options.delegated), now: () => w.now() });
    w.server = http.createServer(createSellerHttpHandler(w.agent, { authentication: w.serverAuth, ...limits }));
    await new Promise((resolve) => w.server.listen(0, '127.0.0.1', resolve));
    w.url = `http://127.0.0.1:${w.server.address().port}`;
    w.auth = createSellerTransportClientAuth({ buyerSigner: signer(buyer), seller: seller.claim, resolveJob: (id) => jobs.get(id), now: () => w.now() });
    if (options.delegated) {
      const authFor = (id) => { const session = sessions.get(id); return createSellerTransportClientAuth({ sessionSigner: signer(session.key), delegation: session.delegation, seller: seller.claim, resolveJob: () => jobs.get(id), now: () => w.now() }); };
      w.auth = { request: (path, body, text) => authFor(body.transportIdentity?.jobId ?? body.jobId).request(path, body, text), verifyResponse: (request, response) => authFor(request.jobId).verifyResponse(request, response) };
    }
    w.client = createSellerAgentClient({ url: w.url, authentication: w.auth, timeoutMs: 5000 });
  };
  w.restart = async () => { await closeServer(w.server); w.store.close(); await w.start(); };
  t.after(async () => { if (w.server?.listening) await closeServer(w.server); w.store.close(); rmSync(directory, { recursive: true }); });
  await w.start();
  return w;
}

async function job(w, { buyer = w.buyer, jobId = generateCanonicalJobId() } = {}) {
  const buyerBundle = bundleFor(buyer);
  const planned = planAgreement({ jobId, listing: w.listing, buyerBundle, generatedAt: Date.now() });
  const contribution = await createFixedPriceAgreementSignatureContribution(planned.plan, 'buyer', { party: buyer.claim, algorithm: 'ed25519', sign: buyer.signBytes });
  const material = { proposalVersion: '1', plan: planned.plan, buyerContribution: contribution };
  const proposalHash = sha256Hex(canonicalize(material));
  const transportIdentity = { jobId, planHash: planned.plan.planHash, agreementHash: planned.plan.agreementHash, buyer: buyer.claim, seller: w.seller.claim, proposalHash };
  const body = { proposal: { ...material, proposalHash }, transportIdentity, buyerIdentityBundle: buyerBundle };
  const context = { listingPin: listingPin(w.listing), agreementHash: planned.plan.agreementHash, ...(w.delegated ? { deadline: planned.draft.terms.deadline, draft: planned.draft } : {}) };
  if (w.delegated) {
    const key = createEphemeralWallet(), payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: key.publicKeyRaw.toString('hex'), seller: w.seller.claim, listingPin: context.listingPin, jobId, notBefore: w.now() - 1000, expiresAt: planned.draft.terms.deadline };
    w.sessions.set(jobId, { key, delegation: { payload, signature: buyer.signBytes(sellerSessionDelegationSigningBytes(payload)).toString('base64url') } });
  }
  w.jobs.set(jobId, context);
  return { jobId, body, planned, buyerBundle, context, payment: { jobId, txHash: sha256Hex(`fixture:${jobId}`), payerPayingKey: buyer.claim } };
}

async function raw(w, path, body, { auth = w.auth, header, text = JSON.stringify(body), method = 'POST' } = {}) {
  const signed = header === undefined ? await auth.request(path, body, text) : null;
  const response = await fetch(`${w.url}${path}`, { method, headers: { 'content-type': 'application/json', [SELLER_TRANSPORT_HEADER]: header ?? signed.header }, ...(method === 'POST' ? { body: text } : {}) });
  const answerText = await response.text();
  return { status: response.status, body: JSON.parse(answerText), text: answerText, header: response.headers.get(SELLER_TRANSPORT_HEADER), signed };
}

async function admitted(w) {
  const j = await job(w);
  assert.equal((await w.client.propose(j.body)).disposition, 'complete');
  return j;
}

test('accepting control: actual HTTP authenticates proposal, payment and completion with separate peer keys', async (t) => {
  const w = await world(t);
  const j = await job(w);
  assert.deepEqual(await w.client.agreementState(j.body.transportIdentity), { proposal: null, contribution: null }, 'SDK pre-publication reconciliation is authenticated absence');
  assert.equal((await w.client.propose(j.body)).disposition, 'complete');
  assert.notEqual(w.buyer.claim, w.seller.claim);
  assert.equal((await w.client.commit(j.jobId)).status, 'committed');
  assert.equal((await w.client.submitPayment(j.payment)).status, 'delivered');
  assert.equal((await w.client.bundleRequest(j.jobId)).fixture, true);
  assert.equal((await w.client.countersign(j.jobId, 'fixture-only-signature')).status, 'seller-copy-anchored');
  assert.equal((await w.client.confirmBuyerCopy(j.jobId)).status, 'verified');
  assert.deepEqual(w.counts, { proposal: 1, payment: 1, commit: 1, request: 1, countersign: 1, buyerCopy: 1 });
  // The database contains public bindings and answers, never a key capability.
  const db = readFileSync(join(w.directory, 'transport.sqlite'));
  assert.equal(db.includes(Buffer.from('PRIVATE KEY')), false);
  assert.equal(db.includes(Buffer.from('signBytes')), false);
});

test('wrong signer, body, job, Listing, Agreement, audience, method and path are rejected before an effect', async (t) => {
  const w = await world(t);
  const j = await admitted(w);
  const stranger = createEphemeralWallet();
  const signed = await w.auth.request(PATHS.payment, j.payment, JSON.stringify(j.payment));
  const variations = [
    ['wrong signer', 401, { header: signHeader(signed.payload, stranger) }],
    ['changed body', 401, { header: signed.header, text: JSON.stringify({ ...j.payment, txHash: 'f'.repeat(64) }) }],
    ['wrong job', 409, { header: signHeader({ ...signed.payload, jobId: generateCanonicalJobId() }, w.buyer) }],
    ['wrong Listing', 409, { header: signHeader({ ...signed.payload, listingPin: { ...j.context.listingPin, contentHash: 'a'.repeat(64) } }, w.buyer) }],
    ['wrong Agreement', 409, { header: signHeader({ ...signed.payload, agreementHash: 'b'.repeat(64) }, w.buyer) }],
    ['wrong audience', 401, { header: signHeader({ ...signed.payload, seller: stranger.claim }, w.buyer) }],
    ['expired', 408, { header: signHeader({ ...signed.payload, expiresAt: Date.now() - 1 }, w.buyer) }],
    ['unbounded future expiry', 408, { header: signHeader({ ...signed.payload, expiresAt: Date.now() + 120000 }, w.buyer) }],
    ['wrong method', 405, { header: signed.header, method: 'GET' }],
  ];
  for (const [name, status, options] of variations) assert.equal((await raw(w, PATHS.payment, j.payment, options)).status, status, name);
  assert.equal((await raw(w, PATHS.commit, j.payment, { header: signed.header })).status, 401, 'path is part of signed bytes');
  assert.equal((await raw(w, `${PATHS.payment}?alias=1`, j.payment, { header: signed.header })).status, 404, 'query alias does not enter a route');
  assert.equal(w.counts.payment, 0);
  assert.equal(w.counts.commit, 0);
});

test('another buyer cannot use or take an admitted job; proposal identity is bound before invocation', async (t) => {
  const w = await world(t);
  const j = await admitted(w);
  const stranger = createEphemeralWallet();
  const other = await job(w, { buyer: stranger, jobId: j.jobId });
  const otherAuth = createSellerTransportClientAuth({ buyerSigner: signer(stranger), seller: w.seller.claim, resolveJob: () => other.context });
  const answer = await raw(w, PATHS.proposal, other.body, { auth: otherAuth });
  assert.equal(answer.status, 409);
  assert.equal(answer.body.error, 'peer_job_conflict');
  assert.equal(w.counts.proposal, 1);
  const altered = { ...j.body, transportIdentity: { ...j.body.transportIdentity, buyer: stranger.claim } };
  w.jobs.set(j.jobId, j.context);
  assert.equal((await raw(w, PATHS.proposal, altered)).status, 409);
  assert.equal(w.counts.proposal, 1);
});

test('exact nonce replay and fresh-nonce idempotency survive restart; changed replay cannot perform a second payment', async (t) => {
  const w = await world(t);
  const j = await admitted(w);
  const signed = await w.auth.request(PATHS.payment, j.payment, JSON.stringify(j.payment));
  const first = await raw(w, PATHS.payment, j.payment, { header: signed.header });
  assert.equal(first.status, 200);
  const same = await raw(w, PATHS.payment, j.payment, { header: signed.header });
  assert.deepEqual(same.body, first.body);
  assert.equal(w.counts.payment, 1);
  const changedBody = { ...j.payment, txHash: 'c'.repeat(64) };
  const changedPayload = { ...signed.payload, bodyHash: sha256Hex(JSON.stringify(changedBody)) };
  const conflict = await raw(w, PATHS.payment, changedBody, { header: signHeader(changedPayload, w.buyer) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'peer_nonce_conflict');
  await w.restart();
  assert.deepEqual((await raw(w, PATHS.payment, j.payment, { header: signed.header })).body, first.body);
  assert.deepEqual(await w.client.submitPayment(j.payment), first.body, 'fresh nonce re-signs the durable completed answer');
  await assert.rejects(w.client.submitPayment(changedBody), (error) => error instanceof SellerRefusedError && error.code === 'peer_operation_conflict');
  assert.equal(w.counts.payment, 1);
});

test('a transaction is reserved for one job durably, including prefix and case aliases', async (t) => {
  const w = await world(t);
  const a = await admitted(w);
  const b = await admitted(w);
  await w.client.submitPayment(a.payment);
  await w.restart();
  await assert.rejects(w.client.submitPayment({ ...b.payment, txHash: `0x${a.payment.txHash.toUpperCase()}` }), (error) => error instanceof SellerRefusedError && error.code === 'peer_payment_conflict');
  assert.equal(w.counts.payment, 1);
});

test('an expired retry cannot falsely prove refusal after a completed effect; a fresh envelope reconciles the answer', async (t) => {
  const w = await world(t);
  let clock = Date.now();
  w.now = () => clock;
  const j = await admitted(w);
  const signed = await w.auth.request(PATHS.payment, j.payment, JSON.stringify(j.payment));
  assert.equal((await raw(w, PATHS.payment, j.payment, { header: signed.header })).status, 200);
  clock += 31000;
  const expired = await raw(w, PATHS.payment, j.payment, { header: signed.header });
  assert.equal(expired.status, 408, 'timeout remains uncertain instead of reporting operation refusal');
  assert.equal(expired.body.error, 'peer_expired');
  w.auth.verifyResponse(signed.payload, expired);
  assert.equal((await w.client.submitPayment(j.payment)).status, 'delivered');
  assert.equal(w.counts.payment, 1);
});

test('lost effect acknowledgement and retained pre-effect intent stay uncertain across restart with no repeat invocation', async (t) => {
  const w = await world(t);
  const j = await admitted(w);
  w.faults.throwAfterPayment = true;
  await assert.rejects(w.client.submitPayment(j.payment), SellerUnavailableError);
  assert.equal(w.counts.payment, 1);
  w.faults.throwAfterPayment = false;
  await w.restart();
  await assert.rejects(w.client.submitPayment(j.payment), SellerUnavailableError);
  assert.equal(w.counts.payment, 1, 'unknown effect did not become permission to repeat');
  const other = await admitted(w);
  const pending = await w.auth.request(PATHS.payment, other.payment, JSON.stringify(other.payment));
  assert.equal(w.store.reserve(pending.payload, other.payment).disposition, 'perform');
  await w.restart();
  const response = await raw(w, PATHS.payment, other.payment, { header: pending.header });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'operation_uncertain');
  assert.equal(w.counts.payment, 1, 'persisted intent is never auto-reexecuted after restart');
  assert.equal(Object.hasOwn(response.body, 'finality'), false);
});

test('signed definite pre-effect refusal permits a fresh attempt, while unsigned refusals remain unavailable', async (t) => {
  const w = await world(t);
  const j = await admitted(w);
  const original = w.agent.submitPayment;
  w.agent.submitPayment = () => { throw new SellerAgentError('not_committed', 'no commitment'); };
  const signed = await w.auth.request(PATHS.payment, j.payment, JSON.stringify(j.payment));
  const refusal = await raw(w, PATHS.payment, j.payment, { header: signed.header });
  assert.equal(refusal.status, 422);
  w.auth.verifyResponse(signed.payload, { ...refusal });
  await assert.rejects(w.client.submitPayment(j.payment), SellerRefusedError);
  w.agent.submitPayment = original;
  assert.equal((await w.client.submitPayment(j.payment)).status, 'delivered');
  assert.equal((await raw(w, PATHS.payment, j.payment, { header: signed.header })).status, 422, 'old nonce retains its exact refusal');
  const unsigned = createSellerAgentClient({ url: w.url, authentication: w.auth, fetchImpl: async () => new Response('{"error":"not_committed"}', { status: 422, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(unsigned.submitPayment(j.payment), SellerUnavailableError);
});

test('seller response signature binds exact body, status, request path, nonce and peer', async (t) => {
  const w = await world(t);
  const j = await admitted(w);
  const request = await w.auth.request(PATHS.payment, j.payment, JSON.stringify(j.payment));
  const response = await raw(w, PATHS.payment, j.payment, { header: request.header });
  assert.equal(w.auth.verifyResponse(request.payload, response).principal, w.seller.claim);
  for (const changed of [
    { ...response, text: '{"status":"verified"}' },
    { ...response, status: 422 },
  ]) assert.throws(() => w.auth.verifyResponse(request.payload, changed));
  assert.throws(() => w.auth.verifyResponse({ ...request.payload, path: PATHS.commit }, response));
  assert.throws(() => w.auth.verifyResponse({ ...request.payload, nonce: Buffer.alloc(24, 3).toString('base64url') }, response));
  const decoded = JSON.parse(Buffer.from(response.header, 'base64url'));
  assert.throws(() => w.auth.verifyResponse(request.payload, { ...response, header: signHeader(decoded.payload, w.buyer) }));
  const expiredResponse = { ...decoded.payload, expiresAt: Date.now() - 1 };
  assert.throws(() => w.auth.verifyResponse(request.payload, { ...response, header: signHeader(expiredResponse, w.seller) }));
  const alteredClient = createSellerAgentClient({ url: w.url, authentication: w.auth, fetchImpl: async (url, init) => {
    const actual = await fetch(url, init);
    return new Response('{"status":"verified","finality":"fabricated"}', { status: actual.status, headers: actual.headers });
  } });
  await assert.rejects(alteredClient.submitPayment(j.payment), SellerUnavailableError);
});

test('body bytes, response bytes, slow bodies, concurrency, rate and durable capacity are bounded', async (t) => {
  const w = await world(t);
  const j = await admitted(w);
  const large = JSON.stringify({ jobId: j.jobId, padding: '€'.repeat(23000) });
  assert.equal((await raw(w, PATHS.commit, { jobId: j.jobId }, { text: large })).status, 413, 'byte limit, not character count');
  const oversizedAnswer = createSellerAgentClient({ url: w.url, authentication: w.auth, fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1), { status: 422, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(oversizedAnswer.submitPayment(j.payment), SellerUnavailableError);
  assert.equal(w.counts.commit, 0);
  const slow = await world(t, { limits: { bodyTimeoutMs: 30 } });
  const slowStatus = await new Promise((resolve, reject) => {
    const req = http.request(`${slow.url}${PATHS.commit}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '100' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('{');
  });
  assert.equal(slowStatus, 408);
  const limited = await world(t, { limits: { maxRequestsPerWindow: 1 } });
  const limitedJob = await admitted(limited);
  await assert.rejects(limited.client.submitPayment(limitedJob.payment), SellerUnavailableError);
  assert.equal(limited.counts.payment, 0);
  const capacity = await world(t, { maxRecords: 1 });
  const capJob = await admitted(capacity);
  await assert.rejects(capacity.client.submitPayment(capJob.payment), SellerUnavailableError);
  assert.equal(capacity.counts.payment, 0);
  const concurrent = await world(t, { limits: { maxConcurrent: 1 } });
  const cj = await admitted(concurrent);
  let release;
  concurrent.agent.submitPayment = () => new Promise((resolve) => { release = () => resolve({ status: 'delivered', fixture: true }); });
  const first = concurrent.client.submitPayment(cj.payment);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(concurrent.client.commit(cj.jobId), SellerUnavailableError);
  release();
  assert.equal((await first).status, 'delivered');
  assert.equal(concurrent.counts.commit, 0);
});

test('public endpoints, URL credentials and a store reused for another peer are refused', async (t) => {
  const w = await world(t);
  for (const url of ['https://seller.example', 'http://127.0.0.1@outside.example', 'http://buyer:secret@127.0.0.1', `${w.url}?query=1`, `${w.url}#fragment`]) assert.throws(() => createSellerAgentClient({ url, authentication: w.auth }));
  assert.throws(() => createSellerTransportServerAuth({ sellerSigner: signer(createEphemeralWallet()), listingPin: w.agent.listingPin, store: w.store }));
});

for (const delegated of [false, true]) test(delegated ? 'real seller-agent accepting control: second buyer with session delegation completes one SDK-backed offline purchase' : 'real seller-agent accepting control: authenticated HTTP carries one complete SDK-backed offline purchase', async (t) => {
  const w = await world(t, { delegated });
  if (delegated) assert.notEqual(w.buyer.claim, w.testBuyer.claim);
  const chain = await startChainFixture();
  const anchors = await startAnchorFixture();
  t.after(async () => { await anchors.close(); await chain.close(); });
  const anchorClient = createFixtureAnchorClient({ url: anchors.url });
  const observer = createPayDemSellerObserver({ rpc: chain.url, timeoutMs: 5000 });
  await closeServer(w.server); w.store.close();
  w.agent = await createSellerAgent({ signer: signer(w.seller), listing: w.listing, anchors: anchorClient, observeDemosTransfer: (hash) => observer.observeDemosTransfer(hash) });
  await w.start();
  const j = await job(w);
  const progress = await exchangeAgreement({ plan: j.planned.plan, draft: j.planned.draft, buyerClaim: w.buyer.claim, buyerBundle: j.buyerBundle, agreementSignature: w.buyer.signHex(j.planned.agreementMessage), anchorSignature: w.buyer.signHex(j.planned.anchorMessage), seller: w.client, anchors: anchorClient });
  assert.equal(progress.disposition, 'anchored', JSON.stringify(progress));
  const agreement = progress.result.agreement;
  const terms = agreementTerms(agreement);
  await w.client.commit(j.jobId);
  const commitment = await readCommitment({ agreement, listing: w.listing, anchors: anchorClient });
  assert.equal(commitment.status, 'verified');
  const payload = buildNativeTransferPayload({ from: w.buyer.address, to: terms.payee, amountOs: terms.price.amountOs, nonce: 1, timestamp: Date.now(), encoding: 'os-string' });
  const txHash = chain.walletBroadcast(payload); // SIMULATED in-process fixture only.
  const reader = createDemosChainReader({ rpcUrl: chain.url, network: 'testnet' });
  const observedTransfer = await reader.observeTransfer(txHash);
  const observed = { txHash, blockNumber: observedTransfer.blockNumber };
  assert.equal((await w.client.submitPayment({ jobId: j.jobId, txHash, payerPayingKey: w.buyer.claim })).status, 'delivered');
  const payment = await verifyPaymentEvidence({ agreement, observed, record: await anchorClient.read(paymentEvidenceAddress(j.jobId, terms.rail, terms.paymentPhaseIndex)) });
  const delivery = await verifyDelivery({ agreement, deliverable: await anchorClient.read(deliverableAddress(j.jobId)), evidenceRecord: await anchorClient.read(deliveryEvidenceAddress(j.jobId)) });
  assert.equal(payment.status, 'verified'); assert.equal(delivery.status, 'verified');
  const request = await w.client.bundleRequest(j.jobId);
  const facts = bundleSession({ agreement, agreementRef: progress.result.agreementRef, commitmentRef: commitment.ref, payment: payment.ref, delivery: delivery.evidenceRef, observed, finalisedAt: request.finalisedAt });
  const plan = await bundleSigningPlan(facts);
  const buyerSignature = w.buyer.signHex(plan.message);
  const { copies, problems } = await assembleBundleCopies(facts, { buyer: buyerSignature, seller: request.sellerSignature });
  assert.deepEqual(problems, []);
  const address = bundleAddress(j.jobId, 'buyer');
  await anchorClient.write({ logicalAddress: address, artifact: copies.buyerCopy, writer: w.buyer.claim, writerSignature: w.buyer.signHex(anchorWriteMessage(address, contentHash(copies.buyerCopy))) });
  assert.equal((await w.client.countersign(j.jobId, buyerSignature)).status, 'seller-copy-anchored');
  assert.equal((await w.client.confirmBuyerCopy(j.jobId)).status, 'verified');
  const before = anchors.faults.writes.length;
  await w.restart();
  assert.equal((await w.client.submitPayment({ jobId: j.jobId, txHash, payerPayingKey: w.buyer.claim })).status, 'delivered');
  assert.equal(anchors.faults.writes.length, before, 'durable cached answer did not publish a second artifact');
  assert.equal(chain.nonceOf(w.buyer.address), 1, 'transport retries never initiate a second fixture wallet send');
});


test('session delegations refuse invalid authority, scope, key, lifetime and Agreement buyer before invocation', async (t) => {
  const w = await world(t, { delegated: true }), j = await admitted(w);
  const session = w.sessions.get(j.jobId), signed = await w.auth.request(PATHS.commit, { jobId: j.jobId }, JSON.stringify({ jobId: j.jobId }));
  const stranger = createEphemeralWallet();
  const headerFor = (payload, delegation, key = session.key) => Buffer.from(canonicalize({ payload, delegation, signature: key.signBytes(sellerTransportSigningBytes(payload)).toString('base64url') })).toString('base64url');
  const delegate = (patch, buyer = w.buyer) => { const payload = { ...session.delegation.payload, ...patch }; return { payload, signature: buyer.signBytes(sellerSessionDelegationSigningBytes(payload)).toString('base64url') }; };
  const variations = [
    ['expired', 408, delegate({ notBefore: w.now() - 2000, expiresAt: w.now() - 1000 })],
    ['not yet valid', 408, delegate({ notBefore: w.now() + 60000 })],
    ['wrong job', 409, delegate({ jobId: generateCanonicalJobId() })],
    ['wrong seller', 409, delegate({ seller: stranger.claim })],
    ...[['listingId', 'another-listing'], ['version', 2], ['contentHash', 'a'.repeat(64)]].map(([key, value]) => [`wrong Listing ${key}`, 409, delegate({ listingPin: { ...j.context.listingPin, [key]: value } })]),
    ['request exceeds delegation expiry', 408, delegate({ expiresAt: w.now() + 1000 })],
    ['deadline exceeded', 409, delegate({ expiresAt: j.planned.draft.terms.deadline + 1 })],
    ['buyer signature forged', 401, delegate({}, stranger)],
  ];
  for (const [name, status, delegation] of variations) assert.equal((await raw(w, PATHS.commit, { jobId: j.jobId }, { header: headerFor(signed.payload, delegation) })).status, status, name);
  assert.equal((await raw(w, PATHS.commit, { jobId: j.jobId }, { header: headerFor(signed.payload, session.delegation, stranger) })).status, 401, 'another session key');
  assert.equal((await raw(w, PATHS.commit, { jobId: j.jobId }, { header: signHeader(signed.payload, w.buyer) })).status, 401, 'direct custody signatures cannot skip delegated mode');
  const wrongBuyer = delegate({ buyer: stranger.claim }, stranger);
  const answer = await raw(w, PATHS.commit, { jobId: j.jobId }, { header: headerFor({ ...signed.payload, buyer: stranger.claim }, wrongBuyer) });
  assert.equal(answer.status, 409); assert.equal(answer.body.error, 'peer_delegation_agreement_mismatch');
  assert.equal(w.counts.commit, 0); assert.equal(w.counts.proposal, 1);
});

test('a delegation signed with a repeated 0x wallet prefix authenticates the session like identity signatures do', async (t) => {
  const w = await world(t, { delegated: true }), j = await admitted(w);
  const session = w.sessions.get(j.jobId);
  session.delegation = { ...session.delegation, signature: `0x0x${Buffer.from(session.delegation.signature, 'base64url').toString('hex')}` };
  assert.equal((await w.client.commit(j.jobId)).status, 'committed');
  assert.equal(w.counts.commit, 1);
});

test('session-authenticated lost payment response remains readback-only across restart', async (t) => {
  const w = await world(t, { delegated: true }), j = await admitted(w);
  w.faults.throwAfterPayment = true;
  await assert.rejects(w.client.submitPayment(j.payment), SellerUnavailableError);
  assert.equal(w.counts.payment, 1);
  w.faults.throwAfterPayment = false;
  await w.restart();
  await assert.rejects(w.client.submitPayment(j.payment), SellerUnavailableError);
  assert.equal(w.counts.payment, 1, 'an unknown delegated request never invokes the write twice');
});

test('after delegation expiry, readback and journaled effects still answer, but a new effect is refused before invocation', async (t) => {
  const w = await world(t, { delegated: true });
  let clock = Date.now();
  w.now = () => clock;
  const lost = await admitted(w), done = await admitted(w);
  // While live: one payment completes, one loses its acknowledgement (journaled, uncertain).
  assert.equal((await w.client.submitPayment(done.payment)).status, 'delivered');
  w.faults.throwAfterPayment = true;
  await assert.rejects(w.client.submitPayment(lost.payment), SellerUnavailableError);
  w.faults.throwAfterPayment = false;
  assert.equal(w.counts.payment, 2);
  const expiry = Math.max(...[lost, done].map((j) => w.sessions.get(j.jobId).delegation.payload.expiresAt));
  clock = expiry + 5000;
  await w.restart();
  const before = { ...w.counts };
  // Completed effect: the exact same request returns the journaled answer.
  const cached = await raw(w, PATHS.payment, done.payment);
  assert.equal(cached.status, 200);assert.equal(cached.body.status, 'delivered');
  assert.equal((await w.client.submitPayment(done.payment)).status, 'delivered');
  // Journaled but uncertain effect: readback only, never invoked again and never reported refused.
  const uncertain = await raw(w, PATHS.payment, lost.payment);
  assert.equal(uncertain.status, 503);assert.equal(uncertain.body.error, 'operation_uncertain');
  // Status/readback routes are answered.
  assert.equal((await raw(w, '/dacs/v1/agreements/state', { transportIdentity: done.body.transportIdentity })).status, 200);
  // A new effect (a commit, or a payment for another transaction) is refused before reserving anything.
  for (const [path, body] of [[PATHS.commit, { jobId: done.jobId }], [PATHS.payment, { ...done.payment, txHash: 'f'.repeat(64) }]]) {
    const refused = await raw(w, path, body);
    assert.equal(refused.status, 408, path);assert.equal(refused.body.error, 'peer_delegation_expired', path);
  }
  assert.deepEqual(w.counts, before, 'no seller operation ran after expiry');
  // The refused requests reserved nothing: no transaction claim and no commit slot.
  const db = new DatabaseSync(join(w.directory, 'transport.sqlite'), { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_transactions WHERE tx = ?').get('f'.repeat(64)).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_slots WHERE slot = ?').get(`${done.jobId}:${PATHS.commit}`).n, 0);
});

test('a live delegation still bounds each request; an expired delegation cannot start the first effect for a job', async (t) => {
  const w = await world(t, { delegated: true });
  let clock = Date.now();
  w.now = () => clock;
  const j = await job(w);
  clock = w.sessions.get(j.jobId).delegation.payload.expiresAt;
  const refused = await raw(w, PATHS.proposal, j.body);
  assert.equal(refused.status, 408);assert.equal(refused.body.error, 'peer_delegation_expired');
  assert.equal(w.counts.proposal, 0);
  // Unadmitted state is still answered as authenticated absence.
  assert.equal((await raw(w, '/dacs/v1/agreements/state', { transportIdentity: j.body.transportIdentity })).status, 200);
});
