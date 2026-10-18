// Embedded wallet SDK seam: public/portal/embedded-wallet/sdk-provider.mjs over
// the actual upstream @kynesyslabs/demosdk 4.0.16 (installed in wallet-build/)
// and over the built browser bundle demos-runtime.mjs loaded in Node.
//
// Functional, source-aware fixture tests only: not a security review and not
// browser/host proof. Every key is fresh and in memory; secret values are only
// compared with assert.ok so a failure never prints them. All socket, fetch and
// WebSocket use is trapped for the whole file: these tests must stay offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

import { renderChallengeMessage, PURPOSES } from '../src/wallet/challenges.mjs';
import { verifyDemosSignature } from '../src/wallet/demos-signature.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { checkRuntimeGraph, readRuntimeGraphFiles } from '../scripts/embedded-wallet-runtime.mjs';

const networkAttempts = [];
net.Socket.prototype.connect = function trappedConnect() {
  networkAttempts.push('net.Socket.connect');
  throw new Error('network disabled in embedded wallet SDK tests');
};
globalThis.fetch = async () => {
  networkAttempts.push('fetch');
  throw new Error('network disabled in embedded wallet SDK tests');
};
globalThis.WebSocket = class {
  constructor() {
    networkAttempts.push('WebSocket');
    throw new Error('network disabled in embedded wallet SDK tests');
  }
};

// Import-time work in the SDK bundle (node-seal init) is asynchronous; record
// any rejection so the final test reports it instead of losing it.
const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(`${reason?.name ?? 'Error'}: ${reason?.message ?? String(reason)}`);
});

const buildDir = new URL('../wallet-build/', import.meta.url);
const sdkDir = new URL('node_modules/@kynesyslabs/demosdk/', buildDir);
const bundleUrl = new URL('../public/portal/embedded-wallet/demos-runtime.mjs', import.meta.url);
const SDK_BLOCKED = existsSync(new URL('package.json', sdkDir)) ? false : 'BLOCKED: wallet-build dependencies are not installed (run worker wallet-install)';
const BUNDLE_BLOCKED = existsSync(bundleUrl) ? false : 'BLOCKED: demos-runtime.mjs has not been built (run worker wallet-build)';

const ADDRESS = /^0x[0-9a-f]{64}$/;

// The published 4.0.16 build uses bundler-style specifiers that plain Node ESM
// rejects (ERR_UNSUPPORTED_DIR_IMPORT for build/demoswork/operations/ from
// baseoperation.js). Only for importers inside the installed SDK, resolve them
// the way esbuild does (dir/ -> dir/index.js, ./x -> ./x.js). SDK bytes are
// loaded unmodified.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!context.parentURL?.startsWith(sdkDir.href)) throw error;
      if (error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT' && error.url) return nextResolve(new URL('index.js', error.url.endsWith('/') ? error.url : `${error.url}/`).href, context);
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
      throw error;
    }
  },
});

async function loadSdk() {
  const require = createRequire(new URL('package.json', buildDir));
  assert.equal(JSON.parse(readFileSync(new URL('package.json', sdkDir), 'utf8')).version, '4.0.16');
  const { Demos } = await import(pathToFileURL(require.resolve('@kynesyslabs/demosdk/websdk')).href);
  const { Identities } = await import(new URL('build/abstraction/Identities.js', sdkDir).href);
  const { validateMnemonic: bip39Validate } = await import(pathToFileURL(require.resolve('@scure/bip39')).href);
  const { wordList } = await import(new URL('build/encryption/PQC/falconts/wordlist.js', sdkDir).href);
  // Same check Demos.connectWallet applies (and demos-runtime.mjs exports).
  const validateMnemonic = (m) => typeof m === 'string' && bip39Validate(m, wordList);
  return { Demos, Identities, validateMnemonic, wordList };
}

const sdk = SDK_BLOCKED ? null : await loadSdk();

function loginMessage(address) {
  return renderChallengeMessage({
    origin: 'https://plugin.example.test',
    purpose: PURPOSES.LOGIN,
    address,
    binding: { account: 'acct_fixture', note: 'naïve ✓ ünïcödé' },
    nonce: 'fixture-nonce',
    issuedAt: '2026-10-03T00:00:00.000Z',
    expiresAt: '2026-10-03T00:05:00.000Z',
  });
}

function session(extra = {}, runtime = sdk) {
  return createSdkWalletSession({ DemosCtor: runtime.Demos, IdentitiesCtor: runtime.Identities, validateMnemonic: runtime.validateMnemonic, ...extra });
}

function assertPublicShape(account) {
  assert.deepEqual(Object.keys(account).sort(), ['address', 'evidenceMode', 'network', 'publicKey']);
  assert.match(account.address, ADDRESS);
  assert.equal(account.publicKey, account.address.slice(2));
  assert.equal(account.network, 'unconfigured');
  assert.equal(account.evidenceMode, 'local-key-only');
}

test('actual SDK: create returns only the public account and matches direct SDK derivation', { skip: SDK_BLOCKED }, async () => {
  const wallet = session();
  assert.equal(wallet.isLocked(), true);
  assert.equal(wallet.getPublicAccount(), null);
  const account = await wallet.create();
  assertPublicShape(account);
  assert.deepEqual(wallet.getPublicAccount(), account);
  assert.equal(wallet.isLocked(), false);

  const mnemonic = wallet.exportMnemonicForUser();
  assert.ok(mnemonic.split(' ').length === 24, 'default strength 256 yields a 24-word phrase');
  assert.ok(sdk.validateMnemonic(mnemonic), 'SDK-generated phrase passes the SDK check');

  const direct = new sdk.Demos();
  await direct.connectWallet(mnemonic, { algorithm: 'ed25519' });
  assert.equal(direct.getAddress(), account.address);
  assert.equal(await direct.getEd25519Address(), account.address);
  direct.disconnect();
  wallet.lock();
});

test('actual SDK: import of a created phrase is equivalent, including 12-word and whitespace/case variants', { skip: SDK_BLOCKED }, async () => {
  for (const strength of [256, 128]) {
    const creator = session();
    const created = await creator.create({ strength });
    const mnemonic = creator.exportMnemonicForUser();
    assert.ok(mnemonic.split(' ').length === (strength === 256 ? 24 : 12), 'phrase length follows strength');
    creator.lock();

    const importer = session();
    assert.deepEqual(await importer.importMnemonic(mnemonic), created);
    importer.lock();
    const messy = `  ${mnemonic.toUpperCase().split(' ').join(' \n\t ')}  `;
    assert.deepEqual(await importer.importMnemonic(messy), created);
    assert.ok(importer.exportMnemonicForUser() === mnemonic, 'normalized phrase is the SDK form');
    importer.lock();
  }
  await assert.rejects(session().create({ strength: 192 }), { code: 'invalid_params' });
});

test('actual SDK: import refuses phrases connectWallet would treat as a passphrase', { skip: SDK_BLOCKED }, async () => {
  const creator = session();
  await creator.create();
  const words = creator.exportMnemonicForUser().split(' ');
  creator.lock();
  let bad = null;
  for (const candidate of sdk.wordList) {
    const attempt = [...words.slice(0, -1), candidate].join(' ');
    if (!sdk.validateMnemonic(attempt)) {
      bad = attempt;
      break;
    }
  }
  assert.ok(bad, 'found a checksum-invalid variant');
  const wallet = session();
  await assert.rejects(wallet.importMnemonic(bad), { code: 'invalid_mnemonic' });
  await assert.rejects(wallet.importMnemonic('correct horse battery staple'), { code: 'invalid_mnemonic' });
  await assert.rejects(wallet.importMnemonic(42), { code: 'invalid_mnemonic' });
  assert.equal(wallet.isLocked(), true);
  const unvalidated = createSdkWalletSession({ DemosCtor: sdk.Demos });
  await assert.rejects(unvalidated.importMnemonic(words.join(' ')), { code: 'not_configured' });
  assert.equal(unvalidated.isLocked(), true);
});

test('actual SDK: approved sign of the exact wallet-login message verifies with the server verifier', { skip: SDK_BLOCKED }, async () => {
  const asked = [];
  const wallet = session({ approve: async (req) => { asked.push(req); return true; } });
  const { address } = await wallet.create();
  const message = loginMessage(address);

  const connected = await wallet.request({ method: 'connect' });
  assert.deepEqual(connected, { success: true, data: address, error: null });

  const res = await wallet.request({ method: 'sign', params: [message] });
  assert.equal(res.success, true);
  assert.deepEqual(asked, [{ method: 'sign', address, message }]);
  assert.deepEqual(Object.keys(res.data).sort(), ['address', 'signature', 'type']);
  assert.equal(res.data.type, 'ed25519');
  assert.equal(res.data.address, address);
  assert.match(res.data.signature, /^[0-9a-f]{128}$/);

  const signature = res.data.signature;
  assert.equal(verifyDemosSignature({ address, message, signature }), true);
  assert.equal(verifyDemosSignature({ address, message, signature: `0x${signature}` }), true);
  assert.equal(verifyDemosSignature({ address, message, signature: Buffer.from(signature, 'hex').toString('base64url') }), true);
  assert.equal(verifyDemosSignature({ address, message: `${message} `, signature }), false);
  assert.equal(verifyDemosSignature({ address, message: message.normalize('NFD'), signature }), false);
  const other = session({ approve: async () => true });
  const otherAccount = await other.create();
  assert.equal(verifyDemosSignature({ address: otherAccount.address, message, signature }), false);
  // SDK's own verifier agrees on the same raw UTF-8 bytes.
  assert.equal(await new sdk.Demos().verifyMessage(message, signature, address, { algorithm: 'ed25519' }), true);
  wallet.lock();
  other.lock();
});

test('sign requires a deliberate approval and well-formed params', { skip: SDK_BLOCKED }, async () => {
  const noApprover = session();
  const { address } = await noApprover.create();
  assert.deepEqual(await noApprover.request({ method: 'sign', params: ['hello'] }), { success: false, data: null, error: { code: 'not_configured', message: 'no approval handler is configured for this wallet' } });
  noApprover.lock();

  for (const answer of [false, 'yes', 1, {}, undefined]) {
    const wallet = session({ approve: async () => answer });
    await wallet.create();
    const res = await wallet.request({ method: 'sign', params: ['hello'] });
    assert.equal(res.success, false);
    assert.equal(res.error.code, 'user_rejected');
    wallet.lock();
  }

  const throwing = session({ approve: async () => { throw new Error(`approval UI failed for ${address}`); } });
  await throwing.create();
  const thrown = await throwing.request({ method: 'sign', params: ['hello'] });
  assert.deepEqual(thrown.error, { code: 'internal_error', message: 'the embedded wallet could not complete the request' });
  throwing.lock();

  const wallet = session({ approve: async () => true });
  await wallet.create();
  for (const params of [undefined, [], ['a', 'b'], [{ message: 'hello' }], 'hello']) {
    assert.equal((await wallet.request({ method: 'sign', params })).error.code, 'invalid_params');
  }
  wallet.lock();
});

test('lock discards live authority, including while an approval is pending', { skip: SDK_BLOCKED }, async () => {
  let wallet;
  wallet = session({ approve: async () => { wallet.lock(); return true; } });
  await wallet.create();
  const res = await wallet.request({ method: 'sign', params: ['hello'] });
  assert.equal(res.error.code, 'locked');
  assert.equal(wallet.isLocked(), true);
  assert.equal(wallet.getPublicAccount(), null);
  assert.throws(() => wallet.exportMnemonicForUser(), { code: 'locked' });
  for (const method of ['connect', 'sign', 'getWeb2IdentityProofPayload']) {
    assert.equal((await wallet.request({ method, params: ['x'] })).error.code, 'locked');
  }

  // Replacing the wallet mid-approval must not sign with the new key either.
  let replacing;
  replacing = session({ approve: async () => { await replacing.create(); return true; } });
  await replacing.create();
  const replaced = await replacing.request({ method: 'sign', params: ['hello'] });
  assert.equal(replaced.success, false);
  assert.ok(['locked', 'busy'].includes(replaced.error.code));
  replacing.lock();
});

test('provider responses never carry the recovery phrase', { skip: SDK_BLOCKED }, async () => {
  const wallet = session({ approve: async () => true });
  const created = await wallet.create();
  const mnemonic = wallet.exportMnemonicForUser();
  const responses = [
    created,
    wallet.getPublicAccount(),
    await wallet.request({ method: 'connect' }),
    await wallet.request({ method: 'sign', params: ['hello'] }),
    await wallet.request({ method: 'getWeb2IdentityProofPayload', params: [] }),
    await wallet.request({ method: 'exportMnemonicForUser' }),
    await wallet.request({ method: 'getMnemonic' }),
    await wallet.request({ method: 'sendTransaction', params: [{}] }),
  ];
  const text = JSON.stringify(responses);
  const words = mnemonic.split(' ');
  assert.ok(!text.includes(mnemonic), 'no full phrase in provider output');
  assert.ok(!text.includes(words.slice(0, 3).join(' ')), 'no phrase fragment in provider output');
  assert.equal(responses[5].error.code, 'unsupported');
  assert.equal(responses[6].error.code, 'unsupported');
  wallet.lock();
});

test('transactions and identity writes stay unavailable, even with an injected transport', { skip: SDK_BLOCKED }, async () => {
  const calls = [];
  const transport = new Proxy({}, { get: (_, key) => (...args) => { calls.push([key, args]); return {}; } });
  const approve = async (req) => { calls.push(['approve', req]); return true; };
  const writes = ['sendTransaction', 'addGithubIdentity', 'addTwitterIdentity', 'removeWeb2Identity'];
  for (const [extra, code] of [[{}, 'not_configured'], [{ transactionTransport: transport }, 'unsupported']]) {
    const wallet = session({ approve, ...extra });
    for (const method of writes) {
      const before = await wallet.request({ method, params: [{}] });
      assert.equal(before.success, false);
      assert.equal(before.error.code, code);
    }
    await wallet.create();
    for (const method of writes) {
      const res = await wallet.request({ method, params: [{ to: '0x' + '1'.repeat(64), amount: 1 }] });
      assert.equal(res.success, false);
      assert.equal(res.error.code, code);
      assert.match(res.error.message, /loopback-only path is not proven/);
    }
    wallet.lock();
  }
  assert.deepEqual(calls, []);
});

test('actual SDK Identities: web2 proof payload is produced locally after approval and verifies', { skip: SDK_BLOCKED }, async () => {
  const asked = [];
  const wallet = session({ approve: async (req) => { asked.push(req.method); return true; } });
  const { address } = await wallet.create();
  const res = await wallet.request({ method: 'getWeb2IdentityProofPayload', params: [] });
  assert.equal(res.success, true);
  assert.deepEqual(asked, ['getWeb2IdentityProofPayload']);
  const match = /^demos:dw2p:ed25519:0x([0-9a-f]{128})$/.exec(res.data);
  assert.ok(match, 'proof is demos:dw2p:ed25519:0x<128 hex>');
  assert.equal(verifyDemosSignature({ address, message: 'dw2p', signature: match[1] }), true);
  wallet.lock();

  const noIdentities = createSdkWalletSession({ DemosCtor: sdk.Demos, approve: async () => true });
  await noIdentities.create();
  assert.equal((await noIdentities.request({ method: 'getWeb2IdentityProofPayload', params: [] })).error.code, 'not_configured');
  noIdentities.lock();
});

test('built demos-runtime.mjs graph is closed and local, labelled and carries notices', { skip: BUNDLE_BLOCKED }, () => {
  const text = readFileSync(bundleUrl, 'utf8');
  assert.match(text.slice(0, 600), /unmodified upstream @kynesyslabs\/demosdk 4\.0\.16/);
  assert.match(text.slice(0, 600), /Not the V2 server-only modified runtime/);
  // Every file of the generated graph, as shipped: exact bytes, only local
  // relative imports, closure from the entry equal to the declared file set.
  assert.deepEqual(checkRuntimeGraph(readRuntimeGraphFiles(new URL('../public/portal/embedded-wallet/', import.meta.url))), []);
  assert.doesNotMatch(text, /\bimport\s*\(\s*["'`]https?:/);
  assert.doesNotMatch(text, /from\s*["']https?:/);
  const notices = text.slice(text.lastIndexOf('THIRD-PARTY NOTICES'));
  assert.match(notices, /@kynesyslabs\/demosdk@4\.0\.16 — license: MIT/);
  assert.match(notices, /@scure\/bip39@/);
});

test('built demos-runtime.mjs works offline and derives the same keys as the installed SDK', { skip: SDK_BLOCKED || BUNDLE_BLOCKED }, async () => {
  const before = networkAttempts.length;
  // Minimal browser-global fixture: the bundle targets browsers, where bundled
  // node-forge (and a Web Crypto random fallback) resolve `window`, and the
  // SDK's FHE module starts node-seal's inlined-WASM web build at import,
  // which locates itself via `document`. Node has neither; provide just these
  // so the browser code paths run here under the network trap. Real browser
  // proof belongs to the separate browser tests.
  globalThis.window ??= globalThis;
  globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
  globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
  const runtime = await import(bundleUrl.href);
  // Let the SDK's import-time node-seal initialisation settle (bounded).
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const name of ['Demos', 'Identities', 'validateMnemonic']) assert.equal(typeof runtime[name], 'function', `exports ${name}`);
  assert.equal(runtime.DEMOS_SDK_VERSION, '4.0.16');

  const bundled = session({ approve: async () => true }, runtime);
  const created = await bundled.create();
  assertPublicShape(created);
  const mnemonic = bundled.exportMnemonicForUser();
  assert.ok(runtime.validateMnemonic(mnemonic) && sdk.validateMnemonic(mnemonic), 'both validators accept the phrase');

  const installed = session();
  assert.deepEqual(await installed.importMnemonic(mnemonic), created);
  installed.lock();

  const message = loginMessage(created.address);
  const res = await bundled.request({ method: 'sign', params: [message] });
  assert.equal(verifyDemosSignature({ address: created.address, message, signature: res.data.signature }), true);
  const proof = await bundled.request({ method: 'getWeb2IdentityProofPayload', params: [] });
  assert.match(proof.data, /^demos:dw2p:ed25519:0x[0-9a-f]{128}$/);
  bundled.lock();
  assert.equal(networkAttempts.length, before);
});

test('no network was attempted and no asynchronous SDK failure occurred', () => {
  assert.deepEqual(networkAttempts, []);
  assert.deepEqual(unhandled, []);
});
