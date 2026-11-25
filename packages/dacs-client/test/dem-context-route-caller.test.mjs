// The buyer's DEM delivery context through the seller's context route: the client's public protocol factory, configured with the
// root route capability, against the kit's seller host composed over the seller's shipped Vet provider on loopback. Every context
// request goes through the purchase's own authenticated seller session; a test can replace the host's signed answer with another
// one, signed by the seller's key over the request the client sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compositeVerificationAddress, contentHash, sha256Hex } from '@kynesyslabs/dacs';
import * as wire from '@kynesyslabs/dacs/wire';
import { CHALLENGE, JOB, JOB2, TEST_CONNECTION, buyer, seller, bootstrapThroughChallenge, bootstrapWorld, walletSign } from './helpers/kit-bootstrap-world.mjs';

const { createDemDeliveryContextRouteCaller, DEM_DELIVERY_CONTEXT_SOURCE } = await import('@kynesyslabs/dacs-client');
const { readBackDemDeliveryContext, resolveDemDeliveryBuyerContext } = await import('../src/dacs/dem-delivery-context-consumer.mjs');
const { SELLER_RETRY_DELAY_MS, SELLER_UNKNOWN_RETRIES } = await import('../src/dacs/seller-http.mjs');
const { startSellerHost, KIT_TP1_VET_MODE } = await import('../../dacs-seller/src/host.mjs');
const sellerContext = await import('../../dacs-seller/src/dacs/dem-delivery-context-consumer.mjs');
const { createDevnetDemoAgreementContextProvider } = await import('../../dacs-seller/src/devnet-demo/agreement-context.mjs');
const { createSellerCreatePass, lateSellerCreatePass } = await import('../../dacs-seller/src/devnet-demo/create-pass.mjs');
const { openPartyVetStore } = await import('../../dacs-seller/src/devnet-demo/party-vet-store.mjs');
const { createOperatorBuyerAccess } = await import('../../dacs-seller/src/devnet-demo/buyer-access.mjs');
const { TEST_PASS_SESSION } = await import('../../dacs-seller/test/helpers/agent-signing.mjs');
const { enrollment, testWalletSession } = await import('../../dacs-seller/test/helpers/kit-wallet-session.mjs');
const { vetRecordAnchor } = await import('../../dacs-seller/test/helpers/composed-vet-host.mjs');
const { testWallet } = await import('../../dacs-seller/test/helpers/protocol-fixture.mjs');

const CONTEXT = wire.DACS_SELLER_HTTP_PATHS.context;
const AUTHORITY = 'TEST-route-caller';
const WIRE_SCOPE_KEYS = ['source', 'wallet', 'jobId', 'buyer', 'buyerBundleHash', 'seller', 'listingPin', 'rail', 'payee', 'price', 'generatedAt'];
const RESPONSE_LIFETIME_MS = 60_000;
const OTHER_HEX = 'e'.repeat(64);
const signerOf = (wallet) => ({ claim: wallet.claim, sign: wallet.signBytes });
const code = (expected) => (error) => { assert.equal(error.code, expected, error.message); return true; };
const held = (reason) => (error) => { assert.equal(error.code, 'agreement_context_held', error.message); assert.ok(error.message.includes(reason), error.message); return true; };

/**
 * The kit host started over the seller's shipped Vet provider, whose Vet records an in-memory anchor keeps. `provider` is the latest
 * host's provider, and `vetWrites()` counts the Vet records published.
 */
async function sellerProviderHost(t) {
  const anchor = vetRecordAnchor(), directory = await mkdtemp(join(tmpdir(), 'TEST-route-caller-vet-')), stores = [];
  const host = { provider: null, published: 0 };
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const sellerAnchor = { ...anchor, publish: async (input) => { host.published++; return anchor.publish(input); } };
  host.vetWrites = () => host.published;
  host.start = async (options) => {
    const finalized = {};
    const { walletSession } = testWalletSession({ finalize: async (input) => { Object.assign(finalized, input); return { close: async () => {} }; } });
    const store = openPartyVetStore({ path: join(directory, 'party.sqlite'), mode: stores.length ? 'open' : 'create' });
    stores.push(store);
    host.provider = createDevnetDemoAgreementContextProvider({ anchor: sellerAnchor, vetMode: KIT_TP1_VET_MODE, listing: options.listing, store, log: () => {}, now: () => Date.now(),
      wallet: { claim: seller.claim, signBytes: async (bytes) => seller.signBytes(bytes) },
      runCreate: lateSellerCreatePass(() => createSellerCreatePass({ effectBoundary: finalized.effectBoundary, session: TEST_PASS_SESSION, stopped: () => finalized.stopped(),
        feeCeilingOs: finalized.feeCeilingOs, clock: { now: () => Date.now() } }).runCreate),
      buyerAccess: createOperatorBuyerAccess({ openBuyerAccess: false, custodyBuyer: buyer.claim, buyerForJob: () => buyer.address }),
      counterparty: Object.fromEntries(['issueChallenge', 'evaluate', 'readRecord'].map((key) => [key, () => { throw new Error(`TEST no counterparty ${key}`); }])) });
    const { provider } = host;
    const demDeliveryContext = sellerContext.createDemDeliveryContext({ authority: 'TEST-route-caller-seller', vetMode: provider.vetMode, resolveSeller: provider.resolveSeller,
      release: provider.release, resolveBuyer: provider.resolveBuyer, recoverBuyer: provider.recoverBuyer, resumableBuyer: provider.resumableBuyer, bindRetainedScope: provider.bindRetainedScope });
    return startSellerHost({ ...options, walletSession, participantImplementations: enrollment(), demDeliveryContext });
  };
  return host;
}

/**
 * The kit world whose buyer services hold the root route capability and whose host runs the seller's shipped provider. `contextAnswers`
 * keeps each context answer the client received; `replace(answer)`, when set, gives the answer the client receives instead of the
 * host's, from `{request, status, text, header}` (the host still served the request). `purchase(jobId)` runs the identity and
 * delegation steps and answers `{purchase, signature}`; `plan(purchase, signature)` asks for the plan.
 */
async function routeWorld(t, { stopped } = {}) {
  // The client's wait between sends after an unknown answer elapses at once, so no test waits on it.
  const wait = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (work, ms, ...rest) => wait(work, ms === SELLER_RETRY_DELAY_MS ? 0 : ms, ...rest));
  const host = await sellerProviderHost(t);
  const capability = createDemDeliveryContextRouteCaller({ authority: AUTHORITY });
  const world = await bootstrapWorld(t, { demDeliveryContext: capability, startHost: host.start, stopped });
  world.seller = host;
  world.capability = capability;
  world.contextAnswers = [];
  world.replace = null;
  world.intercept = async (path, init, forward) => {
    if (path !== CONTEXT) return forward();
    const response = await forward();
    const answer = { request: requestPayload(init), status: response.status, text: await response.text(), header: response.headers.get(wire.DACS_SELLER_HTTP_HEADER) };
    const given = world.replace ? await world.replace(answer) : answer;
    world.contextAnswers.push(given);
    if (given instanceof Error) throw given;
    return new Response(given.text, { status: given.status, headers: { 'content-type': 'application/json', ...(given.header ? { [wire.DACS_SELLER_HTTP_HEADER]: given.header } : {}) } });
  };
  world.start = async (jobId = JOB) => {
    const purchase = world.purchase(jobId, { agreementContext: DEM_DELIVERY_CONTEXT_SOURCE });
    const { presentation } = await bootstrapThroughChallenge(world, purchase);
    return { purchase, signature: walletSign(presentation.message) };
  };
  world.plan = ({ purchase, signature }, intentGeneratedAt) => world.service().planRequest(purchase.get(), signature, intentGeneratedAt);
  world.contextBodies = () => world.sent(CONTEXT).map((request) => request.init.body);
  // Requests the buyer sent beyond the bootstrap's challenge and context routes: an Agreement or payment step.
  world.laterRequests = () => world.requests.filter((request) => ![CHALLENGE, CONTEXT].includes(request.path));
  return world;
}

const requestPayload = (init) => JSON.parse(Buffer.from(init.headers[wire.DACS_SELLER_HTTP_HEADER], 'base64url')).payload;

/** A response header the seller's key (or `signer`) signs over `text` for `request`, at `now`, with no size check of its own. */
function signAnswer(world, request, text, { signer = seller, now = world.clock.time, status = 200 } = {}) {
  const payload = { ...request, kind: 'response', bodyHash: sha256Hex(Buffer.from(text)), expiresAt: now + RESPONSE_LIFETIME_MS, requestHash: wire.wireRequestHash(request), status };
  return wire.signWireEnvelope(payload, { signer: signerOf(signer), binding: world.binding, local: { ...TEST_CONNECTION }, purchaseProfile: world.binding.profile });
}

/** The host's answer with its JSON changed by `change` and signed again by the seller's key. */
const resigned = (world, change) => async (answer) => {
  const body = JSON.parse(answer.text);
  change(body);
  const text = JSON.stringify(body);
  return { ...answer, text, header: await signAnswer(world, answer.request, text) };
};

/** Asserts nothing was planned and no Agreement or payment step was asked for. */
function assertNothingPlanned(world, purchase, label) {
  assert.equal(purchase.get().state.protocol.planned, undefined, `${label}: no Agreement was planned`);
  assert.equal(purchase.get().status, 'agreement_pending', `${label}: the purchase is still pending`);
  assert.deepEqual(world.laterRequests(), [], `${label}: no Agreement or payment request`);
}

test('the public DEM context caller uses the purchase\'s authenticated seller route and both delivery resolvers receive its bound input', async (t) => {
  const world = await routeWorld(t);
  const flow = await world.start();
  const signsBefore = world.signs.length;
  const { operation } = await world.plan(flow);
  const [request] = world.sent(CONTEXT);
  assert.equal(world.sent(CONTEXT).length, 1, 'one context request');
  assert.equal(world.signs.length - signsBefore, 1, 'the session key signed the one context request');
  const body = JSON.parse(request.init.body);
  assert.deepEqual(Object.keys(body).sort(), ['buyerIdentityBundle', 'scope']);
  assert.deepEqual(Object.keys(body.scope).sort(), [...WIRE_SCOPE_KEYS].sort(), 'the wire scope has no account or operation id');
  assert.deepEqual(body.buyerIdentityBundle, operation.state.protocol.buyerBundle);
  assert.equal(requestPayload(request.init).path, CONTEXT, 'the request is signed for the context route');
  // The plan binds the restored local scope and the seller's answered input.
  const answered = JSON.parse(world.contextAnswers[0].text).value;
  const local = { ...body.scope, account: operation.accountId, operation: operation.id };
  assert.deepEqual(operation.state.protocol.agreementContext, { source: DEM_DELIVERY_CONTEXT_SOURCE, authority: AUTHORITY, scopeHash: contentHash(local),
    resolvedAt: operation.state.protocol.agreementContext.resolvedAt }, 'the plan binds the full local scope');
  for (const role of ['buyer', 'seller']) {
    assert.deepEqual(operation.state.protocol.planned.draft.parties.find((party) => party.role === role).vetRecordRef, answered.input[role].vetRecordRef, `${role} Vet ref`);
  }
  // The seller process resolves its own side for the same purchase, from its retained Vet records, with the same input.
  const sellerSide = await world.seller.provider.resolveSeller({ jobId: JOB, listingPin: body.scope.listingPin, buyerIdentityBundle: body.buyerIdentityBundle, generatedAt: body.scope.generatedAt });
  assert.equal(sellerSide.disposition, 'present', JSON.stringify(sellerSide));
  assert.deepEqual(sellerSide.value.input, answered.input, 'the seller resolver binds the same input');
  assert.ok(sellerSide.value.vetRequirements.length > 0, 'the seller resolver returns its retained Vet requirements');
  assert.equal(world.seller.vetWrites(), 2, 'one Vet record per party');
});

// The wire's own refusal of an answer it cannot authenticate; the purchase keeps it as the attempt's reason.
const UNAUTHENTICATED = 'seller agent response is unavailable or unauthenticated';
// An answer whose outcome is unknown is sent again within the call, a bounded number of times, always with the stored body.
const SENDS_PER_UNKNOWN_CALL = 1 + SELLER_UNKNOWN_RETRIES;

test('an unsigned or wrong-seller context answer cannot plan an Agreement', async (t) => {
  const world = await routeWorld(t);
  const flow = await world.start();
  const other = testWallet(4);
  const cases = {
    'an unsigned answer': (answer) => ({ ...answer, header: null }),
    'an answer signed by another key for the seller': async (answer) => ({ ...answer, header: await signAnswer(world, answer.request, answer.text, { signer: other }) }),
    'an answer from another seller': async (answer) => ({ ...answer, header: await signAnswer(world, { ...answer.request, seller: other.claim }, answer.text, { signer: other }) }),
  };
  for (const [label, replace] of Object.entries(cases)) {
    world.replace = replace;
    await assert.rejects(world.plan(flow), held(UNAUTHENTICATED), label);
    assertNothingPlanned(world, flow.purchase, label);
  }
  assert.equal(world.sent(CONTEXT).length, Object.keys(cases).length * SENDS_PER_UNKNOWN_CALL, 'each plan step sent its bounded attempts only');
});

test('a signed context for another scope or bound input cannot plan an Agreement', async (t) => {
  const world = await routeWorld(t);
  const flow = await world.start();
  const other = testWallet(4);
  const input = (change) => (body) => change(body.value.input);
  const SCOPE = 'DEM_DELIVERY_CONTEXT_SCOPE_MISMATCH', EXACT = 'context input is not the exact SDK derive input', TERMS = 'rail, payout, or generation time differs';
  const rejected = [
    ['another wire scope job', (body) => { body.value.scope.jobId = JOB2; }, SCOPE],
    ['another wire scope generation time', (body) => { body.value.scope.generatedAt += 1; }, SCOPE],
    ['another input job', input((value) => { value.jobId = JOB2; }), EXACT],
    ['another verified Listing pin', input((value) => { value.verifiedListing.pin.version += 1; }), 'verified Listing or pin differs'],
    ['another buyer identity bundle', input((value) => { value.buyer.identityBundle.presentedAt += 1; }), 'buyer identity differs'],
    ['another selected rail', input((value) => { value.selectedRail.railVersion += 1; }), TERMS],
    ['another payout payee', input((value) => { value.payoutBindings[0].payeeAddress = other.address; }), TERMS],
    ['another generation time', input((value) => { value.generatedAt += 1; }), TERMS],
  ];
  for (const [role, party] of [['buyer', buyer], ['seller', seller]]) {
    const ref = (change) => input((value) => change(value[role].vetRecordRef));
    rejected.push(
      [`a ${role} Vet ref with an extra key`, ref((vet) => { vet.extra = true; }), `${role} Vet ref is not an exact orchestrator-signed record ref`],
      [`a ${role} Vet ref of another anchor kind`, ref((vet) => { vet.anchor.kind = 'storage-other'; }), `${role} Vet ref is not at the canonical composite address`],
      [`a ${role} Vet ref at another job's address`, ref((vet) => { vet.anchor.locator = compositeVerificationAddress(JOB2, party.claim); }), `${role} Vet ref is not at the canonical composite address`],
      [`a ${role} Vet ref naming another signer`, ref((vet) => { vet.signer = other.claim; }), `${role} Vet ref is not signed by the bound phase orchestrator`],
      [`a ${role} Vet ref whose content hash is not 64 lowercase hex`, ref((vet) => { vet.contentHash = 'E'.repeat(64); }), `${role} Vet ref is not signed by the bound phase orchestrator`]);
  }
  for (const [label, change, reason] of rejected) {
    world.replace = resigned(world, change);
    await assert.rejects(world.plan(flow), held(reason), label);
    assertNothingPlanned(world, flow.purchase, label);
  }
  // The seller attests its Vet refs: another well-formed content hash it signs is its answer, and the plan carries it.
  const second = await world.start(JOB2);
  for (const [role, planned] of [['buyer', flow], ['seller', second]]) {
    world.replace = resigned(world, (body) => { body.value.input[role].vetRecordRef.contentHash = OTHER_HEX; });
    const { operation } = await world.plan(planned);
    assert.equal(operation.state.protocol.planned.draft.parties.find((party) => party.role === role).vetRecordRef.contentHash, OTHER_HEX, `the ${role} ref the seller signed`);
  }
});

test('a stale or replayed signed context answer cannot plan an Agreement', async (t) => {
  const world = await routeWorld(t);
  const flow = await world.start();
  let earlier;
  world.replace = async (answer) => {
    earlier = answer;
    return { ...answer, header: await signAnswer(world, answer.request, answer.text, { now: world.clock.time - 2 * RESPONSE_LIFETIME_MS }) };
  };
  await assert.rejects(world.plan(flow), held(UNAUTHENTICATED), 'an answer whose signature expired');
  assertNothingPlanned(world, flow.purchase, 'expired');
  // The seller's genuine, unexpired answer to the first request, given again for the next one.
  world.replace = () => earlier;
  await assert.rejects(world.plan(flow), held(UNAUTHENTICATED), 'an answer signed for an earlier request');
  assertNothingPlanned(world, flow.purchase, 'replayed');
  assert.notEqual(requestPayload(world.sent(CONTEXT)[1].init).nonce, earlier.request.nonce, 'the second request had its own envelope');
});

test('an oversized context answer is refused before JSON decoding and cannot plan an Agreement', async (t) => {
  const world = await routeWorld(t);
  const flow = await world.start();
  // The host's answer padded inside its value to `bytes` bytes, then signed by the seller's key.
  const padded = (bytes) => async (answer) => {
    const body = JSON.parse(answer.text);
    body.value.padding = '';
    const text = JSON.stringify({ ...body, value: { ...body.value, padding: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(body))) } });
    assert.equal(Buffer.byteLength(text), bytes);
    return { ...answer, text, header: await signAnswer(world, answer.request, text) };
  };
  const limit = wire.DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes;
  world.replace = padded(limit + 1);
  await assert.rejects(world.plan(flow), held(UNAUTHENTICATED), 'one byte over the limit');
  assertNothingPlanned(world, flow.purchase, 'oversized');
  // At the limit the signed answer is decoded and reaches the answer's shape check.
  world.replace = padded(limit);
  await assert.rejects(world.plan(flow), held('DEM_DELIVERY_CONTEXT_FAILED: malformed result'), 'at the limit');
  assertNothingPlanned(world, flow.purchase, 'at the limit');
});

/** A purchase row with only what a buyer context scope reads, for the route capability's own checks. */
function bareOperation() {
  const listingPin = { listingId: 'TEST-listing', version: 1, contentHash: 'a'.repeat(64) };
  return { accountId: 'TEST-buyer', id: 'TEST-operation', terms: { buyer: { wallet: buyer.address }, seller: { claim: seller.claim, payee: seller.address },
    listing: listingPin, price: { amount: '1', currency: 'DEM', amountOs: '1000000000' }, protocol: { jobId: JOB } } };
}
const bareResolution = (capability, options) => resolveDemDeliveryBuyerContext(capability, { operation: bareOperation(), listing: null,
  buyerBundle: { bundleVersion: '1', presentedBy: buyer.claim }, generatedAt: 1, ...options });

test('an expired challenge or changed purchase refuses before a context request is signed', async (t) => {
  const world = await routeWorld(t);
  const expired = await world.start(), ended = await world.start(JOB2);
  const signs = world.signs.length;
  // The seller challenge expired before the presentation was accepted.
  world.clock.time = expired.purchase.get().state.protocol.challenge.expiresAt;
  await assert.rejects(world.plan(expired), code('context_challenge_expired'));
  // The purchase is no longer pending.
  world.ops().transition(ended.purchase.id, 'agreement_pending', 'cancelled', { event: 'TEST-cancelled' });
  await assert.rejects(world.plan(ended), code('invalid_state'));
  assert.deepEqual([world.sent(CONTEXT).length, world.signs.length - signs, world.seller.vetWrites()], [0, 0, 0], 'nothing signed, sent or written');
  // The purchase's write check is asked before the route: a purchase that allows no new write never reaches it.
  const routed = [];
  const answer = await bareResolution(world.capability, { writable: () => 'purchase is cancelled', route: async (body) => { routed.push(body); } });
  assert.deepEqual([answer, routed], [{ disposition: 'indeterminate', reason: 'DEM delivery context route not sent: purchase is cancelled' }, []]);

  // The host stops once the plan step has accepted the presentation, after its entry checks: its context request records the
  // purchase's one suspension and is never signed. The next plan step is stopped at its entry and writes nothing.
  const stop = { flow: null };
  const stopping = await routeWorld(t, { stopped: () => Boolean(stop.flow?.purchase.get().state.protocol.buyerBundle) });
  const flow = stop.flow = await stopping.start();
  const before = stopping.signs.length;
  await assert.rejects(stopping.plan(flow), code('writes_stopped'));
  const { sellerSuspension, revision } = flow.purchase.get().state.protocol;
  assert.deepEqual([sellerSuspension?.cause, sellerSuspension?.path], ['writes_stopped', CONTEXT]);
  await assert.rejects(stopping.plan(flow), code('writes_stopped'));
  const after = flow.purchase.get().state.protocol;
  assert.deepEqual([after.sellerSuspension, after.revision], [sellerSuspension, revision], 'a repeated stop keeps the first suspension and writes nothing');
  assert.deepEqual([stopping.sent(CONTEXT).length, stopping.signs.length - before, stopping.seller.vetWrites()], [0, 0, 0], 'nothing signed, sent or written');
});

test('an unknown context dispatch reuses its retained body after restart', async (t) => {
  const world = await routeWorld(t);
  const flow = await world.start();
  // The host served the request; its answer never reached the client.
  world.replace = () => new TypeError('TEST the answer was lost');
  await assert.rejects(world.plan(flow), held(UNAUTHENTICATED));
  assert.equal(world.sent(CONTEXT).length, SENDS_PER_UNKNOWN_CALL, 'an unknown dispatch is sent again a bounded number of times');
  assertNothingPlanned(world, flow.purchase, 'lost answer');
  const sent = world.sent(CONTEXT).length;
  world.replace = null;
  world.restart();
  // An approved time other than the one the challenge bound is refused before anything is sent.
  await assert.rejects(world.plan(flow, world.clock.time + 1), code('agreement_time_mismatch'));
  // A stored request whose body differs from this step's body is refused before anything is sent.
  const row = flow.purchase.get(), protocol = row.state.protocol, stored = protocol.sellerRequests[CONTEXT];
  const original = JSON.parse(Buffer.from(stored.bodyB64, 'base64url'));
  const changed = JSON.stringify({ ...original, scope: { ...original.scope, generatedAt: original.scope.generatedAt + 1 } });
  const rewrite = (record) => world.ops().transition(row.id, row.status, row.status, { event: 'TEST-stored-request',
    state: { protocol: { ...flow.purchase.get().state.protocol, sellerRequests: { ...protocol.sellerRequests, [CONTEXT]: record }, revision: flow.purchase.get().state.protocol.revision + 1 } } });
  rewrite({ ...stored, bodyB64: Buffer.from(changed).toString('base64url'), bodyHash: sha256Hex(changed) });
  await assert.rejects(world.plan(flow), code('stored_request_mismatch'));
  assert.equal(world.sent(CONTEXT).length, sent, 'nothing was sent for a changed time or body');
  rewrite(stored);
  // The next explicit plan step sends the stored body again, and the seller answers from what it already wrote.
  const { operation } = await world.plan(flow);
  const bodies = world.contextBodies();
  assert.equal(bodies.length, sent + 1);
  assert.deepEqual(new Set(bodies), new Set([bodies[0]]), 'every send carried the same body bytes');
  assert.ok(operation.state.protocol.planned, 'the Agreement is planned');
  assert.equal(world.seller.vetWrites(), 2, 'no second Vet record');
});

test('a buyer route capability cannot configure the shipped seller context host', () => {
  const capability = createDemDeliveryContextRouteCaller({ authority: AUTHORITY });
  assert.throws(() => sellerContext.demDeliveryContextConfig(capability), { name: 'TypeError', message: 'demDeliveryContext requires a constructed application capability' });
});

test('a route caller without the protocol route refuses before any effect', async () => {
  const capability = createDemDeliveryContextRouteCaller({ authority: AUTHORITY });
  let checks = 0;
  const answer = await bareResolution(capability, { writable: () => { checks++; return true; } });
  assert.deepEqual(answer, { disposition: 'indeterminate', reason: 'DEM delivery context has no seller route for this purchase' });
  assert.equal(checks, 0, 'not even the write check runs');
});

test('an indeterminate context answer recovers only on an explicit same-scope plan call', async (t) => {
  const world = await routeWorld(t);
  const flow = await world.start();
  // The seller did the work and wrote its Vet records, but its signed answer says the outcome is not established.
  const uncertain = JSON.stringify({ error: 'operation_uncertain', message: 'the context operation did not finish and its outcome is not established' });
  world.replace = async (answer) => ({ ...answer, status: 503, text: uncertain, header: await signAnswer(world, answer.request, uncertain, { status: 503 }) });
  await assert.rejects(world.plan(flow), held(UNAUTHENTICATED));
  const sent = world.sent(CONTEXT).length;
  assert.equal(world.seller.vetWrites(), 2, 'the seller wrote its Vet records');
  world.replace = null;
  // A passive recheck has no readback for a route capability: it reads and sends nothing, and the purchase stays pending.
  const rechecked = await world.service().recheck(flow.purchase.get(), null);
  assert.deepEqual([rechecked.status, rechecked.state.protocol.stage, world.sent(CONTEXT).length], ['agreement_pending', 'identity', sent]);
  assert.deepEqual(await readBackDemDeliveryContext(world.capability, { jobId: JOB, buyer: buyer.claim }), { disposition: 'indeterminate', reason: 'DEM delivery context has no readback' });
  assertNothingPlanned(world, flow.purchase, 'recheck');
  // The explicit plan step sends the stored body under a new envelope; the seller answers its completed operation once it reads its
  // Vet records back, and writes none.
  const { operation } = await world.plan(flow);
  const requests = world.sent(CONTEXT), last = requests.at(-1);
  assert.deepEqual(new Set(requests.map((request) => request.init.body)), new Set([last.init.body]), 'every send carried the same body bytes');
  assert.equal(new Set(requests.map((request) => requestPayload(request.init).nonce)).size, requests.length, 'no earlier envelope is sent again');
  assert.ok(operation.state.protocol.planned, 'the Agreement is planned');
  assert.equal(world.seller.vetWrites(), 2, 'one Vet record per party, none written twice');
});
