import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { failOnLeftoverListeners } from './helpers/listener-guard.mjs';
import { createLoopbackTestTlsMaterial } from './helpers/loopback-test-tls.mjs';
import { shutdownClock } from './helpers/shutdown-clock.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

// The owned stop's approval cut comes after two waits with no bound of their
// own: a delivery-evidence resume pass, and with the switch on an admitted
// seller request. Both run inside the seller's durable withJob(), which holds
// the job's seller-state.sqlite seller_locks row. The approval deadline starts
// when close() starts, so a manual approval waiting inside either ends at that
// deadline, exactly as at the cut. The cut is not a decision: nothing is
// recorded, signed or sent, the artifact intent stays retained as 'closing'
// (askable, never denied), and the job lock and lane locks are released before
// close returns. The next start asks again and the write lands once.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
const sellerLocks = h => {
  const db = new DatabaseSync(join(h.config.stateDirectory, 'seller-state', 'seller-state.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT job, pid FROM seller_locks ORDER BY job').all().map(row => ({ job: row.job, pid: row.pid })); } finally { db.close(); }
};
// Read after close, from the journal files the next start would open.
async function journalState(h, file) {
  const journal = openDurableWalletJournal({ path: join(h.config.stateDirectory, file), mode: 'open' });
  try { return { locks: journal.inspectLocks(), entries: await journal.entries() }; } finally { journal.close(); }
}
// Every confirmTx/broadcastTx that reaches Node2: a signed transaction is needed for either.
function observeSends() {
  const sent = [];
  return { sent, rpcFault: async ({ body }) => {
    const call = body?.params?.[0];
    if (body?.method === 'execute' && ['confirmTx', 'broadcastTx'].includes(call?.extra)) sent.push(JSON.stringify(call));
    return null;
  } };
}
// The shutdown clock: the deadline sleep starts with close and fires only when advanced.
async function closeUntilDeadline(h, clock) {
  let settled = false;
  const closing = h.operator.close().then(() => ({}), error => ({ error })).finally(() => { settled = true; });
  await bounded(clock.waiting(clock.approvalMs), 10000, 'the approval deadline did not start when close started');
  return { closing, settled: () => settled };
}
const approvalLines = async h => {
  try { return (await readFile(join(h.config.stateDirectory, 'evidence', 'seller-approvals.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const linesFor = (lines, address) => lines.filter(line => JSON.parse(line.requestBytes ?? 'null')?.content?.logicalAddress === address);
// What the cut leaves: no decision is recorded for the request (no line for
// it, and no rejected line at all), nothing for its address is signed or sent,
// its artifact intent is retained as 'closing', not denied, and no job or lane
// lock of this run remains for the next start.
async function assertCutAtDeadline(h, { approvalHash, request }, observed) {
  const address = request.content.logicalAddress;
  const evidence = await approvalLines(h);
  assert.deepEqual(evidence.filter(line => line.approvalHash === approvalHash), [], 'the cut approval is recorded as no decision at all');
  assert.deepEqual(evidence.filter(line => line.decision === 'rejected').map(line => line.approvalHash), [], 'the cut writes no rejected line');
  assert.deepEqual(observed.sent.filter(text => text.includes(address)), [], 'nothing for this address was signed for or sent to Node2');
  assert.equal(h.node2.chain.wire.record.accepted.filter(tx => tx.content?.data?.[1]?.metadata?.logicalAddress === address).length, 0);
  const artifacts = await journalState(h, 'seller-artifacts.sqlite');
  const retained = artifacts.entries.filter(([, value]) => value?.input?.logicalAddress === address);
  assert.equal(retained.length, 1, 'the artifact intent is retained');
  assert.equal(retained[0][1].stage, 'closing', JSON.stringify(retained[0][1]).slice(0, 400));
  assert.equal(retained[0][1].error, 'operator_closing');
  assert.equal(retained[0][1].hash, undefined, 'no transaction hash was issued');
  for (const file of ['seller-artifacts.sqlite', 'seller-wallet.sqlite', 'node2-transport.sqlite']) {
    const state = file === 'seller-artifacts.sqlite' ? artifacts : await journalState(h, file);
    assert.deepEqual(state.locks, [], `${file}: no lane lock is left`);
    assert.deepEqual(state.entries.filter(([, value]) => value?.signedTransaction && JSON.stringify(value.signedTransaction).includes(address)), [], `${file}: no signed transaction for this address`);
  }
  assert.deepEqual(sellerLocks(h), [], 'the seller-state job lock was released before close returned');
}
function cleanup(t, h, answer) {
  t.after(async () => {
    answer.resolve(false);
    if (!await h.close().then(() => true, () => false)) {
      for (const stop of [() => h.operator?.close?.(), () => h.node2.close()]) await Promise.resolve().then(stop).catch(() => {});
      await rm(h.root, { recursive: true, force: true });
    }
    await failOnLeftoverListeners();
  });
}

// The first delivery evidence intent write fails before the wallet is asked,
// so the purchase ends delivery-ready with its evidence held for a resume pass.
function failEvidenceIntentOnce() {
  const state = { fired: 0 };
  state.wrap = journal => new Proxy(journal, { get(target, key) {
    if (key === 'put') return async (k, v) => {
      if (!state.fired && v?.stage === 'intent' && v.input?.artifactKind === 'SettlementEvidence') { state.fired++; throw Object.assign(new Error('TEST evidence intent write failed before the CREATE was sent'), { code: 'TEST-journal-unavailable' }); }
      return target.put(k, v);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return state;
}
// Replaces the 5-minute evidence resume interval, which then never runs; the
// test starts the one pass itself (resumeHeldDeliveryEvidence) for its results.
const manualTimer = () => ({ every: (run, ms) => ({ run, ms }), cancel: () => {} });

test('an approval waiting inside a delivery-evidence resume pass when close starts ends undecided at the approval deadline', { timeout: 300000 }, async t => {
  const fault = failEvidenceIntentOnce(), timer = manualTimer(), observed = observeSends(), answer = deferred(), waiting = deferred();
  const clock = shutdownClock({ graceMs: 30, laneMs: 100, autoLanes: true });
  let holdEvidence = false;
  const h = await startOperatorPurchaseNode2({ tlsFixture: createLoopbackTestTlsMaterial(), sellerDeliveryEvidence: { enabled: true }, wrapPublicJournal: fault.wrap, evidenceResumeTimer: timer,
    rpcFault: observed.rpcFault, shutdownTimer: clock, authorizeBuyerApproval: () => true,
    authorizeSellerApproval: ({ request, approvalHash }) => {
      if (holdEvidence && request.content?.artifactKind === 'SettlementEvidence') { waiting.resolve({ request, approvalHash }); return answer.promise; }
      return true;
    } });
  cleanup(t, h, answer);
  const result = await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'approval-deadline-evidence-pass' });
  assert.equal(fault.fired, 1);
  assert.equal(result.status, 'delivery-ready', 'the evidence is held for a resume pass');
  holdEvidence = true;
  const pass = h.operator.resumeHeldDeliveryEvidence().then(value => ({ value }), error => ({ error }));
  const asked = await bounded(waiting.promise, 120000, 'the resume pass never asked for the evidence approval');
  assert.equal(asked.request.content.logicalAddress, `dacs4:evidence:${result.jobId}`);
  assert.deepEqual(sellerLocks(h), [{ job: result.jobId, pid: process.pid }], 'the pass waits for its approval inside the job lock');

  const { closing, settled } = await closeUntilDeadline(h, clock);
  // Close is still waiting for the pass: the request drain has not started.
  assert.equal(await Promise.race([clock.waiting(clock.graceMs).then(() => 'request drain started'), sleep(500).then(() => 'waiting for the pass')]), 'waiting for the pass');
  assert.equal(settled(), false);
  assert.deepEqual(sellerLocks(h), [{ job: result.jobId, pid: process.pid }]);
  await clock.advance(clock.approvalMs);
  const closed = await bounded(closing, 60000, 'close did not finish after the approval deadline');
  assert.equal(closed.error, undefined, String(closed.error?.stack ?? closed.error));
  const ended = await bounded(pass, 10000, 'the pass did not end');
  assert.equal(ended.error, undefined, String(ended.error?.stack ?? ended.error));
  assert.equal(ended.value.length, 1, JSON.stringify(ended.value));
  assert.equal(ended.value[0].jobId, result.jobId);
  await assertCutAtDeadline(h, asked, observed);

  // A late answer changes nothing.
  const evidenceBefore = await readFile(join(h.config.stateDirectory, 'evidence', 'seller-approvals.jsonl'), 'utf8'), sentBefore = observed.sent.length;
  answer.resolve(true);
  await sleep(500);
  assert.equal(await readFile(join(h.config.stateDirectory, 'evidence', 'seller-approvals.jsonl'), 'utf8'), evidenceBefore);
  assert.equal(observed.sent.length, sentBefore);
});

// The same, with no test clock: the operator's own fixed 15 s timer ends the approval.
test('without a test clock, the production deadline ends an approval waiting inside a resume pass about 15 s after close starts', { timeout: 300000 }, async t => {
  const fault = failEvidenceIntentOnce(), observed = observeSends(), answer = deferred(), waiting = deferred();
  let holdEvidence = false;
  const h = await startOperatorPurchaseNode2({ tlsFixture: createLoopbackTestTlsMaterial(), sellerDeliveryEvidence: { enabled: true }, wrapPublicJournal: fault.wrap, evidenceResumeTimer: manualTimer(),
    rpcFault: observed.rpcFault, authorizeBuyerApproval: () => true,
    authorizeSellerApproval: ({ request, approvalHash }) => {
      if (holdEvidence && request.content?.artifactKind === 'SettlementEvidence') { waiting.resolve({ request, approvalHash }); return answer.promise; }
      return true;
    } });
  cleanup(t, h, answer);
  const result = await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'approval-deadline-production-timer' });
  assert.equal(result.status, 'delivery-ready');
  holdEvidence = true;
  const pass = h.operator.resumeHeldDeliveryEvidence().then(value => ({ value }), error => ({ error }));
  const asked = await bounded(waiting.promise, 120000, 'the resume pass never asked for the evidence approval');
  const started = Date.now();
  const closed = await bounded(h.operator.close().then(() => ({}), error => ({ error })), 60000, 'close did not finish after the production deadline');
  const elapsed = Date.now() - started;
  assert.equal(closed.error, undefined, String(closed.error?.stack ?? closed.error));
  assert.ok(elapsed >= 14000 && elapsed < 30000, `close waited ${elapsed} ms for the 15 s deadline`);
  assert.equal((await bounded(pass, 10000, 'the pass did not end')).error, undefined);
  await assertCutAtDeadline(h, asked, observed);
});

// With the switch on, admitted seller requests are awaited until they end,
// after the app grace. Here the grace is advanced first, so close is in that
// wait when the deadline fires; in production the 15 s deadline comes before
// the 30 s grace ends. An approval first asked after close started has its
// own 15 s from when it is asked (commit-on-signature-operator pins that one
// asked after the deadline is still asked).
test('switch on: an approval waiting inside an admitted seller request ends undecided at the approval deadline, in the seller wait after the app grace', { timeout: 300000 }, async t => {
  const previous = process.env.DACS_COMMIT_ON_SIGNATURE;
  process.env.DACS_COMMIT_ON_SIGNATURE = 'on';
  t.after(() => { if (previous === undefined) delete process.env.DACS_COMMIT_ON_SIGNATURE; else process.env.DACS_COMMIT_ON_SIGNATURE = previous; });
  const observed = observeSends(), answer = deferred(), waiting = deferred();
  // The buyer's app work cut at the grace unwinds its lanes within the lane wait.
  const clock = shutdownClock({ graceMs: 30, laneMs: 10000, autoLanes: true });
  const h = await startOperatorPurchaseNode2({ rpcFault: observed.rpcFault, shutdownTimer: clock, authorizeBuyerApproval: () => true,
    authorizeSellerApproval: ({ request, approvalHash }) => {
      if (request.content?.artifactKind === 'FinalityCommitmentRecord') { waiting.resolve({ request, approvalHash }); return answer.promise; }
      return true;
    } });
  cleanup(t, h, answer);
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'approval-deadline-seller-request' }).then(value => ({ value }), error => ({ error }));
  const asked = await bounded(waiting.promise, 180000, 'the seller commitment approval was never asked');
  const jobId = asked.request.content.jobId;
  assert.deepEqual(sellerLocks(h), [{ job: jobId, pid: process.pid }], 'the seller request waits for its approval inside the job lock');

  const { closing, settled } = await closeUntilDeadline(h, clock);
  await bounded(clock.waiting(clock.graceMs), 10000, 'the request drain never started its grace');
  await clock.advance(clock.graceMs);
  await sleep(500);
  assert.equal(settled(), false, 'close waits for the admitted seller request after the app grace');
  assert.deepEqual(sellerLocks(h), [{ job: jobId, pid: process.pid }]);
  await clock.advance(clock.approvalMs);
  const closed = await bounded(closing, 60000, 'close did not finish after the approval deadline');
  assert.equal(closed.error, undefined, String(closed.error?.stack ?? closed.error));
  await bounded(purchase, 60000, 'the buyer did not finish after the stop');
  await assertCutAtDeadline(h, asked, observed);
});

// After the cut, the next start asks again. The operator approves this time,
// and the write lands exactly once: a paid purchase is not stranded.
const accepted = (h, address) => h.node2.chain.wire.record.accepted.filter(tx => tx.content?.data?.[1]?.metadata?.logicalAddress === address);
const accountOf = (h, operationId) => h.application.db.prepare('SELECT account_id FROM operations WHERE id = ?').get(operationId).account_id;

test('a delivery-evidence approval cut at the approval deadline is asked again after a restart, and the paid purchase reaches delivered', { timeout: 300000 }, async t => {
  const fault = failEvidenceIntentOnce(), timer = manualTimer(), observed = observeSends(), answer = deferred(), waiting = deferred();
  const clock = shutdownClock({ graceMs: 30, laneMs: 100, autoLanes: true });
  let holdEvidence = false;
  const asks = [];
  const h = await startOperatorPurchaseNode2({ tlsFixture: createLoopbackTestTlsMaterial(), sellerDeliveryEvidence: { enabled: true }, wrapPublicJournal: fault.wrap, evidenceResumeTimer: timer,
    rpcFault: observed.rpcFault, shutdownTimer: clock, authorizeBuyerApproval: () => true,
    authorizeSellerApproval: ({ request, approvalHash }) => {
      if (String(request.content?.logicalAddress).startsWith('dacs4:evidence:')) asks.push(approvalHash);
      if (holdEvidence && request.content?.artifactKind === 'SettlementEvidence') { waiting.resolve({ request, approvalHash }); return answer.promise; }
      return true;
    } });
  cleanup(t, h, answer);
  const result = await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'approval-deadline-evidence-restart' });
  assert.equal(result.status, 'delivery-ready');
  const address = `dacs4:evidence:${result.jobId}`;
  holdEvidence = true;
  const pass = h.operator.resumeHeldDeliveryEvidence().then(value => ({ value }), error => ({ error }));
  const asked = await bounded(waiting.promise, 120000, 'the resume pass never asked for the evidence approval');
  const { closing } = await closeUntilDeadline(h, clock);
  await clock.advance(clock.approvalMs);
  assert.equal((await bounded(closing, 60000, 'close did not finish after the approval deadline')).error, undefined);
  await bounded(pass, 10000, 'the pass did not end');
  await assertCutAtDeadline(h, asked, observed);

  // The next start's own pass asks again; the operator approves.
  holdEvidence = false;
  await h.restart();
  assert.deepEqual(await bounded(h.operator.resumeHeldDeliveryEvidence(), 120000, 'the restarted pass did not end'), [{ jobId: result.jobId, status: 'delivered' }]);
  assert.equal(asks.length, 2, 'asked once before the cut and once after the restart');
  assert.notEqual(asks[1], asks[0], 'the new ask is a fresh unsigned request');
  assert.equal(accepted(h, address).length, 1, 'exactly one evidence CREATE');
  const lines = linesFor(await approvalLines(h), address);
  assert.deepEqual(lines.map(line => [line.approvalHash, line.decision]), [[asks[1], 'approved']], 'only the new ask is recorded, as approved');
  const artifacts = await journalState(h, 'seller-artifacts.sqlite');
  assert.deepEqual(artifacts.entries.filter(([, value]) => value?.input?.logicalAddress === address).map(([, value]) => value.stage), ['verified']);
  await h.application.services.purchases.verifyDeal({ accountId: accountOf(h, result.operationId), operationId: result.operationId });
  const protocol = h.application.services.purchases.status(accountOf(h, result.operationId), result.operationId).protocol;
  assert.equal(protocol.stage, 'delivered');
  assert.equal(protocol.delivery.evidencePublication, 'native-read-back');
  // A later pass has nothing to resume, and nothing is sent again.
  assert.deepEqual(await h.operator.resumeHeldDeliveryEvidence(), []);
  assert.equal(accepted(h, address).length, 1);
});

test('switch on: a seller commitment approval cut at the approval deadline is asked again after a restart and lands exactly once', { timeout: 300000 }, async t => {
  const previous = process.env.DACS_COMMIT_ON_SIGNATURE;
  process.env.DACS_COMMIT_ON_SIGNATURE = 'on';
  t.after(() => { if (previous === undefined) delete process.env.DACS_COMMIT_ON_SIGNATURE; else process.env.DACS_COMMIT_ON_SIGNATURE = previous; });
  const observed = observeSends(), answer = deferred(), waiting = deferred();
  const clock = shutdownClock({ graceMs: 30, laneMs: 10000, autoLanes: true });
  let holdCommitment = true;
  const asks = [];
  const h = await startOperatorPurchaseNode2({ rpcFault: observed.rpcFault, shutdownTimer: clock, authorizeBuyerApproval: () => true,
    authorizeSellerApproval: ({ request, approvalHash }) => {
      if (request.content?.artifactKind === 'FinalityCommitmentRecord') {
        asks.push(approvalHash);
        if (holdCommitment) { waiting.resolve({ request, approvalHash }); return answer.promise; }
      }
      return true;
    } });
  cleanup(t, h, answer);
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'approval-deadline-commitment-restart' }).then(value => ({ value }), error => ({ error }));
  const asked = await bounded(waiting.promise, 180000, 'the seller commitment approval was never asked');
  const address = asked.request.content.logicalAddress;
  const { closing } = await closeUntilDeadline(h, clock);
  await bounded(clock.waiting(clock.graceMs), 10000, 'the request drain never started its grace');
  await clock.advance(clock.graceMs);
  await clock.advance(clock.approvalMs);
  assert.equal((await bounded(closing, 60000, 'close did not finish after the approval deadline')).error, undefined);
  await bounded(purchase, 60000, 'the buyer did not finish after the stop');
  await assertCutAtDeadline(h, asked, observed);

  // The next start asks again through the ordinary commit; the operator approves.
  holdCommitment = false;
  await h.restart();
  const row = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind = 'purchase'").get();
  await h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id });
  const after = h.application.db.prepare("SELECT status, json_extract(state, '$.protocol.stage') AS stage FROM operations WHERE id = ?").get(row.id);
  assert.deepEqual({ ...after }, { status: 'awaiting_approval', stage: 'seller-committed' });
  assert.equal(asks.length, 2, 'asked once before the cut and once after the restart');
  assert.equal(accepted(h, address).length, 1, 'exactly one commitment CREATE');
  assert.deepEqual(linesFor(await approvalLines(h), address).map(line => [line.approvalHash, line.decision]), [[asks[1], 'approved']]);
  // Another start only reads the commitment back.
  await h.restart();
  await h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id });
  assert.equal(asks.length, 2);
  assert.equal(accepted(h, address).length, 1, 'the commitment is read back, not sent again');
});

// A paid purchase whose Deliverable approval the deadline cuts: the buyer's
// payment is observed, nothing for the Deliverable is signed or sent, and its
// intent stays 'closing'. The seller's SDK delivery WAL is left ambiguous.
async function cutDeliverable(t, idempotencyKey) {
  const observed = observeSends(), answer = deferred(), waiting = deferred();
  const clock = shutdownClock({ graceMs: 30, laneMs: 10000, autoLanes: true });
  const state = { hold: true, asks: [] };
  const h = await startOperatorPurchaseNode2({ sellerDeliveryEvidence: { enabled: true }, rpcFault: observed.rpcFault, shutdownTimer: clock, authorizeBuyerApproval: () => true,
    authorizeSellerApproval: ({ request, approvalHash }) => {
      if (request.content?.artifactKind === 'Deliverable') {
        state.asks.push(approvalHash);
        if (state.hold) { waiting.resolve({ request, approvalHash }); return answer.promise; }
      }
      return true;
    } });
  cleanup(t, h, answer);
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey }).then(value => ({ value }), error => ({ error }));
  const asked = await bounded(waiting.promise, 240000, 'the Deliverable approval was never asked');
  const { closing } = await closeUntilDeadline(h, clock);
  await clock.advance(clock.approvalMs);
  assert.equal((await bounded(closing, 60000, 'close did not finish after the approval deadline')).error, undefined);
  await bounded(purchase, 60000, 'the buyer did not finish after the stop');
  await assertCutAtDeadline(h, asked, observed);
  state.hold = false;
  return { h, asked, state, address: asked.request.content.logicalAddress, jobId: asked.request.content.jobId };
}
const purchaseRow = h => h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind = 'purchase'").get();
async function verifyAfterRestart(h) {
  await h.restart();
  const row = purchaseRow(h);
  try { await h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id }); } catch {}
  return h.application.services.purchases.status(row.account_id, row.id);
}
async function rewriteArtifacts(h, edit) {
  const journal = openDurableWalletJournal({ path: join(h.config.stateDirectory, 'seller-artifacts.sqlite'), mode: 'open' });
  try { await edit(journal); } finally { journal.close(); }
}

test('a Deliverable approval cut at the approval deadline is asked again after a restart, and the paid purchase reaches delivered', { timeout: 400000 }, async t => {
  const { h, asked, state, address, jobId } = await cutDeliverable(t, 'approval-deadline-deliverable-restart');
  const status = await verifyAfterRestart(h);
  const diagnostic = JSON.stringify({ asks: state.asks.length, stage: status.protocol?.stage, delivery: h.composition.sellerAgent.deliveryStateOf(jobId) }).slice(0, 600);
  assert.equal(status.protocol.stage, 'delivered', diagnostic);
  assert.equal(state.asks.length, 2, 'asked once before the cut and once after the restart');
  assert.equal(new Set(state.asks).size, 2, 'the new ask is a fresh unsigned request');
  assert.equal(state.asks[0], asked.approvalHash);
  assert.equal(accepted(h, address).length, 1, 'exactly one Deliverable CREATE');
  assert.deepEqual(linesFor(await approvalLines(h), address).map(line => [line.approvalHash, line.decision]), [[state.asks[1], 'approved']], 'only the new ask is recorded, as approved');
  const artifacts = await journalState(h, 'seller-artifacts.sqlite');
  assert.deepEqual(artifacts.entries.filter(([, value]) => value?.input?.logicalAddress === address).map(([, value]) => value.stage), ['verified']);
  // Another start only reads the Deliverable back.
  assert.equal((await verifyAfterRestart(h)).protocol.stage, 'delivered');
  assert.equal(state.asks.length, 2);
  assert.equal(accepted(h, address).length, 1, 'the Deliverable is read back, not sent again');
});

// The re-ask needs the reader's own proof, minted only for a 'closing' row as
// the cut writes it with no signed transaction for the address retained.
// Every other row stays held and read-back-only, with nothing asked or sent:
// the 'intent' an ordinary crash leaves before the wallet answers (even with
// copied marker-like fields), a 'closing' row with another error (a plain
// absence), and the cut's own row next to a retained signed transaction.
test('only the closing row a cut writes asks a held Deliverable again: a crash-left intent, another closing error or a retained signed transaction stays held', { timeout: 500000 }, async t => {
  const { h, state, address, jobId } = await cutDeliverable(t, 'approval-deadline-deliverable-forged');
  let key, cut;
  await rewriteArtifacts(h, async journal => {
    [[key, cut]] = (await journal.entries()).filter(([, value]) => value?.input?.logicalAddress === address);
    await journal.put(key, { ...cut, stage: 'intent', askable: true, provenUnsigned: true });
  });
  const held = async label => {
    const status = await verifyAfterRestart(h);
    assert.notEqual(status.protocol.stage, 'delivered', `${label}: ${JSON.stringify(h.composition.sellerAgent.deliveryStateOf(jobId)).slice(0, 400)}`);
    assert.equal(state.asks.length, 1, `${label}: the Deliverable is not asked again`);
    assert.equal(accepted(h, address).length, 0, `${label}: nothing is sent`);
    await h.operator.close();
  };
  await held('crash-left intent');
  await rewriteArtifacts(h, journal => journal.put(key, { ...cut, error: 'wallet-response-missing' }));
  await held('closing with another error');
  await rewriteArtifacts(h, async journal => {
    await journal.put(key, cut);
    await journal.put('demo/wallet/TEST-retained-signed', { stage: 'signed', signedTransaction: { content: { data: ['storageProgram', { metadata: { logicalAddress: address } }] } } });
  });
  await held('closing next to a retained signed transaction');
  // The cut's row alone is asked again and lands once.
  await rewriteArtifacts(h, journal => journal.put('demo/wallet/TEST-retained-signed', { stage: 'released' }));
  const status = await verifyAfterRestart(h);
  assert.equal(status.protocol.stage, 'delivered', `the closing row the cut wrote is asked again: ${JSON.stringify(h.composition.sellerAgent.deliveryStateOf(jobId)).slice(0, 400)}`);
  assert.equal(state.asks.length, 2);
  assert.equal(accepted(h, address).length, 1);
});

// The payment evidence (pay-dem) goes through the sr2 wallet bridge, whose
// handoff is issued before the wallet is asked. A cut there is no decision:
// nothing is recorded or signed, the seller keeps the answer as indeterminate
// (never rejected), and every later call only reads it back, as after a crash.
const sellerJobs = h => {
  const db = new DatabaseSync(join(h.config.stateDirectory, 'seller-state', 'seller-state.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT value FROM seller_jobs').all().map(row => JSON.parse(row.value)); } finally { db.close(); }
};
test('a payment-evidence approval cut at the approval deadline is kept indeterminate, never rejected, and stays read-back-only', { timeout: 400000 }, async t => {
  const observed = observeSends(), answer = deferred(), waiting = deferred();
  const clock = shutdownClock({ graceMs: 30, laneMs: 10000, autoLanes: true });
  const asks = [];
  const h = await startOperatorPurchaseNode2({ rpcFault: observed.rpcFault, shutdownTimer: clock, authorizeBuyerApproval: () => true,
    authorizeSellerApproval: ({ request, approvalHash }) => {
      if (String(request.content?.logicalAddress).startsWith('dacs4:payment:')) { asks.push(approvalHash); waiting.resolve({ request, approvalHash }); return asks.length === 1 ? answer.promise : true; }
      return true;
    } });
  cleanup(t, h, answer);
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'approval-deadline-pay-dem' }).then(value => ({ value }), error => ({ error }));
  const asked = await bounded(waiting.promise, 240000, 'the payment-evidence approval was never asked');
  const address = asked.request.content.logicalAddress;
  const { closing } = await closeUntilDeadline(h, clock);
  await clock.advance(clock.approvalMs);
  assert.equal((await bounded(closing, 60000, 'close did not finish after the approval deadline')).error, undefined);
  await bounded(purchase, 60000, 'the buyer did not finish after the stop');

  const evidence = await approvalLines(h);
  assert.deepEqual(evidence.filter(line => line.approvalHash === asked.approvalHash), [], 'the cut approval is recorded as no decision at all');
  assert.deepEqual(evidence.filter(line => line.decision === 'rejected').map(line => line.approvalHash), [], 'the cut writes no rejected line');
  assert.deepEqual(observed.sent.filter(text => text.includes(address)), [], 'nothing for this address was signed for or sent to Node2');
  for (const file of ['seller-wallet.sqlite', 'seller-artifacts.sqlite', 'node2-transport.sqlite']) {
    const state = await journalState(h, file);
    assert.deepEqual(state.locks, [], `${file}: no lane lock is left`);
    assert.deepEqual(state.entries.filter(([, value]) => value?.signedTransaction && JSON.stringify(value.signedTransaction).includes(address)), [], `${file}: no signed transaction for this address`);
  }
  const workOf = () => sellerJobs(h).map(row => row.payload?.body?.session?.nativeEvidenceWork).find(Boolean);
  const work = workOf();
  assert.equal(work?.address, address, 'the payment-evidence work is retained');
  assert.equal(work.anchorAnswer?.status, 'indeterminate', `the cut is not recorded as rejected: ${JSON.stringify(work.anchorAnswer).slice(0, 300)}`);
  assert.equal(work.anchorAnswer.code, 'operator_closing');
  assert.equal(work.anchorAnswer.plan?.stage, 'handoff-issued', 'the handoff stays issued');

  // As after a crash at that point: later calls only read it back.
  await h.restart();
  const row = purchaseRow(h);
  try { await h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id }); } catch {}
  assert.equal(asks.length, 1, 'the payment evidence is not asked again');
  assert.deepEqual(observed.sent.filter(text => text.includes(address)), [], 'nothing is sent');
  assert.equal(accepted(h, address).length, 0);
  assert.deepEqual(workOf().anchorAnswer, work.anchorAnswer, 'the retained answer is unchanged');
});

// Switch on, an early commitment held after its no-resend intent past the
// shared deadline (as in commit-on-signature-operator) is still asked when it
// finally asks, and a human who never answers holds shutdown only for that
// approval's own deadline, counted from the ask; it then ends undecided.
test('switch on: an approval first asked after the shared deadline is still asked, and ends undecided at its own deadline', { timeout: 300000 }, async t => {
  const previous = process.env.DACS_COMMIT_ON_SIGNATURE;
  process.env.DACS_COMMIT_ON_SIGNATURE = 'on';
  t.after(() => { if (previous === undefined) delete process.env.DACS_COMMIT_ON_SIGNATURE; else process.env.DACS_COMMIT_ON_SIGNATURE = previous; });
  const observed = observeSends(), answer = deferred(), waiting = deferred(), intent = deferred(), release = deferred();
  const clock = shutdownClock({ graceMs: 30, laneMs: 10000, autoLanes: true });
  let paused = false;
  const wrapPublicJournal = journal => ({ ...journal, async put(name, value) {
    await journal.put(name, value);
    if (!paused && value?.stage === 'intent' && value?.input?.artifactKind === 'FinalityCommitmentRecord') { paused = true; intent.resolve(value.input.logicalAddress); await release.promise; }
  } });
  const h = await startOperatorPurchaseNode2({ rpcFault: observed.rpcFault, shutdownTimer: clock, wrapPublicJournal, authorizeBuyerApproval: () => true,
    authorizeSellerApproval: ({ request, approvalHash }) => {
      if (request.content?.artifactKind === 'FinalityCommitmentRecord') { waiting.resolve({ request, approvalHash }); return answer.promise; }
      return true;
    } });
  t.after(() => release.resolve());
  cleanup(t, h, answer);
  const purchase = h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'approval-deadline-late-ask' }).then(value => ({ value }), error => ({ error }));
  const address = await bounded(intent.promise, 180000, 'the commitment intent was never journaled');
  const { closing, settled } = await closeUntilDeadline(h, clock);
  await clock.advance(clock.approvalMs); // the shared deadline passes before the commitment asks
  await bounded(clock.waiting(clock.graceMs), 10000, 'the request drain never started its grace');
  await clock.advance(clock.graceMs);
  release.resolve();
  const asked = await bounded(waiting.promise, 60000, 'an approval asked after the shared deadline was refused without being asked');
  assert.equal(asked.request.content.logicalAddress, address);
  await sleep(500);
  assert.equal(settled(), false, 'close waits for the approval asked after the deadline');
  await bounded(clock.advance(clock.approvalMs), 10000, 'the late approval never started its own deadline');
  assert.equal((await bounded(closing, 60000, 'close did not finish after the late approval\'s own deadline')).error, undefined);
  await bounded(purchase, 60000, 'the buyer did not finish after the stop');
  await assertCutAtDeadline(h, asked, observed);
});

// Approvals asked after close started share one late window, opened by the
// first of them: here a delivery-evidence resume pass asks first, then the
// Vet of another purchase's plan step, which close awaits with its admitted
// work. The second asks only after that window has ended, so it ends
// undecided without being asked and close finishes with no further approval
// wait: two serialized late asks hold close for one window, not one each.
// (The second purchase is paused at its Vet, before its buyer signs or pays:
// a buyer payment's connection lease, while it waits for a paused seller
// write, would also hold the pass's connection fence.)
test('switch on: approvals asked one after another after close started share one late window, and one asked after it ends is cut without being asked', { timeout: 500000 }, async t => {
  const previous = process.env.DACS_COMMIT_ON_SIGNATURE;
  process.env.DACS_COMMIT_ON_SIGNATURE = 'on';
  t.after(() => { if (previous === undefined) delete process.env.DACS_COMMIT_ON_SIGNATURE; else process.env.DACS_COMMIT_ON_SIGNATURE = previous; });
  const fault = failEvidenceIntentOnce(), observed = observeSends(), answer = deferred();
  const clock = shutdownClock({ graceMs: 30, laneMs: 10000, autoLanes: true });
  // A gate pauses one intent of its kind right after it is journaled, before the wallet is asked.
  const gate = () => ({ used: false, reached: deferred(), release: deferred() });
  const gates = {}, closings = new Map();
  const closedFor = address => { if (!closings.has(address)) closings.set(address, deferred()); return closings.get(address).promise; };
  const wrapPublicJournal = journal => new Proxy(fault.wrap(journal), { get(target, key) {
    if (key === 'put') return async (name, value) => {
      await target.put(name, value);
      if (value?.stage === 'closing') { closedFor(value.input.logicalAddress); closings.get(value.input.logicalAddress).resolve(); }
      const held = value?.stage === 'intent' ? gates[value.input?.artifactKind] : null;
      if (held && !held.used) { held.used = true; held.reached.resolve(value.input.logicalAddress); await held.release.promise; }
    };
    return Reflect.get(target, key, target);
  } });
  const holding = new Map(), asks = [];
  const askedFor = address => { if (!holding.has(address)) holding.set(address, deferred()); return holding.get(address).promise; };
  const h = await startOperatorPurchaseNode2({ tlsFixture: createLoopbackTestTlsMaterial(), sellerDeliveryEvidence: { enabled: true }, wrapPublicJournal, evidenceResumeTimer: manualTimer(),
    rpcFault: observed.rpcFault, shutdownTimer: clock, authorizeBuyerApproval: () => true,
    authorizeSellerApproval: ({ request, approvalHash }) => {
      const address = request.content?.logicalAddress;
      asks.push(address);
      if (!holding.has(address)) return true;
      holding.get(address).resolve({ request, approvalHash });
      return answer.promise;
    } });
  t.after(() => { for (const held of Object.values(gates)) held.release.resolve(); });
  cleanup(t, h, answer);
  const driver = h.operator.createBuyerDriver({ composition: h.composition });
  const first = await driver.purchase({ idempotencyKey: 'approval-deadline-late-window-first' });
  assert.equal(fault.fired, 1);
  assert.equal(first.status, 'delivery-ready', 'the first purchase holds its delivery evidence for a resume pass');
  gates.CompositeVerificationRecord = gate();
  const second = driver.purchase({ idempotencyKey: 'approval-deadline-late-window-second' }).then(value => ({ value }), error => ({ error }));
  const vet = await bounded(gates.CompositeVerificationRecord.reached.promise, 240000, 'the second purchase\'s plan step never journaled its Vet intent');
  gates.SettlementEvidence = gate();
  const pass = h.operator.resumeHeldDeliveryEvidence().then(value => ({ value }), error => ({ error }));
  const evidence = await bounded(Promise.race([gates.SettlementEvidence.reached.promise, pass.then(ended => { throw new Error(`the resume pass ended before its evidence intent: ${JSON.stringify(ended.value ?? String(ended.error)).slice(0, 600)}`); })]),
    120000, 'the resume pass never journaled its evidence intent');
  const evidenceAsked = askedFor(evidence), vetAsked = askedFor(vet);

  const { closing } = await closeUntilDeadline(h, clock);
  await clock.advance(clock.approvalMs); // the shared deadline passes before either asks
  gates.SettlementEvidence.release.resolve();
  const lateFirst = await bounded(evidenceAsked, 60000, 'the first approval asked after the shared deadline was refused without being asked');
  await clock.advance(clock.approvalMs); // the one late window ends
  assert.equal((await bounded(pass, 30000, 'the pass did not end at the late window')).error, undefined);
  // Close now drains admitted work, the paused plan step with it.
  await bounded(clock.waiting(clock.graceMs), 10000, 'the request drain never started its grace');
  gates.CompositeVerificationRecord.release.resolve();
  const outcome = await bounded(Promise.race([vetAsked.then(() => 'asked'), closedFor(vet).then(() => 'cut')]), 60000, 'the second late approval neither ended nor was asked');
  assert.equal(outcome, 'cut', 'a second approval asked after the late window ended was put to the operator with a fresh full window');
  await clock.advance(clock.graceMs);
  assert.equal((await bounded(closing, 60000, 'close did not finish after the late window')).error, undefined);
  assert.equal(await Promise.race([clock.waiting(clock.approvalMs).then(() => 'another approval window'), sleep(300).then(() => 'none')]), 'none', 'no approval window is left open');
  await bounded(second, 60000, 'the second buyer did not finish after the stop');

  await assertCutAtDeadline(h, lateFirst, observed);
  assert.equal(asks.filter(address => address === vet).length, 0, 'the second late approval is never put to the operator');
  const artifacts = await journalState(h, 'seller-artifacts.sqlite');
  assert.deepEqual(artifacts.entries.filter(([, value]) => value?.input?.logicalAddress === vet).map(([, value]) => [value.stage, value.error, value.hash]),
    [['closing', 'operator_closing', undefined]], 'the second approval was cut at the gate: its Vet stays askable');
  assert.deepEqual(linesFor(await approvalLines(h), vet), []);
  assert.equal(accepted(h, vet).length, 0);
  assert.deepEqual(observed.sent.filter(text => text.includes(vet)), []);
});
