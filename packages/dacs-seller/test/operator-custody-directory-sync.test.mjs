import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { loadCustody } from './helpers/operator-custody-fixture.mjs';

const ORIGIN = 'http://127.0.0.1:8787';
// The inherited retry marker records directory durability, not credentials.
const markerEvent = event => event.includes('/.directory-sync-pending');
const initializers = [
  ['wallet bootstrap', (custody, directory) => custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN })],
  ['operator secret', (custody, directory) => custody.ensureOperatorSecret({ directory })],
];

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-custody-directory-')));
  // Recursive mode-0700 mkdir cannot have made this pre-existing boundary.
  await chmod(root, 0o755);
  const custody = await loadCustody();
  t.after(async () => { custody.release(); await rm(root, { recursive: true, force: true }); });
  return { root, custody };
}

// A successful call must flush the real containing entries, deepest first,
// before it reads or creates credentials, including on a restart.
function assertParentsSynced(events, directory, boundary) {
  const firstCredentialAccess = events.findIndex(event => /^(readFile|write|link) /.test(event) && !markerEvent(event));
  const beforeCredentials = firstCredentialAccess < 0 ? events : events.slice(0, firstCredentialAccess);
  let previous = -1;
  for (let parent = dirname(directory); ; parent = dirname(parent)) {
    const synced = beforeCredentials.indexOf(`sync ${parent}`);
    assert.ok(synced > previous, `${parent} must be synced after its child and before credential access`);
    assert.ok(beforeCredentials.indexOf(`close ${parent}`, synced) > synced, `${parent} handle must be closed`);
    previous = synced;
    if (parent === boundary) break;
  }
  assert.equal(events.includes(`sync ${dirname(boundary)}`), false, 'stop after the known pre-existing boundary');
}

for (const [name, initialize] of initializers) {
  for (const components of [['wallets'], ['new', 'nested', 'wallets']]) {
    test(`${name} syncs every parent of ${components.length} newly created custody components`, async (t) => {
      const { root, custody } = await fixture(t);
      const directory = join(root, ...components);
      await initialize(custody, directory);
      assertParentsSynced(custody.state.events, directory, root);
      for (let count = 1; count <= components.length; count += 1) {
        assert.equal((await stat(join(root, ...components.slice(0, count)))).mode & 0o777, 0o700);
      }
    });
  }

  test(`${name} resyncs existing ancestors after a restart without replacing credentials`, async (t) => {
    const { root, custody } = await fixture(t);
    const directory = join(root, 'new', 'wallets');
    const first = await initialize(custody, directory);
    const names = await readdir(directory);
    const contents = await Promise.all(names.map(file => readFile(join(directory, file), 'utf8')));
    const restarted = await loadCustody();
    t.after(restarted.release);
    const second = await initialize(restarted, directory);
    assert.deepEqual(second, first);
    assertParentsSynced(restarted.state.events, directory, root);
    assert.deepEqual(restarted.state.mkdirCreated, [undefined]);
    assert.deepEqual(await Promise.all(names.map(file => readFile(join(directory, file), 'utf8'))), contents);
    assert.equal(restarted.state.generated, 0);
    assert.equal(restarted.state.events.some(event => /^(write|link|unlink) /.test(event)), false);
  });

  test(`${name} syncs parents when another caller created the directory first`, async (t) => {
    const { root, custody } = await fixture(t);
    const directory = join(root, 'new', 'wallets');
    custody.state.beforeMkdir = path => mkdir(path, { recursive: true, mode: 0o700 });
    await initialize(custody, directory);
    assert.deepEqual(custody.state.mkdirCreated, [undefined]);
    assertParentsSynced(custody.state.events, directory, root);
  });

  for (const phase of ['open', 'sync']) {
    for (const depth of ['immediate', 'higher']) {
      test(`${name} refuses a ${depth} parent ${phase} failure and retries it after restart`, async (t) => {
        const { root, custody } = await fixture(t);
        const directory = join(root, 'new', 'wallets');
        const failedParent = depth === 'immediate' ? dirname(directory) : root;
        const failure = Object.assign(new Error(`TEST parent ${phase} refused`), { code: 'EIO' });
        custody.state.filesystemError = failure;
        custody.state[phase === 'open' ? 'failOpen' : 'failSync'] = path => path === failedParent;
        await assert.rejects(initialize(custody, directory), error => error === failure);
        assert.equal(custody.state.generated, 0);
        assert.deepEqual((await readdir(directory)).filter(name => name !== '.directory-sync-pending'), []);
        if (phase === 'sync') {
          const events = custody.state.events;
          assert.ok(events.indexOf(`close ${failedParent}`) > events.indexOf(`sync ${failedParent}`));
        }
        const restarted = await loadCustody();
        t.after(restarted.release);
        await initialize(restarted, directory);
        assert.deepEqual(restarted.state.mkdirCreated, [undefined]);
        assertParentsSynced(restarted.state.events, directory, root);
      });
    }
  }

  test(`${name} refuses a shared custody endpoint before syncing ancestors`, async (t) => {
    const { root, custody } = await fixture(t);
    const directory = join(root, 'wallets');
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o755);
    await assert.rejects(initialize(custody, directory), /private real mode-0700/);
    assert.equal(custody.state.events.some(event => event.startsWith('sync ')), false);
    assert.equal(custody.state.generated, 0);
    assert.deepEqual(await readdir(directory), []);
  });
}

test('wallet opening resyncs the parents of existing custody before returning a signer', async (t) => {
  const { root, custody } = await fixture(t);
  const directory = join(root, 'new', 'wallets');
  const bootstrapped = await custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN });
  const restarted = await loadCustody();
  t.after(restarted.release);
  const opened = await restarted.openTestWalletCustody({ directory, role: 'buyer', publicOrigin: ORIGIN });
  t.after(opened.close);
  assert.equal(opened.signer.address, bootstrapped.wallets[0].address);
  assertParentsSynced(restarted.state.events, directory, root);
});

test('wallet opening syncs newly created parents and still refuses a missing wallet', async (t) => {
  const { root, custody } = await fixture(t);
  const directory = join(root, 'new', 'wallets');
  await assert.rejects(custody.openTestWalletCustody({ directory, role: 'buyer', publicOrigin: ORIGIN }), { code: 'ENOENT' });
  assertParentsSynced(custody.state.events, directory, root);
  assert.deepEqual(await readdir(directory), []);
});

test('wallet opening propagates a parent sync failure before reading a retained wallet', async (t) => {
  const { root, custody } = await fixture(t);
  const directory = join(root, 'new', 'wallets');
  await custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN });
  const failure = Object.assign(new Error('TEST opening parent sync refused'), { code: 'EIO' });
  custody.state.events.length = 0;
  custody.state.filesystemError = failure;
  custody.state.failSync = path => path === root;
  await assert.rejects(custody.openTestWalletCustody({ directory, role: 'buyer', publicOrigin: ORIGIN }), error => error === failure);
  assert.equal(custody.state.events.some(event => event.startsWith('readFile ') && !markerEvent(event)), false);
});

test('relative custody paths sync their resolved parents', async (t) => {
  const { root, custody } = await fixture(t);
  const directory = join(root, 'new', 'wallets');
  await custody.ensureOperatorSecret({ directory: relative(process.cwd(), directory) });
  assertParentsSynced(custody.state.events, directory, root);
});

test('an accepted ancestor alias syncs the canonical parents of the new custody directory', async (t) => {
  const { root, custody } = await fixture(t);
  const target = join(root, 'actual');
  const alias = join(root, 'alias');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, alias);
  await custody.ensureOperatorSecret({ directory: join(alias, 'new', 'wallets') });
  assertParentsSynced(custody.state.events, join(target, 'new', 'wallets'), root);
  assert.equal(custody.state.events.some(event => event.startsWith(`sync ${alias}`)), false);
});
