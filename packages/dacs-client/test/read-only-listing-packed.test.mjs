// The read-only Listing entry installed from packed archives verifies one
// Listing through its own Directory client and pinned chain reader, and the
// root purchase verifier stays gated. With DACS_READ_ONLY_NODE20=1 (the CI
// Node 20.19.0 step) the test and its child must run on exactly v20.19.0; the
// supported test legs run the same file on the purchase floor.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from '@kynesyslabs/dacs';
import { installPackedPair } from './helpers/packed-install.mjs';
import { addressForClaim } from '../src/dacs/read-only-address.mjs';
import { assertPurchaseRuntime } from '../src/public-admission.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing, fixtureLocator, summaryFor } from './fixtures/listings.mjs';

const NODE20 = process.env.DACS_READ_ONLY_NODE20 === '1';
const NODE20_VERSION = 'v20.19.0';
const CHECKED_AT = Date.UTC(2026, 2, 1);
const PIN = 'ab'.repeat(32);
const DISPLAY_PIPELINE = [{ kind: 'negotiate-fixed-price' }, { kind: 'commit-payee-bound-agreement' }, { kind: 'deliver-storage-program' }];

const wallet = createEphemeralWallet();
const listing = fixtureListing(wallet, { now: CHECKED_AT, pipeline: DISPLAY_PIPELINE });
const locator = fixtureLocator('read-only-listing-packed');
const fixture = {
  listing, pin: PIN, checkedAt: CHECKED_AT, owner: addressForClaim(wallet.claim),
  row: summaryFor(listing, locator, { observedAt: CHECKED_AT - 60_000 }),
  coordinates: { listingId: listing.listingId, version: listing.listingVersion, seller: wallet.claim },
};

// Runs in the installed app: Directory and node doubles, the entry's verifier, then the root purchase verifier.
const CHILD = `
import { readFileSync } from 'node:fs';
const expected = process.env.DACS_READ_ONLY_NODE20 === '1' ? '${NODE20_VERSION}' : null;
if (expected && process.version !== expected) throw new Error('expected Node ' + expected + ', running ' + process.version);
const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const reads = [];
const directoryFetchImpl = async (input) => {
  reads.push('directory');
  return json(new URL(input).pathname === '/api/dacs/listings' ? { listings: [fixture.row] } : fixture.listing);
};
const chainFetchImpl = async (input) => {
  const storage = new URL(input).pathname.startsWith('/storage-program/');
  reads.push(storage ? 'storage' : 'genesis');
  return json(storage ? { success: true, data: fixture.listing, owner: fixture.owner } : { result: 200, response: { number: 0, hash: fixture.pin } });
};
const entry = await import('@kynesyslabs/dacs-client/listing/read-only');
const verifier = entry.createReadOnlyListingVerifier({ directoryOrigin: 'https://directory.invalid', rpcUrl: 'https://rpc.invalid', network: 'testnet',
  pinnedIdentity: fixture.pin, directoryFetchImpl, chainFetchImpl, now: () => fixture.checkedAt });
const verdict = await verifier.verify(fixture.coordinates);
const refusal = await verifier.verify({ ...fixture.coordinates, fresh: false }).catch((error) => ({ code: error.code, reason: error.reason }));

const root = await import('@kynesyslabs/dacs-client');
let rootGate;
try {
  const purchaseVerifier = root.createListingVerifier({ admission: { binding: {}, currentLocal: () => ({}) }, directory: {}, chain: {} });
  rootGate = await purchaseVerifier.verify(fixture.coordinates).then(() => 'resolved', (error) => error.code);
} catch (error) {
  rootGate = error.code;
}
console.log(JSON.stringify({
  version: process.version, entry: Object.keys(entry).sort(), verifier: Object.keys(verifier), verifierFrozen: Object.isFrozen(verifier),
  verdict: { ...verdict, frozen: Object.isFrozen(verdict) }, reads, refusal, rootGate,
}));
`;

function onPurchaseFloor() {
  try {
    assertPurchaseRuntime(process.version);
    return true;
  } catch {
    return false;
  }
}

// One packed install and one child run serve both tests.
const cleanups = [];
after(() => { for (const cleanup of cleanups) cleanup(); });
let childResult;
function installedChild() {
  if (childResult) return childResult;
  if (NODE20) assert.equal(process.version, NODE20_VERSION);
  const { app } = installPackedPair({ after: (cleanup) => cleanups.push(cleanup) });
  writeFileSync(join(app, 'fixture.json'), JSON.stringify(fixture));
  writeFileSync(join(app, 'read-only-listing.mjs'), CHILD);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['read-only-listing.mjs'], { cwd: app, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  childResult = JSON.parse(child.stdout);
  return childResult;
}

test('packed read-only Listing entry imports and verifies on Node 20.19 and the purchase floor', () => {
  const result = installedChild();
  if (NODE20) assert.equal(result.version, NODE20_VERSION);
  // The page, the detail, the genesis block and the Listing; the refused call reads nothing.
  assert.deepEqual(result.reads, ['directory', 'directory', 'genesis', 'storage']);
  assert.deepEqual(result.verdict, {
    listingId: listing.listingId, version: listing.listingVersion, seller: wallet.claim, listing, contentHash: contentHash(listing),
    anchor: { kind: 'storage-program', locator }, checkedAt: CHECKED_AT, disposition: 'verified', frozen: true,
  });
  assert.deepEqual(result.refusal, { code: 'listing_read_unavailable', reason: 'listing_input_invalid' });
});

test('packed read-only Listing entry has no write export and root purchase gate remains active', () => {
  const result = installedChild();
  assert.deepEqual(result.entry, ['ReadOnlyListingError', 'createReadOnlyListingVerifier']);
  assert.deepEqual(result.verifier, ['verify']);
  assert.equal(result.verifierFrozen, true);
  // Below the purchase floor the root factory refuses to build; on the floor its verify stays held.
  assert.equal(result.rootGate, onPurchaseFloor() ? 'profile_not_admitted' : 'runtime_unsupported');
  if (NODE20) assert.equal(result.rootGate, 'runtime_unsupported');
});
