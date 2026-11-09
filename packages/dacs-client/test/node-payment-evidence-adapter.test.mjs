import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { api, mnemonicBytes, ok, setPurchaseAdmission } from './helpers/tp1-node-fixture.mjs';
import { gateWorld, inPass, openPass, sellerPublications } from './helpers/effect-gate-world.mjs';
import { causeChain } from './helpers/node-wallet-signing-spy.mjs';
import { recordingApproval } from './helpers/payment-evidence-approval-double.mjs';
import { installNoEgress } from './helpers/no-egress.mjs';
import { nativeWalletLaneKey } from '../src/wallet/devnet-native-transport.mjs';
import { createSignerReservations } from '../src/wallet/signer-reservation.mjs';

// The kit journal refuses every send while the kit's operation guard is off. This test-only loader hook admits it in this process, so it is
// registered before the journal module is loaded.
await import('../../dacs-seller/test/helpers/kit-guard-fixture.mjs');
const { createPaymentEvidenceWalletJournal } = await import('../../dacs-seller/src/dacs/payment-evidence-wallet-journal.mjs');

const egress = installNoEgress();
test.after(() => egress.restore());

const OWNER_KEY_PREFIX = 'devnet/signer-reservation/', DISPATCH_PREFIX = 'devnet/signer-reservation-dispatch/';
const FIRST_NONCE = 1;
// Network fee 1 DEM, RPC fee 0, one DEM of gas and one DEM of storage fee for a small artifact.
const FULL_DEBIT_OS = '3000000000';
const answerWith = value => new Response(JSON.stringify(ok(value)), { headers: { 'content-type': 'application/json' } });

async function adapterWorld(t, options = {}) {
  const approval = recordingApproval();
  const w = await gateWorld(t, { ...options, sessionOptions: { paymentEvidenceApproval: approval, ...options.sessionOptions } });
  Object.defineProperty(w, 'adapter', { get: () => w.session.paymentEvidenceAdapter });
  return Object.assign(w, { approval });
}
const evidenceInput = (w, label = 'a', extra = {}) => ({ logicalAddress: `dacs4:payment:TEST-job-${label}:demos-native:DEM:2`, artifact: { TEST: `evidence-${label}` },
  writer: `did:demos:agent:${w.session.wallet.getPublicAccount().address.slice(2)}`, artifactKind: 'SettlementEvidence', jobId: `TEST-job-${label}`, receiptContentHash: 'e1'.repeat(32), ...extra });
const signIn = (w, input, options) => inPass(w, () => w.adapter.signCreate(input, options));
const ownerOf = async w => (await w.journal().entries()).find(([key]) => key.startsWith(OWNER_KEY_PREFIX))?.[1] ?? null;
const attemptOf = async (w, owner) => w.journal().get(`${DISPATCH_PREFIX}${owner.active.attemptId}`);
const sdkMessage = (w, message, respond) => { w.node.intercept = row => (row.body.params[0].message === message ? respond(row) : undefined); };
const releasedIds = w => w.approval.settlements.calls.filter(call => call.outcome === 'released').map(call => call.ledgerId);
const assertNothingSent = w => { assert.equal(w.node.confirms.length, 0, 'no confirmation'); assert.equal(w.node.broadcasts.length, 0, 'no broadcast'); };
const codes = error => causeChain(error).map(link => link.code);
// A reservation instance over the world's journal, standing for a process that wrote its records and then died.
const deadProcess = w => createSignerReservations({ journal: w.journal(), pins: TP1_APPROVED_IDENTITY_RECORD, clock: w.clock,
  openApproval: requestText => w.approval.open(requestText), settleApproval: (ledgerId, outcome, reason) => w.approval.settle(ledgerId, outcome, reason) });
const signerOf = w => w.session.wallet.getPublicAccount().address;

test("an approval refusal or throw, a fee or fork read failure, a gate refusal before signing, a signer failure and an abort before signing each retire the unsigned reservation and settle any bound authorization released; a different evidence address then signs at the same nonce", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w);
  const unsignedExits = {
    'approval refusal': { arrange: () => w.approval.script.push('refuse'), code: 'user_rejected' },
    'approval throw': { arrange: () => w.approval.script.push('throw'), code: 'user_rejected', cause: /TEST-approval-failed/ },
    'fee read failure': { arrange: () => sdkMessage(w, 'getNetworkParameters', () => { throw new Error('TEST-fee-read-failed'); }), cause: /TEST-fee-read-failed/ },
    'fork read failure': { arrange: () => sdkMessage(w, 'getNetworkInfo', () => { throw new Error('TEST-fork-read-failed'); }), cause: /TEST-fork-read-failed/ },
    'gate refusal': { arrange: () => {}, run: () => w.adapter.signCreate(input), code: 'effect_pass_required', released: true },
    'signer failure': { arrange: () => w.nodeDemosPrototype.sign.mock.mockImplementationOnce(async () => { throw new Error('TEST-signer-failed'); }), cause: /TEST-signer-failed/, released: true },
    'abort before signing': { arrange: () => { const stop = new AbortController(); w.stop = stop; sdkMessage(w, 'getNetworkInfo', () => { stop.abort(new Error('TEST-abort')); }); }, cause: /TEST-abort/ },
  };
  for (const [name, exit] of Object.entries(unsignedExits)) {
    w.node.intercept = null; w.stop = undefined;
    exit.arrange();
    const settledBefore = w.approval.settlements.calls.length, boundBefore = w.approval.entries.length;
    const error = await (exit.run ?? (() => signIn(w, input, { signal: w.stop?.signal })))().then(() => assert.fail(`${name} signed`), caught => caught);
    if (exit.code) assert.ok(codes(error).includes(exit.code), `${name}: ${codes(error)}`);
    if (exit.cause) assert.ok(causeChain(error).some(link => exit.cause.test(link.message)), `${name}: the cause is kept`);
    assert.equal(w.signsInsideSign, 0, `${name}: inner signatures 0`);
    assert.equal((await ownerOf(w)).active, null, `${name}: the unsigned reservation is retired`);
    if (w.approval.entries.length > boundBefore) assert.deepEqual(releasedIds(w).slice(-1), [w.approval.entries.at(-1).ledgerId], `${name}: the authorization is released`);
    else assert.equal(w.approval.settlements.calls.length, settledBefore, `${name}: nothing was bound, nothing is settled`);
    if (exit.released) assert.equal(w.approval.settlements.calls.at(-1).reason, 'unsigned-retired');
  }
  assert.equal(new Set(releasedIds(w)).size, releasedIds(w).length, 'every authorization is released once');
  w.node.intercept = null;
  const other = await signIn(w, evidenceInput(w, 'b'));
  assert.equal(other.nonce, FIRST_NONCE, 'a different evidence address signs at the same nonce');
  assert.equal(w.signsInsideSign, 1); assertNothingSent(w);
});

function failingJournal() {
  const faults = { failPut: null, failed: false, getDown: false };
  const wrap = journal => new Proxy(journal, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (key === 'put' || key === 'appendUnderLock') return (...args) => {
      const [storedKey, storedValue] = key === 'put' ? args : args.slice(1);
      if (faults.failPut?.(storedKey, storedValue) && !faults.failed) { faults.failed = true; throw new Error('TEST-put-failed'); }
      return Reflect.apply(value, target, args);
    };
    if (key === 'get') return storedKey => { if (faults.getDown && faults.failed) throw new Error('TEST-get-down'); return Reflect.apply(value, target, [storedKey]); };
    return value.bind(target);
  } });
  return { faults, wrap };
}

test("a failing transaction, dispatch or ownership put inside bindSigned: an unlinked result retires the reservation, an undecidable one keeps it as signer_reservation_uncertain for the next call to reconcile, and nothing is returned or sent", async t => {
  const { faults, wrap } = failingJournal(), w = await adapterWorld(t, { journalWrap: wrap }), input = evidenceInput(w);
  const puts = { transaction: key => key.startsWith('devnet/signer-reservation-tx/'), dispatch: key => key.startsWith(DISPATCH_PREFIX),
    ownership: (key, value) => key.startsWith(OWNER_KEY_PREFIX) && typeof value?.active?.txHash === 'string' };
  for (const [name, failPut] of Object.entries(puts)) {
    Object.assign(faults, { failPut, failed: false, getDown: false });
    await assert.rejects(signIn(w, input), /TEST-put-failed/, `${name}: nothing is returned`);
    assert.equal((await ownerOf(w)).active, null, `${name}: an unlinked result retires the reservation`);
    assert.equal(releasedIds(w).at(-1), w.approval.entries.at(-1).ledgerId, `${name}: the authorization is released`);
  }
  Object.assign(faults, { failPut: puts.dispatch, failed: false, getDown: true });
  const releasedBefore = releasedIds(w).length;
  await assert.rejects(signIn(w, input), error => error.code === 'signer_reservation_uncertain' && /TEST-put-failed/.test(error.cause?.message));
  const kept = await ownerOf(w);
  assert.equal(kept.active?.txHash, null, 'the undecidable result keeps the unlinked reservation');
  assert.equal(releasedIds(w).length, releasedBefore, 'nothing is released while the result is undecided');
  Object.assign(faults, { failPut: null, getDown: false });
  const next = await signIn(w, input);
  assert.equal(next.nonce, FIRST_NONCE, 'the next call reconciles the kept reservation and signs at the same nonce');
  assert.equal((await ownerOf(w)).active.txHash, next.txHash);
  assertNothingSent(w);
});

test("killed after the binding and before the kit journal keeps the row: the same evidence's next signCreate returns the bound projection with zero inner signatures and leaves the current attempt/hash ownership link for broadcast; a changed input retires it never-dispatched and signs once at the same nonce", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w);
  const first = await signIn(w, input), bound = await ownerOf(w), preparedBefore = w.approval.prepared.length;
  await w.restart();
  // Each composition has its own Demos class, so the spy on the first one cannot count here; the SDK's shared crypto can.
  const signaturesBefore = w.innerSigns.length;
  const adopted = await signIn(w, input), after = await ownerOf(w);
  assert.deepEqual(adopted, first, 'the persisted bytes come back');
  assert.equal(w.innerSigns.length, signaturesBefore, 'no second inner signature');
  assert.equal(w.approval.prepared.length, preparedBefore, 'no second preparation');
  assert.deepEqual(after, bound, 'the ownership link, attempt and revision are unchanged');
  assert.ok((await attemptOf(w, after)).history.some(entry => entry.stage === 'adopted'), 'the attempt records the adoption');
  const changed = await signIn(w, { ...input, artifact: { TEST: 'changed-evidence' } });
  assert.equal(changed.nonce, first.nonce, 'the changed input signs at the same nonce');
  assert.notEqual(changed.txHash, first.txHash);
  assert.equal(w.innerSigns.length, signaturesBefore + 1, 'one new signature');
  const retired = await w.journal().get(`${DISPATCH_PREFIX}${bound.active.attemptId}`);
  assert.equal(retired.terminal, 'never-dispatched'); assert.ok(retired.history.some(entry => entry.stage === 'settled'));
  assert.ok(releasedIds(w).includes(bound.active.approval.ledgerId), 'the old authorization is released');
  assert.notEqual((await ownerOf(w)).active.attemptId, bound.active.attemptId, 'a fresh attempt');
  assertNothingSent(w);
});

test("intent before prepare, prepare committed with no returned id, and before or after id binding: resolve only the durable exact request, release an unused preparation once, and refuse with the intent retained when lookup cannot decide", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w);
  w.approval.script.push('commit-then-throw');
  await assert.rejects(signIn(w, input), error => codes(error).includes('user_rejected'));
  assert.deepEqual(releasedIds(w), ['TEST-ledger-1'], 'a committed preparation with a lost id is found by its exact request and released once');
  assert.equal((await ownerOf(w)).active, null);
  w.approval.script.push('commit-then-throw'); w.approval.lookupDown = true;
  await assert.rejects(signIn(w, input), error => error.code === 'approval_lookup_refused');
  const retained = (await ownerOf(w)).active;
  assert.equal(retained.approvalIntent.requestText, w.approval.entries.at(-1).requestText, 'the exact intent is retained');
  assert.equal(releasedIds(w).length, 1, 'nothing is released while lookup cannot decide'); assert.equal(w.signsInsideSign, 0);
  w.approval.lookupDown = false;
  const resumed = await signIn(w, input);
  assert.equal(resumed.nonce, FIRST_NONCE);
  assert.deepEqual(releasedIds(w), ['TEST-ledger-1', 'TEST-ledger-2'], 'the unused preparation is released once and a new request is prepared');
  assert.equal(w.approval.entries.length, 3);
  const stalled = new AbortController();
  w.nodeDemosPrototype.sign.mock.mockImplementationOnce(() => { stalled.abort(new Error('TEST-deadline')); return new Promise(() => {}); });
  await assert.rejects(signIn(w, { ...input, artifact: { TEST: 'changed-evidence' } }, { signal: stalled.signal }), error => error.code === 'signer_reservation_uncertain');
  assert.ok((await ownerOf(w)).active.approval, 'the id was bound before signing started');
  await w.restart();
  assert.deepEqual(releasedIds(w), ['TEST-ledger-1', 'TEST-ledger-2', 'TEST-ledger-3', 'TEST-ledger-4'], 'a restart after id binding releases the unused authorization once');
  assert.equal((await ownerOf(w)).active, null);
});

test("a fee, storage-edit or denomination change at a barrier inside the SDK's preparation refuses at the final content check before the inner signature; inner signatures 0", async t => {
  for (const [message, answer] of [['getNetworkParameters', { networkFee: 60, rpcFee: 0, additionalFee: 0 }], ['getNetworkParameters', { networkFee: 1, rpcFee: 1, additionalFee: 0 }],
    ['getNetworkInfo', { forks: { osDenomination: { activated: false } } }]]) {
    const w = await adapterWorld(t); let reads = 0;
    sdkMessage(w, message, () => (++reads > 1 ? answerWith(answer) : undefined));
    await assert.rejects(signIn(w, evidenceInput(w)), error => codes(error).includes('payload_mismatch'), message);
    assert.equal(w.signsInsideSign, 0, `${message}: inner signatures 0`); assert.equal((await ownerOf(w)).active, null);
  }
  const w = await adapterWorld(t), captured = [], original = w.nodeDemosPrototype.sign;
  t.mock.method(w.nodeDemosPrototype, 'sign', async function captureSign(rawTx, options) {
    const signed = await Reflect.apply(original, this, [rawTx, options]);
    captured.push({ finalContent: options.finalContent, content: signed.content });
    return signed;
  });
  await signIn(w, evidenceInput(w));
  const { finalContent, content } = captured[0], [storageFee, , gas] = content.gcr_edits;
  assert.deepEqual(finalContent(content), { totalDebitOs: FULL_DEBIT_OS, feeDebitOs: FULL_DEBIT_OS });
  const storageEdit = { ...content.gcr_edits[1], context: { ...content.gcr_edits[1].context, data: { variables: { ...content.gcr_edits[1].context.data.variables, salt: 'x' } } } };
  for (const changed of [{ ...content, nonce: content.nonce + 1 }, { ...content, to: `stor-${'0'.repeat(40)}` }, { ...content, custom_charges: { burn: 1 } }, { ...content, amount: 0 },
    { ...content, gcr_edits: [{ ...storageFee, amount: '2000000000' }, ...content.gcr_edits.slice(1)] }, { ...content, gcr_edits: [storageFee, storageEdit, gas, content.gcr_edits[3]] },
    { ...content, gcr_edits: content.gcr_edits.slice(1) }, { ...content, transaction_fee: { ...content.transaction_fee, rpc_address: '0x1' } }]) {
    assert.throws(() => finalContent(changed), error => error.code === 'payload_mismatch');
  }
});

test("prepare is called once per new signature with the exact projection and full debit before signing; the exact intent is on ownership before prepare, its returned id before signing, and the binding on the attempt dispatch record before signCreate returns; a refusal signs nothing", async t => {
  const w = await adapterWorld(t), snapshots = {};
  w.approval.script.push(async () => { snapshots.atPrepare = (await ownerOf(w)).active; });
  let signReads = 0;
  sdkMessage(w, 'getNetworkParameters', async () => { if (++signReads === 2) snapshots.atSign = (await ownerOf(w)).active; });
  const signed = await signIn(w, evidenceInput(w));
  assert.equal(w.approval.prepared.length, 1, 'prepare is called once');
  const [request] = w.approval.prepared, { requestText } = w.approval.entries[0], content = JSON.parse(signed.signedTransaction).content;
  assert.equal(requestText, JSON.stringify(request), 'the kit compares the exact text unchanged');
  assert.equal(request.content.exactCreate, JSON.stringify(content.data[1]), 'the exact CREATE is shown');
  assert.deepEqual([request.content.wallet, request.content.nonce, request.content.timestamp, request.content.debit.totalOs], [content.from, signed.nonce, content.timestamp, FULL_DEBIT_OS]);
  assert.equal(snapshots.atPrepare.approvalIntent.requestText, requestText, 'the exact intent is on ownership before prepare returns');
  assert.equal(snapshots.atPrepare.approval, null);
  assert.deepEqual(snapshots.atSign.approval, { ledgerId: 'TEST-ledger-1', requestText }, 'the returned id is bound before signing');
  const owner = await ownerOf(w), attempt = await attemptOf(w, owner);
  assert.deepEqual(attempt.approval, owner.active.approval, 'the binding is on the attempt dispatch record');
  assert.deepEqual(attempt.history.map(entry => entry.stage), ['bind-started', 'signed']);
  assert.equal(owner.active.txHash, signed.txHash, 'the ownership link names the bytes');
  const refusing = await adapterWorld(t); refusing.approval.script.push('refuse');
  await assert.rejects(signIn(refusing, evidenceInput(refusing)), error => codes(error).includes('user_rejected'));
  assert.equal(refusing.approval.prepared.length, 1); assert.equal(refusing.signsInsideSign, 0);
});

test("the CREATE signed under the installed demosdk version passes the journal's exact projection rules", async t => {
  const w = await adapterWorld(t), dir = mkdtempSync(join(tmpdir(), 'payment-evidence-adapter-')), input = evidenceInput(w);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [], journal = createPaymentEvidenceWalletJournal({ path: join(dir, 'journal.sqlite'), signCreate: (asked, options) => signIn(w, asked, options),
    broadcast: async ({ signedTransaction }) => { sent.push(signedTransaction); }, readAccountNonce: async () => 0, readTransactionState: async () => 'pending' });
  t.after(() => journal.close());
  await journal.anchorEvidence(input);
  const kept = await journal.readSignedProjection({ logicalAddress: input.logicalAddress });
  assert.deepEqual(Object.keys(kept).sort(), ['content', 'hash', 'signature'], 'the journal kept exactly the public signed projection');
  assert.equal(sent.length, 1); assert.deepEqual(JSON.parse(sent[0]), kept, 'the journal broadcast the bytes signCreate returned');
  assert.equal(w.signsInsideSign, 1); assertNothingSent(w);
});

test("an approval double that mutates the request object it receives, or returns a different requestText, makes signCreate refuse with signer 0 and the authorization released", async t => {
  for (const behaviour of ['mutate', 'other-text']) {
    const w = await adapterWorld(t); w.approval.script.push(behaviour);
    await assert.rejects(signIn(w, evidenceInput(w)), error => error.code === 'approval_mismatch', behaviour);
    assert.equal(w.signsInsideSign, 0, `${behaviour}: signer 0`);
    assert.deepEqual(releasedIds(w), ['TEST-ledger-1'], `${behaviour}: the authorization is released once`);
    assert.equal((await ownerOf(w)).active, null);
  }
});

test("a never-settling inner sign aborted by the caller's deadline keeps the reservation, and its late result changes no record", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w), deadline = new AbortController();
  let finishStale, started;
  const signStarted = new Promise(resolve => { started = resolve; });
  w.nodeDemosPrototype.sign.mock.mockImplementationOnce(() => { started(); return new Promise(resolve => { finishStale = () => resolve({ hash: 'a'.repeat(64), content: {}, signature: { type: 'ed25519', data: `0x${'0'.repeat(128)}` } }); }); });
  const timedOut = signIn(w, input, { signal: deadline.signal });
  await signStarted; deadline.abort(new Error('TEST-deadline'));
  await assert.rejects(timedOut, error => error.code === 'signer_reservation_uncertain' && /TEST-deadline/.test(error.cause?.message));
  const kept = (await ownerOf(w)).active;
  assert.equal(kept.txHash, null); assert.ok(kept.approval, 'the reservation is kept, not retired, while the signature is unsettled');
  const next = await signIn(w, input);
  const afterNext = await w.journal().entries();
  finishStale(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await w.journal().entries(), afterNext, 'the late result changes no record');
  assert.equal((await ownerOf(w)).active.txHash, next.txHash, 'the next caller still owns its bytes');
  assertNothingSent(w);
});

test("an authorization withdrawn while the fee is read refuses at the inner signature and releases the approval", async t => {
  const w = await adapterWorld(t); let withdrawn = false, reads = 0;
  sdkMessage(w, 'getNetworkParameters', () => { if (++reads === 2) withdrawn = true; });
  const pass = await openPass(w, { pass: { synchronousChecks: [() => { if (withdrawn) throw new Error('TEST-authorization-withdrawn'); }] } });
  await assert.rejects(pass.run(() => w.adapter.signCreate(evidenceInput(w))), error => causeChain(error).some(link => /TEST-authorization-withdrawn/.test(link.message)));
  assert.equal(w.signsInsideSign, 0, 'inner signatures 0');
  assert.equal((await ownerOf(w)).active, null); assert.deepEqual(releasedIds(w), ['TEST-ledger-1']);
});

test("a process that died after reserving, or after storing the approval intent, leaves nothing that blocks the next call: it signs at the same nonce", async t => {
  for (const storeIntent of [false, true]) {
    const w = await adapterWorld(t), input = evidenceInput(w), dead = deadProcess(w);
    const { reservation } = await dead.reserve({ signer: signerOf(w), operation: 'payment-evidence', operationKey: input.logicalAddress, attemptId: 'TEST-dead-attempt', readChainNonce: async () => 0 });
    if (storeIntent) await dead.bindApprovalIntent(reservation, JSON.stringify({ TEST: 'request of the dead process' }));
    await w.restart();
    const signed = await signIn(w, input);
    assert.equal(signed.nonce, FIRST_NONCE, `intent stored ${storeIntent}: the nonce is reused`);
    assert.equal(w.approval.prepared.length, 1, 'one new preparation');
    assert.equal((await ownerOf(w)).active.txHash, signed.txHash);
    assertNothingSent(w);
  }
});

test("signCreate refuses signer_lane_busy while the transport lane holds an issued write, on the key the transport itself uses, and a busy reservation of another evidence address", async t => {
  const w = await adapterWorld(t), first = await signIn(w, evidenceInput(w));
  await assert.rejects(signIn(w, evidenceInput(w, 'b')), { code: 'signer_lane_busy' });
  assert.equal(w.signsInsideSign, 1, 'a busy signer is refused with signer calls 0');
  const owner = await ownerOf(w);
  assert.equal(owner.active.txHash, first.txHash, 'no transition for the refused call');
  const lane = await adapterWorld(t); lane.node.mode = 'drop';
  await inPass(lane, () => lane.send());
  const [laneKey, record] = (await lane.journal().entries()).find(([key]) => key.startsWith('devnet/native-wallet/'));
  assert.equal(laneKey, nativeWalletLaneKey(TP1_APPROVED_IDENTITY_RECORD, lane.session.wallet.getPublicAccount().address), 'the adapter reads the transport\'s own lane key');
  assert.ok(!['observed', 'failed'].includes(record.stage));
  const signedBefore = lane.signsInsideSign;
  await assert.rejects(signIn(lane, evidenceInput(lane)), { code: 'signer_lane_busy' });
  assert.equal(lane.signsInsideSign, signedBefore, 'signer calls 0'); assert.equal(await ownerOf(lane), null, 'no reservation is made');
});

test("signCreate refuses an input that is not this signer's evidence CREATE before it reserves anything", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w);
  for (const bad of [null, { ...input, writer: `did:demos:agent:${'3'.repeat(64)}` }, { ...input, logicalAddress: '' }, { ...input, artifact: [] }, { ...input, receiptContentHash: 'abc' }, { ...input, jobId: 7 },
    { ...input, deliveryBinding: { TEST: 'a member the evidence CREATE does not carry' } }]) {
    await assert.rejects(signIn(w, bad), { code: 'signer_input_invalid' });
  }
  await assert.rejects(signIn(w, input, { signal: AbortSignal.abort(new Error('TEST-aborted-early')) }), /TEST-aborted-early/);
  assert.equal(await ownerOf(w), null, 'nothing was reserved'); assert.equal(w.node.calls.length, 0, 'no node call');
});

test("a locked wallet refuses signCreate before it reserves anything, and a wallet locked during the approval signs nothing and releases it", async t => {
  const locked = await adapterWorld(t), input = evidenceInput(locked);
  locked.session.wallet.lock();
  await assert.rejects(signIn(locked, input), { code: 'locked' });
  assert.equal(await ownerOf(locked), null, 'nothing was reserved'); assert.equal(locked.node.calls.length, 0, 'no node call');
  const midway = await adapterWorld(t);
  midway.approval.script.push(() => midway.session.wallet.lock());
  await assert.rejects(signIn(midway, evidenceInput(midway)), error => codes(error).includes('locked'));
  assert.equal(midway.signsInsideSign, 0, 'inner signatures 0');
  assert.equal((await ownerOf(midway)).active, null); assert.deepEqual(releasedIds(midway), ['TEST-ledger-1']);
});

test("the hold refuses signCreate with profile_not_admitted and no node call, and the composition requires the whole approval ledger input", async t => {
  const w = await adapterWorld(t), callsBefore = w.node.calls.length;
  assert.deepEqual(Object.keys(w.adapter), ['signCreate']);
  setPurchaseAdmission('held');
  await assert.rejects(signIn(w, evidenceInput(w)), { code: 'profile_not_admitted' });
  assert.equal(w.node.calls.length, callsBefore, '0 node calls'); assert.equal(await ownerOf(w), null);
  setPurchaseAdmission('testnet-tp1');
  for (const missing of ['prepare', 'open', 'reopen', 'confirm', 'settle']) {
    const key = mnemonicBytes(), partial = { ...recordingApproval(), [missing]: undefined };
    await assert.rejects(api.createNodeSellerComposition({ admission: w.admission, owner: w.owner, journal: w.journal(), key, approve: async () => true, clock: w.clock, approveConfirmedWrite: null,
      publications: sellerPublications(), stateOwnership: { directory: tmpdir(), held: () => true }, paymentEvidenceApproval: partial }), { code: 'invalid_params' }, missing);
    assert.ok(key.every(byte => byte === 0), 'the key is zeroed on refusal');
  }
});

test("no socket or DNS lookup leaves the process in the adapter suite", () => {
  assert.deepEqual(egress.attempts, []);
});
