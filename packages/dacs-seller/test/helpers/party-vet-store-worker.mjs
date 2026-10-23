import assert from 'node:assert/strict';
import DatabaseSync from 'better-sqlite3';
import { createInMemoryPartyVetStore, openPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';

const [mode, path] = process.argv.slice(2);
if (mode === 'writer') {
  const db = new DatabaseSync(path);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE jobs SET value = ? WHERE key = ?').run('{"n":99}', 'n');
  process.send('locked');
  // The parent kills this process while its write is uncommitted.
  process.on('message', () => {});
} else {
  const store = mode === 'reject-memory' ? createInMemoryPartyVetStore() : openPartyVetStore({ path });
  await assert.rejects(store.update('job', async () => { throw new Error('TEST rejected change'); }), { code: 'journal-invalid' });
  assert.equal(await store.read('job'), null);
  store.close();
  // A turn boundary lets Node report any leaked rejection before clean exit.
  await new Promise(setImmediate);
}
