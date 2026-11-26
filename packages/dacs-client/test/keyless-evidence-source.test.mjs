// The keyless evidence source: the read members the native payment evidence consumer takes from a settlement source
// capability, over the caller's transport owner and durable journal, with no key, no signer and no member that sends.
// A keyed session in the same world only pays, so there is a transfer to read back; a seller key made here signs the
// SettlementEvidence CREATE the scripted TEST node serves. No network, chain or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_SEPARATORS, canonicalize, contentHash, ed25519Sign, logicalToStorageProgramName, paymentEvidenceAddress, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey,
  sha256Hex, signComponentArtifact } from '@kynesyslabs/dacs';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { api, ok, world, setPurchaseAdmission, T0 } from './helpers/tp1-node-fixture.mjs';
import { createAuthorityFixture } from './fixtures/tp1-authority-reader.mjs';
import { runFreshChild } from './helpers/fresh-node-child.mjs';
import { readOnlyBoundary } from './helpers/read-only-boundary.mjs';
const { JOURNAL_METHODS } = await import('../src/wallet/keystore-wallet-opener.mjs');
const { buildNativeTransferPayload, deriveStorageAddress } = await import('../src/dacs/wallet-transactions.mjs');
const { createDevnetSettlementTransport, DEVNET_SETTLEMENT_POLICY, isDevnetDeliveryTransport } = await import('../src/wallet/devnet-native-transport.mjs');
const { approvedSourcePolicy } = await import('../src/wallet/approved-record-pins.mjs');
const { openKeylessInnerTransport } = await import('../src/wallet/keyless-inner-transport.mjs');
const { createNativePaymentEvidenceConsumer } = await import('../src/dacs/native-payment-evidence-consumer.mjs');
const { isDevnetAgreementTransport, isDevnetSettlementTransport, isDevnetDemoTransport } = api;

const CEILING = '50000000000';
const EVIDENCE_AUTHORITY = 'TEST-keyless-evidence-read';
const OWNER_MEMBERS = ['currentLocal', 'getContext', 'acquireConnectionFence', 'fetchImpl'];
const SOURCE_MEMBERS = ['chainReader', 'close', 'observeBinding', 'pins', 'readRpc', 'transportBinding'];
const READER_MEMBERS = ['observePassiveTransfer', 'observePurchaseTransfer', 'observeTransfer'];
const PIN_FIELDS = ['chainIdentity', 'endpoint', 'network', 'pinVersion', 'transportAuthority'];
const BINDING_FIELDS = ['bindingId', 'bindingVersion', 'settlementPublication', 'source', ...PIN_FIELDS].sort();
// Members of the inner settlement transport or of a keyed source that the evidence source must not carry.
const NOT_ON_SOURCE = ['rpc', 'walletBinding', 'binding', 'reserveRpcAuth', 'recoverStorageWrite', 'onStorageWriteResend', 'cancelNativeTransfer', 'withWalletNonceLock',
  'inspectWalletNonceLane', 'reopenWithheldBroadcast', 'onPurchaseStep', 'profile', 'journal', 'isWalletIdle', 'nativeTransferClaimed', 'nativeTransferCancelled',
  'nativeTransferRefused', 'nativeNonceConsumer', 'settlementPublication', 'key', 'signer', 'actionsAdmitted'];
const STOP_REFUSALS = [
  [() => true, 'writes_stopped'],
  [() => { throw new Error('TEST-stop-read-failed'); }, 'stop_check_failed'],
  [async () => false, 'stop_check_invalid'],
  [() => 'no', 'stop_check_invalid'],
];
const JSON_TYPE = { 'content-type': 'application/json' };
// The seller who signs the SettlementEvidence, and the paid Agreement it settles.
const SELLER_SEED = new Uint8Array(32).fill(17);
const SELLER_HEX = Buffer.from(rawPublicKey(publicKeyFromSeed(SELLER_SEED))).toString('hex');
const SELLER = 'did:demos:agent:' + SELLER_HEX, SELLER_ADDRESS = '0x' + SELLER_HEX;
const JOB = '01HZY3K8V9Q2W4E6R7T8Y9X0AB';
const AMOUNT_OS = '2500000000';
const BLOCK_SECONDS = Math.floor(T0 / 1000), INCLUDED_AT = BLOCK_SECONDS * 1000;
const PAYMENT_BLOCK = 1;
const CONTROL_PUBLICATION = Object.freeze({ policy: DEVNET_SETTLEMENT_POLICY, artifactKind: 'SettlementEvidence', phase: 'pay-dem', railId: 'demos-native:DEM', phaseIndex: 2,
  authority: 'TEST-control-settlement' });

const isCode = code => error => error.code === code;
const isTypeError = code => error => error instanceof TypeError && error.message === code;
const nodeCall = (message, data = {}) => ({ method: 'nodeCall', params: [{ message, data }] });
const outcome = promise => promise.then(value => ({ value }), error => ({ code: error.code ?? error.message }));
const refusal = promise => promise.then(() => null, error => ({ name: error.name, code: error.code ?? null, message: error.message }));
const settles = promise => Promise.race([promise.then(() => true, () => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
const executes = w => w.node.calls.filter(row => row.body?.method === 'execute').length;
const replyWith = response => new Response(JSON.stringify(ok(response)), { headers: JSON_TYPE });

// The owner's and journal's members, each logging its name before it runs, so a test can assert none was called.
function watched(w) {
  const calls = { owner: [], journal: [] };
  const spy = (target, names, log) => Object.fromEntries(names.map(name => [name, (...args) => { log.push(name); return target()[name](...args); }]));
  return { calls, owner: spy(() => w.owner, OWNER_MEMBERS, calls.owner), journal: spy(() => w.journal(), JOURNAL_METHODS, calls.journal) };
}

// The source takes no clock, so its transport reads the system clock; the keyed fixture session reads the same one.
async function sourceWorld(t, worldOptions = {}) {
  const w = await world(t, { ...worldOptions, sessionOptions: { clock: { now: () => Date.now() } } });
  const state = { stop: () => false };
  const options = (extra = {}) => ({ admission: w.admission, owner: w.owner, journal: w.journal(), stopped: () => state.stop(), feeCeilingOs: CEILING, ...extra });
  const open = async extra => {
    const { evidenceSourceCapability } = await api.createKeylessEvidenceSource(options(extra));
    t.after(() => evidenceSourceCapability.close());
    return evidenceSourceCapability;
  };
  const openPurchase = async extra => {
    const { sourceCapability } = await api.createKeylessPurchaseSource(options(extra));
    t.after(() => sourceCapability.close());
    return sourceCapability;
  };
  return { w, state, options, open, openPurchase };
}

// A seller-signed SettlementEvidence CREATE for the paid transfer `txHash`, as the seller's wallet would send it.
async function settlementCreate(pins, txHash) {
  const sellerKey = privateKeyFromSeed(SELLER_SEED);
  const artifact = await signComponentArtifact({ evidenceVersion: '1', jobId: JOB, phase: 'pay-dem', outcome: 'success', observedAt: INCLUDED_AT,
    paymentTxRefs: [{ kind: 'demos', txHash, blockNumber: PAYMENT_BLOCK }], paymentAmount: { amount: '2.5', currency: 'DEM' },
    settlementFinality: { model: 'bft-final', finalityObservedAt: INCLUDED_AT } }, ARTIFACT_SEPARATORS.SettlementEvidence,
  { algorithm: 'ed25519', signer: SELLER, sign: bytes => Buffer.from(ed25519Sign(bytes, sellerKey)) });
  const logicalAddress = paymentEvidenceAddress(JOB, 'demos-native:DEM', 2), programName = logicalToStorageProgramName(logicalAddress);
  const storageAddress = deriveStorageAddress(SELLER_ADDRESS, programName, 1, '');
  const operation = { operation: 'CREATE_STORAGE_PROGRAM', programName, storageAddress, salt: '', encoding: 'json', storageLocation: 'onchain', acl: { mode: 'public' }, data: artifact,
    metadata: { logicalAddress, contentHash: contentHash(artifact), envelopeHash: sha256Hex(canonicalize(artifact)), artifactKind: 'SettlementEvidence',
      networkBinding: { network: pins.network, chainIdentity: pins.chainIdentity, pinVersion: pins.pinVersion } } };
  const content = { type: 'storageProgram', from: SELLER_ADDRESS, from_ed25519_address: SELLER_ADDRESS, to: storageAddress, amount: 0, data: ['storageProgram', operation], nonce: 1,
    timestamp: T0, transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null }, network: pins.network, chainIdentity: pins.chainIdentity };
  const hash = sha256Hex(JSON.stringify(content));
  const signature = { type: 'ed25519', data: Buffer.from(ed25519Sign(new TextEncoder().encode(hash), sellerKey)).toString('hex') };
  return { create: { hash, content, signature }, programName, storageAddress };
}

// A world where the keyed wallet paid the seller and the node serves the seller's signed SettlementEvidence: the block
// carries a time and validation data, and the name index finds the evidence program.
async function paidWorld(t, worldOptions) {
  const opened = await sourceWorld(t, worldOptions);
  const { w } = opened;
  const buyer = w.session.wallet.getPublicAccount().address;
  let evidence;
  w.node.intercept = row => {
    const call = row.body?.params?.[0];
    if (call?.message === 'getBlockByNumber' && call.data.blockNumber >= PAYMENT_BLOCK) {
      return replyWith({ number: call.data.blockNumber, status: 'confirmed', hash: 'b'.repeat(64),
        content: { previousHash: 'a'.repeat(64), ordered_transactions: [...w.node.applied.keys()], timestamp: BLOCK_SECONDS }, validation_data: { signatures: ['TEST-validator'] } });
    }
    if (call?.message === 'searchStoragePrograms') return replyWith(call.data.query === evidence?.programName ? [{ storageAddress: evidence.storageAddress, programName: evidence.programName }] : []);
    return undefined;
  };
  const paid = await w.session.wallet.request({ method: 'sendTransaction',
    params: [buildNativeTransferPayload({ from: buyer, to: SELLER_ADDRESS, amountOs: AMOUNT_OS, nonce: 1, timestamp: T0, encoding: 'os-string' })] });
  assert.equal(paid.success, true, JSON.stringify(paid));
  const txHash = w.node.broadcasts[0].hash;
  evidence = await settlementCreate(w.session.transport.pins, txHash);
  w.node.applied.set(evidence.create.hash, structuredClone(evidence.create));
  const agreement = { jobId: JOB, parties: [{ role: 'buyer', primaryClaim: 'did:demos:agent:' + buyer.slice(2) }, { role: 'seller', primaryClaim: SELLER }],
    listingRef: { listingId: 'TEST-listing', version: 1, contentHash: 'c'.repeat(64) },
    terms: { price: { currency: 'DEM', amount: '2.5' }, rail: { railId: 'demos-native:DEM', railVersion: 1 },
      payoutBindings: [{ payeeAddress: SELLER_ADDRESS, phaseIndex: 2, railId: 'demos-native:DEM' }], deadline: INCLUDED_AT + 60_000 } };
  const request = { agreement, writer: SELLER, txHash, blockNumber: PAYMENT_BLOCK, committedAt: INCLUDED_AT - 1000, signedProjection: structuredClone(evidence.create) };
  const transfer = { status: 'included', txHash, blockNumber: PAYMENT_BLOCK, payer: buyer.slice(2), payee: SELLER_HEX, amountOs: AMOUNT_OS, includedAt: INCLUDED_AT };
  return { ...opened, txHash, request, transfer };
}

// The consumer the buyer builds over a settlement source; its clock is fixed so two reads give equal receipts.
const evidenceConsumer = capability => createNativePaymentEvidenceConsumer({ rpcUrl: capability.pins.endpoint, sourceCapability: capability, now: () => T0 });

// The read members of `source`, each called once with arguments it accepts.
const nodeReads = (source, hash) => [
  ['readRpc', () => source.readRpc('/', nodeCall('getNetworkInfo'))],
  ['observeBinding', () => source.observeBinding()],
  ...READER_MEMBERS.map(name => [name, () => source.chainReader()[name](hash)]),
];

// Option sets both keyless factories refuse, each with the code it gets. `watch` supplies spied owner and journal members.
function refusedOptionSets(w, options, watch) {
  const watchedOptions = (extra = {}) => ({ ...options(), owner: watch.owner, journal: watch.journal, ...extra });
  const without = (name, extra = {}) => () => { const set = watchedOptions(extra); delete set[name]; return set; };
  const extras = { key: new Uint8Array(32), mnemonic: 'TEST words', phrase: 'TEST words', keystore: 'TEST-keystore', signer: () => {}, signRpc: () => {}, fetchImpl: () => {},
    expected: {}, boundary: {}, settlementPublication: CONTROL_PUBLICATION, authority: EVIDENCE_AUTHORITY, transportOwner: watch.owner, walletAddress: '0x' + '7'.repeat(64),
    signingHandle: {}, secondOwner: watch.owner };
  const otherLocal = { ...w.owner.currentLocal(), endpoint: 'https://other.example.invalid/' };
  return [
    ...Object.entries(extras).map(([name, value]) => [`extra ${name}`, () => watchedOptions({ [name]: value }), 'keyless_relay_options_invalid']),
    ...['owner', 'journal', 'stopped', 'feeCeilingOs'].map(name => [`without ${name}`, without(name), 'keyless_relay_options_invalid']),
    ...OWNER_MEMBERS.map(name => [`owner without ${name}`, () => watchedOptions({ owner: { ...watch.owner, [name]: undefined } }), 'keyless_relay_owner_invalid']),
    ...JOURNAL_METHODS.map(name => [`journal without ${name}`, () => watchedOptions({ journal: { ...watch.journal, [name]: undefined } }), 'keyless_relay_journal_invalid']),
    ...[50000000000, '0', '01', '-1', '1.5', ''].map(value => [`fee ceiling ${JSON.stringify(value)}`, () => watchedOptions({ feeCeilingOs: value }), 'keyless_relay_fee_ceiling_invalid']),
    ...[false, 'no', null].map(value => [`stopped ${JSON.stringify(value)}`, () => watchedOptions({ stopped: value }), 'keyless_relay_stop_invalid']),
    ['without admission', without('admission'), 'admission_required'],
    ['without admission, with a key', without('admission', { key: new Uint8Array(32) }), 'admission_required'],
    ['without admission or owner', () => { const set = without('admission')(); delete set.owner; return set; }, 'admission_required'],
    ['no options', () => undefined, 'admission_required'],
    ['without fee ceiling, with a bad stop', without('feeCeilingOs', { stopped: 'no' }), 'keyless_relay_options_invalid'],
    ['bad fee ceiling and bad stop', () => watchedOptions({ feeCeilingOs: '0', stopped: false }), 'keyless_relay_fee_ceiling_invalid'],
    ['bad stop and bad owner', () => watchedOptions({ stopped: false, owner: {} }), 'keyless_relay_stop_invalid'],
    ['bad owner and bad journal', () => watchedOptions({ owner: {}, journal: {} }), 'keyless_relay_owner_invalid'],
    ['binding for another endpoint', async () => watchedOptions({ admission: { binding: await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: otherLocal,
      readAuthority: createAuthorityFixture().read }), currentLocal: w.owner.currentLocal } }), 'profile_not_admitted'],
    ['binding of another record', () => watchedOptions({ admission: { binding: { ...w.admission.binding, recordDigest: '0'.repeat(64) }, currentLocal: w.owner.currentLocal } }),
      'profile_not_admitted'],
    ['connection changed', () => watchedOptions({ admission: { binding: w.admission.binding, currentLocal: () => otherLocal } }), 'tp1_local_binding_changed'],
  ];
}

test('a keyless evidence source refuses key-like, extra and missing options before any owner, journal or node call', async t => {
  const { w, options } = await sourceWorld(t);
  const watch = watched(w), before = w.node.calls.length;
  const sets = refusedOptionSets(w, options, watch).filter(([, , code]) => !['keyless_relay_fee_ceiling_invalid', 'profile_not_admitted', 'tp1_local_binding_changed'].includes(code));
  for (const [label, set, code] of sets) await assert.rejects(api.createKeylessEvidenceSource(await set()), isTypeError(code), label);
  assert.deepEqual(watch.calls, { owner: [], journal: [] }, 'no owner or journal member was called');
  assert.equal(w.node.calls.length, before, 'no node request was sent');
});

test('a keyless evidence source refuses a missing or malformed fee ceiling and builds nothing', async t => {
  const { w, options } = await sourceWorld(t);
  const watch = watched(w), before = w.node.calls.length;
  const construct = extra => api.createKeylessEvidenceSource({ ...options(), owner: watch.owner, journal: watch.journal, ...extra });
  for (const feeCeilingOs of [50000000000, '0', '01', '-1', '1.5', '']) await assert.rejects(construct({ feeCeilingOs }), isTypeError('keyless_relay_fee_ceiling_invalid'), String(feeCeilingOs));
  const withoutCeiling = { ...options(), owner: watch.owner, journal: watch.journal };
  delete withoutCeiling.feeCeilingOs;
  await assert.rejects(api.createKeylessEvidenceSource(withoutCeiling), isTypeError('keyless_relay_options_invalid'), 'the key check runs first');
  assert.deepEqual(watch.calls, { owner: [], journal: [] });
  assert.equal(w.node.calls.length, before);
  const { evidenceSourceCapability } = await api.createKeylessEvidenceSource(options({ feeCeilingOs: '1' }));
  t.after(() => evidenceSourceCapability.close());
  assert.equal(isDevnetSettlementTransport(evidenceSourceCapability), true, 'the smallest valid ceiling builds');
});

test('a keyless evidence source is not built over a refused or changed binding', async t => {
  const { w, options } = await sourceWorld(t);
  const watch = watched(w), before = w.node.calls.length;
  const sets = refusedOptionSets(w, options, watch).filter(([, , code]) => ['profile_not_admitted', 'tp1_local_binding_changed'].includes(code));
  assert.equal(sets.length, 3);
  for (const [label, set, code] of sets) await assert.rejects(api.createKeylessEvidenceSource(await set()), isCode(code), label);
  await assert.rejects(api.createKeylessEvidenceSource(await sets[0][1]()), error => error.code === 'profile_not_admitted' && error.cause !== undefined, 'the binding check keeps its cause');
  assert.deepEqual(watch.calls.journal, [], 'no journal read');
  assert.deepEqual(watch.calls.owner.filter(name => name !== 'currentLocal'), [], 'only the connection the binding check compares was read');
  assert.equal(w.node.calls.length, before, 'no node read');
});

test('a keyless evidence source and a keyless purchase source refuse the same option sets with the same codes in the same order', async t => {
  const { w, options } = await sourceWorld(t);
  const watch = watched(w);
  for (const [label, set, code] of refusedOptionSets(w, options, watch)) {
    const evidence = await refusal(api.createKeylessEvidenceSource(await set()));
    const purchase = await refusal(api.createKeylessPurchaseSource(await set()));
    assert.equal(evidence?.code ?? evidence?.message, code, label);
    assert.deepEqual(evidence, purchase, label);
  }
});

test('a keyless evidence source has exactly the read members and none that sends, recovers or signs', async t => {
  const { options } = await sourceWorld(t);
  const built = await api.createKeylessEvidenceSource(options());
  const source = built.evidenceSourceCapability;
  t.after(() => source.close());
  assert.deepEqual(Object.keys(built), ['evidenceSourceCapability']);
  assert.equal(Object.isFrozen(built), true);
  assert.equal(Object.isFrozen(source), true);
  assert.deepEqual(Object.keys(source).sort(), SOURCE_MEMBERS);
  assert.deepEqual(Reflect.ownKeys(source).filter(key => typeof key === 'symbol'), []);
  for (const name of NOT_ON_SOURCE) assert.equal(name in source, false, name);
  const reader = source.chainReader();
  assert.equal(Object.isFrozen(reader), true);
  assert.deepEqual(Reflect.ownKeys(reader).sort(), READER_MEMBERS);
  for (const name of ['readStorageProgram', 'getAddressNonce', 'getAddressBalance', 'getTransactionFees', 'getTransaction', 'findTransferAtNonce', 'getIdentities']) {
    assert.equal(name in reader, false, name);
  }
  assert.deepEqual(Object.keys(source.pins).sort(), PIN_FIELDS);
  assert.deepEqual(Object.keys(source.transportBinding).sort(), BINDING_FIELDS);
  assert.equal(Object.isFrozen(source.pins), true);
  assert.equal(Object.isFrozen(source.transportBinding), true);
});

test('a keyless evidence source holds no key and constructing one loads no demosdk', async t => {
  const child = runFreshChild(t, `
    import { writeFileSync } from 'node:fs'; import { registerHooks } from 'node:module';
    let demosdkImports = 0;
    registerHooks({ resolve(specifier, context, next) { if (/demosdk|demos-loader|demos-quiet-hooks|node-demos-loading|sdk-provider|node-wallet-session/.test(specifier)) demosdkImports++; return next(specifier, context); } });
    const { createKeylessEvidenceSource } = await import(process.argv[2]);
    const { bindFixture } = await import(process.argv[3]);
    const { binding, currentLocal } = await bindFixture();
    const refuse = () => { throw new Error('TEST-not-called'); };
    const owner = { currentLocal, getContext: refuse, acquireConnectionFence: refuse, fetchImpl: refuse };
    const journal = Object.fromEntries(['get', 'put', 'entries', 'withWalletLock', 'appendUnderLock', 'withOwnedOrAcquiredLane'].map(name => [name, refuse]));
    const built = await createKeylessEvidenceSource({ admission: { binding, currentLocal }, owner, journal, stopped: () => false, feeCeilingOs: '1' });
    const source = built.evidenceSourceCapability;
    const reader = source.chainReader();
    const names = [...Reflect.ownKeys(built), ...Reflect.ownKeys(source), ...Reflect.ownKeys(reader)].map(String);
    const result = { demosdkImports, keys: Object.keys(source).sort(), names };
    await source.close();
    writeFileSync('result.json', JSON.stringify(result));
  `, [new URL('../src/wallet/keyless-evidence-source.mjs', import.meta.url).href, new URL('./fixtures/tp1-authority-reader.mjs', import.meta.url).href]);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.result.demosdkImports, 0);
  assert.deepEqual(child.result.keys, SOURCE_MEMBERS);
  for (const name of child.result.names) assert.doesNotMatch(name, /sign|key|phrase|mnemonic|secret|seed/i, name);
});

test('a keyless evidence source is registered as a settlement transport and a keyless purchase source stays an Agreement transport', async t => {
  const { open, openPurchase } = await sourceWorld(t);
  const source = await open(), purchase = await openPurchase();
  assert.equal(isDevnetAgreementTransport(source), true);
  assert.equal(isDevnetSettlementTransport(source), true);
  for (const isOther of [isDevnetDeliveryTransport, isDevnetDemoTransport]) assert.equal(isOther(source), false);
  assert.equal(isDevnetAgreementTransport(purchase), true);
  assert.equal(isDevnetSettlementTransport(purchase), false);
});

test('the shared keyless builder gives the fee-only and no-repeat-confirm options to the Agreement constructor only', async t => {
  const { w, options } = await sourceWorld(t);
  const recorded = [];
  const recorder = argument => { recorded.push(argument); return createDevnetSettlementTransport(argument); };
  // The builder's own keys win over the constructor options it is given.
  const innerOptions = { settlementPublication: CONTROL_PUBLICATION, journal: 'TEST-overridden' };
  const { inner } = await openKeylessInnerTransport(options(), { construct: recorder, innerOptions });
  t.after(() => inner.close());
  assert.equal(recorded.length, 1);
  const [argument] = recorded;
  for (const name of ['networkFeeCeilingOnly', 'noRepeatUnknownConfirm']) assert.equal(Object.hasOwn(argument, name), false, name);
  assert.deepEqual(Object.keys(argument).sort(), ['boundary', 'expected', 'fetchImpl', 'journal', 'settlementPublication', 'transportOwner', ...Object.keys(approvedSourcePolicy())].sort());
  assert.equal(argument.transportOwner, w.owner);
  assert.equal(argument.journal, w.journal());
  assert.equal(argument.settlementPublication, CONTROL_PUBLICATION);
  assert.equal(isDevnetSettlementTransport(inner), true);
  await assert.rejects(openKeylessInnerTransport(options({ feeCeilingOs: '0' }), { construct: recorder, innerOptions }), isTypeError('keyless_relay_fee_ceiling_invalid'));
  assert.equal(recorded.length, 1, 'the ceiling is refused before the constructor runs');
});

test('the native payment evidence consumer accepts a keyless evidence source and refuses a keyless purchase source', async t => {
  const { open, openPurchase } = await sourceWorld(t);
  const source = await open(), purchase = await openPurchase();
  const consumer = createNativePaymentEvidenceConsumer({ rpcUrl: source.pins.endpoint, sourceCapability: source });
  assert.equal(consumer.rpcOrigin, new URL(source.pins.endpoint).origin);
  assert.throws(() => createNativePaymentEvidenceConsumer({ rpcUrl: purchase.pins.endpoint, sourceCapability: purchase }), TypeError);
  const oneCharacterOff = source.pins.endpoint.replace('example', 'exbmple');
  assert.notEqual(oneCharacterOff, source.pins.endpoint);
  assert.throws(() => createNativePaymentEvidenceConsumer({ rpcUrl: oneCharacterOff, sourceCapability: source }), TypeError);
});

test('a keyless evidence source answers the payment evidence read as the keyed settlement transport does', async t => {
  const paid = await paidWorld(t);
  const { w } = paid;
  const source = await paid.open();
  const control = createDevnetSettlementTransport({ expected: source.pins, transportOwner: w.owner, journal: w.journal(), fetchImpl: (input, init) => w.owner.fetchImpl(input, init),
    boundary: readOnlyBoundary, ...approvedSourcePolicy(), settlementPublication: CONTROL_PUBLICATION });
  t.after(() => control.close());
  const sent = executes(w);
  const answers = [];
  for (const capability of [source, control]) {
    const consumer = evidenceConsumer(capability);
    const answer = await consumer.readEvidence(paid.request);
    assert.equal(answer.disposition, 'present', JSON.stringify(answer));
    assert.deepEqual(Object.keys(answer).sort(), ['artifact', 'disposition', 'evidenceMode', 'receipt', 'ref', 'signedProjection']);
    answers.push(answer);
    const observed = await consumer.observeDemosTransfer(paid.txHash);
    for (const [name, value] of Object.entries(paid.transfer)) assert.equal(observed[name], value, name);
  }
  assert.deepEqual(answers[0], answers[1]);
  assert.equal(executes(w), sent, 'the node saw read requests only');
});

test('a keyless evidence source rebuilt over the reopened journal answers the same paid evidence without a send', async t => {
  const paid = await paidWorld(t);
  const { w, options } = paid;
  const sent = executes(w);
  const first = (await api.createKeylessEvidenceSource(options())).evidenceSourceCapability;
  const before = await evidenceConsumer(first).readEvidence(paid.request);
  assert.equal(before.disposition, 'present', JSON.stringify(before));
  await first.close();
  const restarted = await w.restart();
  const { evidenceSourceCapability: source } = await api.createKeylessEvidenceSource(options({ owner: restarted.owner, admission: restarted.admission, journal: w.journal() }));
  t.after(() => source.close());
  const consumer = evidenceConsumer(source);
  assert.deepEqual(await consumer.readEvidence(paid.request), before);
  const observed = await consumer.observeDemosTransfer(paid.txHash);
  for (const [name, value] of Object.entries(paid.transfer)) assert.equal(observed[name], value, name);
  assert.equal(executes(w), sent, 'no execute request across both sessions');
});

test('a keyless evidence source declares the same pins and binding id as a keyless purchase source over the same owner and journal', async t => {
  const { open, openPurchase } = await sourceWorld(t);
  const source = await open(), purchase = await openPurchase();
  assert.deepEqual(source.pins, purchase.pins);
  assert.equal(source.transportBinding.bindingId, purchase.transportBinding.bindingId);
  assert.equal(source.transportBinding.settlementPublication.authority, EVIDENCE_AUTHORITY);
  assert.deepEqual(source.transportBinding.settlementPublication, { ...CONTROL_PUBLICATION, authority: EVIDENCE_AUTHORITY });
  assert.equal(Object.hasOwn(purchase.transportBinding, 'settlementPublication'), false);
  const info = nodeCall('getNetworkInfo');
  const [fromSource, fromPurchase, boundSource, boundPurchase] = await Promise.all([source.readRpc('/', info), purchase.readRpc('/', info), source.observeBinding(), purchase.observeBinding()]);
  assert.deepEqual(fromSource, fromPurchase);
  assert.equal(boundSource.chainIdentity, boundPurchase.chainIdentity);
});

test('a keyless evidence source refuses node reads while the stop answers true, throws or answers something else than a boolean', async t => {
  const paid = await paidWorld(t);
  const { w, state } = paid;
  const watch = watched(w);
  const source = await paid.open({ owner: watch.owner, journal: watch.journal });
  assert.deepEqual(Reflect.ownKeys(source.chainReader()).sort(), READER_MEMBERS);
  for (const [stop, code] of STOP_REFUSALS) {
    watch.calls.owner.length = 0;
    watch.calls.journal.length = 0;
    const before = w.node.calls.length;
    state.stop = stop;
    for (const [name, read] of nodeReads(source, paid.txHash)) {
      await assert.rejects(read(), error => error.code === code && (code !== 'stop_check_failed' || error.cause?.message === 'TEST-stop-read-failed'), `${code}: ${name}`);
    }
    assert.equal(w.node.calls.length, before, `${code}: no node request`);
    assert.deepEqual(watch.calls, { owner: [], journal: [] }, `${code}: no owner or journal call`);
    assert.deepEqual(Object.keys(source.pins).sort(), PIN_FIELDS, `${code}: pins still read`);
    assert.equal(source.transportBinding.settlementPublication.authority, EVIDENCE_AUTHORITY, `${code}: the declaration still reads`);
    assert.deepEqual(Object.keys(source.chainReader()).sort(), READER_MEMBERS, `${code}: chainReader() still answers`);
    state.stop = () => false;
  }
  const asyncStop = await paid.open({ stopped: async () => false });
  await assert.rejects(asyncStop.readRpc('/', nodeCall('getNetworkInfo')), isCode('stop_check_invalid'), 'an async stop is accepted at construction and refused at use');
  // Control: with the stop answering false, the same reads answer.
  assert.equal((await source.readRpc('/', nodeCall('getNetworkInfo'))).result, 200);
  assert.equal((await source.observeBinding()).chainIdentity, source.pins.chainIdentity);
  for (const name of READER_MEMBERS) assert.equal((await source.chainReader()[name](paid.txHash)).status, 'included', name);
  state.stop = () => true;
  await source.close();
  await assert.rejects(source.readRpc('/', nodeCall('getNetworkInfo')), isCode('writes_stopped'), 'stopped and closed: the stop answers first');
});

test('a stop that refuses an evidence read leaves the payment evidence answer undecided, never rejected', async t => {
  const paid = await paidWorld(t);
  const source = await paid.open();
  const consumer = evidenceConsumer(source);
  paid.state.stop = () => true;
  const stopped = await consumer.readEvidence(paid.request);
  assert.equal(stopped.disposition, 'indeterminate', JSON.stringify(stopped));
  assert.notEqual(stopped.authenticated, true);
  await assert.rejects(consumer.observeDemosTransfer(paid.txHash), isCode('writes_stopped'));
  paid.state.stop = () => false;
  assert.equal((await consumer.readEvidence(paid.request)).disposition, 'present');
});

test('a stop that turns true during a pending read lets that read finish and refuses the next one', async t => {
  const { w, state, open } = await sourceWorld(t);
  const source = await open();
  let release, reached;
  const entered = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
  w.node.intercept = async row => { if (row.body?.params?.[0]?.message === 'getNetworkInfo') { w.node.intercept = null; reached(); await held; } };
  const reading = source.readRpc('/', nodeCall('getNetworkInfo'));
  await entered;
  state.stop = () => true;
  release();
  assert.equal((await reading).result, 200, 'the pending read finishes');
  await assert.rejects(source.readRpc('/', nodeCall('getNetworkInfo')), isCode('writes_stopped'));
});

test('a closed keyless evidence source refuses reads, keeps its data members, and leaves the journal and owner open', async t => {
  const { w, open, openPurchase } = await sourceWorld(t);
  const source = await open();
  let release, reached;
  const entered = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
  w.node.intercept = async row => { if (row.body?.params?.[0]?.message === 'getNetworkInfo') { w.node.intercept = null; reached(); await held; } };
  const reading = outcome(source.readRpc('/', nodeCall('getNetworkInfo')));
  await entered;
  const closing = source.close();
  assert.equal(await settles(closing), false, 'close waits for the read in flight');
  release();
  await closing;
  assert.equal((await reading).value?.result, 200);
  // The chain reader turns a failed read into an observation, so its two transfer reads answer unavailable instead of rejecting.
  const before = w.node.calls.length;
  for (const [name, read] of nodeReads(source, 'a'.repeat(64))) {
    const answer = await outcome(read());
    if (['observeTransfer', 'observePurchaseTransfer'].includes(name)) assert.equal(answer.value?.status, 'unavailable', name);
    else assert.equal(answer.code, 'transport_closed', name);
  }
  assert.equal(w.node.calls.length, before, 'no read reached the node after close');
  await source.close();
  assert.deepEqual(Object.keys(source.pins).sort(), PIN_FIELDS);
  assert.deepEqual(Object.keys(source.transportBinding).sort(), BINDING_FIELDS);
  await w.journal().put('TEST-after-close', { kept: true });
  assert.deepEqual(await w.journal().get('TEST-after-close'), { kept: true });
  assert.deepEqual(w.owner.currentLocal(), w.admission.currentLocal());
  const sibling = await openPurchase();
  assert.equal((await sibling.readRpc('/', nodeCall('getNetworkInfo'))).result, 200, 'a purchase source over them still reads');
});

test('a keyless evidence source keeps reading while purchase actions are held', async t => {
  const paid = await paidWorld(t);
  const source = await paid.open();
  setPurchaseAdmission('held');
  const answers = await Promise.all(nodeReads(source, paid.txHash).map(([, read]) => outcome(read())));
  for (const answer of answers) assert.equal(answer.code, undefined, JSON.stringify(answer));
  assert.equal(answers[0].value.result, 200);
  assert.equal(answers[1].value.chainIdentity, source.pins.chainIdentity);
  for (const answer of answers.slice(2)) assert.equal(answer.value.status, 'included');
});

test('a keyless evidence source has no member that can confirm or broadcast, so no fee ceiling is crossed', async t => {
  const { w, open, options } = await sourceWorld(t);
  const sent = await w.send();
  assert.equal(sent.success, true, JSON.stringify(sent));
  const bodies = w.node.calls.filter(row => row.body?.method === 'execute').map(row => row.body);
  assert.deepEqual(bodies.map(body => body.params[0].extra), ['confirmTx', 'broadcastTx']);
  const source = await open({ feeCeilingOs: '1' }), before = executes(w);
  for (const body of bodies) await assert.rejects(source.readRpc('/', body), isCode('readonly_only'), body.params[0].extra);
  const members = [...Object.entries(source), ...Object.entries(source.chainReader())].filter(([name, member]) => typeof member === 'function' && name !== 'close');
  for (const [, member] of members) {
    for (const body of bodies) {
      for (const args of [[body], ['/', body], [w.node.broadcasts[0].hash, body]]) {
        try { await member(...args); } catch { /* every refusal is fine; the node must see no send */ }
      }
    }
  }
  assert.equal(executes(w), before, 'no member sent a confirm or broadcast');
  const { nativeTransport } = await api.createKeylessSignedRelayTransport(options({ feeCeilingOs: '1' }));
  t.after(() => nativeTransport.close());
  assert.equal(isDevnetAgreementTransport(nativeTransport), true, 'the same five options build the signed relay');
});
