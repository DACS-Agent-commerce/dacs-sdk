// The kit's three delivery constructors take a fixture TEST- label or a TP-1 token admitted for the composition's own binding,
// and store only the label. The production wallet-session port admits a token for a publication that names its binding's own
// TP1- label when it finalizes. The client's purchase hold is lifted through its test hook only where a row says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from '@kynesyslabs/dacs';
import { api, nodeConnection, sellerPublications, setPurchaseAdmission, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';

const { allZero, walletSessionWorld } = await import('./helpers/seller-wallet-session-world.mjs');
const { anchorFixture, signSdkCreate } = await import('./helpers/anchor-isolated-fixture.mjs');
const { fixtureListing } = await import('./fixtures/listings.mjs');
const { protocolFixture, buyer, seller, JOB, NOW } = await import('./helpers/protocol-fixture.mjs');
const client = await import('@kynesyslabs/dacs-client');
const contextModule = await import('../src/dacs/dem-delivery-context-consumer.mjs');
const nativeModule = await import('../src/dacs/native-dem-delivery-consumer.mjs');
const { createDevnetDemoDeliveryCapability } = await import('../src/devnet-demo/native-delivery.mjs');
const { createDevnetPurchasedReportProducer } = await import('../src/devnet-demo/deliverable.mjs');
const { createDemDeliveryContext, resolveDemDeliverySellerContext } = contextModule;
const { createNativeDemDeliveryCapability, nativeDemDeliveryConfig, reconcileNativeDemDelivery, submitNativeDemDelivery } = nativeModule;

const OTHER_DIGEST_LABEL = `TP1-${'f'.repeat(32)}`;
const TYPE_WORDING = /explicit TEST authority or bound TP-1 token/;
const passiveAnchor = (authority) => ({ authority, publish: async () => ({}), read: async () => ({}), readRetained: async () => ({}), verifyReceipt: async () => 'valid' });
const nativeOptions = { submitAuthorized: async () => ({ status: 'accepted' }), reconcile: async () => ({}), read: async () => ({}), verifyReceipt: async () => 'valid' };
// Each token-taking constructor, built with `authority` and `binding`.
const CONSTRUCTORS = {
  createDemDeliveryContext: (authority, binding) => createDemDeliveryContext({ authority, binding, resolveBuyer: () => null, resolveSeller: () => null }),
  createNativeDemDeliveryCapability: (authority, binding) => createNativeDemDeliveryCapability({ authority, binding, ...nativeOptions }),
  createDevnetDemoDeliveryCapability: (authority, binding, anchorAuthority = typeof authority === 'string' ? authority : authority?.label) =>
    createDevnetDemoDeliveryCapability({ authority, binding, anchor: passiveAnchor(anchorAuthority) }),
};

// A connection bound to the TP-1 record, with the purchase hold lifted for the test; `token` is admitted for its binding.
async function admitted(t) {
  setPurchaseAdmission('testnet-tp1');
  const connection = await nodeConnection();
  t.after(async () => { setPurchaseAdmission('held'); await connection.owner.close(); });
  const token = await api.admitTp1Authority(connection.admission);
  return { ...connection, binding: connection.admission.binding, token, label: api.tp1AuthorityLabel(connection.admission.binding) };
}

test('with the guard on through the test loader, the DEM delivery context and native DEM delivery accept a token from admitTp1Authority with its binding', async (t) => {
  const { binding, token } = await admitted(t);
  assert.equal(contextModule.demDeliveryContextConfig(CONSTRUCTORS.createDemDeliveryContext(token, binding)) !== null, true);
  assert.equal(nativeDemDeliveryConfig(CONSTRUCTORS.createNativeDemDeliveryCapability(token, binding)) !== null, true);
});

test('TEST- labels stay accepted for fixtures and their capabilities keep the TEST- label', () => {
  for (const [name, build] of Object.entries(CONSTRUCTORS)) assert.equal(build('TEST-fixture-label').authority, 'TEST-fixture-label', name);
});

test('a plain TP1- label string at a constructor is refused authority_unbound', async (t) => {
  const { binding, label, token } = await admitted(t);
  for (const [name, build] of Object.entries(CONSTRUCTORS)) {
    assert.throws(() => build(label, binding, label), { name: 'OperationError', code: 'authority_unbound' }, name);
    const wording = name === 'createDevnetDemoDeliveryCapability' ? /exact seller native artifact anchor/ : TYPE_WORDING;
    for (const value of [{ ...token }, { label }, 'TP1-short', 'not-a-label', 7, null]) assert.throws(() => build(value, binding, label), (error) => error instanceof TypeError && wording.test(error.message), `${name} ${JSON.stringify(value)}`);
  }
});

test('a token whose binding is not the composition\'s, or a label naming another record digest, is refused authority_unbound', async (t) => {
  const { binding, token } = await admitted(t);
  for (const [name, build] of Object.entries(CONSTRUCTORS)) {
    for (const other of [undefined, null, structuredClone(binding), { ...binding }]) assert.throws(() => build(token, other), { code: 'authority_unbound' }, name);
    assert.throws(() => build(OTHER_DIGEST_LABEL, binding), { code: 'authority_unbound' }, name);
  }
});

test('with two bindings over the same record on different connections, a token from one is refused by the other\'s constructor although the labels are equal', async (t) => {
  const first = await admitted(t), second = await admitted(t);
  assert.equal(first.label, second.label);
  assert.notEqual(first.owner.currentLocal().connectionId, second.owner.currentLocal().connectionId);
  for (const [name, build] of Object.entries(CONSTRUCTORS)) {
    assert.throws(() => build(first.token, second.binding), { code: 'authority_unbound' }, name);
    assert.equal(build(second.token, second.binding).authority, second.label, name);
  }
});

test('isDemDeliveryContextAuthority accepts canonical TEST- and TP1- label strings, refuses tokens and malformed labels, and grants nothing', async (t) => {
  const { binding, label, token } = await admitted(t);
  assert.equal(contextModule.isDemDeliveryContextAuthority, client.isDemDeliveryContextAuthority, 'one predicate, the client\'s');
  for (const value of ['TEST-fixture', label]) assert.equal(contextModule.isDemDeliveryContextAuthority(value), true, value);
  for (const value of [token, 'TP1-short', 'TEST-', 'test-x', `${label} `, 3]) assert.equal(contextModule.isDemDeliveryContextAuthority(value), false, String(value));
  assert.throws(() => CONSTRUCTORS.createDemDeliveryContext(label, binding), { code: 'authority_unbound' }, 'an accepted label is still no authority');
});

test('guard off, each of the three token-bearing constructors throws kit_operation_guard_off with its own entry and registers no capability', () => {
  const url = (path) => JSON.stringify(pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href);
  // The child has no guard fixture loader, so the guard is off. The hold is held and the binding is a copy: the guard answers first.
  const probe = `const { api, nodeConnection, setPurchaseAdmission } = await import(${url('./helpers/seller-node-wallet-world.mjs')});
    setPurchaseAdmission('testnet-tp1');
    const connection = await nodeConnection(), token = await api.admitTp1Authority(connection.admission), copy = structuredClone(connection.admission.binding);
    setPurchaseAdmission('held');
    const { createDemDeliveryContext } = await import(${url('../src/dacs/dem-delivery-context-consumer.mjs')});
    const { createNativeDemDeliveryCapability } = await import(${url('../src/dacs/native-dem-delivery-consumer.mjs')});
    const { createDevnetDemoDeliveryCapability } = await import(${url('../src/devnet-demo/native-delivery.mjs')});
    const builds = {
      createDemDeliveryContext: () => createDemDeliveryContext({ authority: token, binding: copy, resolveBuyer: () => null, resolveSeller: () => null }),
      createNativeDemDeliveryCapability: () => createNativeDemDeliveryCapability({ authority: token, binding: copy, submitAuthorized: async () => ({}), reconcile: async () => ({}), read: async () => ({}), verifyReceipt: async () => 'valid' }),
      createDevnetDemoDeliveryCapability: () => createDevnetDemoDeliveryCapability({ authority: token, binding: copy, anchor: { authority: token.label, publish() {}, read() {}, readRetained() {}, verifyReceipt() {} } }),
    };
    const refused = {};
    for (const [name, build] of Object.entries(builds)) { try { refused[name] = build() ? 'built' : 'none'; } catch (error) { refused[name] = { name: error.name, code: error.code, entry: error.entry }; } }
    await connection.owner.close();
    console.log(JSON.stringify({ refused }));`;
  const nodeOptions = (process.env.NODE_OPTIONS ?? '').split(' ').filter((option) => option && !option.includes('kit-guard-fixture.mjs')).join(' ');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: nodeOptions } });
  assert.equal(child.status, 0, child.stderr);
  const { refused } = JSON.parse(child.stdout.trim().split('\n').at(-1));
  for (const entry of Object.keys(CONSTRUCTORS)) assert.deepEqual(refused[entry], { name: 'KitOperationGuardError', code: 'kit_operation_guard_off', entry }, entry);
});

test('the capability\'s public authority and the context result\'s authority are the label string, never the token', async (t) => {
  const { binding, label, token } = await admitted(t);
  for (const [name, build] of Object.entries(CONSTRUCTORS)) {
    const capability = build(token, binding);
    assert.equal(capability.authority, label, name);
    assert.equal(JSON.parse(JSON.stringify(capability)).authority, label, name);
  }
  const f = await protocolFixture(), input = structuredClone(f.input);
  // Each Vet reference is signed by its counterparty, as the default Vet mode requires.
  input.buyer.vetRecordRef = { ...input.buyer.vetRecordRef, signer: seller.claim };
  input.seller.vetRecordRef = { ...input.seller.vetRecordRef, signer: buyer.claim };
  const context = createDemDeliveryContext({ authority: token, binding, resolveBuyer: () => null, resolveSeller: () => ({ disposition: 'present', value: { input, vetRequirements: [] } }) });
  const result = await resolveDemDeliverySellerContext(context, { listing: f.listing, buyerBundle: f.buyerBundle, jobId: JOB, generatedAt: NOW });
  assert.deepEqual([result.disposition, result.authority], ['present', label]);
});

test('native delivery requires the artifact anchor\'s authority label to equal the token\'s label', async (t) => {
  const { binding, label, token } = await admitted(t);
  for (const anchorAuthority of [OTHER_DIGEST_LABEL, 'TEST-other', token, null]) {
    assert.throws(() => CONSTRUCTORS.createDevnetDemoDeliveryCapability(token, binding, anchorAuthority), /exact seller native artifact anchor/, String(anchorAuthority));
  }
  assert.equal(CONSTRUCTORS.createDevnetDemoDeliveryCapability(token, binding, label).authority, label);
});

// A Deliverable CREATE through the real artifact anchor under `label`. While `crashed`, the readback throws, as a process that dies
// after the wallet kept and broadcast the CREATE; `restart()` ends that and returns the same anchor state reopened.
async function deliveryWorld(label) {
  const w = await anchorFixture({ artifactKinds: ['Deliverable'], signRpc: async () => 'TEST rpc authentication' });
  const listing = fixtureListing(seller), listingRef = { listingId: listing.listingId, version: listing.listingVersion, contentHash: core.contentHash(listing) };
  const report = createDevnetPurchasedReportProducer({ producer: w.seller, produce: () => 'Bound purchased content' })({ agreement: { jobId: JOB, listingRef }, listing, settlementId: 'settlement-1' });
  const logicalAddress = `dacs4:deliverable:${JOB}`, receiptContentHash = core.contentHash(report);
  const deliveryBinding = { version: '1', profile: 'dacs-native-delivery-publication/v1', jobId: JOB, phase: 'deliver-storage-program', phaseIndex: 0, listing: listingRef,
    agreementHash: report.agreementHash, fulfilmentId: 'fulfilment-1', purchaseAmount: { currency: 'DEM', amount: '2.5' }, payloadHash: receiptContentHash };
  const world = { w, input: { jobId: JOB, logicalAddress, report, receiptContentHash, deliveryBinding }, crashed: false, included: new Set() };
  w.source.observeBinding = async () => {};
  w.source.binding = async ({ hash }) => { if (world.crashed) throw new Error('TEST process died before the readback'); return { disposition: world.included.has(hash) ? 'included' : 'pending' }; };
  w.source.recoverStorageWrite = async ({ signedTransaction }) => { world.included.add(signedTransaction.hash); };
  w.controls.reader.read = async () => ({ status: 'present', artifact: report, demosEvidence: {},
    receipt: { contentHash: receiptContentHash, transactionRef: { value: 'a'.repeat(64) }, blockRef: { timestamp: NOW }, writer: w.seller } });
  w.controls.reader.verifyReceipt = async () => 'valid';
  w.controls.request = async (request) => {
    const signedTransaction = await signSdkCreate(request.transaction), { hash } = signedTransaction;
    await w.journal.put('demo/wallet/lane', { stage: 'broadcast-accepted', hash, signedTransaction });
    await w.sourceJournal.put(`source/${hash}`, { stage: 'signed', hash, signedTransaction });
    world.included.add(hash);
    return { success: true, data: { hash } };
  };
  world.capability = (authority, binding) => createDevnetDemoDeliveryCapability({ authority, binding, anchor: { ...w.open(), authority: label } });
  return world;
}

test('the composite createDevnetDemoDeliveryCapability built with a TP-1 token and its binding forwards the binding, and its submit and reconcile run through the real anchor', async (t) => {
  const { binding, label, token } = await admitted(t);
  const world = await deliveryWorld(label);
  const capability = world.capability(token, binding);
  assert.equal(capability.authority, label);
  const submitted = await submitNativeDemDelivery(capability, world.input, () => true);
  assert.equal(submitted.status, 'accepted', JSON.stringify(submitted));
  assert.equal((await reconcileNativeDemDelivery(capability, world.input)).status, 'complete');
  assert.equal(world.w.captured.length, 1, 'signed once');
});

test('the composite delivery factory refuses a missing binding and another connection\'s binding, and never derives a binding from the token', async (t) => {
  const first = await admitted(t), second = await admitted(t);
  let anchorReads = 0;
  const anchor = new Proxy(passiveAnchor(first.label), { get(target, key) { if (key !== 'authority') anchorReads++; return target[key]; } });
  for (const binding of [undefined, second.binding]) {
    assert.throws(() => createDevnetDemoDeliveryCapability({ authority: first.token, binding, anchor }), { code: 'authority_unbound' });
  }
  assert.equal(anchorReads, 0, 'the inner constructor and the anchor\'s operations were not reached');
});

test('composite TP1 delivery submit loses answer then reopens and reconciles one retained report', async (t) => {
  const before = await admitted(t);
  const world = await deliveryWorld(before.label);
  world.crashed = true;
  await assert.rejects(submitNativeDemDelivery(world.capability(before.token, before.binding), world.input, () => true), /died before the readback/);
  world.crashed = false;
  // The restarted composition has a new connection, binding and token; the stored label is the same string.
  const after = await admitted(t);
  assert.equal(after.label, before.label);
  assert.throws(() => world.capability(before.token, after.binding), { code: 'authority_unbound' }, 'the old token is not the new composition\'s');
  const reopened = world.capability(after.token, after.binding);
  assert.equal((await reconcileNativeDemDelivery(reopened, world.input)).status, 'complete');
  assert.equal((await reconcileNativeDemDelivery(reopened, world.input)).status, 'complete');
  assert.equal(world.w.captured.length, 1, 'one retained report, never signed again');
});

test('with the guard on and purchase actions held, a token-bearing constructor throws profile_not_admitted and registers no capability', async (t) => {
  const { binding, label, token } = await admitted(t);
  setPurchaseAdmission('held');
  for (const [name, build] of Object.entries(CONSTRUCTORS)) assert.throws(() => build(token, binding, label), { code: 'profile_not_admitted' }, name);
  assert.equal(CONSTRUCTORS.createDemDeliveryContext('TEST-fixture').authority, 'TEST-fixture', 'a TEST- label is not held');
});

// The seller publications with the demo artifact publication's authority replaced.
const publicationsNaming = (authority) => {
  const publications = sellerPublications();
  return { ...publications, demoArtifactPublication: { ...publications.demoArtifactPublication, authority } };
};

test('a wallet-session port given its binding\'s TP1- label as a publication authority finalizes with a token admitted for that binding and keeps the label string on its anchor, and a label naming another record digest refuses authority_unbound at finalize with nothing signed or sent', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const label = api.tp1AuthorityLabel((await admitted(t)).binding);
  const own = await walletSessionWorld(t, { options: { publications: publicationsNaming(label) } });
  assert.equal(api.tp1AuthorityLabel(own.stages.binding), label);
  await own.finalize();
  assert.equal(own.port.artifactAnchor.authority, label);
  assert.equal(typeof own.port.artifactAnchor.authority, 'string');

  const other = await walletSessionWorld(t, { options: { publications: publicationsNaming(OTHER_DIGEST_LABEL) } });
  await assert.rejects(other.finalize(), (error) => [error.code, error.cause?.code].includes('authority_unbound'));
  assert.ok(other.returnedKeys.every(allZero), 'the loaded key bytes are zero-filled');
  assert.deepEqual({ signatures: signatures.length, effects: own.executeStages() + other.executeStages() }, { signatures: 0, effects: 0 });
});

test('with the kit guard on but purchase actions held, finalizing a port whose publication names its own TP1- label rejects profile_not_admitted in the wallet build, after key load and before signature or send; the loaded key bytes are zero-filled', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const label = api.tp1AuthorityLabel((await admitted(t)).binding);
  const world = await walletSessionWorld(t, { options: { publications: publicationsNaming(label) } });
  setPurchaseAdmission('held');
  const refusal = await world.finalize().then(() => null, (error) => error);
  const codes = [];
  for (let link = refusal; link instanceof Error; link = link.cause) codes.push(link.code);
  assert.ok(codes.includes('profile_not_admitted'), `refused by the hold: ${codes}`);
  assert.equal(world.keyLoads, 1, 'the key was loaded');
  assert.ok(world.returnedKeys.length === 1 && world.returnedKeys.every(allZero), 'the loaded key bytes are zero-filled');
  assert.deepEqual({ signatures: signatures.length, effects: world.executeStages() }, { signatures: 0, effects: 0 });
});
