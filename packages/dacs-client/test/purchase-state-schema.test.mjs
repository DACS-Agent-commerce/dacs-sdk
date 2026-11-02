import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PURCHASE_STATE_SCHEMA } from '../src/purchase-state-schema.mjs';

function schema(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(PURCHASE_STATE_SCHEMA);
  db.exec(PURCHASE_STATE_SCHEMA);
  db.exec("INSERT INTO accounts VALUES ('buyer','TEST','buyer',NULL,'TEST-time')");
  return db;
}
function operation(db, id, { account = 'buyer', key = id, handoff = id } = {}) {
  db.prepare(`INSERT INTO operations(id,account_id,kind,idempotency_key,request_hash,status,terms,terms_hash,handoff_token_hash,expires_at,created_at,updated_at)
    VALUES (?,?,'purchase',?,'TEST-request','prepared','{}','TEST-terms',?,'TEST-expiry','TEST-time','TEST-time')`).run(id, account, key, handoff);
}
test('standalone schema is idempotent, creates buyer tables and preserves operation defaults', t => {
  const db = schema(t);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
    ['accounts','approvals','challenges','operation_events','operations','wallet_nonce_consumptions','write_coordinates']);
  operation(db, 'TEST-op');
  assert.equal(db.prepare('SELECT state FROM operations').get().state, '{}');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
test('accounts and challenges retain identity and one-use nonce constraints', t => {
  const db = schema(t);
  assert.throws(() => db.exec("INSERT INTO accounts VALUES ('other','TEST','buyer',NULL,'TEST-time')"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO accounts(id,auth_subject,created_at) VALUES ('other','TEST','TEST-time')"), /NOT NULL/);
  db.exec("INSERT INTO challenges(id,nonce,purpose,binding,message,issued_at,expires_at) VALUES ('TEST-c1','TEST-nonce','TEST','{}','TEST','TEST-time','TEST-expiry')");
  assert.throws(() => db.exec("INSERT INTO challenges(id,nonce,purpose,binding,message,issued_at,expires_at) VALUES ('TEST-c2','TEST-nonce','TEST','{}','TEST','TEST-time','TEST-expiry')"), /UNIQUE/);
});
test('operation idempotency is scoped by account and kind; handoffs stay unique', t => {
  const db = schema(t);
  operation(db, 'TEST-first', { key: 'TEST-key' });
  assert.throws(() => operation(db, 'TEST-repeat', { key: 'TEST-key' }), /UNIQUE/);
  assert.throws(() => operation(db, 'TEST-handoff', { handoff: 'TEST-first' }), /UNIQUE/);
  assert.throws(() => operation(db, 'TEST-orphan', { account: 'missing' }), /FOREIGN KEY/);
  db.exec("INSERT INTO accounts VALUES ('other','TEST','other',NULL,'TEST-time')");
  operation(db, 'TEST-other', { account: 'other', key: 'TEST-key' });
});
test('event sequence and approval operation/challenge constraints are enforced', t => {
  const db = schema(t);
  operation(db, 'TEST-one'); operation(db, 'TEST-two');
  const event = db.prepare("INSERT INTO operation_events VALUES (?,1,'TEST-time','TEST','{}')");
  event.run('TEST-one');
  assert.throws(() => event.run('TEST-one'), /UNIQUE/);
  assert.throws(() => event.run('missing'), /FOREIGN KEY/);
  for (const id of ['TEST-c1','TEST-c2']) db.prepare("INSERT INTO challenges(id,nonce,purpose,binding,message,issued_at,expires_at) VALUES (?,?,'TEST','{}','TEST','TEST-time','TEST-expiry')").run(id,id);
  const approve = db.prepare("INSERT INTO approvals VALUES (?,?,?,'TEST-signer','TEST-terms','TEST-signature','TEST-time')");
  approve.run('TEST-a1','TEST-one','TEST-c1');
  assert.throws(() => approve.run('TEST-a2','TEST-one','TEST-c2'), /UNIQUE/);
  assert.throws(() => approve.run('TEST-a3','TEST-two','TEST-c1'), /UNIQUE/);
  assert.throws(() => approve.run('TEST-a4','missing','TEST-c2'), /FOREIGN KEY/);
  assert.throws(() => approve.run('TEST-a5','TEST-two','missing'), /FOREIGN KEY/);
});
test('only verified transaction pointers are unique and coordinates default to one handoff', t => {
  const db = schema(t);
  for (const id of ['TEST-one','TEST-two']) {
    operation(db,id);
    db.prepare(`INSERT INTO write_coordinates(operation_id,kind,network,from_address,nonce_fence,expected_nonce,target,payload,payload_hash,saved_at,reported_tx_hash)
      VALUES (?,'dem-transfer','TEST','TEST-payer',1,2,'TEST-payee','{}','TEST-payload','TEST-time','TEST-shared-tx')`).run(id);
  }
  assert.equal(db.prepare('SELECT min(handoffs) n FROM write_coordinates').get().n, 1);
  db.exec("UPDATE write_coordinates SET verified_at='TEST-time' WHERE operation_id='TEST-one'");
  assert.throws(() => db.exec("UPDATE write_coordinates SET verified_at='TEST-time' WHERE operation_id='TEST-two'"), /UNIQUE/);
  assert.throws(() => db.exec("UPDATE write_coordinates SET operation_id='missing' WHERE operation_id='TEST-two'"), /FOREIGN KEY/);
});
test('nonce-consumption evidence retains its composite uniqueness and operation foreign key', t => {
  const db = schema(t);
  operation(db,'TEST-one');
  const consume = db.prepare("INSERT INTO wallet_nonce_consumptions VALUES ('TEST-payer','TEST',2,'TEST-tx',?,'TEST-time')");
  consume.run('TEST-one');
  assert.throws(() => consume.run('TEST-one'), /UNIQUE/);
  assert.throws(() => consume.run('missing'), /FOREIGN KEY/);
});

test('fixture and package share operation columns including nullable handoff expiry', async t => {
  const {openDatabase}=await import('./helpers/purchase-integrity-database.mjs');
  const fixture=openDatabase(':memory:'), db=schema(t);
  t.after(()=>fixture.close());
  const info=db.prepare('PRAGMA table_info(operations)').all();
  assert.deepEqual(fixture.prepare('PRAGMA table_info(operations)').all(),info);
  assert.equal(info.find(row=>row.name==='handoff_expires_at')?.type,'TEXT');
  assert.equal(info.find(row=>row.name==='handoff_expires_at')?.notnull,0);
  operation(db,'TEST-expiry');
  assert.equal(db.prepare('SELECT handoff_expires_at FROM operations').get().handoff_expires_at,null);
  db.prepare('UPDATE operations SET handoff_expires_at=?').run('2030-01-01T00:00:00.000Z');
  assert.equal(db.prepare('SELECT handoff_expires_at FROM operations').get().handoff_expires_at,'2030-01-01T00:00:00.000Z');
});
