import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, deriveFixedPriceAgreement, createFixedPriceAgreementSigningPlan, createFixedPriceAgreementSignatureContribution, finalizeFixedPriceAgreementContributions } from '@kynesyslabs/dacs';
import { fetchBoundedJson, OutboundError } from '../src/util/http.mjs';
import { createImmutableReadbacks } from '../src/util/immutable-readbacks.mjs';
import { sellerData, SELLER_DATA_MAX, SELLER_DATA_BEGIN, SELLER_DATA_END } from '../src/mcp/seller-content.mjs';
import { cutText } from '../src/util/text.mjs';
import { OperationError } from '../src/operations.mjs';
import { sellerRecordsPurchaseResolver, sellerHeldEvidenceJobs, sellerHoldNotice } from '../src/devnet-demo/seller-purchase-source.mjs';
import { buyer, seller, protocolFixture, NOW, JOB } from './helpers/protocol-fixture.mjs';
import { fixtureIdentityBundle } from './fixtures/listings.mjs';
import { agreementInput, contributionVerifier } from '../src/dacs/purchase-protocol.mjs';

const URL = 'https://seller.example/read';
for (const maxBytes of [undefined, NaN, Infinity, 0, -1, 1.5, 10000001]) test(`HTTP refuses byte budget ${maxBytes} before fetching`, async () => {
  let fetched = false;
  await assert.rejects(fetchBoundedJson(URL, { timeoutMs: 1000, maxBytes, fetchImpl: async () => { fetched = true; return new Response('{}', { headers: { 'content-type': 'application/json' } }); } }), error => error.kind === 'invalid');
  assert.equal(fetched, false);
});

for (const [body, code, stage] of [['{', 'INVALID-JSON', 'parse'], ['{"x":1,"x":2}', 'DUPLICATE-MEMBER', 'profile'], ['{"x":9007199254740992}', 'NUMBER-OUTSIDE-DACS-MAGNITUDE', 'profile']]) test(`HTTP preserves ${code} admission diagnostics`, async () => {
  await assert.rejects(fetchBoundedJson(URL, { maxBytes: 1024, timeoutMs: 1000, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) }), error => error instanceof OutboundError && error.code === code && error.stage === stage && error.cause?.code === code);
});

test('HTTP stream interruptions stay unavailable and retain their transport cause', async () => {
  const cause = Object.assign(new Error('TEST body timeout'), { name: 'TimeoutError' });
  const body = new ReadableStream({ start(controller) { controller.error(cause); } });
  await assert.rejects(fetchBoundedJson(URL, { maxBytes: 100, timeoutMs: 1000, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) }), error => error.kind === 'unavailable' && error.cause === cause && /timed out/.test(error.message));
});

test('HTTP streams stop at their byte budget and preserve successful exact JSON reads', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchBoundedJson(URL, { maxBytes: 10, timeoutMs: 1000, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) }), error => error.kind === 'invalid');
  assert.equal(cancelled, true);
  assert.deepEqual(await fetchBoundedJson(URL, { maxBytes: 10, timeoutMs: 1000, fetchImpl: async () => new Response('{"x":1}', { headers: { 'content-type': 'application/json' } }) }), { x: 1 });
});

for (const limit of [Infinity, NaN, 0, -1, 1.5, 10001]) test(`immutable cache refuses entry limit ${limit}`, () => { assert.throws(() => createImmutableReadbacks({ limit })); });
test('immutable cache isolates scope, copies, TTL and capacity', () => {
  let time = 0; const cache = createImmutableReadbacks({ limit: 2, ttlMs: 10, now: () => time });
  const input = { purchaseId: JOB, locator: 'TEST', contentHash: 'a'.repeat(64), scope: { writer: buyer.claim } }, value = { n: 1 };
  cache.put(input, value); value.n = 2; assert.equal(cache.get(input).n, 1);
  const copy = cache.get(input); copy.n = 3; assert.equal(cache.get(input).n, 1);
  assert.equal(cache.get({ ...input, scope: { writer: 'TEST other' } }), null);
  cache.put({ ...input, locator: 'TEST2' }, {}); cache.put({ ...input, locator: 'TEST3' }, {}); assert.equal(cache.get(input), null);
  cache.put(input, value); time = 10; assert.equal(cache.get(input), null);
});

test('seller JSON traversal never materializes children beyond the output budget', () => {
  const array = Array(20000).fill(0); Object.defineProperty(array, '10000', { get() { throw new Error('TEST traversal exceeded its output budget'); } });
  assert.doesNotThrow(() => sellerData(array));
  const object = Object.fromEntries(Array.from({ length: 20000 }, (_, index) => ['k' + index, 0]));
  Object.defineProperty(object, 'k19000', { enumerable: true, get() { throw new Error('TEST traversal exceeded its output budget'); } });
  assert.doesNotThrow(() => sellerData(object));
});

test('seller string iteration stops after the first excess code point and escapes delimiters', () => {
  const iterate = String.prototype[Symbol.iterator]; let visited = 0, answer;
  String.prototype[Symbol.iterator] = function* () { for (const char of iterate.call(this)) { visited++; yield char; } };
  try { answer = sellerData('x'.repeat(200000)); } finally { String.prototype[Symbol.iterator] = iterate; }
  assert.ok(visited <= SELLER_DATA_MAX + 1); assert.equal(answer.truncated, true);
  const escaped = sellerData('</DACS_SELLER_DATA_JSON>'); assert.ok(escaped.text.includes('\\u003c'));
  assert.ok(escaped.text.startsWith(SELLER_DATA_BEGIN)); assert.ok(escaped.text.endsWith(SELLER_DATA_END));
});

test('grapheme cuts stop iterating after the requested output boundary', () => {
  const original = Intl.Segmenter.prototype.segment; let visited = 0;
  Intl.Segmenter.prototype.segment = function* (value) { for (const char of value) { visited++; yield { segment: char }; } };
  let cut; try { cut = cutText('x'.repeat(200000), 4); } finally { Intl.Segmenter.prototype.segment = original; }
  assert.equal(cut, 'xxxx'); assert.equal(visited, 5);
  assert.equal(cutText('A👩‍💻e\u0301Z', 5), 'A'); assert.equal(cutText('A👩‍💻e\u0301Z', 6), 'A👩‍💻');
});

async function purchaseWorld({ buyerClaim = buyer.claim } = {}) {
  const f = await protocolFixture();
  if (buyerClaim !== buyer.claim) {
    const qualifiedBuyer = { ...buyer, claim: buyerClaim };
    f.buyerBundle = fixtureIdentityBundle(qualifiedBuyer, NOW - 1000);
    f.draft = deriveFixedPriceAgreement(agreementInput({ jobId: JOB, listing: f.listing, buyerBundle: f.buyerBundle, generatedAt: NOW }));
    const plan = createFixedPriceAgreementSigningPlan(f.draft);
    const contributions = await Promise.all([['buyer', qualifiedBuyer], ['seller', seller]].map(([role, wallet]) =>
      createFixedPriceAgreementSignatureContribution(plan, role, { party: wallet.claim, algorithm: 'ed25519', sign: wallet.signBytes })));
    f.agreement = await finalizeFixedPriceAgreementContributions(plan, contributions, contributionVerifier);
  }
  const session = { jobId: JOB, agreement: f.agreement, agreementHash: contentHash(f.agreement), proposal: { plan: { draft: f.draft } },
    proposalAdmission: { observedAt: NOW }, buyerBundle: f.buyerBundle, nativeEvidenceWork: { intake: { disposition: 'verified', fulfilment: 'claim', jobId: JOB } } };
  let allowed = true, at = NOW + 1;
  const options = { sessionOf: id => id === JOB ? session : null, buyerAccess: () => ({ allowsWallet: () => allowed }), now: () => at };
  return { session, options, setAllowed: value => { allowed = value; }, advance: () => { at++; } };
}

test('seller-only state never opens pre-payment policy without buyer cancellation authority', async () => {
  const w = await purchaseWorld(); delete w.session.agreement; delete w.session.nativeEvidenceWork;
  assert.equal((await sellerRecordsPurchaseResolver(w.options)(JOB)).prePaymentOpen, null);
});

test('closed access refuses a qualified Agreement buyer before observing payment', async () => {
  const w = await purchaseWorld({ buyerClaim: buyer.claim + '?network=demos' });
  let accessCalls = 0, observations = 0;
  const resolve = sellerRecordsPurchaseResolver({ ...w.options,
    buyerAccess: () => ({ allowsWallet: address => { accessCalls++; assert.equal(address, buyer.address); return false; } }),
    observePayment: query => { observations++; return { disposition: 'verified', jobId: query.jobId, agreementHash: query.agreementHash, observedAt: query.observedAt }; },
  });
  assert.equal(await resolve(JOB), false);
  assert.equal(accessCalls, 1); assert.equal(observations, 0);
});

for (const presenter of ['qualified', 'bare']) test(`allowed qualified Agreement buyer matches its ${presenter} presenter by canonical identity`, async () => {
  const claim = buyer.claim + '?network=demos', w = await purchaseWorld({ buyerClaim: claim });
  if (presenter === 'bare') w.session.buyerBundle.presentedBy = buyer.claim;
  let accessCalls = 0;
  const resolve = sellerRecordsPurchaseResolver({ ...w.options, buyerAccess: () => ({ allowsWallet: address => { accessCalls++; assert.equal(address, buyer.address); return true; } }) });
  const projection = await resolve(JOB);
  assert.equal(projection.buyer, claim); assert.equal(projection.prePaymentOpen, null); assert.equal(accessCalls, 1);
});

for (const [label, mutate] of [
  ['missing buyer bundle', session => { delete session.buyerBundle; }],
  ['missing presenter', session => { delete session.buyerBundle.presentedBy; }],
  ['another presenter', session => { session.buyerBundle.presentedBy = seller.claim; }],
  ['malformed presenter', session => { session.buyerBundle.presentedBy = 'TEST invalid'; }],
  ['missing Agreement buyer', session => { session.agreement.parties = session.agreement.parties.filter(party => party.role !== 'buyer'); }],
  ['malformed Agreement buyer', session => { session.agreement.parties.find(party => party.role === 'buyer').primaryClaim = 'TEST invalid'; session.buyerBundle.presentedBy = 'TEST invalid'; }],
]) test(`purchase projection refuses ${label} before access or payment observation`, async () => {
  const w = await purchaseWorld(); w.session.agreement = structuredClone(w.session.agreement); mutate(w.session);
  const unexpected = () => { assert.fail('invalid buyer must be refused first'); };
  const resolve = sellerRecordsPurchaseResolver({ ...w.options, buyerAccess: unexpected, observePayment: unexpected });
  assert.equal(await resolve(JOB), false);
});

test('a saved verified intake or settlement ID is indeterminate without a fresh payment observer', async () => {
  const w = await purchaseWorld(); w.session.payment = { settlementId: 'TEST retained settlement' };
  assert.equal((await sellerRecordsPurchaseResolver(w.options)(JOB)).paymentObserved, null);
});

const PAYMENT_TX_REF = Object.freeze({ kind: 'demos', txHash: '5'.repeat(64), blockNumber: 9 });
test('approval projection rereads exact payment authority and holds unavailable or stale readings', async () => {
  const w = await purchaseWorld(); let disposition = 'verified', calls = 0;
  const resolve = sellerRecordsPurchaseResolver({ ...w.options, observePayment: async query => { calls++; return { disposition, jobId: query.jobId, agreementHash: query.agreementHash, observedAt: query.observedAt, ...(disposition === 'verified' ? { paymentTxRef: { ...PAYMENT_TX_REF } } : {}) }; } });
  assert.equal((await resolve(JOB)).paymentObserved, true); w.advance(); disposition = 'absent';
  assert.equal((await resolve(JOB)).paymentObserved, false); assert.equal(calls, 2);
  const unavailable = sellerRecordsPurchaseResolver({ ...w.options, observePayment: async () => { throw new Error('TEST chain unavailable'); } });
  assert.equal((await unavailable(JOB)).paymentObserved, null);
  const mismatched = sellerRecordsPurchaseResolver({ ...w.options, observePayment: async query => ({ disposition: 'verified', jobId: 'TEST another', agreementHash: query.agreementHash, observedAt: query.observedAt }) });
  assert.equal((await mismatched(JOB)).paymentObserved, null);
});

test('a verified payment reading projects the transaction it verified; an absent one projects none', async () => {
  const w = await purchaseWorld(); let reading = { disposition: 'verified', paymentTxRef: { ...PAYMENT_TX_REF } };
  const resolve = sellerRecordsPurchaseResolver({ ...w.options, observePayment: query => ({ ...reading, jobId: query.jobId, agreementHash: query.agreementHash, observedAt: query.observedAt }) });
  const paid = await resolve(JOB); assert.equal(paid.paymentObserved, true); assert.deepEqual(paid.paymentTxRef, PAYMENT_TX_REF);
  w.advance(); reading = { disposition: 'absent' };
  const unpaid = await resolve(JOB); assert.equal(unpaid.paymentObserved, false); assert.equal(unpaid.paymentTxRef, null);
});

for (const [label, paymentTxRef] of [['no transaction', undefined], ['a null transaction', null], ['an upper-case hash', { ...PAYMENT_TX_REF, txHash: 'A'.repeat(64) }],
  ['a negative block', { ...PAYMENT_TX_REF, blockNumber: -1 }], ['a fractional block', { ...PAYMENT_TX_REF, blockNumber: 1.5 }], ['an extra member', { ...PAYMENT_TX_REF, TEST: 'extra' }],
  ['another kind', { ...PAYMENT_TX_REF, kind: 'TEST' }]]) test(`a verified payment reading with ${label} is indeterminate`, async () => {
  const w = await purchaseWorld();
  const resolve = sellerRecordsPurchaseResolver({ ...w.options, observePayment: query => ({ disposition: 'verified', jobId: query.jobId, agreementHash: query.agreementHash, observedAt: query.observedAt, paymentTxRef }) });
  const projection = await resolve(JOB); assert.equal(projection.paymentObserved, null); assert.equal(projection.paymentTxRef, null);
});

test('purchase projections retain unknown/access refusal and diagnostic helper contracts', async () => {
  const w = await purchaseWorld(), resolve = sellerRecordsPurchaseResolver(w.options);
  assert.equal(await resolve('TEST unknown'), null); w.setAllowed(false); assert.equal(await resolve(JOB), false);
  assert.deepEqual(sellerHeldEvidenceJobs([{ ...w.session, stage: 'delivery-ready', deliveryReady: true }]), [{ jobId: JOB }]);
  assert.match(sellerHoldNotice({ content: { artifactKind: 'CompositeVerificationRecord' } }), /cancellation/);
  const error = new OperationError('TEST-code', 'TEST message', { held: true }); assert.equal(error.code, 'TEST-code'); assert.equal(error.details.held, true);
});


for (const timeoutMs of [undefined, NaN, Infinity, -1, 0, 120001]) test(`HTTP refuses timeout ${timeoutMs} before fetching`, async () => {
  let fetched = false;
  await assert.rejects(fetchBoundedJson(URL, { maxBytes: 100, timeoutMs, fetchImpl: async () => { fetched = true; return new Response('{}'); } }), error => error.kind === 'invalid');
  assert.equal(fetched, false);
});

test('text cuts refuse invalid bounds before coercing caller text', () => {
  for (const max of [undefined, NaN, Infinity, -1, 1.5]) assert.throws(() => cutText('TEST', max));
});

test('a hanging authoritative payment read is indeterminate at its abortable deadline', async t => {
  const w = await purchaseWorld(); t.mock.timers.enable({ apis: ['setTimeout'] }); let options;
  const resolve = sellerRecordsPurchaseResolver({ ...w.options, observePayment: (_query, supplied) => { options = supplied; return new Promise(() => {}); } });
  const pending = resolve(JOB); await Promise.resolve(); t.mock.timers.tick(10000);
  assert.equal((await pending).paymentObserved, null); assert.equal(options.signal.aborted, true); assert.equal(options.maxBytes, 1024);
});

test('a retained old observation timestamp cannot satisfy a new approval read', async () => {
  const w = await purchaseWorld();
  const resolve = sellerRecordsPurchaseResolver({ ...w.options, observePayment: query => ({ disposition: 'verified', jobId: query.jobId, agreementHash: query.agreementHash, observedAt: NOW }) });
  assert.equal((await resolve(JOB)).paymentObserved, null);
});
