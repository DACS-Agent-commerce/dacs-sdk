// A purchase's job id is reserved by the operations table's unique job_id index,
// written in the same insert as the terms, inside the create transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCanonicalJobId, isCanonicalJobId } from '@kynesyslabs/dacs';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './helpers/purchase-admission-hook.mjs';

installPurchaseAdmissionHook();
const { setPurchaseAdmission } = await loadAdmissionDouble();
const { createPurchaseService } = await import('../src/purchases.mjs');
const { OFFLINE_AGREEMENT_MODE } = await import('../src/dacs/protocol-purchases.mjs');
const { createCoordinateStore } = await import('../src/dacs/wallet-transactions.mjs');
const { OperationError } = await import('../src/client-errors.mjs');
const { createOperationStore } = await import('./helpers/purchase-integrity-operations.mjs');
const { openDatabase, transaction, isUniqueViolation } = await import('./helpers/purchase-integrity-database.mjs');

const JOB_ID_ATTEMPTS = 3;
const jobIdFrom = (seed) => generateCanonicalJobId({ timestamp: 1_700_000_000_000, entropy: new Uint8Array(10).fill(seed) });
const FIRST = jobIdFrom(1), SECOND = jobIdFrom(2), THIRD = jobIdFrom(3);

function world(t, { generateJobId } = {}) {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const chainIdentity = 'c'.repeat(64), wallet = '0x' + 'a'.repeat(64), payee = '0x' + 'b'.repeat(64);
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date().toISOString());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-' + 'offline-approval-'.repeat(3) });
  const price = { amount: '1', amountOs: '1000000000' };
  const generated = [];
  const protocol = { supportsMode: () => true, assertSellerAdmission: async () => {},
    prepareTerms: () => ({ terms: { profile: 'TEST-profile' }, state: { stage: 'identity', attempts: [] } }) };
  const chain = { network: 'testnet', pinnedIdentity: chainIdentity,
    networkIdentity: async () => ({ identity: chainIdentity, mode: 'public-chain-read' }),
    getAddressBalance: async () => 10n ** 15n, getTransactionFees: async () => 1n };
  const verifier = { verify: async () => ({ transactable: true, anchor: { kind: 'storage-program', locator: 'TEST-locator' }, checks: [], contentHash: chainIdentity, price, payee, evidence: {}, listing: { seller: {} } }) };
  const options = { db, ops, coordinates: createCoordinateStore({ db }), store: { transaction, isUniqueViolation }, purposes: { APPROVE_PURCHASE: 'TEST-host-approval-purpose' },
    challenges: {}, chain, verifier, accounts: { listWallets: () => [{ address: wallet }] }, protocol,
    config: { demAmountEncoding: 'os-string', publicOrigin: 'https://portal.invalid', purchaseLimits: { maxUnpaidPerAccount: 10, maxUnpaidPerWallet: 10, maxStartsPerHour: 10 } } };
  if (generateJobId) options.generateJobId = () => { const id = generateJobId(generated.length); generated.push(id); return id; };
  const prepare = (key) => createPurchaseService(options).prepare({ accountId: 'TEST-buyer', listingId: 'TEST-listing', version: 1, seller: 'TEST-seller',
    idempotencyKey: key, walletAddress: wallet, protocol: OFFLINE_AGREEMENT_MODE });
  const rows = () => db.prepare('SELECT id, job_id, terms FROM operations ORDER BY created_at, id').all();
  return { db, ops, prepare, generated, rows, options };
}

const insertOperation = (db, id, jobId) => db.prepare(`INSERT INTO operations (id,account_id,kind,idempotency_key,request_hash,status,terms,terms_hash,handoff_token_hash,expires_at,created_at,updated_at,job_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'TEST-buyer', 'purchase', id, 'TEST-hash', 'agreement_pending', '{}', 'TEST-terms-hash', 'TEST-handoff-' + id, 'TEST-expiry', 'TEST-time', 'TEST-time', jobId);

test('schema refuses a second operation with the same job id', (t) => {
  const { db } = world(t);
  insertOperation(db, 'TEST-op-1', FIRST);
  assert.throws(() => insertOperation(db, 'TEST-op-2', FIRST), (error) => isUniqueViolation(error) && /operations\.job_id/.test(error.message));
});

test('schema keeps job_id optional for purchases without a protocol job', (t) => {
  const { db } = world(t);
  insertOperation(db, 'TEST-op-1', null);
  insertOperation(db, 'TEST-op-2', null);
  assert.equal(db.prepare('SELECT count(*) n FROM operations WHERE job_id IS NULL').get().n, 2);
});

test('stored job_id equals the job id in the terms', async (t) => {
  const w = world(t, { generateJobId: () => FIRST });
  const { operation, created } = await w.prepare('TEST-key-1');
  assert.equal(created, true);
  const [row] = w.rows();
  assert.equal(row.job_id, FIRST);
  assert.equal(JSON.parse(row.terms).protocol.jobId, row.job_id);
  assert.equal(operation.terms.protocol.jobId, FIRST);
});

test('terms hash covers the job id that was stored', async (t) => {
  const w = world(t, { generateJobId: () => FIRST });
  const { operation } = await w.prepare('TEST-key-1');
  const { contentHash } = await import('@kynesyslabs/dacs');
  assert.equal(operation.termsHash, contentHash(operation.terms));
});

test('default generator produces a canonical job id', async (t) => {
  const w = world(t);
  const { operation } = await w.prepare('TEST-key-1');
  assert.equal(isCanonicalJobId(operation.terms.protocol.jobId), true);
  assert.equal(w.rows()[0].job_id, operation.terms.protocol.jobId);
});

test('generates the job id inside the create transaction', async (t) => {
  const w = world(t, { generateJobId: () => FIRST });
  const generator = w.options.generateJobId;
  const transactionOpen = () => {
    try { w.db.exec('BEGIN'); w.db.exec('ROLLBACK'); return false; } catch { return true; }
  };
  assert.equal(transactionOpen(), false, 'the probe sees no transaction outside the service');
  let insideTransaction = null;
  w.options.generateJobId = () => { insideTransaction = transactionOpen(); return generator(); };
  await w.prepare('TEST-key-1');
  assert.equal(insideTransaction, true);
});

test('one collision then success stores the second id', async (t) => {
  const w = world(t, { generateJobId: (n) => [FIRST, FIRST, SECOND][n] });
  await w.prepare('TEST-key-1');
  const { operation } = await w.prepare('TEST-key-2');
  assert.deepEqual(w.generated, [FIRST, FIRST, SECOND]);
  assert.equal(operation.terms.protocol.jobId, SECOND);
  assert.deepEqual(w.rows().map((row) => row.job_id), [FIRST, SECOND]);
});

test('three collisions fail closed and write nothing', async (t) => {
  const w = world(t, { generateJobId: () => FIRST });
  await w.prepare('TEST-key-1');
  const before = w.db.prepare('SELECT count(*) n FROM operation_events').get().n;
  await assert.rejects(w.prepare('TEST-key-2'), { code: 'job_id_unavailable' });
  assert.equal(w.generated.length, 1 + JOB_ID_ATTEMPTS);
  assert.equal(w.rows().length, 1);
  assert.equal(w.db.prepare('SELECT count(*) n FROM operation_events').get().n, before);
  assert.equal(w.ops.findByKey('TEST-buyer', 'purchase', 'TEST-key-2'), null);
});

test('an idempotency conflict is not retried as a job id collision', async (t) => {
  const w = world(t, { generateJobId: (n) => [FIRST, SECOND, THIRD][n] });
  await w.prepare('TEST-key-1');
  w.options.ops = { ...w.options.ops, createIdempotent: () => { throw new OperationError('idempotency_conflict', 'TEST-conflict'); } };
  await assert.rejects(w.prepare('TEST-key-2'), { code: 'idempotency_conflict' });
  assert.equal(w.generated.length, 2, 'one id for the first purchase, one for the conflicting attempt');
});

test('a generator that returns something other than a canonical job id fails closed', async (t) => {
  const w = world(t, { generateJobId: () => 'not-a-job-id' });
  await assert.rejects(w.prepare('TEST-key-1'), { code: 'invalid_job_id' });
  assert.equal(w.rows().length, 0);
});

test('construction refuses an operations table without job_id', (t) => {
  const w = world(t);
  w.db.exec('DROP INDEX IF EXISTS operations_job_id_unique; ALTER TABLE operations DROP COLUMN job_id');
  assert.throws(() => createPurchaseService(w.options), { code: 'schema_migration_required' });
});

test('construction refuses an operations table with job_id but no unique index on it', (t) => {
  const w = world(t);
  w.db.exec('DROP INDEX operations_job_id_unique');
  assert.throws(() => createPurchaseService(w.options), { code: 'schema_migration_required' });
});

test('construction refuses a job_id index that is not unique', (t) => {
  const w = world(t);
  w.db.exec('DROP INDEX operations_job_id_unique; CREATE INDEX operations_job_id_plain ON operations(job_id)');
  assert.throws(() => createPurchaseService(w.options), { code: 'schema_migration_required' });
});

test('construction refuses a unique index that spans more than job_id', (t) => {
  const w = world(t);
  w.db.exec('DROP INDEX operations_job_id_unique; CREATE UNIQUE INDEX operations_job_id_pair ON operations(job_id, account_id)');
  assert.throws(() => createPurchaseService(w.options), { code: 'schema_migration_required' });
});

test('construction refuses a unique index that covers only some rows', (t) => {
  const w = world(t);
  w.db.exec('DROP INDEX operations_job_id_unique; CREATE UNIQUE INDEX operations_job_id_partial ON operations(job_id) WHERE job_id IS NOT NULL');
  assert.throws(() => createPurchaseService(w.options), { code: 'schema_migration_required' });
});

test('construction accepts the shipped schema', (t) => {
  const w = world(t);
  assert.doesNotThrow(() => createPurchaseService(w.options));
});
