// The per-route recovery table for proposals and the two bundle routes, over the real wire handler, wire journal and transport
// store. Rule tests use the counting stand-in agent; revalidation and bundle tests put the real durable agent behind the handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DACS_SELLER_HTTP_PATHS as PATHS } from '@kynesyslabs/dacs/wire';
import { SELLER_EFFECT_ROUTES, createSellerEffectRoutes } from '../src/dacs/seller-effect-routes.mjs';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { WIRE_ROUTE_PATHS } from '../src/dacs/seller-wire-requests.mjs';
import { JOB, testWallet } from './helpers/protocol-fixture.mjs';
import { BUYER, SELLER, PIN, continuingWorld, derive, jobFor, proposeJob, world } from './helpers/wire-routes-world.mjs';
import { BUNDLE_REFUSALS, SHORT_LEASE_MS, bundleWorld, claimedTransport, completions, editSession, markPaid, operationOf, proposalSigningRig, reconcileInput, realWorld, tempDirectory } from './helpers/route-recovery-world.mjs';

const VET_READS = ['resolveVetRecord', 'readVetAnchorReceipt', 'verifyVetAnchorReceipt'];
const ADMISSION_READ_TIMEOUT_MS = 10_000;
const ADMISSION_READ_MAX_BYTES = 65_536;

test('NEW-D1a-table-scope', async (t) => {
  const enabled = createSellerEffectRoutes({ commitOnSignature: false });
  const owned = [PATHS.proposals, PATHS.bundleRequest, PATHS.bundleCountersignature, PATHS.commitments].sort();
  assert.deepEqual(Object.keys(enabled).sort(), owned, 'one row per owned route');
  assert.deepEqual(Object.keys(createSellerEffectRoutes({ commitOnSignature: true })).sort(), [...owned, PATHS.commitmentSignature].sort(), 'the signature row exists only when enabled');
  for (const bad of [undefined, null, 'true', 1]) assert.throws(() => createSellerEffectRoutes({ commitOnSignature: bad }), TypeError, `commitOnSignature ${bad}`);
  assert.throws(() => createSellerEffectRoutes(), TypeError);
  assert.ok(Object.isFrozen(SELLER_EFFECT_ROUTES) && Object.values(SELLER_EFFECT_ROUTES).every((route) => Object.isFrozen(route)), 'the table and its rows are frozen');
  assert.throws(() => { enabled[PATHS.payments] = enabled[PATHS.proposals]; }, TypeError);
  for (const path of [PATHS.state, PATHS.bundleBuyerCopy, PATHS.payments, PATHS.commitmentSignature, '/dacs/v1/context', `${PATHS.proposals}?x=1`, PATHS.proposals.toUpperCase()]) {
    assert.equal(enabled[path], undefined, `${path} has no row`);
  }
  for (const route of Object.values(enabled)) assert.deepEqual(Object.keys(route).sort(), ['endAfter', 'idempotenceKey', 'recover', 'revalidate', 'sink']);

  await t.test('only a completed replay of a table route is revalidated: reads never are', async () => {
    const w = await continuingWorld(t), revalidated = [];
    w.agent.revalidateCompletedAnswer = async (input) => { revalidated.push(input.path); };
    for (const path of [PATHS.state, PATHS.bundleBuyerCopy, PATHS.state, PATHS.bundleBuyerCopy]) assert.equal((await w.request(path)).status, 200, path);
    assert.deepEqual(revalidated, []);
    assert.equal((await w.request(PATHS.commitments)).status, 200, 'the commitment completes');
    assert.deepEqual(revalidated, [], 'a first answer is not a replay');
    assert.equal((await w.request(PATHS.commitments)).status, 200, 'the completed commitment replays');
    assert.equal((await w.request(PATHS.proposals)).status, 200, 'the completed proposal replays');
    assert.deepEqual(revalidated, [PATHS.commitments, PATHS.proposals]);
  });
});

test('the route table has one row per enabled non-context effect route and none for read routes; commitments/signature only when enabled', () => {
  const effectRoutes = [PATHS.proposals, PATHS.commitments, PATHS.bundleRequest, PATHS.bundleCountersignature];
  for (const commitOnSignature of [false, true]) {
    const routes = Object.keys(createSellerEffectRoutes({ commitOnSignature })).sort();
    assert.deepEqual(routes, [...effectRoutes, ...(commitOnSignature ? [PATHS.commitmentSignature] : [])].sort(), `commit-on-signature ${commitOnSignature}`);
    for (const read of [PATHS.state, PATHS.bundleBuyerCopy]) assert.equal(routes.includes(read), false, `${read} is a read`);
    for (const path of routes) assert.equal(WIRE_ROUTE_PATHS.includes(path), true, `${path} is a route of the wire`);
  }
  assert.equal(createSellerEffectRoutes({ commitOnSignature: false })[PATHS.commitmentSignature], undefined);
});

// A commitment route's answer in the stand-in world: `retains` says whether the agent holds commitment work for the job.
const commitmentJob = async (t, path, label) => {
  const w = await world(t, { leaseMs: SHORT_LEASE_MS }), job = await proposeJob(w, label);
  assert.equal((await job.post()).status, 200);
  const body = path === PATHS.commitmentSignature ? { jobId: job.jobId, agreement: {}, signedProjection: {} } : { jobId: job.jobId };
  return { w, job, request: () => w.post(path, body, { jobId: job.jobId, agreementHash: job.agreementHash }) };
};
const COMMITMENT_ROUTES = [PATHS.commitments, PATHS.commitmentSignature];

test('a commitment refused before its CREATE intent ends null; after the intent it is never ended null', async (t) => {
  for (const path of COMMITMENT_ROUTES) {
    const refusal = () => { throw new SellerAgentError('not_committed', 'TEST refused', 422); };
    const before = await commitmentJob(t, path, `c7-before-${path.length}`);
    before.w.agent.answer = refusal;
    assert.equal((await before.request()).body.error, 'not_committed');
    assert.equal(operationOf(before.w, before.job.jobId, path).state, 'ended', `${path}: no commitment work, so the refusal ends null`);
    const after = await commitmentJob(t, path, `c7-after-${path.length}`);
    after.w.agent.retains = true;
    after.w.agent.answer = refusal;
    assert.equal((await after.request()).body.error, 'not_committed');
    assert.equal(operationOf(after.w, after.job.jobId, path).state, 'pending', `${path}: retained commitment work keeps the attempt open`);
    const unknown = await commitmentJob(t, path, `c7-unknown-${path.length}`);
    unknown.w.agent.retainsCommitmentWork = () => { throw new Error('TEST retained state unreadable'); };
    unknown.w.agent.answer = refusal;
    await unknown.request();
    assert.equal(operationOf(unknown.w, unknown.job.jobId, path).state, 'pending', `${path}: unknown evidence keeps the attempt open`);
  }
});

test('NEW-D1b-slot-return', async (t) => {
  const w = await world(t);
  w.handle.wireOverrides = { capacity: { retainedAllocated: ({ route }) => COMMITMENT_ROUTES.includes(route) } };
  w.reopen();
  const slots = (jobId) => w.handle.capacity.capacityReport().allocations.find((allocation) => allocation.jobId === jobId).slots;
  for (const path of COMMITMENT_ROUTES) {
    const other = COMMITMENT_ROUTES.find((route) => route !== path);
    const cells = {};
    for (const name of ['completed', 'refused', 'open']) {
      const job = await proposeJob(w, `d1b-slot-${path.length}-${name}`);
      assert.equal((await job.post()).status, 200);
      sellerStoreInternals(w.handle.store).transaction(() => w.handle.capacity.allocateWithin({ jobId: job.jobId, buyer: BUYER.claim, seller: SELLER.claim, listingPin: PIN }));
      const body = path === PATHS.commitmentSignature ? { jobId: job.jobId, agreement: {}, signedProjection: {} } : { jobId: job.jobId };
      cells[name] = { job, post: () => w.post(path, body, { jobId: job.jobId, agreementHash: job.agreementHash }) };
    }
    const slotAfter = async (name, answer, retains = false) => {
      w.agent.retains = retains; w.agent.answer = answer;
      const before = slots(cells[name].job.jobId);
      await cells[name].post();
      const after = slots(cells[name].job.jobId);
      assert.deepEqual(after[other], before[other], `${path} ${name}: the other commitment route stays as it was`);
      assert.deepEqual(after[PATHS.proposals], before[PATHS.proposals], `${path} ${name}: the proposal slot stays as it was`);
      return after[path];
    };
    const refusal = () => { throw new SellerAgentError('not_committed', 'TEST refused', 422); };
    assert.deepEqual(await slotAfter('completed', undefined), { spent: 1, state: 'returned' }, `${path}: a completed commitment returns its own slot`);
    assert.notEqual((await slotAfter('refused', refusal)).state, 'returned', `${path}: a null end returns none`);
    assert.notEqual((await slotAfter('open', refusal, true)).state, 'returned', `${path}: an open attempt returns none`);
    const settled = slots(cells.completed.job.jobId)[path], recorded = completions(w).length;
    for (const restart of [false, true]) {
      if (restart) w.reopen();
      w.agent.answer = undefined;
      assert.equal((await cells.completed.post()).status, 200, 'the replay answers the stored outcome');
      assert.deepEqual(slots(cells.completed.job.jobId)[path], settled, `${path}: a replay returns no slot, restart ${restart}`);
      assert.equal(completions(w).length, recorded, `${path}: a replay records no completion, restart ${restart}`);
    }
  }
  const disabled = await world(t, { commitOnSignature: false });
  disabled.handle.wireOverrides = { capacity: { retainedAllocated: ({ route }) => COMMITMENT_ROUTES.includes(route) } };
  disabled.reopen();
  const job = await proposeJob(disabled, 'd1b-slot-disabled');
  assert.equal((await job.post()).status, 200);
  sellerStoreInternals(disabled.handle.store).transaction(() => disabled.handle.capacity.allocateWithin({ jobId: job.jobId, buyer: BUYER.claim, seller: SELLER.claim, listingPin: PIN }));
  assert.equal(disabled.handle.capacity.capacityReport().allocations.find((allocation) => allocation.jobId === job.jobId).slots[PATHS.commitmentSignature], undefined, 'no signature slot when the route is disabled');
  const refused = await disabled.post(PATHS.commitmentSignature, { jobId: job.jobId, agreement: {}, signedProjection: {} }, { jobId: job.jobId, agreementHash: job.agreementHash });
  assert.notEqual(refused.status, 200, 'the disabled route answers nothing');
  assert.deepEqual(completions(disabled).filter((row) => row.route === PATHS.commitmentSignature), [], 'and records no completion');
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
  // An agent that cannot say what it retains is never read as retaining nothing.
  for (const retainsProposalWork of [() => { throw new Error('TEST retained state unreadable'); }, undefined]) {
    const w = await world(t), job = await proposeJob(w, `r4-unknown-${retainsProposalWork === undefined}`);
    w.agent.retainsProposalWork = retainsProposalWork;
    w.agent.answer = () => ({ disposition: 'waiting', stage: 'lease', reason: 'TEST' });
    await job.post();
    assert.equal(operationOf(w, job.jobId, PATHS.proposals).state, 'pending', 'unknown evidence keeps the attempt open');
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
    for (const path of [PATHS.payments, PATHS.state, PATHS.bundleRequest]) {
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

  for (const early of [false, true]) await t.test(`commitment cells, ${early ? 'commitments/signature' : 'commitments'}: every retained item and source state fails alone with its cause`, async (st) => {
    const c = await completedCommitment(t, early), settled = commitmentSnapshot(c), anchor = c.fixture.config.nativeArtifactAnchor, read = anchor.readRetained;
    assert.equal(await commitmentRevalidation(c), undefined, 'the valid control passes');
    const failsWith = async (cause, cell, restore) => {
      try { assert.equal(await sourceFailure(commitmentRevalidation(c)), cause, cell); } finally { restore(); }
      assert.deepEqual(commitmentSnapshot(c), settled, `${cell}: nothing was written, signed or sent`);
    };
    const stored = (change) => { const row = c.fixture.rows.get(c.address), original = structuredClone(row); change(row); return () => c.fixture.rows.set(c.address, original); };
    const tampered = {
      'record changed': ['changed', (row) => { row.artifact = { ...row.artifact, agreementHash: derive('another agreement') }; }],
      'canonical address changed': ['changed', (row) => { row.receipt = { ...row.receipt, logicalAddress: `${row.receipt.logicalAddress}-other` }; }],
      'receipt content changed': ['changed', (row) => { row.receipt = { ...row.receipt, contentHash: derive('another record') }; }],
      ...(early ? {} : {
        'transaction ref changed': ['changed', (row) => { row.txRef = { ...row.txRef, txHash: derive('another transaction') }; }],
        'receipt block id changed': ['changed', (row) => { row.receipt = { ...row.receipt, blockRef: { ...row.receipt.blockRef, id: derive('another block') } }; }],
        'receipt block timestamp changed': ['changed', (row) => { row.receipt = { ...row.receipt, blockRef: { ...row.receipt.blockRef, timestamp: row.receipt.blockRef.timestamp + 1 } }; }],
      }),
    };
    for (const [cell, [cause, change]] of Object.entries(tampered)) await failsWith(cause, cell, stored(change));
    const answers = {
      'source absent': ['absent', async () => ({ status: 'absent' })],
      'source indeterminate': ['unavailable', async () => ({ status: 'indeterminate', reason: 'TEST source unavailable' })],
      'source rejected': ['changed', async () => ({ status: 'rejected', reason: 'TEST source rejected the record' })],
      'source reader fails': ['unavailable', async () => { throw new Error('TEST source reader failed'); }],
      'source reply over 64 KiB': ['too_large', async (...args) => ({ ...(await read(...args)), padding: 'x'.repeat(ADMISSION_READ_MAX_BYTES + 1) })],
    };
    for (const [cell, [cause, answer]] of Object.entries(answers)) {
      anchor.readRetained = answer;
      await failsWith(cause, cell, () => { anchor.readRetained = read; });
    }
    st.mock.timers.enable({ apis: ['setTimeout'] });
    anchor.readRetained = () => new Promise(() => {});
    try {
      const failing = sourceFailure(commitmentRevalidation(c));
      await new Promise(setImmediate);
      st.mock.timers.tick(ADMISSION_READ_TIMEOUT_MS);
      assert.equal(await failing, 'timeout', 'a read that stalls stops at 10 s');
    } finally { anchor.readRetained = read; }
    assert.deepEqual(commitmentSnapshot(c), settled);
    const restore = stored((row) => { row.receipt = { ...row.receipt, observedAt: row.receipt.observedAt + 5000 }; });
    try { assert.equal(await commitmentRevalidation(c), undefined, 'a receipt only observed later is the same evidence'); } finally { restore(); }
    for (const other of [{ ...c.outcome, text: 'not json' }, { ...c.outcome, text: JSON.stringify({ ...JSON.parse(c.outcome.text), address: `${c.address}-other` }) }, { ...c.outcome, text: JSON.stringify({ status: 'held', address: c.address }) }]) {
      assert.equal(await sourceFailure(commitmentRevalidation(c, other)), 'changed', 'the stored answer must be the retained commitment');
    }
    for (const [change, cause] of [[(session) => { delete session[early ? 'signatureCommitmentHeld' : 'commitment']; }, 'absent']]) {
      const edited = await completedCommitment(t, early);
      await editSession(edited.fixture, edited.jobId, change);
      assert.equal(await sourceFailure(commitmentRevalidation(edited)), cause, 'the retained commitment is missing');
    }
    assert.deepEqual(commitmentSnapshot(c), settled);
  });

  for (const early of [false, true]) await t.test(`commitment cells on the wire, ${early ? 'commitments/signature' : 'commitments'}: a valid replay answers the stored bytes, an unavailable source is a signed 503 with its cause`, async () => {
    const c = await completedCommitment(t, early), anchor = c.fixture.config.nativeArtifactAnchor, read = anchor.readRetained, settled = commitmentSnapshot(c);
    const signatures = c.signing.calls, valid = await c.commitmentRequest();
    assert.deepEqual([valid.status, valid.text, c.signing.calls], [c.first.status, c.first.text, signatures + 1], 'the stored status and text, one response signature');
    anchor.readRetained = async () => { throw new Error('TEST source unavailable'); };
    try {
      const refused = await c.commitmentRequest();
      assert.deepEqual({ status: refused.status, signed: refused.signed, error: refused.body.error, cause: refused.body.cause }, { status: 503, signed: true, error: 'seller_source_unavailable', cause: 'unavailable' });
    } finally { anchor.readRetained = read; }
    assert.equal(operationOf(c, c.jobId, c.commitmentPath).state, 'completed');
    assert.equal((await c.commitmentRequest()).text, c.first.text, 'the stored outcome was not rewritten');
    assert.deepEqual(commitmentSnapshot(c), settled);
  });
});

// The completed commitment (or early commitment) over a real durable agent, with its stored answer.
const completedCommitment = async (t, early) => {
  const w = await realWorld(t, { early });
  assert.equal((await w.request(PATHS.proposals)).status, 200, 'the host admits the job through its proposal');
  // The agent committed this job before the host started, so the host holds its retained Agreement from here on.
  w.agent.transportAgreementOf = (jobId) => w.fixture.agent().transportAgreementOf(jobId);
  const first = await w.commitmentRequest();
  assert.equal(first.status, 200, first.text);
  const address = JSON.parse(first.text).address;
  return { ...w, first, address, outcome: { status: first.status, text: first.text } };
};
const commitmentSnapshot = (w) => ({ ...snapshot(w), rows: JSON.stringify([...w.fixture.rows]) });
const commitmentRevalidation = (w, outcome = w.outcome) => w.fixture.agent().revalidateCompletedAnswer({ path: w.commitmentPath, jobId: w.jobId, outcome });

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

test('an early commitment completed before the buyer\'s Agreement anchor exists revalidates from the retained commitment alone; a changed or unreadable commitment answers 503 seller_source_unavailable', async (t) => {
  const c = await completedCommitment(t, true), anchor = c.fixture.config.nativeArtifactAnchor, read = anchor.readRetained;
  let agreementReads = 0;
  c.fixture.controls.agreement = null;
  c.fixture.controls.read = () => { agreementReads++; return { disposition: 'absent' }; };
  const settled = commitmentSnapshot(c);
  assert.equal(await commitmentRevalidation(c), undefined, 'no buyer Agreement anchor is needed');
  const replayed = await c.commitmentRequest();
  assert.deepEqual([replayed.status, replayed.text], [c.first.status, c.first.text], 'the replay answers the stored bytes');
  assert.equal(agreementReads, 0, 'the buyer Agreement was never read');
  const row = structuredClone(c.fixture.rows.get(c.address));
  c.fixture.rows.set(c.address, { ...row, artifact: { ...row.artifact, agreementHash: derive('another agreement') } });
  const changed = await c.commitmentRequest();
  assert.deepEqual({ status: changed.status, error: changed.body.error, cause: changed.body.cause }, { status: 503, error: 'seller_source_unavailable', cause: 'changed' });
  c.fixture.rows.set(c.address, row);
  anchor.readRetained = async () => { throw new Error('TEST commitment unreadable'); };
  try {
    const unreadable = await c.commitmentRequest();
    assert.deepEqual({ status: unreadable.status, error: unreadable.body.error, cause: unreadable.body.cause }, { status: 503, error: 'seller_source_unavailable', cause: 'unavailable' });
  } finally { anchor.readRetained = read; }
  assert.equal(agreementReads, 0);
  assert.deepEqual(commitmentSnapshot(c), settled, 'durable state, anchor rows and the outcome are unchanged');
  assert.equal((await c.commitmentRequest()).text, c.first.text);
});

test('native passive read and readRetained never recover a pending accepted CREATE, including completed proposal and commitment checks and a closed attempt', async (t) => {
  for (const early of [false, true]) {
    const c = await completedCommitment(t, early), anchor = c.fixture.config.nativeArtifactAnchor, read = anchor.readRetained, publish = anchor.publish, optionsSeen = [];
    const publications = c.fixture.publications.length, signed = c.fixture.signed.length;
    anchor.readRetained = async (input, options) => { optionsSeen.push(options); return { status: 'indeterminate', reason: 'the accepted CREATE is not yet included' }; };
    anchor.publish = async () => assert.fail('a completed-answer check never publishes');
    const replay = async (cell) => {
      const answered = await c.commitmentRequest();
      assert.deepEqual({ status: answered.status, error: answered.body.error, cause: answered.body.cause }, { status: 503, error: 'seller_source_unavailable', cause: 'unavailable' }, cell);
    };
    await replay('immediately');
    await replay('a second time');
    await c.fixture.reopen();
    c.reopen();
    await replay('after a restart');
    assert.equal(operationOf(c, c.jobId, c.commitmentPath).state, 'completed', 'the closed attempt stays completed');
    assert.ok(optionsSeen.length >= 3 && optionsSeen.every((options) => options?.resend === false), 'every read was passive');
    assert.deepEqual([c.fixture.publications.length, c.fixture.signed.length], [publications, signed], 'nothing was published or signed');
    anchor.readRetained = read;
    anchor.publish = publish;
    assert.equal((await c.commitmentRequest()).status, 200, 'restored authentic inclusion permits the replay again');
  }
});
