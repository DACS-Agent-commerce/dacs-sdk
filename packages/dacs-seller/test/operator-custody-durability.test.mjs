import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
const record = (role, mnemonic) => `${JSON.stringify({ format: 'dacs-node2-test-wallet/v1', role, address: `addr-${mnemonic.replace(/\W/g, '')}`.toLowerCase(), mnemonic, createdAt: '2026-01-01T00:00:00.000Z' })}\n`;
const orderOf = (events, text) => events.findIndex((event) => event === text);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

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
  assert.equal(result.wallets[0].address, 'addr-testmnemonicother');
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
  assert.deepEqual(await files(directory), ['.wallet-repair', BUYER, SELLER]);
  assert.equal((await stat(join(directory, '.wallet-repair'))).mode & 0o777, 0o700);
});

test('a new custody directory is synced in every parent this bootstrap creates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-custody-parent-'));
  const custody = await loadCustody();
  t.after(async () => { custody.release(); await rm(root, { recursive: true, force: true }); });
  const one = join(root, 'one'), two = join(one, 'two'), directory = join(two, 'wallets');
  await custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN });
  const events = custody.state.events;
  for (const parent of [root, one, two]) {
    assert.ok(events.includes(`sync ${parent}`), `the new directory's name must be synced in ${parent}`);
  }
});

test('an oversized role file is refused before it is parsed', async (t) => {
  const { bootstrap, directory } = await fixture(t);
  const content = 'x'.repeat(64 * 1024 + 1);
  await writeFile(join(directory, BUYER), content, { mode: 0o600 });
  await assert.rejects(bootstrap(), /buyer custody record is larger than 65536 bytes/);
  assert.equal(await read(directory, BUYER), content);
});

test('an empty role file with unsafe permissions is refused, not replaced', async (t) => {
  const { bootstrap, directory } = await fixture(t);
  await writeFile(join(directory, BUYER), '', { mode: 0o600 });
  await chmod(join(directory, BUYER), 0o644);
  await assert.rejects(bootstrap(), /must be private real mode-0600 files/);
  assert.equal(await read(directory, BUYER), '');
  assert.deepEqual((await files(directory)).filter((name) => name !== '.wallet-repair'), [BUYER]);
});

test('bootstrap and secret initialization do not open ancestors they did not create', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-custody-ancestor-'));
  const custody = await loadCustody();
  const outer = join(root, 'outer'), directory = join(outer, 'wallets');
  t.after(async () => { await chmod(outer, 0o700).catch(() => {}); custody.release(); await rm(root, { recursive: true, force: true }); });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // `outer` is an established ancestor: it must not be opened for syncing,
  // because a directory that cannot be read is still a usable parent.
  await chmod(outer, 0o300);
  try {
    const result = await custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN });
    assert.deepEqual(result.wallets.map((wallet) => wallet.role), ['buyer', 'seller']);
    const key = await custody.ensureOperatorSecret({ directory });
    assert.equal(JSON.parse(await read(directory, SECRET)).cookieKey, key);
  } finally { await chmod(outer, 0o700); }
  assert.deepEqual(await files(directory).then((names) => names.filter((name) => name !== '.wallet-repair')), [SECRET, BUYER, SELLER].sort());
});

test('a failed directory-name marker removes created directories so a retry syncs their names', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-custody-marker-'));
  const custody = await loadCustody();
  t.after(async () => { custody.release(); await rm(root, { recursive: true, force: true }); });
  const one = join(root, 'one'), directory = join(one, 'wallets');
  custody.state.failWrite = (path) => path.includes('.directory-sync-pending');
  await assert.rejects(custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN }), /TEST disk full/);
  assert.deepEqual(await files(root), [], 'nothing remains that a retry could mistake for an established directory');
  custody.state.failWrite = null; custody.state.events.length = 0;
  await custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN });
  for (const parent of [root, one]) {
    assert.ok(custody.state.events.includes(`sync ${parent}`), `the retry must sync ${parent}`);
  }
});

test('a retry after a failed parent sync makes every created directory name durable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-custody-parent-retry-'));
  const custody = await loadCustody();
  t.after(async () => { custody.release(); await rm(root, { recursive: true, force: true }); });
  const one = join(root, 'one'), directory = join(one, 'wallets');
  custody.state.failSync = (path) => path === root;
  await assert.rejects(custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN }), /TEST sync failed/);
  custody.state.failSync = null; custody.state.events.length = 0;
  await custody.bootstrapTestWalletCustody({ directory, publicOrigin: ORIGIN });
  for (const parent of [root, one]) {
    assert.ok(custody.state.events.includes(`sync ${parent}`), `the retry must sync ${parent} again`);
  }
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

for (const role of ['buyer', 'seller']) {
  test(`a stale empty ${role} observation is rechecked after a competing repair completes`, async (t) => {
    const { bootstrap, state, directory } = await fixture(t);
    const path = join(directory, `${role}-wallet.json`), paused = deferred(), resume = deferred();
    const other = role === 'buyer' ? 'seller' : 'buyer';
    await writeFile(join(directory, `${other}-wallet.json`), record(other, 'TEST mnemonic retained'), { mode: 0o600 });
    await writeFile(path, '', { mode: 0o600 });
    let delayed = false;
    state.afterLstat = async (candidate, info) => {
      if (candidate !== path || info.size !== 0 || delayed) return;
      delayed = true; paused.resolve(); await resume.promise;
    };
    const first = bootstrap();
    await Promise.race([paused.promise, first.then(() => assert.fail('TEST repair did not pause'))]);
    let second, bytes;
    try { second = await bootstrap(); bytes = await readFile(path, 'utf8'); } finally { resume.resolve(); }
    const result = await first;
    assert.deepEqual(result.wallets.map(({ address }) => address), second.wallets.map(({ address }) => address));
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.equal(state.generated, 1, 'the delayed repair keeps the whole winner');
  });

  for (const interrupted of [false, true]) {
    test(`overlapping ${role} empty-file repairs preserve every returned wallet${interrupted ? ' when the delayed repair fails' : ''}`, async (t) => {
      const { bootstrap, state, directory } = await fixture(t);
      const path = join(directory, `${role}-wallet.json`), paused = deferred(), resume = deferred();
      // Only this role needs repair; the other must also remain byte-identical.
      const other = role === 'buyer' ? 'seller' : 'buyer';
      await writeFile(join(directory, `${other}-wallet.json`), record(other, 'TEST mnemonic retained'), { mode: 0o600 });
      await writeFile(path, '', { mode: 0o600 });
      let delayed = false;
      state.beforeUnlink = async (candidate) => {
        if (candidate !== path || delayed) return;
        delayed = true; paused.resolve(); await resume.promise;
        if (interrupted) state.failGenerationAt = state.generated + 1;
      };
      const capture = (work) => work.then((value) => ({ value }), (error) => ({ error }));
      const first = capture(bootstrap());
      await Promise.race([paused.promise, first.then(() => assert.fail('TEST repair did not pause'))]);
      let second;
      try { second = await capture(bootstrap()); } finally { resume.resolve(); }
      const initial = await first;
      if (second.error) assert.equal(second.error.reason, 'held');
      if (interrupted) assert.match(initial.error?.message ?? '', /TEST key generation failed/);
      else assert.ifError(initial.error);
      state.failGenerationAt = null;
      const retry = await bootstrap();
      const retained = JSON.parse(await readFile(path, 'utf8'));
      for (const result of [initial.value, second.value, retry].filter(Boolean)) {
        assert.equal(result.wallets.find((wallet) => wallet.role === role).address, retained.address);
      }
      assert.equal(await read(directory, `${other}-wallet.json`), record(other, 'TEST mnemonic retained'));
    });
  }

  test(`an exited process releases ${role} legacy repair for restart without changing retained wallets`, { timeout: 15000 }, async (t) => {
    const { bootstrap, directory } = await fixture(t);
    const other = role === 'buyer' ? 'seller' : 'buyer';
    await writeFile(join(directory, `${other}-wallet.json`), record(other, 'TEST mnemonic retained'), { mode: 0o600 });
    await writeFile(join(directory, `${role}-wallet.json`), '', { mode: 0o600 });
    const child = fork(new URL('./helpers/operator-custody-repair-worker.mjs', import.meta.url), [directory, role], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    assert.deepEqual((await once(child, 'message'))[0], { stage: 'before-unlink' });
    let contention;
    try { await bootstrap(); } catch (error) { contention = error; }
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const recovered = await bootstrap();
    const repeat = await bootstrap();
    assert.equal(contention?.reason, 'held', 'a live repair is refused before touching its role file');
    assert.deepEqual(recovered.wallets.map(({ address }) => address), repeat.wallets.map(({ address }) => address));
    assert.equal(await read(directory, `${other}-wallet.json`), record(other, 'TEST mnemonic retained'));
  });

  for (const [name, change] of [
    ['empty mnemonic', { mnemonic: '', address: 'addr-' }],
    ['malformed mnemonic', { mnemonic: 'TEST invalid phrase', address: 'addr-testinvalidphrase' }],
    ['mismatched address', { address: 'addr-TESTwrong' }],
    ['empty address', { address: '' }],
  ]) {
    for (const route of ['existing', 'publish winner', 'open']) {
      test(`${role} ${route} refuses and preserves a record with ${name}`, async (t) => {
        const { bootstrap, openTestWalletCustody, state, directory } = await fixture(t);
        const path = join(directory, `${role}-wallet.json`);
        const content = `${JSON.stringify({ ...JSON.parse(record(role, 'TEST mnemonic retained')), ...change })}\n`;
        if (route === 'publish winner') {
          state.beforePublish = async (candidate) => { if (candidate === path) await writeFile(path, content, { mode: 0o600, flag: 'wx' }); };
        } else await writeFile(path, content, { mode: 0o600 });
        const work = route === 'open' ? () => openTestWalletCustody({ directory, role, publicOrigin: ORIGIN }) : bootstrap;
        await assert.rejects(work(), new RegExp(`${role} custody record is malformed`));
        assert.equal(await readFile(path, 'utf8'), content);
      });
    }
  }

  test(`${role} open preserves a JSON parse error as the malformed record's cause`, async (t) => {
    const { openTestWalletCustody, directory } = await fixture(t);
    const content = '{TEST incomplete JSON';
    await writeFile(join(directory, `${role}-wallet.json`), content, { mode: 0o600 });
    await assert.rejects(openTestWalletCustody({ directory, role, publicOrigin: ORIGIN }), (error) => {
      assert.match(error.message, new RegExp(`${role} custody record is malformed`));
      assert.ok(error.cause instanceof SyntaxError); return true;
    });
    assert.equal(await read(directory, `${role}-wallet.json`), content);
  });
}

for (const failure of ['failValidation', 'failConnect']) {
  test(`stored wallet ${failure} is refused with its cause and leaves the record intact`, async (t) => {
    const { bootstrap, state, directory } = await fixture(t);
    const content = record('buyer', 'TEST mnemonic retained');
    await writeFile(join(directory, BUYER), content, { mode: 0o600 });
    const cause = new Error(`TEST ${failure}`); state[failure] = cause;
    await assert.rejects(bootstrap(), (error) => {
      assert.match(error.message, /buyer custody record is malformed/);
      assert.equal(error.cause, cause); return true;
    });
    assert.equal(await read(directory, BUYER), content);
  });
}

test('stored address checking disconnects the probe even on a mismatch', async (t) => {
  const { bootstrap, state, directory } = await fixture(t);
  await writeFile(join(directory, BUYER), record('buyer', 'TEST mnemonic retained').replace('addr-testmnemonicretained', 'addr-testwrong'), { mode: 0o600 });
  await assert.rejects(bootstrap(), /buyer custody record is malformed/);
  assert.equal(state.disconnected, 1);
});

const secretRecord = () => `${JSON.stringify({ format: 'dacs-node2-operator-secret/v1', cookieKey: 'TEST-stored-cookie'.padEnd(43, '-') })}\n`;

test('a secret publish-race loser syncs the winner before returning it', async (t) => {
  const { ensureOperatorSecret, state, directory, normalized } = await fixture(t);
  const winner = secretRecord();
  state.beforePublish = async (path) => {
    if (!path.endsWith(SECRET)) return;
    // Winner has synced its contents and linked its name, but not synced its directory.
    await writeFile(path, winner, { mode: 0o600, flag: 'wx' });
  };
  assert.equal(await ensureOperatorSecret({ directory }), JSON.parse(winner).cookieKey);
  const events = normalized(directory), linked = orderOf(events, `link <dir>/${SECRET}.tmp <dir>/${SECRET}`);
  assert.ok(events.indexOf('sync <dir>', linked) > linked);
  assert.equal(await read(directory, SECRET), winner);
});

test('restart with a whole linked secret syncs its directory before returning the stored key', async (t) => {
  const { ensureOperatorSecret, state, directory, normalized } = await fixture(t);
  const content = secretRecord();
  await writeFile(join(directory, SECRET), content, { mode: 0o600 });
  assert.equal(await ensureOperatorSecret({ directory }), JSON.parse(content).cookieKey);
  assert.ok(normalized(directory).includes('sync <dir>'));
  assert.deepEqual(state.events.filter((event) => /^(write|link|unlink) /.test(event)), []);
  assert.equal(await read(directory, SECRET), content);
});

for (const route of ['new', 'existing', 'publish winner']) {
  test(`${route} secret directory-sync failure cannot become a successful unsynced retry`, async (t) => {
    const { ensureOperatorSecret, state, directory, normalized } = await fixture(t);
    if (route === 'existing') await writeFile(join(directory, SECRET), secretRecord(), { mode: 0o600 });
    if (route === 'publish winner') state.beforePublish = async (path) => { if (path.endsWith(SECRET)) await writeFile(path, secretRecord(), { mode: 0o600, flag: 'wx' }); };
    state.failSync = (path) => path === directory;
    await assert.rejects(ensureOperatorSecret({ directory }), /TEST sync failed/);
    const published = await read(directory, SECRET);
    // Repeated failure must also refuse, rather than trusting the existing entry.
    await assert.rejects(ensureOperatorSecret({ directory }), /TEST sync failed/);
    state.failSync = null; state.events.length = 0;
    assert.equal(await ensureOperatorSecret({ directory }), JSON.parse(published).cookieKey);
    assert.ok(normalized(directory).includes('sync <dir>'));
    assert.equal(await read(directory, SECRET), published);
  });
}

for (const credential of ['wallet', 'secret']) {
  test(`${credential} file-sync failure publishes nothing and a retry succeeds`, async (t) => {
    const { bootstrap, ensureOperatorSecret, state, directory } = await fixture(t);
    const run = credential === 'wallet' ? bootstrap : () => ensureOperatorSecret({ directory });
    state.failSync = (path) => path.endsWith('.tmp');
    await assert.rejects(run(), /TEST sync failed/);
    assert.deepEqual(await files(directory), []);
    state.failSync = null;
    await run();
  });
}

test('wallet retry after failed directory sync keeps the published mnemonic and syncs again', async (t) => {
  const { bootstrap, state, directory, normalized } = await fixture(t);
  state.failSync = (path) => path === directory;
  await assert.rejects(bootstrap(), /TEST sync failed/);
  const buyer = await read(directory, BUYER);
  state.failSync = null; state.events.length = 0;
  await bootstrap();
  assert.equal(await read(directory, BUYER), buyer);
  assert.ok(normalized(directory).includes('sync <dir>'));
});
