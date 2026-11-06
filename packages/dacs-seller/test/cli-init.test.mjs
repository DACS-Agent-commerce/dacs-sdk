import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { identityDouble, identityFor, mnemonicFor } from './helpers/init-identity-fixture.mjs';

// Every FileHandle.sync reports its path to `hooks.sync` while a test has set it; `hooks.link` is an error every link throws.
const hooks = { sync: null, link: null };
const realOpen = fsp.open;
fsp.open = async (...args) => {
  const handle = await realOpen(...args);
  const realSync = handle.sync.bind(handle);
  handle.sync = async () => { await hooks.sync?.(args[0]); return realSync(); };
  return handle;
};
const realLink = fsp.link;
fsp.link = async (...args) => {
  if (hooks.link) throw hooks.link;
  return realLink(...args);
};
syncBuiltinESMExports();

const WORKER = new URL('./helpers/init-worker.mjs', import.meta.url).pathname;
const KEY_FORMAT = 'dacs-seller-key/v1';
const CONFIG_MAX_BYTES = 65_536;
const load = () => import('../src/cli/init.mjs');
const expectedOutput = seed => `claim: ${identityFor(seed).claim}\naddress: ${identityFor(seed).address}\n`;
const modeOf = async path => (await lstat(path)).mode & 0o777;
const keyRecord = (mnemonic, overrides = {}) => JSON.stringify({ format: KEY_FORMAT, algorithm: 'ed25519', mnemonic, ...overrides });
const storedSeed = async directory => Number(/(\d+)$/.exec(JSON.parse(await readFile(join(directory, 'seller-key.json'), 'utf8')).mnemonic)[1]);
const isSyncOf = (path, directory) => !path.endsWith('.tmp') && (path === dirname(directory) || path === directory || path.startsWith(directory + '/'));

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-init-')));
  const dataDirectory = join(root, 'seller');
  t.after(async () => {
    await chmod(root, 0o700);
    await chmod(dataDirectory, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDirectory };
}

async function initialize(dataDirectory, identity = identityDouble(), events = []) {
  const { runInit } = await load();
  let output = '';
  await runInit({ dataDirectory, identity, stdout: { write: text => { output += text; events.push('print'); } } });
  return output;
}

async function refusal(promise) {
  try { await promise; } catch (error) { return error; }
  return assert.fail('expected a refusal');
}

/** Starts the worker; `reached(stage)` resolves on its message, `finished` on its exit with the last result message. */
function startWorker(t, dataDirectory, options) {
  const child = fork(WORKER, [dataDirectory, JSON.stringify(options)]);
  t.after(() => child.kill('SIGKILL'));
  const log = [], waiting = [];
  let result = null;
  child.on('message', message => {
    log.push(message);
    if (message.stage === 'done' || message.stage === 'error') result = message;
    for (const wake of waiting.splice(0)) wake();
  });
  const reached = async stage => { while (!log.some(message => message.stage === stage)) await new Promise(resolve => waiting.push(resolve)); };
  const finished = once(child, 'exit').then(([code, signal]) => ({ code, signal, result }));
  return { child, reached, finished };
}
const runWorker = (t, dataDirectory, options) => startWorker(t, dataDirectory, options).finished;

test('init creates a private data directory, a 0600 key file and seller.json, and prints only the claim and address', async t => {
  const { dataDirectory } = await fixture(t);
  assert.equal(await initialize(dataDirectory), expectedOutput(3));
  assert.equal(await modeOf(dataDirectory), 0o700);
  assert.deepEqual((await readdir(dataDirectory)).sort(), ['seller-key.json', 'seller.json']);
  assert.equal(await modeOf(join(dataDirectory, 'seller-key.json')), 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(dataDirectory, 'seller-key.json'), 'utf8')), { format: KEY_FORMAT, algorithm: 'ed25519', mnemonic: mnemonicFor(3) });
  const { parseSellerConfig, assertConfigBindsDirectory } = await import('../src/cli/config.mjs');
  assertConfigBindsDirectory(parseSellerConfig(await readFile(join(dataDirectory, 'seller.json'))), dataDirectory);
});

test('init never writes the secret to stdout, stderr or seller.json in any encoding', async t => {
  const { dataDirectory } = await fixture(t);
  const output = await initialize(dataDirectory, identityDouble(5));
  const config = await readFile(join(dataDirectory, 'seller.json'));
  const secrets = [Buffer.from(mnemonicFor(5)), Buffer.from(identityFor(5).privateKey), Buffer.from(identityFor(5).privateKey.subarray(0, 32))];
  for (const secret of secrets) {
    for (const encoding of ['utf8', 'hex', 'base64', 'base64url']) {
      for (const text of [output, config.toString()]) assert.ok(!text.includes(secret.toString(encoding)), encoding);
    }
  }
  const worker = await runWorker(t, join(dataDirectory, 'second'), { seed: 6 });
  assert.equal(worker.result.stdout, expectedOutput(6));
  assert.ok(!worker.result.stdout.includes(mnemonicFor(6)));
});

test('init under umask 0277 leaves the key file at exactly 0600 and the data directory at exactly 0700, and the custody loader accepts the key', async t => {
  const { dataDirectory } = await fixture(t);
  const { result } = await runWorker(t, dataDirectory, { umask: 0o277, seed: 4 });
  assert.equal(result.stage, 'done');
  assert.equal(await modeOf(dataDirectory), 0o700);
  assert.equal(await modeOf(join(dataDirectory, 'seller-key.json')), 0o600);
  const { loadKeyFile } = await import('../src/seller-key.mjs');
  const loader = await loadKeyFile(join(dataDirectory, 'seller-key.json'));
  try { assert.equal(loader.source, 'file'); } finally { loader.destroy(); }
});

test('a repeated init gets false from both publications, prints the stored claim and leaves both files byte-identical', async t => {
  const { dataDirectory } = await fixture(t);
  const first = await initialize(dataDirectory, identityDouble(3));
  const before = await Promise.all(['seller-key.json', 'seller.json'].map(name => readFile(join(dataDirectory, name))));
  const second = identityDouble(9);
  assert.equal(await initialize(dataDirectory, second), first);
  assert.deepEqual(second.generated, [mnemonicFor(9)]);
  const after = await Promise.all(['seller-key.json', 'seller.json'].map(name => readFile(join(dataDirectory, name))));
  assert.deepEqual(after, before);
  assert.deepEqual((await readdir(dataDirectory)).sort(), ['seller-key.json', 'seller.json']);
});

test('init after a crash before key publication leaves no key file, and the rerun creates one', async t => {
  const { dataDirectory } = await fixture(t);
  const crashed = await runWorker(t, dataDirectory, { seed: 3, kill: { fn: 'link', n: 1, when: 'before' } });
  assert.equal(crashed.signal, 'SIGKILL');
  assert.ok(!(await readdir(dataDirectory)).includes('seller-key.json'));
  assert.equal(await initialize(dataDirectory, identityDouble(8)), expectedOutput(8));
  assert.equal(await storedSeed(dataDirectory), 8);
});

test('init after a crash between key and config publication keeps the stored key, writes the config and prints the stored key\'s claim', async t => {
  const { dataDirectory } = await fixture(t);
  const crashed = await runWorker(t, dataDirectory, { seed: 3, kill: { fn: 'link', n: 2, when: 'before' } });
  assert.equal(crashed.signal, 'SIGKILL');
  const key = await readFile(join(dataDirectory, 'seller-key.json'));
  assert.ok(!(await readdir(dataDirectory)).includes('seller.json'));
  assert.equal(await initialize(dataDirectory, identityDouble(8)), expectedOutput(3));
  assert.deepEqual(await readFile(join(dataDirectory, 'seller-key.json')), key);
  assert.ok((await readdir(dataDirectory)).includes('seller.json'));
});

test('two concurrent inits held at a barrier after both observe the data directory absent and before either mkdir: one creates it, the other gets EEXIST, re-validates and continues; under the normal private umask both succeed with distinct generated identities, end with one key and one config, and both print the identity of the stored key', async t => {
  const { dataDirectory } = await fixture(t);
  const workers = [11, 12].map(seed => startWorker(t, dataDirectory, { seed, barrier: true, umask: 0o077 }));
  await Promise.all(workers.map(worker => worker.reached('at-mkdir')));
  for (const { child } of workers) child.send('go');
  const results = (await Promise.all(workers.map(worker => worker.finished))).map(({ result }) => result);
  const stored = await storedSeed(dataDirectory);
  assert.deepEqual(results.map(result => result.stage), ['done', 'done']);
  assert.equal(results.reduce((sum, result) => sum + result.eexist, 0), 1);
  assert.notEqual(results[0].generated[0], results[1].generated[0]);
  assert.ok([11, 12].includes(stored));
  for (const result of results) assert.equal(result.stdout, expectedOutput(stored));
  assert.deepEqual((await readdir(dataDirectory)).sort(), ['seller-key.json', 'seller.json']);
});

test('init refuses an existing key file in another format, with a checksum-invalid mnemonic or with a non-mnemonic passphrase, and leaves it unchanged', async t => {
  for (const text of [keyRecord(mnemonicFor(3), { format: 'dacs-seller-key/v0' }), keyRecord('TEST mnemonic seed 1x'), keyRecord(mnemonicFor(3) + ' passphrase')]) {
    const { dataDirectory } = await fixture(t);
    await mkdir(dataDirectory, { mode: 0o700 });
    await writeFile(join(dataDirectory, 'seller-key.json'), text, { mode: 0o600 });
    const error = await refusal(initialize(dataDirectory));
    assert.equal(error.code, 'seller_key_format_invalid');
    assert.ok(!error.message.includes('passphrase'));
    assert.equal(await readFile(join(dataDirectory, 'seller-key.json'), 'utf8'), text);
    assert.deepEqual(await readdir(dataDirectory), ['seller-key.json']);
  }
});

test('init refuses an existing seller.json that fails the closed schema and leaves it unchanged', async t => {
  const { dataDirectory } = await fixture(t);
  await mkdir(dataDirectory, { mode: 0o700 });
  await writeFile(join(dataDirectory, 'seller.json'), '{"format":"dacs-seller-config/v1","unknown":true}', { mode: 0o600 });
  const error = await refusal(initialize(dataDirectory));
  assert.equal(error.code, 'seller_config_invalid');
  assert.equal(await readFile(join(dataDirectory, 'seller.json'), 'utf8'), '{"format":"dacs-seller-config/v1","unknown":true}');
});

test('init refuses a relative, symlinked, group- or world-accessible or foreign-owned data directory before writing, and never changes an existing directory\'s mode', async t => {
  const { root } = await fixture(t);
  const target = join(root, 'target'), link = join(root, 'link'), shared = join(root, 'shared');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, link);
  await mkdir(join(root, 'real'), { mode: 0o700 });
  await symlink(join(root, 'real'), join(root, 'alias'));
  const unsafe = [['relative/seller', 'not-canonical'], [link, 'not-private'], [join(root, 'alias', 'seller'), 'not-canonical']];
  for (const [mode, name] of [[0o770, 'group'], [0o707, 'world'], [0o750, 'readable']]) {
    const path = join(root, name);
    await mkdir(path); await chmod(path, mode);
    unsafe.push([path, 'not-private']);
  }
  for (const [path, detail] of unsafe) {
    const error = await refusal(initialize(path));
    assert.deepEqual([error.code, error.detail], ['data_directory_unsafe', detail], path);
  }
  for (const [path, mode] of [[join(root, 'group'), 0o770], [join(root, 'world'), 0o707], [join(root, 'readable'), 0o750]]) {
    assert.equal(await modeOf(path), mode);
    assert.deepEqual(await readdir(path), []);
  }
  assert.deepEqual(await readdir(target), []);
  assert.deepEqual(await readdir(join(root, 'real')), []);
  await mkdir(shared, { mode: 0o700 });
  const realGetuid = process.getuid;
  process.getuid = () => realGetuid() + 1;
  try { assert.equal((await refusal(initialize(shared))).code, 'data_directory_unsafe'); } finally { process.getuid = realGetuid; }
  assert.deepEqual(await readdir(shared), []);
});

test('the claim init prints equals the claim derived by the custody loader path and by the Node wallet session from the same key file', {
  skip: !(Number(process.versions.node.split('.')[0]) >= 23 || /^22\.(1[3-9]|[2-9]\d)\./.test(process.versions.node)) && 'the custody loader needs the purchase runtime',
}, async t => {
  const { dataDirectory } = await fixture(t);
  const printed = await initialize(dataDirectory, identityDouble(7));
  const { openSellerKey } = await import('../src/seller-key.mjs');
  const identity = identityDouble(7);
  const roles = await openSellerKey({
    filePath: join(dataDirectory, 'seller-key.json'), dataDirectory, keyFormat: KEY_FORMAT, listingSeller: identityFor(7).claim,
    validateMnemonic: identity.validateMnemonic,
    derive: async mnemonic => { const derived = await identity.deriveWalletIdentity(mnemonic); return { claim: derived.claim, ed25519PrivateKey: derived.privateKey, cleanup() {} }; },
  });
  assert.equal(printed, `claim: ${roles.claim}\naddress: ${identityFor(7).address}\n`);
  roles.close();
});

test('init opens no network connection and invokes no signer', async t => {
  const { dataDirectory } = await fixture(t);
  const { result } = await runWorker(t, dataDirectory, { guards: true, seed: 3 });
  assert.deepEqual([result.stage, result.networkAttempts, result.signs], ['done', 0, 0]);
});

test('a key publication that returns false because another key is stored loads and prints the stored identity, never the generated one', async t => {
  const { dataDirectory } = await fixture(t);
  await mkdir(dataDirectory, { mode: 0o700 });
  await writeFile(join(dataDirectory, 'seller-key.json'), keyRecord(mnemonicFor(5)), { mode: 0o600 });
  const generating = identityDouble(9);
  const output = await initialize(dataDirectory, generating);
  assert.equal(output, expectedOutput(5));
  assert.ok(!output.includes(identityFor(9).claim));
  assert.equal(await storedSeed(dataDirectory), 5);
});

test('a config publication that returns false checks the existing seller.json\'s directory binding and key path, and refuses a mismatch without changing it', async t => {
  const other = await fixture(t);
  await initialize(other.dataDirectory);
  const template = JSON.parse(await readFile(join(other.dataDirectory, 'seller.json'), 'utf8'));
  const mismatches = [
    [{ ...template }, 'seller_config_directory_mismatch'],
    [{ ...template, dataDirectory: other.dataDirectory, keyPath: '/TEST-elsewhere/seller-key.json' }, 'seller_config_invalid'],
  ];
  for (const [config, code] of mismatches) {
    const { dataDirectory } = await fixture(t);
    await mkdir(dataDirectory, { mode: 0o700 });
    const text = JSON.stringify(config);
    await writeFile(join(dataDirectory, 'seller.json'), text, { mode: 0o600 });
    assert.equal((await refusal(initialize(dataDirectory))).code, code);
    assert.equal(await readFile(join(dataDirectory, 'seller.json'), 'utf8'), text);
  }
});

test('init syncs exactly the key file, the config file, the data directory and its parent, in that order, and nothing above the parent, before printing, including a run where both publications return false; it succeeds when the grandparent cannot be opened (mode 0311, non-root), where a walk up to `/` would fail on `open(grandparent)` with EACCES', async t => {
  const { root, dataDirectory } = await fixture(t);
  const barrier = [join(dataDirectory, 'seller-key.json'), join(dataDirectory, 'seller.json'), dataDirectory, root];
  const events = [];
  hooks.sync = path => events.push(path);
  try {
    await initialize(dataDirectory, identityDouble(3), events);
    assert.deepEqual(events.slice(-5), [...barrier, 'print']);
    assert.ok(events.filter(event => event !== 'print').every(path => path.endsWith('.tmp') || isSyncOf(path, dataDirectory)));
    events.length = 0;
    await initialize(dataDirectory, identityDouble(9), events);
    assert.deepEqual(events.filter(event => !String(event).endsWith('.tmp')), [...barrier, 'print']);
  } finally { hooks.sync = null; }
  if (process.getuid() === 0) return;
  const grandparent = join(root, 'grandparent'), parent = join(grandparent, 'parent');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(grandparent, 0o311);
  try { assert.equal(await initialize(join(parent, 'seller')), expectedOutput(3)); } finally { await chmod(grandparent, 0o700); }
});

test('each injected file or directory sync failure fails init with init_durability_failed and prints no identity', async t => {
  const counted = [];
  hooks.sync = path => counted.push(path);
  try { await initialize((await fixture(t)).dataDirectory); } finally { hooks.sync = null; }
  assert.ok(counted.length >= 4);
  for (let failing = 1; failing <= counted.length; failing += 1) {
    const { dataDirectory } = await fixture(t);
    let calls = 0;
    hooks.sync = () => { calls += 1; if (calls === failing) throw Object.assign(new Error('TEST sync failed'), { code: 'EIO' }); };
    const events = [];
    try {
      const error = await refusal(initialize(dataDirectory, identityDouble(3), events));
      assert.deepEqual([error.code, error.cause?.code], ['init_durability_failed', 'EIO'], `sync ${failing}`);
    } finally { hooks.sync = null; }
    assert.deepEqual(events, []);
  }
});

test('a winner paused after linking the key, or the config, and killed before its directory sync leaves the loser to complete the barrier and print the stored identity', async t => {
  for (const linked of [1, 2]) {
    const { dataDirectory } = await fixture(t);
    const winner = startWorker(t, dataDirectory, { seed: 21, pause: { fn: 'link', n: linked } });
    await winner.reached('paused');
    const events = [];
    hooks.sync = path => events.push(path);
    try { assert.equal(await initialize(dataDirectory, identityDouble(22), events), expectedOutput(21)); } finally { hooks.sync = null; }
    assert.deepEqual(events.slice(-5), [join(dataDirectory, 'seller-key.json'), join(dataDirectory, 'seller.json'), dataDirectory, dirname(dataDirectory), 'print']);
    winner.child.kill('SIGKILL');
    assert.equal((await winner.finished).signal, 'SIGKILL');
  }
});

test('init refuses a data directory whose parent does not exist and creates nothing', async t => {
  const { root } = await fixture(t);
  const error = await refusal(initialize(join(root, 'missing', 'seller')));
  assert.equal(error.code, 'data_directory_parent_missing');
  assert.deepEqual(await readdir(root), []);
});

test('a creator killed after mkdir and before chmod under umask 0277 leaves a 0500 directory that a concurrent loser and a later rerun refuse with data_directory_unsafe{owner-permissions}, without changing its mode or writing a file', async t => {
  const { dataDirectory } = await fixture(t);
  const loser = startWorker(t, dataDirectory, { seed: 12, barrier: true });
  await loser.reached('at-mkdir');
  const creator = await runWorker(t, dataDirectory, { umask: 0o277, kill: { fn: 'chmod', n: 1, when: 'before' } });
  assert.equal(creator.signal, 'SIGKILL');
  assert.equal(await modeOf(dataDirectory), 0o500);
  loser.child.send('go');
  const { result } = await loser.finished;
  assert.deepEqual([result.stage, result.code, result.detail], ['error', 'data_directory_unsafe', 'owner-permissions']);
  const rerun = await refusal(initialize(dataDirectory));
  assert.deepEqual([rerun.code, rerun.detail], ['data_directory_unsafe', 'owner-permissions']);
  assert.equal(await modeOf(dataDirectory), 0o500);
  assert.deepEqual(await readdir(dataDirectory), []);
});

test('a creator killed after chmod and before key publication leaves an empty 0700 directory that a rerun validates and completes', async t => {
  const { dataDirectory } = await fixture(t);
  const creator = await runWorker(t, dataDirectory, { umask: 0o277, kill: { fn: 'chmod', n: 1, when: 'after' } });
  assert.equal(creator.signal, 'SIGKILL');
  assert.equal(await modeOf(dataDirectory), 0o700);
  assert.deepEqual(await readdir(dataDirectory), []);
  assert.equal(await initialize(dataDirectory), expectedOutput(3));
});

test('init ignores partial and complete unpublished key temporaries left by a crash, and leaves them untouched', async t => {
  const { dataDirectory } = await fixture(t);
  await mkdir(dataDirectory, { mode: 0o700 });
  const temporaries = { 'seller-key.json.1.aaaaaaaaaaaa.tmp': '{"format":"dacs-seller-key/v1","alg', 'seller-key.json.2.bbbbbbbbbbbb.tmp': keyRecord(mnemonicFor(99)) };
  for (const [name, text] of Object.entries(temporaries)) await writeFile(join(dataDirectory, name), text, { mode: 0o600 });
  assert.equal(await initialize(dataDirectory), expectedOutput(3));
  assert.equal(await storedSeed(dataDirectory), 3);
  for (const [name, text] of Object.entries(temporaries)) assert.equal(await readFile(join(dataDirectory, name), 'utf8'), text);
});

test('init refuses an existing seller.json that is oversized, a symbolic link or not a regular file, and leaves it unchanged', async t => {
  const { root, dataDirectory } = await fixture(t);
  const configPath = join(dataDirectory, 'seller.json');
  await mkdir(dataDirectory, { mode: 0o700 });
  const oversized = JSON.stringify({ padding: 'x'.repeat(CONFIG_MAX_BYTES) });
  await writeFile(configPath, oversized, { mode: 0o600 });
  assert.equal((await refusal(initialize(dataDirectory))).code, 'seller_config_invalid');
  assert.equal(await readFile(configPath, 'utf8'), oversized);
  await rm(configPath);
  await writeFile(join(root, 'elsewhere.json'), '{}');
  await symlink(join(root, 'elsewhere.json'), configPath);
  assert.equal((await refusal(initialize(dataDirectory))).code, 'seller_data_directory_unavailable');
  await rm(configPath);
  await mkdir(configPath);
  assert.equal((await refusal(initialize(dataDirectory))).code, 'seller_config_invalid');
});

test('init refuses a derivation that returns a malformed claim or address, prints nothing and zeroes the derived key', async t => {
  const { dataDirectory } = await fixture(t);
  const events = [];
  for (const override of [{ claim: 'did:demos:agent:abc\nclaim: forged' }, { address: 'not hex' }, { claim: undefined }]) {
    const identity = identityDouble(3);
    const derive = identity.deriveWalletIdentity;
    let issued;
    identity.deriveWalletIdentity = async mnemonic => { issued = { ...(await derive(mnemonic)), ...override }; return issued; };
    const error = await refusal(initialize(dataDirectory, identity, events));
    assert.equal(error.code, 'seller_key_derivation_failed');
    assert.ok(issued.privateKey.every(byte => byte === 0));
  }
  assert.deepEqual(events, []);
});

test('a failed write is seller_data_directory_unavailable with its cause, not init_durability_failed, and leaves no key file', async t => {
  const { dataDirectory } = await fixture(t);
  hooks.link = Object.assign(new Error('TEST link failed'), { code: 'ENOSPC' });
  try {
    const error = await refusal(initialize(dataDirectory));
    assert.deepEqual([error.code, error.cause?.code], ['seller_data_directory_unavailable', 'ENOSPC']);
  } finally { hooks.link = null; }
  assert.deepEqual(await readdir(dataDirectory), []);
});

test('init refuses a generated mnemonic that fails validation before publishing anything', async t => {
  const { dataDirectory } = await fixture(t);
  const identity = identityDouble(3);
  identity.generateWalletMnemonic = async () => 'TEST not a mnemonic';
  assert.equal((await refusal(initialize(dataDirectory, identity))).code, 'seller_key_derivation_failed');
  assert.deepEqual(await readdir(dataDirectory), []);
});

test('init through the dispatcher reports a sync failure as init_durability_failed with its filesystem cause and no identity', async t => {
  const { main } = await import('../src/cli/main.mjs');
  const { dataDirectory } = await fixture(t);
  const io = { stdout: { write: text => { io.out += text; } }, stderr: { write: text => { io.err += text; } }, out: '', err: '', identity: identityDouble(3) };
  hooks.sync = () => { throw Object.assign(new Error('TEST sync failed'), { code: 'EIO' }); };
  try { assert.equal(await main(['init', '--data-dir', dataDirectory], io), 1); } finally { hooks.sync = null; }
  assert.deepEqual([io.out, io.err], ['', '{"code":"init_durability_failed","reason":"EIO"}\n']);
});

test('init through the dispatcher prints the claim and address, and refuses an unavailable identity and an unsafe directory with closed codes', async t => {
  const { main } = await import('../src/cli/main.mjs');
  const { root, dataDirectory } = await fixture(t);
  const run = async (argv, identity) => {
    const io = { stdout: { write: text => { io.out += text; } }, stderr: { write: text => { io.err += text; } }, out: '', err: '', identity };
    return { status: await main(argv, io), io };
  };
  const unavailable = await run(['init', '--data-dir', dataDirectory]);
  assert.deepEqual([unavailable.status, unavailable.io.err], [1, '{"code":"seller_identity_unavailable"}\n']);
  assert.deepEqual(await readdir(root), []);
  const created = await run(['init', '--data-dir', dataDirectory], identityDouble(3));
  assert.deepEqual([created.status, created.io.out], [0, expectedOutput(3)]);
  const unsafe = join(root, 'unsafe');
  await mkdir(unsafe, { mode: 0o500 });
  const refused = await run(['init', '--data-dir', unsafe], identityDouble(3));
  assert.deepEqual([refused.status, refused.io.err], [1, '{"code":"data_directory_unsafe","detail":"owner-permissions"}\n']);
  await chmod(unsafe, 0o700);
});
