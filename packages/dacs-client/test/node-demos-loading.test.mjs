// P21a1a: quiet Node demosdk loading. Every test that registers hooks or imports demosdk runs
// in a fresh child (registration is process-wide). Children are scripted offline: the Demos
// subclass answers its own posts, and a guard in the signing child counts any socket or DNS use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installNoEgress } from './helpers/no-egress.mjs';
import { runFreshChild } from './helpers/fresh-node-child.mjs';

const UNREVIEWED = 'node_wallet_sdk_unreviewed';
const PRELOADED = 'node_wallet_sdk_preloaded';
const PINNED_TIME_MS = 1793102400000;
const REVIEWED_LINES = {
  '4.0.16': { 'GCRGeneration.js': [173, 246, 249, 250], 'demosclass.js': [719, 1547] },
  '4.0.18': { 'GCRGeneration.js': [178, 302, 305, 306], 'demosclass.js': [738, 1775, 1781] },
};

const noEgress = installNoEgress();
test.after(() => noEgress.restore());
const childEgress = [];

const websdkUrl = import.meta.resolve('@kynesyslabs/demosdk/websdk');
const websdkDirectory = new URL('.', websdkUrl);
const sdkPackageDirectory = dirname(dirname(dirname(fileURLToPath(websdkUrl))));
const sdkNodeModules = dirname(dirname(sdkPackageDirectory));
const clientSource = fileURLToPath(new URL('../src/', import.meta.url));
const urls = {
  entry: new URL('../src/wallet/node-demos-loading.mjs', import.meta.url).href,
  loader: import.meta.resolve('@kynesyslabs/dacs-node/demos-loader'),
  websdk: websdkUrl,
  storage: import.meta.resolve('@kynesyslabs/demosdk/storage'),
  bip39: import.meta.resolve('@scure/bip39'),
  wordlist: import.meta.resolve('@scure/bip39/wordlists/english.js'),
  sdkWordlist: new URL('../encryption/PQC/falconts/wordlist.js', websdkUrl).href,
};
const hooksUrl = new URL('../src/wallet/demos-quiet-hooks.mjs', import.meta.url).href;
const installedVersion = JSON.parse(readFileSync(join(sdkPackageDirectory, 'package.json'), 'utf8')).version;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function child(t, source, overrides = {}, extra = []) {
  const run = runFreshChild(t, source, [JSON.stringify({ ...urls, ...overrides }), ...extra]);
  if (run.result?.egress !== undefined) childEgress.push({ mode: extra[0], count: run.result.egress });
  return run;
}
function failure(run) {
  return `${run.status}\n${run.stdout}\n${run.stderr}`;
}

const REPORT = `import { writeFileSync } from 'node:fs';
const urls = JSON.parse(process.argv[2]);
const report = result => writeFileSync('result.json', JSON.stringify(result));
const caught = error => ({ name: error?.name, code: error?.code, causeCode: error?.cause?.code, message: error?.message });
`;

test('loads Node demosdk websdk after the dacs-node demos loader; globalThis window, document and location are untouched before and after', t => {
  const loaded = child(t, REPORT + `
    const probe = () => ['window', 'document', 'location'].map(name => [typeof globalThis[name], Object.hasOwn(globalThis, name)]);
    const before = probe();
    const { Demos, validateMnemonic } = await (await import(urls.entry)).loadNodeDemos();
    report({ before, after: probe(), demos: typeof Demos, validator: typeof validateMnemonic });
  `);
  assert.equal(loaded.status, 0, failure(loaded));
  const untouched = [['undefined', false], ['undefined', false], ['undefined', false]];
  assert.deepEqual(loaded.result, { before: untouched, after: untouched, demos: 'function', validator: 'function' });
  const unloaded = child(t, REPORT + `
    try { await import(urls.websdk); report({ imported: true }); } catch (error) { report({ imported: false, ...caught(error) }); }
  `);
  assert.equal(unloaded.status, 0, failure(unloaded));
  assert.deepEqual(unloaded.result.imported, false, 'plain Node cannot import the websdk without the demos loader');
  assert.equal(unloaded.result.code, 'ERR_UNSUPPORTED_DIR_IMPORT');
});

test('the installed Demos class exposes connectWallet, getAddress, signMessage, sign, confirm, broadcast, disconnect and the post seam the session overrides', t => {
  const run = child(t, REPORT + `
    const { Demos } = await (await import(urls.entry)).loadNodeDemos();
    const names = ['connect', 'connectWallet', 'getAddress', 'signMessage', 'sign', 'confirm', 'broadcast', 'disconnect', '_doPost', 'call'];
    report(Object.fromEntries(names.map(name => [name, typeof Demos.prototype[name]])));
  `);
  assert.equal(run.status, 0, failure(run));
  for (const name of ['connect', 'connectWallet', 'getAddress', 'signMessage', 'sign', 'confirm', 'broadcast', 'disconnect', '_doPost', 'call']) {
    assert.equal(run.result[name], 'function', name);
  }
});

test("validateMnemonic is @scure/bip39's check bound to its English wordlist, and that list equals the wordlist the installed demosdk's connectWallet uses", t => {
  const run = child(t, REPORT + `
    const { Demos, validateMnemonic } = await (await import(urls.entry)).loadNodeDemos();
    const { entropyToMnemonic } = await import(urls.bip39);
    const { wordlist } = await import(urls.wordlist);
    const { wordList } = await import(urls.sdkWordlist);
    const valid = entropyToMnemonic(new Uint8Array(32).fill(7), wordlist);
    const words = valid.split(' ');
    const swapped = [words[1], words[0], ...words.slice(2)].join(' ');
    const demos = new Demos();
    await demos.connectWallet(valid, { algorithm: 'ed25519' });
    report({ valid: validateMnemonic(valid), swapped: validateMnemonic(swapped), empty: validateMnemonic(''),
      notText: [validateMnemonic(undefined), validateMnemonic(null), validateMnemonic(words), validateMnemonic(42)],
      sameList: wordlist.length === wordList.length && wordlist.every((word, index) => word === wordList[index]),
      size: wordlist.length, connected: typeof demos.getAddress() });
  `);
  assert.equal(run.status, 0, failure(run));
  assert.deepEqual(run.result, { valid: true, swapped: false, empty: false, notText: [false, false, false, false], sameList: true, size: 2048, connected: 'string' });
});

const SIGNING_CHILD = REPORT + `
import dns from 'node:dns';
import net from 'node:net';
let egress = 0;
net.Socket.prototype.connect = () => { egress++; throw new Error('TEST-no-egress'); };
dns.lookup = () => { egress++; throw new Error('TEST-no-egress'); };
const [mode, scenario] = process.argv.slice(3);
const { entropyToMnemonic } = await import(urls.bip39);
const { wordlist } = await import(urls.wordlist);
let Demos;
if (mode === 'quiet') ({ Demos } = await (await import(urls.entry)).loadNodeDemos());
else { await import(urls.loader); ({ Demos } = await import(urls.websdk)); }
const { DemosTransactions, GCRGeneration } = await import(urls.websdk);
const { StorageProgram } = await import(urls.storage);
Date.now = () => ${PINNED_TIME_MS};
const posts = [];
class OfflineDemos extends Demos {
  async connect(url) { this.rpc_url = url; this.connected = true; return true; }
  async _doPost(url, request) {
    const message = request.params[0].message;
    posts.push(message);
    if (message === 'getNetworkParameters') return { data: { response: scenario === 'fee-fallback' ? null : { networkFee: 1, rpcFee: 0 } } };
    if (message === 'getNetworkInfo') return { data: { response: scenario === 'fork-failure' ? null : { forks: { osDenomination: { activated: true } } } } };
    throw new Error('TEST-unscripted post ' + message);
  }
}
const demos = new OfflineDemos();
await demos.connectWallet(entropyToMnemonic(new Uint8Array(32).fill(3), wordlist), { algorithm: 'ed25519' });
await demos.connect('https://rpc.example.invalid/');
let feeFallbacks = 0;
if (scenario === 'fee-fallback') demos._calculateAndApplyGasFee = () => { feeFallbacks++; throw new Error('TEST-fee derivation failure'); };
if (scenario === 'gas-edit') GCRGeneration.createGasEdit = async () => { throw new Error('TEST-gas edit failure'); };
const result = {};
try {
  const send = await DemosTransactions.pay('0x' + '2'.repeat(64), 1, demos, { nonce: 1 });
  result.send = { hash: send.hash, signature: send.signature.data };
} catch (error) { result.sendError = error.message; }
try {
  const tx = DemosTransactions.empty();
  const payload = StorageProgram.createStorageProgram(String(demos.getAddress()), 'TEST-program', { note: 'TEST-data' }, 'json', undefined, { nonce: 2 });
  Object.assign(tx.content, { type: 'storageProgram', to: payload.storageAddress, amount: 0, data: ['storageProgram', payload], timestamp: ${PINNED_TIME_MS}, nonce: 2 });
  const signed = await demos.sign(tx, { nonce: 2 });
  result.create = { hash: signed.hash, signature: signed.signature.data };
} catch (error) { result.createError = error.message; }
report({ ...result, egress, feeFallbacks, networkInfoPosts: posts.filter(message => message === 'getNetworkInfo').length });
`;

test('an offline native send and storage CREATE signed through the loaded SDK carry the same hash and signature as through the untransformed SDK, and write nothing to stdout or stderr', t => {
  const plain = child(t, SIGNING_CHILD, {}, ['plain', 'ok']);
  const quiet = child(t, SIGNING_CHILD, {}, ['quiet', 'ok']);
  assert.equal(plain.status, 0, failure(plain));
  assert.equal(quiet.status, 0, failure(quiet));
  assert.match(plain.stdout, /nativePayload/, 'the untransformed SDK prints the native payload');
  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');
  for (const kind of ['send', 'create']) {
    assert.match(quiet.result[kind].hash, /^[0-9a-f]{64}$/, kind);
    assert.deepEqual(quiet.result[kind], plain.result[kind], kind);
  }
  assert.deepEqual([plain.result.egress, quiet.result.egress], [0, 0]);
});

test('a failed fork read, a fee fallback and a gas-edit error during signing write nothing to stdout or stderr', t => {
  const loud = { 'fork-failure': /getNetworkInfo unavailable/, 'fee-fallback': /fee derivation skipped/, 'gas-edit': /Error creating gas edit/ };
  for (const [scenario, message] of Object.entries(loud)) {
    const plain = child(t, SIGNING_CHILD, {}, ['plain', scenario]);
    const quiet = child(t, SIGNING_CHILD, {}, ['quiet', scenario]);
    assert.equal(plain.status, 0, failure(plain));
    assert.equal(quiet.status, 0, failure(quiet));
    assert.match(plain.stdout + plain.stderr, message, `${scenario}: the untransformed SDK reports it`);
    assert.equal(quiet.stdout, '', scenario);
    assert.equal(quiet.stderr, '', scenario);
  }
  const forkFailure = child(t, SIGNING_CHILD, {}, ['quiet', 'fork-failure']).result;
  assert.ok(forkFailure.networkInfoPosts >= 1 && forkFailure.send.hash, 'the fork read failed and signing still completed');
  const feeFallback = child(t, SIGNING_CHILD, {}, ['quiet', 'fee-fallback']).result;
  assert.ok(feeFallback.feeFallbacks >= 1 && feeFallback.send.hash, 'the fee fallback ran and signing still completed');
  const gasEdit = child(t, SIGNING_CHILD, {}, ['quiet', 'gas-edit']).result;
  assert.match(gasEdit.sendError, /Error creating gas edit/);
  assert.match(gasEdit.createError, /Error creating gas edit/);
});

function hookHarness(t, targets, reviewed) {
  const hooks = import(hooksUrl);
  const { port1, port2 } = new MessageChannel();
  t.after(() => { port1.close(); port2.close(); });
  const ping = () => new Promise(resolve => { port1.once('message', resolve); port1.postMessage('transformed'); });
  const load = async (url, text) => {
    const { load: loadHook } = await hooks;
    return loadHook(url, {}, async () => ({ format: 'module', source: Buffer.from(text) }));
  };
  const start = async () => (await hooks).initialize({ port: port2, targets, ...(reviewed ? { reviewed } : {}) });
  return { start, load, ping };
}

test("each target's source digest and listed statements match a reviewed entry, and the transformed output matches its recorded digest, under the installed demosdk version", async t => {
  const expected = REVIEWED_LINES[installedVersion];
  assert.ok(expected, `demosdk ${installedVersion} needs a reviewed entry and a line list in this test`);
  const targets = Object.keys(expected).map(name => new URL(name, websdkDirectory).href);
  const harness = hookHarness(t, targets);
  await harness.start();
  for (const [name, lines] of Object.entries(expected)) {
    const url = new URL(name, websdkDirectory).href;
    const original = readFileSync(fileURLToPath(url), 'utf8').split('\n');
    const output = String((await harness.load(url, original.join('\n'))).source).split('\n');
    assert.equal(output.length, original.length, `${name} keeps its line count`);
    const changed = original.flatMap((line, index) => (line === output[index] ? [] : [index + 1]));
    assert.deepEqual(changed, lines, `${name} changes only the reviewed lines`);
    for (const line of changed) {
      assert.match(original[line - 1], /^\s*console\.(?:log|warn)\(.*\);\s*$/, `${name}:${line} is a diagnostic statement`);
      assert.equal(output[line - 1], ';', `${name}:${line} becomes an empty statement`);
    }
  }
  assert.deepEqual((await harness.ping()).sort(), [...targets].sort());
  const other = { format: 'module', source: Buffer.from('console.log("kept");') };
  const { load } = await import(hooksUrl);
  assert.equal(await load('file:///elsewhere/other.js', {}, async () => other), other, 'every other URL passes through untouched');
});

test('an unreviewed source digest, or a reviewed digest whose listed line differs, refuses node_wallet_sdk_unreviewed and loads nothing', async t => {
  const source = 'first();\nconsole.log("noise");\nlast();\n';
  const output = 'first();\n;\nlast();\n';
  const url = 'file:///fixture/target.js';
  const entry = overrides => ({ sourceSha256: sha256(source), outputSha256: sha256(output), statements: [{ line: 2, text: 'console.log("noise");' }], ...overrides });
  const cases = {
    'a source with no reviewed digest': { text: source + '// changed\n', table: [entry()] },
    'a listed line that differs from its recorded text': { text: source, table: [entry({ statements: [{ line: 2, text: 'console.log("other");' }] })] },
    'a listed line past the end of the source': { text: source, table: [entry({ statements: [{ line: 9, text: 'console.log("noise");' }] })] },
    'an output that differs from its recorded digest': { text: source, table: [entry({ outputSha256: sha256('something else') })] },
    'a target with no reviewed entries': { text: source, table: [] },
  };
  for (const [name, { text, table }] of Object.entries(cases)) {
    const harness = hookHarness(t, [url], { 'target.js': table });
    await harness.start();
    await assert.rejects(harness.load(url, text), error => error.code === UNREVIEWED, name);
    assert.deepEqual(await harness.ping(), [], `${name}: nothing was transformed`);
  }
  const harness = hookHarness(t, [url], { 'target.js': [entry()] });
  await harness.start();
  assert.equal(String((await harness.load(url, source)).source), output, 'the reviewed shape itself is accepted');

  const tree = copyDemosdkTree(t);
  const refused = child(t, REPORT + `
    const { loadNodeDemos } = await import(urls.entry);
    const first = await loadNodeDemos().then(() => null, caught);
    const second = await loadNodeDemos().then(() => null, caught);
    report({ first, second });
  `, { entry: pathToFileURL(join(tree, 'src/wallet/node-demos-loading.mjs')).href });
  assert.equal(refused.status, 0, failure(refused));
  for (const attempt of [refused.result.first, refused.result.second]) {
    assert.equal(attempt.name, 'OperationError');
    assert.equal(attempt.code, UNREVIEWED);
    assert.equal(attempt.causeCode, UNREVIEWED, "the hook's error is the cause");
  }
});

/** A copy of the client's two loading modules beside a demosdk whose GCRGeneration.js has one extra comment line. */
function copyDemosdkTree(t) {
  const root = mkdtempSync(join(tmpdir(), 'dacs-client-tampered-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modules = join(root, 'node_modules');
  mkdirSync(join(modules, '@kynesyslabs'), { recursive: true });
  for (const name of readdirSync(sdkNodeModules)) {
    if (name !== '@kynesyslabs' && name !== '.bin') symlinkSync(join(sdkNodeModules, name), join(modules, name));
  }
  for (const name of ['dacs', 'dacs-node']) symlinkSync(join(sdkNodeModules, '@kynesyslabs', name), join(modules, '@kynesyslabs', name));
  const copy = join(modules, '@kynesyslabs', 'demosdk');
  mkdirSync(join(copy, 'build'), { recursive: true });
  copyFileSync(join(sdkPackageDirectory, 'package.json'), join(copy, 'package.json'));
  symlinkSync(join(sdkPackageDirectory, 'node_modules'), join(copy, 'node_modules'));
  for (const name of readdirSync(join(sdkPackageDirectory, 'build'))) {
    const from = join(sdkPackageDirectory, 'build', name), to = join(copy, 'build', name);
    if (name === 'websdk') cpSync(from, to, { recursive: true });
    else symlinkSync(from, to);
  }
  appendFileSync(join(copy, 'build/websdk/GCRGeneration.js'), '\n// TEST-tampered\n');
  mkdirSync(join(root, 'src/wallet'), { recursive: true });
  for (const path of ['client-errors.mjs', 'wallet/node-demos-loading.mjs', 'wallet/demos-quiet-hooks.mjs']) copyFileSync(join(clientSource, path), join(root, 'src', path));
  return root;
}

test("with demosdk's websdk imported before the loading module, loadNodeDemos refuses node_wallet_sdk_preloaded", t => {
  const run = child(t, REPORT + `
    await import(urls.loader);
    await import(urls.websdk);
    const { loadNodeDemos } = await import(urls.entry);
    report({ first: await loadNodeDemos().then(() => null, caught), second: await loadNodeDemos().then(() => null, caught) });
  `);
  assert.equal(run.status, 0, failure(run));
  for (const attempt of [run.result.first, run.result.second]) {
    assert.equal(attempt?.name, 'OperationError');
    assert.equal(attempt?.code, PRELOADED);
  }
  assert.equal(run.stdout + run.stderr, '');
});

test('a second loadNodeDemos in one process registers nothing more and returns the same Demos class', t => {
  const run = child(t, REPORT + `
    import Module from 'node:module';
    let registrations = 0;
    const register = Module.register;
    Module.register = (...args) => { registrations++; return register.apply(Module, args); };
    Module.syncBuiltinESMExports();
    const { loadNodeDemos } = await import(urls.entry);
    const first = await loadNodeDemos();
    const afterFirst = registrations;
    const second = await loadNodeDemos();
    const concurrent = await Promise.all([loadNodeDemos(), loadNodeDemos()]);
    report({ afterFirst, afterRepeats: registrations, sameDemos: first.Demos === second.Demos, sameValidator: first.validateMnemonic === second.validateMnemonic,
      sameObjects: concurrent.every(loaded => loaded.Demos === first.Demos && loaded.validateMnemonic === first.validateMnemonic) });
  `);
  assert.equal(run.status, 0, failure(run));
  assert.equal(run.result.afterFirst, 2, 'the resolver and the quiet transform register once each');
  assert.equal(run.result.afterRepeats, 2);
  assert.deepEqual([run.result.sameDemos, run.result.sameValidator, run.result.sameObjects], [true, true, true]);
});

test('no socket or DNS lookup leaves the process in the loading suite', () => {
  assert.deepEqual(noEgress.attempts, []);
  assert.ok(childEgress.some(({ mode }) => mode === 'quiet'), 'a signing child that loaded the SDK through the loading module reported its guard count');
  assert.deepEqual(childEgress.filter(({ count }) => count !== 0), []);
});

test('the README and module comments list the resolver, the transform\'s reviewed statements and the host build-order rule', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const loading = readFileSync(new URL('../src/wallet/node-demos-loading.mjs', import.meta.url), 'utf8');
  const hooks = readFileSync(new URL('../src/wallet/demos-quiet-hooks.mjs', import.meta.url), 'utf8');
  for (const [name, text] of [['README', readme], ['loading module', loading]]) {
    assert.match(text, /@kynesyslabs\/dacs-node\/demos-loader/, `${name} names the resolver`);
    assert.match(text, /before any other import of `?@kynesyslabs\/demosdk\/websdk`?/, `${name} states the host build-order rule`);
  }
  for (const [name, text] of [['README', readme], ['hooks module', hooks]]) {
    assert.match(text, /GCRGeneration\.js[^\n]*173[^\n]*246[^\n]*249[^\n]*250/, `${name} lists the GCRGeneration statements`);
    assert.match(text, /demosclass\.js[^\n]*719[^\n]*1547/, `${name} lists the demosclass statements`);
  }
  assert.match(loading, new RegExp(PRELOADED));
  assert.match(hooks, new RegExp(UNREVIEWED));
  for (const source of [loading, hooks]) assert.doesNotMatch(source, /\b(?:console|process\.stdout|process\.stderr)(?:\.write)?\s*=(?!=)/, 'nothing assigns console or the standard streams');
});
