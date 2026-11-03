import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from '@kynesyslabs/dacs';
import { fixtureListing } from './fixtures/listings.mjs';
import { anchorFixture } from './helpers/anchor-isolated-fixture.mjs';
import { createDevnetDemoListingPublisher } from '../src/devnet-demo/listing.mjs';
import { requestStop, stopRequested } from '../src/devnet-demo/stop-request.mjs';

// Its own file: the stop flag is process-wide and cannot be cleared.
const NOW = 1_780_000_000_000, seed = new Uint8Array(32).fill(17), privateKey = privateKeyFromSeed(seed);
const address = `0x${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex')}`;
const wallet = { claim: `did:demos:agent:${address.slice(2)}`, signBytes: bytes => Buffer.from(ed25519Sign(bytes, privateKey)) };
const railAuthority = () => ({ trustPhase: 'PA-1', trustPolicyAcceptsPA1: true, registry: { state: 'not-used', entries: [], definitions: [] },
  inCodeDefinitions: [{ railId: 'demos-native:DEM', railVersion: 1, phaseHandler: 'pay-dem', governanceAnchoring: 'in-code', signatureValid: true }] });

test('a stop that arrives after the wallet approved the Listing CREATE signs nothing', async () => {
  const w = await anchorFixture({ writer: { claim: wallet.claim, sign: wallet.signBytes }, artifactKinds: ['Listing'], now: () => NOW });
  let signed = 0;
  // As the operator custody wallet: the operator approves, the stop lands before the write's own check runs on that answer.
  w.controls.approval = async () => { requestStop(); };
  w.controls.request = async () => { signed++; return { success: false, error: { code: 'capture-without-signing' } }; };
  const publish = createDevnetDemoListingPublisher({ anchor: w.open(), sign: (bytes) => wallet.signBytes(bytes),
    scanOwnListings: async () => ({ status: 'ok', anchors: [] }), loadRailResolution: railAuthority });
  const draft = fixtureListing(wallet, { now: NOW });
  delete draft.signature;
  await assert.rejects(publish(draft));
  assert.equal(stopRequested(), true);
  assert.equal(w.captured.length, 1, 'the wallet was asked for the Listing CREATE once');
  assert.equal(signed, 0, 'the wallet signed the Listing CREATE after the stop');
});
