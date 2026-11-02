// The seller's party Vet store (src/devnet-demo/party-vet-store.mjs): its own
// SQLite file, atomic synchronous changes, deletion, explicit capacity and
// integrity checks. Local files only.
import test from 'node:test';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { createInMemoryPartyVetStore, openPartyVetStore, PARTY_VET_STORE_LIMITS } from '../src/devnet-demo/party-vet-store.mjs';

const WORKER = fileURLToPath(new URL('./helpers/party-vet-store-worker.mjs', import.meta.url));
const dirFor = (t) => { const dir = mkdtempSync(join(tmpdir(), 'party-vet-store-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
// Opens an existing file, or creates a missing one: the mode a caller must name.
const openStore = (options) => openPartyVetStore({ mode: existsSync(options.path) ? 'open' : 'create', ...options });
const code = (expected) => (error) => error?.code === expected;

test('party Vet paths with trailing whitespace are refused before touching files', async t => {
  const directory = dirFor(t), path = join(directory, 'party vet.sqlite');
  const store = openStore({ path }); t.after(() => store.close());
  await store.update('job', () => ({ checkpoint: 'TEST-complete' }));
  const before = readdirSync(directory).sort();
  for (const suffix of [' ', '\t', '\n', '\r', '\u00a0', '\ufeff', ' /.']) {
    for (const mode of ['create', 'open']) {
      assert.throws(() => {
        const unexpected = openPartyVetStore({ path: path + suffix, mode });
        unexpected.close();
      }, code('journal-invalid'), JSON.stringify({ suffix, mode }));
      assert.deepEqual(readdirSync(directory).sort(), before, 'refusal creates no file or initialization directory');
      assert.deepEqual(await store.read('job'), { checkpoint: 'TEST-complete' });
    }
  }
  const again = openPartyVetStore({ path, mode: 'open' }); t.after(() => again.close());
  assert.equal(again.storeId, store.storeId, 'internal spaces still identify the same store');
  assert.deepEqual(await again.read('job'), { checkpoint: 'TEST-complete' });
});

test('a missing file is a fresh private store; rows survive a reopen; usage counts jobs and bytes', (t) => {
  const path = join(dirFor(t), 'seller-party-vet.sqlite');
  const store = openStore({ path });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(store.usage(), { jobs: 0, bytes: 0, maxJobs: PARTY_VET_STORE_LIMITS.maxJobs, maxTotalBytes: PARTY_VET_STORE_LIMITS.maxTotalBytes, remainingJobs: PARTY_VET_STORE_LIMITS.maxJobs, remainingBytes: PARTY_VET_STORE_LIMITS.maxTotalBytes });
  return (async () => {
    assert.deepEqual(await store.update('a', () => ({ n: 1 })), { n: 1 });
    await store.update('b', () => ({ n: 2 }));
    const bytes = Buffer.byteLength(JSON.stringify({ n: 1 })) * 2;
    assert.deepEqual({ jobs: store.usage().jobs, bytes: store.usage().bytes, remainingJobs: store.usage().remainingJobs }, { jobs: 2, bytes, remainingJobs: PARTY_VET_STORE_LIMITS.maxJobs - 2 });
    store.close();
    const again = openStore({ path }); t.after(() => again.close());
    assert.equal(again.storeId, store.storeId);
    assert.deepEqual(await again.read('a'), { n: 1 }); assert.deepEqual(await again.entries(), [['a', { n: 1 }], ['b', { n: 2 }]]);
  })();
});

test('opening validates rows and totals from one snapshot after a concurrent commit', async t => {
  const path = join(dirFor(t), 'concurrent.sqlite');
  const seed = openPartyVetStore({ path, mode: 'create' });
  await seed.update('job', () => ({ checkpoint: 'planned' })); seed.close();
  const execute = DatabaseSync.prototype.exec;
  let committed = false;
  t.after(() => { DatabaseSync.prototype.exec = execute; });
  DatabaseSync.prototype.exec = function(sql) {
    const result = execute.call(this, sql);
    if (sql === 'COMMIT' && !committed) {
      // Commit through another process after metadata admission, before row validation.
      committed = true;
      DatabaseSync.prototype.exec = execute;
      const child = spawnSync(process.execPath, [WORKER, 'committed-update', path], { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.signal, null);
    }
    return result;
  };
  const store = openPartyVetStore({ path, mode: 'open' }); t.after(() => store.close());
  assert.equal(committed, true);
  assert.deepEqual(await store.read('job'), { checkpoint: 'TEST-committed' });
});

for (const [label, make] of [['sqlite', (t) => openStore({ path: join(dirFor(t), 's.sqlite') })], ['memory', () => createInMemoryPartyVetStore()]]) {
  test(`${label}: a change keeps, writes or deletes a row atomically; it must be synchronous; a failed change writes nothing`, async (t) => {
    const store = make(t); t.after(() => store.close());
    assert.equal(await store.update('k', () => undefined), null, 'no row: nothing kept or written');
    await store.update('k', () => ({ v: 1 }));
    assert.deepEqual(await store.update('k', (row) => { row.v = 99; return undefined; }), { v: 1 }, 'the change gets a copy');
    assert.deepEqual(await store.update('k', (row) => ({ v: row.v + 1 })), { v: 2 });
    await assert.rejects(store.update('k', async () => ({ v: 3 })), code('journal-invalid'));
    await assert.rejects(store.update('k', () => { throw Object.assign(new Error('TEST'), { code: 'conflict' }); }), code('conflict'));
    assert.deepEqual(await store.read('k'), { v: 2 });
    assert.equal(await store.update('k', () => null), null);
    assert.equal(await store.read('k'), null); assert.equal(store.usage().jobs, 0);
  });

  test(`${label}: capacity is explicit; a full store writes nothing and deletion frees it`, async (t) => {
    const store = label === 'sqlite' ? openStore({ path: join(dirFor(t), 'c.sqlite'), maxJobs: 2, maxValueBytes: 64, maxTotalBytes: 100 }) : createInMemoryPartyVetStore({ maxJobs: 2, maxValueBytes: 64, maxTotalBytes: 100 });
    t.after(() => store.close());
    await store.update('a', () => ({ v: 'x' })); await store.update('b', () => ({ v: 'y' }));
    await assert.rejects(store.update('c', () => ({ v: 'z' })), (error) => error.code === 'journal-capacity' && /full; nothing was written/.test(error.message));
    await assert.rejects(store.update('a', () => ({ v: 'x'.repeat(80) })), (error) => error.code === 'journal-capacity' && /exceeds 64 bytes/.test(error.message));
    await store.update('b', () => ({ v: 'y'.repeat(50) }));
    await assert.rejects(store.update('a', () => ({ v: 'x'.repeat(50) })), code('journal-capacity'), 'total bytes');
    assert.deepEqual(await store.read('a'), { v: 'x' });
    await store.update('b', () => null);
    await store.update('c', () => ({ v: 'z' }));
    assert.deepEqual(store.usage().jobs, 2);
  });
}

test('a row changed outside the store, or a file of another format, fails closed', async (t) => {
  const dir = dirFor(t), path = join(dir, 'p.sqlite');
  const store = openStore({ path });
  await store.update('k', () => ({ v: 1 }));
  store.close();
  const db = new DatabaseSync(path); db.prepare("UPDATE jobs SET value = '{\"v\":2}', bytes = 7 WHERE key = 'k'").run(); db.close();
  assert.throws(() => openStore({ path }), code('journal-integrity'), 'existing rows are validated before returning a handle');
  // Created private first: SQLite would create it 0666 & ~umask (0644 on CI).
  const other = join(dir, 'other.sqlite'); writeFileSync(other, '', { mode: 0o600 });
  const odb = new DatabaseSync(other); odb.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES (\'format\', \'something-else\')'); odb.close();
  assert.throws(() => openStore({ path: other }), code('journal-integrity'));
  const junk = join(dir, 'junk.sqlite'); writeFileSync(junk, 'not a database', { mode: 0o600 });
  assert.throws(() => openStore({ path: junk }), code('journal-integrity'));
  assert.throws(() => openStore({ path: 'relative.sqlite' }), code('journal-invalid'));
});

test('a group- or world-accessible store file is refused before it is read, whatever the umask', (t) => {
  const dir = dirFor(t);
  for (const mode of [0o640, 0o604, 0o644, 0o660]) {
    const path = join(dir, `shared-${mode.toString(8)}.sqlite`);
    const store = openStore({ path }); store.close();
    chmodSync(path, mode);
    assert.throws(() => openStore({ path }), (error) => error.code === 'journal-invalid' && /private regular file/.test(error.message), `mode ${mode.toString(8)}`);
  }
});


test('an existing empty or truncated checkpoint file is not a fresh store', async t => {
  const path = join(dirFor(t), 'truncated.sqlite'), store = openStore({ path });
  await store.update('job', () => ({ checkpoint: 'issued' })); store.close();
  writeFileSync(path, '');
  assert.throws(() => openStore({ path }), code('journal-integrity'));
});

for (const sql of ['DROP TABLE jobs', 'ALTER TABLE jobs ADD COLUMN unexpected TEXT', 'DROP TABLE meta', 'ALTER TABLE meta ADD COLUMN unexpected TEXT',
  'CREATE TRIGGER discard_checkpoint BEFORE INSERT ON jobs BEGIN SELECT RAISE(IGNORE); END',
  'CREATE INDEX extra ON jobs(key)', 'CREATE VIEW extra AS SELECT key FROM jobs', 'CREATE TABLE extra (key TEXT)']) test(`reopen rejects changed application schema: ${sql}`, async t => {
  const path = join(dirFor(t), 'schema.sqlite'), store = openStore({ path });
  await store.update('job', () => ({ checkpoint: 'issued' })); store.close();
  const db = new DatabaseSync(path); db.exec(sql); db.close();
  assert.throws(() => openStore({ path }), code('journal-integrity'));
});

for (const mode of ['reject-memory', 'reject-sqlite']) test(`${mode}: a handled asynchronous callback refusal leaves no unhandled rejection`, t => {
  const child = spawnSync(process.execPath, [WORKER, mode, join(dirFor(t), 'async.sqlite')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
});

for (const [label, make] of [['memory', () => createInMemoryPartyVetStore()], ['sqlite', t => openStore({ path: join(dirFor(t), 'closed.sqlite') })]]) test(`${label}: close is idempotent and all later operations refuse`, async t => {
  const store = make(t); await store.update('k', () => ({ v: 1 })); store.close(); store.close();
  await assert.rejects(store.read('k'), code('journal-closed'));
  await assert.rejects(store.entries(), code('journal-closed'));
  await assert.rejects(store.update('k', () => ({ v: 2 })), code('journal-closed'));
  assert.throws(() => store.usage(), code('journal-closed'));
});

test('a competing process cannot enter an update callback; killing the writer rolls back and permits retry', { timeout: 10000 }, async t => {
  const path = join(dirFor(t), 'shared.sqlite'), store = openStore({ path, busyTimeoutMs: 0 });
  t.after(() => store.close()); await store.update('n', () => ({ n: 0 }));
  const child = fork(WORKER, ['writer', path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: ['--expose-gc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`writer exited before locking: ${stderr}`); })]);
  assert.equal(message, 'locked');
  child.send('collect');
  assert.equal((await once(child, 'message'))[0], 'collected', 'the writer still holds its lock after a garbage collection');
  let entered = false;
  await assert.rejects(store.update('n', row => { entered = true; return { n: row.n + 1 }; }), error => error.code === 'journal-busy' && error.cause instanceof Error);
  assert.equal(entered, false, 'the IMMEDIATE transaction must refuse before the change callback');
  assert.deepEqual(await store.read('n'), { n: 0 }, 'the uncommitted child write is invisible');
  child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
  assert.deepEqual(await store.read('n'), { n: 0 }, 'the dead writer rolled back');
  assert.deepEqual(await store.update('n', row => ({ n: row.n + 1 })), { n: 1 });
  store.close(); const reopened = openStore({ path }); t.after(() => reopened.close());
  assert.deepEqual(await reopened.entries(), [['n', { n: 1 }]]);
});


for (const backend of ['memory', 'sqlite']) for (const invalid of ['bigint', 'cycle']) test(`${backend}: ${invalid} row serialization is journal-invalid with its cause`, async t => {
  const store = backend === 'memory' ? createInMemoryPartyVetStore() : openStore({ path: join(dirFor(t), 'invalid.sqlite') });
  t.after(() => store.close());
  const value = invalid === 'bigint' ? { n: 1n } : {};
  if (invalid === 'cycle') value.self = value;
  await assert.rejects(store.update('job', () => value), error => error.code === 'journal-invalid' && error.cause instanceof TypeError);
  assert.equal(await store.read('job'), null);
});

test('restart succeeds after the first opener is killed before schema creation', t => {
  const path = join(dirFor(t), 'initializing.sqlite');
  const child = spawnSync(process.execPath, [WORKER, 'init-crash', path], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const store = openStore({ path }); t.after(() => store.close());
  assert.equal(store.usage().jobs, 0);
});

for (const backend of ['memory', 'sqlite']) test(`${backend}: malformed Unicode keys are refused without poisoning retained jobs`, async t => {
  const path = join(dirFor(t), 'unicode.sqlite');
  const store = backend === 'memory' ? createInMemoryPartyVetStore() : openStore({ path });
  await store.update('good', () => ({ n: 1 }));
  for (const key of ['job-\ud800', 'job-\udfff']) {
    await assert.rejects(store.update(key, () => ({ n: 2 })), code('journal-invalid'));
    await assert.rejects(store.read(key), code('journal-invalid'));
  }
  assert.deepEqual(await store.entries(), [['good', { n: 1 }]]);
  store.close();
  if (backend === 'sqlite') { const again = openStore({ path }); t.after(() => again.close()); assert.deepEqual(await again.read('good'), { n: 1 }); }
});

test('unsafe parent paths, hard links and planted sidecars are refused before SQLite opens', t => {
  const dir = dirFor(t), safe = join(dir, 'safe'); mkdirSync(safe, { mode: 0o700 });
  const path = join(safe, 'p.sqlite'); openStore({ path }).close();
  const alias = join(safe, 'alias.sqlite'); linkSync(path, alias);
  for (const name of [path, alias]) assert.throws(() => openStore({ path: name }), code('journal-invalid'));
  const linked = join(dir, 'linked'); symlinkSync(safe, linked);
  assert.throws(() => openStore({ path: join(linked, 'new.sqlite') }));
  const shared = join(dir, 'shared'); mkdirSync(shared, { mode: 0o700 }); chmodSync(shared, 0o777);
  assert.throws(() => openStore({ path: join(shared, 'new.sqlite') }));
  const sidecar = join(safe, 'sidecar.sqlite'); openStore({ path: sidecar }).close();
  writeFileSync(sidecar + '-wal', 'hostile', { mode: 0o666 }); chmodSync(sidecar + '-wal', 0o666);
  assert.throws(() => openStore({ path: sidecar }), code('journal-invalid'));
});

test('a store file lost after a committed checkpoint is not recreated, and the mode must be named', async (t) => {
  const path = join(dirFor(t), 'lost.sqlite');
  const store = openPartyVetStore({ path, mode: 'create' });
  await store.update('signed', () => ({ signature: 'TEST-signature' }));
  store.close();
  assert.throws(() => openPartyVetStore({ path, mode: 'create' }), code('journal-exists'));
  assert.throws(() => openPartyVetStore({ path }), code('journal-invalid'));
  rmSync(path);
  assert.throws(() => openPartyVetStore({ path, mode: 'open' }), code('journal-absent'));
  assert.equal(existsSync(path), false, 'nothing was created in its place');
});

test('a row deleted outside the store fails closed on open and on a handle that is already open', async (t) => {
  const path = join(dirFor(t), 'deleted.sqlite');
  const store = openStore({ path }); t.after(() => store.close());
  await store.update('signed', () => ({ signature: 'TEST-signature' }));
  await store.update('other', () => ({ n: 1 }));
  const outside = new DatabaseSync(path); outside.prepare("DELETE FROM jobs WHERE key = 'signed'").run(); outside.close();
  await assert.rejects(store.read('signed'), code('journal-integrity'));
  await assert.rejects(store.update('other', (row) => row), code('journal-integrity'));
  assert.throws(() => openStore({ path }), code('journal-integrity'));
});

test('a store killed after publishing its database and before removing its initialization link is recovered', (t) => {
  const dir = dirFor(t), path = join(dir, 'published.sqlite');
  const child = spawnSync(process.execPath, [WORKER, 'link-crash', path], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(lstatSync(path).nlink, 2, 'the crash left the second link');
  const store = openPartyVetStore({ path, mode: 'open' }); t.after(() => store.close());
  assert.equal(lstatSync(path).nlink, 1);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.init-')), [], 'the initialization directory is gone');
  assert.equal(store.usage().jobs, 0);
});

for (const kind of ['empty', 'foreign']) test(`rejected ${kind} database remains byte-for-byte unchanged`, t => {
  const path = join(dirFor(t), 'foreign.sqlite'); writeFileSync(path, '', { mode: 0o600 });
  if (kind === 'foreign') { const db = new DatabaseSync(path); db.exec('CREATE TABLE unrelated (n INTEGER)'); db.close(); }
  const before = readFileSync(path);
  assert.throws(() => openStore({ path }), code('journal-integrity'));
  assert.deepEqual(readFileSync(path), before);
});

for(const durable of [false,true])test(`every retained row counts until deletion, durable=${durable}`,async t=>{
 const store=durable?openStore({path:join(dirFor(t),'rows.sqlite'),maxJobs:1}):createInMemoryPartyVetStore({maxJobs:1});t.after(()=>store.close());
 const row={version:'dacs-devnet-demo-party-vet-state/v2',writer:'TEST-writer',jobId:'TEST-job',revision:1,lifecycle:{state:'ended'}};
 await store.update('party-vet/TEST-row',()=>row);assert.equal(store.usage().jobs,1);
 await assert.rejects(store.update('active',()=>({work:'TEST'})),{code:'journal-capacity'});
 await store.update('party-vet/TEST-row',()=>null);assert.equal(store.usage().bytes,0);
 await store.update('active',()=>({work:'TEST'}));assert.equal(store.usage().jobs,1);
});
