// Public ESM boundary. Also runnable from an empty packed-package consumer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { installPackedPair } from './helpers/packed-install.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
function declaresPublicContract(source, line) {
  const preceding = source.slice(0, source.indexOf(line)).trimEnd();
  const comment = /\/\*\*(?:(?!\*\/)[\s\S])*\*\/$/.exec(preceding)?.[0];
  return !!comment && /\b(?:returns?|constant|Error)\b/i.test(comment);
}
test('every public export declares its input, result and refusal or side effects', () => {
  const source = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const exports = source.split('\n').filter(line => line.startsWith('export '));
  assert.ok(exports.length > 0);
  for (const line of exports) assert.ok(declaresPublicContract(source, line), line);
});
test('an earlier export contract cannot document a later placeholder', () => {
  const source = '/** returns a first value */\nexport const first = 1;\n/** placeholder */\nexport const second = 2;';
  assert.equal(declaresPublicContract(source, 'export const second = 2;'), false);
});
test('factory documentation names returned methods and the journal contract', () => {
  const source = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.match(source, /observe\/sweep\/start\/stop\/setDeliveryCheck/);
  assert.match(source, /search\/findSummary\/getListingDetail/);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /openDurableWalletJournal\(\{ path, mode/);
  assert.match(readme, /DurableWalletJournalError/);
  assert.match(readme, /journal-absent/);
});

const ROOT = {
  functions: ['createSqlitePurchaseStore', 'createPurchaseService', 'purchaseNext', 'networkIdentityLabel', 'createProtocolPurchases', 'protocolView', 'usesAgreementContext',
    'usesNativeDemDelivery', 'createDeliveryDeadlineWatch', 'createCoordinateStore', 'createDirectoryClient', 'createListingVerifier',
    'deliveryEvidenceAddress', 'sellerFailureCause', 'usesNativePaymentEvidence', 'isOperatorContextAuthority',
    'demDeliveryContextUsage', 'isDemDeliveryContextAuthority',
    'rpcAuthRefusal', 'transferRefusal', 'sellerSessionTransitionState', 'createPurchaseReadbackCache',
    'canonicalize', 'contentHash', 'normalizeDemAmount', 'logicalListingAddress', 'verifyComponent', 'buildUnsignedIdentityBundle', 'normalizeDemosAddress', 'fundingHelpSentence',
    'createDemDeliveryContext', 'createDemDeliveryContextRouteCaller', 'createNativeDemDeliveryCapability', 'createNativePaymentEvidenceConsumer', 'createSourceDemoSellerTransport', 'createSellerSessionKeys',
    'createDevnetNativeCommitmentCapability', 'isOfflineWalletAgreement', 'deriveStorageAddress', 'createDemosNetworkBinder', 'assertNodeRpcEndpoint', 'createAuthorityReader', 'createPublicSellerClient',
    'createPurchaseOperations', 'isPurchaseOperationId', 'createPurchaseChallenges', 'purchaseApprovalChallengeText', 'createLocalPurchaseAccount'],
  classes: ['NotConfiguredError', 'OutboundError', 'OperationError', 'NotWiredError', 'StaleProtocolCheck',
    'SellerRefusedError', 'SellerUnavailableError', 'SellerTlsUnusableError', 'DemosSr2BridgeError', 'DemosSr2Error', 'NetworkBindingError', 'BuyerChainReadbackUnsupported', 'WalletFormatError'],
  values: ['PURCHASE_STATE_SCHEMA', 'PURCHASE_STATUS_HELP', 'DEM_DECIMAL', 'OS_INTEGER', 'vetNotPerformedRef', 'AGREEMENT_CONTEXT_SOURCE', 'DEM_DELIVERY_CONTEXT_SOURCE',
    'SR2_WALLET_KIND', 'DEVNET_AGREEMENT_KIND', 'DEVNET_AGREEMENT_PROFILE', 'DEVNET_NATIVE_BINDING_PATH', 'DEVNET_NATIVE_RPC_PATH', 'SDK_PROVENANCE',
    'OFFLINE_AGREEMENT_MODE', 'DEVNET_NATIVE_COMMITMENT_MARKER', 'PAID_WRITE_FEE_CEILING_OS'],
};
const GUIDANCE_NAMES = ['purchaseNext', 'PURCHASE_STATUS_HELP', 'protocolView'];
const modules = {
  "purchase-state-schema.mjs": "PURCHASE_STATE_SCHEMA",
  "seams/purchase-store-not-wired.mjs": "createSqlitePurchaseStore",
  "purchases.mjs": "createPurchaseService purchaseNext PURCHASE_STATUS_HELP networkIdentityLabel",
  "dacs/protocol-purchases.mjs": "createProtocolPurchases protocolView usesAgreementContext usesNativeDemDelivery StaleProtocolCheck OFFLINE_AGREEMENT_MODE isOfflineWalletAgreement",
  "dacs/delivery-deadline-watch.mjs": "createDeliveryDeadlineWatch",
  "dacs/wallet-transactions.mjs": "createCoordinateStore deriveStorageAddress",
  "dacs/directory.mjs": "createDirectoryClient",
  "public-verification.mjs": "createListingVerifier NotConfiguredError",
  "dacs/chain.mjs": "DEM_DECIMAL OS_INTEGER",
  "dacs/purchase-protocol.mjs": "deliveryEvidenceAddress vetNotPerformedRef",
  "dacs/seller-http.mjs": "sellerFailureCause SellerRefusedError SellerUnavailableError SellerTlsUnusableError createPublicSellerClient",
  "dacs/native-payment-evidence-consumer.mjs": "usesNativePaymentEvidence createNativePaymentEvidenceConsumer",
  "dacs/agreement-context-consumer.mjs": "AGREEMENT_CONTEXT_SOURCE isOperatorContextAuthority",
  "dacs/dem-delivery-context-consumer.mjs": "DEM_DELIVERY_CONTEXT_SOURCE demDeliveryContextUsage isDemDeliveryContextAuthority createDemDeliveryContext createDemDeliveryContextRouteCaller",
  "dacs/native-dem-delivery-consumer.mjs": "createNativeDemDeliveryCapability",
  "dacs/source-demo-seller-transport.mjs": "createSourceDemoSellerTransport",
  "dacs/seller-session-keys.mjs": "createSellerSessionKeys",
  "devnet-demo/commitment-consumer.mjs": "createDevnetNativeCommitmentCapability DEVNET_NATIVE_COMMITMENT_MARKER",
  "dacs/demos-sr2-wallet-bridge.mjs": "SR2_WALLET_KIND DemosSr2BridgeError",
  "wallet/devnet-native-transport.mjs": "rpcAuthRefusal transferRefusal DEVNET_AGREEMENT_KIND DEVNET_AGREEMENT_PROFILE DEVNET_NATIVE_BINDING_PATH DEVNET_NATIVE_RPC_PATH",
  "dacs/seller-session-lifecycle.mjs": "sellerSessionTransitionState",
  "util/purchase-readback-cache.mjs": "createPurchaseReadbackCache",
  "util/http.mjs": "OutboundError",
  "dacs/listing.mjs": "canonicalize contentHash normalizeDemAmount SDK_PROVENANCE logicalListingAddress verifyComponent buildUnsignedIdentityBundle",
  "dacs/demos-sr2-adapter.mjs": "DemosSr2Error",
  "dacs/network-binding.mjs": "NetworkBindingError createDemosNetworkBinder assertNodeRpcEndpoint",
  "wallet/authority-reader.mjs": "createAuthorityReader",
  "dacs/buyer-chain-readback.mjs": "BuyerChainReadbackUnsupported",
  "client-errors.mjs": "OperationError NotWiredError",
  "signatures.mjs": "WalletFormatError normalizeDemosAddress",
  "buyer-funding.mjs": "fundingHelpSentence",
  "host/purchase-ops.mjs": "createPurchaseOperations",
  "util/ids.mjs": "isPurchaseOperationId",
  "host/purchase-challenges.mjs": "createPurchaseChallenges purchaseApprovalChallengeText",
  "host/local-account.mjs": "createLocalPurchaseAccount",
  "index.mjs": "PAID_WRITE_FEE_CEILING_OS"
};

for (const name of [...ROOT.functions, ...ROOT.classes, ...ROOT.values]) {
  test(`root export: ${name}`, async () => {
    const client = await import('@kynesyslabs/dacs-client');
    assert.notEqual(client[name], undefined, name);
    if (ROOT.functions.includes(name) || ROOT.classes.includes(name)) assert.equal(typeof client[name], 'function');
    const module = Object.keys(modules).find(path => modules[path].split(' ').includes(name));
    const original = await import(new URL(module, import.meta.resolve('@kynesyslabs/dacs-client')));
    if (name === 'createProtocolPurchases') assert.notEqual(client[name], original[name], 'public protocol uses a held facade');
    else if (name === 'createPublicSellerClient') assert.notEqual(client[name], original.buildPublicSellerClient, 'public seller client is the admission wrapper over its builder');
    else if (name === 'createPurchaseService') assert.notEqual(client[name], original.createPublicPurchaseService, 'public service is the admission wrapper over the diagnostic service');
    else if (GUIDANCE_NAMES.includes(name)) assert.notEqual(client[name], original[name], 'guidance is chosen on each call, not the admitted form itself');
    else assert.equal(client[name], original[name], 'export retains its defining identity');
  });
}

test('root exposes exactly the reviewed names', async () => {
  assert.deepEqual(Object.keys(await import('@kynesyslabs/dacs-client')).sort(), [...ROOT.functions, ...ROOT.classes, ...ROOT.values].sort());
});

test('the root exports the testnet per-write fee ceiling as the positive decimal OS amount string 50000000000', async () => {
  const { PAID_WRITE_FEE_CEILING_OS } = await import('@kynesyslabs/dacs-client');
  assert.equal(typeof PAID_WRITE_FEE_CEILING_OS, 'string');
  assert.equal(PAID_WRITE_FEE_CEILING_OS, '50000000000');
  assert.match(PAID_WRITE_FEE_CEILING_OS, /^[1-9][0-9]*$/);
});

test('evidence recorder subpath exports exactly its factory', async () => {
  const recorder = await import('@kynesyslabs/dacs-client/purchase/evidence-recorder');
  assert.deepEqual(Object.keys(recorder), ['createPurchaseEvidenceRecorder']);
});

test('durable journal subpath exports exactly its factory, error, format, version and the wallet-lane view', async () => {
  const journal = await import('@kynesyslabs/dacs-client/wallet/durable-journal');
  assert.deepEqual(Object.keys(journal).sort(), ['DURABLE_WALLET_JOURNAL_FORMAT', 'DURABLE_WALLET_JOURNAL_VERSION', 'DurableWalletJournalError', 'openDurableWalletJournal', 'createWalletLaneView', 'walletLane', 'walletLaneKey'].sort());
  for (const name of ['createWalletLaneView', 'walletLane', 'walletLaneKey']) assert.equal(typeof journal[name], 'function');
  assert.equal(typeof journal.openDurableWalletJournal, 'function');
  assert.equal(typeof journal.DurableWalletJournalError, 'function');
  assert.equal(journal.DURABLE_WALLET_JOURNAL_FORMAT, 'dacs-durable-wallet-journal');
  assert.equal(journal.DURABLE_WALLET_JOURNAL_VERSION, 1);
});

for (const subpath of ['src/purchases.mjs', 'src/config.mjs', 'util/http', 'browser', 'wallet-session', 'unknown']) {
  test(`private subpath is refused: ${subpath}`, async () => {
    await assert.rejects(import(`@kynesyslabs/dacs-client/${subpath}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  });
}

test('candidate manifest uses release metadata and the exact public boundary', async () => {
  const client = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@kynesyslabs/dacs-client'))));
  const core = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@kynesyslabs/dacs'))));
  assert.equal(client.private, true);
  assert.equal(client.engines.node, core.engines.node);
  assert.equal(client.type, 'module');
  assert.equal(client.version, core.version);
  assert.deepEqual(client.peerDependencies, { '@kynesyslabs/dacs': core.version });
  assert.deepEqual(client.exports, { '.': './src/index.mjs', './wallet/durable-journal': './src/wallet/durable-journal.mjs', './node-wallet': './src/wallet/node-wallet-session.mjs',
    './substrate/demos': './src/substrate/demos.mjs', './purchase/evidence-recorder': './src/passive-evidence-recorder.mjs', './rpc-endpoint': './src/rpc-endpoint.mjs',
    './purchase/wallet-bridge': './src/purchase/wallet-bridge.mjs' });
  assert.equal(client.publishConfig, undefined, 'release-set admission is pending');
  assert.deepEqual(client.repository, { type: 'git', url: core.repository.url, directory: 'packages/dacs-client' });
  assert.equal(client.bugs.url, core.bugs.url);
  assert.match(client.homepage, /packages\/dacs-client#readme$/);
});

test('the client manifest declares exactly demosdk ^4.0.16 and dacs-node and @scure/bip39 exact; the root import loads neither demosdk nor the loading hooks', () => {
  const client = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@kynesyslabs/dacs-client'))));
  const core = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@kynesyslabs/dacs'))));
  assert.deepEqual(Object.keys(client.dependencies).sort(), ['@kynesyslabs/dacs-node', '@kynesyslabs/demosdk', '@scure/bip39']);
  assert.equal(client.dependencies['@kynesyslabs/demosdk'], '^4.0.16');
  assert.equal(client.dependencies['@kynesyslabs/dacs-node'], core.version);
  assert.match(client.dependencies['@scure/bip39'], /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(client.exports), ['.', './wallet/durable-journal', './node-wallet', './substrate/demos', './purchase/evidence-recorder', './rpc-endpoint', './purchase/wallet-bridge'], 'no export is added for the loading modules');
  const script = `import * as module from 'node:module';
    const refuse = (specifier, context, next) => {
      if (/demosdk|demos-loader|demos-quiet-hooks|node-demos-loading/.test(specifier)) throw new Error('unexpected import of ' + specifier);
      return next(specifier, context);
    };
    module.register('data:text/javascript,' + encodeURIComponent('export const resolve = ' + refuse.toString()), import.meta.url);
    await import('@kynesyslabs/dacs-client');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: process.cwd() });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test('root import never loads SQLite', () => {
  const script = `import * as module from 'node:module';
    const refuse = (specifier, context, next) => {
      if (specifier === 'node:sqlite') throw new Error('unexpected SQLite import');
      return next(specifier, context);
    };
    if (module.registerHooks) module.registerHooks({ resolve: refuse });
    else {
      module.register('data:text/javascript,' + encodeURIComponent('export const resolve = ' + refuse.toString()), import.meta.url);
      const original = module.default._load;
      module.default._load = function(specifier, ...args) {
        if (specifier === 'node:sqlite') throw new Error('unexpected SQLite require');
        return original.call(this, specifier, ...args);
      };
    }
    await import('@kynesyslabs/dacs-client');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: process.cwd() });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

// The per-write fee ceiling and the chain fee reader both purchase factories require.
const FEE_CEILING = { feeCeilingOs: '50000000000', chain: { getTransactionFees: async () => 1n } };

test('public refusals retain the exported error identity', async () => {
  const client = await import('@kynesyslabs/dacs-client');
  assert.throws(() => client.createProtocolPurchases({}), error => error instanceof TypeError && error.message === 'admission_required');
  const { binding, currentLocal } = await bindFixture();
  const buyer = client.createProtocolPurchases({ store: client.createSqlitePurchaseStore(), admission: { binding, currentLocal }, ...FEE_CEILING });
  await assert.rejects(buyer.prepareTerms({}), error => error instanceof client.OperationError && error.code === 'profile_not_admitted');
});

test('public status helpers describe diagnostic holds and historical state', async () => {
  const client = await import('@kynesyslabs/dacs-client');
  for (const status of ['awaiting_approval', 'approved', 'payment_handoff', 'settled_verified']) {
    assert.match(client.purchaseNext({ status }), /historical.*held/);
    assert.match(client.PURCHASE_STATUS_HELP[status], /historical.*held/);
  }
  const view = client.protocolView({ terms: { protocol: {} }, state: { protocol: { stage: 'agreement-signing' } } });
  assert.equal(view.historical, true);
  assert.match(view.next, /historical.*held/);
});

for (const profileAuthority of [undefined, {}, { standardRevision: 'old' }, { standardRevision: 'd45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20' }]) {
  test('public Listing verification refuses before resolution with caller authority ' + JSON.stringify(profileAuthority), async () => {
    const client = await import('@kynesyslabs/dacs-client');
    let reads = 0;
    const forbidden = () => { reads++; throw new Error('unexpected resolution'); };
    const { binding, currentLocal } = await bindFixture();
    const verifier = client.createListingVerifier({ directory: { findSummary: forbidden },
      chain: { readStorageProgram: forbidden }, profileAuthority, admission: { binding, currentLocal } });
    await assert.rejects(verifier.verify({ listingId: 'TEST-listing', version: 1, seller: 'TEST-seller' }), { code: 'profile_not_admitted' });
    assert.equal(reads, 0);
  });
}
test('unqualified node reader and held transport constructors are outside the public candidate', async () => {
  const client = await import('@kynesyslabs/dacs-client');
  for (const name of ['createDemosChainReader', 'createDemosSr2WalletBridge', 'isDevnetAgreementTransport', 'isDevnetNativeTransport']) assert.equal(client[name], undefined);
  // The one public chain reader is the testnet-pinned, read-only projection, offered only on its own subpath.
  assert.equal(client.createDemosPublicChainReader, undefined);
  const demos = await import('@kynesyslabs/dacs-client/substrate/demos');
  assert.deepEqual(Object.keys(demos), ['createDemosPublicChainReader']);
});

test('the complete public protocol method set refuses actions before host effects', async () => {
  const client = await import('@kynesyslabs/dacs-client');
  const { createProtocolPurchases: internalFactory } = await import('../src/dacs/protocol-purchases.mjs');
  let effects = 0;
  const effect = () => { effects++; throw new Error('TEST-host-effect'); };
  const options = { store: client.createSqlitePurchaseStore(), ops: { transition: effect, record: effect } };
  const { binding, currentLocal } = await bindFixture();
  const internal = internalFactory(options), publicProtocol = client.createProtocolPurchases({ ...options, admission: { binding, currentLocal }, ...FEE_CEILING });
  assert.deepEqual(Object.keys(publicProtocol).sort(), Object.keys(internal).sort());
  for (const [name, method] of Object.entries(publicProtocol)) {
    if (typeof method !== 'function' || PASSIVE_PROTOCOL_METHODS.has(name)) continue;
    await assert.rejects(method({ terms: { buyer: { wallet: 'TEST-wallet' } }, state: { protocol: {} } }, 'TEST-reason'),
      error => error instanceof client.OperationError && error.code === 'profile_not_admitted', name);
  }
  assert.equal(effects, 0);
});

const PASSIVE_PROTOCOL_METHODS = new Set(['assertBuyerAccess', 'supportsMode', 'readIssued', 'readIssuedPayment', 'observeReportedPayment', 'assertSellerReceiptReservation', 'readRetainedNativePaymentLane']);
const PASSIVE_SERVICE_METHODS = new Set(['status', 'portalOperation', 'portalEvidence', 'verifyDeal', 'planRunning', 'nativePaymentLaneRead']);
const refusesAsPromise = (member, name) => {
  const result = member({});
  assert.ok(result instanceof Promise, `${name} returns a Promise`);
  return assert.rejects(result, error => error.code === 'profile_not_admitted', name);
};

// The real public objects, with every host write counted. Nothing here is typed in as a member list.
async function heldPublicObjects() {
  const client = await import('@kynesyslabs/dacs-client');
  const { binding, currentLocal } = await bindFixture();
  const admission = { binding, currentLocal };
  const writes = { count: 0 };
  const db = openDatabase(':memory:');
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8), now: () => 1 });
  const counted = Object.fromEntries(Object.entries(ops).filter(([, value]) => typeof value === 'function')
    .map(([name, method]) => [name, (...args) => { writes.count++; return method(...args); }]));
  const coordinates = client.createCoordinateStore({ db });
  const store = client.createSqlitePurchaseStore();
  const protocol = client.createProtocolPurchases({ db, ops: counted, coordinates, store, admission, ...FEE_CEILING });
  const service = client.createPurchaseService({ db, ops: counted, coordinates, ...FEE_CEILING, config: {}, store, protocol, purposes: { APPROVE_PURCHASE: 'TEST-approve' }, admission });
  const verifier = client.createListingVerifier({ directory: {}, chain: {}, admission });
  const rows = () => JSON.stringify(db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table').map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
  return { service, protocol, verifier, writes, rows, close: () => db.close() };
}

test('every active method returns a Promise and every passive method keeps its signature (K6-W20, code half)', async (t) => {
  const { service, protocol, verifier, close } = await heldPublicObjects();
  t.after(close);
  const client = await import('@kynesyslabs/dacs-client');
  const internal = (await import('../src/dacs/protocol-purchases.mjs')).createProtocolPurchases({ store: client.createSqlitePurchaseStore() });
  const passiveSeen = [];
  for (const [name, member] of Object.entries(protocol)) {
    if (typeof member !== 'function') continue;
    if (PASSIVE_PROTOCOL_METHODS.has(name)) { passiveSeen.push(name); assert.equal(member.length, internal[name].length, `${name} keeps its arity`); continue; }
    await refusesAsPromise(member, name);
  }
  assert.deepEqual(passiveSeen.sort(), [...PASSIVE_PROTOCOL_METHODS].sort());
  // The receipt check answers synchronously, held or not: a composition without native payment refuses every operation.
  assert.throws(() => protocol.assertSellerReceiptReservation({ terms: {}, state: { protocol: {} } }), error => error instanceof client.OperationError && error.code === 'seller_receipt_reservation_insufficient');
  assert.deepEqual(Object.keys(service).filter(name => typeof service[name] === 'function' && PASSIVE_SERVICE_METHODS.has(name)).sort(), [...PASSIVE_SERVICE_METHODS].sort());
  assert.deepEqual(Object.keys(verifier).filter(name => typeof verifier[name] === 'function'), ['verify']);
  await refusesAsPromise(verifier.verify, 'verify');
});

test('every purchase-service member outside the passive list (status, portalOperation, portalEvidence, verifyDeal, planRunning, nativePaymentLaneRead) rejects profile_not_admitted with seller, signer, broadcast and row writes 0, and so does every active member of the Listing verifier, and every function member of the object the public createProtocolPurchases returns outside PASSIVE_PROTOCOL_METHODS (holdChainReadback, keepChainPointers and the native payment helpers such as cancelNativePayment included), with ops.transition and every other host write counter at 0', async (t) => {
  const { service, protocol, verifier, writes, rows, close } = await heldPublicObjects();
  t.after(close);
  const before = rows();
  const members = (object, passive) => Object.entries(object).filter(([name, member]) => typeof member === 'function' && !passive.has(name));
  const active = [...members(service, PASSIVE_SERVICE_METHODS), ...members(verifier, new Set()), ...members(protocol, PASSIVE_PROTOCOL_METHODS)];
  for (const name of ['holdChainReadback', 'cancelNativePayment']) assert.ok(active.some(([member]) => member === name), `${name} is an active member`);
  assert.ok(active.length > 30, 'the member lists come from the real objects');
  for (const [name, member] of active) await refusesAsPromise(member, name);
  assert.equal(writes.count, 0);
  assert.equal(rows(), before);
});

// The wrapper names the functions it wraps; a passive member is the original, so it carries its own name.
const WRAPPED_ACTION_NAME = 'admittedAction';
const publicApiSection = () => (readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('\n## Public API\n')[1] ?? '').split(/\n## /)[0];
function readmeInventory(factory) {
  const body = publicApiSection().split(`\n### ${factory}\n`)[1]?.split(/\n### /)[0] ?? '';
  const names = (label) => [...(new RegExp(`^${label}: (.+)$`, 'm').exec(body)?.[1] ?? '').matchAll(/`([^`]+)`/g)].map(([, name]) => name).sort();
  return { active: names('Active'), passive: names('Passive') };
}

test('the README method inventory equals each factory\'s own method list and its active and passive split (K6-W20, documentation half)', async (t) => {
  const { service, protocol, verifier, close } = await heldPublicObjects();
  t.after(close);
  for (const [factory, object] of [['createProtocolPurchases', protocol], ['createPurchaseService', service], ['createListingVerifier', verifier]]) {
    const methods = Object.entries(object).filter(([, member]) => typeof member === 'function');
    const namesWhere = (wrapped) => methods.filter(([, method]) => (method.name === WRAPPED_ACTION_NAME) === wrapped).map(([name]) => name).sort();
    assert.deepEqual(readmeInventory(factory), { active: namesWhere(true), passive: namesWhere(false) }, factory);
  }
});

test('the README documents the admission option and each construction and call refusal', () => {
  const section = publicApiSection();
  assert.match(section, /admission: \{ binding, currentLocal \}/);
  for (const code of ['admission_required', 'admission_input_untrusted', 'runtime_unsupported', 'profile_not_admitted', 'tp1_authority_timeout']) {
    assert.ok(section.includes(code), code);
  }
});

test("node-wallet subpath exports exactly its reviewed names; the root import loads neither SQLite nor demosdk", async () => {
 const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 assert.equal(manifest.exports['./node-wallet'],'./src/wallet/node-wallet-session.mjs');
 const api=await import('../src/wallet/node-wallet-session.mjs');
 assert.deepEqual(Object.keys(api).sort(),['createNodeObserver','createNodeTransportOwner','createNodeWalletSession','createRpcStampSource','createNodeAuthorityCapability','composeNodeWalletSession','openKeystoreWalletSession',
   'createHeldTransportFacade','createNodeSellerComposition','admitTp1Authority','tp1AuthorityLabel','authorityLabelOf','isTp1AuthorityToken','capabilityAuthorityLabel','readNodeAddressBalance','isDevnetAgreementTransport','isDevnetSettlementTransport','isDevnetDemoTransport','releaseAbandonedJournalLocks','passContext','fetchBoundedNodeJson','listsWithin',
   'DEVNET_AGREEMENT_PROFILE','DEVNET_AGREEMENT_KIND','DEVNET_AGREEMENT_SOURCE','DEVNET_SETTLEMENT_KIND','DEVNET_SETTLEMENT_POLICY',
   'DEVNET_DELIVERY_KIND','DEVNET_DELIVERY_POLICY','DEVNET_DEMO_ARTIFACT_KIND','DEVNET_DEMO_ARTIFACT_POLICY','DEVNET_DEMO_ARTIFACT_TYPES'].sort());
});

const SELLER_CLIENT_ACTIONS = ['propose', 'agreementState', 'commit', 'submitPayment', 'bundleRequest', 'countersign', 'confirmBuyerCopy'];

test('createPublicSellerClient requires admission and rejects every active method while held with no connector call', async () => {
  const { createPublicSellerClient } = await import('@kynesyslabs/dacs-client');
  const calls = { request: 0, verifyResponse: 0 };
  const authentication = { request: async () => { calls.request++; }, verifyResponse: async () => { calls.verifyResponse++; } };
  const options = { publicEndpoint: 'https://seller.example.test', authentication };
  assert.throws(() => createPublicSellerClient(options), { name: 'TypeError', message: 'admission_required' });
  const { binding, currentLocal } = await bindFixture();
  const seller = createPublicSellerClient({ ...options, admission: { binding, currentLocal }, commitOnSignature: true });
  assert.equal(seller.origin, 'https://seller.example.test');
  for (const name of [...SELLER_CLIENT_ACTIONS, 'commitOnSignature']) {
    const result = seller[name]({ jobId: 'TEST-job' });
    assert.ok(result instanceof Promise, `${name} returns a Promise`);
    await assert.rejects(result, { code: 'profile_not_admitted' }, name);
  }
  assert.deepEqual(calls, { request: 0, verifyResponse: 0 });
  for (const option of ['fetchImpl', 'connector', 'resolveHost', 'prepareTransmit', 'beforeTransmit']) {
    assert.throws(() => createPublicSellerClient({ ...options, admission: { binding, currentLocal }, [option]: () => {} }), TypeError, option);
  }
});

test('createPublicSellerClient refuses a timeoutMs outside 1000 through 300000 and a commitOnSignature that is not a boolean', async () => {
  const { createPublicSellerClient } = await import('@kynesyslabs/dacs-client');
  const { binding, currentLocal } = await bindFixture();
  const authentication = { request: async () => assert.fail('nothing is signed'), verifyResponse: async () => assert.fail('nothing is verified') };
  const build = (extra) => createPublicSellerClient({ admission: { binding, currentLocal }, publicEndpoint: 'https://seller.example.test', authentication, ...extra });
  for (const timeoutMs of [-1, 0, 999, 300001, 1500.5, Number.NaN, Infinity, '5000', 'abc', null]) {
    assert.throws(() => build({ timeoutMs }), { name: 'TypeError', message: 'timeoutMs must be an integer from 1000 through 300000' }, String(timeoutMs));
  }
  for (const timeoutMs of [undefined, 1000, 300000]) assert.equal(build({ timeoutMs }).origin, 'https://seller.example.test', String(timeoutMs));
  for (const commitOnSignature of ['false', 'true', 1, 0, null, {}]) {
    assert.throws(() => build({ commitOnSignature }), { name: 'TypeError', message: 'commitOnSignature must be boolean' }, String(commitOnSignature));
  }
  assert.equal('commitOnSignature' in build({ commitOnSignature: false }), false);
  assert.equal('commitOnSignature' in build({}), false);
  assert.equal(typeof build({ commitOnSignature: true }).commitOnSignature, 'function');
});

test('an archive installed outside the checkout exports createPublicSellerClient, constructs the held client and loads without SQLite, with no checkout-relative import', (t) => {
  // This file also runs on the Node 24 leg, whose npm checks the app lock against the app manifest: the lock is
  // recomputed for this app, as the other packed test on that leg does, rather than copied from the workspace.
  const { app, run } = installPackedPair(t, { installedDependencyGraph: true });
  writeFileSync(join(app, 'seller-client.mjs'), `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
    assert.equal(existsSync(new URL('./node_modules/better-sqlite3', import.meta.url)), false, 'better-sqlite3 is absent');
    assert.match(import.meta.resolve('@kynesyslabs/dacs-client'), /\\/node_modules\\/@kynesyslabs\\/dacs-client\\//, 'the package is the installed copy');
    const client = await import('@kynesyslabs/dacs-client');
    assert.equal(typeof client.createPublicSellerClient, 'function');
    const local = { endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId: 'vector-conn-1' };
    const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local, readAuthority: async scope => ({ local: { ...scope.local },
      chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-authority', sessionId: scope.sessionId, participants: [] }) });
    const authentication = { request: async () => assert.fail('held: nothing is signed'), verifyResponse: async () => assert.fail('held: nothing is read') };
    const seller = client.createPublicSellerClient({ admission: { binding, currentLocal: () => ({ ...local }) }, publicEndpoint: 'https://seller.example.test', authentication });
    await assert.rejects(seller.propose({}), { code: 'profile_not_admitted' });
    assert.equal(process.moduleLoadList.includes('NativeModule sqlite'), false, 'SQLite was never loaded');
  `);
  run(process.execPath, ['seller-client.mjs'], app);
});

test('an archive installed outside the checkout exports createDemDeliveryContextRouteCaller and constructs its held buyer capability', (t) => {
  const { app, run } = installPackedPair(t, { installedDependencyGraph: true });
  writeFileSync(join(app, 'route-caller.mjs'), `
    import assert from 'node:assert/strict';
    assert.match(import.meta.resolve('@kynesyslabs/dacs-client'), /\\/node_modules\\/@kynesyslabs\\/dacs-client\\//, 'the package is the installed copy');
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error('nothing is sent at construction'); };
    const client = await import('@kynesyslabs/dacs-client');
    const capability = client.createDemDeliveryContextRouteCaller({ authority: 'TEST-installed-route' });
    assert.deepEqual(capability, { source: client.DEM_DELIVERY_CONTEXT_SOURCE, authority: 'TEST-installed-route' });
    assert.equal(Object.isFrozen(capability), true);
    assert.equal(client.demDeliveryContextUsage(capability), null, 'it has no provider store');
    assert.throws(() => client.createDemDeliveryContextRouteCaller({ authority: 'not-a-label' }), TypeError);
    assert.equal(fetches, 0);
  `);
  run(process.execPath, ['route-caller.mjs'], app);
});
