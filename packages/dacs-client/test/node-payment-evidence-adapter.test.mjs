import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { api, mnemonicBytes, ok, setPurchaseAdmission } from './helpers/tp1-node-fixture.mjs';
import { gateWorld, inPass, openPass, sellerPublications } from './helpers/effect-gate-world.mjs';
import { causeChain } from './helpers/node-wallet-signing-spy.mjs';
import { recordingApproval } from './helpers/payment-evidence-approval-double.mjs';
import { installNoEgress } from './helpers/no-egress.mjs';
import { rpcEnvelope, storageWriteConfirmationMatches } from '../src/devnet-demo/storage-write-recovery.mjs';
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
  assert.deepEqual(Object.keys(w.adapter).sort(), ['broadcast', 'readAccountNonce', 'readTransactionState', 'signCreate']);
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

// The replay half: a scripted node that answers a confirmation and a broadcast the way the serving node does, with `w.reply` as the hook that
// changes any one answer.
const broadcastIn = (w, signed, options) => inPass(w, () => w.adapter.broadcast(signed, options));
const successfulConfirmation = (tx, data = {}) => ok({ data: { valid: true, reference_block: 1, message: 'TEST-valid', gas_operation: null, transaction: tx, ...data },
  signature: { type: 'ed25519', data: `0x${'5'.repeat(128)}` }, rpc_public_key: { type: 'ed25519', data: `0x${'6'.repeat(64)}` } });
const responseOf = answer => new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
const spentIds = w => [...w.approval.settled].filter(([, outcome]) => outcome === 'spent').map(([id]) => id);
const applyWithoutBroadcast = (w, signed) => { w.node.applied.set(signed.txHash, JSON.parse(signed.signedTransaction)); w.node.nonce = signed.nonce; };
const messageOf = row => row.body.params[0].message || row.body.params[0].extra;

async function replayWorld(t, options) {
  const w = await adapterWorld(t, options);
  w.reply = null;
  w.node.intercept = async row => {
    const call = row.body.params[0];
    if (call.extra === 'confirmTx') w.node.confirms.push(structuredClone(call.data));
    if (call.extra === 'broadcastTx') w.node.broadcasts.push(structuredClone(call.data.response.data.transaction));
    const changed = await w.reply?.(row);
    if (changed) return changed;
    if (call.extra === 'confirmTx') return responseOf(successfulConfirmation(call.data));
    if (call.extra === 'broadcastTx') {
      const tx = call.data.response.data.transaction;
      w.node.applied.set(tx.hash, structuredClone(tx)); w.node.nonce = tx.content.nonce;
      return responseOf(ok({ hash: tx.hash }));
    }
  };
  return w;
}
const replyFor = (w, message, respond) => { w.reply = row => (messageOf(row) === message ? respond(row) : undefined); };

test("signCreate signs the journal's three-member projection with one signature and no egress; the first broadcast confirms against the serving-node confirmation shape and dispatches the retained bytes once, byte-equal at the receiver; the positive fixture passes every validator in the path", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  assert.equal(w.signsInsideSign, 1); assertNothingSent(w);
  assert.deepEqual(await broadcastIn(w, signed), { status: 'accepted', txHash: signed.txHash });
  assert.equal(w.node.broadcasts.length, 1); assert.equal(JSON.stringify(w.node.broadcasts[0]), signed.signedTransaction);
  const { validity } = w.approval.confirmations[0];
  assert.ok(rpcEnvelope(validity, 200, null)); assert.ok(storageWriteConfirmationMatches(validity.response));
  assert.equal(JSON.stringify(validity.response.data.transaction), signed.signedTransaction);
  assert.deepEqual(Object.keys(validity.response.data.transaction), ['hash', 'content', 'signature']);
  assert.equal(w.signsInsideSign, 1, 'broadcast signs nothing');
});

test("after reopening the journal and the composition, a replay confirms and dispatches the same three-member projection; no second signature is made", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  await broadcastIn(w, signed); await w.restart();
  await broadcastIn(w, signed);
  assert.equal(w.node.confirms.length, 2); assert.equal(w.node.broadcasts.length, 2);
  assert.deepEqual(w.node.broadcasts.map(tx => JSON.stringify(tx)), [signed.signedTransaction, signed.signedTransaction]);
  assert.equal(w.signsInsideSign, 1, 'no second signature'); assert.equal(w.approval.prepared.length, 1);
  assert.deepEqual(w.approval.reopened, ['TEST-ledger-1', 'TEST-ledger-1'], 'the replay reopens the original authorization');
});

test("a confirmation whose transaction has an extra or missing member, or changed content, hash or signature, is an unknown confirmation and nothing is dispatched", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  const changes = { extra: tx => ({ ...tx, status: '' }), missing: ({ hash, content }) => ({ hash, content }), content: tx => ({ ...tx, content: { ...tx.content, amount: '1' } }),
    hash: tx => ({ ...tx, hash: 'f'.repeat(64) }), signature: tx => ({ ...tx, signature: { ...tx.signature, data: `0x${'7'.repeat(128)}` } }) };
  for (const [name, change] of Object.entries(changes)) {
    replyFor(w, 'confirmTx', row => responseOf(successfulConfirmation(change(row.body.params[0].data))));
    await assert.rejects(broadcastIn(w, signed), { code: 'outcome_unknown' }, name);
  }
  assert.equal(w.node.broadcasts.length, 0); assert.equal(w.approval.confirmations.length, 0, 'the callback never ran');
});

test("a valid:true confirmation with the exact projection and malformed gas or charge fields is an unknown confirmation, never confirm_rejected, and nothing is dispatched", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  for (const data of [{ gas_operation: { TEST: 'unexpected gas' } }, { reference_block: -1 }, { message: 7 }]) {
    replyFor(w, 'confirmTx', row => responseOf(successfulConfirmation(row.body.params[0].data, data)));
    await assert.rejects(broadcastIn(w, signed), error => error.code === 'outcome_unknown' && error.code !== 'confirm_rejected', JSON.stringify(data));
  }
  assert.equal(w.node.broadcasts.length, 0);
});

test("a validated valid:false confirmation is confirm_rejected with its cause; nothing is dispatched", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  replyFor(w, 'confirmTx', row => responseOf(successfulConfirmation(row.body.params[0].data, { valid: false, message: 'TEST-insufficient-balance' })));
  await assert.rejects(broadcastIn(w, signed), error => error.code === 'confirm_rejected' && /TEST-insufficient-balance/.test(error.cause.message));
  assert.equal(w.node.broadcasts.length, 0); assert.deepEqual(w.approval.settlements, [], 'the authorization stays held');
});

test("a lost or malformed confirmation answer never advances to broadcast and is reported unknown, never unsent", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  for (const answer of [() => { throw new Error('TEST-confirm-lost'); }, () => responseOf({ result: 200, response: 'TEST-garbled' }), () => new Response('TEST-unavailable', { status: 503 })]) {
    replyFor(w, 'confirmTx', answer);
    await assert.rejects(broadcastIn(w, signed), { code: 'outcome_unknown' });
  }
  assert.equal(w.node.broadcasts.length, 0); assert.equal(w.approval.confirmations.length, 0);
  assert.equal((await recordOf(w)).active.signed.projectionText, signed.signedTransaction, 'the bytes are kept');
});

test("a lost broadcast acknowledgement after the receiver recorded the bytes is outcome_unknown with its cause, never unsent", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  replyFor(w, 'broadcastTx', row => { const tx = row.body.params[0].data.response.data.transaction; w.node.applied.set(tx.hash, tx); throw new Error('TEST-acknowledgement-lost'); });
  await assert.rejects(broadcastIn(w, signed), error => error.code === 'outcome_unknown' && causeChain(error).some(link => /TEST-acknowledgement-lost/.test(link.message)));
  assert.ok(w.node.applied.has(signed.txHash)); assert.deepEqual(w.approval.settlements, [], 'the authorization stays held');
  assert.equal((await recordOf(w)).active.signed.txHash, signed.txHash);
});

test("each explicit broadcast call re-dispatches the identical bytes once with fresh authentication headers; no second signature is made", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  await broadcastIn(w, signed); await broadcastIn(w, signed);
  assert.deepEqual(w.node.broadcasts.map(tx => JSON.stringify(tx)), [signed.signedTransaction, signed.signedTransaction]);
  const stamps = w.node.calls.filter(row => row.headers.identity?.startsWith('ed25519:') && ['confirmTx', 'broadcastTx'].includes(row.body.params[0].extra)).map(row => Number(row.headers.timestamp));
  assert.equal(stamps.length, 4); stamps.slice(1).forEach((stamp, index) => assert.ok(stamp > stamps[index], 'each stamp is above the last'));
  assert.equal(w.signsInsideSign, 1);
});

test("two overlapping broadcast calls for one CREATE serialize; each dispatches at most once", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  let running = 0, most = 0;
  w.reply = async () => { running += 1; most = Math.max(most, running); await settle(); running -= 1; };
  await inPass(w, () => Promise.all([w.adapter.broadcast(signed), w.adapter.broadcast(signed)]));
  assert.equal(most, 1, 'one request at a time'); assert.equal(w.node.broadcasts.length, 2, 'one dispatch per call');
});

test("signCreate refuses signer_lane_busy while another evidence address's CREATE holds the reservation; after that one is applied it signs at the next nonce", async t => {
  const w = await replayWorld(t), first = await signIn(w, evidenceInput(w));
  await assert.rejects(signIn(w, evidenceInput(w, 'b')), { code: 'signer_lane_busy' });
  await broadcastIn(w, first);
  assert.equal((await w.adapter.readTransactionState(first)).state, 'applied');
  assert.equal((await signIn(w, evidenceInput(w, 'b'))).nonce, first.nonce + 1);
});

test("readTransactionState answers applied only for authenticated successful execution of the retained CREATE; included-but-failed is pending", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'pending', 'not on the chain');
  applyWithoutBroadcast(w, signed);
  replyFor(w, 'getTxByHash', () => responseOf(ok({ ...JSON.parse(signed.signedTransaction), status: 'failed', blockNumber: 1 })));
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'pending', 'included but failed');
  assert.deepEqual(spentIds(w), []); w.reply = null;
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'applied');
  assert.deepEqual(spentIds(w), ['TEST-ledger-1']);
});

// Replies as a live node records them: block one with every member of its `content`, and an executed transaction with the members the node adds.
const recordedJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const recordedBlockOne = JSON.parse(recordedJson('../../../conformance/tp1-node-observations/block1.json').body).response;
const recordedExecuted = Object.values(recordedJson('../../../test/fixtures/demos-node2-records.json').getTxByHash)[0].response;
const liveBlock = (ordered, content = {}) => ({ ...recordedBlockOne, number: 1, content: { ...recordedBlockOne.content, previousHash: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, ordered_transactions: ordered, ...content } });
const liveExecuted = (signed, extra = {}) => ({ ...JSON.parse(signed.signedTransaction), ed25519_signature: recordedExecuted.ed25519_signature, attrs: recordedExecuted.attrs, status: 'confirmed', blockNumber: 1, ...extra });
const serveReadback = (w, executed, block) => {
  const answers = { getTransactionStatus: ok({ state: 'included', blockNumber: 1 }), getTxByHash: ok(executed), getBlockByNumber: ok(block) };
  w.reply = row => (Object.hasOwn(answers, messageOf(row)) && (messageOf(row) !== 'getBlockByNumber' || row.body.params[0].data.blockNumber === 1) ? responseOf(answers[messageOf(row)]) : undefined);
};

test("a block recorded from a live node, with all ten members of its content, answers applied when it lists the hash and pending when it does not", async t => {
  assert.equal(Object.keys(recordedBlockOne.content).length, 10, 'the fixture is the live shape');
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  applyWithoutBroadcast(w, signed);
  for (const [name, ordered] of [['no transactions', []], ['another transaction only', ['c'.repeat(64)]]]) {
    serveReadback(w, liveExecuted(signed), liveBlock(ordered));
    const answer = await w.adapter.readTransactionState(signed);
    assert.equal(answer.state, 'pending', name); assert.ok(w.session.internalCauseOf(answer), `${name}: the cause is kept`);
  }
  assert.deepEqual(spentIds(w), []);
  serveReadback(w, liveExecuted(signed), liveBlock(['c'.repeat(64), signed.txHash]));
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'applied');
  assert.deepEqual(spentIds(w), ['TEST-ledger-1']);
});

test("the executed record a live node serves, with its empty dual signature and attrs, is applied; any other member, a dual signature, a block with no listing or another chain identity is pending", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  applyWithoutBroadcast(w, signed);
  const listed = liveBlock([signed.txHash]);
  const refused = {
    'an unknown member of the executed record': [liveExecuted(signed, { TEST_extra: 1 }), listed],
    'a non-empty dual signature': [liveExecuted(signed, { ed25519_signature: `0x${'1'.repeat(128)}` }), listed],
    'attrs that are not an object': [liveExecuted(signed, { attrs: 'TEST' }), listed],
    'block content without a listing': [liveExecuted(signed), liveBlock(undefined)],
    'a listing that is not an array': [liveExecuted(signed), liveBlock(signed.txHash)],
    'a block one that follows another chain': [liveExecuted(signed), liveBlock([signed.txHash], { previousHash: 'd'.repeat(64) })],
    'an unknown member of the block': [liveExecuted(signed), { ...listed, TEST_extra: 1 }],
  };
  for (const [name, [executed, block]] of Object.entries(refused)) {
    serveReadback(w, executed, block);
    const answer = await w.adapter.readTransactionState(signed);
    assert.equal(answer.state, 'pending', name); assert.ok(w.session.internalCauseOf(answer), `${name}: the cause is kept`);
  }
  assert.deepEqual(spentIds(w), []);
  serveReadback(w, liveExecuted(signed), listed);
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'applied');
  assert.deepEqual(spentIds(w), ['TEST-ledger-1']);
});

test("a readback body with the matching hash but changed signed fields, changed execution edits or changed fees is pending, never applied; equal hashes in a scripted answer do not suffice", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w)), original = JSON.parse(signed.signedTransaction);
  applyWithoutBroadcast(w, signed);
  const changes = { nonce: c => ({ ...c, nonce: c.nonce + 1 }), data: c => ({ ...c, data: ['storageProgram', { ...c.data[1], programName: 'TEST-other' }] }),
    edits: c => ({ ...c, gcr_edits: c.gcr_edits.map((edit, index) => (index === 0 ? { ...edit, amount: '1' } : edit)) }),
    fees: c => ({ ...c, transaction_fee: { ...c.transaction_fee, network_fee: '7' } }), amount: c => ({ ...c, amount: '5' }) };
  for (const [name, change] of Object.entries(changes)) {
    replyFor(w, 'getTxByHash', () => responseOf(ok({ ...original, content: change(original.content), status: 'confirmed', blockNumber: 1 })));
    const answer = await w.adapter.readTransactionState(signed);
    assert.equal(answer.state, 'pending', name); assert.ok(w.session.internalCauseOf(answer), `${name}: the cause is kept`);
  }
  assert.deepEqual(spentIds(w), []); assert.notEqual((await recordOf(w)).active, null);
});

test("reopened before the first readback, readTransactionState compares the chain with the retained projection the reservation holds, not an in-memory copy", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  applyWithoutBroadcast(w, signed); await w.restart();
  assert.equal((await w.adapter.readTransactionState({ ...signed, signedTransaction: ` ${signed.signedTransaction}` })).state, 'pending', 'other text than the held bytes');
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'applied');
  assert.equal((await recordOf(w)).active, null, 'the execution ended the reservation');
});

test("a broadcast of bytes the reservation does not hold refuses with no egress, and a readback of bytes that are not this signer's signed CREATE answers pending with the cause kept", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w)), tx = JSON.parse(signed.signedTransaction);
  const callsBefore = w.node.calls.length;
  for (const bad of [{ ...signed, txHash: 'f'.repeat(64) }, { ...signed, signedTransaction: ` ${signed.signedTransaction}` },
    { ...signed, signedTransaction: JSON.stringify({ ...tx, signature: { ...tx.signature, data: `0x${'7'.repeat(128)}` } }) }]) {
    await assert.rejects(broadcastIn(w, bad), { code: 'retained_transaction_invalid' });
    const answer = await w.adapter.readTransactionState(bad);
    assert.equal(answer.state, 'pending'); assert.equal(w.session.internalCauseOf(answer).code, 'retained_transaction_invalid');
  }
  assert.equal(w.node.calls.length, callsBefore, 'no node call'); assertNothingSent(w);
  const other = await replayWorld(t);
  await assert.rejects(broadcastIn(other, signed), { code: 'retained_transaction_invalid' }, 'no reservation holds these bytes');
  assertNothingSent(other);
});

test("readAccountNonce returns a scalar nonce and readTransactionState never answers absent, so the journal's supersession stays disabled", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  assert.equal(await w.adapter.readAccountNonce(), 0); w.node.nonce = '5'; assert.equal(await w.adapter.readAccountNonce(), 5);
  replyFor(w, 'getAddressNonce', () => responseOf(ok({ nonce: 5, blockHeight: 9 })));
  await assert.rejects(w.adapter.readAccountNonce(), { code: 'invalid_nonce' });
  for (const answer of [await w.adapter.readTransactionState(signed), await w.adapter.readTransactionState({ ...signed, signedTransaction: '{' })]) assert.deepEqual(answer, { state: 'pending' });
});

test("an authenticated applied readback with no approval in this process, also after restart, consumes the transaction and settles its authorization spent once by id; a repeated applied settles nothing new", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  applyWithoutBroadcast(w, signed); await w.restart();
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'applied');
  assert.deepEqual(spentIds(w), ['TEST-ledger-1']); assert.equal((await recordOf(w)).active, null);
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'applied', 'applied again with no reservation left');
  assert.equal(w.approval.settlements.filter(call => call.outcome === 'spent').length, 1, 'settled once');
  assert.equal((await recordOf(w)).floor, signed.nonce + 1);
});

test("a reservation write that fails after the authorization was settled spent leaves an unchanged record and a pending answer, and the next readback ends it with one settlement", async t => {
  const { faults, wrap } = failingJournal(), w = await replayWorld(t, { journalWrap: wrap }), signed = await signIn(w, evidenceInput(w));
  applyWithoutBroadcast(w, signed); const held = await recordOf(w);
  faults.failPut = (key, value) => key.startsWith(RECORD_KEY_PREFIX) && value?.active === null;
  const first = await w.adapter.readTransactionState(signed);
  assert.equal(first.state, 'pending'); assert.match(w.session.internalCauseOf(first).message, /TEST-put-failed/);
  assert.deepEqual(await recordOf(w), held, 'the record is unchanged'); assert.deepEqual(spentIds(w), ['TEST-ledger-1'], 'the authorization is already spent');
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'applied');
  assert.equal((await recordOf(w)).active, null); assert.deepEqual(w.approval.settlements.map(call => `${call.ledgerId}/${call.outcome}`).filter((row, index, rows) => rows.indexOf(row) === index), ['TEST-ledger-1/spent'], 'one id and outcome settled');
});

test("held, signCreate and broadcast reject profile_not_admitted with signer and node calls 0; the reads keep working", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  setPurchaseAdmission('held'); const callsBefore = w.node.calls.length, signatures = w.innerSigns.length;
  await assert.rejects(signIn(w, evidenceInput(w)), { code: 'profile_not_admitted' });
  await assert.rejects(broadcastIn(w, signed), { code: 'profile_not_admitted' });
  assert.equal(w.node.calls.length, callsBefore, 'node calls 0'); assert.equal(w.innerSigns.length, signatures, 'signer calls 0');
  assert.equal(await w.adapter.readAccountNonce(), 0); assert.equal((await w.adapter.readTransactionState(signed)).state, 'pending');
});

test("readAccountNonce and readTransactionState honour the received signal: after an abort no further read in that sequence starts, and no consume or settlement happens", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  await assert.rejects(w.adapter.readAccountNonce({ signal: AbortSignal.abort(new Error('TEST-aborted-early')) }), /TEST-aborted-early/);
  applyWithoutBroadcast(w, signed); const controller = new AbortController(), reads = [];
  w.reply = row => { reads.push(messageOf(row)); if (messageOf(row) === 'getTransactionStatus') controller.abort(new Error('TEST-deadline')); };
  assert.equal((await w.adapter.readTransactionState(signed, { signal: controller.signal })).state, 'pending');
  assert.deepEqual(reads.slice(reads.indexOf('getTransactionStatus') + 1), [], 'no read starts after the abort');
  assert.deepEqual(w.approval.settlements, []); assert.notEqual((await recordOf(w)).active, null);
});

test("the inner signature and each confirm and broadcast transmission run through the effect gate; a gate refusal after signing keeps the bytes, records no transmission and transmits 0", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w)), events = [];
  await (await openPass(w, { events })).run(() => w.adapter.broadcast(signed));
  assert.ok(events.indexOf('authority:confirmTx') < events.indexOf('authority:broadcastTx') && events.includes('authority:broadcastTx'), 'both transmissions are gated in order');
  for (const phase of ['confirmTx', 'broadcastTx']) {
    const sentBefore = w.node.broadcasts.length, confirmedBefore = w.node.confirms.length;
    const pass = await openPass(w, { pass: { synchronousChecks: [({ phase: at }) => { if (at === phase) throw new Error('TEST-gate-refused'); }] } });
    await assert.rejects(pass.run(() => w.adapter.broadcast(signed)), error => causeChain(error).some(link => /TEST-gate-refused/.test(link.message)), phase);
    assert.equal(w.node.broadcasts.length, sentBefore, `${phase}: transmits 0`); assert.equal(w.node.confirms.length, confirmedBefore + (phase === 'confirmTx' ? 0 : 1));
    assert.equal((await recordOf(w)).active.signed.projectionText, signed.signedTransaction, `${phase}: the bytes are kept`);
  }
  assert.equal(w.signsInsideSign, 1, 'the one transaction signature');
});

test("after a restart, a replay reopens the original authorization by ledgerId and creates no second budgeted write; an authorization the operator released is replaced only by the exact request's open or new authorization, linked before any egress", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  await w.restart(); await broadcastIn(w, signed);
  assert.equal(w.approval.prepared.length, 1, 'no second write'); assert.equal((await recordOf(w)).active.approvalId, 'TEST-ledger-1');
  await w.approval.settle('TEST-ledger-1', 'released', 'TEST-operator-released');
  const linkedBeforeEgress = [];
  w.reply = async row => { if (messageOf(row) === 'confirmTx') linkedBeforeEgress.push((await recordOf(w)).active.approvalId); };
  await broadcastIn(w, signed);
  assert.equal(w.approval.prepared.length, 2, 'a new authorization'); assert.deepEqual(linkedBeforeEgress, ['TEST-ledger-2'], 'linked before the first transmission');
  assert.equal(w.approval.confirmations.at(-1).binding.ledgerId, 'TEST-ledger-2');
  await w.approval.settle('TEST-ledger-2', 'released', 'TEST-operator-released');
  w.approval.entries.push({ ledgerId: 'TEST-ledger-open', requestText: w.approval.entries[0].requestText });
  await broadcastIn(w, signed);
  assert.equal(w.approval.prepared.length, 2, 'the exact request\'s open authorization is used'); assert.equal((await recordOf(w)).active.approvalId, 'TEST-ledger-open');
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'applied');
  assert.deepEqual(spentIds(w), ['TEST-ledger-open'], 'only the linked authorization is spent');
});

test("a replacement authorization prepared but not linked is found by its exact request after a restart and linked without a second preparation", async t => {
  const { faults, wrap } = failingJournal(), w = await replayWorld(t, { journalWrap: wrap }), signed = await signIn(w, evidenceInput(w));
  await w.approval.settle('TEST-ledger-1', 'released', 'TEST-operator-released');
  faults.failPut = (key, value) => key.startsWith(RECORD_KEY_PREFIX) && value?.active?.approvalId === 'TEST-ledger-2';
  await assert.rejects(broadcastIn(w, signed), error => error.code === 'approval_required' && causeChain(error).some(link => /TEST-put-failed/.test(link.message)));
  assertNothingSent(w); assert.equal((await recordOf(w)).active.approvalId, 'TEST-ledger-1', 'the replacement is not linked');
  assert.equal(w.approval.prepared.length, 2, 'the replacement was prepared');
  await w.restart(); await broadcastIn(w, signed);
  assert.equal(w.approval.prepared.length, 2, 'no third preparation'); assert.equal((await recordOf(w)).active.approvalId, 'TEST-ledger-2');
  w.approval.lookupDown = true; w.approval.settled.set('TEST-ledger-2', 'released');
  await assert.rejects(broadcastIn(w, signed), { code: 'approval_required' }); assert.equal(w.approval.prepared.length, 2, 'an unreadable lookup never prepares another');
});

test("the confirmed-write callback runs once on the validated confirmation against the reopened binding; false, a throw or an unavailable binding broadcasts nothing and the authorization stays held", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  for (const result of [false, new Error('TEST-policy-down')]) {
    w.approval.confirmResult = result;
    await assert.rejects(broadcastIn(w, signed), { code: 'approval_required' });
  }
  w.approval.confirmResult = true; w.approval.lookupDown = true; w.approval.settled.set('TEST-ledger-1', 'released');
  await assert.rejects(broadcastIn(w, signed), { code: 'approval_required' });
  assert.equal(w.node.broadcasts.length, 0); assert.deepEqual(w.approval.settlements, [], 'nothing was released');
  assert.equal(w.approval.confirmations.length, 2, 'one callback per validated confirmation'); assert.deepEqual(w.approval.confirmations[0].binding, w.approval.entries[0]);
});

test("after successful confirmation and a lost broadcast answer, every replay calls the current policy again; unavailable purchase resolution, revoked payment observation or changed bound purchase data each broadcasts zero and retains the same authorization; valid evidence restored permits the exact-byte replay", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  replyFor(w, 'broadcastTx', row => { const tx = row.body.params[0].data.response.data.transaction; w.node.applied.set(tx.hash, tx); throw new Error('TEST-acknowledgement-lost'); });
  await assert.rejects(broadcastIn(w, signed), { code: 'outcome_unknown' }); w.reply = null;
  for (const refusal of ['purchase resolution unavailable', 'payment observation revoked', 'bound purchase data changed']) {
    w.approval.confirmResult = new Error(`TEST-${refusal}`);
    await assert.rejects(broadcastIn(w, signed), { code: 'approval_required' }, refusal);
  }
  assert.equal(w.node.broadcasts.length, 1, 'zero further dispatches'); assert.equal((await recordOf(w)).active.approvalId, 'TEST-ledger-1'); assert.deepEqual(w.approval.settlements, []);
  w.approval.confirmResult = true; await broadcastIn(w, signed);
  assert.equal(w.node.broadcasts.length, 2); assert.equal(w.approval.confirmations.length, 5, 'the policy ran on every replay');
  assert.equal(JSON.stringify(w.node.broadcasts[1]), signed.signedTransaction);
});

test("a lost broadcast answer followed by a withheld replay keeps the bytes and the authorization through two restarts, and a later permitted replay sends the same bytes", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w));
  replyFor(w, 'broadcastTx', () => { throw new Error('TEST-acknowledgement-lost'); });
  await assert.rejects(broadcastIn(w, signed), { code: 'outcome_unknown' }); w.reply = null; w.approval.confirmResult = false;
  const held = await recordOf(w);
  for (let reopen = 0; reopen < 2; reopen += 1) {
    await w.restart(); await assert.rejects(broadcastIn(w, signed), { code: 'approval_required' });
    assert.deepEqual(await recordOf(w), held, 'the record is unchanged'); assert.deepEqual(w.approval.settlements, []);
  }
  w.approval.confirmResult = true; await broadcastIn(w, signed);
  assert.equal(w.node.broadcasts.length, 2); assert.equal(JSON.stringify(w.node.broadcasts[1]), signed.signedTransaction);
});

const replyForms = {
  'an extra top-level member': answer => ({ ...answer, TEST_extra: 1 }),
  'an extra nested response member': answer => ({ ...answer, response: typeof answer.response === 'object' ? { ...answer.response, TEST_extra: 1 } : { value: answer.response, TEST_extra: 1 } }),
  'a forged writeProof': answer => ({ ...answer, response: typeof answer.response === 'object' ? { ...answer.response, writeProof: { TEST: 'forged' } } : { value: answer.response, writeProof: { TEST: 'forged' } } }),
  'a contradicting number': answer => (typeof answer.response?.blockNumber === 'number' ? { ...answer, response: { ...answer.response, blockNumber: 2 } }
    : typeof answer.response?.number === 'number' ? { ...answer, response: { ...answer.response, number: 2 } } : { ...answer, TEST_extra: 1 }),
  'a rejected answer': () => ({ result: 400, response: 'TEST-rejected', require_reply: false, extra: null }),
};
const readAnswers = signed => ({ getAddressNonce: ok(0), getTransactionStatus: ok({ state: 'included', blockNumber: 1 }),
  getTxByHash: ok({ ...JSON.parse(signed.signedTransaction), status: 'confirmed', blockNumber: 1 }),
  getBlockByNumber: ok({ number: 1, status: 'confirmed', hash: 'b'.repeat(64), content: { previousHash: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, ordered_transactions: [signed.txHash] } }) });
test("replies table (confirmTx, broadcastTx, getAddressNonce, getTransactionStatus, getTxByHash, getBlockByNumber) × (extra top-level or nested response member, forged writeProof, contradicting nested status or block number, rejected answer after dispatch): never confirmed/applied; broadcast is outcome_unknown; the reservation stays live; another address's signCreate refuses signer_lane_busy; settlements 0", async t => {
  for (const [form, forge] of Object.entries(replyForms)) {
    for (const message of ['confirmTx', 'broadcastTx', 'getAddressNonce', 'getTransactionStatus', 'getTxByHash', 'getBlockByNumber']) {
      const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w)), label = `${message} with ${form}`;
      if (message === 'confirmTx') {
        replyFor(w, message, row => responseOf(forge(successfulConfirmation(row.body.params[0].data))));
        await assert.rejects(broadcastIn(w, signed), { code: 'outcome_unknown' }, label); assert.equal(w.node.broadcasts.length, 0, `${label}: dispatches 0`);
      } else if (message === 'broadcastTx') {
        replyFor(w, message, row => { const { hash } = row.body.params[0].data.response.data.transaction; return responseOf(forge(ok({ hash }))); });
        await assert.rejects(broadcastIn(w, signed), { code: 'outcome_unknown' }, label); assert.equal(w.node.broadcasts.length, 1, `${label}: one dispatch`);
      } else {
        applyWithoutBroadcast(w, signed); replyFor(w, message, () => responseOf(forge(readAnswers(signed)[message])));
        if (message === 'getAddressNonce') await assert.rejects(w.adapter.readAccountNonce(), error => ['node_reply_invalid', 'invalid_nonce'].includes(error.code), label);
        else assert.equal((await w.adapter.readTransactionState(signed)).state, 'pending', label);
      }
      assert.deepEqual(w.approval.settlements, [], `${label}: settlements 0`); assert.equal((await recordOf(w)).active.signed.txHash, signed.txHash, `${label}: the reservation stays live`);
      await assert.rejects(signIn(w, evidenceInput(w, 'b')), { code: 'signer_lane_busy' }, label);
    }
  }
});

test("a node reply over 4 MiB is refused before it is decoded and a block listing more than 10,000 hashes is not trusted: the confirmation is unknown and the readback is pending", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w)), oversized = () => responseOf(ok('x'.repeat(4 * 1024 * 1024 + 1)));
  replyFor(w, 'confirmTx', oversized);
  await assert.rejects(broadcastIn(w, signed), { code: 'outcome_unknown' }); assert.equal(w.node.broadcasts.length, 0);
  applyWithoutBroadcast(w, signed); replyFor(w, 'getTxByHash', oversized);
  assert.equal((await w.adapter.readTransactionState(signed)).state, 'pending', 'oversized transaction');
  let executedRead = false; const crowded = readAnswers(signed).getBlockByNumber;
  crowded.response.content.ordered_transactions = [signed.txHash, ...Array(10_000).fill('c'.repeat(64))];
  w.reply = row => { if (messageOf(row) === 'getTxByHash') executedRead = true; if (executedRead && messageOf(row) === 'getBlockByNumber') return responseOf(crowded); };
  const answer = await w.adapter.readTransactionState(signed);
  assert.equal(answer.state, 'pending', 'oversized block list'); assert.equal(w.session.internalCauseOf(answer).code, 'readback_unverified');
  assert.deepEqual(spentIds(w), []);
});

test("broadcast with a never-settling fetch, aborted by the journal deadline: the call rejects, the signed bytes and authorization stay, and the next call is not blocked", async t => {
  const w = await replayWorld(t), signed = await signIn(w, evidenceInput(w)), deadline = new AbortController();
  w.reply = row => { if (messageOf(row) === 'broadcastTx') { deadline.abort(new Error('TEST-deadline')); return new Promise(() => {}); } };
  await assert.rejects(broadcastIn(w, signed, { signal: deadline.signal }), error => error.code === 'outcome_unknown' && causeChain(error).some(link => /TEST-deadline/.test(link.message)));
  assert.equal((await recordOf(w)).active.signed.txHash, signed.txHash); assert.deepEqual(w.approval.settlements, []);
  w.reply = null; assert.equal((await broadcastIn(w, signed)).status, 'accepted', 'the queue is free again');
});

test("no socket or DNS lookup leaves the process in the adapter suite", () => {
  assert.deepEqual(egress.attempts, []);
});
