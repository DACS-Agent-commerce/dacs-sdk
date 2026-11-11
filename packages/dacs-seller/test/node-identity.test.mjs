// The wallet identity the dacs-seller bin hands to `init`, and the bin run for real.
// Mnemonics are generated at test time; none is committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/dacs-seller.mjs', import.meta.url));
const IDENTITY_URL = new URL('../src/cli/node-identity.mjs', import.meta.url).href;
const CHILD_TIMEOUT_MS = 120_000;
const MNEMONIC_WORDS = 24;
const CLAIM_PREFIX = 'did:demos:agent:';
// Twenty-four times the first word of the list has a checksum no mnemonic has.
const CHECKSUM_INVALID_MNEMONIC = Array(MNEMONIC_WORDS).fill('abandon').join(' ');
const PASSPHRASE_SHAPED = 'TEST passphrase that is not a mnemonic';

const loadIdentity = () => import(IDENTITY_URL);

async function dataDirectoryIn(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-node-identity-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'seller');
}

test('the dacs-seller bin runs init with the wallet identity and prints the claim and address of the key it stored', async t => {
  const dataDirectory = await dataDirectoryIn(t);
  const child = spawnSync(process.execPath, [BIN, 'init', '--data-dir', dataDirectory], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.match(child.stdout, /^claim: did:demos:agent:[0-9a-f]{64}\naddress: (?:0x)?[0-9a-f]{64}\n$/);
  assert.deepEqual((await readdir(dataDirectory)).sort(), ['seller-key.json', 'seller.json']);
  assert.equal((await lstat(join(dataDirectory, 'seller-key.json'))).mode & 0o777, 0o600);
  const { mnemonic } = JSON.parse(await readFile(join(dataDirectory, 'seller-key.json'), 'utf8'));
  const { deriveWalletIdentity } = await loadIdentity();
  const stored = await deriveWalletIdentity(mnemonic);
  assert.equal(child.stdout, `claim: ${stored.claim}\naddress: ${stored.address}\n`);
  assert.equal(child.stdout.includes(mnemonic), false);
});

test('the wallet identity generates a 24-word mnemonic that passes its own validation, and no two generations match', async () => {
  const { generateWalletMnemonic, validateMnemonic } = await loadIdentity();
  const first = await generateWalletMnemonic(), second = await generateWalletMnemonic();
  assert.equal(first.split(' ').length, MNEMONIC_WORDS);
  assert.equal(validateMnemonic(first), true);
  assert.notEqual(first, second);
});

test('the wallet identity derives one claim and address per mnemonic, the claim naming the address key, and hands out a fresh private key each time', async () => {
  const { generateWalletMnemonic, deriveWalletIdentity } = await loadIdentity();
  const mnemonic = await generateWalletMnemonic();
  const first = await deriveWalletIdentity(mnemonic), second = await deriveWalletIdentity(mnemonic);
  assert.match(first.address, /^0x[0-9a-f]{64}$/);
  assert.equal(first.claim, CLAIM_PREFIX + first.address.slice(2));
  assert.deepEqual([second.address, second.claim], [first.address, first.claim]);
  assert.ok(first.privateKey instanceof Uint8Array && first.privateKey.some(byte => byte !== 0));
  assert.notEqual(first.privateKey.buffer, second.privateKey.buffer);
  assert.notEqual((await deriveWalletIdentity(await generateWalletMnemonic())).claim, first.claim);
});

test('the wallet identity refuses a checksum-invalid mnemonic and a passphrase-shaped string with wallet_mnemonic_invalid, and validation says false', async () => {
  const { deriveWalletIdentity, validateMnemonic } = await loadIdentity();
  for (const value of [CHECKSUM_INVALID_MNEMONIC, PASSPHRASE_SHAPED, '', undefined]) {
    assert.equal(validateMnemonic(value), false);
    await assert.rejects(deriveWalletIdentity(value), { code: 'wallet_mnemonic_invalid' });
  }
});

/** Runs `main` for init with the given identity seam and returns what it exited with and wrote. */
async function initThroughMain(dataDirectory, identity) {
  const { main } = await import('../src/cli/main.mjs');
  const out = { stdout: '', stderr: '' };
  const code = await main(['init', '--data-dir', dataDirectory], { identity, stdout: { write: text => { out.stdout += text; } }, stderr: { write: text => { out.stderr += text; } } });
  return { code, ...out };
}

test('init whose wallet cannot generate a mnemonic exits 1 with a closed code and leaves no key file', async t => {
  const dataDirectory = await dataDirectoryIn(t);
  const wallet = await loadIdentity();
  const failing = { ...wallet, generateWalletMnemonic: async () => { throw Object.assign(new Error('TEST wallet library unavailable'), { code: 'TEST_wallet_load_failed' }); } };
  const result = await initThroughMain(dataDirectory, failing);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^\{"code":"[a-z_]+"\}\n$/);
  assert.doesNotMatch(result.stderr, /TEST/);
  assert.deepEqual(await readdir(dataDirectory), []);
});

test('init whose wallet fails to derive after the key is stored keeps that key, prints no identity, and a rerun prints the stored key\'s identity', async t => {
  const dataDirectory = await dataDirectoryIn(t);
  const wallet = await loadIdentity();
  const failing = { ...wallet, deriveWalletIdentity: async () => { throw new Error('TEST derivation failed'); } };
  const failed = await initThroughMain(dataDirectory, failing);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, '');
  const keyText = await readFile(join(dataDirectory, 'seller-key.json'), 'utf8');
  const { mnemonic } = JSON.parse(keyText);
  assert.equal(failed.stderr.includes(mnemonic), false);
  const rerun = await initThroughMain(dataDirectory, wallet);
  const stored = await wallet.deriveWalletIdentity(mnemonic);
  assert.deepEqual([rerun.code, rerun.stdout, rerun.stderr], [0, `claim: ${stored.claim}\naddress: ${stored.address}\n`, '']);
  assert.equal(await readFile(join(dataDirectory, 'seller-key.json'), 'utf8'), keyText);
});

test('generating and deriving through the wallet identity prints nothing and loads no SQLite', () => {
  const script = `
    import { createRequire } from 'node:module';
    const { generateWalletMnemonic, deriveWalletIdentity } = await import(${JSON.stringify(IDENTITY_URL)});
    await deriveWalletIdentity(await generateWalletMnemonic());
    const loaded = Object.keys(createRequire(import.meta.url).cache).filter(path => /sqlite/i.test(path));
    process.stdout.write(JSON.stringify(loaded));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, cwd: fileURLToPath(new URL('..', import.meta.url)) });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout, '[]');
});
