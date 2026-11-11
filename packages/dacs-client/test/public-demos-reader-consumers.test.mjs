// The purchase service and the Listing verifier take the selected chain reader as it is:
// the public reader when no native Agreement transport is composed, else the transport's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createListingVerifier } from '../src/dacs/verification.mjs';
import { fakeNode, jsonResponse, TESTNET_IDENTITY } from './helpers/public-demos-reader-node.mjs';
import { HASH, WALLET, paymentAnswers, paymentBody, purchaseWorld } from './helpers/public-demos-reader-purchase.mjs';
import { passiveNativeWorld, HASH as NATIVE_HASH, IDENTITY as NATIVE_IDENTITY, PAYER, PAYEE as NATIVE_PAYEE } from './helpers/passive-native-world.mjs';
import { fixtureListing, fixtureLocator, summaryFor } from './fixtures/listings.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const NATIVE_PROTOCOL = { nativePaymentSuperseded: async () => true, nativeIntentsSupersededBy: async () => [] };

// A Listing the directory names and the chain holds at `locator`, owned by the seller.
function listingFixture() {
  const seller = createEphemeralWallet(), listing = fixtureListing(seller, { listingId: 'TEST-listing' }), locator = fixtureLocator('TEST-public-reader');
  const directory = { origin: 'https://directory.invalid', evidenceMode: 'TEST', findSummary: async () => summaryFor(listing, locator), getListingDetail: async () => listing };
  const storage = jsonResponse({ success: true, data: listing, owner: seller.address, programName: 'TEST' });
  return { seller, listing, locator, directory, storage, request: { listingId: listing.listingId, version: listing.listingVersion, seller: seller.claim } };
}

const checksOf = (result) => Object.fromEntries(result.checks.map(({ name, ok }) => [name, ok]));

test('one public reader serves both factories unchanged: the verifier reads the Listing anchor and the service settles a payment through it', async (t) => {
  const fixture = listingFixture();
  const node = fakeNode({ answer: (call) => (call.path ? fixture.storage.clone() : paymentAnswers()(call)) });
  const chain = node.reader();
  const listed = await createListingVerifier({ directory: fixture.directory, chain }).verify(fixture.request);
  assert.equal(checksOf(listed)['chain-anchor-present'], true);
  assert.equal(checksOf(listed)['chain-readback-equals-directory-detail'], true);
  assert.equal(checksOf(listed)['chain-anchor-owner-is-seller'], true);
  assert.deepEqual([listed.evidence.chainRpcOrigin, listed.evidence.chainNetwork, listed.evidence.chainMode], [chain.rpcOrigin, 'testnet', 'public-chain-read']);
  const world = purchaseWorld(t, { chain, chainIdentity: TESTNET_IDENTITY });
  const { operation, verification } = await world.verify();
  assert.equal(verification.outcome, 'verified');
  assert.equal(operation.status, 'settled_verified');
  assert.equal(verification.observer, chain.observer);
  assert.equal(verification.rpcOrigin, chain.rpcOrigin);
  assert.equal(world.state().consumed, 1);
  assert.deepEqual(node.requests, ['getBlockByNumber', `GET /storage-program/${fixture.locator}`, 'getBlockByNumber',
    'getTransactionStatus', 'getTxByHash', 'getBlockByNumber', 'getTxByHash'], 'one identity check, then the reads each factory asked for, plus the service\'s own fresh identity read');
});

test('a non-native purchase cancelled after its nonce slot is used reads the slot with findTransferAtNonce and settles on the public reader', async (t) => {
  const row = { ...paymentBody(), content: { ...paymentBody().content } };
  const node = fakeNode({ answer: paymentAnswers({ history: [row] }) });
  const world = purchaseWorld(t, { chain: node.reader(), chainIdentity: TESTNET_IDENTITY, status: 'payment_handoff', reportedTxHash: null });
  const { operation, cancelled } = await world.cancel();
  assert.equal(cancelled, false);
  assert.equal(operation.status, 'settled_verified');
  assert.equal(world.state().coordinate.reportedTxHash, HASH);
  assert.ok(node.requests.includes('getTransactionHistory'), 'the slot was found in the wallet history');
  assert.equal(world.state().consumed, 1);
});

test('a nonce slot taken by another transfer leaves the purchase open on the public reader', async (t) => {
  const other = paymentBody('3'.repeat(64), { payee: WALLET });
  const node = fakeNode({ answer: paymentAnswers({ body: other, history: [other] }) });
  const world = purchaseWorld(t, { chain: node.reader(), chainIdentity: TESTNET_IDENTITY, status: 'payment_handoff', reportedTxHash: null });
  const { operation, cancelled, slotTxHash } = await world.cancel();
  assert.equal(cancelled, false);
  assert.equal(operation.status, 'payment_uncertain');
  assert.equal(slotTxHash, other.hash);
  assert.equal(world.state().consumed, 0);
});

test('a native composition keeps the transport\'s own reader at both factories and settles an included payment with retained-source evidence', async (t) => {
  const native = passiveNativeWorld();
  await native.seed();
  const chain = native.source.chainReader();
  const fixture = listingFixture();
  const listed = await createListingVerifier({ directory: fixture.directory, chain }).verify(fixture.request);
  assert.equal(listed.evidence.chainRpcOrigin, chain.rpcOrigin, 'the verifier reports the transport reader it was given');
  const world = purchaseWorld(t, { chain, chainIdentity: NATIVE_IDENTITY, native: true, protocol: NATIVE_PROTOCOL, reportedTxHash: NATIVE_HASH,
    wallet: PAYER, payee: NATIVE_PAYEE, amountOs: '1000000000' });
  const { operation, verification } = await world.verify();
  assert.equal(verification.outcome, 'verified');
  assert.equal(operation.status, 'settled_verified');
  assert.equal(verification.observation.sourceDisposition, 'included');
  assert.equal(world.state().consumed, 1);
});
