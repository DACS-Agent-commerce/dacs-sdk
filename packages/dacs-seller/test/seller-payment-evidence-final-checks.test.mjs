// The checks the payment-evidence journal and its pass make before a signature or a send: the pass's last synchronous run (the
// caller's check and the journal's closing check, after the final stop await), the private check every pass call needs, and the
// journal's approval options. They run over the real chain at journal and session level, with the scripted node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceInput, jsonResponse, privateDataDirectory, replyTo, sellerWalletWorld, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';
import { walletSessionWorld } from './helpers/seller-wallet-session-world.mjs';
import { causeCodes, holdableStop, journalOverPass } from './helpers/payment-evidence-test-journals.mjs';

const { createSignedCreateJournal } = await import('../src/dacs/payment-evidence-wallet-journal.mjs');
const { OperationError } = await import('../src/operations.mjs');

const REFUSED_BROADCAST = () => jsonResponse({ result: 400, response: 'TEST-refused' });
const transmissions = (node) => node.reads.filter((read) => read === 'confirmTx' || read === 'broadcastTx').length;
const ensure = (journal, input, authorize = () => true) => journal.ensureEvidence({ ...input, expectedJournalId: journal.journalId, authorize });
const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
// Inner transaction signatures, counted beneath the client gate.
async function innerTransactionSignatures(t) {
  const counted = { signatures: 0 };
  await spyTransactionSignatures(t.mock, () => {}, { onInnerSign: ({ inTransaction }) => { if (inTransaction) counted.signatures++; } });
  return counted;
}
// Keeps a signed, unsent CREATE for `input`: the node refuses its first broadcast.
async function keepUnsent(node, call) {
  replyTo(node, 'broadcastTx', REFUSED_BROADCAST);
  await settled(call());
  node.reply = null;
}

test('the payment-evidence pass refuses a collision during a held send before transmission, and a pass call without the private check is withheld before any approval, signature or send', async (t) => {
  const counted = await innerTransactionSignatures(t);
  // A competing settlement claim during the send pass's final stop await: the pass's last synchronous check refuses.
  const world = await sellerWalletWorld(t), stop = holdableStop(), input = evidenceInput(world);
  const { journal } = journalOverPass(world, { stopped: stop.stopped });
  let collided = false;
  const authorize = () => { if (collided) throw new OperationError('settlement_collision', 'TEST-the payment is claimed by another job'); return true; };
  await keepUnsent(world.node, () => ensure(journal, input, authorize));
  const kept = await journal.readSignedProjection(input);
  assert.ok(kept, 'a signed CREATE is kept unsent');
  const before = { transmissions: transmissions(world.node), signatures: counted.signatures };
  const held = stop.holdNext();
  const send = settled(ensure(journal, input, authorize));
  const { release } = await held;
  collided = true;
  release();
  const { error } = await send;
  assert.ok(causeCodes(error).includes('settlement_collision'), `refused at the last synchronous check: ${causeCodes(error)}`);
  assert.deepEqual({ transmissions: transmissions(world.node), signatures: counted.signatures }, before, 'nothing more was signed, confirmed or broadcast');
  assert.deepEqual(await journal.readSignedProjection(input), kept, 'the kept row and hash are unchanged');
  await world.wallet.close();

  // Over the session: a call with no authorization check asks, signs and sends nothing.
  const sessionWorld = await walletSessionWorld(t);
  const { session } = await sessionWorld.finalize();
  const sessionInput = evidenceInput({ wallet: session }), ledger = sessionWorld.options.approve.retained;
  const plain = await settled(session.paymentEvidence.anchorEvidence(sessionInput));
  assert.equal(plain.error?.code, 'context_authorization_required', 'the plain anchorEvidence is refused before the ask');
  assert.deepEqual({ asked: ledger.prepared.length, transmissions: transmissions(sessionWorld.node), signatures: counted.signatures }, { asked: 0, transmissions: 0, signatures: before.signatures });
  await keepUnsent(sessionWorld.node, () => ensure(session.paymentEvidence, sessionInput));
  const sessionKept = await session.paymentEvidence.readSignedProjection(sessionInput);
  const asked = ledger.prepared.length, sent = transmissions(sessionWorld.node);
  const reconciled = await session.paymentEvidence.reconcilePaymentEvidence(sessionInput);
  assert.equal(reconciled.status, 'pending', 'the reconcile resend has no check, so it answers pending');
  assert.match(reconciled.reason, /current-authorization check/);
  assert.deepEqual({ asked: ledger.prepared.length, transmissions: transmissions(sessionWorld.node) }, { asked, transmissions: sent }, 'nothing was asked or sent');
  assert.deepEqual(await session.paymentEvidence.readSignedProjection(sessionInput), sessionKept, 'the kept row and hash are unchanged');
});

test('an approval wait that ends while the signature pass holds its final stop makes no signature and keeps nothing', async (t) => {
  const counted = await innerTransactionSignatures(t);
  for (const ends of [true, false]) {
    const world = await sellerWalletWorld(t), stop = holdableStop(), approvals = new AbortController(), input = evidenceInput(world);
    const { journal } = journalOverPass(world, { stopped: stop.stopped, approvalSignal: approvals.signal });
    const before = counted.signatures;
    const held = stop.holdNext();
    const call = settled(ensure(journal, input));
    const { release } = await held;
    // The reason the session's endApprovalWaits gives.
    if (ends) approvals.abort(new OperationError('operator_closing', 'TEST-the seller host is closing'));
    release();
    const outcome = await call;
    if (ends) {
      assert.ok(causeCodes(outcome.error).includes('operator_closing'), `refused at the pass's last check: ${causeCodes(outcome.error)}`);
      assert.equal(counted.signatures, before, 'no inner signature');
      assert.equal(await journal.readSignedProjection(input), null, 'nothing was kept');
      assert.deepEqual([...world.approval.settled.values()], ['released'], 'the reservation was retired and its approval released');
    } else {
      assert.equal(outcome.value?.status, 'submitted', 'the unchanged control signs and sends');
      assert.equal(counted.signatures - before, 1, 'the control signs once');
    }
    await world.wallet.close();
  }
});

test('the wallet journal refuses approveAhead without approveSendAhead, the reverse, and an approvalSignal that is not an AbortSignal, before it opens anything', async (t) => {
  const directory = privateDataDirectory(t), asked = { count: 0 };
  const ask = async () => { asked.count++; return {}; };
  const options = (name) => ({ table: 'evidence_creates', path: join(directory, name), signCreate: async () => {}, broadcast: async () => {}, readAccountNonce: async () => 0,
    readTransactionState: async () => 'pending' });
  const pair = 'the wallet journal takes approveAhead and approveSendAhead together, or neither';
  const refused = [
    ['only-ask.sqlite', { approveAhead: ask }, pair],
    ['only-send.sqlite', { approveSendAhead: ask }, pair],
    ['not-a-signal.sqlite', { approveAhead: ask, approveSendAhead: ask, approvalSignal: {} }, 'the wallet journal approvalSignal must be an AbortSignal'],
  ];
  for (const [name, given, message] of refused) {
    assert.throws(() => createSignedCreateJournal({ ...options(name), ...given }), (error) => error instanceof TypeError && error.message === message, name);
    assert.equal(existsSync(join(directory, name)), false, `${name}: no file was opened`);
  }
  assert.equal(asked.count, 0, 'nothing was asked');
  const control = createSignedCreateJournal({ ...options('control.sqlite'), approveAhead: ask, approveSendAhead: ask, approvalSignal: new AbortController().signal });
  assert.equal(typeof control.ensureEvidence, 'function', 'both approve options and a real AbortSignal construct');
  control.close();
});
