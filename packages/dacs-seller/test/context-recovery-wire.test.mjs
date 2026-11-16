// The wire context route after the first admission: the identical accepted presentation continues without a first admission's
// checks, a replay is answered only once the stored outcome is revalidated at its source, and a settled admission is answered
// without a reservation. The provider is the counting stand-in of helpers/context-wire-world.mjs: its passive read
// (`behaviour.source`) stands for the retained Vet records and receipts, so these tests prove the route's decisions, not the
// native anchor's reads (those are covered with the real provider in context-provider-checkpoints.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { SellerTransportError } from '../src/dacs/seller-transport-auth.mjs';
import { JOB as WIRE_JOB, JOB2 as WIRE_JOB2, SELLER_CONTEXT_PATH, T0, contextWireWorld, deferred } from './helpers/context-wire-world.mjs';
import { watchSql } from './helpers/challenge-route-fixture.mjs';

const summary = (answer) => [answer.status, answer.body.error];
const SKEW_MS = 600_000;
const FIRST_VET_NON_PASS = { disposition: 'rejected', reason: 'seller Vet decision: fail', code: 'party_vet_non_pass', errorClass: 'permanent' };
const SECOND_VET_NON_PASS = { disposition: 'rejected', reason: 'buyer Vet decision: fail', code: 'party_vet_non_pass', errorClass: 'permanent' };

/** The same signed body sent again under a new envelope, as a retry that lost its answer does. */
const resign = async (w, request, options = {}) => ({ ...request, ...(await w.sign({ jobId: WIRE_JOB, actor: w.buyer, body: request.body, hash: sha256Hex(canonicalize(request.body.scope)), path: SELLER_CONTEXT_PATH, ...options })), url: SELLER_CONTEXT_PATH });

/** A first admission whose process died between its acceptance and the reservation: the row is `admitted`, nothing has run. */
async function admittedAndCut(w, options) {
  const request = await w.startContext(options);
  // A closed-admission refusal leaves the row to compensation, so the row stays admitted as it would after a crash.
  w.behaviour.beforeReserve = async () => { throw new SellerTransportError('context_admission_closed', 409); };
  assert.deepEqual(summary(await w.post(request)), [409, 'context_admission_closed']);
  w.behaviour.beforeReserve = null;
  assert.equal(w.rowOf().state, 'admitted');
  return request;
}

/** A completed first admission. */
async function settled(w, options) {
  const request = await w.startContext(options), answer = await w.post(request);
  await w.settleJob();
  assert.equal(answer.status, 200);
  return { request, answer };
}

// A presentation that differs from the accepted one in one member.
const changed = (bundle) => { bundle.presentedAt += 1; };
const effects = (w) => ({ holds: w.counts.holds.length, files: w.journalFiles(), vetWrites: w.counts.vetWrites, reserves: w.reserved.calls, starts: w.internals.admissionCounts().starts });

test('after a crash past D4 the identical retry continues to D5 and gets new', async (t) => {
  const w = await contextWireWorld(t), request = await admittedAndCut(w);
  assert.equal(w.counts.holds.length, 1);
  const again = await w.post(await resign(w, request));
  await w.settleJob();
  assert.equal(again.status, 200, again.text);
  assert.deepEqual([w.counts.validations, w.counts.holds.length, w.internals.admissionCounts().starts, w.counts.vetWrites], [1, 1, 1, 2]);
  assert.deepEqual([w.rowOf().state, w.rowOf().contextOutcome, w.operationOf(WIRE_JOB).state], ['settled', 'success', 'completed']);
});

test('continuation after challenge expiry and generatedAt skew, after a restart and for the proposal runs no freshness check and writes nothing to the ledger', async (t) => {
  const w = await contextWireWorld(t), request = await admittedAndCut(w);
  const challenge = w.challengeOf(request.nonce);
  w.advance(SKEW_MS + 1);
  const answer = await w.post(await resign(w, request));
  await w.settleJob();
  assert.equal(answer.status, 200);
  assert.equal(w.counts.validations, 1, 'the profile admission is not asked again');
  assert.deepEqual(w.challengeOf(request.nonce), challenge, 'the challenge row is unchanged');
});

test('a changed presentation, a missing retained admission, a refusing authority reader and an invalid Vet receipt are refused without a signature', async (t) => {
  await t.test('a changed presentation under an accepted nonce', async (t) => {
    const w = await contextWireWorld(t), { request } = await settled(w), before = effects(w);
    assert.deepEqual(summary(await w.post(await w.startContext({ nonce: request.nonce, bundleChange: changed }))), [409, 'peer_agreement_mismatch']);
    assert.deepEqual(effects(w), before);
  });
  await t.test('a missing retained admission', async (t) => {
    const w = await contextWireWorld(t), request = await admittedAndCut(w);
    w.internals.db.prepare('UPDATE kit_challenges SET accepted = NULL WHERE nonce = ?').run(request.nonce);
    const before = effects(w);
    assert.deepEqual(summary(await w.post(await resign(w, request))), [503, 'session_admission_unavailable']);
    assert.deepEqual(effects(w), before);
  });
  await t.test('an authority reader that refuses', async (t) => {
    const w = await contextWireWorld(t), request = await admittedAndCut(w), before = effects(w);
    w.policy.access = async () => { throw Object.assign(new Error('TEST closed'), { code: 'buyer_access_closed' }); };
    assert.deepEqual(summary(await w.post(await resign(w, request))), [409, 'buyer_access_closed']);
    assert.deepEqual(effects(w), before);
  });
  await t.test('an invalid Vet receipt', async (t) => {
    const w = await contextWireWorld(t), { request } = await settled(w), before = effects(w);
    w.behaviour.source = async () => null;
    assert.deepEqual(summary(await w.post(await resign(w, request))), [503, 'seller_source_unavailable']);
    assert.deepEqual(effects(w), before);
    assert.equal(w.counts.agreementSignatures, 0);
  });
});

test('a first-Vet and a second-Vet non-pass are each answered again after revalidation of the one non-pass record, after a restart and at capacity, and never lead to an Agreement signature', async (t) => {
  for (const [name, nonPass, vetWrites] of [['first', FIRST_VET_NON_PASS, 1], ['second', SECOND_VET_NON_PASS, 2]]) {
    await t.test(`${name}-Vet non-pass`, async (t) => {
      const w = await contextWireWorld(t);
      w.behaviour.answer = async () => nonPass;
      const { request, answer } = await settled(w);
      assert.equal(w.rowOf().contextOutcome, 'vet-non-pass');
      const stored = w.operationOf(WIRE_JOB).outcome.text, before = effects(w);
      const replay = await w.post(await resign(w, request));
      assert.deepEqual([replay.status, replay.text], [200, answer.text]);
      assert.equal(replay.text, stored, 'the stored bytes are the answer');
      assert.deepEqual(effects(w), before);
      assert.equal(w.counts.agreementSignatures, 0);
      w.behaviour.source = async () => null;
      assert.deepEqual(summary(await w.post(await resign(w, request))), [503, 'seller_source_unavailable']);
      assert.equal(w.operationOf(WIRE_JOB).outcome.text, stored, 'the outcome is not rewritten');
      assert.ok(vetWrites >= 1);
    });
  }
});

test('under ready:false an accepted continuation with a live delegation is admitted and spends one unit of the context slot', async (t) => {
  const w = await contextWireWorld(t, { requireDelegation: true }), request = await admittedAndCut(w);
  w.state.ready = () => false;
  const reservesBefore = w.reserved.calls;
  const answer = await w.post(await resign(w, request));
  await w.settleJob();
  assert.equal(answer.status, 200);
  assert.deepEqual([w.reserved.calls - reservesBefore, w.counts.vetWrites, w.journalFiles()], [1, 2, 4]);
});

test('the same continuation under an expired delegation is refused peer_delegation_expired 408 with no readback and no file', async (t) => {
  const w = await contextWireWorld(t, { requireDelegation: true }), request = await admittedAndCut(w), before = effects(w);
  const expired = w.delegationFor({ at: T0 - 120_000, lifetimeMs: 60_000 });
  const answer = await w.post(await resign(w, request, { delegation: expired }));
  assert.deepEqual(summary(answer), [408, 'peer_delegation_expired']);
  assert.deepEqual(effects(w), before);
  assert.equal(w.counts.sourceReads, 0);
});

test('under ready:false a new purchase\'s first context request is refused seller_not_ready with no row and no file', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext();
  w.state.ready = () => false;
  assert.deepEqual(summary(await w.post(request)), [503, 'seller_not_ready']);
  assert.deepEqual([w.rowOf(), w.journalFiles(), w.counts.holds.length], [null, 0, 0]);
});

test('a lost answer of a settled admission at full capacity is answered from the stored outcome with no reservation, also after a restart; the four paired negatives are refused', async (t) => {
  const w = await contextWireWorld(t, { storeOptions: { maxRecords: 100 } }), { request, answer } = await settled(w), newPurchase = await w.startContext({ jobId: WIRE_JOB2 });
  w.state.ready = () => false;
  const before = effects(w), sql = watchSql(t);
  for (let n = 0; n < 2; n++) {
    const replay = await resign(w, request), got = await w.post(replay);
    assert.deepEqual([got.status, got.text], [200, answer.text]);
    await replay.verify(got);
  }
  assert.equal(sql.writes(), 0, 'no write statement');
  assert.deepEqual(effects(w), before);
  assert.deepEqual(summary(await w.post(await w.startContext({ nonce: request.nonce, bundleChange: changed }))), [409, 'peer_agreement_mismatch']);
  w.behaviour.source = async () => { throw new Error('TEST the source is down'); };
  assert.deepEqual(summary(await w.post(await resign(w, request))), [503, 'seller_source_unavailable']);
  assert.deepEqual(summary(await w.post(newPurchase)), [503, 'seller_not_ready']);
  assert.deepEqual(effects(w), before);
  const closedRows = [
    ['an aborted admission', (w) => w.admission.compensate(WIRE_JOB, 'a'), 'aborted'],
    // A row that reads settled while its operation has no completed outcome, as a compensation that settled without one would leave it.
    ['a row settled with no completed outcome', (w) => { w.internals.db.prepare('UPDATE kit_context_admissions SET record = json_set(record, \'$.state\', \'settled\') WHERE jobId = ?').run(WIRE_JOB); }, 'settled'],
  ];
  for (const [name, close, state] of closedRows) {
    await t.test(name, async (t) => {
      const w = await contextWireWorld(t), request = await admittedAndCut(w);
      await close(w);
      assert.equal(w.rowOf().state, state);
      assert.equal(w.operationOf(WIRE_JOB)?.state === 'completed', false);
      w.state.ready = () => false;
      const before = effects(w);
      assert.deepEqual(summary(await w.post(await resign(w, request))), [503, 'seller_not_ready']);
      assert.deepEqual(effects(w), before);
    });
  }
});

test('a settled answer whose request expires while its records are read back is refused peer_expired and changes nothing', async (t) => {
  const w = await contextWireWorld(t), { request, answer } = await settled(w), stored = w.operationOf(WIRE_JOB).outcome.text, before = effects(w);
  const replay = await resign(w, request, { lifetimeMs: 5_000 });
  w.behaviour.source = async () => { w.advance(5_001); return JSON.parse(answer.text); };
  assert.deepEqual(summary(await w.post(replay)), [408, 'peer_expired']);
  assert.equal(w.counts.sourceReads, 1, 'the records were read back before the expiry was checked again');
  assert.equal(w.operationOf(WIRE_JOB).outcome.text, stored);
  assert.deepEqual(effects(w), before);
});

test('an aborted admission\'s interrupted context step is never resumed', async (t) => {
  const w = await contextWireWorld(t), request = await admittedAndCut(w);
  await w.admission.compensate(WIRE_JOB, 'a');
  assert.equal(w.rowOf().state, 'aborted');
  const before = effects(w);
  assert.deepEqual(summary(await w.post(await resign(w, request))), [409, 'context_admission_closed']);
  assert.deepEqual(effects(w), before);
});

test('a retry of an accepted presentation continues by accepted continuation and answers the stored outcome', async (t) => {
  const w = await contextWireWorld(t), { request, answer } = await settled(w), before = effects(w);
  const sql = watchSql(t);
  const again = await w.post(request);
  assert.deepEqual([again.status, again.text], [200, answer.text]);
  await request.verify(again);
  assert.equal(sql.writes(), 0, 'no write statement');
  assert.deepEqual(effects(w), before);
});

test('accepted context continuation × each current stage gate without repeating first admission', async (t) => {
  const gates = [
    ['buyer access refused', 409, 'buyer_access_closed', (w) => { w.policy.access = async () => { throw Object.assign(new Error('TEST closed'), { code: 'buyer_access_closed' }); }; }],
    ['buyer access rejects', 503, 'session_admission_unavailable', (w) => { w.policy.access = async () => { throw new Error('TEST access reader failed'); }; }],
    ['known job false', 409, 'context_job_unknown', (w) => { w.policy.known = async () => false; }],
  ];
  for (const [name, status, code, fail] of gates) {
    await t.test(name, async (t) => {
      const w = await contextWireWorld(t), request = await admittedAndCut(w), challenge = w.challengeOf(request.nonce);
      w.advance(SKEW_MS + 1);
      fail(w);
      const before = effects(w), answer = await w.post(await resign(w, request));
      assert.deepEqual([answer.status, answer.body.error], [status, code]);
      assert.deepEqual(effects(w), before);
      assert.deepEqual(w.challengeOf(request.nonce), challenge);
    });
  }
  await t.test('a passing control after the challenge expired reads the profile admission 0 times', async (t) => {
    const w = await contextWireWorld(t), request = await admittedAndCut(w);
    w.advance(SKEW_MS + 1);
    assert.equal((await w.post(await resign(w, request))).status, 200);
    await w.settleJob();
    assert.equal(w.counts.validations, 1);
  });
  await t.test('a source that cannot confirm the Vet receipts', async (t) => {
    const w = await contextWireWorld(t), { request } = await settled(w), stored = w.operationOf(WIRE_JOB).outcome.text;
    w.behaviour.source = async () => null;
    assert.deepEqual(summary(await w.post(await resign(w, request))), [503, 'seller_source_unavailable']);
    assert.equal(w.operationOf(WIRE_JOB).outcome.text, stored);
  });
});

test('settled context inspection may answer the same signed request twice without a reservation nonce or effect', async (t) => {
  for (const [name, answer] of [['present', null], ['first-Vet non-pass', FIRST_VET_NON_PASS], ['second-Vet non-pass', SECOND_VET_NON_PASS]]) {
    await t.test(name, async (t) => {
      const w = await contextWireWorld(t);
      if (answer) w.behaviour.answer = async () => answer;
      const { request, answer: first } = await settled(w), before = effects(w), reads = w.counts.sourceReads;
      const replay = await resign(w, request);
      for (let n = 0; n < 2; n++) assert.deepEqual((({ status, text }) => ({ status, text }))(await w.post(replay)), { status: 200, text: first.text });
      assert.equal(w.counts.sourceReads - reads, 2, 'each answer revalidates');
      assert.deepEqual(effects(w), before);
      w.behaviour.source = async () => null;
      assert.deepEqual(summary(await w.post(replay)), [503, 'seller_source_unavailable']);
    });
  }
});

test('an unfinished earlier attempt of an accepted admission is held and neither ended nor run again', async (t) => {
  const w = await contextWireWorld(t), request = await admittedAndCut(w);
  w.behaviour.recover = true;
  const answer = await w.post(await resign(w, request));
  assert.deepEqual([...summary(answer), answer.body.cause], [503, 'operation_uncertain', 'context_recovery_held']);
  assert.deepEqual([w.counts.resolves, w.completions.length, w.counts.vetWrites], [0, 0, 0]);
});

for (const [title, stall] of [['before its first Vet write', 'provider'], ['after its first Vet write', 'afterFirstWrite']]) {
  test(`a resend that arrives while the first attempt is still running ${title} is answered seller_effect_pending and leaves the job to that attempt`, async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    const reached = deferred(), gate = deferred();
    w.behaviour[stall] = async () => { reached.resolve(); await gate.promise; };
    const first = w.post(request);
    await reached.promise;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let refused = null;
    w.post(await resign(w, request)).then((answer) => { refused = answer; });
    try {
      // The wait for the job's mutex is bounded at ten seconds: time moves on in steps until the resend is answered.
      for (let step = 0; step < 30 && refused === null; step++) { await new Promise((resolve) => setImmediate(resolve)); t.mock.timers.tick(1000); }
      assert.notEqual(refused, null, 'the resend is answered while the first attempt is running');
      assert.deepEqual(summary(refused), [503, 'seller_effect_pending']);
      assert.equal(w.rowOf().state, 'running', 'the resend does not end the job');
      assert.equal(w.counts.releases.length, 0);
    } finally { gate.resolve(); t.mock.timers.reset(); }
    const answer = await first;
    await w.settleJob();
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual([w.rowOf().state, w.rowOf().contextOutcome, w.counts.vetWrites, w.counts.holds.length, w.counts.releases.length], ['settled', 'success', 2, 1, 1]);
  });
}

test('a completed outcome of a running admission is revalidated and answered without a second start', async (t) => {
  const w = await contextWireWorld(t), { request, answer } = await settled(w);
  // A crash after the outcome was published and before the row settled leaves the row running with a completed operation.
  w.internals.db.prepare('UPDATE kit_context_admissions SET record = json_set(record, \'$.state\', \'running\', \'$.contextOutcome\', NULL) WHERE jobId = ?').run(WIRE_JOB);
  const { holds, starts, vetWrites } = effects(w), replay = await w.post(await resign(w, request));
  assert.deepEqual([replay.status, replay.text], [200, answer.text]);
  const after = effects(w);
  assert.deepEqual([after.holds, after.starts, after.vetWrites], [holds, starts, vetWrites]);
  assert.equal(w.counts.sourceReads, 1);
});

test('register context present and non-pass in the shared completed-source matrix', async (t) => {
  const changedAnswer = (answer) => (answer.disposition === 'present'
    ? { ...answer, value: { ...answer.value, input: { ...answer.value.input, jobId: WIRE_JOB2 } } }
    : { ...answer, reason: 'seller Vet decision: changed' });
  const sources = [
    ['absent', () => null, 'absent'],
    ['failing', () => { throw Object.assign(new Error('TEST the node failed'), { code: 'node_failed' }); }, 'node_failed'],
    ['changed', changedAnswer, 'changed'],
  ];
  for (const [kind, stored] of [['present', null], ['first-Vet non-pass', FIRST_VET_NON_PASS], ['second-Vet non-pass', SECOND_VET_NON_PASS]]) {
    for (const [state, source, cause] of sources) {
      await t.test(`${kind} with a ${state} source`, async (t) => {
        const w = await contextWireWorld(t);
        if (stored) w.behaviour.answer = async () => stored;
        const { request, answer } = await settled(w), outcome = w.operationOf(WIRE_JOB).outcome.text, before = effects(w);
        w.behaviour.source = async () => source(JSON.parse(answer.text));
        const refused = await w.post(await resign(w, request));
        assert.deepEqual([...summary(refused), refused.body.cause], [503, 'seller_source_unavailable', cause]);
        assert.equal(w.operationOf(WIRE_JOB).outcome.text, outcome, 'the outcome is unchanged');
        assert.deepEqual(effects(w), before);
        w.behaviour.source = null;
        const control = await w.post(await resign(w, request));
        assert.deepEqual([control.status, control.text], [200, answer.text], 'a valid source answers the stored bytes');
      });
    }
  }
});
