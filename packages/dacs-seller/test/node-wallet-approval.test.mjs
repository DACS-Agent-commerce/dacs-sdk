// The approval accounting of the seller's Node wallet: every request of the composed walletFactory runs as one approval
// attempt, and each request the approver accepted is settled in its ledger by what the request wrote to the journals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { artifactWrite, jsonResponse, ok, outcomes, preparedWrite, refuseConfirmation, replyTo, sendWrite, settlingApproval, settlingWorld, spyTransactionSignatures,
  writesOf } from './helpers/seller-node-wallet-world.mjs';
import { JOBS, ledgerWorld } from './helpers/seller-node-wallet-ledger-world.mjs';
import { confirmationFor, PAYMENT_TX_REF, requestFor } from './helpers/d5-policy-fixtures.mjs';

const { OPERATOR_CLOSING } = await import('../src/devnet-demo/operator-approval.mjs');
const { sellerDiagnostic } = await import('../src/seller-diagnostics.mjs');

// The transport's inclusion poll sleeps 500 ms between reads, up to 240 times.
const CLOCK_STEP_MS = 500;
const CLOCK_STEPS = 2_000;
/** Resolves `work` while moving the mocked clock forward, for a request that waits on a deadline. */
async function withClockAdvancing(t, work) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  const result = work().finally(() => { done = true; });
  for (let step = 0; !done && step < CLOCK_STEPS; step++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(CLOCK_STEP_MS);
  }
  const answer = await result;
  t.mock.timers.reset();
  return answer;
}
const withheldAcknowledgement = world => replyTo(world.node, 'broadcastTx', () => { throw new Error('TEST-acknowledgement-lost'); });

test('an accepted, included artifact CREATE is settled spent', async t => {
  const world = await settlingWorld(t);
  const { answer } = await artifactWrite(world);
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.equal(world.node.broadcasts.length, 1);
  assert.deepEqual(world.approve.settled.map(({ request, outcome }) => [request.method, outcome]), [['sign', 'released'], ['sendTransaction', 'spent']],
    'the message signature wrote nothing and is released; the included write is spent');
});

test('a 200 broadcast reply carrying an included writeProof for a write the node never applied is settled unknown', async t => {
  const world = await settlingWorld(t);
  replyTo(world.node, 'broadcastTx', row => {
    const { hash } = row.body.params[0].data.response.data.transaction;
    return jsonResponse({ ...ok({ hash }), writeProof: { disposition: 'included', receipt: { hash }, noResend: true } });
  });
  const { answer } = await withClockAdvancing(t, () => artifactWrite(world));
  assert.equal(answer.data?.writeProof, undefined, 'the transport never passes on a proof the node supplied');
  assert.deepEqual(outcomes(world), ['unknown']);
});

test('a dropped broadcast acknowledgement is settled unknown, and a confirmation the node refuses before any broadcast is settled released', async t => {
  const dropped = await settlingWorld(t);
  withheldAcknowledgement(dropped);
  assert.equal((await artifactWrite(dropped)).answer.success, false);
  assert.equal(dropped.node.broadcasts.length, 1);
  assert.deepEqual(outcomes(dropped), ['unknown']);

  const refused = await settlingWorld(t);
  refuseConfirmation(refused);
  assert.equal((await artifactWrite(refused)).answer.success, false);
  assert.equal(refused.node.broadcasts.length, 0, 'nothing was sent');
  assert.deepEqual(outcomes(refused), ['released']);
});

test('issuance is recorded from the selected walletFactory journal and from the transport journal, not from a write outside a request', async t => {
  const world = await settlingWorld(t);
  const stages = [];
  const selected = { ...world.wallet.artifactJournal, put: (key, value) => { stages.push(value?.stage); return world.wallet.artifactJournal.put(key, value); } };
  withheldAcknowledgement(world);
  await artifactWrite(world, { anchorJournal: selected });
  assert.ok(stages.includes('broadcast-started'), 'the selected journal kept the record');
  assert.deepEqual(outcomes(world), ['unknown'], 'its record marked the request sent');

  await world.wallet.artifactJournal.put('TEST-unrelated-write', { stage: 'broadcast-started' });
  assert.equal(writesOf(world.approve).length, 1, 'a record written outside any request settles nothing');

  const transportOnly = await settlingWorld(t);
  withheldAcknowledgement(transportOnly);
  await artifactWrite(transportOnly, {});
  assert.deepEqual(outcomes(transportOnly), ['unknown'], 'the transport journal marks a request that selects no journal');
});

test('two overlapping wallet requests run one at a time, each in its own attempt with its own settlement', async t => {
  let active = 0, mostActive = 0;
  const approve = settlingApproval({ gate: async () => {
    active++; mostActive = Math.max(mostActive, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
  } });
  const world = await settlingWorld(t, { approve });
  withheldAcknowledgement(world);
  const write = await preparedWrite(world);
  const settledBefore = approve.settled.length;
  const [sent, signed] = await Promise.all([sendWrite(world, write), write.wallet.request({ method: 'sign', params: ['TEST-overlapping-message'] })]);
  assert.equal(sent.success, false, 'the write whose acknowledgement was lost fails');
  assert.equal(signed.success, true, JSON.stringify(signed));
  assert.equal(mostActive, 1, 'the approver never saw two requests at once');
  assert.deepEqual(approve.settled.slice(settledBefore).map(({ request, outcome }) => [request.method, outcome]).sort(), [['sendTransaction', 'unknown'], ['sign', 'released']],
    'the write is unknown, and the signature that overlapped it is released: it did not inherit the write\'s issuance');
});

test('a settlement error or a logger error never puts the message, nested cause or thrown-object text on stdout or stderr, and the wallet result is unchanged', async t => {
  const secret = 'TEST-secret-settlement-message';
  const failure = Object.assign(new Error(secret, { cause: new Error('TEST-secret-nested-cause') }), { code: 'approval_reservation_unavailable' });
  const written = [];
  // Each write is recorded and still passed on, so the test runner's own reports are not swallowed.
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    t.mock.method(stream, 'write', (chunk, ...rest) => { written.push(String(chunk)); return write(chunk, ...rest); });
  }
  const reference = await settlingWorld(t);
  const expected = (await artifactWrite(reference)).answer.success;

  const world = await settlingWorld(t, { approve: settlingApproval({ failure }) });
  const { answer } = await artifactWrite(world);
  assert.equal(answer.success, expected, 'the wallet result is what it was without the failure');
  assert.deepEqual(world.diagnostics, Array(2).fill(sellerDiagnostic('approval_reservation_unavailable')), 'the sink got the closed projection for the signature and for the write');

  const throwingSink = await settlingWorld(t, { approve: settlingApproval({ failure: { code: 'x', toString: () => 'TEST-secret-thrown-object' } }),
    diagnostics: () => { throw new Error('TEST-secret-logger-error'); } });
  assert.equal((await artifactWrite(throwingSink)).answer.success, expected);
  const output = written.join('');
  for (const text of [secret, 'TEST-secret-nested-cause', 'TEST-secret-thrown-object', 'TEST-secret-logger-error']) assert.ok(!output.includes(text), `${text} was not written`);
});

test('a request whose approval ended in a shutdown answers operator_closing and signs nothing, while the request already in flight is still settled', async t => {
  let closing = false, entered = false, release;
  const inFlight = new Promise(resolve => { release = resolve; });
  const approve = settlingApproval({ gate: async request => {
    if (closing) throw Object.assign(new Error('TEST-closing'), { code: OPERATOR_CLOSING });
    if (request.method === 'sendTransaction') { entered = true; await inFlight; }
  } });
  const flying = await settlingWorld(t, { approve }), queued = await settlingWorld(t, { approve });
  const [first, second] = [await preparedWrite(flying), await preparedWrite(queued)];
  const sending = sendWrite(flying, first);
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  closing = true;
  release();
  assert.equal((await sending).success, true, 'the approval given before the shutdown is honoured');
  assert.deepEqual(outcomes(flying), ['spent'], 'the request in flight is still settled after the shutdown');
  const refused = await sendWrite(queued, second);
  assert.equal(refused.error?.code, OPERATOR_CLOSING);
  assert.equal(queued.node.broadcasts.length, 0, 'the refused request signed and sent nothing');
  assert.equal(writesOf(approve).length, 1, 'the refused request has no settlement to make');
});

test('a broadcast-started write that fails, or commits and then throws, leaves the request settled unknown and never released', async t => {
  for (const commitFirst of [false, true]) {
    const world = await settlingWorld(t);
    const journal = world.wallet.artifactJournal;
    const failing = { ...journal, put: async (key, value) => {
      if (value?.stage !== 'broadcast-started') return journal.put(key, value);
      if (commitFirst) await journal.put(key, value);
      throw new Error('TEST-journal-write-failed');
    } };
    const { answer } = await artifactWrite(world, { anchorJournal: failing });
    assert.equal(answer.success, false);
    assert.deepEqual(outcomes(world), ['unknown'], commitFirst ? 'committed then threw' : 'failed');
    assert.equal(world.node.broadcasts.length, 0, 'the failed write sent nothing');
  }
});

test('walletFactory refuses a selected anchor journal that cannot record writes', async t => {
  const world = await settlingWorld(t);
  assert.throws(() => world.wallet.walletFactory({ anchorJournal: {} }), TypeError);
  assert.throws(() => world.wallet.walletFactory({ anchorJournal: null }), TypeError);
});

// The tests below run the composed wallet over the real policy approval ledger. A payment-evidence CREATE goes through the wallet's
// payment-evidence journal and the ledger's retained calls; an artifact CREATE goes through the ledger's shared slot, because the wallet
// composition's own session write is the Agreement, which the seller's policy never approves.
const CUT = new Error('TEST-cut');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const lostConfirmation = world => replyTo(world.node, 'confirmTx', () => { throw new Error('TEST-confirmation-lost'); });
const artifactRequest = (world, options = {}) => requestFor({ artifactKind: 'Deliverable', job: JOBS[2], nonce: 3, walletAddress: world.address, writer: world.claim,
  sourceBinding: world.sourceBinding, artifact: { producer: world.claim }, ...options });
// A replay the current policy refuses is answered `pending` with the refusal's code, and sends nothing.
const assertReplayRefused = answer => {
  assert.equal(answer.status, 'pending', JSON.stringify(answer));
  assert.match(answer.reason, /approval_required/);
};
const executedConfirmation = request => confirmationFor(request, { executed: true });
const sentBytes = world => new Set(world.node.broadcasts.map(tx => JSON.stringify(tx)));
const assertSent = answer => assert.ok(['submitted', 'rebroadcast'].includes(answer.status), JSON.stringify(answer));
const completionOutcomes = async world => (await world.ledger.lines()).filter(line => line.outcome).map(line => line.outcome);
/** The id of the one authorization the ledger holds a sign line for. */
async function onlyAuthorization(world) {
  const lines = await world.ledger.signLines();
  assert.equal(lines.length, 1, 'one authorization was prepared');
  return lines[0].reservationId;
}
/** The authorization `id` is the only sign line, open, with no completion, and counts as one write. */
async function assertHeld(world, id, barrier) {
  assert.deepEqual((await world.ledger.open()).map(row => row.reservationId), [id], `${barrier}: the authorization is open`);
  assert.deepEqual(await world.ledger.completions(id), [], `${barrier}: nothing is released or spent`);
  assert.equal((await world.ledger.signLines()).length, 1, `${barrier}: no second authorization`);
  assert.equal((await world.ledger.budget()).writes, 1, `${barrier}: one counted write`);
}

test('a payment-evidence CREATE\'s authorization is prepared before signing; after restart a refused replay of an unknown dispatch leaves the same authorization held in the real ledger', async t => {
  let world;
  const heldAtSignature = [];
  await spyTransactionSignatures(t.mock, async () => { heldAtSignature.push((await world.ledger.open()).length); });
  world = await ledgerWorld(t);
  const input = world.evidenceInput();
  withheldAcknowledgement(world);
  await assert.rejects(world.anchor(input));
  assert.deepEqual(heldAtSignature, [1], 'the ledger held the authorization when the CREATE was signed');
  const id = await onlyAuthorization(world);
  assert.equal(world.node.broadcasts.length, 1);
  await assertHeld(world, id, 'after the lost acknowledgement');

  world.node.reply = null;
  await world.reopen();
  world.purchaseState.purchase = false;
  assertReplayRefused(await world.reconcile(input));
  assert.equal(world.node.broadcasts.length, 1, 'the refused replay sent nothing');
  await assertHeld(world, id, 'after the refused replay');
});

async function replayAfterFailedConfirmation(t, failConfirmation) {
  const world = await ledgerWorld(t), input = world.evidenceInput();
  failConfirmation(world);
  await assert.rejects(world.anchor(input));
  const id = await onlyAuthorization(world);
  assert.equal(world.node.broadcasts.length, 0, 'nothing was sent');
  await assertHeld(world, id, 'after the failed confirmation');
  await world.reopen();
  await assertHeld(world, id, 'after the reopen');
  world.node.reply = null;
  assertSent(await world.anchor(input));
  await assertHeld(world, id, 'after the replay');
  assert.ok(world.retainedCalls.includes('reopen'), 'the replay reopened the authorization by its id');
  assert.equal(world.retainedCalls.filter(name => name === 'prepare').length, 1, 'no second preparation');
  assert.equal((await world.reconcile(input)).status, 'applied');
  assert.deepEqual((await world.ledger.completions(id)).map(line => line.outcome), ['spent'], 'settled spent once');
  assert.equal((await world.ledger.linked(id)).length, 1);
}

test('a payment-evidence confirmation refused (balance included), then reopen, then a successful replay: the real ledger holds the original authorization at every barrier, the replay reopens it by id, and it settles spent once', async t => {
  await replayAfterFailedConfirmation(t, refuseConfirmation);
});

test('a lost payment-evidence confirmation answer, then reopen, then a successful replay: same ledger assertions, and nothing is released in between', async t => {
  await replayAfterFailedConfirmation(t, lostConfirmation);
});

test('after a restart, an applied readback through reconcilePaymentEvidence, with no approve or broadcast in that process, settles the original authorization spent once; a repeated reconcile settles nothing new', async t => {
  const world = await ledgerWorld(t), input = world.evidenceInput();
  replyTo(world.node, 'broadcastTx', row => {
    const tx = row.body.params[0].data.response.data.transaction;
    world.node.applied.set(tx.hash, tx);
    world.node.nonce = tx.content.nonce;
    throw new Error('TEST-acknowledgement-lost');
  });
  await assert.rejects(world.anchor(input));
  const id = await onlyAuthorization(world);
  world.node.reply = null;
  await world.reopen();
  const broadcastsBefore = world.node.broadcasts.length, callsBefore = world.retainedCalls.length;
  assert.equal((await world.reconcile(input)).status, 'applied');
  assert.deepEqual(world.retainedCalls.slice(callsBefore).filter(name => ['prepare', 'confirm'].includes(name)), [], 'the restarted process neither prepared nor confirmed');
  assert.equal(world.node.broadcasts.length, broadcastsBefore, 'the restarted process broadcast nothing');
  assert.deepEqual((await world.ledger.completions(id)).map(line => line.outcome), ['spent']);
  assert.equal((await world.reconcile(input)).status, 'applied');
  assert.deepEqual((await world.ledger.completions(id)).map(line => line.outcome), ['spent'], 'a repeated reconcile settles nothing new');
});

const CUTS = [
  { name: 'before the preparation', fault: ['prepare', () => { throw CUT; }], signLines: 0, afterCut: [], eventually: ['spent'] },
  { name: 'after the ledger append, before its return', fault: ['prepare', async (real, args) => { await real(...args); throw CUT; }], signLines: 1, afterCut: ['released'],
    eventually: ['released', 'spent'] },
  { name: 'after the id binding, before the confirmation', fault: ['confirm', () => { throw CUT; }], signLines: 1, afterCut: [], eventually: ['spent'] },
  { name: 'between the terminal state and the settlement answer', fault: ['settle', async (real, args) => { await real(...args); throw CUT; }], signLines: 1, afterCut: ['spent'],
    eventually: ['spent'], reconcileFirst: true },
];

test('cuts before intent, after intent before preparation, after the ledger append before return (including commit then throw), before or after id binding, and between terminal, settlement, settled and ownership cleanup: before intent or before preparation there is no ledger authorization; a committed unused retired preparation has one released completion and no orphan hold; only the eventual executable write has one spent completion; reopen twice is idempotent', async t => {
  for (const cut of CUTS) {
    const world = await ledgerWorld(t), input = world.evidenceInput();
    world.faults[cut.fault[0]] = cut.fault[1];
    await world.anchor(input).catch(() => {});
    if (cut.reconcileFirst) await world.reconcile(input).catch(() => {});
    assert.equal((await world.ledger.signLines()).length, cut.signLines, `${cut.name}: authorizations`);
    assert.deepEqual(await completionOutcomes(world), cut.afterCut, `${cut.name}: completions after the cut`);

    for (const name of Object.keys(world.faults)) delete world.faults[name];
    await world.reopen();
    const linesAfterFirstReopen = (await world.ledger.lines()).length;
    await world.reopen();
    assert.equal((await world.ledger.lines()).length, linesAfterFirstReopen, `${cut.name}: a second reopen appends nothing`);

    await world.anchor(input).catch(() => {});
    assert.equal((await world.reconcile(input)).status, 'applied', cut.name);
    assert.deepEqual(await completionOutcomes(world), cut.eventually, `${cut.name}: completions at the end`);
    assert.deepEqual(await world.ledger.open(), [], `${cut.name}: no orphan hold`);
    assert.equal(sentBytes(world).size, 1, `${cut.name}: one signed CREATE reached the node`);
  }
});

test('policy mode through the real composeSellerApproval: an artifact CREATE through the shared slot and a payment-evidence CREATE through the retained API each prepare, confirm once and settle spent; the callback count equals the confirmations', async t => {
  const world = await ledgerWorld(t), input = world.evidenceInput(), artifact = artifactRequest(world);
  assert.equal(await world.approve(artifact), true);
  assert.equal(await world.approve.confirm(executedConfirmation(artifact)), true);
  await world.approve.settle(artifact, 'spent');
  assertSent(await world.anchor(input));
  assert.equal((await world.reconcile(input)).status, 'applied');

  const signs = await world.ledger.signLines();
  assert.equal(signs.length, 2, 'one authorization for each write');
  for (const { reservationId } of signs) {
    assert.equal((await world.ledger.linked(reservationId)).length, 1, 'confirmed once');
    assert.deepEqual((await world.ledger.completions(reservationId)).map(line => line.outcome), ['spent']);
  }
  const linkedLines = (await world.ledger.lines()).filter(line => line.confirmation).length;
  assert.deepEqual(world.confirmations, { shared: 1, retained: 1 });
  assert.equal(world.confirmations.shared + world.confirmations.retained, linkedLines, 'the callback ran once per confirmation');
});

test('the purchase closes or the debit changes between preparation and confirmation: zero broadcasts; the artifact write\'s hold is released with confirmation-mismatch, while the payment-evidence authorization stays held', async t => {
  const world = await ledgerWorld(t), input = world.evidenceInput();
  // The evidence write is prepared, then the purchase closes before its confirmation.
  world.faults.prepare = async (real, args) => { const binding = await real(...args); world.purchaseState.purchase = false; return binding; };
  await assert.rejects(world.anchor(input), { code: 'approval_required' });
  delete world.faults.prepare;
  assert.equal(world.node.broadcasts.length, 0, 'zero broadcasts');
  const evidenceId = await onlyAuthorization(world);
  await assertHeld(world, evidenceId, 'after the purchase closed');

  // The artifact write is prepared, then the node confirms a different debit.
  world.purchaseState.purchase = world.purchaseState.paid;
  const artifact = artifactRequest(world);
  assert.equal(await world.approve(artifact), true);
  assert.equal(await world.approve.confirm(executedConfirmation(artifactRequest(world, { rpcFeeDem: '2' }))), false);
  const [, artifactSign] = await world.ledger.signLines();
  const [completion, ...rest] = await world.ledger.completions(artifactSign.reservationId);
  assert.deepEqual([completion?.outcome, completion?.reason, rest.length], ['released', 'confirmation-mismatch', 0]);
  assert.deepEqual((await world.ledger.open()).map(row => row.reservationId), [evidenceId], 'only the evidence authorization is still held');
  assert.deepEqual(await world.ledger.completions(evidenceId), []);
});

test('the confirmed-write callback refuses or throws: zero broadcasts on both paths; the artifact hold is settled once, and the payment-evidence authorization stays held', async t => {
  const world = await ledgerWorld(t), input = world.evidenceInput();
  world.faults.confirm = async () => false;
  await assert.rejects(world.anchor(input), { code: 'approval_required' });
  world.faults.confirm = () => { throw CUT; };
  await assert.rejects(world.anchor(input), { code: 'approval_required' });
  delete world.faults.confirm;
  const evidenceId = await onlyAuthorization(world);

  const artifact = artifactRequest(world, { job: JOBS[3], nonce: 4 });
  assert.equal(await world.approve(artifact), true);
  world.purchaseState.purchaseError = new Error('TEST-purchase-source-down');
  await assert.rejects(world.approve.confirm(executedConfirmation(artifact)), /TEST-purchase-source-down/);
  world.purchaseState.purchaseError = null;
  world.purchaseState.purchase = false;
  assert.equal(await world.approve.confirm(executedConfirmation(artifact)), false);
  await world.approve.settle(artifact, 'released');

  assert.equal(world.node.broadcasts.length, 0, 'zero broadcasts');
  const [, artifactSign] = await world.ledger.signLines();
  assert.deepEqual((await world.ledger.completions(artifactSign.reservationId)).map(line => line.outcome), ['released'], 'the artifact hold is settled once');
  assert.deepEqual((await world.ledger.open()).map(row => row.reservationId), [evidenceId], 'the evidence authorization stays held');
  assert.deepEqual(await world.ledger.completions(evidenceId), []);
});

test('with maxWritesPerHour 1, a payment-evidence CREATE reopened and reconfirmed across two restarts counts one write and settles spent once', async t => {
  const world = await ledgerWorld(t, { limits: { maxWritesPerHour: 1 } }), input = world.evidenceInput();
  withheldAcknowledgement(world);
  await assert.rejects(world.anchor(input));
  const id = await onlyAuthorization(world);
  for (let restart = 0; restart < 2; restart++) {
    await world.reopen();
    assert.equal((await world.reconcile(input)).status, 'pending', 'the replay is confirmed again and its acknowledgement is lost again');
    await assertHeld(world, id, `after restart ${restart + 1}`);
  }
  world.node.reply = null;
  await world.reopen();
  assertSent(await world.reconcile(input));
  assert.equal((await world.reconcile(input)).status, 'applied');
  assert.deepEqual((await world.ledger.completions(id)).map(line => line.outcome), ['spent']);
  assert.equal((await world.ledger.signLines()).length, 1);
  assert.equal((await world.ledger.budget()).writes, 1, 'one counted write');
  assert.equal(sentBytes(world).size, 1, 'the same signed bytes every time');
});

test('with maxWritesPerHour 1, crash after preparation append before return or id binding, then change clock or fees: exact-intent recovery releases the unused hold and a retry proceeds without manual fallback or a second counted hold; only the eventual execution settles spent', async t => {
  const world = await ledgerWorld(t, { limits: { maxWritesPerHour: 1 } }), input = world.evidenceInput();
  // The preparation is appended and its return is lost, and the release the failed call then attempts never reaches the ledger.
  world.faults.prepare = async (real, args) => { await real(...args); throw CUT; };
  world.faults.settle = () => { throw CUT; };
  await assert.rejects(world.anchor(input));
  const staleId = await onlyAuthorization(world);
  await assertHeld(world, staleId, 'after the crash');

  for (const name of Object.keys(world.faults)) delete world.faults[name];
  world.purchaseState.now += 60_000;
  replyTo(world.node, 'getNetworkParameters', () => jsonResponse(ok({ networkFee: 2, rpcFee: 0, additionalFee: 0 })));
  await world.reopen();
  assertSent(await world.anchor(input));
  assert.deepEqual((await world.ledger.completions(staleId)).map(line => line.outcome), ['released'], 'the unused hold was released');
  const [, retryId] = (await world.ledger.signLines()).map(line => line.reservationId);
  assert.deepEqual((await world.ledger.open()).map(row => row.reservationId), [retryId], 'only the retry is held');
  assert.equal((await world.ledger.budget()).writes, 1, 'one counted hold');

  assert.equal((await world.reconcile(input)).status, 'applied');
  assert.deepEqual(await completionOutcomes(world), ['released', 'spent']);
  assert.deepEqual((await world.ledger.completions(retryId)).map(line => line.outcome), ['spent'], 'only the execution settled spent');
});

test('through the real journal and ledger, confirm successfully then lose broadcast acknowledgement and restart; unavailable purchase resolution, revoked payment observation or changed bound purchase data each broadcasts zero with the original hold; restore valid evidence and the same bytes replay with no second linked confirmation or counted write', async t => {
  const world = await ledgerWorld(t), input = world.evidenceInput(), state = world.purchaseState;
  withheldAcknowledgement(world);
  await assert.rejects(world.anchor(input));
  const id = await onlyAuthorization(world);
  assert.equal((await world.ledger.linked(id)).length, 1);
  await world.reopen();
  const refusals = {
    'unavailable purchase resolution': () => { state.purchaseError = new Error('TEST-purchase-source-down'); },
    'revoked payment observation': () => { state.purchase = { ...state.paid, paymentObserved: false, paymentTxRef: null, prePaymentOpen: true }; },
    'changed bound purchase data': () => { state.purchase = { ...state.paid, paymentTxRef: { ...PAYMENT_TX_REF, blockNumber: PAYMENT_TX_REF.blockNumber + 1 } }; },
  };
  for (const [label, refuse] of Object.entries(refusals)) {
    refuse();
    assertReplayRefused(await world.reconcile(input));
    assert.equal(world.node.broadcasts.length, 1, `${label}: nothing more was broadcast`);
    await assertHeld(world, id, label);
    state.purchaseError = null;
    state.purchase = state.paid;
  }
  world.node.reply = null;
  assertSent(await world.reconcile(input));
  assert.equal((await world.reconcile(input)).status, 'applied');
  assert.equal((await world.ledger.linked(id)).length, 1, 'no second linked confirmation');
  assert.equal(sentBytes(world).size, 1, 'the same bytes replayed');
  assert.deepEqual((await world.ledger.completions(id)).map(line => line.outcome), ['spent']);
  assert.equal((await world.ledger.budget()).writes, 1, 'one counted write');
});

test('overlapping seller writes: each confirmation consumes only its own preparation, the evidence authorization is untouched by the artifact write\'s, and the ledger\'s lines match each write', async t => {
  const world = await ledgerWorld(t), input = world.evidenceInput(), artifact = artifactRequest(world);
  const [approved, anchored] = await Promise.all([world.approve(artifact), world.anchor(input)]);
  assert.equal(approved, true);
  assertSent(anchored);
  const signs = await world.ledger.signLines();
  const idOf = jobId => signs.find(line => JSON.parse(line.requestBytes).content.jobId === jobId)?.reservationId;
  const [artifactId, evidenceId] = [idOf(artifact.content.jobId), idOf(input.jobId)];
  assert.equal(signs.length, 2);
  assert.ok(artifactId && evidenceId && artifactId !== evidenceId, 'one authorization for each write');

  assert.equal(await world.approve.confirm(executedConfirmation(artifact)), true);
  await world.approve.settle(artifact, 'spent');
  assert.deepEqual((await world.ledger.open()).map(row => row.reservationId), [evidenceId], 'the artifact write left the evidence authorization alone');
  assert.deepEqual(await world.ledger.completions(evidenceId), []);

  assert.equal((await world.reconcile(input)).status, 'applied');
  const lines = await world.ledger.lines();
  for (const [id, jobId] of [[artifactId, artifact.content.jobId], [evidenceId, input.jobId]]) {
    const own = lines.filter(line => line.reservationId === id);
    assert.deepEqual(own.map(line => line.outcome ?? (line.confirmation ? 'linked' : 'sign')), ['sign', 'linked', 'spent'], `the lines of ${jobId}`);
    assert.equal(JSON.parse(own[0].requestBytes).content.jobId, jobId);
  }
});

/** The request the adapter sent for `world`'s evidence write, as the ledger kept it: one anchored and settled write. */
async function adapterRequest(world) {
  const input = world.evidenceInput();
  assertSent(await world.anchor(input));
  assert.equal((await world.reconcile(input)).status, 'applied');
  return JSON.parse((await world.ledger.signLines())[0].requestBytes);
}
const prepareRetained = (world, request) => world.approve.retained.prepare(request);
const without = (record, name) => Object.fromEntries(Object.entries(record).filter(([key]) => key !== name));

test('the ledger refuses a payment-evidence-storage-create request with one extra field, and one with each required field missing, with invalid_params and no hold', async t => {
  const world = await ledgerWorld(t), request = await adapterRequest(world);
  const signLinesBefore = (await world.ledger.signLines()).length;
  const variants = [
    ['an extra request member', { ...request, extra: 1 }],
    ['an extra content member', { ...request, content: { ...request.content, extra: 1 } }],
    ['an extra debit member', { ...request, content: { ...request.content, debit: { ...request.content.debit, extraFeeOs: '0' } } }],
    ...Object.keys(request).map(name => [`no ${name}`, without(request, name)]),
    ...Object.keys(request.content).map(name => [`no content.${name}`, { ...request, content: without(request.content, name) }]),
    ...Object.keys(request.content.debit).map(name => [`no debit.${name}`, { ...request, content: { ...request.content, debit: without(request.content.debit, name) } }]),
  ];
  for (const [label, variant] of variants) await assert.rejects(prepareRetained(world, variant), { code: 'invalid_params' }, label);
  assert.equal((await world.ledger.signLines()).length, signLinesBefore, 'no authorization was held for any of them');
  assert.deepEqual(await world.ledger.open(), []);
});

test('the ledger refuses a payment-evidence-storage-create request whose values are not the CREATE it would approve, with approval_refused and no hold', async t => {
  const world = await ledgerWorld(t), request = await adapterRequest(world);
  const inContent = changes => ({ ...request, content: { ...request.content, ...changes } });
  const inDebit = changes => inContent({ debit: { ...request.content.debit, ...changes } });
  const inCreate = changes => inContent({ exactCreate: JSON.stringify({ ...JSON.parse(request.content.exactCreate), ...changes }) });
  const create = JSON.parse(request.content.exactCreate);
  const variants = {
    'another method': { ...request, method: 'sign' },
    'another address': { ...request, address: `0x${'1'.repeat(64)}` },
    'a purpose that is not text': { ...request, purpose: 7 },
    'another action': inContent({ action: 'another action' }),
    'a job id that is not canonical': inContent({ jobId: 'TEST-job' }),
    'another owner': inContent({ owner: `did:demos:agent:${'1'.repeat(64)}` }),
    'another wallet': inContent({ wallet: `0x${'1'.repeat(64)}` }),
    'a program name that is not the logical address\'s': inContent({ programName: 'TEST-program' }),
    'a nonce of zero': inContent({ nonce: 0 }),
    'a timestamp that is text': inContent({ timestamp: '7' }),
    'another network': inContent({ network: 'TEST-network' }),
    'another chain identity': inContent({ chainIdentity: '1'.repeat(64) }),
    'another content hash': inContent({ contentHash: '1'.repeat(64) }),
    'another envelope hash': inContent({ envelopeHash: '1'.repeat(64) }),
    'a CREATE that is not JSON': inContent({ exactCreate: 'TEST-not-json' }),
    'a CREATE storing another artifact': inCreate({ data: { ...create.data, observedAt: create.data.observedAt + 1 } }),
    'a CREATE with other metadata': inCreate({ metadata: { ...create.metadata, networkBinding: world.sourceBinding } }),
    'a debit amount that is not a canonical number': inDebit({ rpcFeeOs: '01' }),
    'a debit total that is not the sum': inDebit({ totalOs: String(BigInt(request.content.debit.totalOs) + 1n) }),
    'another SDK gas': inDebit({ gasOs: '2000000000', totalOs: String(BigInt(request.content.debit.totalOs) + 1_000_000_000n) }),
    'an additional fee': inDebit({ additionalFeeOs: '1', totalOs: String(BigInt(request.content.debit.totalOs) + 1n) }),
    'a storage fee the stored bytes do not cost': inDebit({ storageFeeOs: '2000000000', totalOs: String(BigInt(request.content.debit.totalOs) + 1_000_000_000n) }),
  };
  const signLinesBefore = (await world.ledger.signLines()).length;
  for (const [label, variant] of Object.entries(variants)) await assert.rejects(prepareRetained(world, variant), { code: 'approval_refused' }, label);
  assert.equal((await world.ledger.signLines()).length, signLinesBefore, 'no authorization was held for any of them');
  assert.deepEqual(await world.ledger.open(), []);
});

test('the ledger refuses an unknown kind, and refuses each known kind carrying another kind\'s shape, with invalid_params and no hold (one assertion per kind)', async t => {
  const world = await ledgerWorld(t), adapter = await adapterRequest(world);
  const settlement = requestFor({ artifactKind: 'SettlementEvidence', phase: 'pay-dem', walletAddress: world.address, writer: world.claim, sourceBinding: world.sourceBinding });
  const kindOf = (request, kind) => ({ ...request, content: { ...request.content, kind } });
  const refused = {
    'an unknown kind': kindOf(adapter, 'TEST-unknown-storage-create'),
    'devnet-demo-artifact-storage-create with the payment-evidence shape': kindOf(adapter, 'devnet-demo-artifact-storage-create'),
    'devnet-settlement-evidence-storage-create with the payment-evidence shape': kindOf(adapter, 'devnet-settlement-evidence-storage-create'),
    'payment-evidence-storage-create with the settlement-evidence shape': kindOf(settlement, 'payment-evidence-storage-create'),
  };
  const signLinesBefore = (await world.ledger.signLines()).length;
  for (const [label, request] of Object.entries(refused)) await assert.rejects(prepareRetained(world, request), { code: 'invalid_params' }, label);
  assert.equal((await world.ledger.signLines()).length, signLinesBefore, 'no authorization was held for any of them');
});

test('a payment-evidence request approved at one OS debit and confirmed with a changed debit field (each debit field in turn) broadcasts zero and keeps the original authorization held', async t => {
  const world = await ledgerWorld(t), input = world.evidenceInput();
  world.faults.confirm = () => { throw CUT; };
  await assert.rejects(world.anchor(input));
  delete world.faults.confirm;
  const id = await onlyAuthorization(world);
  const binding = { ledgerId: id, requestText: (await world.ledger.signLines())[0].requestBytes };
  const approved = JSON.parse(binding.requestText);
  for (const field of Object.keys(approved.content.debit)) {
    const debit = { ...approved.content.debit, [field]: String(BigInt(approved.content.debit[field]) + 1n) };
    const changed = JSON.stringify({ ...approved, content: { ...approved.content, debit } });
    await assert.rejects(world.approve.retained.confirm({ ledgerId: id, requestText: changed }, {}), { code: 'approval_reservation_unavailable' }, field);
    await assertHeld(world, id, `after a changed ${field}`);
  }
  assert.equal(world.node.broadcasts.length, 0, 'zero broadcasts');
  await world.reopen();
  assertSent(await world.anchor(input));
  assert.equal((await world.reconcile(input)).status, 'applied');
  assert.deepEqual((await world.ledger.completions(id)).map(line => line.outcome), ['spent'], 'the original authorization is the one that settled');
});

test('under the L4 testnet policy a payment-evidence-storage-create decision is logged with its exact bytes and hash, and no auto-approve path exists for the kind', async t => {
  const world = await ledgerWorld(t);
  const request = await adapterRequest(world);
  const [sign] = await world.ledger.signLines();
  assert.equal(sign.requestBytes, JSON.stringify(request), 'the approval line holds the exact request bytes');
  assert.equal(sign.approvalHash, sha256(sign.requestBytes), 'and their hash');

  // With no payment observed the policy refuses the same request on both paths, and nobody is asked: the operator callback fails the test.
  world.purchaseState.purchase = { ...world.purchaseState.paid, paymentObserved: false, paymentTxRef: null, prePaymentOpen: true };
  await assert.rejects(prepareRetained(world, request), { code: 'approval_refused' });
  assert.equal(await world.approve(request), false);
  const refusal = (await world.ledger.lines()).find(line => line.decision === 'rejected');
  assert.equal(refusal?.policyReason, 'payment-not-observed');
  assert.equal(refusal.requestBytes, sign.requestBytes, 'the refusal line holds the exact request bytes');
  assert.equal(refusal.approvalHash, sign.approvalHash, 'and their hash');
  assert.equal((await world.ledger.signLines()).length, 1, 'a refused decision holds nothing');
});
