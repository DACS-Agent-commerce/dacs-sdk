import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSqlitePurchaseDatabase, checkSqlitePurchaseInput } from '../src/util/sqlite-purchase-admission.mjs';

function database(t, options, file = 'state.sqlite') {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-purchase-results-'));
  const db = new DatabaseSync(file === ':memory:' || file === '' ? file : join(dir, file), options);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('PRAGMA synchronous=EXTRA; CREATE TABLE records(value INTEGER)');
  return { db, dir };
}
const callback = () => assert.fail('admission must never run the callback');
const admit = db => checkSqlitePurchaseInput(db, callback);
const metadata = db => ['database_list', 'main.journal_mode', 'main.synchronous']
  .map(pragma => db.prepare(`PRAGMA ${pragma}`).all());

for (const readBigInts of [false, true]) for (const returnArrays of [false, true]) {
  const options = { readBigInts, returnArrays };
  const label = `readBigInts=${readBigInts}, returnArrays=${returnArrays}`;
  for (const mode of ['DELETE', 'TRUNCATE', 'PERSIST', 'WAL']) for (const level of ['OFF', 'NORMAL', 'FULL', 'EXTRA']) {
    const supported = level === 'EXTRA' || (mode === 'WAL' && level === 'FULL');
    test(`persistent ${mode}/${level} is ${supported ? 'admitted' : 'refused'} with ${label}`, t => {
      const { db } = database(t, options);
      db.exec(`PRAGMA journal_mode=${mode}; PRAGMA synchronous=${level}`);
      const before = metadata(db);
      for (const check of [admit, checkSqlitePurchaseDatabase]) {
        if (supported) assert.equal(check(db), undefined);
        else assert.throws(() => check(db), { code: 'purchase_store_unsupported_synchronous' });
      }
      assert.deepEqual(metadata(db), before);
      db.exec(`PRAGMA synchronous=${supported ? 'NORMAL' : 'EXTRA'}`);
      if (supported) assert.throws(() => admit(db), { code: 'purchase_store_unsupported_synchronous' });
      else assert.equal(admit(db), undefined);
    });
  }
  for (const mode of ['OFF', 'MEMORY']) {
    test(`persistent ${mode} refusal and retry recheck current settings with ${label}`, t => {
      const { db } = database(t, options);
      assert.equal(admit(db), undefined);
      db.exec(`PRAGMA journal_mode=${mode}`);
      assert.throws(() => admit(db), { code: 'purchase_store_unsupported_journal_mode' });
      db.exec('PRAGMA journal_mode=DELETE');
      assert.equal(admit(db), undefined);
    });
  }
  for (const file of [':memory:', '']) for (const level of ['OFF', 'NORMAL', 'FULL', 'EXTRA']) {
    test(`volatile main ${JSON.stringify(file)}/${level} preserves native journal policy with ${label}`, t => {
      const { db } = database(t, options, file);
      db.exec(`PRAGMA synchronous=${level}`);
      const before = metadata(db);
      assert.equal(admit(db), undefined);
      assert.deepEqual(metadata(db), before);
      db.exec('PRAGMA journal_mode=OFF');
      assert.throws(() => admit(db), { code: 'purchase_store_unsupported_journal_mode' });
    });
  }
  for (const file of ['archive.sqlite', ':memory:', '']) {
    test(`attachment ${JSON.stringify(file)} retains its specific refusal with ${label}`, t => {
      const { db, dir } = database(t, options);
      db.prepare('ATTACH ? AS archive').run(file === 'archive.sqlite' ? join(dir, file) : file);
      const before = metadata(db);
      assert.throws(() => admit(db), { code: file === 'archive.sqlite'
        ? 'purchase_store_persistent_attachment' : 'purchase_store_unsupported_attachment' });
      assert.deepEqual(metadata(db), before);
      db.exec('DETACH archive');
      assert.equal(admit(db), undefined);
    });
  }
  for (const supported of [false, true]) {
    test(`${supported ? 'admission' : 'refusal'} preserves caller results, TEMP and host work with ${label}`, t => {
      const { db } = database(t, options);
      db.exec(`PRAGMA synchronous=${supported ? 'EXTRA' : 'FULL'};
        CREATE TEMP TABLE session(value INTEGER); BEGIN; INSERT INTO records VALUES (7); INSERT INTO session VALUES (8)`);
      const sql = 'SELECT value FROM records UNION ALL SELECT value FROM session';
      const saved = db.prepare(sql);
      // Older SQLite runtimes may ignore constructor options they do not support.
      const expected = saved.all();
      assert.deepEqual(expected.map(row => Number(Object.values(row)[0])), [7, 8]);
      const before = metadata(db);
      if (supported) assert.equal(admit(db), undefined);
      else assert.throws(() => admit(db), { code: 'purchase_store_unsupported_synchronous' });
      assert.deepEqual(saved.all(), expected);
      assert.deepEqual(db.prepare(sql).all(), expected);
      assert.deepEqual(metadata(db), before);
      db.exec('ROLLBACK');
      assert.deepEqual(saved.all(), []);
    });
  }
}
