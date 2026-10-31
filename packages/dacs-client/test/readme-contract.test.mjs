import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as client from '@kynesyslabs/dacs-client';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const contract = readme.slice(readme.indexOf('## Factory integration'));
const NOW = Date.UTC(2030, 0, 1), HASH = 'a'.repeat(64), IDENTITY = 'f'.repeat(64);
const PAYER = '0x' + 'b'.repeat(64), PAYEE = '0x' + 'c'.repeat(64);
const diagnostics = ['status', 'portalOperation', 'portalEvidence', 'verifyDeal'];
const readers = ['network', 'pinnedIdentity', 'networkIdentity', 'observePassiveTransfer'];
const passive = ['assertBuyerAccess', 'supportsMode', 'readIssued', 'readIssuedPayment', 'observeReportedPayment'];
const codes = ['purchase_store_persistent_attachment', 'purchase_store_unsupported_attachment',
  'purchase_store_unsupported_journal_mode', 'purchase_store_unsupported_synchronous',
  'purchase_store_unsupported_temp_journal_mode'];
const covered = new Set();
function probe(name, identifiers, body) {
  for (const id of identifiers) covered.add(id);
  test(name, body);
}
function section(name) {
  return contract.split(`### ${name}\n`)[1]?.split(/\n### |\n## /)[0] ?? '';
}
function database(t, file = false) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-readme-'));
  const db = new DatabaseSync(file ? join(dir, 'state.sqlite') : ':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(client.PURCHASE_STATE_SCHEMA);
  return { db, dir };
}
function world(t, { native = false, expired = false, reader = 'present', disposition, observation } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { db } = database(t), store = client.createSqlitePurchaseStore();
  const savedOps = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8), now: () => NOW });
  const coordinates = client.createCoordinateStore({ db });
  db.prepare('INSERT INTO accounts(id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)')
    .run('TEST-buyer', 'TEST', 'TEST-buyer', new Date(NOW).toISOString());
  const op = savedOps.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST',
    request: {}, status: expired ? 'awaiting_approval' : 'broadcast_reported',
    terms: { buyer: { wallet: PAYER }, seller: { payee: PAYEE }, price: { amountOs: '1000000000' },
      network: 'testnet', rail: 'demos-native:DEM', listing: { listingId: 'TEST-listing', version: 1, contentHash: IDENTITY },
      domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: IDENTITY },
      ...(native ? { protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',
        nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' } } : {}) },
    termsHash: IDENTITY, expiresAt: new Date(NOW + (expired ? -1 : 3600000)).toISOString() }).operation;
  // The handoff lifetime remains independent of the approval window.
  db.prepare('UPDATE operations SET handoff_expires_at=? WHERE id=?').run(new Date(NOW + 3600000).toISOString(), op.id);
  coordinates.save({ operationId: op.id, kind: 'native-dem-transfer', network: 'testnet', from: PAYER,
    nonceFence: 6, expectedNonce: 7, target: PAYEE, amountOs: '1000000000', payload: {} });
  coordinates.reportHash(op.id, HASH);
  const touched = new Set(), chainTouched = new Set();
  const ops = new Proxy({}, { get(_target, key) {
    touched.add(key);
    assert.ok(['get', 'getByHandoff', 'history'].includes(key), String(key));
    return savedOps[key];
  } });
  let activeCalls = 0;
  const chain = new Proxy({ network: 'testnet', pinnedIdentity: IDENTITY,
    networkIdentity: async () => ({ identity: IDENTITY, mode: 'public-chain-read' }),
    observeTransfer: () => { activeCalls++; throw new Error('TEST-active-reader-called'); },
    ...(reader === 'absent' ? {} : { observePassiveTransfer: reader === 'noncallable' ? true : async () => observation ? observation() : ({
      status: 'included', txHash: HASH, payer: PAYER, payee: PAYEE, amountOs: '1000000000', blockNumber: 7,
      ...(disposition === undefined ? {} : { sourceDisposition: disposition }),
    }) }),
  }, { get(target, key) { chainTouched.add(key); return target[key]; } });
  const service = client.createPurchaseService({ db, ops, coordinates, chain, store, now: () => NOW,
    config: {}, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  const token = savedOps.handoffTokenFor(op.id);
  return { db, op, coordinates, touched, chainTouched, service,
    activeCalls: () => activeCalls,
    verify: () => service.verifyDeal({ accountId: op.accountId, operationId: op.id, token, txHash: HASH }),
    snapshot: () => ({ operation: savedOps.get(op.accountId, op.id), events: savedOps.history(op.id), coordinates: coordinates.get(op.id) }),
    token };
}

function observationRows() {
  return [...section('Chain reader').matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map(([, field, presence, rule]) => ({ field, presence: presence.trim(), rule: rule.trim() }));
}
const includedObservation = () => ({ status: 'included', txHash: HASH, payer: PAYER, payee: PAYEE,
  amountOs: '1000000000', blockNumber: 7, reason: 'TEST-observed', includedAt: NOW, sourceDisposition: 'included' });
async function readObservation(w, value) {
  w.observation.value = value;
  const before = w.snapshot();
  const result = (await w.verify()).verification;
  assert.equal(result.outcome, 'readback_only');
  assert.deepEqual(w.snapshot(), before);
  return result;
}
function observationWorld(t, native = false) {
  const observation = { value: includedObservation() };
  return { ...world(t, { native, observation: () => observation.value }), observation };
}
const observationPresence = { status: 'always', reason: 'optional', txHash: 'included', payer: 'included',
  payee: 'included', amountOs: 'included', blockNumber: 'included', includedAt: 'optional', sourceDisposition: 'optional' };
probe('README observation table states every field and its presence', Object.keys(observationPresence), () => {
  assert.deepEqual(observationRows().map(({ field, presence }) => [field, presence]), Object.entries(observationPresence));
  assert.doesNotMatch(section('Chain reader'), /optional block number/);
});
for (const [field, presence] of Object.entries(observationPresence)) {
  probe(`README observation omission: ${field} is ${presence}`, [field], async t => {
    assert.equal(observationRows().find(row => row.field === field)?.presence, presence);
    const w = observationWorld(t);
    for (const explicitUndefined of [false, true]) {
      const value = includedObservation();
      if (explicitUndefined) value[field] = undefined;
      else delete value[field];
      const { observation } = await readObservation(w, value);
      assert.equal(observation.status, presence === 'optional' ? 'included' : 'malformed');
      if (field === 'blockNumber') assert.equal(observation.reason, 'included blockNumber must be a nonnegative safe integer');
    }
  });
}
for (const [field, rule, accepted, rejected] of [
  ['blockNumber', /nonnegative safe integer/, [0, Number.MAX_SAFE_INTEGER], [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', null]],
  ['amountOs', /`OS_INTEGER`.*78 digits/, ['0', '9'.repeat(78)], ['9'.repeat(79), '01', '1.0', '-1', '', 1000000000]],
  ['includedAt', /integer epoch milliseconds.*8640000000000000/, [0, 8640000000000000], [8640000000000001, -1, 1.5, 'x', null]],
  ['txHash', /requested hash.*64 hex characters.*optional `0x`/, [HASH, '0x' + HASH.toUpperCase()], ['d'.repeat(64), 'x', 1, null]],
  ...['payer', 'payee'].map(field => [field, /readable Demos address.*66 characters/, [PAYER, PAYEE], ['TEST-buyer', 'b'.repeat(67), 1, null]]),
  ['reason', /text.*240 characters/, ['', 'x'.repeat(240)], ['x'.repeat(241), 1, null]],
]) probe(`README observation bounds: ${field}`, [field, ...(field === 'txHash' ? ['0x'] : [])], async t => {
  assert.match(observationRows().find(row => row.field === field)?.rule ?? '', rule);
  const w = observationWorld(t);
  for (const value of accepted) {
    const { observation } = await readObservation(w, { ...includedObservation(), [field]: value });
    assert.equal(observation.status, 'included', String(value));
    assert.equal(observation[field], value);
  }
  for (const value of rejected) {
    assert.equal((await readObservation(w, { ...includedObservation(), [field]: value })).observation.status, 'malformed', String(value));
  }
});
for (const [field, alias] of [['txHash', 'hash'], ['amountOs', 'amount'], ['blockNumber', 'block']]) {
  probe(`README observation requires ${field} rather than ${alias}`, [field], async t => {
    assert.ok(observationRows().some(row => row.field === field));
    const value = includedObservation(), w = observationWorld(t);
    value[alias] = value[field]; delete value[field];
    assert.equal((await readObservation(w, value)).observation.status, 'malformed');
  });
}
probe('README observation status table drives included and non-included readback',
  ['pending', 'not-found', 'invalid', 'unavailable', 'malformed', 'termsMatch'], async t => {
    const rule = observationRows().find(row => row.field === 'status')?.rule ?? '';
    const statuses = [...rule.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    assert.deepEqual(statuses, ['included', 'pending', 'not-found', 'failed', 'invalid', 'unavailable']);
    assert.match(section('Chain reader'), /Any other shape yields `status` `malformed` with a `reason`/);
    const w = observationWorld(t);
    for (const status of statuses) {
      const value = status === 'included' ? includedObservation() : { status, reason: 'TEST-observed' };
      const result = await readObservation(w, value);
      assert.equal(result.observation.status, status);
      assert.equal(result.termsMatch, status === 'included' ? true : null);
    }
    for (const value of [null, [], 'included', 1, { status: 'confirmed' }, { status: 'pending', reason: 1 },
      { status: 'pending', sourceDisposition: 'confirmed' }, { status: 'pending', reason: 'x'.repeat(241) }]) {
      const result = await readObservation(w, value);
      assert.equal(result.observation.status, 'malformed');
      assert.equal(result.termsMatch, null);
    }
    // Unknown extensions are omitted, rather than traversed or returned.
    const result = await readObservation(w, { ...includedObservation(), extension: { nested: [] } });
    assert.equal(result.observation.status, 'included');
    assert.equal(Object.hasOwn(result.observation, 'extension'), false);
  });
for (const native of [false, true]) probe(`README termsMatch result branches, native=${native}`, ['termsMatch'], async t => {
  assert.match(section('Chain reader'), /`termsMatch` compares payer, payee and amount; it is null unless/);
  const w = observationWorld(t, native);
  for (const sourceDisposition of [undefined, 'included', 'failed']) {
    const result = await readObservation(w, { ...includedObservation(), sourceDisposition });
    assert.equal(result.termsMatch, sourceDisposition === 'failed' ? null : true);
  }
  for (const patch of [{ payer: PAYEE }, { payee: PAYER }, { amountOs: '1' }]) {
    const result = await readObservation(w, { ...includedObservation(), ...patch });
    assert.equal(result.observation.status, 'included');
    assert.equal(result.termsMatch, false);
  }
});

for (const native of [false, true]) for (const reader of ['present', 'absent', 'noncallable']) {
  probe(`README passive reader contract, native=${native}, reader=${reader}`, readers, async t => {
    assert.match(section('Chain reader'), /legacy and native/);
    assert.doesNotMatch(section('Chain reader'), /fallback|observeTransfer/);
    const w = world(t, { native, reader }), before = w.snapshot();
    for (let repeat = 0; repeat < 2; repeat++) {
      const { verification } = await w.verify();
      assert.equal(verification.outcome, 'readback_only');
      assert.equal(verification.observation.status, reader === 'present' ? 'included' : 'unavailable');
      if (reader !== 'present') assert.equal(verification.observation.code, 'passive_reader_unavailable');
      assert.equal(w.activeCalls(), 0);
      assert.deepEqual(w.snapshot(), before);
    }
    assert.deepEqual([...w.chainTouched].sort(), readers.slice().sort());
  });
}
for (const expired of [false, true]) probe(`README diagnostics use only the closed ops list, expired=${expired}`,
  [...diagnostics, 'ops', 'get', 'getByHandoff', 'history'], async t => {
    const w = world(t, { expired }), before = w.snapshot();
    assert.deepEqual([...section('Diagnostics').matchAll(/`([^`]+)`/g)].map(m => m[1]), diagnostics);
    assert.deepEqual([...section('Operations').matchAll(/`([^`]+)`/g)].map(m => m[1]), ['ops', 'get', 'getByHandoff', 'history', 'transition', 'watch.observe']);
    w.service.status(w.op.accountId, w.op.id, w.token);
    w.service.portalOperation(w.op.id, w.token);
    w.service.portalEvidence(w.op.id, w.token);
    await w.verify();
    assert.deepEqual([...w.touched].sort(), ['get', 'getByHandoff', 'history'].sort());
    assert.deepEqual(w.snapshot(), before);
  });
for (const disposition of ['included', 'failed', 'confirmed', 'pending', '', null, 1, {}]) {
  probe(`README sourceDisposition=${JSON.stringify(disposition)}`, ['sourceDisposition', 'included', 'failed'], async t => {
    assert.match(section('Chain reader'), /`sourceDisposition`.*exactly `included` or `failed`/);
    const w = world(t, { disposition }), before = w.snapshot();
    const { verification } = await w.verify();
    assert.equal(verification.observation.status, ['included', 'failed'].includes(disposition) ? 'included' : 'malformed');
    assert.deepEqual(w.snapshot(), before);
  });
}
probe('README protocol pass-through behavior and every held method', passive.concat('profile_not_admitted'), async t => {
  const { db } = database(t), store = client.createSqlitePurchaseStore();
  let hostCalls = 0;
  const protocol = client.createProtocolPurchases({ db, store, ops: {}, coordinates: client.createCoordinateStore({ db }),
    dacsProtocol: {}, buyerAccess: { assertWallet(wallet) { assert.equal(wallet, PAYER); hostCalls++; } } });
  assert.deepEqual([...section('Protocol').matchAll(/`([^`]+)`/g)].map(m => m[1]), [...passive, 'profile_not_admitted']);
  assert.equal(protocol.assertBuyerAccess(PAYER), undefined);
  assert.equal(hostCalls, 1);
  assert.equal(protocol.supportsMode('TEST-unknown'), false);
  assert.equal(await protocol.readIssued({}), null);
  assert.equal(await protocol.readIssuedPayment({}, HASH), null);
  assert.equal(await protocol.observeReportedPayment(HASH), null);
  for (const [name, method] of Object.entries(protocol)) {
    if (typeof method === 'function' && !passive.includes(name)) {
      assert.throws(() => method({ id: 'TEST-operation' }, 'TEST-hold'), { code: 'profile_not_admitted' }, name);
    }
  }
  assert.throws(() => protocol.holdChainReadback({}, 'TEST-hold'), { code: 'profile_not_admitted' });
  assert.equal(hostCalls, 1);
});
probe('README writer list admits only watch.observe host bookkeeping', ['watch.observe', 'transition'], t => {
  assert.deepEqual([...section('Writers').matchAll(/`([^`]+)`/g)].map(m => m[1]), ['watch.observe']);
  assert.match(section('Writers'), /cannot establish settlement/);
  const { db } = database(t), store = client.createSqlitePurchaseStore(), deadline = NOW - 300000;
  const op = { id: 'TEST-operation', accountId: 'TEST-buyer', kind: 'purchase', status: 'settled_verified',
    terms: { protocol: {}, seller: { claim: 'TEST-seller' } }, state: { protocol: { stage: 'payment-evidenced',
      agreement: { hash: HASH, ref: { contentHash: HASH }, terms: { seller: 'TEST-seller', deadline },
        artifact: { terms: { deadline }, parties: [{ role: 'seller', primaryClaim: 'TEST-seller' }] } },
      commitment: { verifiedAt: NOW } } } };
  let transitions = 0;
  const ops = { get: () => op, transition(id, from, to, patch) {
    assert.equal(id, op.id); assert.equal(from, op.status); assert.equal(to, op.status);
    assert.equal(patch.event, 'protocol_delivery_deadline_overdue');
    assert.equal(patch.state.protocol.deliveryDeadline.overdue.authority, 'local-observation');
    transitions++; return { ...op, state: patch.state };
  } };
  const watch = client.createDeliveryDeadlineWatch({ db, ops, store, coordinates: { get: () => ({ verifiedAt: NOW }) }, enabled: true, now: () => NOW });
  assert.equal(watch.observe(op, { notPresent: true, delivery: { status: 'absent' }, checkedAt: NOW }).status, 'settled_verified');
  assert.equal(transitions, 1);
});

for (const persistent of [false, true]) for (const after of [false, true]) {
  probe(`README refuses attachments before callback, file=${persistent}, after=${after}`, codes.slice(0, 2), t => {
    assert.match(section('Database admission'), /main and TEMP only/);
    for (const code of codes) assert.ok(section('Database admission').includes('`' + code + '`'), code);
    const { db, dir } = database(t), store = client.createSqlitePurchaseStore();
    if (after) store.transaction(db, () => {});
    db.prepare('ATTACH ? AS extra').run(persistent ? join(dir, 'extra.sqlite') : ':memory:');
    let called = false;
    assert.throws(() => store.transaction(db, () => { called = true; }), { code: codes[persistent ? 0 : 1] });
    assert.equal(called, false);
  });
}
for (const [label, setup, code] of [
  ['file defaults', '', codes[3]], ['main OFF', 'PRAGMA journal_mode=OFF', codes[2]],
  ['TEMP OFF', 'PRAGMA synchronous=EXTRA; CREATE TEMP TABLE records(value); PRAGMA temp.journal_mode=OFF', codes[4]],
  ['WAL FULL', 'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL', null],
  ['WAL EXTRA', 'PRAGMA journal_mode=WAL; PRAGMA synchronous=EXTRA', null],
  ...['DELETE', 'TRUNCATE', 'PERSIST'].map(mode => [mode + ' EXTRA', `PRAGMA journal_mode=${mode}; PRAGMA synchronous=EXTRA`, null]),
]) probe(`README database settings ${label}`, codes.slice(2), t => {
  assert.match(section('Database admission'), /WAL.*FULL or EXTRA.*rollback.*EXTRA/);
  const { db } = database(t, true), store = client.createSqlitePurchaseStore();
  if (setup) db.exec(setup);
  let called = false;
  const run = () => store.transaction(db, () => { called = true; });
  if (code) assert.throws(run, { code }); else run();
  assert.equal(called, !code);
});
for (const write of [false, true]) probe(`README store-first ${write ? 'write' : 'read'} statements in a fresh process`,
  ['DatabaseSync', 'store.transaction'], () => {
    assert.match(contract, /reads as well as writes/);
    const source = `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { createSqlitePurchaseStore } from '@kynesyslabs/dacs-client';
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE records(value TEXT)');
      const sql = ${JSON.stringify(write ? "INSERT INTO records VALUES ('TEST')" : 'SELECT * FROM records')};
      const early = db.prepare(sql), store = createSqlitePurchaseStore();
      assert.throws(() => store.transaction(db, () => { early.${write ? 'run' : 'all'}(); }), { name: 'TypeError', message: /unrecognized function opcodes/ });
      const later = db.prepare(sql);
      store.transaction(db, () => { later.${write ? 'run' : 'all'}(); });
      assert.equal(db.prepare('SELECT count(*) n FROM records').get().n, ${write ? 1 : 0});
      db.close();`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
  });
probe('README required schema table exactly matches the exported schema', [], t => {
  const { db } = database(t);
  const expected = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [row.type, row.name]);
  const documented = [...section('Schema').matchAll(/^\| (table|index) \| `([^`]+)` \|$/gm)]
    .map(m => [m[1], m[2]]).sort((a, b) => a[1].localeCompare(b[1]));
  assert.deepEqual(documented, expected);
  for (const [, name] of expected) covered.add(name);
});
test('README public contract has no private or coverage claims and closes every inline identifier', () => {
  assert.doesNotMatch(contract, /retained|SIGKILL|\bCI\b|test.coverage|tests cover|tests also|fixture records/i);
  assert.equal(section('Validation').trim(), 'Run `npm test --workspace @kynesyslabs/dacs-client` after building the SDK.');
  for (const [, id] of contract.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    assert.ok(Object.hasOwn(client, id) || covered.has(id) || id === 'npm test --workspace @kynesyslabs/dacs-client', id);
  }
});
