// Public ESM boundary. Also runnable from an empty packed-package consumer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const ROOT = {
  functions: ['createPurchaseService', 'purchaseNext', 'networkIdentityLabel', 'createProtocolPurchases', 'protocolView', 'usesAgreementContext',
    'usesNativeDemDelivery', 'createDeliveryDeadlineWatch', 'createCoordinateStore', 'createDirectoryClient', 'createListingVerifier',
    'createDemosChainReader', 'deliveryEvidenceAddress', 'sellerFailureCause', 'usesNativePaymentEvidence', 'isOperatorContextAuthority',
    'demDeliveryContextUsage', 'isDemDeliveryContextAuthority', 'createDemosSr2WalletBridge', 'isDevnetAgreementTransport',
    'isDevnetNativeTransport', 'rpcAuthRefusal', 'transferRefusal', 'sellerSessionTransitionState', 'createPurchaseReadbackCache',
    'canonicalize', 'contentHash', 'normalizeDemAmount', 'logicalListingAddress', 'verifyComponent', 'fundingHelpSentence'],
  classes: ['NotConfiguredError', 'OutboundError', 'OperationError', 'NotWiredError', 'StaleProtocolCheck',
    'SellerRefusedError', 'SellerUnavailableError', 'SellerTlsUnusableError', 'DemosSr2BridgeError', 'DemosSr2Error', 'NetworkBindingError', 'BuyerChainReadbackUnsupported', 'WalletFormatError'],
  values: ['PURCHASE_STATUS_HELP', 'DEM_DECIMAL', 'OS_INTEGER', 'vetNotPerformedRef', 'AGREEMENT_CONTEXT_SOURCE', 'DEM_DELIVERY_CONTEXT_SOURCE',
    'SR2_WALLET_KIND', 'DEVNET_AGREEMENT_KIND', 'DEVNET_AGREEMENT_PROFILE', 'DEVNET_NATIVE_BINDING_PATH', 'DEVNET_NATIVE_RPC_PATH', 'SDK_PROVENANCE'],
};
const modules = {
  "purchases.mjs": "createPurchaseService purchaseNext PURCHASE_STATUS_HELP networkIdentityLabel",
  "dacs/protocol-purchases.mjs": "createProtocolPurchases protocolView usesAgreementContext usesNativeDemDelivery StaleProtocolCheck",
  "dacs/delivery-deadline-watch.mjs": "createDeliveryDeadlineWatch",
  "dacs/wallet-transactions.mjs": "createCoordinateStore",
  "dacs/directory.mjs": "createDirectoryClient",
  "dacs/verification.mjs": "createListingVerifier NotConfiguredError",
  "dacs/chain.mjs": "createDemosChainReader DEM_DECIMAL OS_INTEGER",
  "dacs/purchase-protocol.mjs": "deliveryEvidenceAddress vetNotPerformedRef",
  "dacs/seller-http.mjs": "sellerFailureCause SellerRefusedError SellerUnavailableError SellerTlsUnusableError",
  "dacs/native-payment-evidence-consumer.mjs": "usesNativePaymentEvidence",
  "dacs/agreement-context-consumer.mjs": "AGREEMENT_CONTEXT_SOURCE isOperatorContextAuthority",
  "dacs/dem-delivery-context-consumer.mjs": "DEM_DELIVERY_CONTEXT_SOURCE demDeliveryContextUsage isDemDeliveryContextAuthority",
  "dacs/demos-sr2-wallet-bridge.mjs": "createDemosSr2WalletBridge SR2_WALLET_KIND DemosSr2BridgeError",
  "wallet/devnet-native-transport.mjs": "isDevnetAgreementTransport isDevnetNativeTransport rpcAuthRefusal transferRefusal DEVNET_AGREEMENT_KIND DEVNET_AGREEMENT_PROFILE DEVNET_NATIVE_BINDING_PATH DEVNET_NATIVE_RPC_PATH",
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
    assert.equal(client[name], original[name], 'export retains its defining identity');
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
  assert.notEqual(client.private, true);
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
  const loader = `export async function resolve(specifier, context, next) {
    if (specifier === 'node:sqlite') throw new Error('unexpected SQLite import');
    return next(specifier, context);
  }`;
  const script = `import { register } from 'node:module';
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(loader)}), import.meta.url);
    await import('@kynesyslabs/dacs-client');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: process.cwd() });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test('public refusals retain the exported error identity', async () => {
  const client = await import('@kynesyslabs/dacs-client');
  assert.throws(() => client.createProtocolPurchases({}), error => error instanceof client.NotWiredError && error instanceof client.OperationError);
  const buyer = client.createProtocolPurchases({ store: { transaction: (_db, fn) => fn(), isUniqueViolation: () => false } });
  assert.throws(() => buyer.prepareTerms({}), error => error instanceof client.OperationError && error.code === 'profile_not_admitted');
});
