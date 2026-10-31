import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadCustody } from './helpers/operator-custody-fixture.mjs';

const ORIGIN = 'http://127.0.0.1:8787';
const bootstrap = (custody, directory) => custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN });
const secret = (custody, directory) => custody.ensureOperatorSecret({ directory });
const openWallet = role => async (custody, directory) => {
  const opened = await custody.openTestWalletCustody({ directory, role, publicOrigin: ORIGIN });
  try { return opened.signer.address; } finally { opened.close(); }
};
const operations = [
  ['new wallets', bootstrap, false], ['retained wallets', bootstrap, true],
  ['new secret', secret, false], ['retained secret', secret, true],
  ['buyer open', openWallet('buyer'), true], ['seller open', openWallet('seller'), true],
];
const credentialEvent = event => /^(readFile|write|link|unlink) /.test(event) && !event.includes('/.directory-sync-pending');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-custody-parent-durability-')));
  const directory = join(root, 'outer', 'wallets');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(root, 0o755);
  const custody = await loadCustody();
  t.after(async () => {
    await chmod(root, 0o700);
    await chmod(dirname(directory), 0o700);
    custody.release();
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, custody };
}

async function snapshot(directory) {
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map(async name => [name, await readFile(join(directory, name), 'utf8')]));
}

// These paths already exist without a marker, as they do after a killed mkdir.
// Inject the OS error as well as changing mode so the tests also work as root.
for (const [name, access, retained] of operations) {
  for (const depth of ['immediate', 'higher']) {
    for (const phase of ['open', 'sync']) {
      test(`${name} refuses an unreadable ${depth} parent ${phase} failure before credential access`, async (t) => {
        const { root, directory, custody } = await fixture(t);
        if (retained) { await bootstrap(custody, directory); await secret(custody, directory); }
        const before = await snapshot(directory);
        const generated = custody.state.generated;
        const parent = depth === 'immediate' ? dirname(directory) : root;
        const failure = Object.assign(new Error(`TEST parent ${phase} refused`), { code: phase === 'open' ? 'EACCES' : 'EIO' });
        custody.state.events.length = 0;
        custody.state.filesystemError = failure;
        custody.state[phase === 'open' ? 'failOpen' : 'failSync'] = path => path === parent;
        if (phase === 'open') await chmod(parent, depth === 'immediate' ? 0o300 : 0o311);
        // Keep the real directory readable so fsync failure is independently
        // exercised; its stat still exposes the old unreadable-parent bypass.
        else custody.state.afterLstat = (path, info) => { if (path === parent) info.mode &= ~0o400; };
        try {
          await assert.rejects(access(custody, directory), error => error === failure);
          assert.ok(custody.state.events.includes(`open ${parent} r`));
          assert.equal(custody.state.events.some(credentialEvent), false);
          assert.equal(custody.state.generated, generated);
          if (phase === 'sync') assert.ok(custody.state.events.includes(`close ${parent}`));
        } finally {
          await chmod(parent, depth === 'immediate' ? 0o700 : 0o755);
          custody.state.afterLstat = null;
        }
        assert.deepEqual(await snapshot(directory), before);
        const restarted = await loadCustody();
        t.after(restarted.release);
        await access(restarted, directory);
        assert.ok(restarted.state.events.includes(`sync ${parent}`));
        if (retained) assert.deepEqual(await snapshot(directory), before);
      });
    }
  }
}

for (const readable of [false, true]) {
  test(`restart after SIGKILL before the directory marker ${readable ? 'syncs a readable parent' : 'refuses an unreadable parent'}`, { timeout: 15000 }, async (t) => {
    const { directory, custody } = await fixture(t);
    await rm(directory, { recursive: true });
    const child = fork(new URL('./helpers/operator-custody-mkdir-worker.mjs', import.meta.url), [directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    assert.deepEqual((await once(child, 'message'))[0], { stage: 'after-mkdir' });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    assert.deepEqual(await readdir(directory), [], 'mkdir completed without a marker or credentials');
    const parent = dirname(directory);
    if (!readable) {
      await chmod(parent, 0o300);
      if (process.getuid?.() === 0) {
        custody.state.filesystemError = Object.assign(new Error('TEST parent open refused'), { code: 'EACCES' });
        custody.state.failOpen = path => path === parent;
      }
      try {
        await assert.rejects(secret(custody, directory), { code: 'EACCES' });
        assert.equal(custody.state.events.some(credentialEvent), false);
      } finally { await chmod(parent, 0o700); custody.state.failOpen = null; }
    }
    await secret(custody, directory);
    assert.ok(custody.state.events.includes(`sync ${parent}`));
  });
}

// Repair calls the same admission again on .wallet-repair. A failed containing
// sync there must precede the destructive empty-file repair for either role.
for (const role of ['buyer', 'seller']) {
  test(`${role} legacy repair refuses a containing-parent failure before deleting the empty record`, async (t) => {
    const { directory, custody } = await fixture(t);
    await bootstrap(custody, directory);
    const path = join(directory, `${role}-wallet.json`);
    const other = join(directory, `${role === 'buyer' ? 'seller' : 'buyer'}-wallet.json`);
    const retained = await readFile(other, 'utf8');
    await writeFile(path, '', { mode: 0o600 });
    await mkdir(join(directory, '.wallet-repair'), { mode: 0o700 });
    const failure = Object.assign(new Error('TEST repair parent sync refused'), { code: 'EIO' });
    custody.state.events.length = 0;
    custody.state.filesystemError = failure;
    custody.state.failSync = candidate => candidate === directory;
    custody.state.beforeMkdir = candidate => {
      if (candidate === join(directory, '.wallet-repair')) {
        custody.state.afterLstat = (parent, info) => { if (parent === directory) info.mode &= ~0o400; };
      }
    };
    await assert.rejects(bootstrap(custody, directory), error => error === failure);
    assert.equal(custody.state.events.includes(`unlink ${path}`), false);
    assert.equal(await readFile(path, 'utf8'), '');
    assert.equal(await readFile(other, 'utf8'), retained);
    custody.state.failSync = null;
    custody.state.beforeMkdir = null;
    custody.state.afterLstat = null;
    await bootstrap(custody, directory);
    assert.notEqual(await readFile(path, 'utf8'), '');
    assert.equal(await readFile(other, 'utf8'), retained);
  });
}
