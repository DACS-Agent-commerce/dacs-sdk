import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { shutdownClock } from './helpers/shutdown-clock.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

// A detached Agreement plan (it answered 202 and keeps waiting for the
// seller's Vet approval) is admitted work: the owned stop drains it within the
// app grace, then ends its approval wait, undecided, before the source closes.
// Nothing of it runs or writes after that, and no lane row of it is left for
// the next start.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const vetCreates = h => h.node2.chain.wire.record.accepted.filter(tx => tx.content?.data?.[1]?.metadata?.artifactKind === 'CompositeVerificationRecord').length;
// Whether the source still admits work: a malformed binding request then fails
// its own validation (invalid_params, nothing is read or sent). Once the
// source's close has started it is refused as transport_closed.
const sourceAdmits = h => h.prepared.devnetAgreementTransport.binding(null).then(() => 'answered', error => error.code);

// Starts a purchase whose plan answers 202 while its seller Vet approval waits.
// The shutdown clock's beforeSourceClose hook marks the source's close itself:
// the operator calls it as the source starts closing, before anything after it.
// The hook also proves that position: the source still admits work when it runs.
async function waitingPlan(t, signature) {
  const previous = process.env.DACS_COMMIT_ON_SIGNATURE;
  process.env.DACS_COMMIT_ON_SIGNATURE = signature;
  t.after(() => { if (previous === undefined) delete process.env.DACS_COMMIT_ON_SIGNATURE; else process.env.DACS_COMMIT_ON_SIGNATURE = previous; });
  const clock = shutdownClock({ graceMs: 30, laneMs: 100, autoLanes: true });
  const approval = deferred(), prompted = deferred(), events = [], s = { events, sourceClosed: false, sourceCloses: 0, atSourceClose: null, observe: () => {} };
  clock.beforeSourceClose = () => { s.sourceCloses++; s.observe(); s.sourceClosed = true; };
  // Records every artifact journal write and lane release the seller's anchor
  // makes, and whether the source had closed by then.
  const wrapPublicJournal = journal => ({ ...journal,
    put: async (key, value) => { events.push({ what: `put:${value?.stage ?? 'record'}`, afterSource: s.sourceClosed }); return journal.put(key, value); },
    withWalletLock: (key, work) => journal.withWalletLock(key, async () => { try { return await work(); } finally { events.push({ what: 'release', afterSource: s.sourceClosed }); } }) });
  const h = await startOperatorPurchaseNode2({ authorizeBuyerApproval: () => true, shutdownTimer: clock, wrapPublicJournal,
    authorizeSellerApproval: ({ request, approvalHash }) => {
      if (request.content?.artifactKind === 'CompositeVerificationRecord') { s.vetApprovalHash = approvalHash; prompted.resolve(); return approval.promise; }
      return true;
    } });
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    approval.resolve(false);
    for (const stop of [() => h.operator.close(), () => h.node2.close()]) await Promise.resolve().then(stop).catch(() => {});
    await rm(h.root, { recursive: true, force: true });
  });
  const responseSeen = deferred(), buyerStopped = new Error('TEST buyer stops after the plan response');
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (new URL(url).pathname.endsWith('/agreement/plan')) { assert.equal(response.status, 202); responseSeen.resolve(); throw buyerStopped; }
    return response;
  };
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: `owned-stop-plan-${signature}` })
    .then(value => ({ value }), error => ({ error }));
  await prompted.promise; await responseSeen.promise;
  assert.equal((await purchase).error, buyerStopped);
  globalThis.fetch = originalFetch;
  const { id, account_id: accountId } = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind = 'purchase'").get();
  const protocol = h.application.services.protocol, ops = h.application.services.ops, operation = ops.get(accountId, id);
  assert.equal(protocol.planRunning(operation), true, 'the plan runs detached from its answered request');
  const vetStore = h.prepared.composition.partyVetStore;
  s.observe = () => {
    let vetStoreOpen = true;
    try { vetStore.usage(); } catch (error) { assert.equal(error.code, 'journal-closed'); vetStoreOpen = false; }
    s.atSourceClose = { planRunning: protocol.planRunning(operation), planned: Boolean(ops.get(accountId, id).state.protocol.planned), vetStoreOpen };
    s.sourceAtHook = sourceAdmits(h);
  };
  return { h, clock, approval, s, protocol, operation };
}

for (const signature of ['off', 'on']) {
  test(`switch ${signature}: a plan waiting for seller approval at shutdown ends before the source closes and leaves no lane row`, { timeout: 180000 }, async t => {
    const { h, clock, approval, s, protocol, operation } = await waitingPlan(t, signature);
    const evidence = join(h.config.stateDirectory, 'evidence', 'seller-approvals.jsonl'), before = s.events.length;
    const closing = h.operator.close().then(() => ({}), error => ({ error }));
    // The app grace ends while the plan still waits for its approval.
    await clock.advance(30);
    const closed = await closing;
    assert.equal(closed.error, undefined, `the stop completes: ${closed.error?.stack ?? ''}`);
    assert.equal(s.sourceCloses, 1);
    assert.equal(await s.sourceAtHook, 'invalid_params', 'the hook ran while the source still admitted work');
    assert.equal(await sourceAdmits(h), 'transport_closed', 'the source refuses work after the stop');
    assert.deepEqual(s.atSourceClose, { planRunning: false, planned: false, vetStoreOpen: false }, 'the plan ended, unplanned, and the Vet store closed before the source');
    assert.equal(protocol.planRunning(operation), false);
    const unwound = s.events.slice(before);
    assert.ok(unwound.some(event => event.what === 'release'), 'the plan released its artifact lane');
    assert.ok(unwound.some(event => event.what === 'put:closing'), 'the cut Vet intent stays askable');
    assert.ok(!unwound.some(event => event.what === 'put:denied'), 'the cut never denies the Vet intent');
    assert.deepEqual(unwound.filter(event => event.afterSource), [], 'the plan writes nothing to the artifact journal after the source closes');
    // The next start sees no lane row of this run.
    const next = openDurableWalletJournal({ path: join(h.config.stateDirectory, 'seller-artifacts.sqlite'), mode: 'open' });
    try { assert.deepEqual(next.inspectLocks(), []); } finally { next.close(); }

    // The cut is not a decision: no evidence line for the stopped approval and
    // no rejected line. A late answer changes nothing: no evidence line,
    // journal write or CREATE.
    const evidenceBefore = await readFile(evidence, 'utf8'), after = s.events.length;
    const lines = evidenceBefore.trim().split('\n').map(JSON.parse);
    assert.match(s.vetApprovalHash ?? '', /^[0-9a-f]{64}$/);
    assert.deepEqual(lines.filter(line => line.approvalHash === s.vetApprovalHash), [], 'the stopped approval is recorded as no decision');
    assert.deepEqual(lines.filter(line => line.decision === 'rejected'), [], 'the stop writes no rejected line');
    approval.resolve(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await readFile(evidence, 'utf8'), evidenceBefore);
    assert.equal(s.events.length, after);
    assert.equal(vetCreates(h), 0);
  });

  test(`switch ${signature}: a plan approved within the grace is drained to its saved plan before the source closes`, { timeout: 180000 }, async t => {
    const { h, clock, approval, s, protocol, operation } = await waitingPlan(t, signature);
    const closing = h.operator.close().then(() => ({}), error => ({ error }));
    await clock.waiting(30);
    // Approved during the grace: the drain waits for the plan, so the grace is never advanced.
    approval.resolve(true);
    const closed = await closing;
    assert.equal(closed.error, undefined, `the stop completes: ${closed.error?.stack ?? ''}`);
    assert.equal(s.sourceCloses, 1);
    assert.equal(await s.sourceAtHook, 'invalid_params', 'the hook ran while the source still admitted work');
    assert.equal(await sourceAdmits(h), 'transport_closed', 'the source refuses work after the stop');
    assert.deepEqual(s.atSourceClose, { planRunning: false, planned: true, vetStoreOpen: false });
    assert.equal(protocol.planRunning(operation), false);
    assert.ok(vetCreates(h) > 0, 'the approved Vet was sent while the source was open');
    assert.deepEqual(s.events.filter(event => event.afterSource), []);
  });
}
