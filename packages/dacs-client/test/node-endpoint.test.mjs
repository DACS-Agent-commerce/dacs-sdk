// A plain-http Demos node endpoint serves reads only: the owner and the network binder take `http:` under the approved TP-1 chain
// identity, and every session that signs or sends refuses it, because a plain-http reply carries no authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { api, scriptedNode } from './helpers/tp1-node-fixture.mjs';
import { finalizedWorld } from './helpers/finalized-node-world.mjs';
import { addressOfFixture, keystoreDir, PASSPHRASE } from './helpers/keystore-world.mjs';
const { createDemosNetworkBinder } = await import('../src/dacs/network-binding.mjs');
const { loadNodeDemos } = await import('../src/wallet/node-demos-loading.mjs');

const CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const OTHER_CHAIN = 'd'.repeat(64);
const PLAIN = 'http://rpc.example.invalid/';
const SECURE = 'https://rpc.example.invalid/';
const AUTHORITY = 'vector-authority';
const NOT_ROOTS = ['http://rpc.example.invalid/rpc', 'http://u:p@rpc.example.invalid/', 'http://rpc.example.invalid/?x=1', 'http://rpc.example.invalid/#f'];

const owner = (endpoint, chainIdentity, fetchImpl = () => assert.fail('no node read')) =>
  api.createNodeTransportOwner({ endpoint, transportAuthority: AUTHORITY, fetchImpl, chainIdentity });

// A binder reader whose node answers block zero with `identity`, over a connection to `endpoint`.
function blockZeroReader(endpoint, identity) {
  const context = { network: TP1_APPROVED_IDENTITY_RECORD.network, endpoint, transportAuthority: AUTHORITY, connectionId: 'TEST-connection-1' };
  return { getContext: () => context,
    getBlockByNumber: async () => ({ value: { number: 0, status: 'confirmed', hash: identity }, context, observedAt: Date.now(), fromCache: false, redirected: false }) };
}
const pin = (endpoint, chainIdentity) => ({ network: TP1_APPROVED_IDENTITY_RECORD.network, chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion,
  endpoint, transportAuthority: AUTHORITY });

// The buyer's staged composition over an owner on `endpoint` under the approved identity.
async function composedOver(t, endpoint) {
  const node = scriptedNode();
  const httpOwner = owner(endpoint, CHAIN, node.fetch);
  t.after(() => httpOwner.close());
  return finalizedWorld(t, { node, input: { owner: httpOwner } });
}

test('the node transport owner takes a plain-http root only under the approved TP-1 chain identity, and an https root as before', () => {
  const plain = owner(PLAIN, CHAIN);
  assert.equal(plain.local.endpoint, PLAIN);
  assert.throws(() => plain.fetchImpl(SECURE, {}), { code: 'transport_mismatch' }, 'the owner reaches only its own origin');
  plain.close();
  for (const chainIdentity of [OTHER_CHAIN, undefined]) assert.throws(() => owner(PLAIN, chainIdentity), { code: 'transport_mismatch' }, String(chainIdentity));
  for (const endpoint of NOT_ROOTS) assert.throws(() => owner(endpoint, CHAIN), { code: 'transport_mismatch' }, endpoint);
  for (const chainIdentity of [undefined, CHAIN, OTHER_CHAIN]) {
    const secure = owner(SECURE, chainIdentity);
    assert.equal(secure.local.endpoint, SECURE);
    secure.close();
  }
});

test('the network binder pins a plain-http endpoint only under the approved identity, refuses a node over http that reports another chain, and keeps https as before', async () => {
  const bound = await createDemosNetworkBinder({ expected: pin(PLAIN, CHAIN), reader: blockZeroReader(PLAIN, CHAIN) }).bind();
  assert.deepEqual([bound.endpoint, bound.chainIdentity], [PLAIN, CHAIN]);
  for (const expected of [pin(PLAIN, OTHER_CHAIN), { ...pin(PLAIN, CHAIN), chainIdentity: undefined }, ...NOT_ROOTS.map(endpoint => pin(endpoint, CHAIN))]) {
    assert.throws(() => createDemosNetworkBinder({ expected, reader: blockZeroReader(PLAIN, CHAIN) }), { name: 'NetworkBindingError', code: 'unpinned_network' }, expected.endpoint);
  }
  await assert.rejects(createDemosNetworkBinder({ expected: pin(PLAIN, CHAIN), reader: blockZeroReader(PLAIN, OTHER_CHAIN) }).bind(), { code: 'identity_mismatch' });
  for (const chainIdentity of [CHAIN, OTHER_CHAIN]) {
    const secure = await createDemosNetworkBinder({ expected: pin(SECURE, chainIdentity), reader: blockZeroReader(SECURE, chainIdentity) }).bind();
    assert.deepEqual([secure.endpoint, secure.chainIdentity], [SECURE, chainIdentity]);
  }
});

test('the staged composition over a plain-http root refuses the binding before any key is loaded, signature made or effect sent, even when the node reports the approved chain', async t => {
  const { Demos } = await loadNodeDemos();
  const connects = t.mock.method(Demos.prototype, 'connectWallet');
  const world = await composedOver(t, PLAIN);
  await assert.rejects(world.build(), { code: 'tp1_local_binding_invalid' });
  assert.equal(world.session, undefined);
  assert.equal(connects.mock.callCount(), 0, 'no wallet was connected, so nothing could be signed');
  assert.deepEqual([world.node.broadcasts.length, world.effects().length], [0, 0]);
});

test('the keystore composition over a plain-http root refuses before any signature, confirmation or broadcast', async t => {
  const node = scriptedNode(), httpOwner = owner(PLAIN, CHAIN, node.fetch);
  t.after(() => httpOwner.close());
  const expectedAddress = await addressOfFixture(t);
  const world = await finalizedWorld(t, { node,
    input: { owner: httpOwner, keystorePath: keystoreDir(t).file(), passphrase: PASSPHRASE, expectedAddress, stopped: () => false },
    compose: options => api.openKeystoreWalletSession(Object.fromEntries(Object.entries(options).filter(([name]) => name !== 'key'))) });
  await assert.rejects(world.build(), { code: 'tp1_local_binding_invalid' });
  assert.deepEqual([world.node.broadcasts.length, world.effects().length], [0, 0]);
});

test('the same composition over an https root binds and sends once', async t => {
  const world = await composedOver(t, SECURE);
  await world.build();
  assert.equal(world.session.binding.local.endpoint, SECURE);
  assert.equal((await world.send()).success, true);
  assert.equal(world.node.broadcasts.length, 1);
});
