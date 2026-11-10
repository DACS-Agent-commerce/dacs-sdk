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

const RECORD_KEY_PREFIX = 'devnet/signer-reservation/';
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
const recordOf = async w => (await w.journal().entries()).find(([key]) => key.startsWith(RECORD_KEY_PREFIX))?.[1] ?? null;
const sdkMessage = (w, message, respond) => { w.node.intercept = row => (row.body.params[0].message === message ? respond(row) : undefined); };
const releasedIds = w => w.approval.settlements.filter(call => call.outcome === 'released').map(call => call.ledgerId);
const assertNothingSent = w => { assert.equal(w.node.confirms.length, 0, 'no confirmation'); assert.equal(w.node.broadcasts.length, 0, 'no broadcast'); };
const codes = error => causeChain(error).map(link => link.code);
const settle = () => new Promise(resolve => setImmediate(resolve));
// A reservation instance over the world's journal, standing for a process that wrote its records and then died.
const deadProcess = w => createSignerReservations({ journal: w.journal(), pins: TP1_APPROVED_IDENTITY_RECORD,
  openApproval: requestText => w.approval.open(requestText), settleApproval: (ledgerId, outcome, reason) => w.approval.settle(ledgerId, outcome, reason) });
const signerOf = w => w.session.wallet.getPublicAccount().address;

test("a plain signCreate in the default seller composition stores and returns one signed projection that passes the kit journal's projection rules", async t => {
  const w = await adapterWorld(t), dir = mkdtempSync(join(tmpdir(), 'payment-evidence-adapter-')), input = evidenceInput(w);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [], returned = [], journal = createPaymentEvidenceWalletJournal({ path: join(dir, 'journal.sqlite'),
    signCreate: async (asked, options) => { const result = await signIn(w, asked, options); returned.push(result); return result; },
    broadcast: async ({ signedTransaction }) => { sent.push(signedTransaction); }, readAccountNonce: async () => 0, readTransactionState: async () => 'pending' });
  t.after(() => journal.close());
  await journal.anchorEvidence(input);
  const kept = await journal.readSignedProjection({ logicalAddress: input.logicalAddress }), stored = (await recordOf(w)).active.signed;
  assert.deepEqual(Object.keys(kept).sort(), ['content', 'hash', 'signature'], 'the journal kept exactly the public signed projection');
  assert.deepEqual(returned[0], { signedTransaction: stored.projectionText, txHash: stored.txHash, nonce: FIRST_NONCE }, 'the returned bytes are the stored bytes');
  assert.equal(sent.length, 1); assert.deepEqual(JSON.parse(sent[0]), kept, 'the journal broadcast the bytes signCreate returned');
  assert.equal(w.signsInsideSign, 1); assertNothingSent(w);
});

test("stored signed bytes come back for the same input with no signature or write, also after a restart; a changed input is refused signer_lane_busy and changes nothing", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w);
  const first = await signIn(w, input), stored = await recordOf(w), signaturesBefore = w.innerSigns.length, prepared = w.approval.prepared.length;
  assert.deepEqual(await signIn(w, input), first, 'the same input returns the stored bytes');
  assert.deepEqual(await recordOf(w), stored, 'no write: the revision is unchanged');
  await assert.rejects(signIn(w, { ...input, artifact: { TEST: 'changed-evidence' } }), { code: 'signer_lane_busy' });
  assert.deepEqual(await recordOf(w), stored, 'a changed input retires nothing');
  await w.restart();
  assert.deepEqual(await recordOf(w), stored, 'recovery keeps signed bytes');
  assert.deepEqual(await signIn(w, input), first, 'after a restart the same input returns the stored bytes');
  assert.equal(w.innerSigns.length, signaturesBefore, 'no second inner signature');
  assert.equal(w.approval.prepared.length, prepared, 'no second preparation'); assert.deepEqual(releasedIds(w), []);
  assertNothingSent(w);
});

test("every unsigned exit retires the reservation, keeps the floor and releases a bound authorization once; a different evidence address then signs at the same nonce", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w);
  let late;
  const unsignedExits = {
    'approval refusal': { arrange: () => w.approval.script.push('refuse'), code: 'user_rejected' },
    'approval throw': { arrange: () => w.approval.script.push('throw'), code: 'user_rejected', cause: /TEST-approval-failed/ },
    'approval answer for other bytes': { arrange: () => w.approval.script.push('other-text'), code: 'approval_mismatch' },
    'approval mutating its request': { arrange: () => w.approval.script.push('mutate'), code: 'approval_mismatch' },
    'fee read failure': { arrange: () => sdkMessage(w, 'getNetworkParameters', () => { throw new Error('TEST-fee-read-failed'); }), cause: /TEST-fee-read-failed/ },
    'fork read failure': { arrange: () => sdkMessage(w, 'getNetworkInfo', () => { throw new Error('TEST-fork-read-failed'); }), cause: /TEST-fork-read-failed/ },
    'gate refusal': { arrange: () => {}, run: () => w.adapter.signCreate(input), code: 'effect_pass_required' },
    'signer failure': { arrange: () => w.nodeDemosPrototype.sign.mock.mockImplementationOnce(async () => { throw new Error('TEST-signer-failed'); }), cause: /TEST-signer-failed/ },
    'abort before the approval request is stored': { arrange: () => { const stop = new AbortController(); w.stop = stop; sdkMessage(w, 'getNetworkInfo', () => { stop.abort(new Error('TEST-abort')); }); }, cause: /TEST-abort/ },
    'abort during the inner signature': { arrange: () => { const stop = new AbortController(); w.stop = stop;
      w.nodeDemosPrototype.sign.mock.mockImplementationOnce(() => { stop.abort(new Error('TEST-deadline')); return new Promise(resolve => { late = resolve; }); }); }, cause: /TEST-deadline/ },
  };
  for (const [name, exit] of Object.entries(unsignedExits)) {
    w.node.intercept = null; w.stop = undefined;
    exit.arrange();
    const settledBefore = w.approval.settlements.length, preparedBefore = w.approval.entries.length;
    const error = await (exit.run ?? (() => signIn(w, input, { signal: w.stop?.signal })))().then(() => assert.fail(`${name} signed`), caught => caught);
    if (exit.code) assert.ok(codes(error).includes(exit.code), `${name}: ${codes(error)}`);
    if (exit.cause) assert.ok(causeChain(error).some(link => exit.cause.test(link.message)), `${name}: the cause is kept`);
    assert.equal(w.signsInsideSign, 0, `${name}: inner signatures 0`);
    const record = await recordOf(w);
    assert.equal(record.active, null, `${name}: the unsigned reservation is retired`); assert.equal(record.floor, 0, `${name}: the floor is kept`);
    if (w.approval.entries.length > preparedBefore) assert.deepEqual(releasedIds(w).slice(-1), [w.approval.entries.at(-1).ledgerId], `${name}: the authorization is released`);
    else assert.equal(w.approval.settlements.length, settledBefore, `${name}: nothing was prepared, nothing is settled`);
  }
  assert.equal(new Set(releasedIds(w)).size, releasedIds(w).length, 'every authorization is released once');
  w.node.intercept = null;
  const other = await signIn(w, evidenceInput(w, 'b')), afterOther = await w.journal().entries();
  assert.equal(other.nonce, FIRST_NONCE, 'a different evidence address signs at the same nonce');
  late({ hash: 'a'.repeat(64), content: {}, signature: { type: 'ed25519', data: '0'.repeat(128) } }); await settle();
  assert.deepEqual(await w.journal().entries(), afterOther, 'a signature that arrives after the abort changes no record');
  assert.equal(w.signsInsideSign, 1); assertNothingSent(w);
});

test("the approval request is stored before prepare, the returned id before the inner signature, and the signed bytes before signCreate returns", async t => {
  const w = await adapterWorld(t), snapshots = {};
  w.approval.script.push(async () => { snapshots.atPrepare = (await recordOf(w)).active; });
  let signReads = 0;
  sdkMessage(w, 'getNetworkParameters', async () => { if (++signReads === 2) snapshots.atSign = (await recordOf(w)).active; });
  const signed = await signIn(w, evidenceInput(w));
  assert.equal(w.approval.prepared.length, 1, 'prepare is called once');
  const [request] = w.approval.prepared, { requestText } = w.approval.entries[0], content = JSON.parse(signed.signedTransaction).content;
  assert.equal(requestText, JSON.stringify(request), 'the kit compares the exact text unchanged');
  assert.equal(request.content.exactCreate, JSON.stringify(content.data[1]), 'the exact CREATE is shown');
  assert.deepEqual([request.content.wallet, request.content.nonce, request.content.timestamp, request.content.debit.totalOs], [content.from, signed.nonce, content.timestamp, FULL_DEBIT_OS]);
  assert.deepEqual([snapshots.atPrepare.approvalIntent, snapshots.atPrepare.approvalId], [requestText, null], 'the request text is stored before prepare returns');
  assert.deepEqual([snapshots.atSign.approvalId, snapshots.atSign.signed], ['TEST-ledger-1', null], 'the returned id is bound before signing');
  assert.equal((await recordOf(w)).active.signed.projectionText, signed.signedTransaction, 'the signed bytes are stored');
});

test("an abort while prepare has not settled keeps the reservation as signer_reservation_uncertain; later calls write nothing, and after recovery at a restart the next call signs at the same nonce", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w), stop = new AbortController();
  w.approval.script.push(() => { stop.abort(new Error('TEST-deadline')); return new Promise(() => {}); });
  await assert.rejects(signIn(w, input, { signal: stop.signal }), error => error.code === 'signer_reservation_uncertain' && /TEST-deadline/.test(error.cause?.message));
  const kept = await recordOf(w);
  assert.equal(kept.active.approvalIntent, w.approval.entries[0].requestText, 'the request text is kept'); assert.deepEqual(releasedIds(w), []);
  await assert.rejects(signIn(w, input), { code: 'signer_reservation_uncertain' });
  await assert.rejects(signIn(w, evidenceInput(w, 'b')), { code: 'signer_lane_busy' });
  assert.deepEqual(await recordOf(w), kept, 'later calls write nothing'); assert.equal(w.approval.prepared.length, 1, 'and prepare nothing');
  await w.restart();
  assert.deepEqual(releasedIds(w), ['TEST-ledger-1'], 'recovery finds the late preparation by its exact text and releases it once');
  const signed = await signIn(w, input);
  assert.equal(signed.nonce, FIRST_NONCE); assertNothingSent(w);
});

test("a committed preparation whose answer was lost is released by its exact request; a lookup that cannot decide keeps the reservation until recovery", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w);
  w.approval.script.push('commit-then-throw');
  await assert.rejects(signIn(w, input), error => codes(error).includes('user_rejected'));
  assert.deepEqual(releasedIds(w), ['TEST-ledger-1']); assert.equal((await recordOf(w)).active, null);
  w.approval.script.push('commit-then-throw'); w.approval.lookupDown = true;
  await assert.rejects(signIn(w, input), { code: 'approval_lookup_refused' });
  assert.equal((await recordOf(w)).active.approvalIntent, w.approval.entries[1].requestText, 'the request text is kept');
  w.approval.lookupDown = false;
  await assert.rejects(signIn(w, input), { code: 'signer_reservation_uncertain' });
  assert.deepEqual(releasedIds(w), ['TEST-ledger-1'], 'nothing is released while the lookup could not decide');
  await w.restart();
  assert.deepEqual(releasedIds(w), ['TEST-ledger-1', 'TEST-ledger-2']);
  assert.equal((await signIn(w, input)).nonce, FIRST_NONCE); assertNothingSent(w);
});

test("a wallet locked during the SDK's fee read inside the signature refuses locked, stores no bytes and releases the approval", async t => {
  const w = await adapterWorld(t); let reads = 0;
  sdkMessage(w, 'getNetworkParameters', () => { if (++reads === 2) w.session.wallet.lock(); });
  await assert.rejects(signIn(w, evidenceInput(w)), error => codes(error).includes('locked'));
  assert.equal(reads, 2, 'the lock happened inside the SDK preparation');
  assert.equal(w.signsInsideSign, 0, 'inner signatures 0');
  assert.equal((await recordOf(w)).active, null); assert.deepEqual(releasedIds(w), ['TEST-ledger-1']);
});

function failingJournal() {
  const faults = { failPut: null, failed: false, getDown: false };
  const wrap = journal => new Proxy(journal, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (key === 'put') return (storedKey, storedValue) => {
      if (faults.failPut?.(storedKey, storedValue) && !faults.failed) { faults.failed = true; throw new Error('TEST-put-failed'); }
      return Reflect.apply(value, target, [storedKey, storedValue]);
    };
    if (key === 'get') return storedKey => { if (faults.getDown && faults.failed) throw new Error('TEST-get-down'); return Reflect.apply(value, target, [storedKey]); };
    return value.bind(target);
  } });
  return { faults, wrap };
}

test("a failed store of the signed bytes returns nothing: a read-back that proves it did not commit retires the reservation, and an unreadable one keeps it as signer_reservation_uncertain", async t => {
  const { faults, wrap } = failingJournal(), w = await adapterWorld(t, { journalWrap: wrap }), input = evidenceInput(w);
  const storesBytes = (key, value) => key.startsWith(RECORD_KEY_PREFIX) && value?.active?.signed;
  Object.assign(faults, { failPut: storesBytes, failed: false });
  await assert.rejects(signIn(w, input), /TEST-put-failed/);
  assert.equal((await recordOf(w)).active, null, 'a proven unstored result retires the reservation'); assert.deepEqual(releasedIds(w), ['TEST-ledger-1']);
  Object.assign(faults, { failPut: storesBytes, failed: false, getDown: true });
  await assert.rejects(signIn(w, input), error => error.code === 'signer_reservation_uncertain' && /TEST-put-failed/.test(error.cause?.message));
  Object.assign(faults, { failPut: null, getDown: false });
  const kept = await recordOf(w);
  assert.deepEqual([kept.active.approvalId, kept.active.signed], ['TEST-ledger-2', null], 'the undecided reservation is kept');
  assert.deepEqual(releasedIds(w), ['TEST-ledger-1'], 'nothing is released while the result is undecided');
  await assert.rejects(signIn(w, input), { code: 'signer_reservation_uncertain' });
  await w.restart();
  assert.deepEqual(releasedIds(w), ['TEST-ledger-1', 'TEST-ledger-2']);
  assert.equal((await signIn(w, input)).nonce, FIRST_NONCE); assertNothingSent(w);
});

test("a fee, storage-edit or denomination change at a barrier inside the SDK's preparation refuses at the final content check before the inner signature; a pre-fork CREATE signs", async t => {
  for (const [message, answer] of [['getNetworkParameters', { networkFee: 60, rpcFee: 0, additionalFee: 0 }], ['getNetworkParameters', { networkFee: 1, rpcFee: 1, additionalFee: 0 }],
    ['getNetworkInfo', { forks: { osDenomination: { activated: false } } }]]) {
    const w = await adapterWorld(t); let reads = 0;
    sdkMessage(w, message, () => (++reads > 1 ? answerWith(answer) : undefined));
    await assert.rejects(signIn(w, evidenceInput(w)), error => codes(error).includes('payload_mismatch'), message);
    assert.equal(w.signsInsideSign, 0, `${message}: inner signatures 0`); assert.equal((await recordOf(w)).active, null);
    assert.deepEqual(releasedIds(w), ['TEST-ledger-1'], `${message}: the approval is released`);
  }
  const preFork = await adapterWorld(t);
  sdkMessage(preFork, 'getNetworkInfo', () => answerWith({ forks: { osDenomination: { activated: false } } }));
  const signed = await signIn(preFork, evidenceInput(preFork));
  assert.equal(JSON.parse(signed.signedTransaction).content.transaction_fee.network_fee, 1, 'pre-fork amounts are whole DEM numbers');
  const w = await adapterWorld(t), captured = [], original = w.nodeDemosPrototype.sign;
  t.mock.method(w.nodeDemosPrototype, 'sign', async function captureSign(rawTx, options) {
    const result = await Reflect.apply(original, this, [rawTx, options]);
    captured.push({ finalContent: options.finalContent, content: result.content });
    return result;
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

test("an authorization withdrawn while the fee is read refuses at the inner signature and releases the approval", async t => {
  const w = await adapterWorld(t); let withdrawn = false, reads = 0;
  sdkMessage(w, 'getNetworkParameters', () => { if (++reads === 2) withdrawn = true; });
  const pass = await openPass(w, { pass: { synchronousChecks: [() => { if (withdrawn) throw new Error('TEST-authorization-withdrawn'); }] } });
  await assert.rejects(pass.run(() => w.adapter.signCreate(evidenceInput(w))), error => causeChain(error).some(link => /TEST-authorization-withdrawn/.test(link.message)));
  assert.equal(w.signsInsideSign, 0, 'inner signatures 0');
  assert.equal((await recordOf(w)).active, null); assert.deepEqual(releasedIds(w), ['TEST-ledger-1']);
});

test("a process that died after reserving, or after storing the approval request, leaves nothing that blocks the next call: it signs at the same nonce", async t => {
  for (const storeIntent of [false, true]) {
    const w = await adapterWorld(t), input = evidenceInput(w), dead = deadProcess(w);
    const { reservation } = await dead.reserve({ signer: signerOf(w), operation: 'payment-evidence', operationKey: input.logicalAddress, readChainNonce: async () => 0 });
    if (storeIntent) await dead.bindApprovalIntent(reservation, JSON.stringify({ TEST: 'request of the dead process' }));
    await w.restart();
    const signed = await signIn(w, input);
    assert.equal(signed.nonce, FIRST_NONCE, `request stored ${storeIntent}: the nonce is reused`);
    assert.equal(w.approval.prepared.length, 1, 'one new preparation');
    assert.equal((await recordOf(w)).active.signed.txHash, signed.txHash);
    assertNothingSent(w);
  }
});

test("signCreate refuses signer_lane_busy while the transport lane holds an issued write, on the key the transport itself uses, and while another evidence address holds signed bytes", async t => {
  const w = await adapterWorld(t), first = await signIn(w, evidenceInput(w)), held = await recordOf(w);
  await assert.rejects(signIn(w, evidenceInput(w, 'b')), { code: 'signer_lane_busy' });
  assert.equal(w.signsInsideSign, 1, 'a busy signer is refused with signer calls 0');
  assert.deepEqual(await recordOf(w), held, 'no transition for the refused call'); assert.equal(held.active.signed.txHash, first.txHash);
  const lane = await adapterWorld(t); lane.node.mode = 'drop';
  await inPass(lane, () => lane.send());
  const [laneKey, record] = (await lane.journal().entries()).find(([key]) => key.startsWith('devnet/native-wallet/'));
  assert.equal(laneKey, nativeWalletLaneKey(TP1_APPROVED_IDENTITY_RECORD, lane.session.wallet.getPublicAccount().address), 'the adapter reads the transport\'s own lane key');
  assert.ok(!['observed', 'failed'].includes(record.stage));
  const signedBefore = lane.signsInsideSign;
  await assert.rejects(signIn(lane, evidenceInput(lane)), { code: 'signer_lane_busy' });
  assert.equal(lane.signsInsideSign, signedBefore, 'signer calls 0'); assert.equal(await recordOf(lane), null, 'no reservation is made');
});

test("signCreate refuses an input that is not this signer's evidence CREATE, a locked wallet and an aborted call before it reserves anything", async t => {
  const w = await adapterWorld(t), input = evidenceInput(w);
  for (const bad of [null, { ...input, writer: `did:demos:agent:${'3'.repeat(64)}` }, { ...input, logicalAddress: '' }, { ...input, artifact: [] }, { ...input, receiptContentHash: 'abc' }, { ...input, jobId: 7 },
    { ...input, deliveryBinding: { TEST: 'a member the evidence CREATE does not carry' } }]) {
    await assert.rejects(signIn(w, bad), { code: 'signer_input_invalid' });
  }
  await assert.rejects(signIn(w, input, { signal: AbortSignal.abort(new Error('TEST-aborted-early')) }), /TEST-aborted-early/);
  w.session.wallet.lock();
  await assert.rejects(signIn(w, input), { code: 'locked' });
  assert.equal(await recordOf(w), null, 'nothing was reserved'); assert.equal(w.node.calls.length, 0, 'no node call');
});

test("the hold refuses signCreate with profile_not_admitted and no node call, and the composition requires the whole approval ledger input", async t => {
  const w = await adapterWorld(t), callsBefore = w.node.calls.length;
  assert.deepEqual(Object.keys(w.adapter), ['signCreate']);
  setPurchaseAdmission('held');
  await assert.rejects(signIn(w, evidenceInput(w)), { code: 'profile_not_admitted' });
  assert.equal(w.node.calls.length, callsBefore, '0 node calls'); assert.equal(await recordOf(w), null);
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
