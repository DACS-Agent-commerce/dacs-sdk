import './helpers/d5-isolated-dependencies.mjs';
import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const { createSellerTransportStore, sellerContextScopeHash, sellerContextChallengeScope, sellerTransportEffect, SELLER_CONTEXT_PATH } = await import('../src/dacs/seller-transport-auth.mjs');
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
  const config = { path, now: () => time, maxRecords: 1,
    contextSessionState: ({ jobId }) => JSON.parse(readFileSync(states, 'utf8'))[jobId], ...options };
  const reopen = () => { store?.close(); store = createSellerTransportStore(config); return store; };
  reopen(); t.after(() => store.close());
  const issue = (jobId) => store.issueContextChallenge({ jobId, buyer }, { jobId, buyer }, { maxPerBuyer: 1, maxGlobal: 1, admit: () => time });
  const count = table => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } finally { db.close(); } };
  const rows = () => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT * FROM peer_context_challenges').all(); } finally { db.close(); } };
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
  assert.throws(() => w.store.attemptContextPresentation({ jobId: jid('job-0'), buyer }, { scope: { jobId: jid('job-0'), buyer }, buyerIdentityBundle: { sessionNonce: first.sessionNonce } }), { code: 'context_challenge_expired' });
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
  assert.throws(() => w.store.attemptContextPresentation({ jobId: jid('job-0'), buyer }, { scope: { jobId: jid('job-0'), buyer }, buyerIdentityBundle: { sessionNonce: first.sessionNonce } }), { code: 'context_challenge_mismatch' });
  assert.throws(() => w.issue(jid('job-0')), { code: 'context_session_terminal' });
  for (let i = 1; i < 4; i++) {
    w.terminal(jid('job-' + i)); w.advance(HOUR + 1); w.reopen(); w.issue(jid('job-' + (i + 1)));
    assert.equal(w.rows().length, 1);
  }
});

test('T4 only exact terminal seller states allow reclamation, regardless of nonce expiry or consumption', t => {
  for (const state of ['draft', 'vet-pending', 'vet-completed', 'settle-asymmetric', 'settle-completed', 'audit-pending', 'substrate-failure-paused', 'delivered', null]) {
    const w = world(t); const first = w.issue(jid('job-0'));
    w.store.attemptContextPresentation({ jobId: jid('job-0'), buyer }, { scope: { jobId: jid('job-0'), buyer }, buyerIdentityBundle: { sessionNonce: first.sessionNonce } });
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

test('T6 terminal cleanup runs only after unpaid-start admission succeeds', t => {
  const w = world(t); w.issue(jid('job-0')); w.terminal(jid('job-0')); w.advance(HOUR + 1);
  assert.throws(() => w.store.issueContextChallenge({ jobId: jid('job-1'), buyer }, { jobId: jid('job-1'), buyer }, { admit: () => { throw new Error('unpaid start refused'); } }), /unpaid start refused/);
  assert.equal(w.rows()[0].job, jid('job-0'));
});

const other = 'did:demos:agent:' + 'c'.repeat(64);
const request = (w, i, overrides = {}) => ({ path: '/dacs/v1/agreements/proposals', method: 'POST', bodyHash: 'c'.repeat(64), jobId: jid('job-' + i), buyer, seller,
  listingPin: { listingId: 'test', version: 1, contentHash: 'd'.repeat(64) }, agreementHash: 'e'.repeat(64), nonce: 'nonce-' + i, expiresAt: w.now() + 60000, ...overrides });

test('T7 no-effect proposals release job capacity for another buyer across windows and restart', t => {
  const w = world(t, { maxRecords: 5 });
  for (let i = 0; i < 5; i++) {
    const reservation = w.store.reserve(request(w, i), {});
    assert.equal(w.count('peer_jobs'), 1);
    w.store.finish(reservation, 409, '{}', { noEffect: true }); w.advance(61000);
    assert.equal(w.count('peer_jobs'), 0);
  }
  w.advance(7 * 86400000); w.reopen();
  assert.equal(w.store.classify(request(w, 5, { buyer: other }), {}), 'start');
  assert.equal(w.store.reserve(request(w, 5, { buyer: other }), {}).disposition, 'perform');
});

test('T8 live, uncertain and completed effects retain their job binding and cap across restart', t => {
  for (const status of [null, 503, 200]) {
    const w = world(t, { maxRecords: 2 });
    const first = request(w, 0), live = w.store.reserve(first, {});
    if (status) w.store.finish(live, status, '{}');
    const read = w.store.reserve(request(w, 0, { path: '/dacs/v1/agreements/state', nonce: 'read' }), {});
    w.store.finish(read, 200, '{}');
    assert.equal(w.count('peer_jobs'), 1);
    w.advance(HOUR + 1);
    w.store.finish(w.store.reserve(request(w, 1), {}), 200, '{}'); w.advance(HOUR + 1); w.reopen();
    assert.throws(() => w.store.reserve(request(w, 2), {}), { code: 'peer_job_capacity' });
    assert.throws(() => w.store.classify(request(w, 2), {}), { code: 'peer_job_capacity' });
    assert.equal(w.count('peer_jobs'), 2);
    assert.notEqual(w.store.reserve({ ...first, nonce: 'retry', expiresAt: w.now() + 60000 }, {}).disposition, 'perform');
  }
});

test('T9 no-effect completion retains a job used by another pending read, then releases the empty job', t => {
  const w = world(t, { maxRecords: 3 });
  const proposal = w.store.reserve(request(w, 0), {});
  const read = w.store.reserve(request(w, 0, { path: '/dacs/v1/agreements/state', nonce: 'read' }), {});
  w.store.finish(proposal, 409, '{}', { noEffect: true });
  assert.equal(w.count('peer_jobs'), 1);
  w.store.finish(read, 200, '{}'); assert.equal(w.count('peer_jobs'), 0);
});

function noMutations(work) {
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, mutations = [];
  DatabaseSync.prototype.prepare = function(sql) { if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)/i.test(sql)) mutations.push(sql); return prepare.call(this, sql); };
  DatabaseSync.prototype.exec = function(sql) { if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)/i.test(sql)) mutations.push(sql); return exec.call(this, sql); };
  try { work(); } finally { DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec; }
  assert.deepEqual(mutations, []);
}
const context = (w, i, overrides) => request(w, i, { path: SELLER_CONTEXT_PATH, ...overrides });

test('T21 malformed job IDs refuse before hashing, admission or challenge mutation', t => {
  const w = world(t);
  for (const jobId of ['job-0', '01arz3ndektsv4rrffq69g5faw', '01ARZ3NDEKTSV4RRFFQ69G5FAI', '01ARZ3NDEKTSV4RRFFQ69G5FA', '81ARZ3NDEKTSV4RRFFQ69G5FAW']) {
    noMutations(() => assert.throws(() => w.store.issueContextChallenge({ jobId, buyer }, { jobId, buyer }, {
      admit: () => assert.fail('malformed job reached admission'),
    }), { code: 'peer_job_invalid' }));
    assert.equal(w.count('peer_context_challenges'), 0);
  }
});

test('T22 every direct journal and hashing entry refuses malformed IDs without consuming a real challenge', t => {
  const w = world(t), valid = jid('valid'), issued = w.issue(valid), before = w.rows();
  for (const jobId of [undefined,null,{},7,'job-0',valid.toLowerCase(),valid.slice(1),'8'+valid.slice(1)]) {
    const p = request(w, 0, {jobId}), body = {scope:{jobId,buyer},buyerIdentityBundle:{sessionNonce:issued.sessionNonce}};
    noMutations(() => {
      for (const work of [
        () => w.store.reserve(p,{}), () => w.store.classify(p,{}),
        () => w.store.contextAdmission(jobId), () => w.store.contextAnswer(jobId),
        () => w.store.attemptContextPresentation(p,body),
        () => w.store.attemptContextPresentation({...p,jobId:valid},body),
        () => w.store.issueContextChallenge({...p,jobId:valid},body.scope),
        () => w.store.reconcile({},p,200,'{}'), () => w.store.resume({},p),
        () => sellerContextScopeHash(body.scope), () => sellerContextChallengeScope(body.scope), () => sellerTransportEffect(p),
      ]) assert.throws(work,{code:'peer_job_invalid'});
      const scope={jobId,get poison(){assert.fail('malformed scope was canonicalized')}};
      assert.throws(()=>sellerContextScopeHash(scope),{code:'peer_job_invalid'});
    });
    assert.deepEqual(w.rows(),before);
  }
});

function withoutStoreAccess(work) {
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec, queries = [];
  DatabaseSync.prototype.prepare = function(sql) { queries.push(sql); return prepare.call(this, sql); };
  DatabaseSync.prototype.exec = function(sql) { queries.push(sql); return exec.call(this, sql); };
  try { work(); } finally { DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec; }
  assert.deepEqual(queries, [], 'invalid context bodies must refuse before opening a transaction or reading the journal');
}

const contextBody = i => ({ scope: { jobId: jid('job-' + i) } });
const invalidContextBodies = () => [
  ...[undefined, null, {}, 7, 'job-0', jid('job-0').toLowerCase(), jid('job-0').slice(1), '8' + jid('job-0').slice(1)]
    .map(jobId => ({ body: { scope: { jobId } }, code: 'peer_job_invalid' })),
  ...[undefined, null, {}, { scope: null }, { scope: [] }]
    .map(body => ({ body, code: 'peer_job_invalid' })),
  { body: contextBody(1), code: 'peer_job_mismatch' },
];

test('T24 direct context reservation and classification refuse invalid body jobs before journal access', t => {
  const w = world(t), issued = w.issue(jid('job-0')), before = w.rows();
  const p = context(w, 0);
  for (const method of ['reserve', 'classify']) for (const { body, code } of invalidContextBodies()) {
    withoutStoreAccess(() => assert.throws(() => w.store[method](p, body, {
      admit: () => assert.fail('invalid body reached admission'),
    }), { code }));
    assert.deepEqual(w.rows(), before, 'a body refusal cannot consume its issued challenge');
    assert.equal(w.count('peer_effects'), 0);
    assert.equal(w.store.contextAdmission(p.jobId), null);
  }
  // Job checks also precede request hashing and all other field access.
  const poison = { jobId: p.jobId, path: SELLER_CONTEXT_PATH, get buyer() { assert.fail('invalid body reached hashing'); } };
  assert.throws(() => w.store.reserve(poison, { scope: { jobId: 'job-0' } }), { code: 'peer_job_invalid' });
  assert.equal(w.store.classify(p, contextBody(0)), 'start');
  assert.equal(w.store.reserve(p, contextBody(0), { admit: () => w.now() }).disposition, 'perform');
  assert.equal(w.store.contextAdmission(p.jobId).jobId, p.jobId);
  assert.equal(w.rows()[0].nonce, issued.sessionNonce);
});

test('T25 body job checks precede retained context replies and survive restart', t => {
  const w = world(t), p = context(w, 0), body = contextBody(0);
  const reservation = w.store.reserve(p, body, { admit: () => w.now() });
  for (const state of ['pending', 'complete', 'restarted']) {
    if (state === 'complete') w.store.finish(reservation, 200, '{}');
    if (state === 'restarted') w.reopen();
    for (const method of ['reserve', 'classify']) for (const { body: invalid, code } of invalidContextBodies()) {
      withoutStoreAccess(() => assert.throws(() => w.store[method](p, invalid), { code }));
      withoutStoreAccess(() => assert.throws(() => w.store[method]({ ...p, nonce: 'fresh-' + state }, invalid), { code }));
    }
    assert.equal(w.store.classify(p, body), 'known');
    assert.equal(w.store.reserve(p, body).disposition, state === 'pending' ? 'uncertain' : 'cached');
    assert.equal(w.count('peer_effects'), 1);
    assert.equal(w.store.contextAdmission(p.jobId).jobId, p.jobId);
  }
});

test('T23 five/five/two unused challenge issuances exhaust the twelve-per-hour global allowance', t => {
  const w = world(t,{maxRecords:20});
  for (const [actor,count] of [[buyer,5],[other,5],[seller,2]]) for(let i=0;i<count;i++) {
    const jobId=jid(actor+i);
    w.store.issueContextChallenge({jobId,buyer:actor},{jobId,buyer:actor},{admit:()=>w.now()});
  }
  const jobId=jid('fourth-buyer');
  noMutations(()=>assert.throws(()=>w.store.issueContextChallenge({jobId,buyer:'did:demos:agent:'+'d'.repeat(64)},{jobId},{admit:()=>assert.fail('admitted')}),{code:'context_challenge_limit'}));
  assert.equal(w.count('peer_context_challenges'),12);assert.equal(w.count('peer_effects'),0);
});

test('T10 total context capacity bounds admissions, effects and slots across hours and restart before any mutation', t => {
  const w = world(t, { maxRecords: 5, maxContextRecords: 1 });
  const first = context(w, 0);
  w.store.finish(w.store.reserve(first, contextBody(0), { admit: () => w.now() }), 200, '{}');
  for (let i = 1; i <= 4; i++) {
    w.advance(HOUR + 1); w.reopen();
    noMutations(() => {
      const options = { admit: () => { assert.fail('capacity must precede admission'); } };
      assert.throws(() => w.store.classify(context(w, i), contextBody(i), options), { code: 'peer_context_capacity' });
      assert.throws(() => w.store.reserve(context(w, i), contextBody(i), options), { code: 'peer_context_capacity' });
      assert.throws(() => w.issue(jid('job-' + i)), { code: 'peer_context_capacity' });
    });
    for (const table of ['peer_context_admissions', 'peer_effects', 'peer_effect_jobs', 'peer_slots']) assert.equal(w.count(table), 1, table);
    assert.equal(w.count('peer_jobs'), 0);
    assert.equal(w.store.reserve({ ...first, nonce: 'retry-' + i, expiresAt: w.now() + 60000 }, contextBody(0)).disposition, 'cached');
  }
});

test('T11 terminal context cleanup preserves the full hour and expired-request fence, with restart and replay refusal', t => {
  const w = world(t, { maxContextRecords: 1 });
  const old = context(w, 0);
  w.store.finish(w.store.reserve(old, contextBody(0), { admit: () => w.now() }), 409, '{}');
  w.terminal(jid('job-0')); w.advance(HOUR - 1); w.reopen();
  noMutations(() => assert.throws(() => w.store.reserve(context(w, 1), contextBody(1), { admit: () => w.now() }), { code: 'peer_context_capacity' }));
  w.advance(1); w.reopen();
  assert.equal(w.store.classify(context(w, 1), contextBody(1), { admit: () => w.now() }), 'start');
  assert.equal(w.store.contextAdmission(jid('job-0')).jobId, jid('job-0'), 'dry cleanup is read-only');
  const next = w.store.reserve(context(w, 1), contextBody(1), { admit: () => w.now() });
  assert.equal(next.disposition, 'perform'); assert.equal(w.store.contextAdmission(jid('job-0')), null);
  assert.equal(w.store.contextAnswer(jid('job-0')), null);
  for (const table of ['peer_context_admissions', 'peer_effects', 'peer_effect_jobs', 'peer_slots', 'peer_nonces', 'peer_nonce_retention']) assert.equal(w.count(table), 1, table);
  w.reopen();
  noMutations(() => assert.throws(() => w.store.reserve({ ...old, nonce: 'old-retry', expiresAt: w.now() + 60000 }, contextBody(0), { admit: () => w.now() }), { code: 'context_session_terminal' }));
});

test('T12 terminal evidence never releases pending or uncertain context effects', t => {
  for (const status of [null, 503]) {
    const w = world(t, { maxRecords: 5, maxContextRecords: 1 });
    const original = context(w, 0), reservation = w.store.reserve(original, contextBody(0), { admit: () => w.now() });
    if (status) w.store.finish(reservation, status, '{}');
    w.terminal(jid('job-0')); w.advance(HOUR + 1); w.reopen();
    noMutations(() => assert.throws(() => w.store.reserve(context(w, 1), contextBody(1), { admit: () => w.now() }), { code: 'peer_context_capacity' }));
    assert.equal(w.store.reserve({ ...original, nonce: 'retry', expiresAt: w.now() + 60000 }, contextBody(0)).disposition, 'uncertain');
    assert.equal(w.count('peer_effects'), 1);
  }
});

test('T13 terminal cleanup waits for live requests and successful unpaid-start admission', t => {
  const w = world(t, { maxRecords: 5, maxContextRecords: 1 });
  const first = context(w, 0, { expiresAt: w.now() + 2 * HOUR });
  w.store.finish(w.store.reserve(first, contextBody(0), { admit: () => w.now() }), 200, '{}');
  w.terminal(jid('job-0')); w.advance(HOUR + 1);
  noMutations(() => assert.throws(() => w.store.reserve(context(w, 1), contextBody(1), { admit: () => w.now() }), { code: 'peer_context_capacity' }));
  w.advance(HOUR);
  noMutations(() => assert.throws(() => w.store.reserve(context(w, 1), contextBody(1), { admit: () => { throw new Error('unpaid start refused'); } }), /unpaid start refused/));
  assert.equal(w.count('peer_context_admissions'), 1); assert.equal(w.count('peer_effects'), 1);
});

test('T14 challenge cleanup stops inspecting terminal sessions once capacity is available', t => {
  const inspected = [];
  // Seed using a real store with no terminal knowledge, then restart.
  const directory = mkdtempSync(join(tmpdir(), 'd5-scan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1800000000000; const path = join(directory, 'transport.sqlite');
  let store = createSellerTransportStore({ path, maxRecords: 5, now: () => time });
  for (let i = 0; i < 5; i++) store.issueContextChallenge({ jobId: jid('old-' + i), buyer }, {jobId:jid('old-'+i)}, { maxGlobal: 10, maxPerBuyer: 10, admit: () => time });
  store.close(); time += HOUR + 1;
  store = createSellerTransportStore({ path, maxRecords: 5, now: () => time, contextSessionState: ({ jobId }) => { inspected.push(jobId); return jobId === jid('next') ? null : 'vet-failed'; } });
  try { store.issueContextChallenge({ jobId: jid('next'), buyer }, {jobId:jid('next')}, { admit: () => time }); }
  finally { store.close(); }
  assert.equal(inspected.filter(job => oldJobs.has(job)).length, 1);
});

test('T15 earlier empty job bindings are reclaimed only on successful admission, after restart', t => {
  const w = world(t, { maxRecords: 1 });
  const first = request(w, 0);
  w.store.finish(w.store.reserve(first, {}), 409, '{"error":"refused"}', { noEffect: true });
  // Reproduce a pre-upgrade leftover binding; do not supply a missing module.
  const { path, method, bodyHash, nonce, expiresAt, ...identity } = first;
  const db = new DatabaseSync(w.path);
  try { db.prepare('INSERT INTO peer_jobs VALUES (?, ?)').run(first.jobId, JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a], [b]) => a.localeCompare(b))))); }
  finally { db.close(); }
  w.advance(HOUR + 1); w.reopen();
  noMutations(() => assert.equal(w.store.classify(request(w, 1, { buyer: other }), {}), 'start'));
  assert.equal(w.count('peer_jobs'), 1);
  const next = w.store.reserve(request(w, 1, { buyer: other }), {});
  assert.equal(next.disposition, 'perform'); assert.equal(w.count('peer_jobs'), 1);
  const check = new DatabaseSync(w.path, { readOnly: true });
  try { assert.equal(check.prepare('SELECT job FROM peer_jobs').get().job, jid('job-1')); } finally { check.close(); }
});

test('T16 no-effect job reclamation keeps the original nonce response while another effect may start', t => {
  const w = world(t, { maxRecords: 5 });
  const first = request(w, 0), refused = '{"error":"refused"}';
  w.store.finish(w.store.reserve(first, {}), 409, refused, { noEffect: true });
  assert.deepEqual(w.store.reserve(first, {}), { disposition: 'cached', status: 409, text: refused });
  w.reopen();
  assert.equal(w.store.reserve({ ...first, nonce: 'next' }, {}).disposition, 'perform');
  assert.deepEqual(w.store.reserve(first, {}), { disposition: 'cached', status: 409, text: refused });
});

function observeQueries(work) {
  const prepare = DatabaseSync.prototype.prepare, queries = [];
  DatabaseSync.prototype.prepare = function(sql) { queries.push(sql); return prepare.call(this, sql); };
  try { noMutations(work); } finally { DatabaseSync.prototype.prepare = prepare; }
  return queries;
}

function seedCapacity(w, n, contexts = false) {
  const db = new DatabaseSync(w.path);
  try {
    if (contexts) db.exec(`CREATE TABLE peer_context_admissions (job TEXT PRIMARY KEY, buyer TEXT NOT NULL, seller TEXT NOT NULL,
      listing_pin TEXT NOT NULL, scope_hash TEXT NOT NULL, effect TEXT NOT NULL, admitted_at INTEGER NOT NULL)`);
    db.exec('BEGIN');
    const jobs = db.prepare('INSERT INTO peer_jobs VALUES (?, ?)'), effects = db.prepare('INSERT INTO peer_effects VALUES (?, ?, ?, ?, ?)');
    const mappings = db.prepare('INSERT INTO peer_effect_jobs VALUES (?, ?)');
    const admissions = contexts && db.prepare('INSERT INTO peer_context_admissions VALUES (?, ?, ?, ?, ?, ?, ?)');
    const nonces = db.prepare('INSERT INTO peer_nonces VALUES (?, ?, ?, ?, ?)'), retention = db.prepare('INSERT INTO peer_nonce_retention VALUES (?, ?, ?, ?)');
    for (let i = 0; i < n; i++) {
      const job = jid('old-' + i), effect = 'effect-' + i, nonce = 'nonce-' + i;
      effects.run(effect, 'owner', 'complete', 200, '{}'); mappings.run(effect, job);
      if (contexts) {
        admissions.run(job, buyer, seller, '{}', 'scope', effect, w.now() - HOUR - 1);
        nonces.run(nonce, 'hash', effect, 200, '{}'); retention.run(nonce, buyer, w.now() - HOUR - 1, w.now() - HOUR + 60000);
      } else jobs.run(job, '{}');
    }
    db.exec('COMMIT');
    // Exercise opening an existing schema whose lookup indexes are absent.
    db.exec('DROP INDEX peer_effect_jobs_job; DROP INDEX peer_transactions_job; DROP INDEX peer_nonces_effect');
  } finally { db.close(); }
  w.reopen();
}

test('T17 ten thousand retained jobs refuse with one indexed candidate query and no per-job statements or mutations', t => {
  const w = world(t, { maxRecords: 10000 }); seedCapacity(w, 10000);
  for (const method of ['classify', 'reserve']) {
    const queries = observeQueries(() => assert.throws(() => w.store[method](request(w, 'new'), {}), { code: 'peer_job_capacity' }));
    assert.ok(queries.length < 25, 'statement count is independent of the job count');
    assert.equal(queries.filter(sql => sql.startsWith('SELECT 1 FROM peer_effects e')).length, 1, 'global legacy check runs once');
    const candidates = queries.filter(sql => sql.startsWith('SELECT j.job FROM peer_jobs j'));
    assert.equal(candidates.length, 1);
    const db = new DatabaseSync(w.path, { readOnly: true });
    try {
      const plan = db.prepare('EXPLAIN QUERY PLAN ' + candidates[0]).all(1).map(row => row.detail).join('\n');
      assert.match(plan, /SEARCH m USING COVERING INDEX peer_effect_jobs_job/);
      assert.match(plan, /SEARCH t USING COVERING INDEX peer_transactions_job/);
      assert.match(plan, /SEARCH s USING COVERING INDEX .*\(slot>\? AND slot<\?\)/);
      assert.doesNotMatch(plan, /SCAN [mts]\b/);
    } finally { db.close(); }
  }
  assert.equal(w.count('peer_jobs'), 10000); assert.equal(w.count('peer_effects'), 10000); assert.equal(w.count('peer_nonces'), 0);
});

test('T18 context capacity uses indexed nonce lookups and stops after enough terminal rows; below cap reads no old sessions', t => {
  let calls = [], terminal = false;
  const w = world(t, { maxRecords: 10000, contextSessionState: input => { calls.push(input.jobId); return terminal && oldJobs.has(input.jobId) ? 'finalised' : null; } });
  seedCapacity(w, 9999, true);
  const issue = label => {const jobId=jid(label); return w.store.issueContextChallenge({ jobId, buyer }, { jobId, buyer }, { maxPerBuyer: 10, maxGlobal: 10, admit: () => w.now() });};
  // Challenge issuance and both reserve modes below capacity need only the
  // incoming job's state, regardless of how many old contexts are retained.
  for (const method of ['classify', 'issue', 'reserve']) {
    calls = [];
    if (method === 'issue') issue('new');
    else if (method === 'reserve') w.store.reserve(context(w, 'new'), contextBody('new'), { admit: () => w.now() });
    else noMutations(() => assert.equal(w.store.classify(context(w, 'new'), contextBody('new'), { admit: () => w.now() }), 'start'));
    assert.deepEqual(calls, [jid(method === 'issue' ? 'new' : 'job-new')]);
  }
  calls = [];
  const queries = observeQueries(() => {
    assert.throws(() => issue('full'), { code: 'peer_context_capacity' });
    assert.throws(() => w.store.classify(context(w, 'full'), contextBody('full'), { admit: () => w.now() }), { code: 'peer_context_capacity' });
    assert.throws(() => w.store.reserve(context(w, 'full'), contextBody('full'), { admit: () => w.now() }), { code: 'peer_context_capacity' });
  });
  assert.ok(queries.length < 60, 'no per-admission SQL statements');
  const query = queries.find(sql => sql.startsWith('SELECT a.job, a.effect'));
  const db = new DatabaseSync(w.path, { readOnly: true });
  try {
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + query).all(w.now() - HOUR, w.now(), w.now() - 60000).map(row => row.detail).join('\n');
    assert.match(plan, /SEARCH n USING INDEX peer_nonces_effect/); assert.doesNotMatch(plan, /SCAN n\b/);
  } finally { db.close(); }
  assert.equal(calls.filter(job => oldJobs.has(job)).length, 9999 * 3);
  assert.equal(w.count('peer_context_admissions'), 10000); assert.equal(w.count('peer_context_challenges'), 1);
  terminal = true;
  for (const method of ['classify', 'issue', 'reserve']) {
    calls = [];
    if (method === 'issue') issue('room');
    else if (method === 'reserve') assert.equal(w.store.reserve(context(w, 'room'), contextBody('room'), { admit: () => w.now() }).disposition, 'perform');
    else noMutations(() => assert.equal(w.store.classify(context(w, 'room'), contextBody('room'), { admit: () => w.now() }), 'start'));
    assert.equal(calls.filter(job => oldJobs.has(job)).length, 1, 'stop after one reclaimable admission');
    assert.equal(w.count('peer_context_admissions'), 10000, 'planning retains rows; reserve replaces only the necessary row');
  }
});

test('T19 terminal state is job-scoped and refuses another buyer after cleanup and restart', t => {
  const terminal = new Set();
  const w = world(t, { maxRecords: 5, maxContextRecords: 1, contextSessionState: input => {
    assert.deepEqual(Object.keys(input), ['jobId'], 'the reader cannot scope state by the requester');
    return terminal.has(input.jobId) ? 'finalised' : null;
  } });
  const old = context(w, 0); w.store.finish(w.store.reserve(old, contextBody(0), { admit: () => w.now() }), 200, '{}');
  terminal.add(old.jobId); w.advance(HOUR + 1);
  assert.throws(() => w.store.classify(context(w, 0, { buyer: other }), contextBody(0)), { code: 'peer_job_conflict' });
  w.store.finish(w.store.reserve(context(w, 1), contextBody(1), { admit: () => w.now() }), 200, '{}');
  assert.equal(w.store.contextAdmission(old.jobId), null); w.reopen();
  noMutations(() => {
    assert.throws(() => w.store.classify(context(w, 0, { buyer: other }), contextBody(0)), { code: 'context_session_terminal' });
    assert.throws(() => w.store.reserve(context(w, 0, { buyer: other }), contextBody(0)), { code: 'context_session_terminal' });
    assert.throws(() => w.store.issueContextChallenge({ jobId: old.jobId, buyer: other }, {jobId:old.jobId}, { admit: () => w.now() }), { code: 'context_session_terminal' });
  });
});

test('T20 legacy unmapped effects, slot prefixes and transaction references keep job bindings fenced', t => {
  for (const barrier of ['unmapped', 'slot', 'transaction']) {
    const w = world(t);
    const db = new DatabaseSync(w.path);
    try {
      db.prepare('INSERT INTO peer_jobs VALUES (?, ?)').run('old', '{}');
      if (barrier === 'unmapped') db.prepare('INSERT INTO peer_effects VALUES (?, ?, ?, ?, ?)').run('legacy', 'owner', 'uncertain', 503, '{}');
      if (barrier === 'slot') db.prepare('INSERT INTO peer_slots VALUES (?, ?)').run('old:/legacy', 'legacy');
      if (barrier === 'transaction') db.prepare('INSERT INTO peer_transactions VALUES (?, ?, ?)').run('tx', 'old', 'legacy');
    } finally { db.close(); }
    noMutations(() => assert.throws(() => w.store.reserve(request(w, 'new'), {}), { code: 'peer_job_capacity' }));
    assert.equal(w.count('peer_jobs'), 1);
  }
});
