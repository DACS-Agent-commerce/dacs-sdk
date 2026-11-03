import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectoryClient, projectSummary } from '../src/dacs/directory.mjs';
import { createListingVerifier } from '../src/dacs/verification.mjs';
import { fixtureListing, fixtureLocator, summaryFor } from './fixtures/listings.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const NOW = 1770000000000;
const DAY = 24 * 60 * 60 * 1000;
const wallet = createEphemeralWallet();
const listing = fixtureListing(wallet, { now: NOW });
const locator = fixtureLocator('catalog-observed-at');

const cases = [
  ['numeric observation a few minutes ago', NOW - 10 * 60 * 1000, NOW - 10 * 60 * 1000, true],
  ['numeric observation older than 24 hours', NOW - DAY - 1, NOW - DAY - 1, false],
  ['numeric observation exactly 24 hours old', NOW - DAY, NOW - DAY, true],
  ['numeric observation at the current time', NOW, NOW, true],
  ['numeric observation in the future', NOW + 1, NOW + 1, false],
  ['ISO observation a few minutes ago', new Date(NOW - 10 * 60 * 1000).toISOString(), NOW - 10 * 60 * 1000, true],
  ['ISO observation in the future', new Date(NOW + 1).toISOString(), NOW + 1, false],
  ['epoch zero observation', 0, 0, false],
  ['maximum safe integer observation', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, false],
  ...[
    ['negative number', -1],
    ['fractional number', NOW + 0.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['NaN', NaN],
    ['infinity', Infinity],
    ['unparseable string', 'not a date'],
    ['negative ISO observation', '1969-12-31T23:59:59.999Z'],
    ['overlong string', `${new Date(NOW).toISOString()}${'x'.repeat(1000)}`],
    ['object', { observedAt: NOW }],
    ['array', [NOW]],
    ['boolean', true],
    ['null', null],
    ['missing', undefined],
  ].map(([name, value]) => [name, value, undefined, false]),
];

for (const [name, value, expected, fresh] of cases) {
  test(`catalog observation: ${name}`, async () => {
    const raw = summaryFor(listing, locator);
    raw.catalogObservedAt = value;
    const projected = projectSummary(raw);
    assert.equal(projected.catalogObservedAt, expected, 'projection normalizes valid input to epoch milliseconds or treats it as missing');
    if (expected !== undefined) assert.ok(String(projected.catalogObservedAt).length <= 16, 'model text stays bounded');

    const directory = createDirectoryClient({
      origin: 'http://127.0.0.1',
      fetchImpl: async (url) => Response.json(new URL(url).pathname === '/api/dacs/listings' ? { listings: [raw] } : listing),
    });
    const chain = { readStorageProgram: async () => ({ status: 'found', data: listing, owner: wallet.address }) };
    const verifier = createListingVerifier({ directory, chain, now: () => NOW });
    const result = await verifier.verify({ listingId: listing.listingId, version: 1, seller: wallet.claim });
    assert.equal(result.checks.find((check) => check.name === 'catalog-observation-fresh').ok, fresh);
    assert.equal(result.transactable, fresh);
    assert.equal(result.disposition, fresh ? 'verified' : 'indeterminate');
    if (!fresh) assert.match(result.checks.find((check) => check.name === 'standard-reader-verified').detail, /catalog-stale/);
  });
}

for (const [name, observedAt, fresh] of [
  ['ISO string', new Date(NOW).toISOString(), true],
  ['numeric timestamp', NOW, true],
  ['future ISO string', new Date(NOW + 1).toISOString(), false],
]) {
  test(`direct summary fixture: ${name}`, async () => {
    const directory = {
      findSummary: async () => summaryFor(listing, locator, { observedAt }),
      getListingDetail: async () => listing,
    };
    const chain = { readStorageProgram: async () => ({ status: 'found', data: listing, owner: wallet.address }) };
    const result = await createListingVerifier({ directory, chain, now: () => NOW }).verify({ listingId: listing.listingId, version: 1, seller: wallet.claim });
    assert.equal(result.checks.find((check) => check.name === 'catalog-observation-fresh').ok, fresh);
    assert.equal(result.transactable, fresh);
  });
}
