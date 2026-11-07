import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalize, createFixedPriceAgreementSigningPlan, createFixedPriceAgreementSignatureContribution, sha256Hex } from '@kynesyslabs/dacs';
import { createSellerTransportClientAuth, createSellerTransportServerAuth, sellerSessionDelegationSigningBytes,
  sellerTransportSigningBytes, verifySellerSessionDelegation, normalizeSellerSessionDelegationSignature, SELLER_CONTEXT_PATH, SELLER_CONTEXT_CHALLENGE_PATH, sellerContextScopeHash } from '../src/dacs/seller-transport-auth.mjs';
import { assertSellerSessionLifetime, SELLER_SESSION_MAX_LIFETIME_MS } from '../src/public/portal/seller-session-limits.mjs';

// Fixed public test seeds, never operator credentials.
function signer(seed) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  return { claim: `did:demos:agent:${publicKey}`, publicKey, sign: (bytes) => sign(null, bytes, privateKey) };
}
const buyer = signer(1), seller = signer(2), session = signer(3);
const jobId = '01J8N4YV7YVYQ4DB7M8T4C7W0A';
const pin = { listingId: 'TEST-listing', version: 1, contentHash: 'd'.repeat(64) };
const agreementHash = 'e'.repeat(64), statePath = '/dacs/v1/agreements/state';
const stateBody = () => ({ transportIdentity: { jobId, buyer: buyer.claim, seller: seller.claim, agreementHash } });
function delegation(overrides = {}) {
  const payload = { version: '1', kind: 'seller-session-delegation', buyer: buyer.claim, sessionPublicKey: session.publicKey,
    seller: seller.claim, listingPin: pin, jobId, notBefore: 900, expiresAt: 1500, ...overrides };
  return { payload, signature: buyer.sign(sellerSessionDelegationSigningBytes(payload)).toString('base64url') };
}
function world({ delegated = false, context = false, time = 1000, grant = delegation(), route, requestBody, bindingHash } = {}) {
  const calls = [], now = () => time;
  const store = { journaledOnlyReserve: true, bind() {}, finish() {}, close() {},
    reserve: (...args) => { calls.push(['reserve', ...args]); return { disposition: 'cached' }; },
    classify: (...args) => { calls.push(['classify', ...args]); return 'retry'; },
    issueContextChallenge: (...args) => { calls.push(['challenge', ...args]); },
    attemptContextPresentation: (...args) => { calls.push(['presentation', ...args]); },
    reconcile: (...args) => { calls.push(['reconcile', ...args]); }, resume: (...args) => { calls.push(['resume', ...args]); } };
  const scope = { source: 'TEST', wallet: 'TEST', jobId, buyer: buyer.claim, buyerBundleHash: 'c'.repeat(64), seller: seller.claim,
    listingPin: pin, rail: 'TEST', payee: seller.claim, price: '1', generatedAt: 900 };
  const body = requestBody ?? (context ? { scope, buyerIdentityBundle: { presentedBy: buyer.claim } } : stateBody());
  const path = route ?? (context ? SELLER_CONTEXT_PATH : statePath);
  const client = createSellerTransportClientAuth({ ...(delegated ? { sessionSigner: session, delegation: grant } : { buyerSigner: buyer }), seller: seller.claim,
    resolveJob: () => ({ listingPin: pin, agreementHash: bindingHash ?? (context ? sellerContextScopeHash(scope) : agreementHash) }), now, lifetimeMs: 100, nonce: () => Buffer.alloc(24, 4).toString('base64url') });
  const server = createSellerTransportServerAuth({ sellerSigner: seller, listingPin: pin, store, now, requireDelegation: delegated });
  return { client, server, store, calls, body, path, setTime: (value) => { time = value; },
    async request(value = body, rawBody = Buffer.from(JSON.stringify(value))) { const signed = await client.request(path, value, rawBody); return { request: server.readRequest(signed.header), rawBody, body: value, header: signed.header }; },
    validate(asked, extra = {}) { return server.validate(asked.request, { method: 'POST', path, rawBody: asked.rawBody, body: asked.body, ...extra }); } };
}
const encoded = (envelope) => Buffer.from(canonicalize(envelope)).toString('base64url');

test('all server sessions require a store that promises journal-only reservation', () => {
  for (const requireDelegation of [false, true]) for (const capability of [undefined, false, 'true']) {
    const store = { journaledOnlyReserve: capability, bind() {}, finish() {}, reserve: () => ({ disposition: 'perform' }) };
    assert.throws(() => createSellerTransportServerAuth({ sellerSigner: seller, listingPin: pin, store, requireDelegation }), /configuration is invalid/);
  }
});

test('request and response signatures bind the exact body, status and request', async () => {
  const w = world(), asked = await w.request(); w.validate(asked);
  const text = '{"TEST":"answer"}', header = await w.server.responseHeader(asked.request, 200, text);
  assert.equal(w.client.verifyResponse(asked.request, { header, status: 200, text }).principal, seller.claim);
  for (const changed of [{ status: 201, text }, { status: 200, text: text + ' ' }]) assert.throws(() => w.client.verifyResponse(asked.request, { header, ...changed }), { code: 'peer_response_mismatch' });
  const envelope = JSON.parse(Buffer.from(asked.header, 'base64url'));
  envelope.payload.nonce = Buffer.alloc(24, 5).toString('base64url');
  assert.throws(() => w.server.readRequest(encoded(envelope)), { code: 'peer_signature_invalid' });
  const response = JSON.parse(Buffer.from(header, 'base64url')); response.signature = Buffer.alloc(64).toString('base64url');
  assert.throws(() => w.client.verifyResponse(asked.request, { header: encoded(response), status: 200, text }), { code: 'peer_signature_invalid' });
  assert.throws(() => w.validate({ ...asked, rawBody: Buffer.from('{}') }), { code: 'peer_request_mismatch' });
});

test('live delegated sessions authenticate and bind the wallet signature to scope and time', async () => {
  const w = world({ delegated: true }), asked = await w.request(); w.validate(asked);
  assert.equal(w.server.readbackOnly(asked.request), false);
  w.server.store.attemptContextPresentation(asked.request, {});
  assert.equal(w.calls[0][0], 'presentation');
  const grant = delegation();
  assert.equal(verifySellerSessionDelegation(grant, { buyer: buyer.claim, seller: seller.claim, listingPin: pin, jobId, time: 900 }).buyer, buyer.claim);
  for (const options of [{ buyer: seller.claim }, { seller: buyer.claim }, { jobId: 'TEST-other' }, { listingPin: { ...pin, version: 2 } }]) assert.throws(() => verifySellerSessionDelegation(grant, options), { code: 'peer_delegation_mismatch' });
  for (const time of [899, 1500]) assert.throws(() => verifySellerSessionDelegation(grant, { time }), { code: 'peer_delegation_expired' });
  assert.throws(() => verifySellerSessionDelegation(grant, { deadline: 1499 }), { code: 'peer_delegation_deadline' });
  assert.throws(() => verifySellerSessionDelegation({ ...grant, signature: Buffer.alloc(64).toString('base64url') }), { code: 'peer_delegation_signature_invalid' });
  const bytes = buyer.sign(sellerSessionDelegationSigningBytes(grant.payload));
  assert.equal(normalizeSellerSessionDelegationSignature('0x0x' + bytes.toString('hex')), bytes.toString('base64url'));
});

test('expired delegation forwards journal readback but never presentation or retry effects', async () => {
  const w = world({ delegated: true, context: true, time: 2000 }), asked = await w.request(); w.validate(asked);
  assert.equal(w.server.readbackOnly(asked.request), true);
  w.server.store.reserve(asked.request, asked.body); w.server.store.classify(asked.request, asked.body);
  assert.deepEqual(w.calls.map((call) => [call[0], call[3]]), [['reserve', { journaledOnly: true }], ['classify', { journaledOnly: true }]]);
  for (const effect of [() => w.server.store.issueContextChallenge(asked.request, {}), () => w.server.store.attemptContextPresentation(asked.request, {}),
    () => w.server.store.resume({}, asked.request), () => w.server.store.reconcile({}, asked.request, 200, '{}', { retry: true }),
    () => w.server.store.reconcile({}, asked.request, 200, '{}', { noEffect: true })]) assert.throws(effect, { code: 'peer_delegation_expired' });
  assert.equal(w.calls.length, 2);
  w.server.store.reconcile({}, asked.request, 200, '{}'); assert.equal(w.calls.at(-1)[0], 'reconcile');
});

for (const body of [null, [], 4, 'TEST', true]) test(`a signed ${JSON.stringify(body)} body is refused before property access`, async () => {
  const w = world();
  // Sign the hostile body through the supported signing callback, retaining its hash.
  const valid = await w.request(), envelope = JSON.parse(Buffer.from(valid.header, 'base64url'));
  const rawBody = Buffer.from(JSON.stringify(body));
  const { sha256Hex } = await import('@kynesyslabs/dacs');
  envelope.payload.bodyHash = sha256Hex(rawBody);
  const { sellerTransportSigningBytes } = await import('../src/dacs/seller-transport-auth.mjs');
  envelope.signature = buyer.sign(sellerTransportSigningBytes(envelope.payload)).toString('base64url');
  const request = w.server.readRequest(encoded(envelope));
  assert.throws(() => w.validate({ request, rawBody, body }), { code: 'peer_body_invalid' });
});

test('the authenticated-body callback runs only after every validation succeeds', async () => {
  const w = world({ delegated: true }), asked = await w.request(); let calls = 0;
  const callback = () => { calls++; };
  w.validate(asked, { onAuthenticatedBody: callback }); assert.equal(calls, 1);
  w.setTime(asked.request.expiresAt);
  assert.throws(() => w.validate(asked, { onAuthenticatedBody: callback }), { code: 'peer_expired' }); assert.equal(calls, 1);
  w.setTime(1000);
  for (const change of [{ listingPin: { ...pin, version: 2 } }, { agreementHash: 'f'.repeat(64) }, { seller: buyer.claim }]) {
    assert.throws(() => w.validate({ ...asked, request: { ...asked.request, ...change } }, { onAuthenticatedBody: callback }));
    assert.equal(calls, 1);
  }
});

for (const [text, code, stage] of [['{"payload":{},"payload":{}}', 'DUPLICATE-MEMBER', 'profile'], ['{', 'INVALID-JSON', 'parse']]) test(`header admission preserves ${code} and its cause`, () => {
  const w = world();
  assert.throws(() => w.server.readRequest(Buffer.from(text).toString('base64url')), (error) => error.code === 'peer_envelope_invalid' && error.admissionCode === code && error.admissionStage === stage && error.cause?.code === code);
});

test('session lifetime accepts its boundary and refuses malformed or excessive durations', () => {
  assert.doesNotThrow(() => assertSellerSessionLifetime(SELLER_SESSION_MAX_LIFETIME_MS));
  for (const duration of [0, -1, 1.5, '100', SELLER_SESSION_MAX_LIFETIME_MS + 1]) assert.throws(() => assertSellerSessionLifetime(duration), RangeError);
  assert.throws(() => delegation({ expiresAt: 900 + SELLER_SESSION_MAX_LIFETIME_MS + 1 }), { code: 'peer_delegation_invalid' });
});


test('unsigned copies and changed authenticated requests never reach the authenticated callback', async () => {
  const w = world(), asked = await w.request(); let calls = 0;
  const onAuthenticatedBody = () => { calls++; };
  assert.throws(() => w.validate({ ...asked, request: structuredClone(asked.request) }, { onAuthenticatedBody }), { code: 'peer_request_unauthenticated' });
  asked.request.nonce = Buffer.alloc(24, 9).toString('base64url');
  assert.throws(() => w.validate(asked, { onAuthenticatedBody }), { code: 'peer_request_mismatch' });
  assert.equal(calls, 0);
});

test('body substitution and duplicate signed JSON members cannot reach the authenticated callback', async () => {
  const w = world(), asked = await w.request({ ...stateBody(), operation: 'safe' }); let calls = 0;
  const onAuthenticatedBody = () => { calls++; };
  assert.throws(() => w.validate({ ...asked, body: { ...asked.body, operation: 'changed' } }, { onAuthenticatedBody }), { code: 'peer_body_mismatch' });
  const rawBody = Buffer.from(`{"transportIdentity":${JSON.stringify(stateBody().transportIdentity)},"operation":"safe","operation":"changed"}`);
  const duplicate = await w.request(JSON.parse(rawBody), rawBody);
  assert.throws(() => w.validate(duplicate, { onAuthenticatedBody }), error => error.code === 'peer_body_invalid' && error.cause?.code === 'DUPLICATE-MEMBER');
  assert.equal(calls, 0);
});

test('the authenticated callback receives the owned value admitted from the signed raw bytes', async () => {
  const w = world(), asked = await w.request(); let admitted;
  w.validate(asked, { onAuthenticatedBody: value => { admitted = value; } });
  assert.deepEqual(admitted, asked.body);
  assert.notEqual(admitted, asked.body);
});

function agreementDraft(deadline = 2000) {
  return { agreementVersion: '1', jobId, listingRef: pin,
    parties: [['buyer', buyer], ['seller', seller]].map(([role, actor]) => ({ role, primaryClaim: actor.claim,
      bundleHash: sha256Hex(`TEST bundle ${role}`), vetRecordRef: { anchor: { kind: 'storage-program', locator: `TEST-vet-${role}` }, contentHash: sha256Hex(`TEST vet ${role}`) } })),
    terms: { deliverable: { deliverableType: 'attested-payload', hash: sha256Hex('TEST deliverable') },
      price: { amount: '1', currency: 'DEM' }, deadline }, derivedFromPattern: 'fixed-price', generatedAt: 900 };
}
async function proposalBody(deadline) {
  const plan = createFixedPriceAgreementSigningPlan(agreementDraft(deadline));
  const buyerContribution = await createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: buyer.claim, algorithm: 'ed25519', sign: buyer.sign });
  const material = { proposalVersion: '1', plan, buyerContribution }, proposalHash = sha256Hex(canonicalize(material));
  return { proposal: { ...material, proposalHash }, buyerIdentityBundle: { presentedBy: buyer.claim },
    transportIdentity: { ...stateBody().transportIdentity, agreementHash: plan.agreementHash, planHash: plan.planHash, proposalHash } };
}

test('proposal route accepts exact plans and rejects malformed or substituted proposal bindings', async () => {
  const body = await proposalBody(), w = world({ route: '/dacs/v1/agreements/proposals', requestBody: body, bindingHash: body.transportIdentity.agreementHash });
  w.validate(await w.request());
  const malformed = await w.request({ ...body, proposal: {} });
  assert.throws(() => w.validate(malformed), { code: 'peer_proposal_invalid' });
  const mismatch = await w.request({ ...body, buyerIdentityBundle: { presentedBy: seller.claim } });
  assert.throws(() => w.validate(mismatch), { code: 'peer_proposal_mismatch' });
});


test('payment route accepts a bound paying key and hash and refuses either substitution', async () => {
  const body = { jobId, payerPayingKey: buyer.claim, txHash: 'a'.repeat(64) }, w = world({ route: '/dacs/v1/payments', requestBody: body });
  w.validate(await w.request());
  for (const change of [{ payerPayingKey: seller.claim }, { txHash: 'invalid' }]) {
    const asked = await w.request({ ...body, ...change });
    assert.throws(() => w.validate(asked), { code: 'peer_payment_mismatch' });
  }
});

for (const delegated of [false, true]) test(`payment route refuses a body naming another job than the signed one (delegated=${delegated})`, async () => {
  const otherJobId = '01J8N4YV7YVYQ4DB7M8T4C7W0B', payment = { payerPayingKey: buyer.claim, txHash: 'a'.repeat(64) };
  const body = { ...payment, jobId: otherJobId, transportIdentity: { jobId } }, w = world({ delegated, route: '/dacs/v1/payments', requestBody: body });
  const asked = await w.request();
  assert.throws(() => w.validate(asked), { code: 'peer_job_mismatch' });
  const own = world({ delegated, route: '/dacs/v1/payments', requestBody: { ...payment, jobId, transportIdentity: { jobId } } });
  own.validate(await own.request());
});

test('challenge route authenticates its exact context scope and rejects a changed field', async () => {
  const { buyerBundleHash, ...scope } = world({ context: true }).body.scope;
  const w = world({ route: SELLER_CONTEXT_CHALLENGE_PATH, requestBody: { scope }, bindingHash: sellerContextScopeHash(scope) });
  w.validate(await w.request());
  const asked = await w.request({ scope: { ...scope, price: '2' } });
  assert.throws(() => w.validate(asked), { code: 'peer_context_mismatch' });
});

test('delegated server checks Agreement scope and deadlines before the authenticated callback', async () => {
  const w = world({ delegated: true }), asked = await w.request(); let calls = 0;
  w.validate(asked, { agreement: agreementDraft(1500), onAuthenticatedBody: () => { calls++; } });
  for (const [agreement, code] of [[agreementDraft(1499), 'peer_delegation_deadline'],
    [{ ...agreementDraft(), listingRef: { ...pin, version: 2 } }, 'peer_delegation_agreement_mismatch']]) {
    assert.throws(() => w.validate(asked, { agreement, onAuthenticatedBody: () => { calls++; } }), { code });
  }
  assert.equal(calls, 1);
  const body = await proposalBody(1499), proposal = world({ delegated: true, route: '/dacs/v1/agreements/proposals', requestBody: body, bindingHash: body.transportIdentity.agreementHash });
  const proposed = await proposal.request();
  assert.throws(() => proposal.validate(proposed), { code: 'peer_delegation_deadline' });
});


for (const delegated of [false, true]) test(`effect entry rechecks expired request time (delegated=${delegated})`, async () => {
  const w = world({ delegated, context: true }), asked = await w.request();
  w.validate(asked); w.setTime(asked.request.expiresAt);
  assert.equal(w.server.readbackOnly(asked.request), true);
  w.server.store.reserve(asked.request, asked.body); w.server.store.classify(asked.request, asked.body);
  assert.deepEqual(w.calls.map(call => [call[0], call[3]]), [['reserve', { journaledOnly: true }], ['classify', { journaledOnly: true }]]);
  for (const effect of [() => w.server.store.issueContextChallenge(asked.request, {}),
    () => w.server.store.attemptContextPresentation(asked.request, {}), () => w.server.store.resume({}, asked.request),
    () => w.server.store.reconcile({}, asked.request, 200, '{}', { retry: true }),
    () => w.server.store.reconcile({}, asked.request, 200, '{}', { noEffect: true })]) {
    assert.throws(effect, error => error.status === 408 && ['peer_expired', 'peer_delegation_expired'].includes(error.code));
  }
  assert.equal(w.calls.length, 2);
});

test('effect entry rechecks delegation expiry after successful validation', async () => {
  const w = world({ delegated: true, context: true }), asked = await w.request();
  w.validate(asked); w.setTime(1500);
  for (const method of ['issueContextChallenge', 'attemptContextPresentation']) {
    assert.throws(() => w.server.store[method](asked.request, {}), { code: 'peer_delegation_expired', status: 408 });
  }
  assert.equal(w.calls.length, 0);
});

test('scalar envelope fields refuse arrays and objects before authentication callbacks', async () => {
  const w = world(), asked = await w.request(); let callbacks = 0;
  const envelope = JSON.parse(Buffer.from(asked.header, 'base64url'));
  const fields = ['bodyHash', 'buyer', 'seller', 'agreementHash', 'nonce', 'requestHash', 'listingPin.contentHash'];
  const response = JSON.parse(Buffer.from(await w.server.responseHeader(asked.request, 200, '{}'), 'base64url'));
  for (const field of fields) for (const shape of ['array', 'object']) {
    const malformed = structuredClone(field === 'requestHash' ? response : envelope);
    const target = field.startsWith('listingPin.') ? malformed.payload.listingPin : malformed.payload;
    const key = field.split('.').at(-1), value = target[key];
    target[key] = shape === 'array' ? [value] : { toString: value };
    assert.throws(() => sellerTransportSigningBytes(malformed.payload), { code: 'peer_envelope_invalid', status: 401 });
    assert.throws(() => field === 'requestHash'
      ? w.client.verifyResponse(asked.request, { header: encoded(malformed), status: 200, text: '{}' })
      : w.validate({ ...asked, request: w.server.readRequest(encoded(malformed)) }, { onAuthenticatedBody: () => { callbacks++; } }), { code: 'peer_envelope_invalid', status: 401 });
  }
  assert.equal(callbacks, 0);
  await assert.rejects(world({ route: '/dacs/v1/payments', bindingHash: [agreementHash],
    requestBody: { jobId, payerPayingKey: buyer.claim, txHash: 'a'.repeat(64) } }).request(), { code: 'peer_envelope_invalid' });
});

test('signer and seller configuration rejects coercible claim values', () => {
  const coerce = { toString() { throw new Error('TEST claim coercion must not run'); } };
  for (const claim of [[buyer.claim], coerce]) {
    assert.throws(() => createSellerTransportClientAuth({ buyerSigner: { ...buyer, claim }, seller: seller.claim, resolveJob() {} }), /signing callback/);
    assert.throws(() => createSellerTransportServerAuth({ sellerSigner: { ...seller, claim }, listingPin: pin, store: {} }), /signing callback/);
    assert.throws(() => createSellerTransportClientAuth({ buyerSigner: buyer, seller: claim, resolveJob() {} }), /configuration/);
  }
});

test('transport factories share named lifetime, header and default limits', () => {
  const source = readFileSync(new URL('../src/dacs/seller-transport-auth.mjs', import.meta.url), 'utf8');
  assert.match(source, /const MAX_TRANSPORT_LIFETIME_MS = 60_000;/);
  const factories = source.slice(source.indexOf('export function createSellerTransportServerAuth('));
  assert.doesNotMatch(factories, /\b(?:60000|60_000|4096|30000)\b/);
  const header = source.slice(source.indexOf('function verifiedHeader('), source.indexOf('function publicKeyFor('));
  assert.doesNotMatch(header, /\b4096\b/);
});

test('a small-order identity key never authenticates a request or a delegation by the constant signature', async () => {
  // The identity point with R = the identity and S = 0 verifies for every message.
  const identityKey = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString('hex');
  const constantSignature = Buffer.concat([Buffer.from([1]), Buffer.alloc(63)]).toString('base64url');
  const forger = `did:demos:agent:${identityKey}`;
  const w = world(), asked = await w.request();
  for (const nonce of [Buffer.alloc(24, 5), Buffer.alloc(24, 6)]) {
    const envelope = JSON.parse(Buffer.from(asked.header, 'base64url'));
    Object.assign(envelope.payload, { buyer: forger, nonce: nonce.toString('base64url') });
    envelope.signature = constantSignature;
    assert.throws(() => w.server.readRequest(encoded(envelope)), { code: 'peer_signature_invalid' });
  }
  const forged = delegation({ buyer: forger });
  assert.throws(() => verifySellerSessionDelegation({ ...forged, signature: constantSignature }), { code: 'peer_delegation_signature_invalid' });
});
