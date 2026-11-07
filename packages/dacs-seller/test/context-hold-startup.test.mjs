import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { sha256Hex } from '@kynesyslabs/dacs';
import { world, JOBS } from './helpers/d5-http-fixture.mjs';
import { createSellerTransportStore, sellerTransportEffect } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerContextAdmission, releaseSellerContextHolds, parsePolicyLedger, withContextHolds, heldPolicyBudget } from '../src/devnet-demo/operator-approval.mjs';
import { acquireSellerStateLock } from '../src/devnet-demo/seller-state-lock.mjs';

const CONTEXT = 'dacs-node2-seller-context-admission/v1';
async function fixture(t) {
  const w = await world(t), input = await w.wire();
  const request = w.auth.readRequest(input.header), body = JSON.parse(input.text);
  const evidencePath = join(dirname(w.path), 'approval.jsonl');
  const config = { evidencePath, sellerApproval: { mode: 'policy', maxWriteTotalOs: '4', maxWritesPerHour: 2, maxTotalOsPerHour: '8' }, now: w.now };
  const hold = { jobId: request.jobId, effect: sellerTransportEffect(request), writes: 2, hold: sellerTransportEffect(request) };
  const policy = createSellerContextAdmission(config);
  const rows = async () => parsePolicyLedger(await readFile(evidencePath, 'utf8')).rows;
  const restart = (extra = {}) => {
    const store = createSellerTransportStore({ path: w.path, now: w.now });
    t.after(() => store.close());
    return createSellerContextAdmission({ ...config, transportStore: store, ...extra });
  };
  return { ...w, request, body, config, policy, hold, rows, restart };
}
const nextHold = f => ({ ...f.hold, jobId: JOBS[1], effect: 'b'.repeat(64), hold: 'TEST next context' });
function journal(path) {
  const db = new Database(path, { readonly: true });
  try {
    return ['peer_effects', 'peer_context_admissions', 'peer_nonces', 'peer_context_challenges'].map(table => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table);
      return exists ? db.prepare(`SELECT * FROM ${table}`).all() : [];
    });
  } finally { db.close(); }
}

for (const startup of [false, true]) test(`ready admission preserves reserve-before-release queue order, startup=${startup}`, async t => {
  const f = await fixture(t), policy = startup ? f.restart() : f.policy;
  await policy.ready;
  const reserved = policy.reserve(f.hold);
  const released = releaseSellerContextHolds({ evidencePath: f.config.evidencePath, jobId: f.hold.jobId, now: f.now });
  assert.equal(await reserved, null);
  assert.deepEqual(await released, [f.hold.hold]);
  assert.equal((await f.rows())[0].released, true);
});

test('startup restores capacity after a hold commits before its transport reservation', async t => {
  const f = await fixture(t);
  f.store.attemptContextPresentation(f.request, f.body);
  assert.equal(await f.policy.reserve(f.hold), null);
  assert.equal(f.store.contextAdmission(f.hold.jobId), null);
  assert.equal(await f.policy.reserve(nextHold(f)), 'hourly-write-limit');
  const before = journal(f.path), restarted = f.restart();
  const admitted = restarted.reserve(nextHold(f));
  await restarted.ready;
  assert.equal(await admitted, null, 'orphan capacity must be reusable after startup');
  assert.equal((await f.rows())[0].released, true);
  assert.deepEqual(journal(f.path), before, 'consumed challenges and transport answers remain untouched');
});

for (const resumed of [false, true]) for (const outcome of ['complete', 'no-effect']) {
  test(`startup releases ${resumed ? 'resumed' : 'original'} hold after ${outcome} without a request retry`, async t => {
    const f = await fixture(t), reservation = f.store.reserve(f.request, f.body, { admit: f.now });
    if (resumed) f.hold.hold += ':' + reservation.owner;
    await f.policy.reserve(f.hold);
    f.store.finish(reservation, 200, '{"disposition":"rejected"}', { noEffect: outcome === 'no-effect' });
    const before = journal(f.path), restarted = f.restart();
    assert.deepEqual(await restarted.ready, [f.hold.hold]);
    assert.equal((await f.rows())[0].released, true);
    const bytes = await readFile(f.config.evidencePath, 'utf8');
    assert.deepEqual(await f.restart().ready, []);
    assert.equal(await readFile(f.config.evidencePath, 'utf8'), bytes);
    assert.deepEqual(journal(f.path), before);
  });
}

for (const state of ['pending', 'uncertain', 'retry']) test(`startup retains capacity for a ${state} effect`, async t => {
  const f = await fixture(t), reservation = f.store.reserve(f.request, f.body, { admit: f.now });
  await f.policy.reserve(f.hold);
  if (state !== 'pending') f.store.finish(reservation, 503, '{}', { retry: state === 'retry' });
  const before = journal(f.path), restarted = f.restart();
  assert.deepEqual(await restarted.ready, []);
  assert.equal((await f.rows())[0].released, false);
  assert.equal(await restarted.reserve(nextHold(f)), 'hourly-write-limit');
  assert.deepEqual(journal(f.path), before);
});

test('startup releases orphan holds across jobs and exact arbitrary hold identities', async t => {
  const f = await fixture(t);
  f.config.sellerApproval.maxWritesPerHour = 10;
  f.config.sellerApproval.maxTotalOsPerHour = '40';
  const policy = createSellerContextAdmission(f.config), other = nextHold(f);
  await policy.reserve(f.hold); await policy.reserve(other);
  assert.deepEqual(await f.restart().ready, [f.hold.hold, other.hold]);
  assert((await f.rows()).every(row => row.released));
});

test('startup releases an older orphan while retaining a later pending effect for the same job', async t => {
  const f = await fixture(t);
  const orphan = { ...f.hold, effect: 'c'.repeat(64), hold: 'TEST earlier orphan', writes: 1 };
  await f.policy.reserve(orphan);
  f.store.reserve(f.request, f.body, { admit: f.now });
  await f.policy.reserve({ ...f.hold, writes: 1 });
  assert.deepEqual(await f.restart().ready, [orphan.hold]);
  assert.deepEqual((await f.rows()).map(row => row.released), [true, false]);
});

test('startup releases unused slots while retaining converted signed-write accounting and bytes', async t => {
  const f = await fixture(t);
  await f.policy.reserve(f.hold);
  const requestBytes = JSON.stringify({ content: { jobId: f.hold.jobId, artifactKind: 'CompositeVerificationRecord', debit: { totalOs: '4' } } });
  const signed = JSON.stringify({ format: 'dacs-node2-seller-policy-sign-authorization/v1', reservationId: '00000000-0000-4000-8000-000000000009',
    requestBytes, approvalHash: sha256Hex(requestBytes), totalOs: '4', recordedAt: f.now() });
  await appendFile(f.config.evidencePath, signed + '\n');
  const restarted = f.restart(); await restarted.ready;
  const budget = heldPolicyBudget(withContextHolds(await f.rows()), f.now());
  assert.equal(budget.writes, 1);
  assert.equal(await restarted.reserve(nextHold(f)), 'hourly-write-limit');
  assert.equal(await restarted.reserve({ ...nextHold(f), writes: 1 }), null);
  assert((await readFile(f.config.evidencePath, 'utf8')).includes(signed + '\n'));
});

test('startup repairs a torn release and retries the exact hold once', async t => {
  const f = await fixture(t); await f.policy.reserve(f.hold);
  await appendFile(f.config.evidencePath, `{"format":"${CONTEXT}","event":"release","holdId":`);
  assert.deepEqual(await f.restart().ready, [f.hold.hold]);
  assert.deepEqual(await f.restart().ready, []);
  assert.equal((await f.rows())[0].released, true);
});

for (const damage of ['missing-effect', 'missing-admission', 'dangling-mapping', 'wrong-job', 'wrong-effect', 'unknown-state', 'invalid-completion']) {
  test(`startup refuses ${damage} journal joins before releasing any holds`, async t => {
    const f = await fixture(t), reservation = f.store.reserve(f.request, f.body, { admit: f.now });
    await f.policy.reserve(f.hold);
    const db = new Database(f.path);
    try {
      if (damage === 'missing-effect') db.prepare('DELETE FROM peer_effects WHERE effect = ?').run(reservation.effectKey);
      if (damage === 'missing-admission') db.prepare('DELETE FROM peer_context_admissions').run();
      if (damage === 'dangling-mapping') { db.prepare('DELETE FROM peer_effects').run(); db.prepare('DELETE FROM peer_context_admissions').run(); }
      if (damage === 'wrong-job') db.prepare('UPDATE peer_context_admissions SET job = ?').run(JOBS[1]);
      if (damage === 'wrong-effect') db.prepare('UPDATE peer_context_admissions SET effect = ?').run('c'.repeat(64));
      if (damage === 'unknown-state') db.prepare("UPDATE peer_effects SET state = 'TEST unknown'").run();
      if (damage === 'invalid-completion') db.prepare("UPDATE peer_effects SET state = 'complete', status = 503, response = '{}'").run();
    } finally { db.close(); }
    const before = await readFile(f.config.evidencePath, 'utf8'), restarted = f.restart();
    await assert.rejects(restarted.ready, { code: 'peer_context_reconciliation_conflict' });
    await assert.rejects(restarted.reserve(nextHold(f)), { code: 'peer_context_reconciliation_conflict' });
    await assert.rejects(restarted.release({ jobId: f.hold.jobId }), { code: 'peer_context_reconciliation_conflict' });
    assert.equal(await readFile(f.config.evidencePath, 'utf8'), before);
  });
}

test('startup preflights every hold and preserves the journal read error', async t => {
  const f = await fixture(t); await f.policy.reserve({ ...f.hold, writes: 1 });
  await f.policy.reserve({ ...nextHold(f), writes: 1 });
  const cause = new Error('TEST journal read failed'); let reads = 0;
  const restarted = f.restart({ transportStore: { contextHoldState() { if (++reads === 2) throw cause; return 'absent'; } } });
  await assert.rejects(restarted.ready, error => error === cause);
  assert.equal(reads, 2); assert((await f.rows()).every(row => !row.released));
});

test('startup rejects an unknown classification rather than assuming absence', async t => {
  const f = await fixture(t); await f.policy.reserve(f.hold);
  await assert.rejects(f.restart({ transportStore: { contextHoldState: () => undefined } }).ready, /context.*state/i);
  assert.equal((await f.rows())[0].released, false);
});

test('startup refuses a malformed ledger without changing its bytes', async t => {
  const f = await fixture(t); await f.policy.reserve(f.hold);
  await appendFile(f.config.evidencePath, 'TEST invalid ledger\n');
  const before = await readFile(f.config.evidencePath, 'utf8');
  await assert.rejects(f.restart().ready, SyntaxError);
  assert.equal(await readFile(f.config.evidencePath, 'utf8'), before);
});

for (const time of [NaN, -1, 1]) test(`startup refuses invalid release clock ${time}`, async t => {
  const f = await fixture(t); await f.policy.reserve(f.hold);
  await assert.rejects(f.restart({ now: () => time }).ready, RangeError);
  assert.equal((await f.rows())[0].released, false);
});

test('startup checks every release timestamp before appending the first release', async t => {
  const f = await fixture(t); await f.policy.reserve({ ...f.hold, writes: 1 });
  const later = createSellerContextAdmission({ ...f.config, now: () => f.now() + 1 });
  await later.reserve({ ...nextHold(f), writes: 1 });
  await assert.rejects(f.restart().ready, RangeError);
  assert((await f.rows()).every(row => !row.released));
});

test('startup requires the transport classification capability', async t => {
  const f = await fixture(t);
  assert.throws(() => f.restart({ transportStore: {} }), TypeError);
});

test('transport classification refuses invalid hold job and effect identifiers', async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.contextHoldState({ jobId: 'TEST invalid job', effect: f.hold.effect }), { code: 'peer_job_invalid' });
  assert.throws(() => f.store.contextHoldState({ jobId: f.hold.jobId, effect: 'TEST invalid effect' }), { code: 'peer_context_reconciliation_conflict' });
});

test('reopening an older transport store adds an indexed effect lookup for startup joins', async t => {
  const f = await fixture(t); f.store.reserve(f.request, f.body, { admit: f.now });
  const db = new Database(f.path);
  try { db.exec('DROP INDEX peer_context_admissions_effect'); }
  finally { db.close(); }
  await f.restart().ready;
  const reopened = new Database(f.path, { readonly: true });
  try {
    const plan = reopened.prepare('EXPLAIN QUERY PLAN SELECT job FROM peer_context_admissions WHERE effect = ? AND job <> ? LIMIT 1').all(f.hold.effect, f.hold.jobId);
    assert(plan.some(row => row.detail.includes('USING INDEX peer_context_admissions_effect')));
  } finally { reopened.close(); }
});

test('startup rejects under another policy writer lock', async t => {
  const f = await fixture(t); await f.policy.reserve(f.hold);
  const directory = f.config.evidencePath + '.policy-lock'; await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await acquireSellerStateLock(directory);
  try { await assert.rejects(f.restart().ready, { code: 'seller_state_locked' }); }
  finally { lock.release(); }
  assert.equal((await f.rows())[0].released, false);
});

test('startup sync failure rejects admission and repeat startup syncs retained releases', async t => {
  const f = await fixture(t); await f.policy.reserve(f.hold);
  const original = fs.fsyncSync, inode = fs.statSync(f.config.evidencePath).ino, cause = new Error('TEST ledger sync failed');
  try {
    fs.fsyncSync = fd => { if (fs.fstatSync(fd).ino === inode) throw cause; return original(fd); }; syncBuiltinESMExports();
    const restarted = f.restart();
    await assert.rejects(restarted.ready, error => error === cause);
    await assert.rejects(restarted.reserve(nextHold(f)), error => error === cause);
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  let synced = 0;
  try {
    fs.fsyncSync = fd => { if (fs.fstatSync(fd).ino === inode) synced++; return original(fd); }; syncBuiltinESMExports();
    assert.deepEqual(await f.restart().ready, []);
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert(synced > 0); assert.equal((await f.rows())[0].released, true);
});

test('manual mode startup cleans holds from a prior policy run and opens no new hold', async t => {
  const f = await fixture(t); await f.policy.reserve(f.hold);
  const restarted = f.restart({ sellerApproval: { mode: 'manual' } });
  assert.deepEqual(await restarted.ready, [f.hold.hold]);
  assert.equal(await restarted.reserve(nextHold(f)), null);
  assert.equal((await f.rows()).length, 1);
});

test('startup with no ledger or context admissions leaves both stores unchanged', async t => {
  const f = await fixture(t), before = journal(f.path);
  assert.deepEqual(await f.restart().ready, []);
  assert.deepEqual(journal(f.path), before);
  await assert.rejects(readFile(f.config.evidencePath), { code: 'ENOENT' });
});

test('a fresh process reconciles persisted holds before admitting more work', async t => {
  const f = await fixture(t); await f.policy.reserve(f.hold);
  const configPath = join(dirname(f.path), 'startup.json');
  await writeFile(configPath, JSON.stringify({ ...f.config, now: f.now(), path: f.path, next: nextHold(f) }));
  const worker = spawnSync(process.execPath, [new URL('./helpers/context-hold-startup-worker.mjs', import.meta.url).pathname, configPath], { encoding: 'utf8', timeout: 30000 });
  assert.equal(worker.status, 0, worker.stderr);
  assert.deepEqual(JSON.parse(worker.stdout), { released: [f.hold.hold], admitted: null });
});
