import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import { createDemDeliveryContext, resolveDemDeliverySellerContext, DEM_DELIVERY_CONTEXT_LIMITS as LIMITS } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { protocolFixture, buyer, seller, JOB, NOW } from './helpers/protocol-fixture.mjs';
import { boundedResolutionValue } from '../src/util/bounded-resolution.mjs';

async function fixture() {
  const f = await protocolFixture();
  f.input.buyer.vetRecordRef.signer = seller.claim;
  f.input.seller.vetRecordRef.signer = buyer.claim;
  return { request: { ...f, jobId: JOB, generatedAt: NOW }, answer: { disposition: 'present', value: { input: f.input, vetRequirements: [] } } };
}
async function resolve(answer, request) {
  const context = createDemDeliveryContext({ authority: 'TEST-bounds', resolveBuyer: async () => null, resolveSeller: async () => answer });
  return resolveDemDeliverySellerContext(context, request);
}

for (const member of ['input', 'vetRequirements']) test(`rejects oversized ${member} strings before canonicalization`, async () => {
  const { answer, request } = await fixture();
  const oversized = '🙂'.repeat(LIMITS.maxBytes / 4);
  if (member === 'input') answer.value.input.verifiedListing.listing.offering.title = oversized;
  else answer.value.vetRequirements.push({ note: oversized });
  const result = await resolve(answer, request);
  assert.equal(result.disposition, 'indeterminate');
  assert.match(result.reason, /byte limit/);
});

test('caps the Vet requirement list independently of the generic array limit', async () => {
  const { answer, request } = await fixture();
  answer.value.vetRequirements = Array(LIMITS.maxVetRequirements + 1).fill(null);
  const result = await resolve(answer, request);
  assert.equal(result.disposition, 'indeterminate');
  assert.match(result.reason, /Vet requirement limit/);
});

for (const member of ['input', 'vetRequirements']) test(`caps nested lists in ${member}`, async () => {
  const { answer, request } = await fixture();
  const list = Array(LIMITS.maxListEntries + 1).fill(null);
  if (member === 'input') answer.value.input.selectedRail.extra = list;
  else answer.value.vetRequirements.push({ list });
  assert.match((await resolve(answer, request)).reason, /list limit/);
});

for (const kind of ['values', 'depth']) test(`caps aggregate ${kind} before copying repeated nested values`, async () => {
  const { answer, request } = await fixture();
  let nested = null;
  if (kind === 'values') nested = Array.from({ length: 32 }, () => Array(256).fill(null));
  else for (let i = 0; i < LIMITS.maxDepth + 1; i++) nested = { nested };
  answer.value.vetRequirements.push(nested);
  const result = await resolve(answer, request);
  assert.equal(result.disposition, 'indeterminate');
  assert.match(result.reason, kind === 'values' ? /value limit/ : /depth limit/);
});

for (const kind of ['string', 'key']) test(`accounts for JSON escaping in ${kind} byte budgets`, async () => {
  const { answer, request } = await fixture();
  const escaped = '\u0000'.repeat(Math.floor(LIMITS.maxBytes / 6));
  answer.value.vetRequirements = [kind === 'string' ? escaped : { [escaped]: null }];
  assert.match((await resolve(answer, request)).reason, /byte limit/);
});

test('refuses accessors without reading them', async () => {
  const { answer, request } = await fixture();
  let accessed = false;
  Object.defineProperty(answer.value.input, 'untrusted', { enumerable: true, get() { accessed = true; return null; } });
  const result = await resolve(answer, request);
  assert.equal(accessed, false);
  assert.equal(result.disposition, 'indeterminate');
  assert.match(result.reason, /JSON data/);
});

for (const kind of ['cycle', 'non-finite', 'unsupported', 'sparse', 'symbol']) test(`holds ${kind} replies`, async () => {
  const { answer, request } = await fixture();
  if (kind === 'cycle') answer.value.vetRequirements.push(answer);
  if (kind === 'non-finite') answer.value.vetRequirements.push(Infinity);
  if (kind === 'unsupported') answer.value.vetRequirements.push(new Date(0));
  if (kind === 'sparse') answer.value.vetRequirements = Array(2);
  if (kind === 'symbol') answer.value[Symbol('TEST')] = true;
  assert.equal((await resolve(answer, request)).disposition, 'indeterminate');
});

test('admits object and byte replies at the exact byte budget and refuses one byte more', async () => {
  const { answer, request } = await fixture();
  answer.value.vetRequirements = [''];
  const overhead = Buffer.byteLength(JSON.stringify(answer));
  answer.value.vetRequirements[0] = 'x'.repeat(LIMITS.maxBytes - overhead);
  const encoded = Buffer.from(JSON.stringify(answer));
  assert.equal(encoded.length, LIMITS.maxBytes);
  for (const value of [answer, encoded]) {
    const result = await resolve(value, request);
    assert.equal(result.disposition, 'present');
    assert.deepEqual(result.input, answer.value.input);
  }
  answer.value.vetRequirements[0] += 'x';
  for (const value of [answer, Buffer.from(JSON.stringify(answer))]) {
    const result = await resolve(value, request);
    assert.equal(result.disposition, 'indeterminate');
    assert.match(result.reason, /byte limit/);
  }
});

test('admitted results are independent canonical snapshots', async () => {
  const { answer, request } = await fixture();
  answer.value.vetRequirements = [{ note: 'e\u0301' }];
  const result = await resolve(answer, request);
  assert.equal(result.disposition, 'present');
  assert.equal(result.vetRequirements[0].note, 'é');
  assert.equal(canonicalize(result.input), canonicalize(answer.value.input));
  answer.value.vetRequirements[0].note = 'TEST-changed';
  answer.value.input.jobId = 'TEST-changed';
  assert.equal(result.input.jobId, JOB);
  assert.equal(result.vetRequirements[0].note, 'é');
});

for (const disposition of ['absent', 'rejected', 'indeterminate', 'unknown']) test(`bounded ${disposition} answers preserve held status and cause`, async () => {
  const { request } = await fixture();
  const result = await resolve({ disposition, reason: 'TEST-held-cause' }, request);
  assert.deepEqual(result, { disposition: disposition === 'unknown' ? 'indeterminate' : disposition, reason: 'TEST-held-cause' });
});

test('exact structural limits admit and one more refuses', () => {
  const defaults = { ...LIMITS, maxBytes: 1024 * 1024 };
  const cases = [
    ['value', { ...defaults, maxValues: 4 }, [null, null, null], [null, null, null, null]],
    ['depth', { ...defaults, maxDepth: 3 }, { a: { b: null } }, { a: { b: { c: null } } }],
    ['list', defaults, Array(256).fill(null), Array(257).fill(null)],
  ];
  for (const [kind, limits, exact, over] of cases) {
    assert.doesNotThrow(() => boundedResolutionValue(exact, limits));
    assert.throws(() => boundedResolutionValue(over, limits), new RegExp(`${kind} limit`));
  }
});

test('exact requirements limit and UTF-8/escaped byte budgets admit', async () => {
  const { answer, request } = await fixture();
  answer.value.vetRequirements = Array(LIMITS.maxVetRequirements).fill(null);
  assert.equal((await resolve(answer, request)).disposition, 'present');
  for (const text of ['🙂', '\u0000', 'é']) {
    answer.value.vetRequirements = [text];
    const remaining = LIMITS.maxBytes - Buffer.byteLength(JSON.stringify(answer));
    answer.value.vetRequirements[0] += 'x'.repeat(remaining);
    for (const value of [answer, Buffer.from(JSON.stringify(answer))]) assert.equal((await resolve(value, request)).disposition, 'present');
    answer.value.vetRequirements[0] += 'x';
    for (const value of [answer, Buffer.from(JSON.stringify(answer))]) assert.match((await resolve(value, request)).reason, /byte limit/);
  }
});

test('raw malformed UTF-8 and duplicate keys remain held', async () => {
  const { request } = await fixture();
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{"disposition":"absent","disposition":"present"}')]) {
    assert.equal((await resolve(bytes, request)).disposition, 'indeterminate');
  }
});
