import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCustody } from './helpers/operator-custody-fixture.mjs';

const ORIGIN = 'http://127.0.0.1:8787';
const SECRET = 'app-secret.json';
const ROLES = ['buyer', 'seller'];
const walletName = role => `${role}-wallet.json`;
const walletRecord = (role, mnemonic) => `${JSON.stringify({ format: 'dacs-node2-test-wallet/v1', role, address: `addr-${mnemonic.replace(/\W/g, '')}`.toLowerCase(), mnemonic, createdAt: '2026-01-01T00:00:00.000Z' })}\n`;
const secretRecord = () => `${JSON.stringify({ format: 'dacs-node2-operator-secret/v1', cookieKey: 'TEST-stored-cookie'.padEnd(43, '-') })}\n`;
const rewritesFiles = event => /^(write|link|unlink) /.test(event);
const credentialEvent = event => /^(readFile|write|link|unlink) /.test(event) && !event.includes('/.directory-sync-pending');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-custody-retained-sync-')));
  const directory = join(root, 'wallets');
  await mkdir(directory, { mode: 0o700 });
  const custody = await loadCustody();
  t.after(async () => { custody.release(); await rm(root, { recursive: true, force: true }); });
  return {
    ...custody,
    custody,
    root,
    directory,
    bootstrap: () => custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN }),
    secret: () => custody.ensureOperatorSecret({ directory }),
    openRole: async role => {
      const opened = await custody.openTestWalletCustody({ directory, role, publicOrigin: ORIGIN });
      try { return opened.signer.address; } finally { opened.close(); }
    },
  };
}

// The earlier bootstrap wrote whole records in place without syncing them.
async function writeLegacyPair(directory) {
  const records = Object.fromEntries(ROLES.map(role => [role, walletRecord(role, `TEST mnemonic ${role}`)]));
  for (const role of ROLES) await writeFile(join(directory, walletName(role)), records[role], { mode: 0o600 });
  return records;
}

for (const role of ROLES) {
  test(`${role} legacy wallet record is synced before bootstrap returns`, async (t) => {
    const { bootstrap, state, directory } = await fixture(t);
    const records = await writeLegacyPair(directory);
    await bootstrap();
    assert.ok(state.events.includes(`sync ${join(directory, walletName(role))}`));
    assert.equal(state.events.some(rewritesFiles), false);
    assert.equal(await readFile(join(directory, walletName(role)), 'utf8'), records[role]);
  });

  test(`${role} legacy wallet record sync failure refuses bootstrap and a retry syncs it`, async (t) => {
    const { bootstrap, state, directory } = await fixture(t);
    const records = await writeLegacyPair(directory);
    const path = join(directory, walletName(role));
    const failure = Object.assign(new Error('TEST record sync refused'), { code: 'EIO' });
    state.filesystemError = failure;
    state.failSync = candidate => candidate === path;
    await assert.rejects(bootstrap(), error => error === failure);
    assert.equal(await readFile(path, 'utf8'), records[role]);
    state.failSync = null;
    state.events.length = 0;
    await bootstrap();
    assert.ok(state.events.includes(`sync ${path}`));
    assert.equal(await readFile(path, 'utf8'), records[role]);
  });

  test(`opening a retained ${role} wallet syncs its record before returning the signer`, async (t) => {
    const { bootstrap, openRole, state, directory } = await fixture(t);
    await writeLegacyPair(directory);
    await bootstrap();
    state.events.length = 0;
    assert.equal(await openRole(role), `addr-testmnemonic${role}`);
    assert.ok(state.events.includes(`sync ${join(directory, walletName(role))}`));
  });

  test(`opening a retained ${role} wallet refuses when its record cannot be synced`, async (t) => {
    const { bootstrap, openRole, state, directory } = await fixture(t);
    await writeLegacyPair(directory);
    await bootstrap();
    const path = join(directory, walletName(role));
    const failure = Object.assign(new Error('TEST record sync refused'), { code: 'EIO' });
    state.filesystemError = failure;
    state.failSync = candidate => candidate === path;
    await assert.rejects(openRole(role), error => error === failure);
  });

  test(`publish-race winner ${role} wallet record is synced before bootstrap returns it`, async (t) => {
    const { bootstrap, state, directory } = await fixture(t);
    const path = join(directory, walletName(role));
    state.beforePublish = async candidate => { if (candidate === path) await writeFile(candidate, walletRecord(role, 'TEST mnemonic winner'), { mode: 0o600, flag: 'wx' }); };
    const result = await bootstrap();
    assert.equal(result.wallets.find(wallet => wallet.role === role).address, 'addr-testmnemonicwinner');
    assert.ok(state.events.includes(`sync ${path}`));
  });
}

test('retained operator secret is synced before it is returned', async (t) => {
  const { secret, state, directory } = await fixture(t);
  await writeFile(join(directory, SECRET), secretRecord(), { mode: 0o600 });
  assert.equal(await secret(), JSON.parse(secretRecord()).cookieKey);
  assert.ok(state.events.includes(`sync ${join(directory, SECRET)}`));
  assert.equal(state.events.some(rewritesFiles), false);
  assert.equal(await readFile(join(directory, SECRET), 'utf8'), secretRecord());
});

test('retained operator secret sync failure refuses the key and a retry syncs it', async (t) => {
  const { secret, state, directory } = await fixture(t);
  const path = join(directory, SECRET);
  await writeFile(path, secretRecord(), { mode: 0o600 });
  const failure = Object.assign(new Error('TEST secret sync refused'), { code: 'EIO' });
  state.filesystemError = failure;
  state.failSync = candidate => candidate === path;
  await assert.rejects(secret(), error => error === failure);
  assert.equal(await readFile(path, 'utf8'), secretRecord());
  state.failSync = null;
  state.events.length = 0;
  assert.equal(await secret(), JSON.parse(secretRecord()).cookieKey);
  assert.ok(state.events.includes(`sync ${path}`));
});

test('publish-race winner operator secret is synced before it is returned', async (t) => {
  const { secret, state, directory } = await fixture(t);
  const path = join(directory, SECRET);
  state.beforePublish = async candidate => { if (candidate === path) await writeFile(candidate, secretRecord(), { mode: 0o600, flag: 'wx' }); };
  assert.equal(await secret(), JSON.parse(secretRecord()).cookieKey);
  assert.ok(state.events.includes(`sync ${path}`));
});

// A killed mkdir leaves the new directories with no sync marker and no files.
async function killAfterMkdir(t, directory) {
  const child = fork(new URL('./helpers/operator-custody-mkdir-worker.mjs', import.meta.url), [directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  assert.deepEqual((await once(child, 'message'))[0], { stage: 'after-mkdir' });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
}

// Two new levels under an existing mode-0755 root; the stopped run created them.
async function stoppedBeforeMarker(t) {
  const run = await fixture(t);
  await chmod(run.root, 0o755);
  const first = join(run.root, 'first');
  const second = join(first, 'second');
  const directory = join(second, 'wallets');
  await killAfterMkdir(t, directory);
  return { ...run, directory, parents: [second, first, run.root] };
}

for (const [name, access] of [['wallets', run => run.custody.bootstrapTestWalletCustody({ directory: run.directory, publicOrigin: ORIGIN })], ['secret', run => run.custody.ensureOperatorSecret({ directory: run.directory })]]) {
  test(`${name} retry after a stop before the sync marker syncs every created parent`, async (t) => {
    const run = await stoppedBeforeMarker(t);
    await access(run);
    for (const parent of run.parents) assert.ok(run.state.events.includes(`sync ${parent}`), `parent ${parent} is synced`);
  });

  test(`${name} retry after a stop before the sync marker refuses a failed higher parent sync`, async (t) => {
    const run = await stoppedBeforeMarker(t);
    const higher = run.parents[1];
    const failure = Object.assign(new Error('TEST higher parent sync refused'), { code: 'EIO' });
    run.state.filesystemError = failure;
    run.state.failSync = candidate => candidate === higher;
    await assert.rejects(access(run), error => error === failure);
    assert.equal(run.state.events.some(credentialEvent), false);
    run.state.failSync = null;
    await access(run);
    assert.ok(run.state.events.includes(`sync ${higher}`));
  });
}
