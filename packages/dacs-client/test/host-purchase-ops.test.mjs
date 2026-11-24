// The shipped operations adapter and the purchase operation id check, on the
// client's own schema and transaction store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PURCHASE_STATE_SCHEMA, createSqlitePurchaseStore, createPurchaseOperations, isPurchaseOperationId,
  sellerSessionTransitionState, OperationError, NotWiredError,
} from '../src/index.mjs';
import { sha256Hex } from '../src/util/ids.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

const NOW = 1_900_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET = 'TEST-'.repeat(8);
const OTHER_SECRET = 'TEST-other-'.repeat(4);
const ACCOUNT_A = 'TEST-account-a', ACCOUNT_B = 'TEST-account-b';
const HANDOFF_HASH_PREFIX = 'dacs-handoff-hash:';

function freshDatabase(t, db = new DatabaseSync(':memory:')) {
  t.after(() => { if (db.isOpen) db.close(); });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(PURCHASE_STATE_SCHEMA);
  addAccounts(db);
  return { db, store: createSqlitePurchaseStore() };
}
function addAccounts(db) {
  const insert = db.prepare('INSERT INTO accounts (id, auth_issuer, auth_subject, created_at) VALUES (?, ?, ?, ?)');
  for (const id of [ACCOUNT_A, ACCOUNT_B]) insert.run(id, 'TEST-issuer', id, new Date(NOW).toISOString());
}
function adapter(t, options = {}) {
  const { db, store } = freshDatabase(t);
  return { db, store, ops: createPurchaseOperations({ db, store, handoffSecret: SECRET, handoffTtlMs: DAY_MS, now: () => NOW, ...options }) };
}
const purchase = (overrides = {}) => ({ accountId: ACCOUNT_A, kind: 'purchase', idempotencyKey: 'TEST-key', request: { listingId: 'TEST-listing' },
  status: 'awaiting_approval', terms: { price: '2.5' }, termsHash: 'f'.repeat(64), expiresAt: new Date(NOW + 3_600_000).toISOString(), ...overrides });
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const savedRow = (db, id) => ({ ...db.prepare('SELECT * FROM operations WHERE id = ?').get(id) });
const refused = (code) => (error) => error instanceof OperationError && error.code === code;

test('createIdempotent mints an id isPurchaseOperationId accepts, writes job_id and handoff_expires_at in the same insert, and returns the same operation for the same key and request', (t) => {
  const { db, ops } = adapter(t);
  const first = ops.createIdempotent(purchase({ jobId: 'TEST-job-1' }));
  assert.equal(first.created, true);
  assert.equal(isPurchaseOperationId(first.operation.id), true);
  assert.equal(first.handoffToken, ops.handoffTokenFor(first.operation.id));
  const row = savedRow(db, first.operation.id);
  assert.equal(row.job_id, 'TEST-job-1');
  assert.equal(row.handoff_expires_at, new Date(NOW + DAY_MS).toISOString());
  assert.equal(row.handoff_token_hash, sha256Hex(HANDOFF_HASH_PREFIX + first.handoffToken));
  const again = ops.createIdempotent(purchase({ jobId: 'TEST-job-2' }));
  assert.equal(again.created, false);
  assert.deepEqual(again.operation, first.operation);
  assert.equal(again.handoffToken, first.handoffToken);
  assert.equal(count(db, 'operations'), 1);
  assert.deepEqual(ops.history(first.operation.id).map((event) => event.type), ['created']);
});

test('the same key with another request refuses idempotency_conflict, a used job id refuses job_id_collision, and neither writes a row', (t) => {
  const { db, ops } = adapter(t);
  ops.createIdempotent(purchase({ jobId: 'TEST-job-1' }));
  const before = [count(db, 'operations'), count(db, 'operation_events')];
  assert.throws(() => ops.createIdempotent(purchase({ request: { listingId: 'TEST-other' } })), refused('idempotency_conflict'));
  assert.throws(() => ops.createIdempotent(purchase({ idempotencyKey: 'TEST-key-2', jobId: 'TEST-job-1' })), refused('job_id_collision'));
  assert.deepEqual([count(db, 'operations'), count(db, 'operation_events')], before);
});

test('a short handoff secret, a bad handoff lifetime, a foreign store and a kind other than purchase are refused with their named errors', (t) => {
  const { db, store } = freshDatabase(t);
  const build = (options) => createPurchaseOperations({ db, store, handoffSecret: SECRET, handoffTtlMs: DAY_MS, ...options });
  for (const handoffSecret of [undefined, 42, 'TEST-short', 'x'.repeat(31)]) {
    assert.throws(() => build({ handoffSecret }), { name: 'TypeError', message: 'handoff_secret_required' }, String(handoffSecret));
  }
  for (const handoffTtlMs of [undefined, 0, -1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => build({ handoffTtlMs }), { name: 'TypeError', message: 'handoff_ttl_invalid' }, String(handoffTtlMs));
  }
  assert.throws(() => build({ store: { transaction: (_db, fn) => fn(), isUniqueViolation: () => false } }), NotWiredError);
  const ops = build({});
  for (const kind of ['identity', 'publication', undefined]) {
    assert.throws(() => ops.createIdempotent(purchase({ kind })), { name: 'TypeError', message: 'operation_kind_unsupported' }, String(kind));
  }
  assert.equal(count(db, 'operations'), 0);
});

test('transition compares the saved status, appends its event in the same transaction, keeps the seller-session clock, and refuses not_found and a stale status', (t) => {
  const { db, ops } = adapter(t);
  const { operation } = ops.createIdempotent(purchase({ state: { protocol: { sessionDelegation: { payload: { expiresAt: 0 } } } } }));
  const moved = ops.transition(operation.id, 'awaiting_approval', 'expired', { state: { note: 'TEST-note' }, data: { reason: 'TEST-reason' } });
  assert.equal(moved.status, 'expired');
  assert.equal(moved.state.note, 'TEST-note');
  const expected = sellerSessionTransitionState(operation, 'expired', { ...operation.state, note: 'TEST-note' }, NOW);
  assert.equal(moved.state.protocol.sellerSessionFinalAt, NOW);
  assert.deepEqual(moved.state, expected);
  assert.deepEqual(ops.history(operation.id).map(({ type, data }) => [type, data]), [['created', { status: 'awaiting_approval' }], ['expired', { reason: 'TEST-reason' }]]);
  assert.throws(() => ops.transition('pur_AAAAAAAAAAAAAAAA', 'awaiting_approval', 'approved'), refused('not_found'));
  assert.throws(() => ops.transition(operation.id, 'awaiting_approval', 'approved'),
    (error) => refused('invalid_state')(error) && error.details.status === 'expired');
  assert.equal(savedRow(db, operation.id).status, 'expired');
  assert.equal(count(db, 'operation_events'), 2);
});

test('a createIdempotent inside a transaction that rolls back leaves no operation and no event, and a retry with the same key creates one operation', (t) => {
  const { db, store, ops } = adapter(t);
  assert.throws(() => store.transaction(db, () => { ops.createIdempotent(purchase()); throw new Error('TEST-abort'); }), /TEST-abort/);
  assert.deepEqual([count(db, 'operations'), count(db, 'operation_events')], [0, 0]);
  assert.equal(ops.createIdempotent(purchase()).created, true);
  assert.deepEqual([count(db, 'operations'), count(db, 'operation_events')], [1, 1]);
});

test('a transition inside a transaction that rolls back leaves the saved status and the event log unchanged', (t) => {
  const { db, store, ops } = adapter(t);
  const { operation } = ops.createIdempotent(purchase());
  assert.throws(() => store.transaction(db, () => { ops.transition(operation.id, 'awaiting_approval', 'approved'); throw new Error('TEST-abort'); }), /TEST-abort/);
  assert.deepEqual(ops.get(ACCOUNT_A, operation.id), operation);
  assert.deepEqual(ops.history(operation.id).map((event) => event.type), ['created']);
});

test("get and findByKey are scoped to the account, and getByHandoff answers only the operation's own token and null for a malformed, wrong or other operation's token", (t) => {
  const { db, ops } = adapter(t);
  const a = ops.createIdempotent(purchase());
  const b = ops.createIdempotent(purchase({ idempotencyKey: 'TEST-key-b' }));
  const [tokenA, tokenB] = [a.handoffToken, b.handoffToken];
  assert.match(tokenA, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(ops.get(ACCOUNT_A, a.operation.id), a.operation);
  assert.equal(ops.get(ACCOUNT_B, a.operation.id), null);
  assert.deepEqual(ops.findByKey(ACCOUNT_A, 'purchase', 'TEST-key'), a.operation);
  assert.equal(ops.findByKey(ACCOUNT_B, 'purchase', 'TEST-key'), null);
  assert.deepEqual(ops.getByHandoff(a.operation.id, tokenA), a.operation);
  assert.deepEqual(ops.getByHandoff(b.operation.id, tokenB), b.operation);
  const events = count(db, 'operation_events');
  const last = tokenA.at(-1) === 'A' ? 'B' : 'A';
  const refusedTokens = [undefined, null, 42, Buffer.from(tokenA), [tokenA], '', tokenA.slice(0, 15),
    tokenA.slice(0, -1) + last, ops.handoffTokenFor('pur_AAAAAAAAAAAAAAAA'), tokenB];
  for (const token of refusedTokens) assert.equal(ops.getByHandoff(a.operation.id, token), null, String(token));
  assert.equal(ops.getByHandoff(b.operation.id, tokenA), null);
  assert.deepEqual(ops.get(ACCOUNT_A, a.operation.id), a.operation);
  assert.deepEqual(ops.get(ACCOUNT_A, b.operation.id), b.operation);
  assert.equal(count(db, 'operation_events'), events);
});

test('the handoff token is unchanged after the adapter is rebuilt with the same secret, and another secret reads nothing', (t) => {
  const { db, store, ops } = adapter(t);
  const { operation, handoffToken } = ops.createIdempotent(purchase());
  const rebuilt = createPurchaseOperations({ db, store, handoffSecret: SECRET, handoffTtlMs: DAY_MS, now: () => NOW + 1 });
  assert.equal(rebuilt.handoffTokenFor(operation.id), handoffToken);
  assert.deepEqual(rebuilt.getByHandoff(operation.id, handoffToken), operation);
  const other = createPurchaseOperations({ db, store, handoffSecret: OTHER_SECRET, handoffTtlMs: DAY_MS, now: () => NOW });
  assert.notEqual(other.handoffTokenFor(operation.id), handoffToken);
  assert.equal(other.getByHandoff(operation.id, handoffToken), null);
  assert.equal(other.getByHandoff(operation.id, other.handoffTokenFor(operation.id)), null);
});

test('transition listeners run after the transaction settles, only for a status change, and a throwing listener changes nothing', async (t) => {
  const { ops } = adapter(t);
  const { operation } = ops.createIdempotent(purchase());
  const seen = [];
  ops.onTransition(() => { throw new Error('TEST-listener'); });
  const unsubscribe = ops.onTransition((changed) => seen.push(changed.status));
  assert.throws(() => ops.onTransition('TEST-not-a-function'), TypeError);
  ops.transition(operation.id, 'awaiting_approval', 'awaiting_approval', { event: 'TEST-same-status' });
  const moved = ops.transition(operation.id, 'awaiting_approval', 'approved');
  assert.deepEqual(seen, [], 'listeners do not run inside the transition');
  await new Promise(setImmediate);
  assert.deepEqual(seen, ['approved']);
  assert.deepEqual(ops.get(ACCOUNT_A, operation.id), moved);
  assert.equal(unsubscribe(), true);
  ops.transition(operation.id, 'approved', 'payment_handoff');
  await new Promise(setImmediate);
  assert.deepEqual(seen, ['approved']);
});

// One scripted purchase, run against an operations store; returns every result.
function scriptedPurchase(ops, db, transaction) {
  const results = [];
  const created = ops.createIdempotent(purchase({ jobId: 'TEST-job', state: { protocol: { stage: 'TEST-stage' } } }));
  const id = created.operation.id;
  results.push(created, ops.createIdempotent(purchase({ jobId: 'TEST-job' })));
  results.push(ops.transition(id, 'awaiting_approval', 'approved', { data: { signer: 'TEST-signer' } }));
  ops.record(id, 'TEST-recorded', { index: 1 });
  transaction(db, () => ops.appendEvent(id, 'TEST-appended'));
  results.push(ops.transition(id, 'approved', 'payment_handoff', { state: { protocol: { stage: 'TEST-next' } }, event: 'TEST-handoff', data: { nonce: 7 } }));
  for (const attempt of [() => ops.transition(id, 'approved', 'cancelled'), () => ops.createIdempotent(purchase({ request: {} }))]) {
    try { attempt(); } catch (error) { results.push({ code: error.code, message: error.message, details: error.details }); }
  }
  results.push(ops.get(ACCOUNT_A, id), ops.get(ACCOUNT_B, id), ops.findByKey(ACCOUNT_A, 'purchase', 'TEST-key'), ops.getByHandoff(id, ops.handoffTokenFor(id)), ops.history(id));
  const rows = ['operations', 'operation_events'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row })));
  return { results, rows };
}
// Replaces each operation id by its order of first appearance, and its token and token hash by a label.
function normalized(value, ops) {
  let text = JSON.stringify(value);
  const ids = [...new Set(text.match(/pur_[A-Za-z0-9_-]{16}/g))];
  ids.forEach((id, index) => {
    const token = ops.handoffTokenFor(id);
    text = text.replaceAll(id, `op-${index + 1}`).replaceAll(sha256Hex(HANDOFF_HASH_PREFIX + token), `token-hash(op-${index + 1})`).replaceAll(token, `token(op-${index + 1})`);
  });
  return JSON.parse(text);
}

test("the shipped adapter and the package's test harness leave identical rows and results for one scripted purchase", (t) => {
  const harnessDb = openDatabase(':memory:');
  t.after(() => harnessDb.close());
  addAccounts(harnessDb);
  const harnessStore = createSqlitePurchaseStore();
  const harness = createOperationStore({ db: harnessDb, handoffSecret: SECRET, now: () => NOW });
  const { db, store, ops } = adapter(t);
  const fromHarness = normalized(scriptedPurchase(harness, harnessDb, harnessStore.transaction), harness);
  const fromAdapter = normalized(scriptedPurchase(ops, db, store.transaction), ops);
  assert.deepEqual(fromAdapter, fromHarness);
});

test("a rollback-journal file at synchronous FULL is refused by the store's admission on the adapter's first write", (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dacs-client-ops-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'state.db'));
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA synchronous = FULL');
  const { store } = freshDatabase(t, db);
  const ops = createPurchaseOperations({ db, store, handoffSecret: SECRET, handoffTtlMs: DAY_MS, now: () => NOW });
  assert.throws(() => ops.createIdempotent(purchase()), refused('purchase_store_unsupported_synchronous'));
  assert.equal(count(db, 'operations'), 0);
});

test('isPurchaseOperationId accepts exactly pur_ and 16 base64url characters and answers false, without throwing, for every other value', () => {
  for (const value of ['pur_AAAAAAAAAAAAAAAA', 'pur_abcdefghijklmnop', 'pur_0123456789_-Azyx']) assert.equal(isPurchaseOperationId(value), true, value);
  const refusedValues = ['pub_AAAAAAAAAAAAAAAA', 'idn_AAAAAAAAAAAAAAAA', 'PUR_AAAAAAAAAAAAAAAA', 'purAAAAAAAAAAAAAAAAA', 'pur_AAAAAAAAAAAAAAA', 'pur_AAAAAAAAAAAAAAAAA',
    'pur_AAAAAAAAAAAAAAA+', 'pur_AAAAAAAAAAAAAAA/', 'pur_AAAAAAAAAAAAAAA=', 'pur_AAAAAAA AAAAAAAA', ' pur_AAAAAAAAAAAAAAAA', 'pur_AAAAAAAAAAAAAAAA\n', '',
    undefined, null, 42, {}, ['pur_AAAAAAAAAAAAAAAA'], { toString: () => 'pur_AAAAAAAAAAAAAAAA' }];
  for (const value of refusedValues) assert.equal(isPurchaseOperationId(value), false, String(value));
});
