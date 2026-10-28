// The seller's party Vet store (src/devnet-demo/party-vet-store.mjs): its own
// SQLite file, atomic synchronous changes, deletion, explicit capacity and
// integrity checks. Local files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInMemoryPartyVetStore, openPartyVetStore, PARTY_VET_STORE_LIMITS } from '../src/devnet-demo/party-vet-store.mjs';

const dirFor = (t) => { const dir = mkdtempSync(join(tmpdir(), 'party-vet-store-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const code = (expected) => (error) => error?.code === expected;

test('a missing file is a fresh private store; rows survive a reopen; usage counts jobs and bytes', (t) => {
  const path = join(dirFor(t), 'seller-party-vet.sqlite');
  const store = openPartyVetStore({ path });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(store.usage(), { jobs: 0, bytes: 0, maxJobs: PARTY_VET_STORE_LIMITS.maxJobs, maxTotalBytes: PARTY_VET_STORE_LIMITS.maxTotalBytes, remainingJobs: PARTY_VET_STORE_LIMITS.maxJobs, remainingBytes: PARTY_VET_STORE_LIMITS.maxTotalBytes });
  return (async () => {
    assert.deepEqual(await store.update('a', () => ({ n: 1 })), { n: 1 });
    await store.update('b', () => ({ n: 2 }));
    const bytes = Buffer.byteLength(JSON.stringify({ n: 1 })) * 2;
    assert.deepEqual({ jobs: store.usage().jobs, bytes: store.usage().bytes, remainingJobs: store.usage().remainingJobs }, { jobs: 2, bytes, remainingJobs: PARTY_VET_STORE_LIMITS.maxJobs - 2 });
    store.close();
    const again = openPartyVetStore({ path }); t.after(() => again.close());
    assert.equal(again.storeId, store.storeId);
    assert.deepEqual(await again.read('a'), { n: 1 }); assert.deepEqual(await again.entries(), [['a', { n: 1 }], ['b', { n: 2 }]]);
  })();
});

for (const [label, make] of [['sqlite', (t) => openPartyVetStore({ path: join(dirFor(t), 's.sqlite') })], ['memory', () => createInMemoryPartyVetStore()]]) {
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
    const store = label === 'sqlite' ? openPartyVetStore({ path: join(dirFor(t), 'c.sqlite'), maxJobs: 2, maxValueBytes: 64, maxTotalBytes: 100 }) : createInMemoryPartyVetStore({ maxJobs: 2, maxValueBytes: 64, maxTotalBytes: 100 });
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
  const store = openPartyVetStore({ path });
  await store.update('k', () => ({ v: 1 }));
  store.close();
  const db = new DatabaseSync(path); db.prepare("UPDATE jobs SET value = '{\"v\":2}', bytes = 7 WHERE key = 'k'").run(); db.close();
  const reopened = openPartyVetStore({ path }); t.after(() => reopened.close());
  await assert.rejects(reopened.read('k'), code('journal-integrity'));
  await assert.rejects(reopened.update('k', () => ({ v: 3 })), code('journal-integrity'));
  // Created private first: SQLite would create it 0666 & ~umask (0644 on CI).
  const other = join(dir, 'other.sqlite'); writeFileSync(other, '', { mode: 0o600 });
  const odb = new DatabaseSync(other); odb.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES (\'format\', \'something-else\')'); odb.close();
  assert.throws(() => openPartyVetStore({ path: other }), code('journal-integrity'));
  const junk = join(dir, 'junk.sqlite'); writeFileSync(junk, 'not a database', { mode: 0o600 });
  assert.throws(() => openPartyVetStore({ path: junk }), code('journal-integrity'));
  assert.throws(() => openPartyVetStore({ path: 'relative.sqlite' }), code('journal-invalid'));
});

test('a group- or world-accessible store file is refused before it is read, whatever the umask', (t) => {
  const dir = dirFor(t);
  for (const mode of [0o640, 0o604, 0o644, 0o660]) {
    const path = join(dir, `shared-${mode.toString(8)}.sqlite`);
    const store = openPartyVetStore({ path }); store.close();
    chmodSync(path, mode);
    assert.throws(() => openPartyVetStore({ path }), (error) => error.code === 'journal-invalid' && /private regular file/.test(error.message), `mode ${mode.toString(8)}`);
  }
});

test('two instances on one file (two processes): every change is one atomic read and write', async (t) => {
  const path = join(dirFor(t), 'shared.sqlite');
  const a = openPartyVetStore({ path }), b = openPartyVetStore({ path }); t.after(() => { a.close(); b.close(); });
  await a.update('n', () => ({ n: 0 }));
  await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).update('n', (row) => ({ n: row.n + 1 }))));
  assert.deepEqual(await a.read('n'), { n: 50 });
  assert.equal(b.storeId, a.storeId);
});
