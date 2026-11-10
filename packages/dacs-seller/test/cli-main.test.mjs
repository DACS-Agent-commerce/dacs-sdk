import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD_TIMEOUT_MS = 10000;
const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
// Runs an ES module script in a clean child that resolves packages from the seller package.
const runModuleScript = (script, env = process.env) => spawnSync(process.execPath, ['--input-type=module', '-e', script],
  { cwd: packageDirectory, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, env: { ...env, NODE_OPTIONS: '' } });
const load = () => import('../src/cli/main.mjs');
const captured = () => {
  const output = { stdout: '', stderr: '' };
  return { output, io: Object.fromEntries(['stdout', 'stderr'].map(name => [name, { write: text => { output[name] += text; } }])) };
};

test('the dispatcher refuses unknown commands, unknown options and a missing, relative or non-canonical --data-dir with exit 2 and opens no file', async t => {
  const { main } = await load();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(dir, join(dir, 'alias'));
  for (const argv of [[], ['unknown', '--data-dir', dir], ['unknown', '--data-dir', join(dir, 'missing', 'child')], ['--wat'], ['init'], ['init', '--data-dir'],
    ['init', '--data-dir', 'relative'], ['init', '--data-dir', dir + '/'], ['init', '--data-dir', dir + '/a/..'],
    ['init', '--data-dir', join(dir, 'alias')], ['init', '--data-dir', dir, '--data-dir', dir],
    ['init', '--data-dir', dir, '--unknown'], ['toString', '--data-dir', dir], ['__proto__', '--data-dir', dir]]) {
    const { output, io } = captured();
    assert.equal(await main(argv, io), 2, JSON.stringify(argv)); assert.match(output.stderr, /usage|unknown|data-dir/i);
  }
  const script = `
    import fs from 'node:fs'; import fsp from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
    const {main} = await import(${JSON.stringify(new URL('../src/cli/main.mjs', import.meta.url).href)});
    for (const target of [fs, fsp]) for (const name of ['open', 'openSync', 'readFile', 'readFileSync', 'writeFile', 'writeFileSync'])
      if (name in target) target[name] = () => { throw Error('TEST file opened'); };
    syncBuiltinESMExports();
    if (await main(['unknown', '--data-dir', ${JSON.stringify(dir)}], {stdout:{write(){}},stderr:{write(){}}}) !== 2) throw Error('TEST exit');
  `;
  const child = runModuleScript(script);
  assert.equal(child.status, 0, child.stderr);
});

test('--help alone prints usage and exits 0 without a --data-dir, and --help beside other arguments is refused', async () => {
  const { main } = await load();
  const { output, io } = captured();
  assert.equal(await main(['--help'], io), 0);
  assert.match(output.stdout, /Usage: dacs-seller/);
  assert.equal(output.stderr, '');
  assert.equal(await main(['--help', '--data-dir', '/TEST-seller'], captured().io), 2);
});

test('a command that succeeds exits 0 and receives the canonical data directory; a config refusal exits 1 naming its code and field; any other failure exits 1 with the closed diagnostic', async t => {
  const { main } = await load();
  const { SellerConfigError } = await import('../src/cli/config.mjs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-cli-run-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const received = [];
  const commands = {
    ok: { run: async options => { received.push(options); }, effect: false },
    refuse: { run: async () => { throw new SellerConfigError('seller_config_directory_mismatch', 'keyPath'); }, effect: false },
    long: { run: async () => { throw new SellerConfigError('seller_config_invalid', 'x'.repeat(1000)); }, effect: false },
    other: { run: async () => { throw Object.assign(new Error('TEST secret detail'), { code: 'seller_key_unavailable' }); }, effect: false },
    unknown: { run: async () => { throw new Error('TEST secret detail'); }, effect: false },
  };
  const run = async name => {
    const { output, io } = captured();
    return { status: await main([name, '--data-dir', dir], { ...io, commands }), output };
  };
  assert.equal((await run('ok')).status, 0);
  assert.deepEqual(received, [{ dataDirectory: dir }]);
  const refused = await run('refuse');
  assert.equal(refused.status, 1);
  assert.deepEqual(JSON.parse(refused.output.stderr), { code: 'seller_config_directory_mismatch', field: 'keyPath' });
  assert.equal(JSON.parse((await run('long')).output.stderr).field.length, 128);
  const other = await run('other');
  assert.equal(other.status, 1);
  assert.deepEqual(JSON.parse(other.output.stderr), { code: 'seller_key_unavailable' });
  assert.deepEqual(JSON.parse((await run('unknown')).output.stderr), { code: 'seller_diagnostic_unknown' });
  assert.doesNotMatch(other.output.stderr, /secret/);
  const missing = captured();
  assert.equal(await main(['ok', '--data-dir', join(dir, 'a', 'b')], { ...missing.io, commands }), 1);
  assert.deepEqual(JSON.parse(missing.output.stderr), { code: 'seller_data_directory_unavailable', reason: 'ENOENT' });
});

test('every module under src/cli imports without side effects', async () => {
  const script = `
    import fs from 'node:fs'; import fsp from 'node:fs/promises'; import net from 'node:net'; import crypto from 'node:crypto';
    import {syncBuiltinESMExports} from 'node:module';
    const directory = new URL('../src/cli/', ${JSON.stringify(import.meta.url)});
    const files = fs.readdirSync(directory).filter(name => name.endsWith('.mjs'));
    if (!files.length) throw Error('TEST no CLI modules');
    // Preload their shared dependencies before instrumenting application side effects.
    await import('@kynesyslabs/dacs'); await import('@kynesyslabs/dacs/wire');
    await import(${JSON.stringify(new URL('../src/devnet-demo/operator-approval.mjs', import.meta.url).href)});
    await import(${JSON.stringify(new URL('../src/dacs/seller-durable-state.mjs', import.meta.url).href)});
    const counts = process.eventNames().map(name => [name, process.listenerCount(name)]);
    Object.defineProperty(process, 'argv', {get(){throw Error('TEST argv read');}});
    for (const target of [fs, fsp]) for (const name of ['open', 'openSync', 'readFile', 'readFileSync', 'writeFile', 'writeFileSync']) {
      if (!(name in target)) continue;
      const original = target[name];
      target[name] = (...args) => {
        // Loading the imported modules' source is intrinsic to the ESM loader.
        if (new Error().stack.includes('node:internal/modules/esm/load')) return original(...args);
        throw Error('TEST file effect');
      };
    }
    net.connect = crypto.sign = () => {throw Error('TEST network/sign effect');}; syncBuiltinESMExports();
    for (const file of files) await import(new URL(file, directory));
    if (JSON.stringify(counts) !== JSON.stringify(process.eventNames().map(name => [name, process.listenerCount(name)]))) throw Error('TEST signal handlers');
  `;
  const child = runModuleScript(script);
  assert.equal(child.status, 0, child.stderr);
});

test('no argument, environment variable or seller.json key selects a network, an identity or the operation guard', async () => {
  const { main } = await load();
  for (const option of ['--network', '--chain', '--identity', '--guard', '--public', '--kit-operation-guard']) {
    assert.equal(await main(['start', '--data-dir', '/TEST-seller', option, 'testnet-tp1'], captured().io), 2);
  }
  const child = runModuleScript(`
    import assert from 'node:assert/strict';
    const { main } = await import(${JSON.stringify(new URL('../src/cli/main.mjs', import.meta.url).href)});
    const { KIT_OPERATION_GUARD } = await import(${JSON.stringify(new URL('../src/kit-operation-guard.mjs', import.meta.url).href)});
    assert.equal(KIT_OPERATION_GUARD, 'off');
    assert.equal(await main(['start'], {stdout:{write(){}},stderr:{write(){}}}), 2);
  `, { ...process.env, DACS_KIT_GUARD: 'testnet-tp1', DACS_DATA_DIR: '/TEST-seller', DACS_NETWORK: 'testnet', DACS_IDENTITY: 'TEST-identity' });
  assert.equal(child.status, 0, child.stderr);
  const { parseSellerConfig } = await import('../src/cli/config.mjs');
  for (const key of ['network', 'chain', 'identity', 'guard', 'DACS_KIT_GUARD']) {
    assert.throws(() => parseSellerConfig(Buffer.from(JSON.stringify({ [key]: 'testnet-tp1' }))), error => error.field === key);
  }
});

test('canonical data directory accepts existing and absent final directories', async t => {
  const { parseCliArguments } = await load();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-canonical-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const dataDirectory of [dir, join(dir, 'new')]) {
    assert.deepEqual(await parseCliArguments(['init', '--data-dir', dataDirectory]), { command: 'init', dataDirectory });
  }
  symlinkSync(join(dir, 'missing'), join(dir, 'dangling'));
  symlinkSync(dir, join(dir, 'alias'));
  for (const dataDirectory of ['relative', dir + '/', dir + '/a/..', join(dir, 'dangling'), join(dir, 'alias', 'new')]) {
    await assert.rejects(parseCliArguments(['init', '--data-dir', dataDirectory]), error => error.code === 'cli_usage');
  }
});

test('directory validation preserves filesystem refusal causes', async () => {
  const { parseCliArguments } = await load();
  const dataDirectory = new URL(import.meta.url).pathname;
  await assert.rejects(parseCliArguments(['init', '--data-dir', dataDirectory + '/child']), error => error.cause?.code === 'ENOTDIR');
});
