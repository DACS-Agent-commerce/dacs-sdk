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
  listingContentHash: summary.contentHash, logicalAddress: `dacs1-revoked:${encodeURIComponent(summary.seller.primaryClaim)}:example:v1`,
  markerAnchor: { kind: 'storage-program', locator: `stor-${'d'.repeat(40)}` }, markerContentHash: 'e'.repeat(64),
};
// Community 074f040: listings/route.ts filters activeCatalogListings;
// sellers/[primaryClaimRef]/route.ts returns seller.listings, including revoked.
test('exact lookup uses the pinned seller route to discover a revoked summary', async () => {
  const raw = { ...summary, status: 'revoked', revocation: revocationBinding };
  assert.deepEqual(projectSummary(raw).revocationBinding, revocationBinding);
  const paths = [];
  const client = createDirectoryClient({ origin, fetchImpl: async input => {
    const url = new URL(input); paths.push(url.pathname);
    const body = url.pathname === '/api/dacs/listings' ? { listings: [], total: 0 }
      : { listings: [raw], identity: {}, reputation: {}, deals: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual((await client.search()).listings, []);
  const found = await client.findSummary({ listingId: summary.listingId, version: 1, seller: summary.seller.primaryClaim });
  assert.deepEqual(found.revocationBinding, revocationBinding);
  assert.equal(found.verified, false);
  assert.deepEqual(paths, ['/api/dacs/listings', `/api/dacs/sellers/${encodeURIComponent(summary.seller.primaryClaim)}`]);
});
for (const alias of ['revocation', 'revocationBinding']) {
  test(`active summaries refuse ${alias} while valid revoked hints remain unverified`, () => {
    assert.throws(() => projectSummary({ ...summary, [alias]: revocationBinding }), { kind: 'invalid', message: 'active-record-has-binding' });
    const revoked = projectSummary({ ...summary, status: 'revoked', [alias]: revocationBinding });
    assert.deepEqual(revoked.revocationBinding, revocationBinding);
    assert.equal(revoked.verified, false);
    assert.equal(projectSummary(summary).verified, false);
  });
}
for (const patch of [
  { listingId: 'TEST-other' }, { listingVersion: 2 }, { sellerPrimaryClaim: 'TEST-other' },
  { listingContentHash: 'f'.repeat(64) }, { markerContentHash: 'TEST-not-hash' },
  { logicalAddress: 'TEST-wrong-prefix' },
]) {
  test(`revoked discovery drops malformed or unrelated binding ${Object.keys(patch)[0]}`, () => {
    for (const aliases of [{ revocation: { ...revocationBinding, ...patch } },
      { revocation: { ...revocationBinding, ...patch }, revocationBinding: { ...revocationBinding, ...patch } }]) {
      assert.equal(projectSummary({ ...summary, status: 'revoked', ...aliases }).revocationBinding, undefined);
    }
  });
}
test('revoked discovery preserves a generic Standard marker anchor', () => {
  const binding = { ...revocationBinding, markerAnchor: { kind: 'TEST-other-substrate', locator: 'TEST-native-locator' } };
  assert.deepEqual(projectSummary({ ...summary, status: 'revoked', revocation: binding }).revocationBinding, binding);
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

test('discovery hints cannot bypass held public artifact verification', async () => {
  const { createListingVerifier } = await import('@kynesyslabs/dacs-client');
  const hint = projectSummary({ ...summary, verified: true });
  assert.equal(hint.verified, false);
  let reads = 0;
  const verifier = createListingVerifier({ directory: { findSummary() { reads++; return hint; } } });
  await assert.rejects(verifier.verify(hint), { code: 'profile_not_admitted' });
  assert.equal(reads, 0);
});
for (const listings of [Array(201).fill(summary), [summary, summary]]) {
  test(`exact discovery refuses ${listings.length === 201 ? 'oversized' : 'ambiguous'} seller summaries`, async () => {
    const client = createDirectoryClient({ origin, fetchImpl: async () => new Response(JSON.stringify({ listings }), { headers: { 'content-type': 'application/json' } }) });
    await assert.rejects(client.findSummary({ listingId: summary.listingId, version: 1, seller: summary.seller.primaryClaim }), error => error.kind === 'invalid');
  });
}

for (const logicalAddress of ['dacs1-revoked:bogus',
  `dacs1-revoked:${summary.seller.primaryClaim}:example:v1`,
  revocationBinding.logicalAddress.replaceAll('%3A', '%3a'),
  revocationBinding.logicalAddress.replace(':example:', ':other:'),
  revocationBinding.logicalAddress.replace(':v1', ':v2')]) {
  test(`revocation hints require the exact CF-4 address: ${logicalAddress}`, () => {
    for (const alias of ['revocation', 'revocationBinding']) {
      assert.equal(projectSummary({ ...summary, status: 'revoked', [alias]: { ...revocationBinding, logicalAddress } }).revocationBinding, undefined);
      assert.deepEqual(projectSummary({ ...summary, status: 'revoked', [alias]: revocationBinding }).revocationBinding, revocationBinding);
    }
  });
}
for (const kind of ['fixed', 'negotiable', 'auction', 'metered']) {
  test(`Directory retains the pinned pricing kind ${kind}`, () => {
    assert.equal(projectSummary({ ...summary, pricing: { kind } }).pricingHint.kind, kind);
  });
}
for (const artifactProfile of ['dacs-v0.1', 'legacy-sdk-v0.1', 'fixture-listing']) {
  test(`Directory retains the pinned artifact profile ${artifactProfile}`, () => {
    assert.equal(projectSummary({ ...summary, artifactProfile }).artifactProfile, artifactProfile);
  });
}
test('Directory omits unknown presentation enums without discarding unverified discovery', () => {
  for (const value of ['TEST-unknown', '', null, {}, 1]) {
    const hint = projectSummary({ ...summary, pricing: { kind: value }, artifactProfile: value });
    assert.equal(hint.pricingHint.kind, undefined);
    assert.equal(hint.artifactProfile, undefined);
    assert.equal(hint.verified, false);
  }
});
test('Directory retains epoch milliseconds and bounded legacy ISO observation times', () => {
  for (const value of [1000, '1970-01-01T00:00:01.000Z']) {
    assert.equal(projectSummary({ ...summary, catalogObservedAt: value }).catalogObservedAt, 1000);
  }
  for (const value of [NaN, 1.5, -1, 'TEST-invalid-date', 'x'.repeat(65)]) {
    assert.equal(projectSummary({ ...summary, catalogObservedAt: value }).catalogObservedAt, undefined);
  }
});
for (const status of [404, 429, 500]) {
  test(`exact lookup preserves the meaning of HTTP ${status}`, async () => {
    const client = createDirectoryClient({ origin, fetchImpl: async () => new Response('{}', { status }) });
    const read = () => client.findSummary({ listingId: summary.listingId, version: 1, seller: summary.seller.primaryClaim });
    if (status === 404) assert.equal(await read(), null);
    else await assert.rejects(read, error => error.kind === 'unavailable' && error.status === status);
  });
}

for (const alias of ['revocation', 'revocationBinding']) {
  for (const binding of [revocationBinding, {}, null]) {
    test(`Directory search and exact lookup refuse active ${alias} evidence (${binding === null ? 'null' : Object.keys(binding).length})`, async () => {
      const raw = { ...summary, [alias]: binding };
      const client = createDirectoryClient({ origin, fetchImpl: async () =>
        new Response(JSON.stringify({ listings: [raw] }), { headers: { 'content-type': 'application/json' } }) });
      await assert.rejects(client.search(), { kind: 'invalid', message: 'active-record-has-binding' });
      await assert.rejects(client.findSummary({ listingId: summary.listingId, version: 1, seller: summary.seller.primaryClaim }),
        { kind: 'invalid', message: 'active-record-has-binding' });
    });
  }
}
test('Directory search and exact lookup accept active summaries without a binding', async () => {
  const client = createDirectoryClient({ origin, fetchImpl: async () =>
    new Response(JSON.stringify({ listings: [summary] }), { headers: { 'content-type': 'application/json' } }) });
  assert.equal((await client.search()).listings[0].status, 'active');
  assert.equal((await client.findSummary({ listingId: summary.listingId, version: 1, seller: summary.seller.primaryClaim })).status, 'active');
});
