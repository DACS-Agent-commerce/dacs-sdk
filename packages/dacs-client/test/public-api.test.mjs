// Public ESM boundary. Also runnable from an empty packed-package consumer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
    assert.equal(client[name], original[alias[name] ?? name], 'export retains its defining identity');
  });
}

test('root exposes exactly the reviewed names', async () => {
  assert.deepEqual(Object.keys(await import('@kynesyslabs/dacs-client')).sort(), [...ROOT.functions, ...ROOT.classes, ...ROOT.values].sort());
});

test('durable journal subpath exports its format and version', async () => {
  const journal = await import('@kynesyslabs/dacs-client/wallet/durable-journal');
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
  assert.throws(() => client.createProtocolPurchases({}), error => error instanceof client.NotWiredError && error instanceof client.OperationError);
  const buyer = client.createProtocolPurchases({ store: client.createSqlitePurchaseStore() });
  assert.throws(() => buyer.prepareTerms({}), error => error instanceof client.OperationError && error.code === 'profile_not_admitted');
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
    const verifier = client.createListingVerifier({ directory: { findSummary: forbidden },
      chain: { readStorageProgram: forbidden }, profileAuthority });
    await assert.rejects(verifier.verify({ listingId: 'TEST-listing', version: 1, seller: 'TEST-seller' }), { code: 'profile_not_admitted' });
    assert.equal(reads, 0);
  });
}
test('unqualified node reader and held transport constructors are outside the public candidate', async () => {
  const client = await import('@kynesyslabs/dacs-client');
  for (const name of ['createDemosChainReader', 'createDemosSr2WalletBridge', 'isDevnetAgreementTransport', 'isDevnetNativeTransport']) assert.equal(client[name], undefined);
});
