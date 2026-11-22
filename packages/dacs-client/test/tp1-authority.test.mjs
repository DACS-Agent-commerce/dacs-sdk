// Testnet authority tokens on the client's native capabilities and the native transport's
// publication policies. Offline: no socket, DNS lookup or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { createAuthorityFixture, LOCAL } from './fixtures/tp1-authority-reader.mjs';
import { api, setPurchaseAdmission, world } from './helpers/tp1-node-fixture.mjs'; // first: it installs the purchase-admission hook
import { readOnlyBoundary } from './helpers/read-only-boundary.mjs';

// Loaded after the fixture above has installed the purchase-admission hook.
const { createWorld, JOB_IDS, queuingFenceOwner } = await import('./helpers/native-create-world.mjs');
const { writingBoundary } = await import('./helpers/transport-boundary.mjs');
const { openDurableWalletJournal } = await import('../src/wallet/durable-journal.mjs');
const { createSourceDemoSellerTransport, sourceDemoSellerTransportConfig } = await import('../src/dacs/source-demo-seller-transport.mjs');
const { createDemDeliveryContext, demDeliveryContextConfig, isDemDeliveryContextAuthority } = await import('../src/dacs/dem-delivery-context-consumer.mjs');
const { createNativeDemDeliveryCapability, nativeDemDeliveryConfig } = await import('../src/dacs/native-dem-delivery-consumer.mjs');
const { createDevnetNativeCommitmentCapability, devnetNativeCommitmentConfig } = await import('../src/devnet-demo/commitment-consumer.mjs');
const { agreementContextConfig, isOperatorContextAuthority } = await import('../src/dacs/agreement-context-consumer.mjs');
const { createDevnetAgreementWalletTransport } = await import('../src/public/portal/embedded-wallet/sdk-provider.mjs');

// The suite must stay offline: any socket connection or name lookup is counted, and refused.
const leaks = [];
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function refuseConnect() { leaks.push('connect'); throw new Error('TEST-no-network'); };
const lookup = dns.lookup, promisesLookup = dns.promises.lookup;
dns.lookup = () => { leaks.push('lookup'); throw new Error('TEST-no-network'); };
dns.promises.lookup = async () => { leaks.push('lookup'); throw new Error('TEST-no-network'); };
test.after(() => { net.Socket.prototype.connect = connect; dns.lookup = lookup; dns.promises.lookup = promisesLookup; });

const WALLET_ORIGIN = 'https://wallet.test';
const noop = () => {};
const OTHER_DIGEST_LABEL = `TP1-${'0'.repeat(32)}`;

/** A binding over the approved record on one connection, and the token the session admits for it. */
async function admit(connectionId = LOCAL.connectionId) {
  const local = { ...LOCAL, connectionId };
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: { ...local }, readAuthority: createAuthorityFixture().read });
  const token = await api.admitTp1Authority({ binding, currentLocal: () => ({ ...local }) });
  return { binding, token };
}

/** Purchase admission set for one test; it is held again when the test ends. */
function admitPurchases(t, state = 'testnet-tp1') {
  setPurchaseAdmission(state);
  t.after(() => setPurchaseAdmission('held'));
}

/** The four token-taking capability constructors, each built from an authority and an explicit binding. */
const CONSTRUCTORS = [
  { name: 'source demo seller transport', fixture: 'TEST-fixture-seller',
    build: (authority, binding) => createSourceDemoSellerTransport({ authority, binding, sessionSignerFor: noop, sessionPolicyFor: noop, endpointProofFor: noop, effectBoundary: readOnlyBoundary }),
    declared: capability => capability.declaration.authority, configured: sourceDemoSellerTransportConfig },
  { name: 'DEM delivery context', fixture: 'TEST-fixture-context',
    build: (authority, binding) => createDemDeliveryContext({ authority, binding, resolveBuyer: noop, resolveSeller: noop }),
    declared: capability => capability.authority, configured: demDeliveryContextConfig },
  { name: 'native DEM delivery', fixture: 'TEST-fixture-native',
    build: (authority, binding) => createNativeDemDeliveryCapability({ authority, binding, submit: noop, reconcile: noop, read: noop, verifyReceipt: noop }),
    declared: capability => capability.authority, configured: nativeDemDeliveryConfig },
  { name: 'native commitment', fixture: 'TEST-RUN-fixture-0001',
    build: (authority, binding) => createDevnetNativeCommitmentCapability({ authority, binding,
      anchor: { authority: api.isTp1AuthorityToken(authority) ? api.authorityLabelOf(authority) : authority, readRetained: noop, verifyReceipt: noop } }),
    declared: capability => capability.authority, configured: devnetNativeCommitmentConfig },
];

/** A transport world over a fresh durable journal; `options` are those of `createWorld`. */
function transportWorld(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tp1-authority-'));
  const journal = openDurableWalletJournal({ path: join(directory, 'journal.sqlite'), mode: 'create' });
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = queuingFenceOwner();
  return { journal, owner, create: (options = {}) => createWorld({ journal, owner, ...options }) };
}

const tokensFor = token => ({ settlement: token, delivery: token, demo: token });

test('admitted through the test seam, the source demo seller transport, DEM delivery context, native DEM delivery and native commitment accept a token with its binding', async t => {
  admitPurchases(t);
  const { binding, token } = await admit();
  for (const { name, build, declared, configured } of CONSTRUCTORS) {
    const capability = build(token, binding);
    assert.equal(declared(capability), api.authorityLabelOf(token), `${name} declares the token's label`);
    assert.equal(typeof declared(capability), 'string', `${name} stores only the label`);
    assert.equal(configured(capability), capability, `${name} registered the capability`);
  }
});

test("the native transport's settlement, delivery and demo publications accept a token and declare its label string", async t => {
  admitPurchases(t);
  const { binding, token } = await admit();
  const label = api.authorityLabelOf(token);
  const w = transportWorld(t).create({ authorities: tokensFor(token), authorityBinding: binding });
  t.after(() => w.capability.close());
  const profile = w.capability.profile(WALLET_ORIGIN);
  for (const key of ['settlementPublication', 'deliveryPublication', 'demoArtifactPublication']) {
    assert.equal(profile[key].authority, label, `${key} declares the label`);
    assert.equal(profile.transportBinding[key].authority, label, `the transport binding's ${key} carries the same label`);
  }
  const tx = await w.makeCreate(JOB_IDS[0], 1);
  assert.equal(tx.content.data[1].metadata.artifactBinding.authority, label);
  const lease = await w.lease();
  const confirmation = await w.confirm(tx);
  assert.equal(confirmation.result, 200, 'the node confirmed a CREATE whose signed metadata names the label');
  assert.deepEqual(w.sent.confirms, [tx.hash]);
  await w.release(lease);
});

test('readTransport accepts a canonical TP1- label string only when it equals the bound publication, and refuses a mismatched or malformed label string', async t => {
  admitPurchases(t);
  const { binding, token } = await admit();
  const { capability } = transportWorld(t).create({ authorities: tokensFor(token), authorityBinding: binding });
  t.after(() => capability.close());
  const profile = structuredClone(capability.profile(WALLET_ORIGIN));
  assert.ok(createDevnetAgreementWalletTransport(profile, { relayOrigin: WALLET_ORIGIN }), 'the declared labels equal the binding copy');
  for (const key of ['settlementPublication', 'deliveryPublication', 'demoArtifactPublication']) {
    const mismatched = structuredClone(profile);
    mismatched[key] = { ...mismatched[key], authority: OTHER_DIGEST_LABEL };
    assert.throws(() => createDevnetAgreementWalletTransport(mismatched, { relayOrigin: WALLET_ORIGIN }), { code: 'held_for_review' }, `${key} naming another label than the binding`);
    for (const malformed of [`TP1-${'A'.repeat(32)}`, `TP1-${'0'.repeat(31)}`, `TP1-${'0'.repeat(33)}`, `tp1-${'0'.repeat(32)}`, { label: api.authorityLabelOf(token) }, 7]) {
      const refused = structuredClone(profile);
      refused[key].authority = refused.transportBinding[key].authority = malformed;
      assert.throws(() => createDevnetAgreementWalletTransport(refused, { relayOrigin: WALLET_ORIGIN }), { code: 'held_for_review' }, `${key} with ${JSON.stringify(malformed)}`);
    }
  }
});

test('TEST- and TEST-RUN- labels stay accepted for fixtures', async t => {
  admitPurchases(t);
  const { binding } = await admit();
  for (const { name, build, declared, fixture } of CONSTRUCTORS) {
    assert.equal(declared(build(fixture, binding)), fixture, name);
    assert.equal(declared(build(fixture, undefined)), fixture, `${name}: a fixture label needs no binding`);
  }
  const w = transportWorld(t).create();
  t.after(() => w.capability.close());
  const profile = w.capability.profile(WALLET_ORIGIN);
  assert.match(profile.settlementPublication.authority, /^TEST-/);
  assert.match(profile.demoArtifactPublication.authority, /^TEST-RUN-/);
  assert.ok(createDevnetAgreementWalletTransport(structuredClone(profile), { relayOrigin: WALLET_ORIGIN }));
});

test('a plain TP1- label string is refused authority_unbound at each token-taking constructor', async t => {
  admitPurchases(t);
  const { binding, token } = await admit();
  const label = api.authorityLabelOf(token);
  for (const { name, build } of CONSTRUCTORS) assert.throws(() => build(label, binding), { code: 'authority_unbound' }, name);
  const world = transportWorld(t);
  for (const key of ['settlement', 'delivery', 'demo']) {
    assert.throws(() => world.create({ authorities: { [key]: label }, authorityBinding: binding }), { code: 'authority_unbound' }, `transport ${key} publication`);
  }
});

test('a token for another binding, or a label naming another record digest, is refused at each site', async t => {
  admitPurchases(t);
  const { binding, token } = await admit();
  const other = await admit('vector-conn-other');
  for (const { name, build } of CONSTRUCTORS) {
    assert.throws(() => build(token, other.binding), { code: 'authority_unbound' }, `${name}: token with another binding`);
    assert.throws(() => build(token, undefined), { code: 'authority_unbound' }, `${name}: token with no binding`);
    assert.throws(() => build(token, structuredClone(binding)), { code: 'authority_unbound' }, `${name}: token with a copy of its binding`);
    assert.throws(() => build({ ...token }, binding), name + ': a copy of the token');
    assert.throws(() => build(OTHER_DIGEST_LABEL, binding), { code: 'authority_unbound' }, `${name}: label naming another record digest`);
  }
  const world = transportWorld(t);
  for (const key of ['settlement', 'delivery', 'demo']) {
    assert.throws(() => world.create({ authorities: { [key]: token }, authorityBinding: other.binding }), { code: 'authority_unbound' }, `transport ${key}: token with another binding`);
    assert.throws(() => world.create({ authorities: { [key]: token } }), { code: 'authority_unbound' }, `transport ${key}: token with no binding`);
    assert.throws(() => world.create({ authorities: { [key]: OTHER_DIGEST_LABEL }, authorityBinding: binding }), { code: 'authority_unbound' }, `transport ${key}: other label`);
  }
});

test("with two bindings over the same record on different connections, each constructor refuses the other binding's token although the labels are equal", async t => {
  admitPurchases(t);
  const first = await admit('vector-conn-first'), second = await admit('vector-conn-second');
  assert.equal(api.authorityLabelOf(first.token), api.authorityLabelOf(second.token));
  assert.notEqual(first.binding, second.binding);
  for (const { name, build } of CONSTRUCTORS) {
    assert.ok(build(first.token, first.binding), `${name}: first token, first binding`);
    assert.ok(build(second.token, second.binding), `${name}: second token, second binding`);
    assert.throws(() => build(first.token, second.binding), { code: 'authority_unbound' }, `${name}: first token, second binding`);
    assert.throws(() => build(second.token, first.binding), { code: 'authority_unbound' }, `${name}: second token, first binding`);
  }
  const world = transportWorld(t);
  for (const key of ['settlement', 'delivery', 'demo']) {
    assert.throws(() => world.create({ authorities: { [key]: first.token }, authorityBinding: second.binding }), { code: 'authority_unbound' }, `transport ${key}`);
  }
});

test('held, each token-bearing constructor throws profile_not_admitted and registers no capability', async t => {
  admitPurchases(t, 'held');
  const { binding, token } = await admit();
  for (const { name, build } of CONSTRUCTORS) assert.throws(() => build(token, binding), { code: 'profile_not_admitted' }, name);
  const { journal, owner } = transportWorld(t);
  const boundary = writingBoundary({ owner, journal });
  setPurchaseAdmission('held');
  for (const key of ['settlement', 'delivery', 'demo']) {
    assert.throws(() => createWorld({ journal, owner, boundary, authorities: { [key]: token }, authorityBinding: binding }), { code: 'profile_not_admitted' }, `transport ${key}`);
  }
  setPurchaseAdmission('testnet-tp1');
  for (const { name, build, declared, configured } of CONSTRUCTORS) {
    const capability = build(token, binding);
    assert.equal(configured(capability), capability, `${name}: the refused attempts left nothing in the way of a later admitted one`);
    assert.equal(declared(capability), api.authorityLabelOf(token));
  }
  setPurchaseAdmission('held');
  for (const { name, fixture, build, declared } of CONSTRUCTORS) assert.equal(declared(build(fixture, binding)), fixture, `${name}: a fixture label needs no admission`);
});

test('isDemDeliveryContextAuthority accepts canonical TEST- and TP1- label strings at runtime, refuses tokens, malformed labels and non-strings', async () => {
  const { token } = await admit();
  for (const label of ['TEST-fixture-context', 'TEST-RUN-fixture-0001', api.authorityLabelOf(token), OTHER_DIGEST_LABEL]) assert.equal(isDemDeliveryContextAuthority(label), true, label);
  for (const refused of [token, { label: api.authorityLabelOf(token) }, `TP1-${'A'.repeat(32)}`, `TP1-${'0'.repeat(31)}`, `TP1-${'0'.repeat(33)}`, `tp1-${'0'.repeat(32)}`, 'TEST-', 'TEST- x', 'demo', '', 7, null, undefined]) {
    assert.equal(isDemDeliveryContextAuthority(refused), false, String(refused));
  }
});

test('the generic operator context seam does not admit a TP1- label', async () => {
  const { token } = await admit();
  const label = api.authorityLabelOf(token);
  assert.equal(isOperatorContextAuthority(label), false);
  assert.equal(isOperatorContextAuthority(label.toLowerCase()), true, 'the seam is a lower-case label class of its own');
  assert.throws(() => agreementContextConfig({ authority: label, resolve: noop }), TypeError);
  assert.throws(() => agreementContextConfig({ authority: token, resolve: noop }), TypeError);
});

test('sdk-provider.mjs and tp1-authority-label.mjs import no Node composition module', () => {
  for (const file of ['../src/public/portal/embedded-wallet/sdk-provider.mjs', '../src/dacs/tp1-authority-label.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^'"\n]*(?:from\s*)?['"]([^'"]+)['"]/gm)].map(match => match[1]);
    assert.deepEqual(specifiers.filter(specifier => /^node:|wallet\/|node-wallet|composition/.test(specifier)), [], file);
  }
});

test('a retained CREATE whose metadata names a TEST label is not recovered under a TP1 declaration, nor the reverse', async t => {
  admitPurchases(t);
  const { binding, token } = await admit();
  const fixtureSide = transportWorld(t), testnetSide = transportWorld(t);
  const fixtureWorld = fixtureSide.create(), testnetWorld = testnetSide.create({ authorities: tokensFor(token), authorityBinding: binding });
  t.after(async () => { await fixtureWorld.capability.close(); await testnetWorld.capability.close(); });
  const fixtureCreate = await fixtureWorld.makeCreate(JOB_IDS[0], 1), testnetCreate = await testnetWorld.makeCreate(JOB_IDS[0], 1);
  assert.notEqual(fixtureCreate.content.data[1].metadata.artifactBinding.authority, testnetCreate.content.data[1].metadata.artifactBinding.authority);
  const cases = [['a TEST create under a TP1 declaration', testnetSide, testnetWorld, fixtureCreate], ['a TP1 create under a TEST declaration', fixtureSide, fixtureWorld, testnetCreate]];
  for (const [name, { journal }, recovering, create] of cases) {
    await recovering.retain(create, 'broadcast-accepted', { signed: true });
    const retained = await journal.get(`devnet/native-transfer/${create.hash}`);
    await assert.rejects(recovering.recover(create), { code: 'storage_recovery_only' }, name);
    assert.deepEqual(recovering.sent, { confirms: [], broadcasts: [] }, `${name}: nothing was confirmed or resent`);
    assert.deepEqual(await journal.get(`devnet/native-transfer/${create.hash}`), retained, `${name}: the retained row is unchanged`);
  }
  const controlWorld = transportWorld(t).create();
  t.after(() => controlWorld.capability.close());
  const ownCreate = await controlWorld.makeCreate(JOB_IDS[0], 1);
  await controlWorld.retain(ownCreate, 'broadcast-accepted', { signed: true });
  assert.deepEqual(await controlWorld.recover(ownCreate), { disposition: 'pending', hash: ownCreate.hash, noResend: true }, 'a create under its own declaration is read back, not refused');
});

test('reopened composition reconstructs token and refuses old serialized capability authority', async t => {
  admitPurchases(t);
  const before = await admit();
  const oldLabel = api.authorityLabelOf(before.token);
  const reopened = await admit();
  assert.equal(api.authorityLabelOf(reopened.token), oldLabel, 'the label is stable across a restart');
  for (const { name, build, declared } of CONSTRUCTORS) {
    assert.equal(declared(build(reopened.token, reopened.binding)), oldLabel, `${name}: the reopened composition's own token`);
    assert.throws(() => build(before.token, reopened.binding), { code: 'authority_unbound' }, `${name}: the earlier composition's token`);
    assert.throws(() => build(oldLabel, reopened.binding), { code: 'authority_unbound' }, `${name}: the serialized label`);
  }
});

test('the seller composition accepts token publication policies for its own binding', async t => {
  let token;
  const tokenPublications = async admission => {
    token = await api.admitTp1Authority(admission);
    return { publications: {
      settlementPublication: { artifactKind: 'SettlementEvidence', authority: token, phase: 'pay-dem', phaseIndex: 2, policy: api.DEVNET_SETTLEMENT_POLICY, railId: 'demos-native:DEM' },
      deliveryPublication: { artifactKind: 'Deliverable', authority: token, phase: 'deliver-storage-program', phaseIndex: 3, policy: api.DEVNET_DELIVERY_POLICY },
      demoArtifactPublication: { authority: token, policy: api.DEVNET_DEMO_ARTIFACT_POLICY, artifactKinds: [...api.DEVNET_DEMO_ARTIFACT_TYPES] },
    } };
  };
  const w = await world(t, { createSession: api.createNodeSellerComposition, sessionOptions: { approveConfirmedWrite: null }, sessionOptionsFor: tokenPublications });
  const label = api.authorityLabelOf(token);
  const { settlementPublication, deliveryPublication, demoArtifactPublication } = w.session.transport;
  assert.deepEqual([settlementPublication.authority, deliveryPublication.authority, demoArtifactPublication.authority], [label, label, label]);
});

test('no socket or DNS lookup leaves the process in the P23 suite', () => {
  assert.deepEqual(leaks, []);
});
