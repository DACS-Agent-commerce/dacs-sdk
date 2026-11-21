// K12-H7 / A37: a purchase through the client's public entries against the composed kit host. The harness loader sets only the
// client's hold constant; the real admission wrapper and the original actions run. The failure and counters it records are in the index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { drivePurchase, purchaseWorld } from './client-purchase.mjs';
import { composedKitHost } from './kit-host.mjs';

const { current: CURRENT } = JSON.parse(readFileSync(new URL('./harness-index.json', import.meta.url), 'utf8')).find((entry) => entry.id === 'K12-H7');
const REQUEST_COUNTERS = ['context', 'proposals', 'commitments', 'commitmentSignature', 'payments'];
// A step the client refuses before any seller exchange is recorded under the client's own layer and error class.
const CLIENT_LAYER = 'client';

test('K12-H7 / A37 today: a purchase through the public entries on the fixture node stops at its first incompatibility, with no downstream request or effect', async (t) => {
  const { fixture, host } = await composedKitHost(t);
  const world = await purchaseWorld(t, { host, listing: fixture.listing });
  const sellerSignaturesBefore = fixture.signed.length;
  const { operation, retained, failure } = await drivePurchase(world);

  // Control: prepare ran for real and left the purchase at the start's first step, with nothing signed or saved for it.
  assert.equal(retained.id, operation.id);
  assert.equal(retained.state.protocol.stage, 'identity');
  assert.equal(retained.state.protocol.sessionDelegation, undefined);
  assert.equal(retained.state.protocol.identity, undefined, 'the client derived no presentation of its own');

  // The first failing step, exactly as the index records it.
  assert.ok(failure, 'the purchase failed at its first wallet step');
  const [contextFailure, ...laterFailures] = world.contextFailures;
  assert.deepEqual(laterFailures, [], 'one failed context exchange at most');
  const requests = Object.fromEntries(REQUEST_COUNTERS.map((name) => [name, world.sellerRequests.filter((path) => path === DACS_SELLER_HTTP_PATHS[name]).length]));
  assert.equal(world.sellerRequests.length, Object.values(requests).reduce((sum, count) => sum + count, 0), 'no seller request outside the counted routes');
  assert.deepEqual({ step: failure.step, code: failure.error.code, failureClass: contextFailure?.failureClass ?? failure.error.constructor.name, layer: contextFailure?.layer ?? CLIENT_LAYER,
    counters: { ...requests, sellerSignatures: fixture.signed.length - sellerSignaturesBefore, walletEffects: world.native.writes.length + world.native.calls.length + world.chain.broadcasts } },
  { step: CURRENT.step, code: CURRENT.code, failureClass: CURRENT.failureClass, layer: CURRENT.layer, counters: CURRENT.counters });
});
