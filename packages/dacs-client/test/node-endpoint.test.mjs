// A plain-http Demos node endpoint: each client site that judges a node endpoint takes `http:` only under the approved TP-1
// chain identity, through the wire's canonicalNodeEndpoint, and keeps every https root exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalNodeEndpoint, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { api, ok, scriptedNode } from './helpers/tp1-node-fixture.mjs';
import { finalizedWorld } from './helpers/finalized-node-world.mjs';
import { addressOfFixture, keystoreDir, PASSPHRASE } from './helpers/keystore-world.mjs';
const { createDemosNetworkBinder } = await import('../src/dacs/network-binding.mjs');
const { createDevnetAgreementWalletTransport, projectPaidWrite } = await import('../src/public/portal/embedded-wallet/sdk-provider.mjs');
const { loadNodeDemos } = await import('../src/wallet/node-demos-loading.mjs');

const CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const OTHER_CHAIN = 'd'.repeat(64);
const PLAIN = 'http://rpc.example.invalid/';
const SECURE = 'https://rpc.example.invalid/';
const AUTHORITY = 'vector-authority';
const NOT_ROOTS = ['http://rpc.example.invalid/rpc', 'http://u:p@rpc.example.invalid/', 'http://rpc.example.invalid/?x=1', 'http://rpc.example.invalid/#f'];
const RELAY_ORIGIN = 'https://node-wallet.invalid';
const RELAY = Object.freeze({ profile: 'devnet-agreement', network: TP1_APPROVED_IDENTITY_RECORD.network,
  rpcUrl: `${RELAY_ORIGIN}/portal/api/devnet-native-wallet-rpc`, bindingUrl: `${RELAY_ORIGIN}/portal/api/devnet-native-wallet-binding` });

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

// The node answers every block read as another chain's node.
const otherChainNode = () => {
  const node = scriptedNode();
  node.intercept = row => (row.body?.params[0].message === 'getBlockByNumber'
    ? new Response(JSON.stringify(ok({ number: row.body.params[0].data.blockNumber, status: 'confirmed', hash: OTHER_CHAIN, content: { previousHash: OTHER_CHAIN } })),
      { headers: { 'content-type': 'application/json' } })
    : undefined);
  return node;
};

// The buyer's staged composition (production authority reader and live chain read) over an owner on `endpoint` under the approved identity.
async function composedOver(t, endpoint, node = scriptedNode()) {
  const httpOwner = owner(endpoint, CHAIN, node.fetch);
  t.after(() => httpOwner.close());
  const world = await finalizedWorld(t, { node, input: { owner: httpOwner } });
  return { world, httpOwner };
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

test('over a plain-http root under the approved identity the staged composition binds through the live chain read and sends once; the Agreement transport binding passes the provider only with the wire rule', async t => {
  const { world } = await composedOver(t, PLAIN);
  await world.build();
  assert.equal(world.session.binding.local.endpoint, PLAIN);
  const sent = await world.send();
  assert.equal(sent.success, true, JSON.stringify(sent));
  assert.equal(world.node.broadcasts.length, 1);
  assert.ok(world.node.calls.every(row => row.url.startsWith(PLAIN) && row.redirect === 'error'));

  const transportBinding = world.session.wallet.getWriteProfile().transportBinding;
  assert.equal(transportBinding.endpoint, PLAIN);
  const relayed = (binding, nodeEndpoint) => () => createDevnetAgreementWalletTransport({ ...RELAY, transportBinding: binding }, { relayOrigin: RELAY_ORIGIN, nodeEndpoint });
  assert.ok(relayed(transportBinding, canonicalNodeEndpoint)());
  for (const changed of [{ chainIdentity: OTHER_CHAIN }, { chainIdentity: undefined }, ...NOT_ROOTS.map(endpoint => ({ endpoint }))]) {
    assert.throws(relayed({ ...transportBinding, ...changed }, canonicalNodeEndpoint), { code: 'held_for_review' }, JSON.stringify(changed));
  }
  assert.throws(relayed(transportBinding, undefined), { code: 'held_for_review' }, 'without the wire rule the standalone provider takes https only');
  for (const nodeEndpoint of [undefined, canonicalNodeEndpoint]) {
    for (const chainIdentity of [CHAIN, OTHER_CHAIN]) assert.ok(relayed({ ...transportBinding, endpoint: SECURE, chainIdentity }, nodeEndpoint)());
  }
});

test('over a plain-http root under the approved identity the keystore composition prepares a paid write once, over that root, and still sends nothing unapproved', async t => {
  const node = scriptedNode(), httpOwner = owner(PLAIN, CHAIN, node.fetch);
  t.after(() => httpOwner.close());
  const expectedAddress = await addressOfFixture(t);
  const world = await finalizedWorld(t, { node,
    input: { owner: httpOwner, keystorePath: keystoreDir(t).file(), passphrase: PASSPHRASE, expectedAddress, stopped: () => false },
    compose: options => api.openKeystoreWalletSession(Object.fromEntries(Object.entries(options).filter(([name]) => name !== 'key'))) });
  await world.build();
  const preview = await world.session.preparePaidWrite(world.request(), { feeCeilingOs: '50000000000' });
  assert.equal(preview.content.content.networkBinding.endpoint, PLAIN);
  assert.equal(typeof preview.prepared, 'object');
  assert.equal((await world.send()).error?.code, 'paid_approval_required');
  assert.deepEqual([world.node.broadcasts.length, world.effects().length], [0, 0]);
  assert.ok(world.node.calls.every(row => row.url.startsWith(PLAIN) && row.redirect === 'error'));
});

test('without the wire rule the paid-write planner refuses a plain-http Agreement transport its session admitted, and plans it with the rule', async t => {
  const { world } = await composedOver(t, PLAIN);
  await world.build();
  const transactionTransport = createDevnetAgreementWalletTransport(world.session.transport.profile(RELAY_ORIGIN), { relayOrigin: RELAY_ORIGIN, nodeEndpoint: canonicalNodeEndpoint });
  const binding = await world.session.transport.observeBinding(), request = world.request(), address = world.session.wallet.getPublicAccount().address;
  const plan = nodeEndpoint => projectPaidWrite({ request, transaction: request.params[0], address, binding, fee: { networkFee: 1, rpcFee: 0 }, postFork: true,
    chainNonce: 1, transactionTransport, relayOrigin: RELAY_ORIGIN, nodeEndpoint, scopedPaidWrite: true });
  await assert.rejects(plan(undefined), { code: 'not_configured' });
  assert.equal((await plan(canonicalNodeEndpoint)).callback.content.networkBinding.endpoint, PLAIN);
  assert.equal(world.node.broadcasts.length, 0);
});

test('a node over a plain-http root that reports another chain refuses the staged composition before any key is loaded, signature made or effect sent', async t => {
  const { Demos } = await loadNodeDemos();
  const connects = t.mock.method(Demos.prototype, 'connectWallet');
  const { world } = await composedOver(t, PLAIN, otherChainNode());
  await assert.rejects(world.build(), { code: 'tp1_connection_unverified' });
  assert.equal(world.session, undefined);
  assert.equal(connects.mock.callCount(), 0, 'no wallet was connected, so nothing could be signed');
  assert.ok(world.node.calls.length > 0, 'the node was asked for its chain');
  assert.deepEqual(world.effects(), []);
});
