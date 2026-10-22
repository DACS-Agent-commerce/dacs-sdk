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
  classes: ['NotConfiguredError', 'OutboundError'],
  values: ['PURCHASE_STATUS_HELP', 'DEM_DECIMAL', 'OS_INTEGER', 'vetNotPerformedRef', 'AGREEMENT_CONTEXT_SOURCE', 'DEM_DELIVERY_CONTEXT_SOURCE',
    'SR2_WALLET_KIND', 'DEVNET_AGREEMENT_KIND', 'DEVNET_AGREEMENT_PROFILE', 'DEVNET_NATIVE_BINDING_PATH', 'DEVNET_NATIVE_RPC_PATH', 'SDK_PROVENANCE'],
};
const modules = {
  "purchases.mjs": "createPurchaseService purchaseNext PURCHASE_STATUS_HELP networkIdentityLabel",
  "dacs/protocol-purchases.mjs": "createProtocolPurchases protocolView usesAgreementContext usesNativeDemDelivery",
  "dacs/delivery-deadline-watch.mjs": "createDeliveryDeadlineWatch",
  "dacs/wallet-transactions.mjs": "createCoordinateStore",
  "dacs/directory.mjs": "createDirectoryClient",
  "dacs/verification.mjs": "createListingVerifier NotConfiguredError",
  "dacs/chain.mjs": "createDemosChainReader DEM_DECIMAL OS_INTEGER",
  "dacs/purchase-protocol.mjs": "deliveryEvidenceAddress vetNotPerformedRef",
  "dacs/seller-http.mjs": "sellerFailureCause",
  "dacs/native-payment-evidence-consumer.mjs": "usesNativePaymentEvidence",
  "dacs/agreement-context-consumer.mjs": "AGREEMENT_CONTEXT_SOURCE isOperatorContextAuthority",
  "dacs/dem-delivery-context-consumer.mjs": "DEM_DELIVERY_CONTEXT_SOURCE demDeliveryContextUsage isDemDeliveryContextAuthority",
  "dacs/demos-sr2-wallet-bridge.mjs": "createDemosSr2WalletBridge SR2_WALLET_KIND",
  "wallet/devnet-native-transport.mjs": "isDevnetAgreementTransport isDevnetNativeTransport rpcAuthRefusal transferRefusal DEVNET_AGREEMENT_KIND DEVNET_AGREEMENT_PROFILE DEVNET_NATIVE_BINDING_PATH DEVNET_NATIVE_RPC_PATH",
  "dacs/seller-session-lifecycle.mjs": "sellerSessionTransitionState",
  "util/purchase-readback-cache.mjs": "createPurchaseReadbackCache",
  "util/http.mjs": "OutboundError",
  "dacs/listing.mjs": "canonicalize contentHash normalizeDemAmount SDK_PROVENANCE logicalListingAddress verifyComponent",
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

test('publishable manifest uses the release version and exact public boundary', async () => {
  const client = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@kynesyslabs/dacs-client'))));
  const core = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@kynesyslabs/dacs'))));
  assert.notEqual(client.private, true);
  assert.equal(client.type, 'module');
  assert.equal(client.version, core.version);
  assert.deepEqual(client.dependencies, { '@kynesyslabs/dacs': core.version });
  assert.deepEqual(client.exports, { '.': './src/index.mjs', './wallet/durable-journal': './src/wallet/durable-journal.mjs' });
  assert.deepEqual(client.files, ['src', 'README.md', 'LICENSE']);
  assert.equal(client.publishConfig.access, 'public');
});

test('root import never loads SQLite', () => {
  const script = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'node:sqlite') throw new Error('unexpected SQLite import');
      return next(specifier, context);
    }});
    await import('@kynesyslabs/dacs-client');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: process.cwd() });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
