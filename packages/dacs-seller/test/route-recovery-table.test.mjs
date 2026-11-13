// The per-route recovery table for proposals and the two bundle routes, over the real wire handler, wire journal and transport
// store. Rule tests use the counting stand-in agent; revalidation and bundle tests put the real durable agent behind the handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DACS_SELLER_HTTP_PATHS as PATHS } from '@kynesyslabs/dacs/wire';
import { SELLER_EFFECT_ROUTES, createSellerEffectRoutes } from '../src/dacs/seller-effect-routes.mjs';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { JOB, testWallet } from './helpers/protocol-fixture.mjs';
import { BUYER, SELLER, PIN, continuingWorld, derive, jobFor, proposeJob, world } from './helpers/wire-routes-world.mjs';
import { BUNDLE_REFUSALS, SHORT_LEASE_MS, bundleWorld, claimedTransport, completions, editSession, markPaid, operationOf, proposalSigningRig, reconcileInput, realWorld, tempDirectory } from './helpers/route-recovery-world.mjs';

const VET_READS = ['resolveVetRecord', 'readVetAnchorReceipt', 'verifyVetAnchorReceipt'];
const ADMISSION_READ_TIMEOUT_MS = 10_000;
const ADMISSION_READ_MAX_BYTES = 65_536;

test('NEW-D1a-table-scope', async (t) => {
  const enabled = createSellerEffectRoutes({ commitOnSignature: false });
  const owned = [PATHS.proposals, PATHS.bundleRequest, PATHS.bundleCountersignature].sort();
  assert.deepEqual(Object.keys(enabled).sort(), owned, 'one row per owned route');
  assert.deepEqual(Object.keys(createSellerEffectRoutes({ commitOnSignature: true })).sort(), owned, 'no commitment row exists, enabled or not');
  for (const bad of [undefined, null, 'true', 1]) assert.throws(() => createSellerEffectRoutes({ commitOnSignature: bad }), TypeError, `commitOnSignature ${bad}`);
  assert.throws(() => createSellerEffectRoutes(), TypeError);
  assert.ok(Object.isFrozen(SELLER_EFFECT_ROUTES) && Object.values(SELLER_EFFECT_ROUTES).every((route) => Object.isFrozen(route)), 'the table and its rows are frozen');
  assert.throws(() => { enabled[PATHS.payments] = enabled[PATHS.proposals]; }, TypeError);
  for (const path of [PATHS.state, PATHS.bundleBuyerCopy, PATHS.payments, PATHS.commitments, PATHS.commitmentSignature, '/dacs/v1/context', `${PATHS.proposals}?x=1`, PATHS.proposals.toUpperCase()]) {
    assert.equal(enabled[path], undefined, `${path} has no row`);
  }
  for (const route of Object.values(enabled)) assert.deepEqual(Object.keys(route).sort(), ['endAfter', 'idempotenceKey', 'recover', 'revalidate', 'sink']);

  await t.test('only a completed proposal replay is revalidated: reads and other routes never are', async () => {
    const w = await continuingWorld(t), revalidated = [];
    w.agent.revalidateCompletedAnswer = async (input) => { revalidated.push(input.path); };
    for (const path of [PATHS.state, PATHS.bundleBuyerCopy, PATHS.commitments, PATHS.commitments]) assert.equal((await w.request(path)).status, 200, path);
    assert.deepEqual(revalidated, []);
    assert.equal((await w.request(PATHS.proposals)).status, 200, 'the completed proposal replays');
    assert.deepEqual(revalidated, [PATHS.proposals]);
  });
});

test('NEW-D1a-slot-return', async (t) => {
  const w = await world(t);
  w.handle.wireOverrides = { capacity: { retainedAllocated: ({ route }) => route === PATHS.proposals } };
  w.reopen();
  // A restart reopens the store, so the capacity is read from the handle each time.
  const slots = (jobId) => w.handle.capacity.capacityReport().allocations.find((allocation) => allocation.jobId === jobId).slots;
  const jobs = {};
  for (const name of ['completed', 'waiting', 'open']) {
    jobs[name] = await proposeJob(w, `slot-${name}`);
    sellerStoreInternals(w.handle.store).transaction(() => w.handle.capacity.allocateWithin({ jobId: jobs[name].jobId, buyer: BUYER.claim, seller: SELLER.claim, listingPin: PIN }));
  }
  const slotAfter = async (name, answer, retains = false) => {
    w.agent.retains = retains; w.agent.answer = answer;
    const before = slots(jobs[name].jobId);
    await jobs[name].post();
    const after = slots(jobs[name].jobId);
    for (const other of Object.keys(before).filter((route) => route !== PATHS.proposals)) assert.deepEqual(after[other], before[other], `${name}: ${other} stays as it was`);
    return after[PATHS.proposals];
  };
  const waiting = () => ({ disposition: 'waiting', stage: 'lease', reason: 'TEST' });
  assert.deepEqual(await slotAfter('completed', undefined), { spent: 1, state: 'returned' }, 'a completed proposal returns its own slot');
  assert.notEqual((await slotAfter('waiting', waiting)).state, 'returned', 'a waiting proposal (null end) returns none');
  assert.notEqual((await slotAfter('open', waiting, true)).state, 'returned', 'an open attempt returns none');
  assert.deepEqual(completions(w).map((row) => row.status), [200], 'only the completed proposal was recorded');
  const settled = slots(jobs.completed.jobId)[PATHS.proposals];
  for (const restart of [false, true]) {
    if (restart) w.reopen();
    assert.equal((await jobs.completed.post()).status, 200, 'the replay answers the stored outcome');
    assert.deepEqual(slots(jobs.completed.jobId)[PATHS.proposals], settled, `replay returns no slot, restart ${restart}`);
    assert.equal(completions(w).length, 1, `replay records no completion, restart ${restart}`);
  }
  const bundles = await continuingWorld(t);
  bundles.agent.bundleRequest = async () => { throw new SellerAgentError('not_delivered', 'TEST nothing was delivered', 422); };
  assert.equal((await bundles.request(PATHS.bundleRequest)).body.error, 'not_delivered');
  assert.deepEqual(completions(bundles).filter((row) => row.route === PATHS.bundleRequest), [], 'a bundle refusal records no completion and returns no slot');
});

test('K5-R4 proposal answer {waiting, indeterminate, rejected} × signature intent {none, present}', async (t) => {
  for (const disposition of ['waiting', 'indeterminate', 'rejected']) for (const intent of [false, true]) {
    const w = await world(t, { leaseMs: SHORT_LEASE_MS }), job = await proposeJob(w, `r4-${disposition}-${intent}`);
    w.agent.retains = intent;
    w.agent.answer = () => ({ disposition, stage: 'lease', reason: 'TEST' });
    const cell = `${disposition} intent ${intent}`;
    await job.post();
    const view = operationOf(w, job.jobId, PATHS.proposals);
    assert.equal(view.state, intent ? 'pending' : 'ended', `${cell}: only an attempt with no signature intent ends null`);
    if (!intent) assert.equal(view.superseded, 0, `${cell}: a clean null end spends no superseded attempt`);
    if (intent) {
      assert.equal((await job.post()).body.error, 'seller_effect_pending', `${cell}: pending within the lease`);
      w.state.time += SHORT_LEASE_MS;
    }
    const reconciled = w.agent.calls.reconciled;
    assert.equal((await job.post()).status, 200, `${cell}: recovered`);
    assert.equal(w.agent.calls.reconciled, reconciled + 1, `${cell}: the agent reconciled first`);
  }
});

test('K5-R6 a proposal answered waiting after its signature intent stays open: pending within the lease, then recover resumes the same responder with one seller signature', async (t) => {
  // The attempt: waiting with retained signature work stays open, pending within the lease, and recovers after it.
  const w = await world(t, { leaseMs: SHORT_LEASE_MS }), job = await proposeJob(w, 'r6-open');
  w.agent.retains = true;
  w.agent.answer = () => ({ disposition: 'waiting', stage: 'lease', reason: 'TEST another worker holds the responder' });
  assert.equal((await job.post()).body.disposition, 'waiting');
  assert.equal(operationOf(w, job.jobId, PATHS.proposals).state, 'pending', 'never ended null');
  assert.equal((await job.post()).body.error, 'seller_effect_pending', 'pending within the lease');
  w.state.time += SHORT_LEASE_MS;
  assert.equal((await job.post()).status, 200, 'recovered after the lease');
  // The responder: the signature intent is kept when the signer fails, and recovery signs the same bytes once.
  const { data } = tempDirectory(t), { agent, body, signatures, failNextSignature } = await proposalSigningRig(data);
  t.after(() => agent.close());
  failNextSignature();
  assert.notEqual((await agent.receiveProposal(body)).disposition, 'complete', 'the failed signer completes nothing');
  assert.equal(agent.retainsProposalWork(JOB), true, 'the intent keeps the work');
  assert.deepEqual(signatures, []);
  const recovered = await agent.reconcileTransport({ ...reconcileInput(agent, body), transport: claimedTransport });
  assert.deepEqual([recovered.disposition, recovered.value.disposition], ['present', 'complete']);
  assert.equal(signatures.length, 1, 'one seller signature');
});

// The completed proposal over a real durable agent, then its stored answer replayed.
const completedProposal = async (t, options) => {
  const w = await realWorld(t, options), first = await w.request(PATHS.proposals);
  assert.equal(first.status, 200);
  return { ...w, first, outcome: { status: first.status, text: first.text } };
};
const snapshot = (w) => ({ session: JSON.stringify(w.fixture.agent().durableSessionOf(w.jobId)), signed: w.fixture.signed.length, writes: w.fixture.publications.length,
  admissions: w.fixture.admission.calls.filter(([name]) => ['admit', 'readRevocationSurfaces'].includes(name)).length });
const revalidation = (w) => w.fixture.agent().revalidateCompletedAnswer({ path: PATHS.proposals, jobId: w.jobId, outcome: w.outcome });
const sourceFailure = async (promise) => {
  const error = await promise.then(() => assert.fail('revalidation passed'), (rejected) => rejected);
  assert.deepEqual({ name: error.constructor.name, code: error.code, status: error.status }, { name: 'SellerTransportError', code: 'seller_source_unavailable', status: 503 });
  return error.cause;
};

test('completed revalidation: route {proposals, commitments, commitments/signature, payments, context present, context non-pass} × retained evidence item × source state {absent, indeterminate, rejected, non-final, timeout, oversized, changed record/projection/receipt/time, valid with later observedAt}', async (t) => {
  const w = await completedProposal(t), admission = w.fixture.config.sessionAdmission;
  assert.equal(await revalidation(w), undefined, 'the valid control passes');
  const settled = snapshot(w);

  await t.test('proposal cells: every Vet read, for each party, fails alone with the cause of its failure', async () => {
    for (const method of VET_READS) for (const role of ['buyer', 'seller']) {
      const read = admission[method];
      const sourceStates = {
        reader: ['unavailable', async () => { throw new Error('TEST source unavailable'); }],
        oversized: ['too_large', async (answer) => (typeof answer === 'string' ? 'x'.repeat(ADMISSION_READ_MAX_BYTES + 1) : { ...answer, padding: 'x'.repeat(ADMISSION_READ_MAX_BYTES + 1) })],
        changed: ['changed', async (answer) => ({ resolveVetRecord: null, readVetAnchorReceipt: { ...answer, contentHash: derive('another record') }, verifyVetAnchorReceipt: 'invalid' })[method]],
      };
      for (const [state, [cause, tamper]] of Object.entries(sourceStates)) {
        admission[method] = async (query, limits) => (query.role === role ? tamper(await read(query, limits)) : read(query, limits));
        try { assert.equal(await sourceFailure(revalidation(w)), method === 'resolveVetRecord' && state === 'reader' ? 'unavailable' : cause, `${method} ${role} ${state}`); } finally { admission[method] = read; }
        assert.deepEqual(snapshot(w), settled, `${method} ${role} ${state}: nothing was written, signed or admitted`);
      }
    }
    const verify = admission.verifyVetAnchorReceipt;
    admission.verifyVetAnchorReceipt = async () => 'indeterminate';
    try { await sourceFailure(revalidation(w)); } finally { admission.verifyVetAnchorReceipt = verify; }
  });

  await t.test('a read that stalls is stopped at its 10 s deadline with the timeout cause', async (st) => {
    st.mock.timers.enable({ apis: ['setTimeout'] });
    for (const method of VET_READS) {
      const read = admission[method];
      admission[method] = () => new Promise(() => {});
      try {
        const failing = sourceFailure(revalidation(w));
        await new Promise(setImmediate);
        st.mock.timers.tick(ADMISSION_READ_TIMEOUT_MS);
        assert.equal(await failing, 'timeout', method);
      } finally { admission[method] = read; }
    }
    assert.deepEqual(snapshot(w), settled);
  });

  await t.test('the stored answer must be the retained contribution', async () => {
    const stored = JSON.parse(w.outcome.text);
    const other = { ...w.outcome, text: JSON.stringify({ ...stored, contribution: { ...stored.contribution, planHash: derive('another plan') } }) };
    assert.equal(await sourceFailure(w.fixture.agent().revalidateCompletedAnswer({ path: PATHS.proposals, jobId: w.jobId, outcome: other })), 'changed');
    assert.equal(await sourceFailure(w.fixture.agent().revalidateCompletedAnswer({ path: PATHS.proposals, jobId: w.jobId, outcome: { ...w.outcome, text: 'not json' } })), 'changed');
  });

  await t.test('valid evidence whose receipt was only observed later passes and changes nothing', async () => {
    const read = admission.readVetAnchorReceipt, verify = admission.verifyVetAnchorReceipt;
    admission.readVetAnchorReceipt = async (...args) => { const receipt = await read(...args); return { ...receipt, observedAt: receipt.observedAt + 5000 }; };
    admission.verifyVetAnchorReceipt = async () => 'valid';
    try { assert.equal(await revalidation(w), undefined); } finally { Object.assign(admission, { readVetAnchorReceipt: read, verifyVetAnchorReceipt: verify }); }
    w.fixture.advance(3_600_000);
    assert.equal(await revalidation(w), undefined, 'a later clock alone changes nothing either');
    assert.deepEqual(snapshot(w), settled);
  });

  await t.test('a retained contribution that is missing or does not finalize the Agreement fails', async () => {
    for (const [change, cause] of [[(session) => { delete session.sellerContribution; }, 'absent'], [(session) => { session.agreementHash = derive('another agreement'); }, 'changed']]) {
      const edited = await completedProposal(t);
      await editSession(edited.fixture, edited.jobId, change);
      assert.equal(await sourceFailure(revalidation(edited)), cause);
    }
  });

  await t.test('a job the seller holds nothing for, and a path with no completed answer, are not revalidated', async () => {
    await assert.rejects(w.fixture.agent().revalidateCompletedAnswer({ path: PATHS.proposals, jobId: jobFor('revalidate-unknown'), outcome: w.outcome }), (error) => error.code === 'seller_source_unavailable' && error.cause === 'absent');
    for (const path of [PATHS.payments, PATHS.state, PATHS.bundleRequest, PATHS.commitments]) {
      await assert.rejects(w.fixture.agent().revalidateCompletedAnswer({ path, jobId: w.jobId, outcome: w.outcome }), TypeError, path);
    }
  });

  await t.test('on the wire: a replay with an unavailable source is a signed 503 with its cause and the stored outcome stays', async () => {
    const read = admission.resolveVetRecord, signatures = w.signing.calls, received = w.calls.receive;
    assert.equal((await w.request(PATHS.proposals)).text, w.first.text, 'the valid replay answers the stored bytes');
    assert.equal(w.signing.calls, signatures + 1, 'one response signature');
    admission.resolveVetRecord = async () => { throw new Error('TEST source unavailable'); };
    try {
      const refused = await w.request(PATHS.proposals);
      assert.deepEqual({ status: refused.status, signed: refused.signed, error: refused.body.error, cause: refused.body.cause }, { status: 503, signed: true, error: 'seller_source_unavailable', cause: 'unavailable' });
    } finally { admission.resolveVetRecord = read; }
    assert.equal(w.calls.receive, received, 'receiveProposal never ran again');
    assert.deepEqual(operationOf(w, w.jobId, PATHS.proposals).state, 'completed');
    assert.equal((await w.request(PATHS.proposals)).text, w.first.text, 'the stored outcome was not rewritten');
    assert.deepEqual(snapshot(w), settled);
  });
});

const closedAccess = () => createOperatorBuyerAccess({ openBuyerAccess: false, custodyBuyer: testWallet(9).claim });

test('buyer access closed after proposal completion withholds replay without changing the outcome', async (t) => {
  const w = await completedProposal(t), settled = snapshot(w), openAccess = w.fixture.config.buyerAccess;
  assert.equal((await w.request(PATHS.proposals)).text, w.first.text, 'a passing control returns the stored bytes');
  w.fixture.config.buyerAccess = closedAccess();
  await w.fixture.reopen();
  const refused = await w.request(PATHS.proposals);
  assert.deepEqual({ status: refused.status, signed: refused.signed, error: refused.body.error }, { status: 409, signed: true, error: 'buyer_access_closed' }, 'the access refusal keeps its own code');
  assert.equal(w.calls.receive, 1, 'the proposal never ran again');
  assert.equal(w.fixture.signed.length, settled.signed, 'no seller signature was made again');
  assert.equal(operationOf(w, w.jobId, PATHS.proposals).state, 'completed');
  w.fixture.config.buyerAccess = openAccess;
  await w.fixture.reopen();
  assert.equal((await w.request(PATHS.proposals)).text, w.first.text, 'the same stored bytes answer once access is open again');
  assert.equal(snapshot(w).session, settled.session);
});

test('K5-R12 bundle route × payment absent/present: exact named refusal and null end after no-worker proof', async (t) => {
  for (const [path, paid, code, status] of BUNDLE_REFUSALS) {
    const w = await bundleWorld(t);
    if (paid) await editSession(w.fixture, w.jobId, markPaid);
    const signed = w.fixture.signed.length, writes = w.fixture.publications.length;
    const answered = await w.request(path);
    assert.deepEqual({ status: answered.status, error: answered.body.error }, { status, error: code }, `${path} paid ${paid}`);
    assert.equal(operationOf(w, w.jobId, path).state, 'ended', `${path} paid ${paid}: the no-worker proof ended the attempt with null`);
    assert.deepEqual(completions(w).filter((row) => row.route === path), [], 'no completed bundle claim');
    assert.deepEqual([w.fixture.signed.length, w.fixture.publications.length], [signed, writes], 'nothing was signed or sent');
  }
});

test('a bundle route whose job retains unfinished countersignature work is not ended null', async (t) => {
  for (const path of [PATHS.bundleRequest, PATHS.bundleCountersignature]) {
    const w = await bundleWorld(t, { leaseMs: SHORT_LEASE_MS });
    await editSession(w.fixture, w.jobId, (session) => { session.countersignatureWork = { buyerSignature: 'TEST-retained-countersignature' }; });
    await w.request(path);
    assert.equal(operationOf(w, w.jobId, path).state, 'pending', `${path}: the attempt stays open`);
    w.state.time += SHORT_LEASE_MS;
    assert.equal((await w.request(path)).body.error, 'operation_uncertain', `${path}: recovery holds while the work is retained`);
    assert.equal(operationOf(w, w.jobId, path).state, 'pending', `${path}: still open after recovery`);
  }
});
