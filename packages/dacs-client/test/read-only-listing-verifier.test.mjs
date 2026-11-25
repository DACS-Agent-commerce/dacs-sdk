// The read-only Listing verifier, driven through the real Directory client
// and the real pinned chain reader with local fetch doubles: no node, no
// network. Each refusal names one fixed reason and carries nothing upstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { contentHash, encodeAddressSegment, signedBytes } from '@kynesyslabs/dacs';
import { createReadOnlyListingVerifier, ReadOnlyListingError } from '../src/listing/read-only-verifier.mjs';
import {
  LISTING_CALL_TIMEOUT_MS, LISTING_CHAIN_IDENTITY_MAX_BYTES, LISTING_DIRECTORY_DETAIL_MAX_BYTES, LISTING_DIRECTORY_PAGE_MAX_BYTES,
  LISTING_MAX_FETCHES, LISTING_STORAGE_MAX_BYTES,
} from '../src/listing/read-only-limits.mjs';
import { createDirectoryClient } from '../src/dacs/directory.mjs';
import { createDemosPublicChainReader } from '../src/substrate/demos.mjs';
import { purchaseSupport } from '../src/dacs/listing.mjs';
import { addressForClaim } from '../src/dacs/read-only-address.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing, fixtureLocator, summaryFor } from './fixtures/listings.mjs';

const CHECKED_AT = Date.UTC(2026, 2, 1);
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DIRECTORY = 'https://directory.invalid';
const RPC = 'https://rpc.invalid';
const PIN = 'ab'.repeat(32);
const OTHER_CHAIN = 'cd'.repeat(32);
const HELD = 'rail availability is not authenticated; purchase actions are held';
const REASONS = ['listing_input_invalid', 'listing_not_found', 'listing_directory_unavailable', 'listing_read_timeout', 'listing_read_limit',
  'listing_chain_identity_mismatch', 'listing_anchor_mismatch', 'listing_catalog_stale', 'listing_standard_invalid'];
// The Base reader defaults the verifier caps narrow.
const READER_DEFAULTS = { page: 1_000_000, detail: 65_536, identity: 4_194_304, storage: 262_144 };
// A Listing with no payment phase: the Standard reader can verify it while the client's DEM rail is not available.
const DISPLAY_PIPELINE = [{ kind: 'negotiate-fixed-price' }, { kind: 'commit-payee-bound-agreement' }, { kind: 'deliver-storage-program' }];

const wallet = createEphemeralWallet();
const seller = wallet.claim;
const listing = fixtureListing(wallet, { now: CHECKED_AT, pipeline: DISPLAY_PIPELINE });
const LOCATOR = fixtureLocator('read-only-listing');
const MARKER_LOCATOR = fixtureLocator('read-only-listing-marker');
const coordinates = { listingId: listing.listingId, version: listing.listingVersion, seller };

const signWith = (separator, body) => ({ ...body, signature: { algorithm: 'ed25519', signer: seller, value: wallet.signBytes(signedBytes(separator, contentHash(body))).toString('base64url') } });
const marker = signWith('dacs-revocation:v1:', { listingId: listing.listingId, listingVersion: listing.listingVersion, listingContentHash: contentHash(listing), revokedAt: CHECKED_AT - HOUR_MS, reason: 'withdrawn' });
const rowFor = (served, { observedAt = CHECKED_AT - HOUR_MS } = {}) => summaryFor(served, LOCATOR, { observedAt });
const revokedRow = {
  ...summaryFor(listing, LOCATOR, { status: 'revoked', observedAt: CHECKED_AT - HOUR_MS }),
  revocation: {
    sellerPrimaryClaim: seller, listingId: listing.listingId, listingVersion: listing.listingVersion, listingContentHash: contentHash(listing),
    logicalAddress: `dacs1-revoked:${encodeAddressSegment(seller)}:${listing.listingId}:v${listing.listingVersion}`,
    markerAnchor: { kind: 'storage-program', locator: MARKER_LOCATOR }, markerContentHash: contentHash(marker),
  },
};

/** A JSON reply; `padTo` adds trailing whitespace up to that many bytes and declares the length. */
function json(body, { padTo, headers = {} } = {}) {
  const text = JSON.stringify(body);
  assert.equal(Buffer.byteLength(text), text.length, 'fixture replies are ASCII');
  const sized = padTo === undefined ? text : text.padEnd(padTo, ' ');
  const declared = padTo === undefined ? {} : { 'content-length': String(sized.length) };
  return new Response(sized, { headers: { 'content-type': 'application/json', ...declared, ...headers } });
}

const found = (data, owner = addressForClaim(seller)) => ({ success: true, data, owner });
const genesisBlock = (hash) => ({ result: 200, response: { number: 0, hash } });
const blockOne = (previousHash) => ({ result: 200, response: { number: 1, status: 'confirmed', hash: 'ef'.repeat(32), content: { previousHash } } });
const NO_BLOCK = { result: 500, response: 'no block' };

/**
 * Directory and node doubles over one set of answers. `pages` spreads the scan
 * over that many pages (the row on the last). `genesis: 'block-one'` answers
 * block 0 without a block, so the identity comes from block 1. `replies`
 * replaces the reply for one kind: page, detail, genesis, storage or marker.
 */
function world({ row = rowFor(listing), pages = 1, detail = listing, identity = PIN, genesis = 'block-zero', storage = found(listing), markerAnswer = found(marker), replies = {}, now = () => CHECKED_AT } = {}) {
  const counts = { directory: 0, chain: 0, genesis: 0, storage: 0, marker: 0 };
  const reply = { page: json, detail: json, genesis: json, storage: json, marker: json, ...replies };
  const directoryFetchImpl = async (input) => {
    counts.directory += 1;
    const url = new URL(input);
    if (url.pathname !== '/api/dacs/listings') return reply.detail(detail);
    const index = Number(url.searchParams.get('cursor') ?? 0);
    const last = index === pages - 1;
    return reply.page({ listings: last ? [row] : [], ...(last ? {} : { cursor: String(index + 1) }) });
  };
  const chainFetchImpl = async (input, init) => {
    counts.chain += 1;
    const { pathname } = new URL(input);
    if (pathname === `/storage-program/${MARKER_LOCATOR}`) {
      counts.marker += 1;
      return markerAnswer === null ? new Response('not found', { status: 404 }) : reply.marker(markerAnswer);
    }
    if (pathname.startsWith('/storage-program/')) {
      counts.storage += 1;
      return storage === null ? new Response('not found', { status: 404 }) : reply.storage(storage);
    }
    counts.genesis += 1;
    const { blockNumber } = JSON.parse(init.body).params[0].data;
    if (genesis === 'none') return reply.genesis(NO_BLOCK);
    if (blockNumber === 0) return reply.genesis(genesis === 'block-one' ? NO_BLOCK : genesisBlock(identity));
    return reply.genesis(blockOne(identity));
  };
  const verifier = createReadOnlyListingVerifier({ directoryOrigin: DIRECTORY, rpcUrl: RPC, network: 'testnet', pinnedIdentity: PIN, directoryFetchImpl, chainFetchImpl, now });
  return { counts, verifier, directoryFetchImpl, chainFetchImpl };
}

// A world serving `served` everywhere: its own Directory row, detail and chain bytes.
const serving = (served, options = {}) => world({ row: rowFor(served), detail: served, storage: found(served), ...options });

async function refuses(promise, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ReadOnlyListingError, String(error?.stack ?? error));
    assert.equal(error.code, 'listing_read_unavailable');
    assert.equal(error.reason, reason);
    assert.equal(Object.hasOwn(error, 'listing'), false);
    return true;
  });
}

test('one verified Listing uses at most nine bounded Directory and chain requests', async () => {
  const { counts, verifier } = world({ pages: 5, genesis: 'block-one' });
  const result = await verifier.verify(coordinates);
  assert.deepEqual({ directory: counts.directory, chain: counts.chain }, { directory: 6, chain: 3 });
  assert.equal(counts.directory + counts.chain, LISTING_MAX_FETCHES);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(Object.keys(result).sort(), ['anchor', 'checkedAt', 'contentHash', 'disposition', 'listing', 'listingId', 'seller', 'version']);
  assert.deepEqual(result.listing, listing);
  assert.deepEqual(result.anchor, { kind: 'storage-program', locator: LOCATOR });
  assert.equal(result.contentHash, contentHash(listing));
  assert.equal(result.checkedAt, CHECKED_AT);
  assert.equal(result.disposition, 'verified');
  assert.deepEqual([result.listingId, result.version, result.seller], [coordinates.listingId, coordinates.version, seller]);
});

test('a tenth read refuses listing_read_limit before fetch', async () => {
  // Five pages, the detail, two genesis reads and the Listing are nine; the revocation marker would be the tenth.
  const { counts, verifier } = world({ row: revokedRow, pages: 5, genesis: 'block-one' });
  await refuses(verifier.verify(coordinates), 'listing_read_limit');
  assert.deepEqual({ directory: counts.directory, chain: counts.chain, marker: counts.marker }, { directory: 6, chain: 3, marker: 0 });
});

test('changed Directory coordinates hash or chain anchor bytes refuse listing_anchor_mismatch', async () => {
  // The detail names another version; the row carries the detail's own hash, so only the coordinates differ.
  const moved = { ...listing, listingVersion: listing.listingVersion + 1 };
  await refuses(world({ row: { ...rowFor(listing), contentHash: contentHash(moved) }, detail: moved }).verifier.verify(coordinates), 'listing_anchor_mismatch');
  await refuses(world({ row: { ...rowFor(listing), contentHash: 'f'.repeat(64) } }).verifier.verify(coordinates), 'listing_anchor_mismatch');
  const changedBytes = { ...listing, offering: { ...listing.offering, title: 'Changed on chain' } };
  await refuses(world({ storage: found(changedBytes) }).verifier.verify(coordinates), 'listing_anchor_mismatch');
});

test('changed chain owner or pinned identity refuses without a Listing', async () => {
  const other = createEphemeralWallet();
  await refuses(world({ storage: found(listing, other.address) }).verifier.verify(coordinates), 'listing_anchor_mismatch');
  const wrongChain = world({ identity: OTHER_CHAIN });
  await refuses(wrongChain.verifier.verify(coordinates), 'listing_chain_identity_mismatch');
  assert.equal(wrongChain.counts.storage, 0, 'nothing is read from a chain other than the pinned one');
  const noIdentity = world({ genesis: 'none' });
  await refuses(noIdentity.verifier.verify(coordinates), 'listing_chain_identity_mismatch');
  assert.equal(noIdentity.counts.storage, 0);
});

test('missing future or stale catalog observation refuses listing_catalog_stale', async () => {
  const { catalogObservedAt: _omitted, ...missing } = rowFor(listing);
  for (const row of [missing, rowFor(listing, { observedAt: CHECKED_AT + 1 }), rowFor(listing, { observedAt: CHECKED_AT - DAY_MS - 1 })]) {
    const { counts, verifier } = world({ row });
    await refuses(verifier.verify(coordinates), 'listing_catalog_stale');
    assert.equal(counts.chain, 0, 'a stale catalog is refused before the chain is read');
  }
});

test('Directory page detail identity and storage replies one byte over each verifier cap but under the Base reader default refuse listing_read_limit before decoding; replies at each cap pass', async (t) => {
  const caps = { page: LISTING_DIRECTORY_PAGE_MAX_BYTES, detail: LISTING_DIRECTORY_DETAIL_MAX_BYTES, genesis: LISTING_CHAIN_IDENTITY_MAX_BYTES, storage: LISTING_STORAGE_MAX_BYTES };
  const defaults = { page: READER_DEFAULTS.page, detail: READER_DEFAULTS.detail, genesis: READER_DEFAULTS.identity, storage: READER_DEFAULTS.storage };
  for (const [kind, cap] of Object.entries(caps)) {
    assert.equal(cap * 2, defaults[kind], `${kind}: the verifier cap is half the reader default`);
    const padded = (padTo) => world({ replies: { [kind]: (body) => json(body, { padTo }) } }).verifier.verify(coordinates);
    const atCap = await padded(cap);
    assert.equal(atCap.disposition, 'verified', `${kind} at the cap`);
    await refuses(padded(cap + 1), 'listing_read_limit');
  }

  await t.test('the readers built without the verifier options still admit the same replies', async () => {
    const pad = (kind) => (body) => json(body, { padTo: caps[kind] + 1 });
    const answers = world({ replies: { page: pad('page'), detail: pad('detail'), genesis: pad('genesis'), storage: pad('storage') } });
    const directory = createDirectoryClient({ origin: DIRECTORY, fetchImpl: answers.directoryFetchImpl });
    assert.equal((await directory.findSummary(coordinates)).contentHash, contentHash(listing));
    assert.deepEqual(await directory.getListingDetail(coordinates), listing);
    const chain = createDemosPublicChainReader({ rpcUrl: RPC, network: 'testnet', pinnedIdentity: PIN, fetchImpl: answers.chainFetchImpl });
    assert.equal((await chain.networkIdentity()).identity, PIN);
    assert.equal((await chain.readStorageProgram(LOCATOR)).status, 'found');
  });
});

test('missing oversized or unreadable revocation marker refuses without a Listing', async () => {
  const missing = world({ row: revokedRow, markerAnswer: null });
  await refuses(missing.verifier.verify(coordinates), 'listing_standard_invalid');
  const oversized = world({ row: revokedRow, replies: { marker: (body) => json(body, { padTo: LISTING_STORAGE_MAX_BYTES + 1 }) } });
  await refuses(oversized.verifier.verify(coordinates), 'listing_read_limit');
  const unreadable = world({ row: revokedRow, markerAnswer: found({ note: 'not a revocation marker' }) });
  await refuses(unreadable.verifier.verify(coordinates), 'listing_standard_invalid');
  for (const { counts } of [missing, oversized, unreadable]) assert.equal(counts.marker, 1, 'the marker is read once');
});

test('invalid Listing or identity signature and revoked Listing refuse listing_standard_invalid', async () => {
  const { signature: _signature, ...unsigned } = listing;
  const otherSignature = signWith('dacs-listing:v1:', { ...unsigned, offering: { ...unsigned.offering, title: 'Other' } }).signature.value;
  const forged = { ...listing, signature: { ...listing.signature, value: otherSignature } };
  await refuses(serving(forged).verifier.verify(coordinates), 'listing_standard_invalid');

  const draft = structuredClone(listing);
  delete draft.signature;
  draft.seller.identity.presentation.signatures[0].signature = listing.signature.value;
  await refuses(serving(signWith('dacs-listing:v1:', draft)).verifier.verify(coordinates), 'listing_standard_invalid');

  await refuses(world({ row: revokedRow }).verifier.verify(coordinates), 'listing_standard_invalid');
});

test('standard verified Listing remains readable while purchase support stays held', async () => {
  const result = await world().verifier.verify(coordinates);
  assert.equal(result.disposition, 'verified');
  const support = purchaseSupport(result.listing);
  assert.equal(support.supported, false);
  assert.equal(support.reasons[0], HELD);
  for (const name of ['transactable', 'eligibility', 'price', 'payee', 'checks']) assert.equal(Object.hasOwn(result, name), false, name);
});

test('each call checks the live pin and a simulated answer refuses', async () => {
  const answers = { identity: PIN };
  const { counts, verifier } = world({ replies: { genesis: (body) => json(answers.identity === PIN ? body : genesisBlock(answers.identity)) } });
  await verifier.verify(coordinates);
  await verifier.verify(coordinates);
  assert.equal(counts.genesis, 2, 'every call reads the genesis identity');
  answers.identity = OTHER_CHAIN;
  await refuses(verifier.verify(coordinates), 'listing_chain_identity_mismatch');

  const simulated = (body) => json(body, { headers: { 'x-dacs-simulation': '1' } });
  await refuses(world({ replies: { genesis: simulated } }).verifier.verify(coordinates), 'listing_chain_identity_mismatch');
  await refuses(world({ replies: { storage: simulated } }).verifier.verify(coordinates), 'listing_chain_identity_mismatch');
});

test('stalled Directory chain and marker reads refuse listing_read_timeout within the call deadline', async (t) => {
  // A reply that arrives only after 10 s and ignores its abort signal; the subtest clears it when it ends.
  const stalled = (context) => (body) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(json(body)), 10_000);
    context.after(() => clearTimeout(timer));
  });
  async function refusesWithinReaderLimit(replies, row) {
    const { verifier } = world({ row, replies });
    const started = performance.now();
    await refuses(verifier.verify(coordinates), 'listing_read_timeout');
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1_800 && elapsed < 5_000, `refused after ${elapsed} ms`);
  }

  await t.test('a stalled Directory page refuses at the Directory read limit', (sub) => refusesWithinReaderLimit({ page: stalled(sub) }));
  await t.test('a stalled genesis read refuses at the chain read limit', (sub) => refusesWithinReaderLimit({ genesis: stalled(sub) }));
  await t.test('a stalled revocation marker read refuses at the chain read limit', (sub) => refusesWithinReaderLimit({ marker: stalled(sub) }, revokedRow));

  await t.test('reads that each finish under their own limit refuse at the call deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const READ_MS = 1_950;
    let notify = () => {};
    const nextRead = () => new Promise((resolve) => { notify = resolve; });
    const slow = (body) => {
      notify();
      return new Promise((resolve) => setTimeout(() => resolve(json(body)), READ_MS));
    };
    // Five pages, the detail, the genesis block and the Listing: eight reads, 15,600 ms in all.
    const { verifier } = world({ pages: 5, replies: { page: slow, detail: slow, genesis: slow, storage: slow } });
    let started = nextRead();
    const pending = verifier.verify(coordinates);
    for (let read = 1; read <= 8; read += 1) {
      await started;
      started = nextRead();
      t.mock.timers.tick(READ_MS);
    }
    assert.ok(8 * READ_MS > LISTING_CALL_TIMEOUT_MS);
    await refuses(pending, 'listing_read_timeout');
  });
});

test('without fetch functions or a clock the verifier reads through the global fetch and Date.now', async (t) => {
  const { counts, directoryFetchImpl, chainFetchImpl } = world();
  t.mock.method(globalThis, 'fetch', (input, init) => (new URL(input).origin === DIRECTORY ? directoryFetchImpl : chainFetchImpl)(input, init));
  t.mock.timers.enable({ apis: ['Date'], now: CHECKED_AT });
  const verifier = createReadOnlyListingVerifier({ directoryOrigin: DIRECTORY, rpcUrl: RPC, network: 'testnet', pinnedIdentity: PIN });
  const result = await verifier.verify(coordinates);
  assert.equal(result.checkedAt, CHECKED_AT);
  assert.deepEqual({ directory: counts.directory, chain: counts.chain }, { directory: 2, chain: 2 });
});

test('read failures expose only fixed code and reason with no cause or node text', async () => {
  const SECRET = 'node-secret-text';
  const failures = [
    ['listing_directory_unavailable', world({ replies: { page: () => new Response(`${SECRET} upstream failed`, { status: 500 }) } })],
    ['listing_directory_unavailable', world({ replies: { page: () => new Response(`{"${SECRET}":`, { headers: { 'content-type': 'application/json' } }) } })],
    ['listing_not_found', world({ row: rowFor({ ...listing, listingId: 'another-listing' }) })],
    ['listing_chain_identity_mismatch', world({ replies: { genesis: () => { throw new Error(`${SECRET} ${RPC} refused`); } } })],
    ['listing_anchor_mismatch', world({ storage: null })],
  ];
  const errors = [];
  for (const [reason, { verifier }] of failures) {
    errors.push(await verifier.verify(coordinates).then(() => assert.fail(`${reason} resolved`), (error) => ({ reason, error })));
  }

  // Malformed input refuses before any request, and so does a malformed construction.
  const quiet = world();
  for (const input of [{ ...coordinates, listingId: '..' }, { ...coordinates, version: 0 }, { ...coordinates, seller: seller.toUpperCase() }, { ...coordinates, fresh: false }]) {
    errors.push(await quiet.verifier.verify(input).then(() => assert.fail('malformed input resolved'), (error) => ({ reason: 'listing_input_invalid', error })));
  }
  assert.deepEqual({ directory: quiet.counts.directory, chain: quiet.counts.chain }, { directory: 0, chain: 0 });
  const options = { directoryOrigin: DIRECTORY, rpcUrl: RPC, network: 'testnet', pinnedIdentity: PIN, directoryFetchImpl: quiet.directoryFetchImpl, chainFetchImpl: quiet.chainFetchImpl };
  for (const change of [{ network: 'mainnet' }, { pinnedIdentity: PIN.toUpperCase() }, { rpcUrl: 'not a url' }, { directoryOrigin: `${DIRECTORY}/path` }, { directoryOrigin: undefined }]) {
    try {
      createReadOnlyListingVerifier({ ...options, ...change });
      assert.fail(`${JSON.stringify(change)} constructed`);
    } catch (error) {
      errors.push({ reason: 'listing_input_invalid', error });
    }
  }
  assert.deepEqual({ directory: quiet.counts.directory, chain: quiet.counts.chain }, { directory: 0, chain: 0 });

  for (const { reason, error } of errors) {
    assert.ok(error instanceof ReadOnlyListingError, String(error?.stack ?? error));
    assert.equal(error.code, 'listing_read_unavailable');
    assert.equal(error.reason, reason);
    assert.ok(REASONS.includes(error.reason));
    assert.equal(error.message, error.reason);
    assert.equal('cause' in error, false, reason);
    assert.deepEqual(Object.keys(error), ['code', 'reason']);
    assert.doesNotMatch(`${JSON.stringify(error)} ${error.stack}`, new RegExp(`${SECRET}|\\.invalid`), reason);
  }
});
