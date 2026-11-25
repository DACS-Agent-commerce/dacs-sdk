// The wallet-free node RPC endpoint check: the wire's one endpoint rule, with the approved chain identity passed on
// only under the client's `testnet` label, and the HTTP-capable owner and binder that a checked root then reaches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { canonicalNodeEndpoint, TP1_APPROVED_CHAIN_IDENTITY } from '@kynesyslabs/dacs/wire/node-endpoint';
import * as client from '@kynesyslabs/dacs-client';
import { FIXTURE_IDENTITY } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { pinContexts, RPC_URL_CASES, wireAnswer } from './helpers/rpc-endpoint-cases.mjs';
import * as entry from '../src/rpc-endpoint.mjs';
import { assertNodeRpcEndpoint, createDemosNetworkBinder, NetworkBindingError } from '../src/dacs/network-binding.mjs';
import { createNodeTransportOwner } from '../src/wallet/node-wallet-session.mjs';

const APPROVED = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const OTHER = 'd'.repeat(64);
const AUTHORITY = 'vector-authority';
const NOW = 1_000_000;
const refused = { name: 'NetworkBindingError', code: 'rpc_endpoint_invalid' };

// Refuses with the wrapper's own code and keeps no URL, credential or cause in what it throws.
function assertRefused(input, label = JSON.stringify(input)) {
  assert.throws(() => assertNodeRpcEndpoint(input), error => {
    assert.ok(error instanceof NetworkBindingError, label);
    assert.deepEqual([error.code, error.cause], ['rpc_endpoint_invalid', undefined], label);
    assert.doesNotMatch(error.message, /user|pw|:\/\/|\bh\//, label);
    return true;
  }, label);
}

// Opens the owner only for a root the check admits, as a purchase-time caller does; counts each owner it opens.
function ownerOpener(fetchImpl) {
  const opened = [];
  return { opened, open(record) {
    const endpoint = assertNodeRpcEndpoint(record);
    const owner = createNodeTransportOwner({ endpoint, transportAuthority: AUTHORITY, fetchImpl, chainIdentity: record.chainIdentity });
    opened.push(owner);
    return owner;
  } };
}

test('client RPC endpoint entry exports one wallet-free assertion', () => {
  assert.deepEqual(Object.keys(entry), ['assertNodeRpcEndpoint']);
  assert.equal(entry.assertNodeRpcEndpoint, assertNodeRpcEndpoint);
  assert.equal(client.assertNodeRpcEndpoint, entry.assertNodeRpcEndpoint);
});

test('HTTPS node roots canonicalize identically with and without the reviewed pin', () => {
  for (const rpcUrl of ['https://h/', 'https://h:8443/']) {
    for (const context of [...pinContexts(APPROVED, OTHER), { network: 'testnet', chainIdentity: 42 }]) {
      const record = { rpcUrl, ...context };
      assert.equal(assertNodeRpcEndpoint(record), rpcUrl, JSON.stringify(record));
      assert.equal(wireAnswer(canonicalNodeEndpoint, record), rpcUrl, JSON.stringify(record));
    }
    assert.equal(assertNodeRpcEndpoint({ rpcUrl, chainIdentity: APPROVED }), rpcUrl, 'a record that omits network');
    assert.equal(assertNodeRpcEndpoint({ rpcUrl, network: 'testnet' }), rpcUrl, 'a record that omits chainIdentity');
  }
});

test('only the reviewed testnet chain identity admits an HTTP node root', () => {
  const { opened, open } = ownerOpener(() => assert.fail('no node read'));
  const admitted = open({ rpcUrl: 'http://h/', network: 'testnet', chainIdentity: APPROVED });
  assert.equal(admitted.local.endpoint, 'http://h/');
  admitted.close();
  for (const record of [
    { rpcUrl: 'http://h/', network: 'testnet' },
    { rpcUrl: 'http://h/', network: 'testnet', chainIdentity: OTHER },
    { rpcUrl: 'http://h/', network: 'testnet', chainIdentity: FIXTURE_IDENTITY },
    { rpcUrl: 'http://h/', network: 'mainnet', chainIdentity: APPROVED },
    { rpcUrl: 'http://h/', network: 'demos-testnet', chainIdentity: APPROVED },
    { rpcUrl: 'http://h/', chainIdentity: APPROVED },
  ]) {
    assertRefused(record);
    assert.throws(() => open(record), refused, JSON.stringify(record));
  }
  assert.equal(opened.length, 1, 'no refused record reached the owner');
});

test('node RPC endpoint refuses credentials paths queries fragments and absent input', () => {
  const pinned = { network: 'testnet', chainIdentity: APPROVED };
  const urls = ['http://h/rpc', 'http://user:pw@h/', 'http://user@h/', 'http://h/?x=1', 'http://h/#f',
    'https://h', 'https://h/rpc', 'https://h/?x=1', 'https://h/#f', 'https://user:pw@h/', 'https://H/', 'https://h/?', 'ws://h/', 'h', ''];
  for (const rpcUrl of urls) {
    assert.equal(wireAnswer(canonicalNodeEndpoint, { rpcUrl, ...pinned }), null, rpcUrl);
    assertRefused({ rpcUrl, ...pinned }, rpcUrl);
  }
  for (const rpcUrl of [443, null, undefined, new URL('https://h/'), ['https://h/']]) {
    assert.equal(wireAnswer(canonicalNodeEndpoint, { rpcUrl, ...pinned }), null, String(rpcUrl));
    assertRefused({ rpcUrl, ...pinned }, String(rpcUrl));
  }
  assertRefused(pinned, 'a record with no rpcUrl');
  assertRefused(undefined, 'no record');
});

test('node RPC endpoint matches the wire predicate on every accepted and refused URL', () => {
  const accepted = [];
  for (const rpcUrl of RPC_URL_CASES) {
    for (const context of pinContexts(APPROVED, OTHER)) {
      const record = { rpcUrl, ...context }, wire = wireAnswer(canonicalNodeEndpoint, record);
      if (wire === null) assertRefused(record);
      else assert.equal(assertNodeRpcEndpoint(record), wire, JSON.stringify(record));
      if (context.network === 'testnet' && context.chainIdentity === APPROVED && wire !== null) accepted.push(wire);
    }
  }
  assert.deepEqual(accepted, ['https://h/', 'https://h:8443/', 'http://h/']);
  assertRefused({ rpcUrl: 'https://h', network: 'testnet', chainIdentity: APPROVED }, 'a root without its trailing slash is not repaired');
});

test('HTTP admission fails when its reviewed identity comparison is removed', () => {
  assert.equal(TP1_APPROVED_CHAIN_IDENTITY, APPROVED, 'the wire leaf compares with the approved record\'s chain identity');
  assert.equal(assertNodeRpcEndpoint({ rpcUrl: 'http://h/', network: 'testnet', chainIdentity: APPROVED }), 'http://h/');
  for (const chainIdentity of [OTHER, APPROVED.toUpperCase(), `0x${APPROVED}`]) {
    assertRefused({ rpcUrl: 'http://h/', network: 'testnet', chainIdentity }, chainIdentity);
  }
  assertRefused({ rpcUrl: 'http://h/', network: 'mainnet', chainIdentity: APPROVED }, 'the approved pin under another label');
});

// A binder reader that reads block zero through the owner's fetch; the node answers with `live.identity`.
function ownerReader(owner, live) {
  return { getContext: () => owner.getContext(),
    async getBlockByNumber(height, policy) {
      const answer = await owner.fetchImpl(owner.local.endpoint, { method: 'POST', body: JSON.stringify({ height }), ...policy });
      return { value: await answer.json(), context: owner.getContext(), observedAt: NOW, fromCache: false, redirected: false };
    } };
}

test('HTTP owner and network binder keep fresh identity and zero effects on mismatch', async () => {
  const requests = [], live = { identity: APPROVED };
  const fetchImpl = async (url, init) => {
    requests.push({ url, redirect: init.redirect });
    return new Response(JSON.stringify({ number: 0, status: 'confirmed', hash: live.identity }), { headers: { 'content-type': 'application/json' } });
  };
  const { opened, open } = ownerOpener(fetchImpl);
  for (const record of [{ rpcUrl: 'http://h/', network: 'testnet' }, { rpcUrl: 'http://h/', network: 'testnet', chainIdentity: OTHER }]) {
    assert.throws(() => open(record), refused, JSON.stringify(record));
  }
  assert.equal(opened.length, 0, 'a missing or wrong pin opens no owner');

  const owner = open({ rpcUrl: 'http://h/', network: 'testnet', chainIdentity: APPROVED });
  assert.deepEqual(requests, [], 'constructing the owner reads nothing');
  assert.throws(() => owner.fetchImpl('http://other.invalid/', {}), { code: 'transport_mismatch' }, 'the owner reaches only its own origin');

  const expected = { network: TP1_APPROVED_IDENTITY_RECORD.network, chainIdentity: APPROVED, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion,
    endpoint: 'http://h/', transportAuthority: AUTHORITY };
  const binder = createDemosNetworkBinder({ expected, reader: ownerReader(owner, live), now: () => NOW });
  assert.deepEqual(requests, [], 'constructing the binder reads nothing');
  const saved = await binder.bind();
  assert.deepEqual([saved.endpoint, saved.chainIdentity], ['http://h/', APPROVED]);
  assert.ok(requests.length > 0 && requests.every(row => row.url === 'http://h/' && row.redirect === 'error'), 'every read refused redirects');

  const effects = { signatures: 0, sends: 0 };
  live.identity = OTHER;
  await assert.rejects(binder.bind(), { code: 'identity_mismatch' });
  await assert.rejects((async () => { await binder.beforeSignature(saved); effects.signatures += 1; })(), { code: 'identity_mismatch' });
  await assert.rejects((async () => { await binder.beforeBroadcast(saved); effects.sends += 1; })(), { code: 'identity_mismatch' });
  assert.deepEqual(effects, { signatures: 0, sends: 0 });

  owner.close();
  assert.throws(() => owner.fetchImpl('http://h/', {}), { code: 'transport_closed' });
  assert.throws(() => owner.getContext(), { code: 'transport_closed' });
});
