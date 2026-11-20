// The native transport verifies a transaction's signature over what the configured node's getNetworkInfo
// says it covers: the bare hash while the signatureDomain fork is inactive, `demos-tx:v1:<chain id>:<hash>`
// once it is active. An unreadable or malformed answer verifies nothing. The evidence belongs to one
// connection; an inactive answer is reused for one minute at most, an active one is kept, and a failed
// read is retried. A request refused before it holds a lease reads nothing.
// The real transport and durable journal run in this process against a scripted TEST node. No network,
// chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeWorld as world } from './helpers/native-effect-world.mjs';
import { networkInfo } from './helpers/network-info.mjs';

const ONE_MINUTE_MS = 60_000;
const domainForm = chainId => hash => `demos-tx:v1:${chainId}:${hash}`;

// One confirmation of `tx` under its own lease, released afterwards.
const confirmUnderLease = async (w, tx) => {
  const lease = await w.lease();
  try { return await w.confirm(tx); } finally { await w.release(lease.leaseId); }
};
const refusedWith = code => error => error.code === code;

test('with the signature domain fork inactive, a bare-hash signature confirms and a domain-form signature is refused', async t => {
  const w = world(t);
  w.open({});
  assert.equal((await confirmUnderLease(w, w.signedTransfer(1))).result, 200);
  await assert.rejects(confirmUnderLease(w, w.signedTransfer(2, undefined, domainForm(1))), refusedWith('native_only'));
  assert.equal(w.node.confirms, 1, 'the refused signature never reached the node');
});

test('with the signature domain fork active, a domain-form signature confirms and broadcasts and a bare-hash signature is refused', async t => {
  const w = world(t);
  w.node.networkInfo = networkInfo(true, 7);
  w.open({});
  await assert.rejects(confirmUnderLease(w, w.signedTransfer(1)), refusedWith('native_only'));
  assert.equal(w.node.confirms, 0, 'the refused signature never reached the node');
  const lease = await w.lease(), tx = w.signedTransfer(1, undefined, domainForm(7));
  const confirmation = await w.confirm(tx);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  await w.broadcast(confirmation);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});

for (const [name, signedOver] of Object.entries({
  'another chain id': domainForm(8),
  'a zero-padded chain id': domainForm('07'),
  'another version': hash => `demos-tx:v2:7:${hash}`,
  'no chain id': hash => `demos-tx:v1:${hash}`,
})) {
  test(`with the fork active, a signature over ${name} is refused`, async t => {
    const w = world(t);
    w.node.networkInfo = networkInfo(true, 7);
    w.open({});
    await assert.rejects(confirmUnderLease(w, w.signedTransfer(1, undefined, signedOver)), refusedWith('native_only'));
    assert.equal(w.node.confirms, 0);
  });
}

for (const [name, answer] of Object.entries({
  'a failed read': new Error('TEST-node-down'),
  'a refusing node': { result: 500, response: 'TEST-refused', require_reply: false, extra: null },
  'a chain id that is not a safe integer': networkInfo(true, 2 ** 53),
})) {
  test(`an unreadable getNetworkInfo answer (${name}) refuses the request with its cause and nothing reaches the node`, async t => {
    const w = world(t);
    w.node.networkInfo = answer;
    w.open({});
    await assert.rejects(confirmUnderLease(w, w.signedTransfer(1)), error => error.code === 'signature_domain_unreadable' && error.cause instanceof Error);
    assert.equal(w.node.confirms, 0);
  });
}

const activeFor = chainId => networkInfo(true, chainId);
for (const [name, answer] of Object.entries({
  'no forks': { chainId: 1 },
  'no signatureDomain fork': { forks: {}, chainId: 1 },
  'an activated flag that is not a boolean': { forks: { signatureDomain: { activated: 'true' } }, chainId: 1 },
  'no answer body': null,
  'a list for an answer body': [],
  'an active fork with no chain id': { forks: { signatureDomain: { activated: true } } },
  'an active fork with a negative chain id': activeFor(-1),
  'an active fork with a fractional chain id': activeFor(1.5),
  'an active fork with a chain id that is a string': activeFor('7'),
  'an active fork with a null chain id': activeFor(null),
})) {
  test(`a malformed getNetworkInfo answer refuses the request: ${name}`, async t => {
    const w = world(t);
    w.node.networkInfo = answer;
    w.open({});
    await assert.rejects(confirmUnderLease(w, w.signedTransfer(1)), refusedWith('signature_domain_malformed'));
    assert.equal(w.node.confirms, 0);
  });
}

test('an active fork with chain id 0 is read as a valid domain', async t => {
  const w = world(t);
  w.node.networkInfo = networkInfo(true, 0);
  w.open({});
  assert.equal((await confirmUnderLease(w, w.signedTransfer(1, undefined, domainForm(0)))).result, 200);
});

test('an unreadable answer is not remembered: the next request reads again and succeeds', async t => {
  const w = world(t);
  w.node.networkInfo = new Error('TEST-node-down');
  w.open({});
  await assert.rejects(confirmUnderLease(w, w.signedTransfer(1)), refusedWith('signature_domain_unreadable'));
  w.node.networkInfo = networkInfo();
  assert.equal((await confirmUnderLease(w, w.signedTransfer(1))).result, 200);
  assert.equal(w.node.networkInfoReads, 2);
});

test('a malformed answer is not remembered: the next request reads again and succeeds', async t => {
  const w = world(t);
  w.node.networkInfo = { chainId: 1 };
  w.open({});
  await assert.rejects(confirmUnderLease(w, w.signedTransfer(1)), refusedWith('signature_domain_malformed'));
  w.node.networkInfo = networkInfo();
  assert.equal((await confirmUnderLease(w, w.signedTransfer(1))).result, 200);
  assert.equal(w.node.networkInfoReads, 2);
});

test('an active-fork answer is kept for the connection and not read again', async t => {
  let at = Date.now();
  const w = world(t);
  w.node.networkInfo = networkInfo(true, 7);
  w.open({}, { now: () => at });
  await confirmUnderLease(w, w.signedTransfer(1, undefined, domainForm(7)));
  at += ONE_MINUTE_MS + 1000;
  w.node.networkInfo = new Error('TEST-node-down');
  await confirmUnderLease(w, w.signedTransfer(2, undefined, domainForm(7)));
  assert.equal(w.node.networkInfoReads, 1);
});

test('an inactive-fork answer is reused for under a minute and read again at one minute', async t => {
  let at = Date.now();
  const w = world(t);
  w.open({}, { now: () => at });
  await confirmUnderLease(w, w.signedTransfer(1));
  at += ONE_MINUTE_MS - 1;
  await confirmUnderLease(w, w.signedTransfer(2));
  assert.equal(w.node.networkInfoReads, 1, 'reused one millisecond short of a minute');
  at += 1;
  await confirmUnderLease(w, w.signedTransfer(3));
  assert.equal(w.node.networkInfoReads, 2, 'read again at one minute');
});

test('an inactive answer that turns active is picked up after the minute, and bare-hash signatures are then refused', async t => {
  let at = Date.now();
  const w = world(t);
  w.open({}, { now: () => at });
  await confirmUnderLease(w, w.signedTransfer(1));
  w.node.networkInfo = networkInfo(true, 7);
  at += ONE_MINUTE_MS;
  await assert.rejects(confirmUnderLease(w, w.signedTransfer(2)), refusedWith('native_only'));
  assert.equal((await confirmUnderLease(w, w.signedTransfer(2, undefined, domainForm(7)))).result, 200);
});

test('the domain evidence of one connection is not used on another connection', async t => {
  const w = world(t);
  w.node.networkInfo = networkInfo(true, 7);
  w.open({});
  await confirmUnderLease(w, w.signedTransfer(1, undefined, domainForm(7)));
  w.fence.connectionId = 'TEST-connection-other';
  w.node.networkInfo = networkInfo(true, 9);
  await assert.rejects(confirmUnderLease(w, w.signedTransfer(2, undefined, domainForm(7))), refusedWith('native_only'));
  assert.equal(w.node.networkInfoReads, 2, 'the other connection was read, not assumed');
  assert.equal((await confirmUnderLease(w, w.signedTransfer(2, undefined, domainForm(9)))).result, 200);
  assert.equal(w.node.networkInfoReads, 2, 'the other connection is then kept');
});

test('a connection that changes while the domain is read refuses the request and keeps nothing', async t => {
  const w = world(t);
  w.node.networkInfo = () => { w.fence.connectionId = 'TEST-connection-moved'; return networkInfo(); };
  w.open({});
  await assert.rejects(confirmUnderLease(w, w.signedTransfer(1)), refusedWith('connection_changed'));
  assert.equal(w.node.confirms, 0);
  w.node.networkInfo = networkInfo(true, 7);
  assert.equal((await confirmUnderLease(w, w.signedTransfer(1, undefined, domainForm(7)))).result, 200);
  assert.equal(w.node.networkInfoReads, 2, 'the answer read while the connection moved was not kept');
});

test('a request with no lease makes no getNetworkInfo read', async t => {
  const w = world(t);
  w.open({});
  await assert.rejects(w.confirm(w.signedTransfer(1)), refusedWith('network_binding_required'));
  assert.equal(w.node.networkInfoReads, 0);
  assert.equal(w.node.confirms, 0);
});

test('a request whose lease has expired makes no getNetworkInfo read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let at = Date.now();
  const w = world(t);
  w.open({}, { now: () => at, leaseMs: 1000 });
  await w.lease();
  at += 1000;
  await assert.rejects(w.confirm(w.signedTransfer(1)), refusedWith('network_binding_required'));
  assert.equal(w.node.networkInfoReads, 0);
});

test('a request that is not a native send or storage CREATE makes no getNetworkInfo read', async t => {
  const w = world(t);
  w.open({});
  await w.lease();
  const tx = w.signedTransfer(1);
  tx.content.type = 'web2Request';
  await assert.rejects(w.confirm(tx), refusedWith('native_only'));
  assert.equal(w.node.networkInfoReads, 0);
});

test('after a restart the domain is read again and a refused signature is not relayed', async t => {
  const w = world(t);
  w.node.networkInfo = networkInfo(true, 7);
  w.open({});
  await confirmUnderLease(w, w.signedTransfer(1, undefined, domainForm(7)));
  await w.restart({});
  await assert.rejects(confirmUnderLease(w, w.signedTransfer(2)), refusedWith('native_only'));
  assert.equal(w.node.networkInfoReads, 2, 'the restarted wallet read the domain itself');
  assert.equal(w.node.confirms, 1, 'the refused signature was not relayed');
  assert.equal((await confirmUnderLease(w, w.signedTransfer(2, undefined, domainForm(7)))).result, 200);
});
