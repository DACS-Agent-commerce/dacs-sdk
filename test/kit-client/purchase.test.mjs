// K12-H7 / A37: a purchase through the client's public entries against the composed kit host. The harness loader sets only the
// client's hold constant; the real admission wrapper and the original actions run. The failure and counters it records are in the index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { buyer } from '../../packages/dacs-seller/test/helpers/protocol-fixture.mjs';
import { CLIENT_NOW, drivePurchase, purchaseWorld } from './client-purchase.mjs';
import { composedKitHost } from './kit-host.mjs';

const PRESENTATION_DOMAIN = 'dacs-bundle-presentation:v1:';
const { current: CURRENT } = JSON.parse(readFileSync(new URL('./harness-index.json', import.meta.url), 'utf8')).find((entry) => entry.id === 'K12-H7');
const REQUEST_COUNTERS = ['context', 'proposals', 'commitments', 'commitmentSignature', 'payments'];

/** The nonce the client derives for itself (listing.mjs): sha256 of the plugin domain, the session seed, the claim and the time. */
const selfDerivedNonce = ({ operation, jobId }) => sha256Hex(`dacs-chatgpt-plugin:${operation.id}:${jobId}:${buyer.claim}:${CLIENT_NOW}`);

test('K12-H7 / A37 today: a purchase through the public entries on the fixture node stops at its first incompatibility, with no downstream request or effect', async (t) => {
  const { fixture, host } = await composedKitHost(t);
  const world = await purchaseWorld(t, { host, listing: fixture.listing });
  const sellerSignaturesBefore = fixture.signed.length;
  const { operation, identity, retained, failure } = await drivePurchase(world);

  // Control: the public identity action ran for real. It returned its request and advanced the retained state; undefined or a no-op fails here.
  assert.equal(typeof identity?.message, 'string');
  assert.ok(identity.message.startsWith(PRESENTATION_DOMAIN), 'the message is the presentation request');
  const kept = retained.state.protocol.identity;
  assert.equal(kept.message, identity.message, 'the retained state holds the request that was returned');
  assert.equal(kept.bundle.presentedBy, buyer.claim);
  assert.equal(kept.bundle.sessionNonce, selfDerivedNonce({ operation, jobId: operation.terms.protocol.jobId }), 'the client derived its own nonce (K12-H1)');

  // The first failing step, exactly as the index records it.
  assert.ok(failure, 'the purchase failed at its plan step');
  const [contextFailure, ...laterFailures] = world.contextFailures;
  assert.ok(contextFailure, 'the seller client reported a failed context exchange');
  assert.deepEqual(laterFailures, [], 'one failed context exchange only');
  const requests = Object.fromEntries(REQUEST_COUNTERS.map((name) => [name, world.sellerRequests.filter((path) => path === DACS_SELLER_HTTP_PATHS[name]).length]));
  assert.equal(world.sellerRequests.length, Object.values(requests).reduce((sum, count) => sum + count, 0), 'no seller request outside the counted routes');
  assert.deepEqual({ step: failure.step, code: failure.error.code, failureClass: contextFailure.failureClass, layer: contextFailure.layer,
    counters: { ...requests, sellerSignatures: fixture.signed.length - sellerSignaturesBefore, walletEffects: world.native.writes.length + world.native.calls.length + world.chain.broadcasts } },
  { step: CURRENT.step, code: CURRENT.code, failureClass: CURRENT.failureClass, layer: CURRENT.layer, counters: CURRENT.counters });
});
