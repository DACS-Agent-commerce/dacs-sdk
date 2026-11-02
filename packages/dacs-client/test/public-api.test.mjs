// Public ESM boundary. Also runnable from an empty packed-package consumer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
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
    'canonicalize', 'contentHash', 'normalizeDemAmount', 'logicalListingAddress', 'verifyComponent', 'fundingHelpSentence'],
  classes: ['NotConfiguredError', 'OutboundError', 'OperationError', 'NotWiredError', 'StaleProtocolCheck',
    'SellerRefusedError', 'SellerUnavailableError', 'SellerTlsUnusableError', 'DemosSr2BridgeError', 'DemosSr2Error', 'NetworkBindingError', 'BuyerChainReadbackUnsupported', 'WalletFormatError'],
  values: ['PURCHASE_STATE_SCHEMA', 'PURCHASE_STATUS_HELP', 'DEM_DECIMAL', 'OS_INTEGER', 'vetNotPerformedRef', 'AGREEMENT_CONTEXT_SOURCE', 'DEM_DELIVERY_CONTEXT_SOURCE',
    'SR2_WALLET_KIND', 'DEVNET_AGREEMENT_KIND', 'DEVNET_AGREEMENT_PROFILE', 'DEVNET_NATIVE_BINDING_PATH', 'DEVNET_NATIVE_RPC_PATH', 'SDK_PROVENANCE'],
};
const modules = {
  "purchase-state-schema.mjs": "PURCHASE_STATE_SCHEMA",
  "seams/purchase-store-not-wired.mjs": "createSqlitePurchaseStore",
  "purchases.mjs": "createPurchaseService purchaseNext PURCHASE_STATUS_HELP networkIdentityLabel",
  "dacs/protocol-purchases.mjs": "createProtocolPurchases protocolView usesAgreementContext usesNativeDemDelivery StaleProtocolCheck",
  "dacs/delivery-deadline-watch.mjs": "createDeliveryDeadlineWatch",
  "dacs/wallet-transactions.mjs": "createCoordinateStore",
  "dacs/directory.mjs": "createDirectoryClient",
  "public-verification.mjs": "createListingVerifier NotConfiguredError",
  "dacs/chain.mjs": "DEM_DECIMAL OS_INTEGER",
  "dacs/purchase-protocol.mjs": "deliveryEvidenceAddress vetNotPerformedRef",
  "dacs/seller-http.mjs": "sellerFailureCause SellerRefusedError SellerUnavailableError SellerTlsUnusableError",
  "dacs/native-payment-evidence-consumer.mjs": "usesNativePaymentEvidence",
  "dacs/agreement-context-consumer.mjs": "AGREEMENT_CONTEXT_SOURCE isOperatorContextAuthority",
  "dacs/dem-delivery-context-consumer.mjs": "DEM_DELIVERY_CONTEXT_SOURCE demDeliveryContextUsage isDemDeliveryContextAuthority",
  "dacs/demos-sr2-wallet-bridge.mjs": "SR2_WALLET_KIND DemosSr2BridgeError",
  "wallet/devnet-native-transport.mjs": "rpcAuthRefusal transferRefusal DEVNET_AGREEMENT_KIND DEVNET_AGREEMENT_PROFILE DEVNET_NATIVE_BINDING_PATH DEVNET_NATIVE_RPC_PATH",
  "dacs/seller-session-lifecycle.mjs": "sellerSessionTransitionState",
  "util/purchase-readback-cache.mjs": "createPurchaseReadbackCache",
  "util/http.mjs": "OutboundError",
  "dacs/listing.mjs": "canonicalize contentHash normalizeDemAmount SDK_PROVENANCE logicalListingAddress verifyComponent",
  "dacs/demos-sr2-adapter.mjs": "DemosSr2Error",
  "dacs/network-binding.mjs": "NetworkBindingError",
  "dacs/buyer-chain-readback.mjs": "BuyerChainReadbackUnsupported",
  "client-errors.mjs": "OperationError NotWiredError",
  "signatures.mjs": "WalletFormatError",
  "buyer-funding.mjs": "fundingHelpSentence"
};

for (const name of [...ROOT.functions, ...ROOT.classes, ...ROOT.values]) {
  test(`root export: ${name}`, async () => {
    const client = await import('@kynesyslabs/dacs-client');
    assert.notEqual(client[name], undefined, name);
    if (ROOT.functions.includes(name) || ROOT.classes.includes(name)) assert.equal(typeof client[name], 'function');
    const module = Object.keys(modules).find(path => modules[path].split(' ').includes(name));
    const original = await import(new URL(module, import.meta.resolve('@kynesyslabs/dacs-client')));
    const alias = { createPurchaseService: 'createPublicPurchaseService', purchaseNext: 'diagnosticPurchaseNext', PURCHASE_STATUS_HELP: 'DIAGNOSTIC_PURCHASE_STATUS_HELP', protocolView: 'diagnosticProtocolView' };
    if (name === 'createProtocolPurchases') assert.notEqual(client[name], original[name], 'public protocol uses a held facade');
    else if (name === 'createPurchaseService') assert.notEqual(client[name], original[alias[name]], 'public service is the admission wrapper over the diagnostic service');
    else assert.equal(client[name], original[alias[name] ?? name], 'export retains its defining identity');
  });
}

test('root exposes exactly the reviewed names', async () => {
  assert.deepEqual(Object.keys(await import('@kynesyslabs/dacs-client')).sort(), [...ROOT.functions, ...ROOT.classes, ...ROOT.values].sort());
});

test('durable journal subpath exports exactly its factory, error, format and version', async () => {
  const journal = await import('@kynesyslabs/dacs-client/wallet/durable-journal');
  assert.deepEqual(Object.keys(journal).sort(), ['DURABLE_WALLET_JOURNAL_FORMAT', 'DURABLE_WALLET_JOURNAL_VERSION', 'DurableWalletJournalError', 'openDurableWalletJournal'].sort());
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
  assert.equal(client.engines.node, '^22.13.0 || >=23.4.0');
  assert.equal(client.type, 'module');
  assert.equal(client.version, core.version);
  assert.deepEqual(client.peerDependencies, { '@kynesyslabs/dacs': core.version });
  assert.equal(client.dependencies, undefined);
  assert.deepEqual(client.exports, { '.': './src/index.mjs', './wallet/durable-journal': './src/wallet/durable-journal.mjs' });
  assert.equal(client.publishConfig, undefined, 'release-set admission is pending');
  assert.deepEqual(client.repository, { type: 'git', url: core.repository.url, directory: 'packages/dacs-client' });
  assert.equal(client.bugs.url, core.bugs.url);
  assert.match(client.homepage, /packages\/dacs-client#readme$/);
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

test('public refusals retain the exported error identity', async () => {
  const client = await import('@kynesyslabs/dacs-client');
  assert.throws(() => client.createProtocolPurchases({}), error => error instanceof TypeError && error.message === 'admission_required');
  const { binding, currentLocal } = await bindFixture();
  const buyer = client.createProtocolPurchases({ store: client.createSqlitePurchaseStore(), admission: { binding, currentLocal } });
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
});

test('the complete public protocol method set refuses actions before host effects', async () => {
  const client = await import('@kynesyslabs/dacs-client');
  const { createProtocolPurchases: internalFactory } = await import('../src/dacs/protocol-purchases.mjs');
  let effects = 0;
  const effect = () => { effects++; throw new Error('TEST-host-effect'); };
  const options = { store: client.createSqlitePurchaseStore(), ops: { transition: effect, record: effect } };
  const { binding, currentLocal } = await bindFixture();
  const internal = internalFactory(options), publicProtocol = client.createProtocolPurchases({ ...options, admission: { binding, currentLocal } });
  assert.deepEqual(Object.keys(publicProtocol).sort(), Object.keys(internal).sort());
  for (const [name, method] of Object.entries(publicProtocol)) {
    if (typeof method !== 'function' || PASSIVE_PROTOCOL_METHODS.has(name)) continue;
    await assert.rejects(method({ terms: { buyer: { wallet: 'TEST-wallet' } }, state: { protocol: {} } }, 'TEST-reason'),
      error => error instanceof client.OperationError && error.code === 'profile_not_admitted', name);
  }
  assert.equal(effects, 0);
});

const PASSIVE_PROTOCOL_METHODS = new Set(['assertBuyerAccess', 'supportsMode', 'readIssued', 'readIssuedPayment', 'observeReportedPayment']);
const PASSIVE_SERVICE_METHODS = new Set(['status', 'portalOperation', 'portalEvidence', 'verifyDeal', 'planRunning']);
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
  const protocol = client.createProtocolPurchases({ db, ops: counted, coordinates, store, admission });
  const service = client.createPurchaseService({ db, ops: counted, coordinates, chain: {}, config: {}, store, protocol, purposes: { APPROVE_PURCHASE: 'TEST-approve' }, admission });
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
  assert.deepEqual(Object.keys(service).filter(name => typeof service[name] === 'function' && PASSIVE_SERVICE_METHODS.has(name)).sort(), [...PASSIVE_SERVICE_METHODS].sort());
  assert.deepEqual(Object.keys(verifier).filter(name => typeof verifier[name] === 'function'), ['verify']);
  await refusesAsPromise(verifier.verify, 'verify');
});

test('every purchase-service member outside the passive list (status, portalOperation, portalEvidence, verifyDeal, planRunning) rejects profile_not_admitted with seller, signer, broadcast and row writes 0, and so does every active member of the Listing verifier, and every function member of the object the public createProtocolPurchases returns outside PASSIVE_PROTOCOL_METHODS (holdChainReadback, keepChainPointers and the native payment helpers such as cancelNativePayment included), with ops.transition and every other host write counter at 0', async (t) => {
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
