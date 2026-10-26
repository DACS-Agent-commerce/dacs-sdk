import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import DatabaseSync from 'better-sqlite3';
import { createInMemoryPartyVetStore, openPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';

const [mode, path] = process.argv.slice(2);
if (mode === 'init-crash') {
  const execute = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql.startsWith('CREATE TABLE meta ')) process.kill(process.pid, 'SIGKILL');
    return execute.call(this, sql);
  };
  openPartyVetStore({ path, mode: 'create' });
  assert.fail('TEST initializer did not reach the crash boundary');
} else if (mode === 'link-crash') {
  const link = fs.linkSync;
  fs.linkSync = (existing, target) => { link(existing, target); process.kill(process.pid, 'SIGKILL'); };
  syncBuiltinESMExports();
  openPartyVetStore({ path, mode: 'create' });
  assert.fail('TEST publication did not reach the crash boundary');
} else if (mode === 'committed-update') {
  const store = openPartyVetStore({ path, mode: 'open' });
  await store.update('job', () => ({ checkpoint: 'TEST-committed' }));
  store.close();
} else if (mode === 'writer') {
  const db = new DatabaseSync(path);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE jobs SET value = ? WHERE key = ?').run('{"n":99}', 'n');
  // The parent kills this process while its write is uncommitted. The handler
  // keeps the connection reachable: a collected connection closes and drops its write lock.
  process.on('message', () => { globalThis.gc(); process.send(db.inTransaction ? 'collected' : 'lost'); });
  process.send('locked');
} else {
  const store = mode === 'reject-memory' ? createInMemoryPartyVetStore() : openPartyVetStore({ path, mode: 'create' });
  await assert.rejects(store.update('job', async () => { throw new Error('TEST rejected change'); }), { code: 'journal-invalid' });
  assert.equal(await store.read('job'), null);
  store.close();
  // A turn boundary lets Node report any leaked rejection before clean exit.
  await new Promise(setImmediate);
}
