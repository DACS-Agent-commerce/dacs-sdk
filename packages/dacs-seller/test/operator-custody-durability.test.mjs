import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCustody } from './helpers/operator-custody-fixture.mjs';

const ORIGIN = 'http://127.0.0.1:8787';
const BUYER = 'buyer-wallet.json';
const SELLER = 'seller-wallet.json';
const SECRET = 'app-secret.json';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-custody-durability-'));
  const custody = await loadCustody();
  t.after(async () => { custody.release(); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, 'wallets');
  await mkdir(directory, { mode: 0o700 });
  return { ...custody, directory, bootstrap: () => custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN }) };
}
const files = async (directory) => (await readdir(directory)).sort();
const read = (directory, name) => readFile(join(directory, name), 'utf8');
const record = (role, mnemonic) => `${JSON.stringify({ format: 'dacs-node2-test-wallet/v1', role, address: `addr-${mnemonic.replace(/\W/g, '')}`, mnemonic, createdAt: '2026-01-01T00:00:00.000Z' })}\n`;
const orderOf = (events, text) => events.findIndex((event) => event === text);

test('a write failure leaves no wallet file at the final path and no temporary file', async (t) => {
  const { bootstrap, state, directory } = await fixture(t);
  state.failWrite = (path) => path.includes(BUYER);
  await assert.rejects(bootstrap(), /TEST disk full/);
  assert.deepEqual(await files(directory), []);
});

test('a key-generation failure for the second role leaves the first role whole and no second file', async (t) => {
  const { bootstrap, state, directory } = await fixture(t);
  state.failGenerationAt = 2;
  await assert.rejects(bootstrap(), /TEST key generation failed/);
  assert.deepEqual(await files(directory), [BUYER]);
  assert.equal(JSON.parse(await read(directory, BUYER)).role, 'buyer');
});

test('bootstrap resumes a pair that has only the buyer file and keeps the buyer mnemonic', async (t) => {
  const { bootstrap, state, directory } = await fixture(t);
  state.failGenerationAt = 2;
  await assert.rejects(bootstrap(), /TEST key generation failed/);
  const buyerBefore = await read(directory, BUYER);
  state.failGenerationAt = null;
  const result = await bootstrap();
  assert.deepEqual(result.wallets.map((wallet) => wallet.role), ['buyer', 'seller']);
  assert.equal(await read(directory, BUYER), buyerBefore);
  assert.equal(result.wallets[0].address, JSON.parse(buyerBefore).address);
  assert.equal(JSON.parse(await read(directory, SELLER)).role, 'seller');
  assert.deepEqual(await files(directory), [BUYER, SELLER]);
});

test('a repeated bootstrap returns the same wallets and writes nothing', async (t) => {
  const { bootstrap, state, directory } = await fixture(t);
  const first = await bootstrap();
  const contents = [await read(directory, BUYER), await read(directory, SELLER)];
  state.events.length = 0;
  const second = await bootstrap();
  assert.deepEqual(second.wallets.map(({ role, address, path }) => ({ role, address, path })), first.wallets.map(({ role, address, path }) => ({ role, address, path })));
  assert.deepEqual([await read(directory, BUYER), await read(directory, SELLER)], contents);
  assert.deepEqual(state.events.filter((event) => /^(write|link|unlink) /.test(event)), []);
});

test('an existing role file is never replaced when another writer publishes first', async (t) => {
  const { bootstrap, state, directory } = await fixture(t);
  const winner = record('buyer', 'TEST mnemonic other');
  state.beforePublish = async (path) => { if (path.endsWith(BUYER)) await writeFile(path, winner, { mode: 0o600, flag: 'wx' }); };
  const result = await bootstrap();
  assert.equal(await read(directory, BUYER), winner);
  assert.equal(result.wallets[0].address, 'addr-TESTmnemonicother');
  assert.deepEqual(await files(directory), [BUYER, SELLER]);
});

for (const [name, content] of [
  ['names the other role', record('seller', 'TEST mnemonic other')],
  ['is not JSON', '{"format":"dacs-node2-test-wallet/v1","role":"buy'],
  ['has no mnemonic', `${JSON.stringify({ format: 'dacs-node2-test-wallet/v1', role: 'buyer', address: 'addr-x' })}\n`],
]) {
  test(`a buyer file that ${name} is refused and left in place`, async (t) => {
    const { bootstrap, directory } = await fixture(t);
    await writeFile(join(directory, BUYER), content, { mode: 0o600 });
    await assert.rejects(bootstrap(), /buyer custody record is malformed/);
    assert.equal(await read(directory, BUYER), content);
    assert.deepEqual(await files(directory), [BUYER]);
  });
}

test('an empty role file left by the earlier bootstrap is replaced', async (t) => {
  const { bootstrap, directory } = await fixture(t);
  await writeFile(join(directory, BUYER), '', { mode: 0o600 });
  const result = await bootstrap();
  assert.equal(JSON.parse(await read(directory, BUYER)).address, result.wallets[0].address);
  assert.deepEqual(await files(directory), [BUYER, SELLER]);
});

test('bootstrap syncs each file before publishing it and the directory after', async (t) => {
  const { bootstrap, directory, normalized } = await fixture(t);
  await bootstrap();
  const events = normalized(directory);
  for (const name of [BUYER, SELLER]) {
    const synced = orderOf(events, `sync <dir>/${name}.tmp`);
    const linked = orderOf(events, `link <dir>/${name}.tmp <dir>/${name}`);
    assert.ok(synced >= 0 && synced < linked, `${name} content is synced before it gets its name`);
    assert.ok(events.indexOf('sync <dir>', linked) > linked, `${name} directory entry is synced after it is published`);
  }
  assert.equal(events.filter((event) => event.startsWith('sync ')).at(-1), 'sync <dir>');
});

test('a resumed bootstrap syncs the directory before it returns', async (t) => {
  const { bootstrap, state, directory, normalized } = await fixture(t);
  await bootstrap();
  state.events.length = 0;
  await bootstrap();
  assert.ok(normalized(directory).includes('sync <dir>'));
});

test('the operator secret is synced, then published whole, then its directory is synced', async (t) => {
  const { ensureOperatorSecret, directory, normalized } = await fixture(t);
  const key = await ensureOperatorSecret({ directory });
  const events = normalized(directory);
  const synced = orderOf(events, `sync <dir>/${SECRET}.tmp`);
  const linked = orderOf(events, `link <dir>/${SECRET}.tmp <dir>/${SECRET}`);
  assert.ok(synced >= 0 && synced < linked, 'content is synced before the secret gets its name');
  assert.ok(events.indexOf('sync <dir>', linked) > linked, 'directory entry is synced after it is published');
  assert.equal(JSON.parse(await read(directory, SECRET)).cookieKey, key);
  assert.deepEqual(await files(directory), [SECRET]);
});

test('ensureOperatorSecret returns the stored key when another writer published first', async (t) => {
  const { ensureOperatorSecret, state, directory } = await fixture(t);
  const winner = `${JSON.stringify({ format: 'dacs-node2-operator-secret/v1', cookieKey: 'TEST-stored-cookie'.padEnd(43, '-') })}\n`;
  state.beforePublish = async (path) => { if (path.endsWith(SECRET)) await writeFile(path, winner, { mode: 0o600, flag: 'wx' }); };
  assert.equal(await ensureOperatorSecret({ directory }), 'TEST-stored-cookie'.padEnd(43, '-'));
  assert.equal(await read(directory, SECRET), winner);
});

test('a write failure leaves no operator secret file at the final path and no temporary file', async (t) => {
  const { ensureOperatorSecret, state, directory } = await fixture(t);
  state.failWrite = (path) => path.includes(SECRET);
  await assert.rejects(ensureOperatorSecret({ directory }), /TEST disk full/);
  assert.deepEqual(await files(directory), []);
});

test('wallet and secret files are mode 0600', async (t) => {
  const { bootstrap, ensureOperatorSecret, directory } = await fixture(t);
  await bootstrap();
  await ensureOperatorSecret({ directory });
  for (const name of [BUYER, SELLER, SECRET]) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600, name);
});

test('publishFileExclusive reports false and leaves an existing file unchanged', async (t) => {
  const { directory } = await fixture(t);
  const { publishFileExclusive } = await import('../src/devnet-demo/durable-file.mjs');
  const path = join(directory, 'existing.json');
  assert.equal(await publishFileExclusive(path, 'first\n'), true);
  assert.equal(await publishFileExclusive(path, 'second\n'), false);
  assert.equal(await readFile(path, 'utf8'), 'first\n');
  assert.deepEqual(await files(directory), ['existing.json']);
});
