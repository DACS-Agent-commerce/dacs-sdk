import assert from 'node:assert/strict';
import test from 'node:test';
import { createDirectoryClient, projectSummary } from '../src/dacs/directory.mjs';

const DIRECTORY_LIMIT = 10_000_000;
const origin = 'https://directory.invalid';
const summary = {
  listingId: 'example', version: 1, contentHash: 'a'.repeat(64),
  anchor: { kind: 'storage-program', locator: `stor-${'b'.repeat(40)}` },
  seller: { primaryClaim: `did:demos:agent:${'c'.repeat(64)}` },
  offering: { title: 'Example', description: '' }, status: 'active',
};
const revocationBinding = {
  sellerPrimaryClaim: summary.seller.primaryClaim, listingId: summary.listingId, listingVersion: 1,
  listingContentHash: summary.contentHash, logicalAddress: `dacs1-revoked:${summary.seller.primaryClaim}:example:v1`,
  markerAnchor: { kind: 'storage-program', locator: `stor-${'d'.repeat(40)}` }, markerContentHash: 'e'.repeat(64),
};
test('Directory preserves a Standard-named revocation binding through search and findSummary', async () => {
  const raw = { ...summary, status: 'revoked', revocation: revocationBinding };
  assert.deepEqual(projectSummary(raw).revocationBinding, revocationBinding);
  const client = createDirectoryClient({ origin, fetchImpl: async () => new Response(JSON.stringify({ listings: [raw] }), { headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual((await client.search()).listings[0].revocationBinding, revocationBinding);
  assert.deepEqual((await client.findSummary({ listingId: summary.listingId, version: 1, seller: summary.seller.primaryClaim })).revocationBinding, revocationBinding);
});
test('Directory projects equal aliases and drops ambiguous or malformed aliases', () => {
  const both = { ...summary, status: 'revoked', revocationBinding, revocation: { ...revocationBinding } };
  assert.deepEqual(projectSummary(both).revocationBinding, revocationBinding);
  assert.equal(projectSummary({ ...both, revocation: { ...revocationBinding, markerContentHash: 'f'.repeat(64) } }).revocationBinding, undefined);
  assert.equal(projectSummary({ ...both, revocation: {} }).revocationBinding, undefined);
});
test('Directory revocation discovery projects seven bounded fields and copies nested anchors', () => {
  const raw = { ...revocationBinding, extra: { text: 'TEST-untrusted-extension' },
    markerAnchor: { ...revocationBinding.markerAnchor, extra: ['TEST-extension'] } };
  const projected = projectSummary({ ...summary, status: 'revoked', revocationBinding: raw }).revocationBinding;
  assert.deepEqual(projected, revocationBinding);
  assert.notEqual(projected, raw);
  assert.notEqual(projected.markerAnchor, raw.markerAnchor);
});
for (const binding of [[], {}, { ...revocationBinding, logicalAddress: 'x'.repeat(1025) },
  { ...revocationBinding, markerContentHash: {} }, { ...revocationBinding, listingVersion: 0 },
  { ...revocationBinding, markerAnchor: { kind: 'TEST', locator: 'x'.repeat(1025) } }]) {
  test(`Directory drops malformed or oversized revocation discovery ${JSON.stringify(binding).slice(0, 70)}`, () => {
    const result = projectSummary({ ...summary, status: 'revoked', revocationBinding: binding });
    assert.equal(result.revocationBinding, undefined);
    assert.equal(result.listingId, summary.listingId);
  });
}
function listingBytes(length) {
  const body = { listings: Array.from({ length: 50 }, (_, i) => ({
    ...summary, listingId: `example-${i}`, offering: { ...summary.offering },
  })) };
  const padding = length - Buffer.byteLength(JSON.stringify(body));
  body.listings.forEach((listing, i) => {
    listing.offering.description = 'x'.repeat(Math.floor(padding / 50) + (i < padding % 50 ? 1 : 0));
  });
  const bytes = Buffer.from(JSON.stringify(body));
  assert.equal(bytes.length, length);
  return bytes;
}
function directory(t, bytes, maxBytes, declaredLength = false) {
  let calls = 0;
  t.after(() => assert.equal(calls, 1));
  return createDirectoryClient({
    origin, maxBytes,
    fetchImpl: async (input, init) => {
      calls += 1;
      const url = new URL(input);
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, '/api/dacs/listings');
      assert.equal(url.searchParams.get('limit'), '50');
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.redirect, 'manual');
      return new Response(bytes, { headers: {
        'content-type': 'application/json',
        ...(declaredLength ? { 'content-length': String(bytes.length) } : {}),
      } });
    },
  });
}

for (const [length, maxBytes] of [[1_000_000, undefined], [5_024_765, DIRECTORY_LIMIT], [DIRECTORY_LIMIT, DIRECTORY_LIMIT]]) {
  test(`Directory search admits ${length} exact bytes within its budget`, async t => {
    const result = await directory(t, listingBytes(length), maxBytes).search({ limit: 50 });
    assert.equal(result.listings.length, 50);
    assert.equal(result.rejected, 0);
    assert.equal(result.listings[49].listingId, 'example-49');
    assert.ok(result.listings.every(listing => listing.description === 'x'.repeat(2000)));
  });
}
for (const limit of [1_000_000, DIRECTORY_LIMIT]) {
  for (const declared of [false, true]) {
    test(`Directory search refuses ${limit} plus one byte (${declared ? 'declared' : 'streamed'})`, async t => {
      await assert.rejects(directory(t, listingBytes(limit + 1), limit, declared).search({ limit: 50 }),
        error => error.kind === 'invalid' && /response exceeds byte limit/.test(error.message));
    });
  }
}
for (const [suffix, code] of [
  [',"listings":[]}', 'DUPLICATE-MEMBER'],
  [',"rounded":9007199254740991.1}', 'NUMBER-OUTSIDE-DACS-MAGNITUDE'],
  [',"unicode":"\\ud800"}', 'INVALID-UNICODE'],
]) {
  test(`large Directory response still receives token admission: ${code}`, async t => {
    const bytes = Buffer.concat([listingBytes(5_024_765).subarray(0, -1), Buffer.from(suffix)]);
    await assert.rejects(directory(t, bytes, DIRECTORY_LIMIT).search({ limit: 50 }),
      error => error.kind === 'invalid' && error.code === code && error.stage === 'profile' && error.cause?.code === code);
  });
}
test('large Directory response rejects invalid UTF-8 before parsing', async t => {
  const bytes = listingBytes(5_024_765);
  bytes[bytes.lastIndexOf(0x78)] = 0xff;
  await assert.rejects(directory(t, bytes, DIRECTORY_LIMIT).search({ limit: 50 }),
    error => error.kind === 'invalid' && error.code === 'INVALID-UTF8' && error.stage === 'parse');
});
test('Directory rejects invalid byte budgets before making a request', async () => {
  let calls = 0;
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, DIRECTORY_LIMIT + 1, null, '10000000']) {
    const client = createDirectoryClient({ origin, maxBytes, fetchImpl: async () => {
      calls += 1;
      throw new Error('must not fetch');
    } });
    await assert.rejects(client.search(), error => error.kind === 'invalid' && /request byte limit/.test(error.message));
  }
  assert.equal(calls, 0);
});
