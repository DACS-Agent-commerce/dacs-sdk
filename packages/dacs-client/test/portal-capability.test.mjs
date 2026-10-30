import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPurchaseService } from '../src/purchases.mjs';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { PURCHASE_STATE_SCHEMA } from '../src/purchase-state-schema.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

const WALL = Date.parse('2030-01-01T00:00:00.000Z');
const LIFETIME = '2040-01-01T00:00:00.000Z';
const WALLET = '0x' + 'a'.repeat(64), HASH = '1'.repeat(64);
const METHODS = ['portalOperation', 'portalEvidence', 'protocolRecheck'];
const tokenHash = token => createHash('sha256').update(`dacs-handoff-hash:${token}`).digest('hex');
const denial = { code: 'not_found', message: 'unknown or invalid approval link' };

// Provision only with valid clocks; the service clock is independently mutable.
function fixture(t, { path = ':memory:' } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: WALL });
  const db = openDatabase(path), store = createSqlitePurchaseStore();
  t.after(() => db.close());
  let businessClock = WALL, lookup = null, refusal = null;
  const calls = { lookup: 0, coordinates: 0, readback: 0 };
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8), now: () => WALL });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)')
    .run('TEST-buyer', 'TEST', 'TEST-buyer', new Date(WALL).toISOString());
  const terms = { buyer: { wallet: WALLET }, seller: { claim: 'TEST-seller', payee: WALLET },
    price: { amount: '2.5', amountOs: '2500000000' }, network: 'testnet', rail: 'demos-native:DEM',
    listing: { listingId: 'TEST-listing', version: 1, contentHash: HASH },
    domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: HASH },
    protocol: { profile: 'TEST-profile' } };
  const makeOperation = key => {
    const operation = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: key,
      request: {}, status: 'broadcast_reported', terms, termsHash: HASH,
      expiresAt: new Date(WALL + 3600000).toISOString() }).operation;
    db.prepare('UPDATE operations SET handoff_expires_at=? WHERE id=?').run(LIFETIME, operation.id);
    return operation;
  };
  const op = makeOperation('TEST-first'), token = ops.handoffTokenFor(op.id);
  const coordinates = createCoordinateStore({ db, now: () => WALL });
  const getCoordinates = coordinates.get;
  coordinates.get = (...args) => { calls.coordinates++; return getCoordinates(...args); };
  // Deliberately permissive host: package authentication must stand alone.
  ops.getByHandoff = id => { calls.lookup++; return lookup ? lookup(id) : ops.get(op.accountId, id); };
  const closed = Object.assign(new Error('TEST-closed'), { code: 'buyer_access_closed' });
  const protocol = {
    assertBuyerAccess() { if (refusal) throw refusal; },
    async readIssued() { calls.readback++; return true; },
  };
  const service = () => createPurchaseService({ db, config: {}, ops, coordinates, protocol, store,
    now: () => typeof businessClock === 'function' ? businessClock() : businessClock,
    purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  let purchases = service();
  const run = (method, id = op.id, supplied = token) => {
    refusal = method === 'protocolRecheck' ? closed : null;
    return method === 'protocolRecheck'
      ? purchases.protocolRecheck({ operationId: id, token: supplied })
      : purchases[method](id, supplied);
  };
  const snapshot = () => ({
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
    changes: db.prepare('SELECT total_changes() n').get().n,
  });
  return { db, ops, op, token, coordinates, calls, run, snapshot, makeOperation,
    purchases: () => purchases, reopenService: () => { purchases = service(); },
    clock: value => { businessClock = value; }, host: value => { lookup = value; },
    buyerRefusal: value => { refusal = value; },
    patch: (column, value) => db.prepare(`UPDATE operations SET ${column}=? WHERE id=?`).run(value, op.id),
  };
}

async function positive(w, method) {
  const value = await w.run(method);
  assert.ok(value);
  if (method === 'protocolRecheck') assert.equal(value.verification.outcome, 'readback_only');
}

async function refused(w, method, id = w.op.id, token = w.token) {
  const before = { ...w.calls };
  await assert.rejects(async () => w.run(method, id, token), denial);
  assert.deepEqual(w.calls, before, 'denied before host lookup, coordinates or readback');
}

for (const method of METHODS) {
  test(`${method}: positive canonical capability and exact maximum input lengths`, async t => {
    const w = fixture(t);
    await positive(w, method);
    const id = 'i'.repeat(256), token = 't'.repeat(1024);
    w.db.prepare('DELETE FROM operation_events WHERE operation_id=?').run(w.op.id);
    w.patch('id', id);
    w.db.prepare('UPDATE operations SET handoff_token_hash=? WHERE id=?').run(tokenHash(token), id);
    assert.ok(await w.run(method, id, token));
  });

  for (const [label, field, value] of [
    ['missing id', 'id', undefined], ['empty id', 'id', ''], ['null id', 'id', null],
    ['object id', 'id', {}], ['boxed id', 'id', new String('TEST')], ['long id', 'id', 'x'.repeat(257)],
    ['missing token', 'token', undefined], ['empty token', 'token', ''], ['null token', 'token', null],
    ['object token', 'token', {}], ['numeric token', 'token', 1], ['long token', 'token', 'x'.repeat(1025)],
  ]) test(`${method}: ${label}`, async t => {
    const w = fixture(t);
    await positive(w, method);
    // Avoid default parameters when explicitly exercising undefined.
    const before = { ...w.calls };
    await assert.rejects(async () => {
      if (method === 'protocolRecheck') return w.purchases().protocolRecheck({ operationId: field === 'id' ? value : w.op.id, token: field === 'token' ? value : w.token });
      return w.purchases()[method](field === 'id' ? value : w.op.id, field === 'token' ? value : w.token);
    }, denial);
    assert.deepEqual(w.calls, before);
  });

  for (const [label, value] of [
    ['NaN', NaN], ['undefined', undefined], ['infinity', Infinity], ['negative infinity', -Infinity],
    ['string', '0'], ['null', null], ['object', {}], ['fraction', 1.5], ['negative', -1],
    ['out of range', 8640000000000001], ['bigint', 0n], ['symbol', Symbol('TEST-clock')],
  ]) test(`${method}: invalid business clock ${label} after valid provisioning`, async t => {
    const w = fixture(t);
    await positive(w, method);
    w.clock(value);
    await refused(w, method);
  });

  test(`${method}: throwing business clock refuses after valid provisioning`, async t => {
    const w = fixture(t);
    await positive(w, method);
    w.clock(() => { throw new Error('TEST-clock'); });
    await refused(w, method);
  });

  for (const [label, value] of [
    ['null', null], ['empty', ''], ['malformed', 'TEST-time'], ['expired', '1970-01-01T00:00:00.000Z'],
    ['sqlite', '2040-01-01 00:00:00'], ['local', '2040-01-01T00:00:00.000'],
    ['offset', '2040-01-01T00:00:00.000+00:00'], ['epoch text', String(Date.parse(LIFETIME))],
    ['normalized invalid date', '2040-02-30T00:00:00.000Z'],
  ]) test(`${method}: ${label} capability lifetime`, async t => {
    const w = fixture(t);
    await positive(w, method);
    w.patch('handoff_expires_at', value);
    await refused(w, method);
  });

  for (const [label, change] of [
    ['wrong token', async w => refused(w, method, w.op.id, 'TEST-wrong')],
    ['another operation token', async w => refused(w, method, w.op.id, w.ops.handoffTokenFor(w.makeOperation('TEST-second').id))],
    ['rotated token', async w => { w.patch('handoff_token_hash', tokenHash('TEST-rotated')); await refused(w, method); }],
    ['deleted row', async w => {
      w.db.prepare('DELETE FROM operation_events WHERE operation_id=?').run(w.op.id);
      w.db.prepare('DELETE FROM operations WHERE id=?').run(w.op.id);
      await refused(w, method);
    }],
    ['stored other kind', async w => { w.patch('kind', 'identity'); await refused(w, method); }],
    ['empty hash', async w => { w.patch('handoff_token_hash', ''); await refused(w, method); }],
    ['short hash', async w => { w.patch('handoff_token_hash', 'a'.repeat(63)); await refused(w, method); }],
    ['nonhex hash', async w => { w.patch('handoff_token_hash', 'g'.repeat(64)); await refused(w, method); }],
    ['uppercase hash', async w => { w.patch('handoff_token_hash', tokenHash(w.token).toUpperCase()); await refused(w, method); }],
  ]) test(`${method}: ${label} is checked fresh`, async t => {
    const w = fixture(t);
    await positive(w, method);
    await change(w);
  });

  for (const [label, change] of [
    ['missing operation', () => null], ['other id', op => ({ ...op, id: 'TEST-other' })],
    ['other kind', op => ({ ...op, kind: 'identity' })], ['other owner', op => ({ ...op, accountId: 'TEST-other' })],
    ['null terms', op => ({ ...op, terms: null })], ['missing terms', op => ({ ...op, terms: undefined })],
    ['missing buyer', op => ({ ...op, terms: {} })], ['null buyer', op => ({ ...op, terms: { buyer: null } })],
    ['missing wallet', op => ({ ...op, terms: { buyer: {} } })],
    ['empty wallet', op => ({ ...op, terms: { buyer: { wallet: '' } } })],
    ['non-string wallet', op => ({ ...op, terms: { buyer: { wallet: 42 } } })],
  ]) test(`${method}: host ${label} refuses before private reads`, async t => {
    const w = fixture(t);
    await positive(w, method);
    w.host(() => change(w.op));
    const before = { ...w.calls };
    await assert.rejects(async () => w.run(method), denial);
    assert.equal(w.calls.lookup, before.lookup + 1);
    assert.equal(w.calls.coordinates, before.coordinates);
    assert.equal(w.calls.readback, before.readback);
  });

  for (const clock of ['business', 'wall']) {
    test(`${method}: ${clock} expiry equality and stale business-clock boundary`, async t => {
      const w = fixture(t);
      await positive(w, method);
      const expiry = Date.parse(LIFETIME);
      if (clock === 'business') w.clock(expiry - 1);
      else { w.clock(0); t.mock.timers.setTime(expiry - 1); }
      await positive(w, method);
      if (clock === 'business') w.clock(expiry);
      else t.mock.timers.setTime(expiry);
      await refused(w, method);
    });
  }

  test(`${method}: exact-byte vector and whitespace distinction`, async t => {
    const w = fixture(t);
    await positive(w, method);
    w.patch('handoff_token_hash', 'afe0c673f2027d951dfa05cecb56c758114474d50893b91004207d3733a4fb55');
    assert.ok(await w.run(method, w.op.id, 'TEST-capability-vector'));
    await refused(w, method, w.op.id, 'TEST-capability-vector ');
  });

  for (const source of ['lookup', 'buyer-access']) test(`${method}: ${source} refusal identity survives`, async t => {
    const w = fixture(t), cause = new Error('TEST-host-refusal');
    await positive(w, method);
    const before = { ...w.calls };
    if (source === 'lookup') w.host(() => { throw cause; });
    else w.buyerRefusal(cause);
    await assert.rejects(async () => method === 'protocolRecheck'
      ? w.purchases().protocolRecheck({ operationId: w.op.id, token: w.token })
      : w.purchases()[method](w.op.id, w.token), error => error === cause);
    assert.equal(w.calls.coordinates, before.coordinates);
    assert.equal(w.calls.readback, before.readback);
  });
}

test('old evidence operation-object signature is refused', async t => {
  const w = fixture(t);
  await positive(w, 'portalEvidence');
  const before = { ...w.calls };
  assert.throws(() => w.purchases().portalEvidence(w.op), denial);
  assert.deepEqual(w.calls, before);
});

for (const method of METHODS) {
  for (const [label, value] of [['NaN', NaN], ['string', '0'], ['negative', -1], ['fraction', 1.5], ['bigint', 0n]]) {
    test(`${method}: invalid internal wall clock ${label} refuses before host lookup`, async t => {
      const w = fixture(t);
      await positive(w, method);
      t.mock.method(Date, 'now', () => value);
      await refused(w, method);
    });
  }
}

test('terms null is refused even without the optional protocol guard', async t => {
  const w = fixture(t);
  const service = createPurchaseService({ db: w.db, config: {}, ops: w.ops, coordinates: w.coordinates,
    store: createSqlitePurchaseStore(), now: () => WALL, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  assert.ok(service.portalEvidence(w.op.id, w.token));
  w.host(() => ({ ...w.op, terms: null }));
  const before = w.calls.coordinates;
  assert.throws(() => service.portalEvidence(w.op.id, w.token), denial);
  assert.equal(w.calls.coordinates, before);
});

for (const status of ['awaiting_approval', 'agreement_pending']) {
  test(`${status}: repeated/reopened evidence and status project expiry without writes`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'dacs-portal-read-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.sqlite'), w = fixture(t, { path });
    await positive(w, 'portalEvidence');
    w.patch('status', status);
    w.patch('expires_at', new Date(WALL - 1000).toISOString());
    const before = w.snapshot(), events = w.ops.history(w.op.id);
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal(w.purchases().portalEvidence(w.op.id, w.token).actionable, false);
      assert.equal(w.purchases().status(w.op.accountId, w.op.id).operation.status, 'expired');
      w.reopenService();
    }
    assert.deepEqual(w.snapshot(), before);
    assert.equal(w.ops.get(w.op.accountId, w.op.id).status, status);
    assert.deepEqual(w.ops.history(w.op.id), events);
    const reopened = new DatabaseSync(path);
    try {
      const restartedOps = createOperationStore({ db: reopened, handoffSecret: 'TEST-'.repeat(8), now: () => WALL });
      const restarted = createPurchaseService({ db: reopened, config: {}, ops: restartedOps,
        coordinates: createCoordinateStore({ db: reopened, now: () => WALL }), store: createSqlitePurchaseStore(),
        now: () => WALL, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
      for (let repeat = 0; repeat < 2; repeat++) {
        assert.equal(restarted.portalEvidence(w.op.id, w.token).actionable, false);
        assert.equal(restarted.status(w.op.accountId, w.op.id).operation.status, 'expired');
      }
      assert.equal(reopened.prepare('SELECT total_changes() n').get().n, 0);
      assert.equal(reopened.prepare('SELECT status FROM operations WHERE id=?').get(w.op.id).status, status);
      // A second running service must observe durable revocation too.
      w.patch('handoff_token_hash', tokenHash('TEST-rotated'));
      assert.throws(() => restarted.portalEvidence(w.op.id, w.token), denial);
      w.patch('handoff_token_hash', tokenHash(w.token));
    }
    finally { reopened.close(); }
    assert.equal(w.purchases().portalOperation(w.op.id, w.token).status, 'expired');
    assert.equal(w.ops.history(w.op.id).length, events.length + 1);
  });
}

for (const status of ['approved', 'payment_handoff', 'payment_uncertain', 'settled_verified', 'cancelled', 'expired']) {
  test(`${status}: evidence and status have no state or nonce effects`, async t => {
    const w = fixture(t);
    await positive(w, 'portalEvidence');
    w.patch('status', status);
    const before = w.snapshot();
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.ok(w.purchases().portalEvidence(w.op.id, w.token));
      assert.equal(w.purchases().status(w.op.accountId, w.op.id).operation.status, status);
    }
    assert.deepEqual(w.snapshot(), before);
  });
}

test('fresh evidence, concurrent reads, restart and revocation have no extra effects', async t => {
  const w = fixture(t);
  await positive(w, 'portalEvidence');
  assert.equal(w.purchases().portalEvidence(w.op.id, w.token).reportedTxHash, null);
  w.coordinates.save({ operationId: w.op.id, kind: 'native-dem-transfer', network: 'testnet', from: WALLET,
    nonceFence: 6, expectedNonce: 7, target: WALLET, amountOs: '2500000000', payload: {} });
  w.coordinates.reportHash(w.op.id, HASH);
  const before = w.snapshot();
  await Promise.all(Array.from({ length: 4 }, async () => {
    assert.equal(w.purchases().portalEvidence(w.op.id, w.token).reportedTxHash, HASH);
    assert.equal(w.purchases().status(w.op.accountId, w.op.id).coordinates.reportedTxHash, HASH);
  }));
  w.reopenService();
  assert.equal(w.purchases().portalEvidence(w.op.id, w.token).reportedTxHash, HASH);
  assert.deepEqual(w.snapshot(), before);
  w.patch('handoff_token_hash', tokenHash('TEST-revoked'));
  w.reopenService();
  await refused(w, 'portalEvidence');
});

test('schema preflight refuses before migration and accepts the migrated schema', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(PURCHASE_STATE_SCHEMA.replace('handoff_expires_at TEXT,', ''));
  const construct = () => createPurchaseService({ db, config: {}, store: createSqlitePurchaseStore(),
    purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  assert.throws(construct, error => error.code === 'schema_migration_required' && /handoff_expires_at/.test(error.message));
  db.exec('ALTER TABLE operations ADD COLUMN handoff_expires_at TEXT');
  assert.ok(construct());
});
