import { issueChallenge, attemptChallenge } from './helpers/challenge-api.mjs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
const { createSellerTransportStore } = await import('./helpers/bound-transport-store.mjs');
const buyer = 'did:demos:agent:' + 'a'.repeat(64), seller = 'did:demos:agent:' + 'b'.repeat(64);
const HOUR = 3600000;
const jid = label => '0' + createHash('sha256').update(String(label)).digest('hex').slice(0,25).toUpperCase();
const oldJobs = new Set(Array.from({length:10000},(_,i)=>jid('old-'+i)));
function world(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'd5-retention-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'transport.sqlite'), states = join(directory, 'sessions.json');
  writeFileSync(states, '{}');
  let time = 1800000000000, store;
  const config = { path, now: () => time, maxRecords: 1, contextStartLimits: { maxStartsPerHour: 1, maxStartsPerBuyerPerHour: 1 },
    contextSessionState: ({ jobId }) => JSON.parse(readFileSync(states, 'utf8'))[jobId] ?? null, ...options };
  // hostStart: what the host does with the lock held, right after it opens the store.
  const reopen = ({ hostStart = false, ...changes } = {}) => {
    store?.close(); store = createSellerTransportStore({ ...config, ...changes });
    if (hostStart) { store.challenges.closeLostValidations(); store.recoverLostContextReservations(); }
    return store;
  };
  reopen(); t.after(() => store.close());
  const issue = (jobId) => issueChallenge(store, { jobId, buyer }, { jobId, buyer });
  const count = table => { const db = new DatabaseSync(path, { readonly: true }); try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } finally { db.close(); } };
  const rows = () => { const db = new DatabaseSync(path, { readonly: true }); try { return db.prepare("SELECT *, jobId AS job, issuedAt AS issued_at, expiresAt AS expires_at, state <> 'issued' AS attempted FROM kit_challenges").all(); } finally { db.close(); } };
  return { path, issue, rows, reopen, count, now: () => time, get store() { return store; }, advance: ms => { time += ms; }, terminal: (job, state = 'vet-failed') => writeFileSync(states, JSON.stringify({ [job]: state })) };
}

test('T1 expired windows and restart never grow challenges beyond total capacity or erase a pending record', t => {
  const w = world(t); const first = w.issue(jid('job-0'));
  assert.deepEqual(w.issue(jid('job-0')), first, 'an outstanding challenge is read-only at capacity');
  for (let i = 1; i <= 3; i++) {
    w.advance(HOUR + 1); w.reopen();
    assert.throws(() => w.issue(jid('job-' + i)), { code: 'context_challenge_capacity' });
    assert.equal(w.rows().length, 1); assert.equal(w.rows()[0].nonce, first.sessionNonce);
  }
  assert.throws(() => attemptChallenge(w.store,{ jobId: jid('job-0'), buyer }, { scope: { jobId: jid('job-0'), buyer }, buyerIdentityBundle: { sessionNonce: first.sessionNonce } }), { code: 'context_challenge_expired' });
  assert.equal(w.rows()[0].attempted, 1, 'expired attempts stay durably consumed');
});

test('T2 full-capacity refusal executes zero SQL mutations, including rolled-back cleanup', t => {
  const w = world(t); w.issue(jid('job-0')); w.advance(HOUR + 1);
  const original = DatabaseSync.prototype.prepare, mutations = [];
  DatabaseSync.prototype.prepare = function(sql) { if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) mutations.push(sql); return original.call(this, sql); };
  try { assert.throws(() => w.issue(jid('job-1')), { code: 'context_challenge_capacity' }); }
  finally { DatabaseSync.prototype.prepare = original; }
  assert.deepEqual(mutations, []); assert.equal(w.rows().length, 1);
});

test('T3 terminal cleanup preserves rate accounting, survives restart and refuses old presentations', t => {
  const w = world(t); const first = w.issue(jid('job-0')); w.terminal(jid('job-0')); w.advance(60001); w.reopen();
  assert.throws(() => w.issue(jid('job-1')), { code: 'context_challenge_limit' });
  assert.equal(w.rows().length, 1, 'terminal rows still count for their full issuance window');
  w.advance(HOUR - 60001); w.reopen();
  const next = w.issue(jid('job-1')); assert.notEqual(next.sessionNonce, first.sessionNonce);
  assert.equal(w.rows().length, 1); assert.equal(w.rows()[0].job, jid('job-1'));
  assert.throws(() => attemptChallenge(w.store,{ jobId: jid('job-0'), buyer }, { scope: { jobId: jid('job-0'), buyer }, buyerIdentityBundle: { sessionNonce: first.sessionNonce } }), { code: 'context_challenge_mismatch' });
  assert.throws(() => w.issue(jid('job-0')), { code: 'context_session_terminal' });
  for (let i = 1; i < 4; i++) {
    w.terminal(jid('job-' + i)); w.advance(HOUR + 1); w.reopen(); w.issue(jid('job-' + (i + 1)));
    assert.equal(w.rows().length, 1);
  }
});

test('T4 only exact terminal seller states allow reclamation, regardless of nonce expiry or consumption', t => {
  for (const state of ['draft', 'vet-pending', 'vet-completed', 'settle-asymmetric', 'settle-completed', 'audit-pending', 'substrate-failure-paused', 'delivered', null]) {
    const w = world(t); const first = w.issue(jid('job-0'));
    attemptChallenge(w.store,{ jobId: jid('job-0'), buyer }, { scope: { jobId: jid('job-0'), buyer }, buyerIdentityBundle: { sessionNonce: first.sessionNonce } });
    w.terminal(jid('job-0'), state); w.advance(HOUR + 1);
    assert.throws(() => w.issue(jid('job-1')), { code: 'context_challenge_capacity' }, String(state));
    assert.equal(w.rows()[0].attempted, 1);
  }
  for (const state of ['finalised', 'vet-failed', 'negotiate-failed', 'commit-failed', 'settle-failed', 'aborted-by-self', 'aborted-by-other', 'failed-substrate']) {
    const w = world(t); w.issue(jid('job-0')); w.terminal(jid('job-0'), state); w.advance(HOUR + 1);
    w.issue(jid('job-1')); assert.equal(w.rows().length, 1); assert.equal(w.rows()[0].job, jid('job-1'));
  }
});

test('T5 missing or uncertain seller-state knowledge retains records and fails closed', t => {
  for (const contextSessionState of [() => null, () => Promise.resolve('vet-failed'), () => { throw new Error('seller state unavailable'); }]) {
    let ready = false;
    const w = world(t, { contextSessionState: input => ready ? contextSessionState(input) : null });
    w.issue(jid('job-0')); w.advance(HOUR + 1); ready = true;
    assert.throws(() => w.issue(jid('job-1'))); assert.equal(w.rows().length, 1);
  }
});

const other = 'did:demos:agent:' + 'c'.repeat(64);
// Terminal-observation metadata (a closure and the release of an existing allocation) is counted apart from the work's own writes.
const OBSERVATION_METADATA = /^\s*(INSERT OR IGNORE INTO kit_terminal_closures|UPDATE kit_allocations)/i;
function noMutations(work) {
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, mutations = [];
  const note = sql => { if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)/i.test(sql) && !OBSERVATION_METADATA.test(sql)) mutations.push(sql); };
  DatabaseSync.prototype.prepare = function(sql) { note(sql); return prepare.call(this, sql); };
  DatabaseSync.prototype.exec = function(sql) { note(sql); return exec.call(this, sql); };
  try { work(); } finally { DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec; }
  assert.deepEqual(mutations, []);
}
test('T21 malformed job IDs refuse before hashing, admission or challenge mutation', t => {
  const w = world(t);
  for (const jobId of ['job-0', '01arz3ndektsv4rrffq69g5faw', '01ARZ3NDEKTSV4RRFFQ69G5FAI', '01ARZ3NDEKTSV4RRFFQ69G5FA', '81ARZ3NDEKTSV4RRFFQ69G5FAW']) {
    noMutations(() => assert.throws(() => w.store.challenges.issue({ jobId, buyer }, createHash('sha256').update('TEST malformed-job scope').digest('hex')), { code: 'peer_job_invalid' }));
    assert.equal(w.count('kit_challenges'), 0);
  }
});

test('T23 five/five/two unused challenge issuances exhaust the twelve-per-hour global allowance', t => {
  const w = world(t,{maxRecords:20,contextStartLimits:{maxStartsPerHour:12,maxStartsPerBuyerPerHour:5}});
  for (const [actor,count] of [[buyer,5],[other,5],[seller,2]]) for(let i=0;i<count;i++) {
    const jobId=jid(actor+i);
    issueChallenge(w.store,{jobId,buyer:actor},{jobId,buyer:actor});
  }
  const jobId=jid('fourth-buyer');
  noMutations(()=>assert.throws(()=>issueChallenge(w.store,{jobId,buyer:'did:demos:agent:'+'d'.repeat(64)},{jobId}),{code:'context_challenge_limit'}));
  assert.equal(w.count('kit_challenges'),12);assert.equal(w.count('peer_effects'),0);
});

test('T14 challenge cleanup stops inspecting terminal sessions once capacity is available', t => {
  const inspected = [];
  // Seed using a real store with no terminal knowledge, then restart.
  const directory = mkdtempSync(join(tmpdir(), 'd5-scan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1800000000000; const path = join(directory, 'transport.sqlite');
  const contextStartLimits = { maxStartsPerHour: 10, maxStartsPerBuyerPerHour: 10 };
  let store = createSellerTransportStore({ path, maxRecords: 5, contextStartLimits, now: () => time });
  for (let i = 0; i < 5; i++) issueChallenge(store,{ jobId: jid('old-' + i), buyer }, {jobId:jid('old-'+i)});
  store.close(); time += HOUR + 1;
  store = createSellerTransportStore({ path, maxRecords: 5, contextStartLimits, now: () => time, contextSessionState: ({ jobId }) => { inspected.push(jobId); return jobId === jid('next') ? null : 'vet-failed'; } });
  try { issueChallenge(store,{ jobId: jid('next'), buyer }, {jobId:jid('next')}); }
  finally { store.close(); }
  assert.equal(inspected.filter(job => oldJobs.has(job)).length, 1);
});
