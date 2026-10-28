import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSqlitePurchaseStore, createPurchaseService, createCoordinateStore,
  createDeliveryDeadlineWatch, createDirectoryClient, protocolView } from '@kynesyslabs/dacs-client';
import { deliveryDeadlineView } from '../src/dacs/delivery-deadline-watch.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
import { openWorld, ABSENT } from './helpers/domain-store-crash-world.mjs';

function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-diagnostic-store-')), path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, value INTEGER DEFAULT 0)');
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

for (const module of ['fts5(body)', 'rtree(id, minX, maxX)']) {
  test(`unrelated ${module} virtual and shadow tables permit ordinary transactions`, t => {
    const { db, store } = database(t);
    if (!db.prepare('PRAGMA module_list').all().some(row => row.name === module.split('(')[0])) {
      return t.skip('this Node SQLite build does not include the requested optional module');
    }
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
  }), { code: 'client_not_wired' });
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
    assert.throws(() => store.transaction(db, () => nested ? store.transaction(db, body) : body()), { code: 'client_not_wired' });
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
  const write = () => db.exec("INSERT INTO records(id) VALUES (lower(hex(randomblob(8))))");
  store.transaction(db, write);
  const triggers = () => db.prepare("SELECT name FROM sqlite_temp_master WHERE type='trigger' ORDER BY name").all();
  const before = triggers(), start = performance.now();
  for (let i = 0; i < 5; i++) store.transaction(db, write);
  assert.deepEqual(triggers(), before);
  assert.equal(before.length, 401 * 3);
  assert.ok((performance.now() - start) / 5 < 100, 'warm transactions should take less than 100 ms at 400 host tables');
  for (const ddl of ['CREATE TABLE added (id TEXT)', 'DROP TABLE added; CREATE TABLE added (id TEXT)']) {
    db.exec(ddl);
    db.exec("INSERT INTO records(id) VALUES ('existing') ON CONFLICT DO NOTHING");
    assert.throws(() => store.transaction(db, () => {
      assert.throws(() => db.exec("INSERT OR ROLLBACK INTO records(id) VALUES ('existing')"), /UNIQUE/);
      assert.throws(() => db.exec("INSERT INTO added VALUES ('after')"), /transaction ended/);
    }), { code: 'client_not_wired' });
    assert.equal(db.prepare('SELECT count(*) n FROM added').get().n, 0);
  }
  db.exec("INSERT INTO added VALUES ('outside')");
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

test('public watch refuses a host promise before its continuation can persist an overdue event', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-watch-store-')), path = join(dir, 'state.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const world = openWorld(path);
  world.seed('delivery');
  const before = world.snapshot('delivery'), op = world.operation('delivery');
  const transition = world.ops.transition.bind(world.ops);
  world.ops.transition = (...args) => Promise.resolve().then(() => transition(...args));
  const watch = createDeliveryDeadlineWatch({ ...world, store: createSqlitePurchaseStore(), enabled: true });
  assert.throws(() => watch.observe(op, ABSENT), { code: 'client_not_wired' });
  await new Promise(resolve => setImmediate(resolve));
  const reopened = openWorld(path);
  try { assert.deepEqual(reopened.snapshot('delivery'), before); }
  finally { reopened.db.close(); }
});

for (const checkedAt of [8640000000000000, 8640000000000001, Number.MAX_SAFE_INTEGER]) {
  test(`deadline observation checks the Date range (${checkedAt})`, t => {
    const w = purchaseWorld(t);
    w.db.prepare("UPDATE operations SET status='settled_verified', state=json_set(state, '$.protocol.stage', 'payment-evidenced') WHERE id=?").run(w.operation.id);
    const op = w.ops.get(w.operation.accountId, w.operation.id);
    const watch = createDeliveryDeadlineWatch({ ...w, enabled: true, now: () => 8640000000000000, coordinates: { get: () => ({ verifiedAt: 'TEST' }) } });
    const result = watch.observe(op, { notPresent: true, delivery: { status: 'absent' }, checkedAt });
    assert.equal(Boolean(result.state.protocol.deliveryDeadline?.overdue), checkedAt === 8640000000000000);
    assert.doesNotThrow(() => deliveryDeadlineView(result, { enabled: true }));
  });
}

test('historical malformed overdue and delivery timestamps remain renderable after JSON roundtrip', () => {
  for (const timestamp of [Number.MAX_SAFE_INTEGER, -1, 'invalid', null]) {
    const operation = JSON.parse(JSON.stringify({ terms: { protocol: {} }, state: { protocol: { stage: 'payment-evidenced',
      deliveryDeadline: { overdue: { deadline: 1, checkedAt: timestamp }, laterDelivery: { deliveredAt: timestamp, deliveredAtSource: 'TEST' } } } } }));
    const view = deliveryDeadlineView(operation, { enabled: true });
    assert.match(view.message, /unavailable|invalid|unknown/i);
    assert.doesNotThrow(() => protocolView(operation));
  }
});

test('Directory search drops oversized rails without truncating or losing bounded identifiers', async () => {
  const raw = { listingId: 'test', version: 1, contentHash: 'a'.repeat(64), status: 'active',
    anchor: { kind: 'storage-program', locator: 'stor-' + 'b'.repeat(40) }, seller: { primaryClaim: 'did:demos:agent:' + 'c'.repeat(64) },
    offering: { rails: ['x'.repeat(900000), 'x'.repeat(257), 'demos-native:DEM', 'x'.repeat(256)] } };
  const client = createDirectoryClient({ origin: 'https://directory.invalid', fetchImpl: async () => new Response(JSON.stringify({ listings: [raw] }), { headers: { 'content-type': 'application/json' } }) });
  const result = await client.search();
  assert.deepEqual(result.listings[0].rails, ['demos-native:DEM', 'x'.repeat(256)]);
  assert.ok(JSON.stringify(result).length < 4000);
});

test('public deadline guidance distinguishes payment readback from held delivery checks', () => {
  const operation = { state: { protocol: { agreement: { artifact: { terms: { deadline: 0 } } } } } };
  const result = deliveryDeadlineView(operation, { now: () => 1000, enabled: true });
  assert.match(result.message, /payment transfer only/);
  assert.match(result.message, /delivery checking remains held/);
  assert.doesNotMatch(result.message, /verify_deal checks the chain again/);
});

for (const offset of [1, 7 * 24 * 3600000, 1700000000000000]) {
  test(`deadline watch ignores a future host observation (+${offset} ms), accepts current time`, t => {
    const w = purchaseWorld(t), clock = Date.now();
    const watch = createDeliveryDeadlineWatch({ db: w.db, ops: w.ops, coordinates: w.coordinates,
      store: createSqlitePurchaseStore(), enabled: true, now: () => clock });
    w.ops.transition(w.operation.id, 'payment_handoff', 'settled_verified');
    w.coordinates.recordObservation(w.operation.id, { status: 'included' }, true, null);
    w.db.prepare("UPDATE operations SET state=json_set(state, '$.protocol.stage', 'payment-evidenced') WHERE id=?").run(w.operation.id);
    const operation = w.ops.get(w.operation.accountId, w.operation.id), before = w.ops.history(w.operation.id);
    const observation = { notPresent: true, delivery: { status: 'absent' }, checkedAt: clock + offset };
    watch.observe(operation, observation);
    assert.equal(w.ops.get(w.operation.accountId, w.operation.id).state.protocol.deliveryDeadline, undefined);
    assert.deepEqual(w.ops.history(w.operation.id), before);
    watch.observe(operation, { ...observation, checkedAt: clock });
    assert.equal(w.ops.get(w.operation.accountId, w.operation.id).state.protocol.deliveryDeadline.overdue.checkedAt, clock);
  });
}

test('a microsecond report cannot mark a future delivery deadline overdue', t => {
  const w = purchaseWorld(t), clock = Date.now(), deadline = clock + 7 * 24 * 3600000;
  const op = structuredClone(w.operation);
  op.state.protocol.stage = 'payment-evidenced';
  op.state.protocol.agreement.terms.deadline = deadline;
  op.state.protocol.agreement.artifact.terms.deadline = deadline;
  w.db.prepare('UPDATE operations SET status=?, state=? WHERE id=?').run('settled_verified', JSON.stringify(op.state), op.id);
  const watch = createDeliveryDeadlineWatch({ ...w, now: () => clock, enabled: true,
    coordinates: { get: () => ({ verifiedAt: 'TEST' }) } });
  const current = w.ops.get(op.accountId, op.id), history = w.ops.history(op.id);
  watch.observe(current, { notPresent: true, delivery: { status: 'absent' }, checkedAt: clock * 1000 });
  assert.equal(w.ops.get(op.accountId, op.id).state.protocol.deliveryDeadline, undefined);
  assert.deepEqual(w.ops.history(op.id), history);
});
