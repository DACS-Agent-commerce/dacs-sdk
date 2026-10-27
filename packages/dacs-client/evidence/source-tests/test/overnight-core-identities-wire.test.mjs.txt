// Overnight-core: the server's unsigned gcr_routine getIdentities read
// (src/dacs/chain.mjs) against the REAL pinned @kynesyslabs/demosdk 4.0.16
// as the independent oracle. Both requests go to one SIMULATED loopback
// recorder; the test compares the exact body and the identity / signature /
// timestamp headers. This is wire alignment with the pinned SDK only: it says
// nothing about whether a live Demos node answers the read (not exercised).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDemosChainReader } from '../src/dacs/chain.mjs';

const buildDir = new URL('../wallet-build/', import.meta.url);
const sdkDir = new URL('node_modules/@kynesyslabs/demosdk/', buildDir);
const SDK_BLOCKED = existsSync(new URL('package.json', sdkDir)) ? false : 'BLOCKED: wallet-build dependencies are not installed';
const sdkPrefixes = SDK_BLOCKED ? [] : [sdkDir.href, `${pathToFileURL(realpathSync(fileURLToPath(sdkDir))).href}/`];

// Same scoped resolution shim as overnight-core-seller.test.mjs (realpath-aware).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!sdkPrefixes.some((prefix) => context.parentURL?.startsWith(prefix))) throw error;
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
  return { Demos, Identities };
}

const sdk = SDK_BLOCKED ? null : await loadSdk();
const ADDR = `0x${'ab'.repeat(32)}`;
const REPLY = { result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} }, require_reply: false, extra: null };
const AUTH = ['identity', 'signature', 'timestamp'];

let recorder;
before(async () => {
  const posts = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST') posts.push({ headers: Object.fromEntries(AUTH.map((name) => [name, req.headers[name]])), contentType: req.headers['content-type'], body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' });
    res.end(JSON.stringify(req.method === 'POST' ? REPLY : { result: 200, response: 'SIMULATED recorder' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  recorder = { url: `http://127.0.0.1:${server.address().port}`, posts, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
});
after(async () => recorder?.close());

test('unsigned getIdentities: the server sends exactly the body and empty auth headers the pinned SDK sends without a wallet', { skip: SDK_BLOCKED }, async () => {
  // Oracle: the pinned SDK with no wallet connected (the dacs DemosAdapter
  // connects a wallet only when given a secret).
  const demos = new sdk.Demos();
  await demos.connect(recorder.url);
  assert.equal(demos.walletConnected, false);
  const raw = await new sdk.Identities().getIdentities(demos, 'getIdentities', ADDR);
  assert.equal(raw.result, 200);
  const oracle = recorder.posts.at(-1);
  assert.deepEqual(oracle.body, { method: 'gcr_routine', params: [{ method: 'getIdentities', params: [ADDR] }] });
  assert.deepEqual(oracle.headers, { identity: 'ed25519:', signature: '', timestamp: '' }, 'the SDK sends the auth headers empty when unsigned');

  const reader = createDemosChainReader({ rpcUrl: recorder.url, network: 'overnight-core-recorder' });
  const envelope = await reader.getIdentities(ADDR.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(envelope, REPLY);
  const ours = recorder.posts.at(-1);
  assert.deepEqual(ours.body, oracle.body, 'same body (normalized lowercase 0x address)');
  assert.deepEqual(ours.headers, oracle.headers, 'same unsigned auth headers');
  assert.match(ours.contentType, /^application\/json/);

  // Witness: the previous chain.mjs request (same body, no auth headers) is
  // caught by the header comparison above.
  await fetch(recorder.url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(oracle.body) });
  const previous = recorder.posts.at(-1);
  assert.deepEqual(previous.body, oracle.body);
  assert.notDeepEqual(previous.headers, oracle.headers, 'a header-less read differs from the SDK wire');
});

test('control: with a connected wallet the SDK signs the read; the server never does', { skip: SDK_BLOCKED }, async () => {
  const demos = new sdk.Demos();
  await demos.connect(recorder.url);
  await demos.connectWallet(demos.newMnemonic(128), { algorithm: 'ed25519' });
  await new sdk.Identities().getIdentities(demos, 'getIdentities', ADDR);
  const signed = recorder.posts.at(-1);
  assert.match(signed.headers.identity, /^ed25519:0x[0-9a-f]{64}$/);
  assert.match(signed.headers.signature, /^(0x)?[0-9a-f]{128}$/);
  assert.match(signed.headers.timestamp, /^\d+$/);
  demos.disconnect();

  await createDemosChainReader({ rpcUrl: recorder.url, network: 'overnight-core-recorder' }).getIdentities(ADDR);
  assert.deepEqual(recorder.posts.at(-1).headers, { identity: 'ed25519:', signature: '', timestamp: '' }, 'no key, no signature');
});
