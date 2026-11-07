import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
import { createPublicPurchaseService as createPurchaseService } from '../src/purchases.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { diagnosticProtocolView as protocolView } from '../src/dacs/protocol-purchases.mjs';
import { deliveryDeadlineView } from '../src/dacs/delivery-deadline-watch.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
import { inTransaction, hasSqliteModule } from './helpers/sqlite-engine-floor.mjs';

function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-diagnostic-store-')), path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA synchronous=EXTRA; CREATE TABLE records (id TEXT PRIMARY KEY, value INTEGER DEFAULT 0)');
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { db, path, store: createSqlitePurchaseStore() };
}

test('updating an active SELECT iterator returns success exactly when the writes commit', t => {
  const { db, path, store } = database(t);
  db.exec("INSERT INTO records(id) VALUES ('one'), ('two')");
  let iterator;
  t.after(() => { try { iterator?.return(); } catch {} });
  assert.equal(store.transaction(db, () => {
    iterator = db.prepare('SELECT * FROM records').iterate();
    const row = iterator.next().value;
    db.prepare('UPDATE records SET value=value+1 WHERE id=?').run(row.id);
    return 'committed';
  }), 'committed');
  const reopened = new DatabaseSync(path);
  try { assert.equal(reopened.prepare('SELECT sum(value) n FROM records').get().n, 1); }
  finally { reopened.close(); }
});

// The engine floors lack FTS5 and RTREE, so a case that needs one skips there.
const MODULE_MISSING = 'this Node SQLite build does not include the requested optional module';
const lacksModule = (db, definition) => !hasSqliteModule(db, definition.split('(')[0]);

for (const module of ['fts5(body)', 'rtree(id, minX, maxX)']) {
  test(`unrelated ${module} virtual and shadow tables permit ordinary transactions`, t => {
    const { db, store } = database(t);
    if (lacksModule(db, module)) return t.skip(MODULE_MISSING);
    db.exec(`CREATE VIRTUAL TABLE search USING ${module}`);
    assert.equal(store.transaction(db, () => db.prepare('INSERT INTO records(id) VALUES (?)').run('one').changes), 1);
    assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 1);
  });
}

test('automatic rollback protects legal sqlite-prefixed host tables and retains an outer handle', t => {
  const { db, store } = database(t);
  db.exec("INSERT INTO records(id) VALUES ('existing'); CREATE TABLE sqliteCache (id TEXT)");
  const insert = db.prepare('INSERT INTO sqliteCache VALUES (?)');
  assert.throws(() => store.transaction(db, () => {
    assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records(id) VALUES ('existing')"), /UNIQUE/);
    assert.throws(() => insert.run('after'), /transaction ended/);
  }), { code: 'purchase_store_transaction_ended' });
  assert.equal(db.prepare('SELECT count(*) n FROM sqliteCache').get().n, 0);
  insert.run('outside');
  store.transaction(db, () => insert.run('retry'));
  assert.equal(db.prepare('SELECT count(*) n FROM sqliteCache').get().n, 2);
});

for (const nested of [false, true]) {
  test(`a returned promise cannot write after refusal (nested=${nested})`, async t => {
    const { db, path, store } = database(t);
    const insert = db.prepare('INSERT INTO records(id) VALUES (?)');
    let continued = false;
    const body = () => {
      insert.run('before');
      return Promise.resolve().then(() => { continued = true; insert.run('after'); });
    };
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()), { code: 'purchase_store_async_result' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(continued, true);
    assert.throws(() => insert.run('outside'), /closed|not open|finalized/i);
    const reopened = new DatabaseSync(path);
    try { assert.equal(reopened.prepare('SELECT count(*) n FROM records').get().n, 0); }
    finally { reopened.close(); }
  });
}

test('guards are reused at host scale and refresh for added or recreated tables', t => {
  const { db, store } = database(t);
  for (let i = 0; i < 400; i++) db.exec(`CREATE TABLE host_${i} (id TEXT)`);
  let serial = 0;
  const write = () => db.prepare('INSERT INTO records(id) VALUES (?)').run(`TEST-${serial++}`);
  store.transaction(db, write);
  const triggers = () => db.prepare("SELECT name FROM sqlite_temp_master WHERE type='trigger' ORDER BY name").all();
  const before = triggers();
  for (let i = 0; i < 5; i++) store.transaction(db, write);
  assert.deepEqual(triggers(), before);
  assert.equal(before.length, 401 * 3);
  for (const ddl of ['CREATE TABLE added (id TEXT)', 'DROP TABLE added; CREATE TABLE added (id TEXT)']) {
    db.exec(ddl);
    db.exec("INSERT INTO records(id) VALUES ('existing') ON CONFLICT DO NOTHING");
    assert.throws(() => store.transaction(db, () => {
      assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records(id) VALUES ('existing')"), /UNIQUE/);
      assert.throws(() => db.exec("INSERT INTO added VALUES ('after')"), /transaction ended/);
    }), { code: 'purchase_store_transaction_ended' });
    assert.equal(db.prepare('SELECT count(*) n FROM added').get().n, 0);
  }
  db.exec("INSERT INTO added VALUES ('outside')");
});

for (const [name, module, seed, write] of [
  ['FTS5 delete', 'fts5(body)', "INSERT INTO search VALUES ('TEST-existing')", 'DELETE FROM search'],
  ['RTree insert', 'rtree(id,minX,maxX)', 'INSERT INTO search VALUES (1,0,1)', 'INSERT INTO search VALUES (2,0,1)'],
  ['CTAS', null, "INSERT INTO search VALUES ('TEST-existing')", "CREATE TABLE escaped AS SELECT 'TEST-after' AS body"],
]) {
  test(`automatic rollback prevents ${name} writes on reopen`, t => {
    const { db, path, store } = database(t);
    if (module && lacksModule(db, module)) return t.skip(MODULE_MISSING);
    const ddl = module ? `CREATE VIRTUAL TABLE search USING ${module}` : 'CREATE TABLE search(body TEXT)';
    db.exec(`${ddl}; ${seed}; INSERT INTO records(id) VALUES ('TEST-existing')`);
    const prepared = db.prepare(write);
    assert.throws(() => store.transaction(db, () => {
      assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records(id) VALUES ('TEST-existing')"), /UNIQUE/);
      for (const execute of [() => db.exec(write), () => prepared.run(), () => prepared.get(), () => prepared.all(), () => [...prepared.iterate()]]) {
        assert.throws(execute, /transaction ended/);
      }
    }), { code: 'purchase_store_transaction_ended' });
    const reopened = new DatabaseSync(path);
    try {
      assert.equal(reopened.prepare('SELECT count(*) n FROM search').get().n, 1);
      assert.equal(reopened.prepare("SELECT count(*) n FROM sqlite_master WHERE name='escaped'").get().n, 0);
    } finally { reopened.close(); }
  });
}
test('detach and reattach of the same persistent file is refused on every call', t => {
  const { db, path, store } = database(t);
  store.transaction(db, () => {});
  for (const attempt of [1, 2]) {
    db.prepare('ATTACH DATABASE ? AS aux').run(`${path}.aux`);
    assert.throws(() => store.transaction(db, () => assert.fail('callback ran')),
      { code: 'purchase_store_persistent_attachment' });
    assert.equal(inTransaction(db), false);
    db.exec('DETACH aux');
    store.transaction(db, () => db.prepare('INSERT INTO records(id) VALUES (?)').run(`TEST-${attempt}`));
  }
  assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, 2);
});

function purchaseWorld(t) {
  const db = openDatabase(':memory:'), store = createSqlitePurchaseStore();
  t.after(() => db.close());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8) }), coordinates = createCoordinateStore({ db });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('buyer', 'TEST', 'buyer', new Date().toISOString());
  const operation = ops.createIdempotent({ accountId: 'buyer', kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'payment_handoff',
    terms: { buyer: { wallet: '0x' + 'a'.repeat(64) }, seller: { claim: 'seller', payee: '0x' + 'b'.repeat(64) }, protocol: {},
      price: { amountOs: '1000000000' }, listing: { listingId: 'TEST', version: 1, contentHash: 'f'.repeat(64) },
      network: 'testnet', rail: 'demos-native:DEM', domain: { network: 'testnet', chainIdentity: 'f'.repeat(64), mode: 'public-chain-read' } }, termsHash: 'f'.repeat(64),
    expiresAt: new Date(Date.now() + 3600000).toISOString(), state: { protocol: { stage: 'awaiting-countersignature',
      planned: { agreementMessage: 'TEST-agreement-sign', anchorMessage: 'TEST-anchor-sign' }, identity: { message: 'TEST-identity-sign' },
      sessionDelegation: { payload: { jobId: 'TEST-delegation-sign' }, signature: 'historical-signature' },
      bundle: { bundleHash: 'b'.repeat(64), message: 'TEST-bundle-sign' },
      agreement: { hash: 'f'.repeat(64), ref: { contentHash: 'f'.repeat(64) }, terms: { seller: 'seller', deadline: 1 },
        artifact: { terms: { deadline: 1 }, parties: [{ role: 'seller', primaryClaim: 'seller' }] } }, commitment: { verifiedAt: 'TEST' } } } }).operation;
  coordinates.save({ operationId: operation.id, kind: 'dem-transfer', network: 'testnet', from: operation.terms.buyer.wallet,
    nonceFence: 6, expectedNonce: 7, target: '0x' + 'b'.repeat(64), amountOs: '1000000000',
    payload: { type: 'native', nonce: 7, amount: 1000000000, data: ['send'] } });
  const chain = { getAddressNonce: async () => 6 };
  const purchases = createPurchaseService({ db, ops, coordinates, store, chain, config: {}, purposes: { APPROVE_PURCHASE: 'TEST' } });
  return { db, ops, coordinates, store, operation, purchases };
}

test('every public diagnostic omits payment payloads and signing messages while preserving identifiers', async t => {
  const w = purchaseWorld(t), { operation: op } = w;
  await assert.rejects(w.purchases.prepareHandoff({ operationId: op.id, token: w.ops.handoffTokenFor(op.id) }), { code: 'profile_not_admitted' });
  const before = w.ops.get(op.accountId, op.id), coords = w.coordinates.get(op.id);
  const status = w.purchases.status(op.accountId, op.id, w.ops.handoffTokenFor(op.id));
  const portal = w.purchases.portalOperation(op.id, w.ops.handoffTokenFor(op.id));
  for (const result of [status, portal, w.purchases.portalEvidence(op.id, w.ops.handoffTokenFor(op.id)), protocolView(before), await w.purchases.verifyDeal({ accountId: op.accountId, operationId: op.id, token: w.ops.handoffTokenFor(op.id) })]) {
    const json = JSON.stringify(result);
    assert.doesNotMatch(json, /"payload"|"agreementMessage"|"anchorMessage"|TEST-.*-sign/);
  }
  assert.equal(status.coordinates.expectedNonce, 7);
  assert.equal(status.coordinates.payloadHash, coords.payloadHash);
  assert.equal(status.protocol.bundle.bundleHash, 'b'.repeat(64));
  assert.deepEqual(w.ops.get(op.accountId, op.id), before);
  assert.deepEqual(w.coordinates.get(op.id), coords);
});

test('historical malformed overdue and delivery timestamps remain renderable after JSON roundtrip', () => {
  for (const timestamp of [Number.MAX_SAFE_INTEGER, -1, 'invalid', null]) {
    const operation = JSON.parse(JSON.stringify({ terms: { protocol: {} }, state: { protocol: { stage: 'payment-evidenced',
      deliveryDeadline: { overdue: { deadline: 1, checkedAt: timestamp }, laterDelivery: { deliveredAt: timestamp, deliveredAtSource: 'TEST' } } } } }));
    const view = deliveryDeadlineView(operation, { enabled: true });
    assert.match(view.message, /unavailable|invalid|unknown/i);
    assert.doesNotThrow(() => protocolView(operation));
  }
});
