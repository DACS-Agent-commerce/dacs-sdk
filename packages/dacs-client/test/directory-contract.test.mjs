// The client reads the Directory's actual row contract: `revocation`,
// `transactionReadiness` and an integer `catalogObservedAt`. Every row goes
// through the real Directory reader and the real Listing verifier; only the
// network and the chain are scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentHash, encodeAddressSegment, signedBytes } from '@kynesyslabs/dacs';
import { createDirectoryClient } from '../src/dacs/directory.mjs';
import { createListingVerifier } from '../src/dacs/verification.mjs';
import { createBuyerChainReadback } from '../src/dacs/buyer-chain-readback.mjs';
import { DemosSr2Error } from '../src/dacs/demos-sr2-adapter.mjs';
import { createDevnetAgreementTransport } from '../src/wallet/devnet-native-transport.mjs';
import { addressForClaim } from '../src/signatures.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing, fixtureLocator } from './fixtures/listings.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { readOnlyBoundary } from './helpers/read-only-boundary.mjs';

const contract = JSON.parse(readFileSync(new URL('./fixtures/directory-contract-c02.json', import.meta.url)));
const CHECKED_AT = Date.UTC(2026, 2, 1);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ORIGIN = 'https://directory.invalid';
const RAIL_CHECK = 'v0.1-purchase-support';
const ROW_CHECK = 'directory-row-contract';

const wallet = createEphemeralWallet();
const seller = wallet.claim;
const listing = fixtureListing(wallet, { now: CHECKED_AT });
const listingHash = contentHash(listing);
const locator = fixtureLocator('directory-contract-listing');
const markerLocator = fixtureLocator('directory-contract-marker');

const markerBody = { listingId: listing.listingId, listingVersion: listing.listingVersion, listingContentHash: listingHash, revokedAt: CHECKED_AT - HOUR_MS, reason: 'withdrawn' };
const marker = {
  ...markerBody,
  signature: { algorithm: 'ed25519', signer: seller, value: wallet.signBytes(signedBytes('dacs-revocation:v1:', contentHash(markerBody))).toString('base64url') },
};

const activeRow = (overrides = {}) => ({
  listingId: listing.listingId,
  version: listing.listingVersion,
  contentHash: listingHash,
  anchor: { kind: 'storage-program', locator },
  seller: { primaryClaim: seller, displayName: 'Fixture Seller' },
  offering: { title: listing.offering.title, description: listing.offering.description, category: listing.offering.category, tags: ['fixture'], rails: ['demos-native:DEM'] },
  pricing: { kind: 'fixed', priceHint: '2.5', currency: 'DEM' },
  publicEndpoint: listing.seller.publicEndpoint,
  artifactProfile: 'dacs-v0.1',
  status: 'active',
  transactionReadiness: { ...contract.transactionReadiness },
  catalogObservedAt: CHECKED_AT - HOUR_MS,
  ...overrides,
});
const revocationFor = (overrides = {}) => ({
  sellerPrimaryClaim: seller,
  listingId: listing.listingId,
  listingVersion: listing.listingVersion,
  listingContentHash: listingHash,
  logicalAddress: `${contract.logicalAddressPrefix}${encodeAddressSegment(seller)}:${listing.listingId}:v${listing.listingVersion}`,
  markerAnchor: { kind: 'storage-program', locator: markerLocator },
  markerContentHash: contentHash(marker),
  ...overrides,
});
const revokedRow = (overrides = {}) => activeRow({ status: 'revoked', revocation: revocationFor(), ...overrides });
const without = (value, member) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== member));

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A Directory serving `pages` (keyed by the request's cursor, '' for the
// first) and a chain serving the Listing and its revocation marker.
function world({ pages = {}, rows, fetchImpl } = {}) {
  const served = rows ? { '': { listings: rows } } : pages;
  const requests = [];
  const chainReads = [];
  const directory = createDirectoryClient({
    origin: ORIGIN,
    fetchImpl: fetchImpl ?? (async (input) => {
      const url = new URL(input);
      requests.push(url);
      if (url.pathname !== '/api/dacs/listings') return jsonResponse(listing);
      const page = served[url.searchParams.get('cursor') ?? ''];
      return page ? jsonResponse(page) : jsonResponse({ error: 'no page' }, 404);
    }),
  });
  const chain = {
    rpcOrigin: 'https://rpc.invalid',
    network: 'testnet',
    evidenceMode: 'TEST',
    readStorageProgram: async (read) => {
      chainReads.push(read);
      if (read === locator) return { status: 'found', data: listing, owner: addressForClaim(seller) };
      if (read === markerLocator) return { status: 'found', data: marker, owner: addressForClaim(seller) };
      return { status: 'indeterminate', reason: 'not served' };
    },
  };
  const verify = () => createListingVerifier({ directory, chain, now: () => CHECKED_AT })
    .verify({ listingId: listing.listingId, version: listing.listingVersion, seller });
  return { directory, requests, chainReads, verify };
}

const failedChecks = (result) => result.checks.filter((check) => !check.ok).map((check) => check.name);
const checkNamed = (result, name) => result.checks.find((check) => check.name === name);

// The Directory and chain checks all pass and the Standard reader gets past
// its signature, validity and revocation steps. It then stops at step 8, the
// rail step, because the client has no authenticated rail resolution yet, and
// the purchase-support check holds for the same reason.
function assertReachesRailAdmission(w, result) {
  assert.deepEqual(failedChecks(result), ['standard-reader-verified', RAIL_CHECK]);
  assert.match(checkNamed(result, 'standard-reader-verified').detail, /step 8: malformed-rail-authority/);
  assert.ok(w.chainReads.includes(locator));
}

function assertRowRefused(result, code, member) {
  const check = checkNamed(result, ROW_CHECK);
  assert.equal(check?.ok, false, JSON.stringify(result.checks));
  assert.ok(check.detail.includes(code), check.detail);
  if (member) assert.ok(check.detail.includes(member), check.detail);
  assert.equal(result.transactable, false);
  assert.notEqual(result.disposition, 'not-found');
}

async function refusedRow(row, code, member) {
  const w = world({ rows: [row] });
  assertRowRefused(await w.verify(), code, member);
  return w;
}

test('fresh active row with matching chain listing reaches rail admission with every other check passing', async () => {
  const w = world({ rows: [activeRow()] });
  assertReachesRailAdmission(w, await w.verify());
});
test('a row without rail authority fails at rail admission while the Directory and chain checks pass', async () => {
  const w = world({ rows: [activeRow()] });
  const result = await w.verify();
  assert.equal(result.transactable, false);
  assert.equal(result.listing, undefined);
  assert.equal(checkNamed(result, RAIL_CHECK)?.ok, false);
  assert.equal(checkNamed(result, 'chain-readback-equals-directory-detail')?.ok, true);
  assert.equal(checkNamed(result, 'catalog-observation-fresh')?.ok, true);
  assert.equal(checkNamed(result, ROW_CHECK), undefined);
});

test('revoked row with only revocationBinding is blocked and the legacy field is not read', async () => {
  const w = await refusedRow(revokedRow({ revocation: undefined, revocationBinding: revocationFor() }), 'directory_row_malformed', 'revocation');
  assert.ok(!w.chainReads.includes(markerLocator));
});
test('revoked row with neither field is blocked', async () => {
  await refusedRow(revokedRow({ revocation: undefined }), 'directory_row_malformed', 'revocation');
});
test('transactionReadiness disposition assessed is malformed and blocked', async () => {
  await refusedRow(activeRow({ transactionReadiness: { disposition: 'assessed', reason: 'catalog only' } }), 'directory_row_malformed', 'transactionReadiness');
});
test('revocation for another Listing content hash is blocked', async () => {
  const other = 'f'.repeat(64);
  const w = world({ rows: [revokedRow({ contentHash: other, revocation: revocationFor({ listingContentHash: other }) })] });
  const result = await w.verify();
  assert.equal(checkNamed(result, ROW_CHECK), undefined);
  assert.equal(checkNamed(result, 'directory-detail-hash-matches-summary')?.ok, false);
  assert.equal(checkNamed(result, 'standard-reader-verified')?.ok, false);
  assert.notEqual(result.disposition, 'revoked');
  assert.equal(result.transactable, false);
});
test('Directory unavailable rejects verify with the original cause and chain readback of a committed purchase makes no Directory call', async () => {
  const failure = new TypeError('fetch failed');
  await assert.rejects(world({ fetchImpl: async () => { throw failure; } }).verify(), (error) => error.kind === 'unavailable' && error.cause === failure);

  const directoryRequests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { directoryRequests.push(String(input)); throw failure; };
  try {
    const source = createDevnetAgreementTransport({
      boundary: readOnlyBoundary,
      expected: { network: 'testnet', chainIdentity: 'f'.repeat(64), pinVersion: 'TEST-1', endpoint: 'https://rpc.invalid/', transportAuthority: 'TEST-owner' },
      transportOwner: { getContext() { throw new Error('unused'); }, acquireConnectionFence() { throw new Error('unused'); } },
      journal: { get: async () => null, put: async () => { throw new Error('read only'); }, entries: async () => [], withWalletLock: (_key, work) => work() },
    });
    const readback = createBuyerChainReadback({ sourceCapability: source, reader: {
      read: async () => { throw new DemosSr2Error('invalid', 'node bytes did not authenticate'); },
      verifyReceipt: async () => { throw new Error('must not verify a missing record'); },
    } });
    const jobId = '01HZY3K8V9Q2W4E6R7T8Y9X0AB';
    const signedProjection = { hash: 'b'.repeat(64), content: { from: `0x${'a'.repeat(64)}`, to: locator, data: ['storageProgram', { metadata: { logicalAddress: `dacs4:deliverable:${jobId}`, artifactKind: 'Deliverable' } }] }, signature: { type: 'ed25519', data: '00' } };
    const result = await readback.readDeliverable({ jobId, agreementHash: 'd'.repeat(64), listing, seller, signedProjection, receiptContentHash: 'e'.repeat(64),
      deliveryBinding: { jobId, agreementHash: 'd'.repeat(64), listing: { listingId: listing.listingId, version: listing.listingVersion, contentHash: listingHash }, payloadHash: 'e'.repeat(64) } });
    assert.equal(result.status, 'indeterminate');
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(directoryRequests, []);
});
test('active row carrying revocation is a schema violation and blocked', async () => {
  await refusedRow(activeRow({ revocation: revocationFor() }), 'directory_row_malformed', 'revocation');
});
test('revoked row with a conflicting legacy binding is decided by revocation', async () => {
  const legacyLocator = fixtureLocator('conflicting-legacy-marker');
  const w = world({ rows: [revokedRow({ revocationBinding: revocationFor({ markerAnchor: { kind: 'storage-program', locator: legacyLocator } }) })] });
  const result = await w.verify();
  assert.equal(result.disposition, 'revoked');
  assert.equal(checkNamed(result, 'standard-reader-verified')?.ok, false);
  assert.ok(w.chainReads.includes(markerLocator));
  assert.ok(!w.chainReads.includes(legacyLocator));
});
test('active row with a legacy binding ignores it and reaches rail admission', async () => {
  const w = world({ rows: [activeRow({ revocationBinding: revocationFor() })] });
  assertReachesRailAdmission(w, await w.verify());
  assert.ok(!w.chainReads.includes(markerLocator));
});
test('correctly bound revocation verifies the marker and blocks as revoked', async () => {
  const w = world({ rows: [revokedRow()] });
  const result = await w.verify();
  assert.equal(result.disposition, 'revoked');
  assert.match(checkNamed(result, 'standard-reader-verified').detail, /verified-revocation-marker/);
  assert.ok(w.chainReads.includes(markerLocator));
});
for (const member of ['sellerPrimaryClaim', 'listingId', 'listingVersion', 'listingContentHash']) {
  test(`wrong ${member} blocks naming the member`, async () => {
    const wrong = { sellerPrimaryClaim: `did:demos:agent:${'9'.repeat(64)}`, listingId: 'another-listing', listingVersion: 2, listingContentHash: 'e'.repeat(64) }[member];
    await refusedRow(revokedRow({ revocation: revocationFor({ [member]: wrong }) }), 'directory_row_malformed', `revocation.${member}`);
  });
}
test('logicalAddress outside dacs1-revoked blocks naming the member', async () => {
  await refusedRow(revokedRow({ revocation: revocationFor({ logicalAddress: `dacs1-active:${encodeAddressSegment(seller)}:${listing.listingId}:v1` }) }), 'directory_row_malformed', 'revocation.logicalAddress');
});
test('missing markerAnchor blocks naming the member', async () => {
  await refusedRow(revokedRow({ revocation: without(revocationFor(), 'markerAnchor') }), 'directory_row_malformed', 'revocation.markerAnchor');
});
test('wrong markerContentHash blocks naming the member', async () => {
  const w = world({ rows: [revokedRow({ revocation: revocationFor({ markerContentHash: 'f'.repeat(64) }) })] });
  const result = await w.verify();
  assert.equal(checkNamed(result, 'standard-reader-verified')?.ok, false);
  assert.match(checkNamed(result, 'standard-reader-verified').detail, /marker-content-hash-mismatch/);
  assert.notEqual(result.disposition, 'revoked');
  await refusedRow(revokedRow({ revocation: revocationFor({ markerContentHash: 'not-a-hash' }) }), 'directory_row_malformed', 'revocation.markerContentHash');
});

test('observation exactly 86,400,000 ms old reaches rail admission', async () => {
  const w = world({ rows: [activeRow({ catalogObservedAt: CHECKED_AT - DAY_MS })] });
  assertReachesRailAdmission(w, await w.verify());
});
test('observation 86,400,001 ms old is blocked as stale', async () => {
  const result = await world({ rows: [activeRow({ catalogObservedAt: CHECKED_AT - DAY_MS - 1 })] }).verify();
  assert.equal(checkNamed(result, 'catalog-observation-fresh')?.ok, false);
  assert.equal(checkNamed(result, ROW_CHECK), undefined);
  assert.equal(result.transactable, false);
});
test('observation 1 ms in the future is blocked', async () => {
  const result = await world({ rows: [activeRow({ catalogObservedAt: CHECKED_AT + 1 })] }).verify();
  assert.equal(checkNamed(result, 'catalog-observation-fresh')?.ok, false);
  assert.equal(result.transactable, false);
});
test('missing observation is blocked', async () => {
  await refusedRow(without(activeRow(), 'catalogObservedAt'), 'directory_row_malformed', 'catalogObservedAt');
});
test('catalogObservedAt as a date string is malformed', async () => {
  await refusedRow(activeRow({ catalogObservedAt: new Date(CHECKED_AT - HOUR_MS).toISOString() }), 'directory_row_malformed', 'catalogObservedAt');
  for (const value of [-1, 1.5, String(CHECKED_AT), null, true]) {
    await refusedRow(activeRow({ catalogObservedAt: value }), 'directory_row_malformed', 'catalogObservedAt');
  }
});

test('unknown status is blocked', async () => {
  await refusedRow(activeRow({ status: 'unknown' }), 'directory_row_malformed', 'status');
});
test('absent status is blocked', async () => {
  await refusedRow(without(activeRow(), 'status'), 'directory_row_malformed', 'status');
});

test('transactionReadiness with an extra member is malformed', async () => {
  await refusedRow(activeRow({ transactionReadiness: { ...contract.transactionReadiness, extra: true } }), 'directory_row_malformed', 'transactionReadiness');
});
test('transactionReadiness without reason is malformed', async () => {
  await refusedRow(activeRow({ transactionReadiness: { disposition: 'unassessed' } }), 'directory_row_malformed', 'transactionReadiness');
  await refusedRow(activeRow({ transactionReadiness: { disposition: 'unassessed', reason: '' } }), 'directory_row_malformed', 'transactionReadiness');
});
test('unassessed readiness grants nothing by itself and the reader decides', async () => {
  const w = world({ rows: [activeRow({ transactionReadiness: { disposition: 'unassessed', reason: 'catalog only' } })] });
  const result = await w.verify();
  assertReachesRailAdmission(w, result);
  const revoked = await world({ rows: [revokedRow({ transactionReadiness: { disposition: 'unassessed', reason: 'catalog only' } })] }).verify();
  assert.equal(revoked.disposition, 'revoked');
  await refusedRow(without(activeRow(), 'transactionReadiness'), 'directory_row_malformed', 'transactionReadiness');
});
// Without listingId, version or seller a row has other coordinates, so the lookup never matches it.
const COORDINATE_MEMBERS = ['listingId', 'version', 'seller'];
test('a row missing any required Directory member is refused by the lookup naming that member', async () => {
  for (const member of contract.rowMembers.filter((name) => !COORDINATE_MEMBERS.includes(name))) {
    await refusedRow(without(activeRow(), member), 'directory_row_malformed', member);
  }
});
test('search counts a row missing any required Directory member as rejected and lists a full row', async () => {
  for (const member of contract.rowMembers) {
    const served = { listings: [activeRow(), without(activeRow({ listingId: 'bad-row' }), member)] };
    const directory = createDirectoryClient({ origin: ORIGIN, fetchImpl: async () => jsonResponse(served) });
    const result = await directory.search({ limit: 50 });
    assert.deepEqual(result.listings.map((summary) => summary.listingId), [listing.listingId], member);
    assert.equal(result.rejected, 1, member);
  }
});

test('a revocation with an unknown member is malformed naming that member', async () => {
  await refusedRow(revokedRow({ revocation: revocationFor({ extraMember: 1 }) }), 'directory_row_malformed', 'revocation.extraMember');
});
test('a markerAnchor with an unknown member is malformed naming that member', async () => {
  const markerAnchor = { kind: 'storage-program', locator: markerLocator, extraMember: 1 };
  await refusedRow(revokedRow({ revocation: revocationFor({ markerAnchor }) }), 'directory_row_malformed', 'revocation.markerAnchor.extraMember');
});
test('an active row with revocation null is a schema violation and blocked', async () => {
  await refusedRow(activeRow({ revocation: null }), 'directory_row_malformed', 'revocation');
});
test('each required revocation member removed or mistyped in turn blocks naming the member', async () => {
  for (const member of contract.revocationMembers) {
    await refusedRow(revokedRow({ revocation: without(revocationFor(), member) }), 'directory_row_malformed', `revocation.${member}`);
    await refusedRow(revokedRow({ revocation: revocationFor({ [member]: 42 }) }), 'directory_row_malformed', `revocation.${member}`);
  }
  for (const member of contract.markerAnchorMembers) {
    const markerAnchor = { kind: 'storage-program', locator: markerLocator, [member]: '' };
    await refusedRow(revokedRow({ revocation: revocationFor({ markerAnchor }) }), 'directory_row_malformed', 'revocation.markerAnchor');
  }
});

const siblingRow = (overrides) => activeRow({ listingId: 'another-listing', ...overrides });
test('an active match followed by a revoked or malformed duplicate on a later page blocks as directory_row_ambiguous', async () => {
  for (const duplicate of [revokedRow(), activeRow({ status: 'unknown' })]) {
    const w = world({ pages: { '': { listings: [activeRow()], cursor: '1' }, 1: { listings: [duplicate] } } });
    assertRowRefused(await w.verify(), 'directory_row_ambiguous');
    assert.equal(w.requests.length, 2);
  }
});
test('a sole malformed exact row blocks as directory_row_malformed naming its member and is never not-found', async () => {
  const w = world({ rows: [siblingRow(), activeRow({ transactionReadiness: { disposition: 'assessed', reason: 'x' } })] });
  const result = await w.verify();
  assertRowRefused(result, 'directory_row_malformed', 'transactionReadiness');
  await assert.rejects(w.directory.findSummary({ listingId: listing.listingId, version: listing.listingVersion, seller }),
    (error) => error.kind === 'invalid' && error.code === 'directory_row_malformed' && error.member === 'transactionReadiness');
});
// The seller's `count` rows, 50 to a page as the lookup asks, with this
// Listing's row at index `matchAt` and other Listings everywhere else.
function sellerPages(count, matchAt) {
  const rows = Array.from({ length: count }, (_, i) => (i === matchAt ? activeRow() : siblingRow({ listingId: `other-${i}` })));
  const pages = {};
  for (let page = 0; page * 50 < count; page += 1) {
    const more = (page + 1) * 50 < count;
    pages[page === 0 ? '' : String(page)] = { listings: rows.slice(page * 50, (page + 1) * 50), ...(more ? { cursor: String(page + 1) } : {}) };
  }
  return pages;
}
const listingPageReads = (w) => w.requests.filter((url) => url.pathname === '/api/dacs/listings').length;
const exactCoordinates = { listingId: listing.listingId, version: listing.listingVersion, seller };
const unconfirmed = (error) => error.kind === 'invalid' && error.code === 'directory_scan_unconfirmed';
function assertUnconfirmedAndNeverVerified(w, result) {
  assertRowRefused(result, 'directory_scan_unconfirmed');
  assert.equal(result.transactable, false);
  assert.equal(result.disposition, 'directory-row-invalid');
  assert.equal(result.standardReaderInput, null);
  assert.deepEqual(w.chainReads, []);
  assert.equal(listingPageReads(w), 5);
}
test('a seller with 251 rows and the match on the first page is directory_scan_unconfirmed and never verified', async () => {
  const w = world({ pages: sellerPages(251, 0) });
  assertUnconfirmedAndNeverVerified(w, await w.verify());
  await assert.rejects(w.directory.findSummary(exactCoordinates), unconfirmed);
});
test('conflicting rows for one listing at rows 1 and 251 are refused and never return row 1', async () => {
  const pages = sellerPages(251, 0);
  pages[5] = { listings: [activeRow({ contentHash: 'f'.repeat(64), pricing: { kind: 'fixed', priceHint: '9.5', currency: 'DEM' } })] };
  const w = world({ pages });
  assertUnconfirmedAndNeverVerified(w, await w.verify());
  await assert.rejects(w.directory.findSummary(exactCoordinates), unconfirmed);
});
test('a seller whose list ends within five pages with the match on the first page is found and verified', async () => {
  const w = world({ pages: sellerPages(120, 0) });
  assertReachesRailAdmission(w, await w.verify());
  assert.equal(listingPageReads(w), 3);
  const summary = await w.directory.findSummary(exactCoordinates);
  assert.equal(summary.contentHash, listingHash);
});
test('a seller with 251 rows and no match in the five scanned pages is directory_scan_incomplete and never not-found', async () => {
  const w = world({ pages: sellerPages(251, 250) });
  assertRowRefused(await w.verify(), 'directory_scan_incomplete');
  assert.equal(listingPageReads(w), 5);
});
test('a repeated cursor or a present invalid cursor is directory_cursor_invalid', async () => {
  const repeated = world({ pages: { '': { listings: [activeRow()], cursor: '1' }, 1: { listings: [siblingRow()], cursor: '1' } } });
  assertRowRefused(await repeated.verify(), 'directory_cursor_invalid');
  for (const cursor of ['not-a-cursor', '', 7, '1234567890']) {
    assertRowRefused(await world({ pages: { '': { listings: [activeRow()], cursor } } }).verify(), 'directory_cursor_invalid');
  }
});
test('a single valid match followed by a clean end reaches rail admission through the verifier', async () => {
  const w = world({ pages: { '': { listings: [siblingRow()], cursor: '1' }, 1: { listings: [activeRow()] } } });
  assertReachesRailAdmission(w, await w.verify());
});
test('an exact-coordinate lookup with no match and a clean end is not found', async () => {
  const result = await world({ rows: [siblingRow()] }).verify();
  assert.equal(result.disposition, 'not-found');
  assert.equal(result.transactable, false);
});

const malformedVariants = {
  'date-string observation': activeRow({ listingId: 'bad-row', catalogObservedAt: new Date(CHECKED_AT).toISOString() }),
  'unknown status': activeRow({ listingId: 'bad-row', status: 'unknown' }),
  'assessed readiness': activeRow({ listingId: 'bad-row', transactionReadiness: { disposition: 'assessed', reason: 'x' } }),
  'active row with revocation null': activeRow({ listingId: 'bad-row', revocation: null }),
  'revoked row without revocation': revokedRow({ listingId: 'bad-row', revocation: undefined }),
  'revocation with a wrong claim': revokedRow({ listingId: 'bad-row', revocation: revocationFor({ sellerPrimaryClaim: `did:demos:agent:${'9'.repeat(64)}` }) }),
  'content hash that is not a hash': activeRow({ listingId: 'bad-row', contentHash: 'not-a-hash' }),
};
test('production search with one valid row and one malformed row returns only the valid summary with rejected 1 and the cursor and total unchanged, for each newly checked member and a pre-existing hash failure', async () => {
  for (const [name, bad] of Object.entries(malformedVariants)) {
    const served = { listings: [activeRow(), bad], cursor: '7', total: 2 };
    const directory = createDirectoryClient({ origin: ORIGIN, fetchImpl: async () => jsonResponse(served) });
    const result = await directory.search({ limit: 50 });
    assert.equal(result.listings.length, 1, name);
    assert.equal(result.listings[0].listingId, listing.listingId, name);
    assert.equal(result.listings[0].problem, undefined, name);
    assert.equal(result.rejected, 1, name);
    assert.equal(result.cursor, '7', name);
    assert.equal(result.total, 2, name);
  }
});
test('search lists a revoked row with its revocation and an active row without one', async () => {
  const directory = createDirectoryClient({ origin: ORIGIN, fetchImpl: async () => jsonResponse({ listings: [activeRow(), revokedRow({ listingId: 'revoked-listing', revocation: revocationFor({ listingId: 'revoked-listing', logicalAddress: `dacs1-revoked:${encodeAddressSegment(seller)}:revoked-listing:v1` }) })] }) });
  const result = await directory.search();
  assert.equal(result.rejected, 0);
  assert.equal(result.listings.length, 2);
  assert.equal(Object.hasOwn(result.listings[0], 'revocation'), false);
  assert.equal(result.listings[1].revocation.listingId, 'revoked-listing');
  assert.equal(Object.hasOwn(result.listings[1], 'revocationBinding'), false);
});
test('a page with more listings than the integer limit sent is refused, not truncated', async () => {
  const sent = [];
  const directory = createDirectoryClient({ origin: ORIGIN, fetchImpl: async (input) => {
    sent.push(new URL(input).searchParams.get('limit'));
    return jsonResponse({ listings: [activeRow(), siblingRow(), siblingRow({ listingId: 'third' })] });
  } });
  await assert.rejects(directory.search({ limit: 2 }), (error) => error.kind === 'invalid' && error.code === 'directory_page_oversized');
  assert.equal((await directory.search({ limit: 3 })).listings.length, 3);
  assert.equal((await directory.search({ limit: 100 })).listings.length, 3);
  assert.deepEqual(sent, ['2', '3', '50']);
});
test('a limit that is not an integer is refused before any request', async () => {
  let calls = 0;
  const directory = createDirectoryClient({ origin: ORIGIN, fetchImpl: async () => { calls += 1; return jsonResponse({ listings: [] }); } });
  for (const limit of [1.5, NaN, Infinity, '5', null, {}]) {
    await assert.rejects(directory.search({ limit }), (error) => error.kind === 'invalid');
  }
  assert.equal(calls, 0);
});
test('network failure and HTTP 5xx keep distinct causes', async () => {
  const failure = new TypeError('fetch failed');
  const network = await world({ fetchImpl: async () => { throw failure; } }).directory.search().catch((error) => error);
  assert.equal(network.kind, 'unavailable');
  assert.equal(network.cause, failure);
  assert.equal(network.status, undefined);
  const upstream = await world({ fetchImpl: async () => jsonResponse({ error: 'down' }, 503) }).directory.search().catch((error) => error);
  assert.equal(upstream.kind, 'unavailable');
  assert.equal(upstream.status, 503);
  assert.equal(upstream.cause, undefined);
});

test('the public createListingVerifier still rejects profile_not_admitted before any Directory read', async () => {
  const client = await import('@kynesyslabs/dacs-client');
  let directoryRequests = 0;
  const directory = createDirectoryClient({ origin: ORIGIN, fetchImpl: async () => { directoryRequests += 1; throw new Error('unexpected Directory read'); } });
  const { binding, currentLocal } = await bindFixture();
  const verifier = client.createListingVerifier({ directory, chain: { readStorageProgram: async () => { throw new Error('unexpected chain read'); } }, admission: { binding, currentLocal } });
  await assert.rejects(verifier.verify({ listingId: listing.listingId, version: listing.listingVersion, seller }), { code: 'profile_not_admitted' });
  assert.equal(directoryRequests, 0);
});
