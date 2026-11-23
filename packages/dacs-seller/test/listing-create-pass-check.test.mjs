// The Listing publisher's pass arguments: each publication hands the anchor operationClass 'job-create' and its own check,
// which answers true while the operator runs and throws once a stop is requested. This file requests the process-wide stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from '@kynesyslabs/dacs';
import { fixtureListing } from './fixtures/listings.mjs';
import { createDevnetDemoListingPublisher } from '../src/devnet-demo/listing.mjs';
import { requestStop } from '../src/devnet-demo/stop-request.mjs';

const NOW = 1_780_000_000_000, seed = new Uint8Array(32).fill(23), privateKey = privateKeyFromSeed(seed);
const address = `0x${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex')}`;
const wallet = { claim: `did:demos:agent:${address.slice(2)}`, signBytes: (bytes) => Buffer.from(ed25519Sign(bytes, privateKey)) };
const railAuthority = () => ({ trustPhase: 'PA-1', trustPolicyAcceptsPA1: true, registry: { state: 'not-used', entries: [], definitions: [] },
  inCodeDefinitions: [{ railId: 'demos-native:DEM', railVersion: 1, phaseHandler: 'pay-dem', governanceAnchoring: 'in-code', signatureValid: true }] });

test('the Listing publisher hands publish a per-publication check that returns true while the operator runs and throws the operator is stopping once a stop is requested, with authorize, authorizeSigning and reaskDenied unchanged', async () => {
  const inputs = [];
  // A stub anchor that records each publish input and ends the publication there.
  const anchor = {
    async publish(input) { inputs.push(input); throw new Error('TEST-recorded'); },
    async read() { return { status: 'absent' }; },
    async verifyReceipt() { return 'invalid'; },
  };
  const publish = createDevnetDemoListingPublisher({ anchor, sign: (bytes) => wallet.signBytes(bytes), scanOwnListings: async () => ({ status: 'ok', anchors: [] }),
    loadRailResolution: railAuthority });
  const draft = fixtureListing(wallet, { now: NOW });
  delete draft.signature;
  for (let publication = 0; publication < 2; publication++) await assert.rejects(publish(draft));
  assert.equal(inputs.length, 2, 'both publications reached publish');
  for (const input of inputs) {
    assert.equal(input.operationClass, 'job-create');
    assert.equal(input.currentAuthorization(), true);
    assert.deepEqual([input.authorize(), input.authorizeSigning(), input.reaskDenied], [true, true, true]);
  }
  assert.notEqual(inputs[0].currentAuthorization, inputs[1].currentAuthorization, 'each publication has its own check');

  requestStop();
  for (const input of inputs) {
    assert.throws(() => input.currentAuthorization(), { message: 'the operator is stopping' });
    assert.deepEqual([input.authorize(), input.authorizeSigning()], ['the operator is stopping', 'the operator is stopping']);
  }
});
