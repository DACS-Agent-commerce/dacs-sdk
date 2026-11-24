import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { ok, setPurchaseAdmission, T0 } from './helpers/tp1-node-fixture.mjs';
import { assertFenceFree, inPass, openPass } from './helpers/effect-gate-world.mjs';
import { adapterWorld, assertNothingSent, evidenceInput, recordOf, releasedIds, replayWorld, signerOf } from './helpers/payment-evidence-adapter-world.mjs';
import { recordingApproval } from './helpers/payment-evidence-approval-double.mjs';
import { causeChain } from './helpers/node-wallet-signing-spy.mjs';
import { installNoEgress } from './helpers/no-egress.mjs';
import { nativeWalletLaneKey } from '../src/wallet/devnet-native-transport.mjs';
import { signerReservationKey } from '../src/wallet/signer-reservation.mjs';

const egress = installNoEgress();
test.after(() => egress.restore());

const FIRST_NONCE = 1;
const FIRST_LEDGER_ID = 'TEST-ledger-1';
const SECOND_LEDGER_ID = 'TEST-ledger-2';
// A probe that must not wait for the operator's decision is raced against this real-time limit, so a regression fails the row
// instead of deadlocking it.
const PROBE_LIMIT_MS = 1_000;
const answerWith = value => new Response(JSON.stringify(ok(value)), { headers: { 'content-type': 'application/json' } });
// Answers the node read `message` with `respond(row)` once, then lets every later read through.
const onceAt = (w, message, respond) => {
  w.node.intercept = row => {
    if (row.body?.params[0].message !== message) return undefined;
    w.node.intercept = null;
    return respond(row);
  };
};
const signWith = async (w, input, hold, pass) => (await openPass(w, pass ? { pass } : {})).run(() => w.adapter.signCreate(input, { approval: hold }));
const outcomeOf = promise => promise.then(value => ({ value }), reason => ({ reason }));
async function bounded(probe, label) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the probe waited: ${label}`)), PROBE_LIMIT_MS); });
  try { return await Promise.race([probe, late]); } finally { clearTimeout(timer); }
}
const assertRetired = async (w, label) => {
  const record = await recordOf(w);
  assert.equal(record.active, null, `${label}: the reservation is retired`); assert.equal(record.floor, 0, `${label}: the floor is kept`);
};

for (const approvalMs of [2000, 10_001, 30_000]) {
  test(`a manual approval that takes ${approvalMs} ms on the session clock is asked before the effect pass, and the payment-evidence CREATE is then signed once inside a pass that meets its deadline`, async t => {
    const w = await adapterWorld(t, { approval: recordingApproval({ manual: true }) }), input = evidenceInput(w);
    let now = T0;
    w.clock.now = () => now;
    w.approval.script.push(async () => { now += approvalMs; });
    const { approval: hold } = await w.adapter.approveAhead(input);
    assert.equal(hold.requestText, JSON.stringify(w.approval.prepared[0]), 'the hold carries the text the ledger was shown');
    assert.equal(hold.approvalHash, sha256Hex(hold.requestText));
    assert.equal(w.innerSigns.length, 0, 'nothing is signed before the pass');
    const events = [], signed = await (await openPass(w, { events })).run(() => w.adapter.signCreate(input, { approval: hold }));
    const stored = (await recordOf(w)).active.signed;
    assert.deepEqual(signed, { signedTransaction: stored.projectionText, txHash: stored.txHash, nonce: FIRST_NONCE }, 'the stored projection comes back');
    const content = JSON.parse(signed.signedTransaction).content, asked = JSON.parse(hold.requestText).content;
    assert.equal(content.nonce, asked.nonce); assert.equal(content.timestamp, asked.timestamp); assert.equal(JSON.stringify(content.data[1]), asked.exactCreate);
    assert.equal(w.signsInsideSign, 1, 'one inner signature');
    assert.ok(events.includes('authority:sign') && events.includes('stop:sign'), events.join());
    assert.equal(w.approval.prepared.length, 1, 'the ledger was asked once'); assert.equal(w.approval.decisions, 1);
    assertNothingSent(w);
  });
}

// The fork changes the form of the signed fee and edit amounts but not the request's OS amounts, so only the inputs show it.
const movesAfterApproval = {
  'signer nonce': { textMoves: true, feeForm: 'string', move: w => { w.node.nonce += 1; } },
  'network fee': { textMoves: true, feeForm: 'string', move: w => { w.node.intercept = row => (row.body?.params[0].message === 'getNetworkParameters' ? answerWith({ networkFee: 2, rpcFee: 0, additionalFee: 0 }) : undefined); } },
  'denomination fork': { textMoves: false, feeForm: 'number', move: w => { w.node.intercept = row => (row.body?.params[0].message === 'getNetworkInfo'
    ? answerWith({ forks: { osDenomination: { activated: false }, signatureDomain: { activated: false } }, chainId: 1 }) : undefined); } },
};
for (const [change, { textMoves, feeForm, move }] of Object.entries(movesAfterApproval)) {
  test(`a ${change} that moves between the approval and the pass refuses approval_mismatch inside the pass before the inner signature, with nothing signed or sent, the authorization released and the next approval asked again`, async t => {
    const w = await adapterWorld(t), input = evidenceInput(w);
    const { approval: hold } = await w.adapter.approveAhead(input);
    move(w);
    await assert.rejects(signWith(w, input, hold), { code: 'approval_mismatch' });
    assert.equal(w.innerSigns.length, 0, 'no inner signature'); assertNothingSent(w);
    await assertRetired(w, change);
    assert.deepEqual(releasedIds(w), [FIRST_LEDGER_ID], 'the authorization is released once');
    const { approval: again } = await w.adapter.approveAhead(input);
    assert.equal(w.approval.prepared.length, 2, 'the ledger is asked again');
    assert.equal(again.requestText !== hold.requestText, textMoves, 'the new request carries the moved nonce or fee');
    const signed = await signWith(w, input, again), content = JSON.parse(signed.signedTransaction).content;
    assert.equal(w.signsInsideSign, 1, 'the new approval signs once'); assertNothingSent(w);
    assert.equal(typeof content.transaction_fee.network_fee, feeForm, 'the signed fee has the form the chain now reads');
  });
}

const unusedApprovals = {
  'a refused approval': {
    refusedAhead: true,
    async run(w, input) {
      w.approval.script.push('refuse');
      await assert.rejects(w.adapter.approveAhead(input), { code: 'user_rejected' });
    },
  },
  'a hold released unused': {
    async run(w, input, hold) {
      const released = hold.release();
      assert.deepEqual(await released, { released: true });
      assert.deepEqual(releasedIds(w), [FIRST_LEDGER_ID], 'the authorization is released once');
      assert.equal(hold.release(), released, 'a repeat returns the first answer'); assert.equal(w.approval.settlements.length, 1, 'and settles nothing');
      const calls = w.node.calls.length, record = await recordOf(w);
      await assert.rejects(signWith(w, input, hold), { code: 'approval_required' });
      assert.equal(w.node.calls.length, calls, 'no node call'); assert.deepEqual(await recordOf(w), record, 'no new record');
    },
  },
  'an approval the ledger withdrew before the pass': {
    async run(w, input, hold) {
      await w.approval.settle(w.approval.bindingOf(FIRST_LEDGER_ID), 'released', 'TEST-operator');
      const calls = w.node.calls.length;
      await assert.rejects(signWith(w, input, hold), { code: 'approval_required' });
      assert.equal(w.node.calls.length, calls, 'no node call: the hold is not current and is not taken');
      assert.deepEqual(await hold.release(), { released: true });
    },
  },
  'a manual approval withdrawn before the pass': {
    manual: true,
    async run(w, input, hold) {
      w.approval.withdraw(hold.requestText);
      await w.approval.prepare(JSON.parse(hold.requestText));
      assert.notEqual((await w.approval.open(hold.requestText)).token, w.approval.grants[0].token, 'a new generation is open');
      const calls = w.node.calls.length;
      await assert.rejects(signWith(w, input, hold), { code: 'approval_required' });
      assert.equal(w.node.calls.length, calls, 'no node call');
      assert.deepEqual(await hold.release(), { released: true });
    },
  },
  'a manual approval withdrawn during the pass\'s authority read': {
    manual: true,
    async run(w, input, hold) {
      await assert.rejects(signWith(w, input, hold, { refreshAuthority: () => { w.approval.withdraw(hold.requestText); } }), { code: 'approval_required' });
      assert.equal(w.approval.grants[0].outcome, 'released');
    },
  },
  'an approval another process closed before the pass': {
    async run(w, input, hold) {
      w.approval.closeUncounted(w.approval.bindingOf(FIRST_LEDGER_ID));
      const calls = w.node.calls.length;
      await assert.rejects(signWith(w, input, hold), { code: 'approval_required' });
      assert.ok(!w.node.calls.slice(calls).some(row => row.body?.params[0].message === 'getAddressNonce'), 'refused before the chain nonce read');
    },
  },
  'a manual grant another process replaced before the pass': {
    manual: true,
    async run(w, input, hold) {
      const [first] = w.approval.grants;
      w.approval.closeUncounted({ ledgerId: null, requestText: hold.requestText, token: first.token });
      await w.approval.prepare(JSON.parse(hold.requestText));
      const replacement = w.approval.grants[1];
      await assert.rejects(signWith(w, input, hold), { code: 'approval_required' });
      assert.equal((await w.approval.open(hold.requestText))?.token, replacement.token, 'the other process\'s grant is still open');
    },
  },
};
for (const [how, unused] of Object.entries(unusedApprovals)) {
  test(`${how} signs nothing, leaves no reservation and holds no fence`, async t => {
    const w = await adapterWorld(t, unused.manual ? { approval: recordingApproval({ manual: true }) } : {}), input = evidenceInput(w);
    const hold = unused.refusedAhead ? null : (await w.adapter.approveAhead(input)).approval;
    await unused.run(w, input, hold);
    assert.equal(w.innerSigns.length, 0, 'no inner signature'); assertNothingSent(w);
    await assertRetired(w, how);
    await assertFenceFree(w.currentOwner());
  });
}

test("while the operator decides, no pass, fence, lock or adapter queue is held: the connection fence and the signer's lane and reservation locks are granted to a concurrent request, a native write and another evidence's approval are answered at once with signer_lane_busy and nothing broadcast, and the CREATE then signs once", async t => {
  // "No lane held" as the owner ruled it: no lock is held and nothing waits for the decision, while the signer's next nonce stays
  // reserved, so a second write of the same signer is refused at once instead of served.
  const w = await adapterWorld(t), input = evidenceInput(w), signer = signerOf(w), journal = w.journal(), probes = {};
  w.approval.script.push(async () => {
    probes.fence = await outcomeOf(bounded(assertFenceFree(w.currentOwner()), 'the connection fence'));
    probes.laneLock = await outcomeOf(bounded(journal.withWalletLock(nativeWalletLaneKey(TP1_APPROVED_IDENTITY_RECORD, signer), () => true), 'the native lane lock'));
    probes.reservationLock = await outcomeOf(bounded(journal.withWalletLock(signerReservationKey(TP1_APPROVED_IDENTITY_RECORD, signer), () => true), 'the reservation lock'));
    probes.nativeWrite = await outcomeOf(bounded(inPass(w, () => w.send()), 'a native write'));
    probes.otherApproval = await outcomeOf(bounded(w.adapter.approveAhead(evidenceInput(w, 'b')), 'another approval'));
    probes.nonceRead = await outcomeOf(bounded(w.adapter.readAccountNonce(), 'a nonce read'));
  });
  const { approval: hold } = await w.adapter.approveAhead(input);
  assert.ok(!('reason' in probes.fence), probes.fence.reason?.message);
  assert.equal(probes.laneLock.value, true, probes.laneLock.reason?.message); assert.equal(probes.reservationLock.value, true, probes.reservationLock.reason?.message);
  assert.equal(probes.nativeWrite.value?.success, false, probes.nativeWrite.reason?.message); assert.equal(probes.nativeWrite.value.error.code, 'signer_lane_busy');
  assert.equal(probes.otherApproval.reason?.code, 'signer_lane_busy'); assert.equal(w.approval.prepared.length, 1, 'no second prepare');
  assert.equal(probes.nonceRead.value, 0, probes.nonceRead.reason?.message);
  assert.equal(w.node.broadcasts.length, 0, 'nothing broadcast');
  // The native transfer signs and confirms its own bytes and is refused before its broadcast, so the CREATE's signature is
  // counted from here.
  const signaturesBefore = w.signsInsideSign, signed = await signWith(w, input, hold);
  assert.equal(signed.nonce, FIRST_NONCE); assert.equal(w.signsInsideSign - signaturesBefore, 1, 'the CREATE signs once');
  assert.equal(w.node.broadcasts.length, 0, 'nothing broadcast');
});

test("an approval hold is used once and only for its own input: another evidence's input and a second use each refuse with nothing signed, and the next call asks the ledger again", async t => {
  const w = await adapterWorld(t), a = evidenceInput(w), b = evidenceInput(w, 'b');
  const { approval: first } = await w.adapter.approveAhead(a);
  await assert.rejects(signWith(w, b, first), { code: 'approval_mismatch' });
  assert.equal(w.innerSigns.length, 0); await assertRetired(w, 'another input'); assert.deepEqual(releasedIds(w), [FIRST_LEDGER_ID]);
  const { approval: second } = await w.adapter.approveAhead(a);
  assert.equal(w.approval.prepared.length, 2, 'the ledger is asked again');
  const signed = await signWith(w, a, second);
  assert.equal(w.signsInsideSign, 1);
  const stored = await recordOf(w), calls = w.node.calls.length;
  await assert.rejects(signWith(w, a, second), { code: 'approval_required' });
  assert.equal(w.node.calls.length, calls, 'no node call'); assert.deepEqual(await recordOf(w), stored, 'the stored bytes are unchanged');
  assert.deepEqual(await w.adapter.approveAhead(a), { answer: signed }, 'the stored bytes come back');
  assert.equal(w.approval.prepared.length, 2, 'and nothing is asked'); assertNothingSent(w);
});

const cutsInThePass = {
  'a stop after the approval and before the pass': {
    async run(w, input, hold, flag) {
      flag.on = true;
      const calls = w.node.calls.length;
      await assert.rejects(signWith(w, input, hold), { code: 'approval_required' });
      assert.equal(w.node.calls.length, calls, 'no node call');
      assert.deepEqual(await hold.release(), { released: true });
    },
  },
  'a stop after the gate\'s last await': {
    async run(w, input, hold, flag) {
      await assert.rejects(signWith(w, input, hold, { finalStop: () => { flag.on = true; } }), { code: 'approval_required' });
    },
  },
  'a wallet locked after the approval': {
    async run(w, input, hold) {
      w.session.wallet.lock();
      await assert.rejects(signWith(w, input, hold), { code: 'locked' });
      assert.deepEqual(await hold.release(), { released: true });
    },
  },
  'a ledger authorization released during the pass\'s final stop step': {
    async run(w, input, hold) {
      const finalStop = () => w.approval.settle(w.approval.bindingOf(FIRST_LEDGER_ID), 'released', 'TEST-operator');
      await assert.rejects(signWith(w, input, hold, { finalStop }), { code: 'approval_required' });
      assert.equal(w.approval.settled.get(FIRST_LEDGER_ID), 'released');
    },
  },
};
for (const [cut, inThePass] of Object.entries(cutsInThePass)) {
  test(`${cut} refuses the CREATE inside the pass with nothing signed`, async t => {
    const flag = { on: false }, w = await adapterWorld(t, { stopped: () => flag.on }), input = evidenceInput(w);
    const { approval: hold } = await w.adapter.approveAhead(input);
    await inThePass.run(w, input, hold, flag);
    assert.equal(w.innerSigns.length, 0, 'no inner signature'); assertNothingSent(w);
    await assertRetired(w, cut);
  });
}

test("a process gone after the approval was bound and before the pass signs nothing; at the next construction the authorization is released once, the old hold refuses with nothing read, and the next approval is asked again and signs at the same nonce", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w);
  const { approval: old } = await w.adapter.approveAhead(input);
  assert.equal((await recordOf(w)).active.approvalId, FIRST_LEDGER_ID, 'the approval is bound before the restart');
  await w.restart();
  assert.equal(w.innerSigns.length, 0);
  assert.deepEqual(releasedIds(w), [FIRST_LEDGER_ID], 'recovery releases the authorization once'); await assertRetired(w, 'after recovery');
  const record = await recordOf(w), calls = w.node.calls.length;
  await assert.rejects(signWith(w, input, old), { code: 'approval_required' });
  assert.equal(w.node.calls.length, calls, 'no node call'); assert.deepEqual(await recordOf(w), record, 'no record change');
  const { approval: next } = await w.adapter.approveAhead(input);
  assert.equal(w.approval.prepared.length, 2, 'the next approval is asked once');
  assert.equal((await signWith(w, input, next)).nonce, FIRST_NONCE); assertNothingSent(w);
});

test("a process gone after a manual grant was bound and before the pass signs nothing: the grant ends with that process, the next construction retires the reservation, the old hold refuses with nothing read, and the operator is asked again and the CREATE signs at the same nonce", async t => {
  const w = await adapterWorld(t, { approval: recordingApproval({ manual: true }) }), input = evidenceInput(w);
  const { approval: old } = await w.adapter.approveAhead(input);
  const [first] = w.approval.grants;
  assert.equal((await recordOf(w)).active.approvalIntent, old.requestText, 'the approval request is stored before the process goes');
  // The kit keeps a manual grant only in the memory of the process that holds it, so the process going ends it without a settlement.
  w.approval.closeUncounted({ ledgerId: null, requestText: first.requestText, token: first.token });
  await w.restart();
  assert.equal(w.innerSigns.length, 0); assert.deepEqual(w.approval.settlements, [], 'nothing was settled');
  await assertRetired(w, 'after recovery');
  const record = await recordOf(w), calls = w.node.calls.length;
  await assert.rejects(signWith(w, input, old), { code: 'approval_required' });
  assert.equal(w.node.calls.length, calls, 'no node call'); assert.deepEqual(await recordOf(w), record, 'no record change');
  const { approval: next } = await w.adapter.approveAhead(input);
  assert.equal(next.requestText, old.requestText, 'the identical request at the same nonce');
  assert.equal(w.approval.decisions, 2, 'the operator is asked again'); assert.notEqual(w.approval.grants[1].token, first.token);
  assert.equal((await signWith(w, input, next)).nonce, FIRST_NONCE); assertNothingSent(w);
});

const askChecks = [
  ['a stop before the claim', 'writes_stopped', { before: stop => { stop.mode = 'on'; } }],
  ['a stop during the fee read', 'writes_stopped', { duringFeeRead: stop => { stop.mode = 'on'; } }],
  ['a stop check that answers a promise', 'stop_check_invalid', { before: stop => { stop.mode = 'promise'; } }],
  ['a stop check that throws', 'stop_check_failed', { before: stop => { stop.mode = 'throw'; } }],
  ['a wallet locked during the fee read', 'locked', { duringFeeRead: (stop, w) => { w.session.wallet.lock(); }, restart: true }],
  ['purchase actions held during the fee read', 'profile_not_admitted', { duringFeeRead: () => { setPurchaseAdmission('held'); } }],
];
for (const [cut, code, { before, duringFeeRead, restart }] of askChecks) {
  test(`approveAhead checks the wallet lock, the purchase hold and a synchronous stop before it reserves and again right before the ledger is asked: ${cut} refuses ${code} with no prepare, no reservation left and nothing signed or sent`, async t => {
    const stop = { mode: 'off' };
    const stopped = () => {
      if (stop.mode === 'throw') throw new Error('TEST-stop-check-broken');
      if (stop.mode === 'promise') return Promise.reject(new Error('TEST-stop-check-promise'));
      return stop.mode === 'on';
    };
    const w = await adapterWorld(t, { stopped }), input = evidenceInput(w), calls = w.node.calls.length;
    const unhandled = [], onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    before?.(stop);
    if (duringFeeRead) onceAt(w, 'getNetworkParameters', () => { duringFeeRead(stop, w); return undefined; });
    await assert.rejects(w.adapter.approveAhead(input), { code });
    if (before) {
      assert.equal(await recordOf(w), null, 'nothing was reserved'); assert.equal(w.node.calls.length, calls, 'no fee or nonce read');
    } else {
      await assertRetired(w, cut); assert.deepEqual(w.approval.settlements, [], 'no id was bound, so nothing is settled');
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'the stop check\'s promise is not left unhandled');
    assert.deepEqual(w.approval.prepared, [], 'no prepare'); assert.equal(w.innerSigns.length, 0); assertNothingSent(w);
    stop.mode = 'off'; setPurchaseAdmission('testnet-tp1');
    if (restart) await w.restart();
    const { approval: hold } = await w.adapter.approveAhead(input);
    assert.equal(w.approval.prepared.length, 1, 'the next approval asks once');
    await signWith(w, input, hold);
    // The spy on inner signatures is prototype-wide, so it also counts after a restart.
    assert.equal(w.innerSigns.length, 1, 'and signs once');
  });
}

test("approveAhead refuses approval_required before it reserves or asks anything when the approval ledger cannot report a withdrawal synchronously", async t => {
  const approval = recordingApproval();
  delete approval.revocationGeneration;
  const w = await adapterWorld(t, { approval }), calls = w.node.calls.length;
  await assert.rejects(w.adapter.approveAhead(evidenceInput(w)), { code: 'approval_required' });
  assert.equal(await recordOf(w), null, 'nothing was reserved'); assert.equal(w.node.calls.length, calls, 'nothing was read');
  assert.deepEqual(approval.prepared, [], 'nothing was asked');
});

test("release() of an unused hold never rejects: a retirement that fails resolves released false with its cause readable through internalCauseOf, the refusal of a pass that ended before the hold was taken is the one its caller sees, and the next construction retires the reservation and releases the authorization once", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w);
  const { approval: hold } = await w.adapter.approveAhead(input);
  w.approval.settleFailures = 1;
  let answer;
  const pass = await openPass(w);
  await assert.rejects(pass.run(async () => {
    try { throw new Error('TEST-pass-refused'); } finally { answer = await hold.release(); }
  }), /TEST-pass-refused/);
  assert.deepEqual(answer, { released: false }); assert.ok(Object.isFrozen(answer));
  assert.equal(w.session.internalCauseOf(answer)?.code, 'signer_settlement_failed');
  assert.equal(await hold.release(), answer, 'a repeat returns the same answer');
  const kept = (await recordOf(w)).active;
  assert.equal(kept.approvalId, FIRST_LEDGER_ID); assert.equal(kept.approvalIntent, hold.requestText);
  await w.restart();
  assert.deepEqual(releasedIds(w), [FIRST_LEDGER_ID], 'recovery releases the authorization once'); await assertRetired(w, 'after recovery');
  const { approval: next } = await w.adapter.approveAhead(input);
  assert.equal(w.approval.prepared.length, 2);
  assert.equal((await signWith(w, input, next)).nonce, FIRST_NONCE); assertNothingSent(w);
});

test("an approveAhead aborted while the ledger has not answered keeps the reservation as signer_reservation_uncertain and asks nothing more; after the next construction's recovery the next approval signs at the same nonce", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w), stop = new AbortController();
  w.approval.script.push(() => { stop.abort(new Error('TEST-deadline')); return new Promise(() => {}); });
  await assert.rejects(w.adapter.approveAhead(input, { signal: stop.signal }), error => error.code === 'signer_reservation_uncertain' && /TEST-deadline/.test(error.cause?.message));
  const kept = await recordOf(w);
  assert.equal(kept.active.approvalIntent, w.approval.entries[0].requestText, 'the request text is kept'); assert.equal(kept.active.approvalId, null);
  await assert.rejects(w.adapter.approveAhead(input), { code: 'signer_reservation_uncertain' });
  assert.deepEqual(await recordOf(w), kept, 'the second call writes nothing'); assert.equal(w.approval.prepared.length, 1, 'and asks nothing');
  assert.equal(w.innerSigns.length, 0);
  await w.restart();
  assert.deepEqual(releasedIds(w), [FIRST_LEDGER_ID], 'recovery finds the preparation by its exact text and releases it once');
  const { approval: next } = await w.adapter.approveAhead(input);
  assert.equal(w.approval.prepared.length, 2);
  assert.equal((await signWith(w, input, next)).nonce, FIRST_NONCE); assertNothingSent(w);
});

const ownerUses = {
  'use it once': async (w, input, hold) => {
    assert.equal((await signWith(w, input, hold)).nonce, FIRST_NONCE);
    assert.equal(w.signsInsideSign, 1);
  },
  'release it': async (w, input, hold) => {
    assert.deepEqual(await hold.release(), { released: true });
    assert.deepEqual(releasedIds(w), [FIRST_LEDGER_ID], 'released once, with no restart');
  },
};
for (const [kind, then] of [['sign hold', 'use it once'], ['sign hold', 'release it']]) {
  test(`a ${kind} from another composition is refused there without being taken: nothing is read, signed or sent in that composition, and its own adapter can still ${then}`, async t => {
    const w1 = await adapterWorld(t), w2 = await adapterWorld(t), input = evidenceInput(w1);
    const { approval: hold } = await w1.adapter.approveAhead(input);
    const ownRecord = await recordOf(w1), calls = w2.node.calls.length;
    await assert.rejects(signWith(w2, evidenceInput(w2, 'a'), hold), { code: 'approval_required' });
    // The signing spies are prototype-wide, so this count also sees the first composition's signatures: it is read before that one signs.
    assert.equal(w2.innerSigns.length, 0, 'nothing signed');
    assert.equal(w2.node.calls.length, calls, 'nothing read'); assert.equal(await recordOf(w2), null, 'nothing reserved'); assertNothingSent(w2);
    assert.deepEqual(await recordOf(w1), ownRecord, 'the owner\'s reservation is untouched'); assert.deepEqual(w1.approval.settlements, []);
    await ownerUses[then](w1, input, hold);
    assertNothingSent(w1); assert.equal(w2.node.calls.length, calls);
  });
}

const manualHoldEnds = {
  'release() of an unused hold': async (w, input, hold) => { assert.deepEqual(await hold.release(), { released: true }); },
  'a refusal inside the pass before the bytes are stored': async (w, input, hold) => {
    await assert.rejects(signWith(w, evidenceInput(w, 'b'), hold), { code: 'approval_mismatch' });
    assert.equal(w.innerSigns.length, 0, 'no inner signature');
  },
};
for (const [how, end] of Object.entries(manualHoldEnds)) {
  test(`a manual grant ends with its sign hold: after ${how}, the identical request is asked of the operator again, under a new token, and signs once`, async t => {
    const w = await adapterWorld(t, { approval: recordingApproval({ manual: true }) }), input = evidenceInput(w);
    const { approval: hold } = await w.adapter.approveAhead(input);
    const [first] = w.approval.grants;
    assert.equal(w.approval.decisions, 1);
    await end(w, input, hold);
    assert.deepEqual(w.approval.settlements, [{ ledgerId: null, token: first.token, outcome: 'released', reason: 'unsigned-retired' }], 'the grant is settled once, by its token');
    assert.equal(await w.approval.open(hold.requestText), null, 'the grant is closed'); await assertRetired(w, how);
    const { approval: again } = await w.adapter.approveAhead(input);
    assert.equal(again.requestText, hold.requestText, 'the identical request: same nonce, timestamp and fees');
    assert.equal(w.approval.decisions, 2, 'the operator is asked again'); assert.notEqual(w.approval.grants[1].token, first.token, 'under a new token');
    assert.equal((await signWith(w, input, again)).nonce, FIRST_NONCE);
    assert.equal(w.signsInsideSign, 1); assertNothingSent(w);
  });
}

// The send hold. The kept bytes are signed in one call under the first authorization and not sent, so the scripted chain
// answers that it has not seen them.
const keptBytes = w => inPass(w, () => w.adapter.signCreate(evidenceInput(w)));
const broadcastWith = async (w, signed, hold, pass) => (await openPass(w, pass ? { pass } : {})).run(() => w.adapter.broadcast(signed, { approval: hold }));
const releaseFirst = w => w.approval.settle(w.approval.bindingOf(FIRST_LEDGER_ID), 'released', 'TEST-operator');

test("a replacement approval for kept bytes whose authorization the ledger released is asked before the broadcast pass and outside the adapter queue, and the broadcast in the pass asks the ledger nothing new and sends the same bytes once", async t => {
  const w = await replayWorld(t), signed = await keptBytes(w), probes = {};
  await releaseFirst(w);
  w.approval.script.push(async () => {
    probes.fence = await outcomeOf(bounded(assertFenceFree(w.currentOwner()), 'the connection fence'));
    probes.otherSignature = await outcomeOf(bounded(inPass(w, () => w.adapter.signCreate(evidenceInput(w, 'b'))), 'another evidence\'s signature'));
  });
  const { approval: hold } = await w.adapter.approveSendAhead(signed);
  assert.ok(!('reason' in probes.fence), probes.fence.reason?.message);
  assert.equal(probes.otherSignature.reason?.code, 'signer_lane_busy', 'the queue is free: another call is answered at once');
  assert.equal(w.approval.prepared.length, 2, 'the replacement is prepared once');
  assert.equal((await recordOf(w)).active.approvalId, SECOND_LEDGER_ID, 'and linked before the pass'); assertNothingSent(w);
  const reopens = w.approval.reopened.length;
  assert.deepEqual(await broadcastWith(w, signed, hold), { status: 'accepted', txHash: signed.txHash });
  assert.equal(w.approval.prepared.length, 2, 'the broadcast asks for no new authorization');
  assert.deepEqual(w.approval.reopened.slice(reopens), [SECOND_LEDGER_ID], 'it reopens the linked replacement');
  assert.equal(w.approval.confirmations.at(-1).binding.ledgerId, SECOND_LEDGER_ID);
  assert.equal(w.node.broadcasts.length, 1); assert.equal(JSON.stringify(w.node.broadcasts[0]), signed.signedTransaction, 'the kept bytes');
  assert.equal(w.signsInsideSign, 1, 'no second signature');
});

const heldSendCuts = {
  'the ledger released before the pass': async (w, signed, hold) => {
    await releaseFirst(w);
    const calls = w.node.calls.length;
    await assert.rejects(broadcastWith(w, signed, hold), { code: 'approval_required' });
    assert.equal(w.node.calls.length, calls, 'no node call: the hold is not current and is not taken');
    assert.deepEqual(await hold.release(), { released: true }, 'the hold that was not taken still releases');
  },
  'another process closed before the pass': async (w, signed, hold) => {
    w.approval.closeUncounted(w.approval.bindingOf(FIRST_LEDGER_ID));
    await assert.rejects(broadcastWith(w, signed, hold), { code: 'approval_required' });
    assert.equal(w.node.confirms.length, 0, 'refused before the confirmation');
  },
  'the ledger released during the broadcastTx final stop step': async (w, signed, hold) => {
    const finalStop = ({ phase }) => (phase === 'broadcastTx' ? releaseFirst(w) : undefined);
    await assert.rejects(broadcastWith(w, signed, hold, { finalStop }), { code: 'approval_required' });
    assert.equal(w.node.confirms.length, 1, 'the confirmation ran once'); assert.equal(w.approval.confirmations.length, 1, 'and the ledger confirmed once');
  },
};
for (const [how, cut] of Object.entries(heldSendCuts)) {
  test(`a broadcast carrying a send hold whose authorization ${how} refuses approval_required inside the pass, asks for no new authorization and sends nothing`, async t => {
    const w = await replayWorld(t), signed = await keptBytes(w);
    const { approval: hold } = await w.adapter.approveSendAhead(signed);
    const record = await recordOf(w);
    await cut(w, signed, hold);
    assert.equal(w.node.broadcasts.length, 0, 'nothing broadcast'); assert.equal(w.approval.prepared.length, 1, 'no new authorization');
    assert.deepEqual(await recordOf(w), record, 'the record and its bytes are unchanged');
  });
}

const sendAskChecks = [
  ['a stop before the reads', 'writes_stopped', { before: stop => { stop.mode = 'on'; } }],
  ['a stop during the chain read', 'writes_stopped', { duringChainRead: stop => { stop.mode = 'on'; } }],
  ['a stop check that answers a promise', 'stop_check_invalid', { before: stop => { stop.mode = 'promise'; } }],
];
for (const [cut, code, { before, duringChainRead }] of sendAskChecks) {
  test(`approveSendAhead checks the wallet lock, the purchase hold and a synchronous stop before its reads and again right before it asks for a replacement: ${cut} refuses ${code} with no prepare and the kept bytes and their record unchanged`, async t => {
    const stop = { mode: 'off' };
    const stopped = () => (stop.mode === 'promise' ? Promise.reject(new Error('TEST-stop-check-promise')) : stop.mode === 'on');
    const w = await adapterWorld(t, { stopped }), signed = await keptBytes(w);
    await releaseFirst(w);
    const record = await recordOf(w), calls = w.node.calls.length;
    before?.(stop);
    if (duringChainRead) onceAt(w, 'getTransactionStatus', () => { duringChainRead(stop); return undefined; });
    await assert.rejects(w.adapter.approveSendAhead(signed), { code });
    if (before) assert.equal(w.node.calls.length, calls, 'nothing was read');
    assert.equal(w.approval.prepared.length, 1, 'no prepare'); assert.deepEqual(await recordOf(w), record, 'the kept bytes and their record are unchanged');
    assertNothingSent(w);
  });
}

test("a send hold from another composition is refused there without being taken: nothing is read, signed or sent in that composition, and its own adapter can still use it once", async t => {
  const w1 = await replayWorld(t), w2 = await replayWorld(t), signed = await keptBytes(w1);
  const { approval: hold } = await w1.adapter.approveSendAhead(signed);
  const ownRecord = await recordOf(w1), calls = w2.node.calls.length, signatures = w2.innerSigns.length;
  await assert.rejects(broadcastWith(w2, signed, hold), { code: 'approval_required' });
  assert.equal(w2.node.calls.length, calls, 'nothing read'); assert.equal(w2.innerSigns.length, signatures, 'nothing signed'); assert.equal(await recordOf(w2), null, 'nothing reserved');
  assertNothingSent(w1); assertNothingSent(w2);
  assert.deepEqual(await recordOf(w1), ownRecord, 'the owner\'s reservation is untouched');
  assert.deepEqual(await broadcastWith(w1, signed, hold), { status: 'accepted', txHash: signed.txHash });
  assert.equal(w1.node.broadcasts.length, 1); assert.equal(JSON.stringify(w1.node.broadcasts[0]), signed.signedTransaction, 'the kept bytes, once');
  assert.equal(w2.node.calls.length, calls);
});

test("a process gone after approveSendAhead linked a replacement and before the broadcast pass sends nothing; at the next construction the old hold refuses with nothing read, and the next approveSendAhead reopens the linked replacement with no second preparation and sends the kept bytes once", async t => {
  const w = await replayWorld(t), signed = await keptBytes(w);
  await releaseFirst(w);
  const { approval: old } = await w.adapter.approveSendAhead(signed);
  assert.equal((await recordOf(w)).active.approvalId, SECOND_LEDGER_ID, 'the replacement is linked before the restart');
  await w.restart();
  assertNothingSent(w);
  const record = await recordOf(w), calls = w.node.calls.length;
  await assert.rejects(broadcastWith(w, signed, old), { code: 'approval_required' });
  assert.equal(w.node.calls.length, calls, 'no node call'); assert.deepEqual(await recordOf(w), record, 'no record change');
  const { approval: next } = await w.adapter.approveSendAhead(signed);
  assert.equal(w.approval.prepared.length, 2, 'no second preparation');
  assert.deepEqual(await broadcastWith(w, signed, next), { status: 'accepted', txHash: signed.txHash });
  assert.equal(w.node.broadcasts.length, 1); assert.equal(w.approval.confirmations.at(-1).binding.ledgerId, SECOND_LEDGER_ID);
});

test("an approveSendAhead aborted while the ledger has not answered rejects with the abort's reason and gives no hold; the next approveSendAhead uses the replacement that was committed with no second preparation and sends the kept bytes once", async t => {
  const w = await replayWorld(t), signed = await keptBytes(w), stop = new AbortController();
  await releaseFirst(w);
  w.approval.script.push(() => { stop.abort(new Error('TEST-deadline')); return new Promise(() => {}); });
  await assert.rejects(w.adapter.approveSendAhead(signed, { signal: stop.signal }), error => causeChain(error).some(link => /TEST-deadline/.test(link.message)));
  assertNothingSent(w);
  const { approval: hold } = await w.adapter.approveSendAhead(signed);
  assert.equal(w.approval.prepared.length, 2, 'no second preparation');
  assert.equal((await recordOf(w)).active.approvalId, SECOND_LEDGER_ID, 'the committed replacement is linked');
  assert.deepEqual(await broadcastWith(w, signed, hold), { status: 'accepted', txHash: signed.txHash });
  assert.equal(w.node.broadcasts.length, 1);
});

test("a process gone while the ledger decides a replacement for kept bytes sends nothing; at the next construction the replacement it committed is found by its exact request and linked with no second preparation, and the broadcast sends the kept bytes once", async t => {
  const w = await replayWorld(t), signed = await keptBytes(w);
  await releaseFirst(w);
  let asked;
  const deciding = new Promise(resolve => { asked = resolve; });
  w.approval.script.push(() => { asked(); return new Promise(() => {}); });
  w.adapter.approveSendAhead(signed).catch(() => {});
  await deciding;
  await w.restart();
  assert.equal((await recordOf(w)).active.approvalId, FIRST_LEDGER_ID, 'nothing was linked before the process went'); assertNothingSent(w);
  const { approval: hold } = await w.adapter.approveSendAhead(signed);
  assert.equal(w.approval.prepared.length, 2, 'no second preparation');
  assert.equal((await recordOf(w)).active.approvalId, SECOND_LEDGER_ID, 'the committed replacement is linked');
  assert.deepEqual(await broadcastWith(w, signed, hold), { status: 'accepted', txHash: signed.txHash });
  assert.equal(w.node.broadcasts.length, 1);
});
