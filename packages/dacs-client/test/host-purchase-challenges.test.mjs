// The shipped approval challenge adapter and its signed text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PURCHASE_STATE_SCHEMA, createSqlitePurchaseStore, createPurchaseChallenges, purchaseApprovalChallengeText,
  OperationError, WalletFormatError,
} from '../src/index.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const NOW = 1_900_000_000_000;
const TTL_MS = 300_000;
const ORIGIN = 'https://buyer.example.invalid';
const PURPOSE = 'approve-purchase';
const BINDING = Object.freeze({ operation: 'pur_AAAAAAAAAAAAAAAA', 'terms-hash': 'f'.repeat(64), amount: '2.5 DEM' });
const iso = (time) => new Date(time).toISOString();
const refused = (code) => (error) => error instanceof OperationError && error.code === code;

function openState(t, path = ':memory:') {
  const db = new DatabaseSync(path);
  t.after(() => { if (db.isOpen) db.close(); });
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000');
  db.exec(PURCHASE_STATE_SCHEMA);
  return db;
}
function temporaryPath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dacs-client-challenges-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'state.db');
}
// One adapter on its own database, with a movable clock and the test wallet.
function world(t, { path, options = {} } = {}) {
  const db = openState(t, path), store = createSqlitePurchaseStore(), wallet = createEphemeralWallet(), clock = { now: NOW };
  const challenges = createPurchaseChallenges({ db, store, origin: ORIGIN, purpose: PURPOSE, ttlMs: TTL_MS, now: () => clock.now, ...options });
  const accountId = `local:${wallet.address}`;
  const issue = (overrides = {}) => challenges.issue({ purpose: PURPOSE, address: wallet.address, accountId, binding: BINDING, ...overrides });
  const expectedBinding = { ...BINDING, account: accountId, address: wallet.address };
  const verify = (issued, overrides = {}) => challenges.verifyAndConsume({ challengeId: issued.challengeId, purpose: PURPOSE, expectedBinding,
    signature: wallet.signHex(issued.message), consumedBy: 'TEST-consumer', ...overrides });
  return { db, store, wallet, clock, challenges, accountId, issue, verify, expectedBinding };
}
const count = (db) => db.prepare('SELECT count(*) AS n FROM challenges').get().n;
const row = (db, id) => ({ ...db.prepare('SELECT * FROM challenges WHERE id = ?').get(id) });

test('issue stores one challenge whose binding is the given binding with address and account, and returns the binding without address and the text purchaseApprovalChallengeText rebuilds from the returned fields', (t) => {
  const { db, wallet, accountId, issue } = world(t);
  const issued = issue({ address: wallet.address.toUpperCase() });
  assert.equal(issued.address, wallet.address);
  assert.deepEqual(issued.binding, { ...BINDING, account: accountId });
  assert.equal(Object.hasOwn(issued.binding, 'address'), false);
  assert.match(issued.challengeId, /^chl_[A-Za-z0-9_-]{16}$/);
  assert.match(issued.nonce, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(issued.issuedAt, iso(NOW));
  assert.equal(issued.expiresAt, iso(NOW + TTL_MS));
  const { address, binding, nonce, issuedAt, expiresAt } = issued;
  assert.equal(purchaseApprovalChallengeText({ origin: ORIGIN, purpose: PURPOSE, address, binding, nonce, issuedAt, expiresAt }), issued.message);
  assert.equal(count(db), 1);
  const saved = row(db, issued.challengeId);
  assert.deepEqual(JSON.parse(saved.binding), { address: wallet.address, ...BINDING, account: accountId });
  assert.deepEqual([saved.nonce, saved.purpose, saved.account_id, saved.message, saved.issued_at, saved.expires_at, saved.consumed_at, saved.consumed_by],
    [nonce, PURPOSE, accountId, issued.message, issuedAt, expiresAt, null, null]);
});

test('the challenge text for a fixed input equals the expected text byte for byte', () => {
  const text = purchaseApprovalChallengeText({ origin: 'https://host.example', purpose: 'approve-purchase', address: '0x' + 'a'.repeat(64),
    binding: { operationId: 'op_1', amount: '5', account: 'acct_1' }, nonce: 'n', issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z' });
  assert.equal(text, [
    'host.example requests a DACS wallet signature',
    '',
    'Approve exactly this DEM testnet purchase. Your wallet will ask separately before any transaction is sent.',
    '',
    'origin: https://host.example',
    'purpose: approve-purchase',
    'address: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'account: acct_1',
    'amount: 5',
    'operationId: op_1',
    'nonce: n',
    'issued-at: 2026-01-01T00:00:00.000Z',
    'expires-at: 2026-01-01T00:05:00.000Z',
  ].join('\n'));
});

test("verifyAndConsume accepts the wallet's signature once inside the caller's transaction and refuses a replay", (t) => {
  const { db, store, wallet, clock, accountId, issue, verify } = world(t);
  const issued = issue();
  clock.now = NOW + 1000;
  const consumed = store.transaction(db, () => verify(issued));
  assert.deepEqual(consumed, { challengeId: issued.challengeId, address: wallet.address, binding: { address: wallet.address, ...BINDING, account: accountId },
    message: issued.message, accountId });
  const saved = row(db, issued.challengeId);
  assert.deepEqual([saved.consumed_at, saved.consumed_by], [iso(NOW + 1000), 'TEST-consumer']);
  assert.throws(() => store.transaction(db, () => verify(issued, { consumedBy: 'TEST-second' })), refused('challenge_replayed'));
  assert.deepEqual(row(db, issued.challengeId), saved);
});

test('issue for another purpose refuses invalid_purpose and stores nothing, and an unknown, expired, other-purpose or other-binding challenge and a bad signature are refused with their codes and stay unconsumed', (t) => {
  const { db, clock, issue, verify, expectedBinding } = world(t);
  assert.throws(() => issue({ purpose: 'TEST-other-purpose' }), refused('invalid_purpose'));
  assert.equal(count(db), 0);
  const issued = issue();
  assert.throws(() => verify(issued, { challengeId: 'chl_AAAAAAAAAAAAAAAA' }), refused('unknown_challenge'));
  assert.throws(() => verify(issued, { purpose: 'TEST-other-purpose' }), refused('purpose_mismatch'));
  assert.throws(() => verify(issued, { expectedBinding: { ...expectedBinding, amount: '3 DEM' } }), refused('binding_mismatch'));
  assert.throws(() => verify(issued, { expectedBinding: { ...expectedBinding, 'TEST-absent': 'x' } }), refused('binding_mismatch'));
  assert.throws(() => verify(issued, { signature: createEphemeralWallet().signHex(issued.message) }), refused('bad_signature'));
  assert.throws(() => verify(issued, { signature: 'TEST-not-a-signature' }), refused('bad_signature'));
  assert.equal(row(db, issued.challengeId).consumed_at, null);
  clock.now = NOW + TTL_MS;
  assert.throws(() => verify(issued), refused('challenge_expired'));
  assert.equal(row(db, issued.challengeId).consumed_at, null);
  clock.now = NOW + TTL_MS - 1;
  assert.equal(verify(issued).challengeId, issued.challengeId, 'every refusal left the challenge unconsumed');
});

test('a multi-line binding value or account id, a malformed address, origin, purpose or lifetime are refused before anything is stored', (t) => {
  const { db, store, accountId, issue } = world(t);
  const build = (options) => createPurchaseChallenges({ db, store, origin: ORIGIN, purpose: PURPOSE, ttlMs: TTL_MS, ...options });
  for (const origin of [undefined, 'TEST-not-a-url', 'https://host.example/path', 'https://host.example/', 'https://host.example\nextra']) {
    assert.throws(() => build({ origin }), { name: 'TypeError', message: 'challenge_origin_invalid' }, String(origin));
  }
  for (const purpose of [undefined, '', 42, 'approve\npurchase']) {
    assert.throws(() => build({ purpose }), { name: 'TypeError', message: 'challenge_purpose_invalid' }, String(purpose));
  }
  for (const ttlMs of [undefined, 0, -1, 1.5, '300000']) {
    assert.throws(() => build({ ttlMs }), { name: 'TypeError', message: 'challenge_ttl_invalid' }, String(ttlMs));
  }
  for (const binding of [{ ...BINDING, amount: '2.5 DEM\nTEST-extra' }, { ...BINDING, amount: 5 }, { ...BINDING, 'TEST\nkey': 'x' }, { ...BINDING, address: '0x' + 'b'.repeat(64) }, null, 'TEST-binding']) {
    assert.throws(() => issue({ binding }), refused('challenge_binding_invalid'), JSON.stringify(binding));
  }
  assert.throws(() => issue({ accountId: `${accountId}\nTEST-extra` }), refused('challenge_binding_invalid'));
  assert.throws(() => issue({ address: 'TEST-not-an-address' }), WalletFormatError);
  assert.equal(count(db), 0);
  issue();
  assert.equal(count(db), 1);
});

test('an unconsumed challenge verifies after the adapter is rebuilt on the same database file, and a consumed one stays consumed', (t) => {
  const path = temporaryPath(t);
  const first = world(t, { path });
  const open = first.issue(), used = first.issue();
  first.verify(used);
  first.db.close();
  const db = openState(t, path);
  const challenges = createPurchaseChallenges({ db, store: createSqlitePurchaseStore(), origin: ORIGIN, purpose: PURPOSE, ttlMs: TTL_MS, now: () => NOW });
  const verify = (issued) => challenges.verifyAndConsume({ challengeId: issued.challengeId, purpose: PURPOSE, expectedBinding: first.expectedBinding,
    signature: first.wallet.signHex(issued.message), consumedBy: 'TEST-after-restart' });
  assert.equal(verify(open).challengeId, open.challengeId);
  assert.throws(() => verify(used), refused('challenge_replayed'));
  assert.equal(row(db, used.challengeId).consumed_by, 'TEST-consumer');
});

test('a consumption inside a transaction that rolls back is undone', (t) => {
  const { db, store, issue, verify } = world(t);
  const issued = issue();
  assert.throws(() => store.transaction(db, () => { verify(issued); throw new Error('TEST-rollback'); }), /TEST-rollback/);
  assert.equal(row(db, issued.challengeId).consumed_at, null);
  assert.equal(verify(issued).challengeId, issued.challengeId);
});

test('issue without an account id refuses challenge_account_required and stores nothing', (t) => {
  const { db, wallet, challenges, accountId } = world(t);
  const base = { purpose: PURPOSE, address: wallet.address, binding: BINDING };
  for (const request of [base, { ...base, accountId: null }, { ...base, accountId: '' }, { ...base, accountId: 42 }]) {
    assert.throws(() => challenges.issue(request), refused('challenge_account_required'), String(request.accountId));
  }
  assert.equal(count(db), 0);
  challenges.issue({ ...base, accountId });
  assert.equal(count(db), 1);
});

test('every challenge is signed under the origin the adapter was built with, and issue given an origin of its own refuses challenge_origin_not_accepted and stores nothing', (t) => {
  const { db, challenges, issue } = world(t);
  for (const issued of [issue(), issue()]) {
    const { address, binding, nonce, issuedAt, expiresAt } = issued;
    const rebuilt = purchaseApprovalChallengeText({ origin: ORIGIN, purpose: PURPOSE, address, binding, nonce, issuedAt, expiresAt });
    assert.equal(issued.message, rebuilt);
    assert.equal(row(db, issued.challengeId).message, rebuilt);
  }
  for (const origin of ['https://other.example.invalid', ORIGIN]) assert.throws(() => issue({ origin }), refused('challenge_origin_not_accepted'), origin);
  assert.equal(count(db), 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM challenges WHERE message LIKE ?').get('%other.example.invalid%').n, 0);
  assert.equal(Object.isFrozen(challenges), true);
  assert.equal('origin' in challenges, false);
});

// A worker with its own connection, store and adapter. Each round it waits at
// a shared barrier for the other worker, then verifies the round's challenge.
const RACE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const barriers = new Int32Array(workerData.barriers);
const ready = import(workerData.client).then(({ createSqlitePurchaseStore, createPurchaseChallenges }) => {
  const db = new DatabaseSync(workerData.path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL');
  const store = createSqlitePurchaseStore();
  return createPurchaseChallenges({ db, store, ...workerData.options, now: () => workerData.now });
});
parentPort.on('message', async ({ round, request }) => {
  const challenges = await ready;
  Atomics.add(barriers, round, 1);
  Atomics.notify(barriers, round);
  for (let arrived; (arrived = Atomics.load(barriers, round)) < 2;) Atomics.wait(barriers, round, arrived);
  try { challenges.verifyAndConsume({ ...request, consumedBy: workerData.name }); parentPort.postMessage({ round, name: workerData.name, ok: true }); }
  catch (error) { parentPort.postMessage({ round, name: workerData.name, ok: false, code: error.code, message: error.message }); }
});`;
const RACE_ROUNDS = 30;

test("two connections verifying one challenge at once give exactly one consumption and one challenge_replayed, and a second connection cannot consume while the first holds the store's write lock", async (t) => {
  const path = temporaryPath(t);
  const main = world(t, { path });
  const options = { origin: ORIGIN, purpose: PURPOSE, ttlMs: TTL_MS };
  const connection = (name) => {
    const db = new DatabaseSync(path);
    t.after(() => { if (db.isOpen) db.close(); });
    db.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL');
    const store = createSqlitePurchaseStore();
    return { db, store, challenges: createPurchaseChallenges({ db, store, ...options, now: () => NOW }), name };
  };
  const [a, b] = [connection('TEST-connection-a'), connection('TEST-connection-b')];
  const issued = main.issue();
  const request = { challengeId: issued.challengeId, purpose: PURPOSE, expectedBinding: main.expectedBinding, signature: main.wallet.signHex(issued.message) };
  a.store.transaction(a.db, () => {
    a.challenges.verifyAndConsume({ ...request, consumedBy: a.name });
    assert.throws(() => b.challenges.verifyAndConsume({ ...request, consumedBy: b.name }), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  });
  assert.throws(() => b.challenges.verifyAndConsume({ ...request, consumedBy: b.name }), refused('challenge_replayed'));
  assert.equal(row(main.db, issued.challengeId).consumed_by, a.name);

  const barriers = new SharedArrayBuffer(4 * RACE_ROUNDS);
  const client = new URL('../src/index.mjs', import.meta.url).href;
  const workers = ['TEST-worker-1', 'TEST-worker-2'].map((name) => new Worker(RACE_WORKER, { eval: true, workerData: { path, client, barriers, options, now: NOW, name } }));
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));
  const answers = new Map();
  for (const worker of workers) {
    worker.on('message', (answer) => answers.get(answer.round).push(answer));
    worker.on('error', (error) => { throw error; });
  }
  for (let round = 0; round < RACE_ROUNDS; round++) {
    const challenge = main.issue();
    const roundRequest = { challengeId: challenge.challengeId, purpose: PURPOSE, expectedBinding: main.expectedBinding, signature: main.wallet.signHex(challenge.message) };
    const settled = new Promise((resolve) => {
      const results = [];
      answers.set(round, { push(answer) { results.push(answer); if (results.length === 2) resolve(results); } });
    });
    for (const worker of workers) worker.postMessage({ round, request: roundRequest });
    const results = await settled;
    const winners = results.filter((answer) => answer.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(results.find((answer) => !answer.ok).code, 'challenge_replayed', JSON.stringify(results));
    assert.equal(row(main.db, challenge.challengeId).consumed_by, winners[0].name);
  }
  assert.equal(main.db.prepare('SELECT count(*) AS n FROM challenges WHERE consumed_at IS NOT NULL').get().n, RACE_ROUNDS + 1);
});
