// The passive readback of a native purchase's wallet lane after its one-time guard was issued: the public purchase
// service's nativePaymentLaneRead and the public protocol's readRetainedNativePaymentLane. Each purchase reaches its
// issued guard through the real approval, handoff and active lane read (helpers/retained-native-lane-world.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPurchaseAdmission } from './helpers/wire-client-fixture.mjs';
import { installRetainedReadbackStandIns } from './helpers/retained-native-readback-stand-ins.mjs';

const standIns = installRetainedReadbackStandIns();
const { retainedLaneWorld, NOW, IDENTITY } = await import('./helpers/retained-native-lane-world.mjs');
const { openDurableWalletJournal } = await import('../src/wallet/durable-journal.mjs');
const { walletLane } = await import('../src/wallet/wallet-lane.mjs');

const OTHER = 'a'.repeat(64);
const code = (expected) => (error) => error?.code === expected;
const iso = (ms) => new Date(ms).toISOString();
const envelopeOf = (p) => ({ readback: true, retained: { stage: 'broadcast-accepted', hash: p.txHash, nonce: p.createNonce } });
const PASSIVE_SERVICE = ['nativePaymentLaneRead', 'planRunning', 'portalEvidence', 'portalOperation', 'status', 'verifyDeal'];
const PASSIVE_PROTOCOL = ['assertBuyerAccess', 'assertSellerReceiptReservation', 'observeReportedPayment', 'readIssued', 'readIssuedPayment', 'readRetainedNativePaymentLane', 'supportsMode'];
const functionNames = (object) => Object.keys(object).filter((name) => typeof object[name] === 'function').sort();

async function issuedWorld(t, options) {
  const w = await retainedLaneWorld(t, standIns, options);
  return { w, p: await w.issue('TEST-issued') };
}
const serviceRecord = (w, p, service = w.service) => async (key = p.key) => (await service.nativePaymentLaneRead({ operationId: p.operationId, token: p.token, key })).record;
const protocolRecord = (w, p, protocol = w.protocol) => (key = p.key) => protocol.readRetainedNativePaymentLane(w.ops.get(w.accountId, p.operationId), key);
const bothEntries = (w, p) => [['service', serviceRecord(w, p)], ['protocol', protocolRecord(w, p)]];

// Each change edits one stored row through the world's database and returns its undo.
function changeColumn(w, table, column, where, args, next) {
  const { value } = w.db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${where}`).get(...args);
  const update = w.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where}`);
  update.run(typeof next === 'function' ? next(value) : next, ...args);
  return () => update.run(value, ...args);
}
function removeRows(w, table, where, args) {
  const rows = w.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...args);
  w.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args);
  return () => { for (const row of rows) w.db.prepare(`INSERT INTO ${table} (${Object.keys(row)}) VALUES (${Object.keys(row).map(() => '?')})`).run(...Object.values(row)); };
}
const json = (edit) => (text) => { const value = JSON.parse(text); edit(value); return JSON.stringify(value); };
const state = (edit) => (w, p) => changeColumn(w, 'operations', 'state', 'id = ?', [p.operationId], json(edit));
const terms = (edit) => (w, p) => changeColumn(w, 'operations', 'terms', 'id = ?', [p.operationId], json(edit));
const approval = (column, value) => (w, p) => changeColumn(w, 'approvals', column, 'operation_id = ?', [p.operationId], value);
const coordinate = (column, value) => (w, p) => changeColumn(w, 'write_coordinates', column, 'operation_id = ?', [p.operationId], value);
const event = (type, column, next) => (w, p) => changeColumn(w, 'operation_events', column, 'operation_id = ? AND type = ?', [p.operationId, type], next);
const eventData = (type, edit) => event(type, 'data', json(edit));
const removeEvent = (type) => (w, p) => removeRows(w, 'operation_events', 'operation_id = ? AND type = ?', [p.operationId, type]);
const receipt = (edit) => state((s) => edit(s.protocol.agreement.anchorReceipt));
const lane = (edit) => async (w, p) => {
  const key = `sr2/wallet/${p.key}`, before = await w.durable.get(key);
  await w.durable.put(key, edit(structuredClone(before)));
  return () => w.durable.put(key, before);
};

// Applies each change alone; `read` must refuse with the leg's code (before any journal read unless `journal`), then the change is undone.
async function refusesEach(w, legs, read, { journal = false } = {}) {
  for (const [label, change, expected] of legs) {
    const undo = await change(w, w.purchase), gets = w.counters.journalGets;
    await assert.rejects(read(), code(expected), label);
    if (!journal) assert.equal(w.counters.journalGets, gets, `${label}: refused before the journal read`);
    await undo();
  }
  assert.deepEqual(await read(), envelopeOf(w.purchase), 'the restored rows read back');
}
const noRefresh = (w, before) => assert.deepEqual([standIns.reads.agreement, standIns.reads.commitment, w.counters.sellerLookups, w.counters.broadcasts, w.native.writes.length],
  [before.agreementReads, before.commitmentReads, before.sellerLookups, before.broadcasts, before.journalWrites], 'no recheck, seller call, broadcast or journal write');

test('an issued native payment lane remains readable through the public purchase factory while stopped', async (t) => {
  const { w, p } = await issuedWorld(t);
  setPurchaseAdmission('held');
  w.stop = true;
  const rows = w.rows(), effects = w.effects(), stopReads = w.counters.stopReads, authorityCalls = w.authority.state.calls;
  assert.deepEqual(await serviceRecord(w, p)(), envelopeOf(p));
  assert.deepEqual(await protocolRecord(w, p)(), envelopeOf(p));
  assert.equal(w.counters.stopReads, stopReads, 'no stop check');
  assert.equal(w.authority.state.calls, authorityCalls, 'no authority or binding check');
  assert.equal(w.rows(), rows);
  assert.deepEqual(w.effects(), effects);
});

test('the passive native payment lane read refuses an invalid or expired handoff token before reading the lane', async (t) => {
  const { w, p } = await issuedWorld(t);
  w.stop = true;
  const read = (operationId, token) => w.service.nativePaymentLaneRead({ operationId, token, key: p.key });
  const rows = w.rows(), gets = w.counters.journalGets;
  for (const [label, operationId, token] of [['missing', p.operationId, undefined], ['malformed', p.operationId, 'x'], ['too long', p.operationId, 't'.repeat(1025)],
    ['altered', p.operationId, p.token.slice(0, -1) + (p.token.endsWith('A') ? 'B' : 'A')], ['another purchase\'s token', p.operationId, w.ops.handoffTokenFor('pur_TESTotherpurchase')],
    ['unknown purchase', 'pur_TEST-unknown', p.token]]) {
    await assert.rejects(read(operationId, token), code('not_found'), label);
  }
  const undo = changeColumn(w, 'operations', 'handoff_expires_at', 'id = ?', [p.operationId], iso(NOW));
  await assert.rejects(read(p.operationId, p.token), code('not_found'), 'expired');
  undo();
  assert.equal(w.counters.journalGets, gets);
  assert.equal(w.rows(), rows);
  assert.deepEqual(await serviceRecord(w, p)(), envelopeOf(p));
});

test('the passive native payment lane read refuses missing or mismatched approval signer and terms', async (t) => {
  const { w, p } = await issuedWorld(t);
  w.stop = true; w.purchase = p;
  const legs = [['approval removed', (w, p) => removeRows(w, 'approvals', 'operation_id = ?', [p.operationId]), 'native_payment_lane_held'],
    ['approval signer', approval('signer_address', w.seller.address), 'native_payment_lane_held'],
    ['approval terms hash', approval('terms_hash', OTHER), 'native_payment_lane_held'],
    ['approved terms hash', (w, p) => changeColumn(w, 'operations', 'terms_hash', 'id = ?', [p.operationId], OTHER), 'native_payment_lane_held']];
  for (const [, read] of bothEntries(w, p)) await refusesEach(w, legs, read);
});

test('the passive native payment lane read refuses an unissued handoff and altered coordinates', async (t) => {
  const w = await retainedLaneWorld(t, standIns);
  const unissued = await w.handOff('TEST-unissued');
  w.stop = true;
  const gets = w.counters.journalGets;
  for (const [label, read] of bothEntries(w, unissued)) await assert.rejects(read(), code('native_payment_lane_held'), `${label}: unissued`);
  assert.equal(w.counters.journalGets, gets);
  const { w: issued, p } = await issuedWorld(t);
  issued.stop = true; issued.purchase = p;
  const legs = [['coordinates removed', (w, p) => removeRows(w, 'write_coordinates', 'operation_id = ?', [p.operationId]), 'native_payment_lane_held'],
    ['nonce fence', coordinate('nonce_fence', p.expectedNonce), 'native_payment_lane_unverified'],
    ['expected nonce', coordinate('expected_nonce', p.expectedNonce + 1), 'native_payment_lane_unverified'],
    ['payload', coordinate('payload', json((payload) => { payload.TEST = 'changed'; })), 'native_payment_lane_unverified'],
    ['payload hash', coordinate('payload_hash', OTHER), 'native_payment_lane_unverified'],
    ['network', coordinate('network', 'devnet'), 'native_payment_lane_unverified'],
    ['sender', coordinate('from_address', issued.seller.address), 'native_payment_lane_unverified'],
    ['target', coordinate('target', issued.wallet.address), 'native_payment_lane_unverified'],
    ['amount', coordinate('amount_os', '1'), 'native_payment_lane_unverified']];
  for (const [, read] of bothEntries(issued, p)) await refusesEach(issued, legs, read);
});

test('the passive native payment lane read refuses a foreign domain or lane key without refreshing either', async (t) => {
  const { w, p } = await issuedWorld(t);
  w.stop = true; w.purchase = p;
  const before = w.effects(), keys = [walletLane({ network: 'testnet', chainIdentity: IDENTITY, address: w.seller.address }), walletLane({ network: 'testnet', chainIdentity: OTHER, address: w.wallet.address })];
  for (const [label, read] of bothEntries(w, p)) {
    for (const key of keys) await assert.rejects(read(key), code('wallet_lane_mismatch'), `${label}: ${key}`);
    await refusesEach(w, [['domain identity', terms((t) => { t.domain.chainIdentity = OTHER; }), 'native_payment_lane_unverified'],
      ['domain mode', terms((t) => { t.domain.mode = 'simulated-fixture'; }), 'native_payment_lane_unverified'],
      ['domain network', terms((t) => { t.domain.network = 'devnet'; }), 'native_payment_lane_unverified']], read);
  }
  // The configured RPC now reports another chain: the service refuses before the journal read; the protocol makes no live read.
  w.observedIdentity = OTHER;
  const identityReads = w.counters.identityReads, gets = w.counters.journalGets;
  await assert.rejects(serviceRecord(w, p)(), code('network_identity_mismatch'));
  assert.equal(w.counters.identityReads, identityReads + 1, 'one read-only identity read');
  assert.equal(w.counters.journalGets, gets);
  assert.deepEqual(await protocolRecord(w, p)(), envelopeOf(p));
  assert.equal(w.counters.identityReads, identityReads + 1, 'the protocol entry reads no live identity');
  noRefresh(w, before);
});

test('the passive native payment lane read refuses stale or unverified protocol evidence without a recheck', async (t) => {
  const { w, p } = await issuedWorld(t);
  w.stop = true; w.purchase = p;
  const before = w.effects(), unverified = 'native_payment_lane_unverified';
  const legs = [
    ['handoff commitment removed', eventData('payment_handoff', (d) => { delete d.commitment; }), unverified],
    ['handoff commitment changed', eventData('payment_handoff', (d) => { d.commitment = OTHER; }), unverified],
    ['seller commitment witness removed', eventData('payment_handoff', (d) => { delete d.sellerCommitmentWitness; }), unverified],
    ['seller commitment witness changed', eventData('payment_handoff', (d) => { d.sellerCommitmentWitness = OTHER; }), unverified],
    ['handoff payload hash', eventData('payment_handoff', (d) => { d.payloadHash = OTHER; }), unverified],
    ['handoff recheck removed', eventData('payment_handoff', (d) => { delete d.recheck; }), unverified],
    ['handoff recheck changed', eventData('payment_handoff', (d) => { d.recheck = 'simulated-fixture'; }), unverified],
    ['prepared chain mode removed', state((s) => { delete s.preparedVerification.evidence.chainMode; }), unverified],
    ['prepared chain mode changed', state((s) => { s.preparedVerification.evidence.chainMode = 'simulated-fixture'; }), unverified],
    ['issuance hash', eventData('protocol_native_wallet_guard_issued', (d) => { d.createHash = OTHER; }), unverified],
    ['issuance nonce', eventData('protocol_native_wallet_guard_issued', (d) => { d.createNonce += 1; }), unverified],
    ['issuance nonce as text', eventData('protocol_native_wallet_guard_issued', (d) => { d.createNonce = String(d.createNonce); }), unverified],
    ['receipt hash', receipt((r) => { r.transactionRef.value = OTHER; }), unverified],
    ['receipt nonce value', receipt((r) => { r.nonce = String(Number(r.nonce) + 1); }), unverified],
    ['receipt nonce not canonical', receipt((r) => { r.nonce = `0${r.nonce}`; }), unverified],
    ['receipt nonce unsafe', receipt((r) => { r.nonce = '9007199254740993'; }), unverified],
    ['receipt evidence', receipt((r) => { r.evidence.value = 'TEST'; }), unverified],
    ['commitment signer', state((s) => { s.protocol.commitment.signer = 'did:demos:agent:' + OTHER; }), unverified],
    ['commitment content hash', state((s) => { s.protocol.commitment.contentHash = OTHER; }), unverified],
    ['commitment time', state((s) => { s.protocol.commitment.committedAt = 'TEST-not-a-time'; }), unverified],
    ['commitment verified after the handoff', state((s) => { s.protocol.commitment.verifiedAt = iso(NOW + 1); }), unverified],
    ['protocol stage', state((s) => { s.protocol.stage = 'payment-observed'; }), unverified],
    ['issued bit', state((s) => { delete s.protocol.nativePaymentLaneIssued; }), 'native_payment_lane_held'],
    ['operation terms', terms((t) => { t.listing.contentHash = OTHER; }), unverified]];
  for (const [, read] of bothEntries(w, p)) await refusesEach(w, legs, read);
  // The protocol checks the declared transport binding against its own source capability, before the journal read.
  for (const [, read] of bothEntries(w, p)) await refusesEach(w, [['transport binding', terms((t) => { t.protocol.transportBinding.pinVersion = 'TEST-other-pin'; }), unverified]], read);
  // A valid receipt and issuance whose retained lane changed is fenced.
  const fenced = [['lane hash', lane((r) => ({ ...r, hash: OTHER })), 'wallet_fenced'], ['lane nonce', lane((r) => ({ ...r, nonce: r.nonce + 1 })), 'wallet_fenced'],
    ['lane stage', lane((r) => ({ ...r, stage: 'broadcast-started' })), 'wallet_fenced']];
  for (const [, read] of bothEntries(w, p)) await refusesEach(w, fenced, read, { journal: true });
  noRefresh(w, before);
});

test('repeated passive native payment lane reads preserve the one-time bit and journal and never issue a wallet guard', async (t) => {
  const { w, p } = await issuedWorld(t);
  const rows = w.rows(), entries = await w.durable.entries(), effects = w.effects();
  for (const read of [serviceRecord(w, p), protocolRecord(w, p), serviceRecord(w, p), protocolRecord(w, p)]) {
    const record = await read();
    assert.deepEqual(record, envelopeOf(p));
    assert.deepEqual(Object.keys(record).sort(), ['readback', 'retained']);
  }
  assert.equal(w.rows(), rows);
  assert.deepEqual(await w.durable.entries(), entries);
  assert.deepEqual(w.effects(), effects);
  assert.equal(w.ops.get(w.accountId, p.operationId).state.protocol.nativePaymentLaneIssued, true);
  assert.equal(w.ops.history(p.operationId).filter((event) => event.type === 'protocol_native_wallet_guard_issued').length, 1);
  const reopened = openDurableWalletJournal({ path: w.journalPath, mode: 'open', expectedJournalId: w.durable.journalId });
  try { assert.deepEqual(await reopened.entries(), entries); } finally { reopened.close(); }
  assert.deepEqual(await serviceRecord(w, p)(), envelopeOf(p), 'read again after the journal was reopened');
});

test('a stopped passive native payment lane read saves no expiry or suspension and invokes no stop assertion', async (t) => {
  const { w, p } = await issuedWorld(t);
  w.stop = true;
  const rows = w.rows(), stopReads = w.counters.stopReads;
  assert.deepEqual(await serviceRecord(w, p)(), envelopeOf(p));
  assert.equal(w.counters.stopReads, stopReads);
  assert.equal(w.rows(), rows);
  assert.doesNotMatch(w.rows(), /suspen/);
  // The active lane read in the same composition still refuses while stopped.
  await assert.rejects(w.service.nativePaymentLane({ operationId: p.operationId, token: p.token, key: p.key }), code('writes_stopped'));
  // An elapsed approval read with a valid token (the handoff lifetime outlasts the approval window) saves no expiry.
  const elapsedWorld = await retainedLaneWorld(t, standIns);
  const elapsed = await elapsedWorld.seedCommitted('TEST-elapsed', { status: 'agreement_pending', expiresAt: iso(NOW - 1) });
  const elapsedRows = elapsedWorld.rows();
  await assert.rejects(serviceRecord(elapsedWorld, elapsed)(), code('native_payment_lane_held'));
  assert.equal(elapsedWorld.rows(), elapsedRows);
  assert.equal(elapsedWorld.ops.get(elapsedWorld.accountId, elapsed.operationId).status, 'agreement_pending');
});

test('a passive-only purchase composition retains the authenticated native payment lane read', async (t) => {
  const { w, p } = await issuedWorld(t);
  setPurchaseAdmission('held');
  w.stop = true;
  const readOnly = w.compose({ passiveOnly: true });
  assert.deepEqual(functionNames(readOnly.service), PASSIVE_SERVICE);
  assert.deepEqual(functionNames(readOnly.protocol), PASSIVE_PROTOCOL);
  w.purchase = p;
  const entries = [serviceRecord(w, p, readOnly.service), protocolRecord(w, p, readOnly.protocol)];
  for (const read of entries) {
    assert.deepEqual(await read(), envelopeOf(p));
    await refusesEach(w, [['prepared chain mode removed', state((s) => { delete s.preparedVerification.evidence.chainMode; }), 'native_payment_lane_unverified'],
      ['prepared chain mode changed', state((s) => { s.preparedVerification.evidence.chainMode = 'simulated-fixture'; }), 'native_payment_lane_unverified']], read);
  }
  await assert.rejects(readOnly.service.nativePaymentLaneRead({ operationId: p.operationId, token: 'x', key: p.key }), code('not_found'));
});

test('two ordinary Agreement CREATEs keep the second retained CREATE nonce distinct from its payment nonce', async (t) => {
  const w = await retainedLaneWorld(t, standIns);
  const first = await w.issue('TEST-first', { createNonce: 1 });
  // The first payment was never sent: cancelling it releases the shared wallet before the second CREATE.
  const cancelled = await w.service.cancel({ accountId: w.accountId, operationId: first.operationId });
  assert.equal(cancelled.operation.status, 'cancelled');
  const second = await w.issue('TEST-second', { createNonce: first.createNonce + 1 });
  const retained = w.ops.get(w.accountId, second.operationId).state.protocol.agreement.anchorReceipt.nonce;
  assert.equal(retained, '2');
  assert.equal(second.guard.nonce, 2);
  assert.equal(second.expectedNonce, 3);
  w.stop = true;
  for (const [label, read] of bothEntries(w, second)) {
    const record = await read();
    assert.deepEqual(record, envelopeOf(second), label);
    assert.notEqual(record.retained.nonce, second.expectedNonce, label);
  }
  await assert.rejects(serviceRecord(w, first)(), code('native_payment_lane_held'), 'the cancelled purchase has no handoff');
});

test('a missing or changed handoff event binding refuses before journal read', async (t) => {
  const { w, p } = await issuedWorld(t);
  w.stop = true; w.purchase = p;
  const unverified = 'native_payment_lane_unverified';
  const legs = [['handoff event removed', removeEvent('payment_handoff'), unverified],
    ['issuance event removed', removeEvent('protocol_native_wallet_guard_issued'), unverified],
    ['issuance before the handoff', event('protocol_native_wallet_guard_issued', 'seq', 0), unverified],
    ['handoff before the verified commitment', event('payment_handoff', 'at', iso(NOW - 120_000)), unverified],
    ['handoff event data, same seq', eventData('payment_handoff', (d) => { d.expectedNonce += 1; }), unverified],
    ['issuance event data, same seq', eventData('protocol_native_wallet_guard_issued', (d) => { d.createHash = OTHER; }), unverified]];
  for (const [, read] of bothEntries(w, p)) await refusesEach(w, legs, read);
});

// The five row kinds a pending journal read must see unchanged; each change is made while the read waits.
const PENDING_CHANGES = [['operation state member', state((s) => { s.protocol.TEST = 'changed'; })], ['approval row', approval('approved_at', iso(NOW + 1))],
  ['coordinate row', coordinate('handoffs', 5)], ['handoff event data, same seq', eventData('payment_handoff', (d) => { d.TEST = 'changed'; })],
  ['issuance event data, same seq', eventData('protocol_native_wallet_guard_issued', (d) => { d.TEST = 'changed'; })]];

test('a retained row changed while the journal read is pending refuses with no effect', async (t) => {
  for (const entry of ['service', 'protocol']) {
    for (const [label, change] of PENDING_CHANGES) {
      const { w, p } = await issuedWorld(t);
      w.stop = true;
      const effects = w.effects(), rows = w.rows(), read = entry === 'service' ? serviceRecord(w, p) : protocolRecord(w, p);
      const hold = w.holdJournalGet(), pending = read();
      await hold.reached;
      const undo = change(w, p);
      hold.release();
      await assert.rejects(pending, code('native_payment_lane_unverified'), `${entry}: ${label}`);
      undo();
      assert.equal(w.rows(), rows, `${entry}: ${label}`);
      assert.deepEqual(w.effects(), effects, `${entry}: ${label}`);
    }
  }
});

test('retained readback envelopes have no issuable guard fields including stopped repeats', async (t) => {
  const { w, p } = await issuedWorld(t);
  assert.deepEqual(Object.keys(p.guard).sort(), ['hash', 'nonce', 'stage'], 'the issued guard');
  w.stop = true;
  for (const admission of ['testnet-tp1', 'held']) {
    setPurchaseAdmission(admission);
    for (let repeat = 0; repeat < 3; repeat++) {
      for (const [label, read] of bothEntries(w, p)) {
        const record = await read();
        assert.equal(record.readback, true, label);
        for (const field of ['stage', 'hash', 'nonce']) assert.equal(Object.hasOwn(record, field), false, `${label} ${admission}: ${field}`);
        assert.notDeepEqual(record, p.guard, label);
      }
    }
  }
});

test('the public service rejects each invalid retained predicate before a controlled protocol member runs', async (t) => {
  const { w, p } = await issuedWorld(t);
  w.purchase = p;
  const member = { calls: 0, during: null };
  const controlled = { available: true,
    assertBuyerAccess(wallet) { if (wallet !== w.wallet.address) throw new Error('TEST unknown buyer'); },
    async readRetainedNativePaymentLane() { member.calls++; await member.during?.(); return envelopeOf(p); } };
  const service = w.serviceWith(controlled, { withStop: false }), read = serviceRecord(w, p, service);
  assert.deepEqual(await read(), envelopeOf(p));
  assert.equal(member.calls, 1, 'the valid control calls the member once');
  const unverified = 'native_payment_lane_unverified';
  const legs = [['approval signer', approval('signer_address', w.seller.address), 'native_payment_lane_held'],
    ['approval terms hash', approval('terms_hash', OTHER), 'native_payment_lane_held'],
    ['native profile', terms((t) => { t.protocol.nativePayment = 'TEST-other'; }), 'native_payment_lane_held'],
    ['coordinate network', coordinate('network', 'devnet'), unverified], ['coordinate sender', coordinate('from_address', w.seller.address), unverified],
    ['coordinate target', coordinate('target', w.wallet.address), unverified], ['coordinate amount', coordinate('amount_os', '1'), unverified],
    ['coordinate payload', coordinate('payload', json((payload) => { payload.TEST = 'changed'; })), unverified],
    ['coordinate nonce', coordinate('expected_nonce', p.expectedNonce + 1), unverified],
    ['handoff commitment', eventData('payment_handoff', (d) => { d.commitment = OTHER; }), unverified],
    ['handoff witness', eventData('payment_handoff', (d) => { d.sellerCommitmentWitness = OTHER; }), unverified],
    ['handoff recheck', eventData('payment_handoff', (d) => { d.recheck = 'simulated-fixture'; }), unverified],
    ['retained chain mode', state((s) => { s.preparedVerification.evidence.chainMode = 'simulated-fixture'; }), unverified],
    ['issued bit', state((s) => { s.protocol.nativePaymentLaneIssued = false; }), 'native_payment_lane_held'],
    ['issuance hash', eventData('protocol_native_wallet_guard_issued', (d) => { d.createHash = OTHER; }), unverified],
    ['issuance nonce', eventData('protocol_native_wallet_guard_issued', (d) => { d.createNonce += 1; }), unverified],
    ['receipt hash', receipt((r) => { r.transactionRef.value = OTHER; }), unverified],
    ['declared binding network', terms((t) => { t.protocol.transportBinding.network = 'devnet'; }), unverified],
    ['declared binding identity', terms((t) => { t.protocol.transportBinding.chainIdentity = OTHER; }), unverified],
    ['live identity', () => { w.observedIdentity = OTHER; return () => { w.observedIdentity = IDENTITY; }; }, 'network_identity_mismatch']];
  for (const [label, change, expected] of legs) {
    const undo = change(w, p), calls = member.calls;
    await assert.rejects(read(), code(expected), label);
    assert.equal(member.calls, calls, `${label}: the member never ran`);
    undo();
  }
  // Each row the member could see change is read again by the service before it returns.
  for (const [label, change] of PENDING_CHANGES) {
    let undo;
    member.during = () => { undo = change(w, p); };
    await assert.rejects(read(), code(unverified), label);
    member.during = null;
    undo();
  }
  assert.deepEqual(await read(), envelopeOf(p));
  const gets = w.counters.journalGets, buyerAccess = w.counters.buyerAccess;
  await assert.rejects(serviceRecord(w, p, w.serviceWith(null, { withStop: false }))(), code('dacs_protocol_unavailable'));
  assert.deepEqual([w.counters.journalGets, w.counters.buyerAccess], [gets, buyerAccess], 'no retained read without a protocol');
});
