import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { contentHash, storAddress, signComponentArtifact, ARTIFACT_SEPARATORS } from '@kynesyslabs/dacs';
import { loadConfig } from '../src/config.mjs';
import { createMcpServerFactory } from '../src/mcp/server.mjs';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createAccountService } from '../src/accounts.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { createProtocolPurchases, protocolView, holdCompletedBundle } from '../src/dacs/protocol-purchases.mjs';
import { createDeliveryDeadlineWatch, DELIVERY_DEADLINE_SWEEP_MS, DELIVERY_DEADLINE_GRACE_MS, DELIVERY_DEADLINE_STOP_MS, DELIVERY_TIME_SOURCE } from '../src/dacs/delivery-deadline-watch.mjs';
import { NATIVE_AGREEMENT_PAYMENT } from '../src/dacs/native-agreement-payment-consumer.mjs';
import { SELLER_SR2_PUBLIC_PROJECTION } from '../src/dacs/seller-sr2-agreement-consumer.mjs';
import { readDelivery } from '../src/dacs/delivery-readback.mjs';
import { agreementTerms, deliverableAddress, deliveryEvidenceAddress, PROTOCOL_PROFILE } from '../src/dacs/purchase-protocol.mjs';
import { signAnchorWrite, canonicalSignature, fixtureWriteHash, FIXTURE_SUBSTRATE, FIXTURE_FINALITY } from '../src/dacs/fixture-anchors.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const deadline = Date.parse('2026-10-08T12:00:00Z');
const afterGrace = deadline + DELIVERY_DEADLINE_GRACE_MS + 1;
const baseEnv = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: 'https://issuer.example', DACS_DATABASE_PATH: ':memory:' };
const fakeTimer = () => ({ runs: [], cancelled: [], delays: [], every(run, ms) { this.runs.push({ run, ms }); return this.runs.length; }, cancel(handle) { this.cancelled.push(handle); }, after(run, ms) { this.delays.push({ run, ms }); return run; }, cancelAfter() {} });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function world(t, { enabled = true, status = 'settled_verified', agreed = true, paid = true, delivery = null, stage = 'payment-evidenced' } = {}) {
  let time = deadline;
  const now = () => time, db = openDatabase(':memory:'); t.after(() => db.close());
  const accounts = createAccountService({ db, builtinIssuer: 'https://plugin.example/oauth', now });
  const account = accounts.resolveFromToken({ issuer: 'https://issuer.example', subject: 'TEST-buyer' });
  const ops = createOperationStore({ db, handoffSecret: 'TEST-only-secret'.repeat(4), now }), coordinates = createCoordinateStore({ db, now });
  const buyer = createEphemeralWallet(), seller = createEphemeralWallet();
  // Stored previously verified Agreement/commitment boundary; delivery below runs the SDK verifier.
  const agreement = { jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', listingRef: { listingId: 'TEST', version: 1, contentHash: 'a'.repeat(64) },
    parties: [{ role: 'buyer', primaryClaim: buyer.claim }, { role: 'seller', primaryClaim: seller.claim }],
    terms: { deadline, price: { amount: '1', currency: 'DEM' }, payoutBindings: [{ phaseIndex: 0, railId: 'dem:devnet:DEM', payeeAddress: seller.address }] } };
  const terms = { protocol: { profile: PROTOCOL_PROFILE, jobId: agreement.jobId, sellerAgent: 'http://127.0.0.1:1', substrate: 'TEST' },
    buyer: { wallet: buyer.address }, seller: { claim: seller.claim, payee: seller.address }, listing: { ...agreement.listingRef, deadline: deadline - 900000 }, deadline: deadline - 800000,
    price: { amount: '1', amountOs: '1000000000' }, network: 'TEST', rail: 'TEST', approvalExpiresAt: new Date(deadline).toISOString(), domain: { mode: 'simulated-fixture' } };
  const protocolState = { stage, attempts: [], ...(agreed ? { agreement: { artifact: agreement, hash: contentHash(agreement), ref: { contentHash: contentHash(agreement) }, terms: agreementTerms(agreement) }, commitment: { contentHash: 'b'.repeat(64), verifiedAt: new Date(deadline - 1000).toISOString() } } : {}),
    paymentEvidence: { ref: { contentHash: 'c'.repeat(64) } }, ...(delivery ? { delivery } : {}) };
  const { operation } = ops.createIdempotent({ accountId: account.id, kind: 'purchase', idempotencyKey: 'TEST', request: { deadline: deadline - 700000 }, status, terms, termsHash: contentHash(terms),
    expiresAt: new Date(deadline + 86400000).toISOString(), state: { protocol: protocolState } });
  coordinates.save({ operationId: operation.id, kind: 'purchase', network: 'TEST', from: buyer.address, target: seller.address, nonceFence: 0, expectedNonce: 1, payload: {} });
  coordinates.reportHash(operation.id, 'd'.repeat(64));
  coordinates.recordObservation(operation.id, { chainMode: 'simulated-fixture', observation: { txHash: 'd'.repeat(64), blockNumber: 1 } }, paid);
  const timer = fakeTimer(), logs = [], watch = createDeliveryDeadlineWatch({ db, ops, coordinates, enabled, now, timer, logger: { warn: (...args) => logs.push(args) } });
  const config = loadConfig({ ...baseEnv, DACS_DELIVERY_DEADLINE_WATCH: enabled ? 'on' : 'off' });
  const purchases = createPurchaseService({ db, config, ops, coordinates, accounts, now, protocol: {} });
  const get = () => ops.get(account.id, operation.id);
  return { db, ops, coordinates, now, accounts, account, config, buyer, seller, agreement, terms, operation, watch, timer, logs, purchases, get, clock: (at) => { time = at; } };
}

async function reader(w, at = null) {
  const records = new Map(), reads = [], sellerRequests = [];
  if (at !== null) {
    const report = { jobId: w.agreement.jobId, agreementHash: contentHash(w.agreement), TEST: 'purchased report' };
    const evidence = await signComponentArtifact({ evidenceVersion: '1', jobId: w.agreement.jobId, phase: 'deliver-storage-program', outcome: 'success',
      deliverableContentHash: contentHash(report), deliverableAnchor: { kind: 'storage-program', locator: deliverableAddress(w.agreement.jobId) }, observedAt: at },
      ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: w.seller.claim, sign: w.seller.signBytes });
    for (const [address, artifact] of [[deliverableAddress(w.agreement.jobId), report], [deliveryEvidenceAddress(w.agreement.jobId), evidence]]) {
      const hash = contentHash(artifact), signature = canonicalSignature(signAnchorWrite(w.seller.signBytes, address, hash));
      records.set(address, { status: 'present', artifact, receipt: { receiptVersion: '1', substrate: FIXTURE_SUBSTRATE, finalityProfile: FIXTURE_FINALITY,
        logicalAddress: address, nativeAddress: storAddress(address), contentHash: hash, writer: w.seller.claim,
        transactionRef: { kind: 'fixture-sr2-write', value: fixtureWriteHash({ logicalAddress: address, contentHash: hash, writer: w.seller.claim, writerSignature: signature }) },
        state: 'finalized', observationDisposition: 'established', observedAt: at,
        blockRef: { id: 'TEST-block', height: '1', timestamp: at }, evidence: { kind: 'fixture-writer-signature', value: signature } } });
    }
  }
  const r = { records, reads, sellerRequests, fault: null, gate: null };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname !== '/sr2/records') { sellerRequests.push(url.pathname); throw new Error('TEST bundle request unavailable'); }
    assert.equal(init.method, 'GET', 'checks never write the chain');
    const address = url.searchParams.get('address'); reads.push(address);
    if (r.gate) await r.gate(address);
    if (r.fault) return r.fault(address);
    const record = records.get(address);
    return new Response(JSON.stringify(record ?? {}), { status: record ? 200 : 404, headers: { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' } });
  };
  r.protocol = createProtocolPurchases({ db: w.db, ops: w.ops, coordinates: w.coordinates, now: w.now, deliveryDeadlineWatch: w.watch,
    dacsProtocol: { anchorUrl: 'http://127.0.0.1:2', sellerEndpoint: () => 'http://127.0.0.1:1' }, fetchImpl });
  return r;
}
const observation = w => w.get().state.protocol.deliveryDeadline;
const stateBytes = w => w.db.prepare('SELECT state FROM operations WHERE id=?').get(w.operation.id).state;
// The protocol save without the watch: the stored protocol plus the patch,
// revision + 1. Compare serialized storage, not projections.
function baseSave(w, operation, patch) {
  const stored = w.ops.get(operation.accountId, operation.id).state.protocol;
  const protocol = { ...stored, ...patch, revision: (stored.revision ?? 0) + 1 };
  return w.ops.transition(operation.id, operation.status, operation.status, { state: { protocol }, event: 'protocol_delivery', data: { stage: protocol.stage } });
}
const unavailablePatch = (w, snapshot) => ({ attempts: [...snapshot.state.protocol.attempts.slice(-9), { at: new Date(w.now()).toISOString(), step: 'delivery', outcome: 'unavailable', reason: 'request failed' }] });

test('config accepts only off/on and defaults off', () => {
  assert.equal(loadConfig(baseEnv).deliveryDeadlineWatch, 'off');
  assert.equal(loadConfig({ ...baseEnv, DACS_DELIVERY_DEADLINE_WATCH: 'on' }).deliveryDeadlineWatch, 'on');
  for (const value of ['', 'true', 'ON', '1']) assert.throws(() => loadConfig({ ...baseEnv, DACS_DELIVERY_DEADLINE_WATCH: value }), /DACS_DELIVERY_DEADLINE_WATCH/);
});

for (const mode of ['unreachable', 'timeout', 'malformed', 'never-polled']) test(`on-time existing Deliverable: ${mode} cannot create overdue and later verifies normally`, async t => {
  const w = world(t), r = await reader(w, deadline - 1); w.clock(afterGrace);
  const before = stateBytes(w), history = w.ops.history(w.operation.id);
  w.purchases.status(w.account.id, w.operation.id); w.purchases.portalEvidence(w.purchases.portalOperation(w.operation.id, w.ops.handoffTokenFor(w.operation.id)));
  assert.equal(stateBytes(w), before); assert.deepEqual(w.ops.history(w.operation.id), history); assert.equal(r.reads.length, 0);
  if (mode !== 'never-polled') {
    r.fault = () => { if (mode === 'malformed') return new Response('{broken', { headers: { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' } });
      throw Object.assign(new Error(mode), { name: mode === 'timeout' ? 'TimeoutError' : 'TypeError' }); };
    await r.protocol.advance(w.get(), w.coordinates.get(w.operation.id)); assert.equal(observation(w), undefined);
    await w.watch.sweep(); assert.equal(observation(w), undefined);
  } else { assert.equal(observation(w), undefined); }
  r.fault = null;
  const count = r.reads.length; await r.protocol.advance(w.get(), w.coordinates.get(w.operation.id));
  assert.equal(r.reads.length - count, 2, 'advance reuses its existing pair of delivery reads');
  assert.equal(w.get().state.protocol.stage, 'delivered'); assert.equal(w.get().state.protocol.delivery.status, 'verified'); assert.equal(observation(w), undefined);
});

test('clean not-present only: grace is strict, observation is appended once, stage stays base', async t => {
  const w = world(t), r = await reader(w);
  for (const time of [deadline - 1, deadline, deadline + 1, afterGrace - 1]) {
    w.clock(time); await r.protocol.advance(w.get(), w.coordinates.get(w.operation.id)); assert.equal(observation(w), undefined);
  }
  w.clock(afterGrace); await r.protocol.advance(w.get(), w.coordinates.get(w.operation.id));
  const recorded = structuredClone(observation(w));
  assert.deepEqual(recorded, { overdue: { deadline, checkedAt: afterGrace, read: 'not-present', disposition: 'indeterminate', obligatedParty: 'seller', seller: w.seller.claim, authority: 'local-observation' } });
  assert.equal(w.get().state.protocol.stage, 'payment-evidenced');
  w.clock(afterGrace + 1000); await r.protocol.checkDelivery(w.get()); await w.watch.sweep();
  assert.deepEqual(observation(w), recorded); assert.equal(w.ops.history(w.operation.id).filter(e => e.type === 'protocol_delivery_deadline_overdue').length, 1);
});

test('Listing, request and prepared terms cannot override the verified Agreement deadline', async t => {
  const w = world(t), r = await reader(w);
  assert.notEqual(w.operation.terms.deadline, deadline); assert.notEqual(w.operation.terms.listing.deadline, deadline);
  w.clock(deadline - 1); await r.protocol.checkDelivery(w.get()); assert.equal(observation(w), undefined);
  w.clock(afterGrace); await r.protocol.checkDelivery(w.get()); assert.equal(observation(w).overdue.deadline, deadline);
});

test('unavailable, malformed, rejected and indeterminate records are never clean not-present', async t => {
  const w = world(t); w.clock(afterGrace);
  for (const bad of [undefined, {}, { status: 'unavailable' }, { status: 'rejected' }, { status: 'indeterminate' }, { status: 'present', artifact: {} }]) {
    // As on base, the verifier may throw for a malformed present record; nothing is saved then.
    const readback = await readDelivery({ agreement: w.agreement, now: w.now, anchors: { read: async () => bad } }).catch(() => null);
    if (readback) { w.watch.observe(w.get(), readback); assert.equal(readback.notPresent, false); }
    assert.equal(observation(w), undefined);
  }
  const r = await reader(w, deadline - 1);
  r.records.get(deliverableAddress(w.agreement.jobId)).artifact.TEST = 'tampered';
  await r.protocol.checkDelivery(w.get()); assert.equal(observation(w), undefined); assert.equal(w.get().state.protocol.stage, 'delivery-rejected');
});

test('a Deliverable read back without its evidence is not "no Deliverable"; base classification is kept', async t => {
  for (const missing of ['evidence', 'deliverable']) {
    const w = world(t), r = await reader(w, deadline - 1); w.clock(afterGrace);
    r.records.delete(missing === 'evidence' ? deliveryEvidenceAddress(w.agreement.jobId) : deliverableAddress(w.agreement.jobId));
    await r.protocol.advance(w.get(), w.coordinates.get(w.operation.id));
    assert.equal(w.get().state.protocol.stage, 'payment-evidenced');
    assert.deepEqual(w.get().state.protocol.attempts.at(-1), { at: new Date(afterGrace).toISOString(), step: 'delivery', outcome: 'absent', reason: 'nothing delivered yet' });
    if (missing === 'evidence') assert.equal(observation(w), undefined); else assert.equal(observation(w).overdue.checkedAt, afterGrace);
  }
  const w = world(t); w.clock(afterGrace);
  const readback = await readDelivery({ agreement: w.agreement, now: w.now,
    anchors: { read: async (address) => address === deliverableAddress(w.agreement.jobId) ? { status: 'present', artifact: [] } : { status: 'absent' } } });
  assert.equal(readback.delivery.status, 'absent'); assert.equal(readback.notPresent, false);
});

test('a verifier error propagates from advance() and saves nothing, as on base', async t => {
  const w = world(t), r = await reader(w, deadline - 1); w.clock(afterGrace);
  r.records.get(deliveryEvidenceAddress(w.agreement.jobId)).artifact = [];
  const before = stateBytes(w), history = w.ops.history(w.operation.id);
  await assert.rejects(r.protocol.advance(w.get(), w.coordinates.get(w.operation.id)));
  assert.equal(stateBytes(w), before); assert.deepEqual(w.ops.history(w.operation.id), history); assert.equal(observation(w), undefined);
});

test('checkedAt is when the check starts: a read that ends after the grace cannot backdate an observation', async t => {
  const w = world(t), r = await reader(w), gate = deferred(), entered = deferred();
  w.clock(afterGrace - 1); r.gate = async () => { entered.resolve(); await gate.promise; };
  const check = r.protocol.checkDelivery(w.get()); await entered.promise;
  w.clock(afterGrace + 60_000); gate.resolve(); await check;
  assert.equal(observation(w), undefined); assert.equal(w.get().state.protocol.attempts.at(-1).outcome, 'absent');
});

for (const stage of ['committed', 'awaiting-claim', 'claim-rejected', 'evidence-rejected', 'delivery-rejected', 'delivered']) test(`checkDelivery refuses at ${stage} without reading or saving`, async t => {
  const w = world(t, { stage }), r = await reader(w, deadline - 1); w.clock(afterGrace);
  const before = stateBytes(w);
  await assert.rejects(r.protocol.checkDelivery(w.get()), { code: 'delivery_check_not_ready' });
  assert.equal(r.reads.length, 0); assert.equal(stateBytes(w), before);
});

test('native purchases are skipped by the sweep without reads or warnings', async t => {
  const w = world(t), r = await reader(w); w.clock(afterGrace);
  const terms = { ...w.terms, protocol: { ...w.terms.protocol, profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: NATIVE_AGREEMENT_PAYMENT, sellerAgreementProjection: SELLER_SR2_PUBLIC_PROJECTION } };
  const { operation } = w.ops.createIdempotent({ accountId: w.account.id, kind: 'purchase', idempotencyKey: 'TEST-native', request: {}, status: 'settled_verified', terms, termsHash: contentHash(terms), expiresAt: w.operation.expiresAt, state: w.operation.state });
  w.coordinates.save({ operationId: operation.id, kind: 'purchase', network: 'TEST', from: w.buyer.address, target: w.seller.address, nonceFence: 0, expectedNonce: 1, payload: {} });
  w.coordinates.reportHash(operation.id, 'e'.repeat(64)); w.coordinates.recordObservation(operation.id, { chainMode: 'simulated-fixture', observation: { txHash: 'e'.repeat(64), blockNumber: 1 } }, true);
  await w.watch.sweep(); await w.watch.sweep();
  assert.deepEqual(w.logs, []); assert.equal(w.ops.get(w.account.id, operation.id).state.protocol.deliveryDeadline, undefined);
  assert.equal(r.reads.length, 2, 'only the fixture purchase is read'); assert.ok(observation(w).overdue);
});

test('ineligible purchases never get an observation', async t => {
  const cases = [w => ({ status: 'awaiting_approval' }), w => ({ status: 'cancelled' }), w => ({ state: { protocol: { ...w.operation.state.protocol, agreement: null } } }),
    w => ({ state: { protocol: { ...w.operation.state.protocol, commitment: {} } } }),
    w => ({ state: { protocol: { ...w.operation.state.protocol, agreement: { ...w.operation.state.protocol.agreement, terms: { ...w.operation.state.protocol.agreement.terms, seller: 'other' } } } } }),
    w => ({ state: { protocol: { ...w.operation.state.protocol, agreement: { ...w.operation.state.protocol.agreement, terms: { ...w.operation.state.protocol.agreement.terms, deadline: deadline - 1 } } } } }),
    w => ({ state: { protocol: { ...w.operation.state.protocol, stage: 'delivered', delivery: { status: 'verified', deliveredAt: deadline - 1 } } } })];
  for (const badDeadline of [-1, 8640000000000001, 1.5, '1791460800000']) cases.push(w => {
    const p = structuredClone(w.operation.state.protocol); p.agreement.artifact.terms.deadline = badDeadline; p.agreement.terms.deadline = badDeadline;
    p.agreement.hash = contentHash(p.agreement.artifact); p.agreement.ref.contentHash = p.agreement.hash;
    return { state: { protocol: p } };
  });
  cases.push(w => { const p = structuredClone(w.operation.state.protocol); p.agreement.ref.contentHash = 'bad'; return { state: { protocol: p } }; });
  for (const change of cases) {
    const w = world(t), patch = change(w); w.clock(afterGrace);
    w.ops.transition(w.operation.id, w.operation.status, patch.status ?? w.operation.status, { state: patch.state ?? w.operation.state });
    const before = stateBytes(w), r = await reader(w); await w.watch.sweep();
    w.watch.observe(w.get(), { checkedAt: afterGrace, delivery: { status: 'absent' }, notPresent: true });
    assert.equal(observation(w), undefined); assert.equal(stateBytes(w), before);
  }
  const w = world(t, { paid: false }); await reader(w); w.clock(afterGrace); await w.watch.sweep(); assert.equal(observation(w), undefined);
});

for (const order of ['unavailable-first', 'verified-first']) test(`same snapshot concurrent reads ${order}: the held check is not saved; the first save stands`, async t => {
  const w = world(t), good = await reader(w, deadline - 1), bad = await reader(w, deadline - 1), gate = deferred(), entered = deferred(); w.clock(afterGrace);
  bad.fault = () => { throw new Error('unreachable'); };
  const first = order === 'unavailable-first' ? bad : good, second = first === bad ? good : bad;
  first.gate = async () => { entered.resolve(); await gate.promise; };
  const snapshot = w.get(), pending = first.protocol.checkDelivery(snapshot); await entered.promise;
  const secondResult = await second.protocol.checkDelivery(snapshot); gate.resolve(); const firstResult = await pending;
  assert.equal(observation(w), undefined);
  // first was held, so second saved first; first read the older revision and saved nothing.
  assert.deepEqual(firstResult.state.protocol.notSaved, { savedRevision: 1, savedStage: second === good ? 'delivered' : 'payment-evidenced' });
  assert.equal(w.ops.history(w.operation.id).filter(e => e.type === 'protocol_check_not_saved').length, 1);
  const actual = stateBytes(w);
  w.ops.transition(snapshot.id, snapshot.status, snapshot.status, { state: snapshot.state });
  const patch = second === bad ? unavailablePatch(w, snapshot) : { stage: 'delivered', delivery: secondResult.state.protocol.delivery,
    attempts: [...snapshot.state.protocol.attempts.slice(-9), { at: new Date(w.now()).toISOString(), step: 'delivery', outcome: 'verified' }] };
  baseSave(w, snapshot, patch);
  assert.equal(actual, stateBytes(w));
  assert.equal(w.get().state.protocol.stage, second === good ? 'delivered' : 'payment-evidenced');
  if (second === bad) {
    // The lost success is redone by the next check from the saved state.
    await good.protocol.checkDelivery(w.get()); assert.equal(w.get().state.protocol.stage, 'delivered');
  }
});

for (const enabled of [true, false]) for (const outcome of ['unavailable', 'verified']) test(`no observation: byte-identical base ${outcome} save with switch ${enabled ? 'on' : 'off'}`, async t => {
  const w = world(t, { enabled }), r = await reader(w, outcome === 'verified' ? deadline - 1 : null), snapshot = w.get(); w.clock(afterGrace);
  if (outcome === 'unavailable') r.fault = () => { throw new Error('unreachable'); };
  const saved = await r.protocol.checkDelivery(snapshot), actual = stateBytes(w);
  w.ops.transition(snapshot.id, snapshot.status, snapshot.status, { state: snapshot.state });
  const patch = outcome === 'unavailable' ? unavailablePatch(w, snapshot) : { stage: 'delivered', delivery: saved.state.protocol.delivery,
    attempts: [...snapshot.state.protocol.attempts.slice(-9), { at: new Date(w.now()).toISOString(), step: 'delivery', outcome: 'verified' }] };
  baseSave(w, snapshot, patch); assert.equal(actual, stateBytes(w)); assert.equal(observation(w), undefined);
  if (!enabled && outcome === 'unavailable') { r.fault = null; await r.protocol.checkDelivery(w.get()); assert.equal(observation(w), undefined); }
});

for (const deliveryAt of [deadline - 1, deadline + 1]) test(`later verified delivery at ${deliveryAt <= deadline ? 'within' : 'after'} deadline keeps both facts, including when off`, async t => {
  const w = world(t), absent = await reader(w); w.clock(afterGrace); await absent.protocol.checkDelivery(w.get());
  const recorded = structuredClone(observation(w));
  // Disable after recording. The independent save overlay still captures delivery.
  const off = createDeliveryDeadlineWatch({ db: w.db, ops: w.ops, coordinates: w.coordinates, now: w.now, enabled: false, timer: w.timer });
  const r = await reader(w, deliveryAt);
  const protocol = createProtocolPurchases({ db: w.db, ops: w.ops, coordinates: w.coordinates, now: w.now, deliveryDeadlineWatch: off,
    dacsProtocol: { anchorUrl: 'http://127.0.0.1:2', sellerEndpoint: () => 'http://127.0.0.1:1' },
    fetchImpl: async (input, init) => { const url = new URL(input); if (url.pathname !== '/sr2/records') { r.sellerRequests.push(url.pathname); throw new Error('bundle unavailable'); }
      return new Response(JSON.stringify(r.records.get(url.searchParams.get('address'))), { headers: { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' } }); } });
  await protocol.advance(w.get(), w.coordinates.get(w.operation.id));
  assert.equal(w.get().state.protocol.stage, 'delivered'); assert.deepEqual(observation(w).overdue, recorded.overdue);
  assert.deepEqual(observation(w).laterDelivery, { verifiedAt: afterGrace, deliveredAt: deliveryAt, deliveredAtSource: DELIVERY_TIME_SOURCE,
    deliverableRef: w.get().state.protocol.delivery.deliverableRef, payloadHash: w.get().state.protocol.delivery.payloadHash });
  assert.equal(r.sellerRequests.length, 1, 'seller-recorded time cannot hold base bundle requests');
  const view = protocolView(w.get(), { now: w.now, enabled: false }); assert.ok(view.deliveryDeadline.overdue);
  assert.match(view.deliveryDeadline.deliveryMessage, deliveryAt <= deadline ? /within the deadline: the earlier check had not seen it yet/ : /verified after the deadline/);
  assert.match(view.deliveryDeadline.deliveryMessage, /seller-recorded delivery SettlementEvidence.observedAt/);
  const later = structuredClone(observation(w)); w.clock(afterGrace + 1000);
  await assert.rejects(absent.protocol.checkDelivery(w.get()), { code: 'delivery_check_not_ready' }); assert.deepEqual(observation(w), later);
  assert.equal(holdCompletedBundle(w.get().state.protocol), false);
  const authenticated = structuredClone(w.get().state.protocol); authenticated.deliveryDeadline.laterDelivery.deliveredAtSource = 'chain-authenticated inclusion block timestamp';
  assert.equal(holdCompletedBundle(authenticated), deliveryAt > deadline);
});

for (const stage of ['committed', 'awaiting-claim', 'claim-rejected', 'evidence-rejected', 'delivery-rejected']) test(`sweep leaves a purchase at ${stage} alone, delivered or not`, async t => {
  for (const at of [deadline - 1, null]) {
    const w = world(t, { stage }), r = await reader(w, at); w.clock(afterGrace);
    const before = stateBytes(w); await w.watch.sweep();
    assert.equal(r.reads.length, 0); assert.equal(r.sellerRequests.length, 0); assert.equal(stateBytes(w), before);
    w.watch.observe(w.get(), { notPresent: true, checkedAt: afterGrace, delivery: { status: 'absent' } }); assert.equal(observation(w), undefined);
  }
});

test('sweep verifies an existing on-time Deliverable through the normal save without seller calls', async t => {
  const w = world(t), r = await reader(w, deadline - 1); w.clock(afterGrace);
  await w.watch.sweep();
  assert.equal(w.get().state.protocol.stage, 'delivered'); assert.equal(w.get().state.protocol.delivery.status, 'verified');
  assert.equal(observation(w), undefined); assert.equal(r.reads.length, 2); assert.equal(r.sellerRequests.length, 0);
});

test('native delivery capability is never checked against the unrelated fixture substrate', async t => {
  const w = world(t), r = await reader(w); w.clock(afterGrace);
  const native = { ...w.get(), terms: { ...w.terms, protocol: { ...w.terms.protocol, profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',
    nativePayment: NATIVE_AGREEMENT_PAYMENT, sellerAgreementProjection: SELLER_SR2_PUBLIC_PROJECTION } } };
  await assert.rejects(r.protocol.checkDelivery(native), { code: 'dacs_protocol_unavailable' });
  assert.equal(r.reads.length, 0); assert.equal(r.sellerRequests.length, 0); assert.equal(observation(w), undefined);
});

test('observation transaction re-reads: delivery committed during a not-present read prevents overdue', async t => {
  const w = world(t), absent = await reader(w), good = await reader(w, deadline - 1), gate = deferred(), entered = deferred(); w.clock(afterGrace);
  absent.gate = async () => { entered.resolve(); await gate.promise; };
  const pending = absent.protocol.checkDelivery(w.get()); await entered.promise;
  await good.protocol.checkDelivery(w.get()); gate.resolve(); await pending;
  assert.equal(observation(w), undefined);
  // The held check read an older revision, so it saved nothing: delivery stands.
  assert.equal(w.get().state.protocol.stage, 'delivered'); assert.equal(w.get().state.protocol.delivery.status, 'verified');
});

test('a sweep check that loses to a saved delivery is not saved and is not logged as a failed check', async t => {
  // The last protocol service created registers its check with the watch, so the held absent reader is the sweep's.
  const w = world(t), good = await reader(w, deadline - 1), absent = await reader(w), gate = deferred(), entered = deferred(); w.clock(afterGrace);
  absent.gate = async () => { entered.resolve(); await gate.promise; };
  const pass = w.watch.sweep(); await entered.promise;
  await good.protocol.checkDelivery(w.get()); gate.resolve(); await pass;
  assert.deepEqual(w.logs, []);
  assert.equal(w.get().state.protocol.stage, 'delivered'); assert.equal(observation(w), undefined);
  assert.equal(w.ops.history(w.operation.id).filter(e => e.type === 'protocol_check_not_saved').length, 1);
});

test('sweep reads at most ten sequentially, rotates past failures, filters unrelated rows and never calls seller', async t => {
  const w = world(t), r = await reader(w); w.clock(afterGrace);
  const rows = [w.operation];
  for (let i = 0; i < 12; i++) {
    const { operation } = w.ops.createIdempotent({ accountId: w.account.id, kind: 'purchase', idempotencyKey: `TEST-${i}`, request: {}, status: 'settled_verified', terms: w.terms,
      termsHash: contentHash(w.terms), expiresAt: w.operation.expiresAt, state: w.operation.state });
    // Eligibility deliberately fails after SQL selection for these rows unless paid.
    w.coordinates.save({ operationId: operation.id, kind: 'purchase', network: 'TEST', from: w.buyer.address, target: w.seller.address, nonceFence: 0, expectedNonce: 1, payload: {} });
    const txHash = (i + 1).toString(16).padStart(64, '0');
    w.coordinates.reportHash(operation.id, txHash); w.coordinates.recordObservation(operation.id, { chainMode: 'simulated-fixture', observation: { txHash, blockNumber: 1 } }, true);
    rows.push(operation);
  }
  for (let i = 0; i < 15; i++) w.ops.createIdempotent({ accountId: w.account.id, kind: 'purchase', idempotencyKey: `irrelevant-${i}`, request: {}, status: 'settled_verified', terms: w.terms, termsHash: contentHash(w.terms), expiresAt: w.operation.expiresAt, state: { protocol: { stage: 'committed' } } });
  const sorted = rows.map(x => x.id).sort(), seen = []; let active = 0, maxActive = 0;
  w.watch.setDeliveryCheck(async (op, options) => { seen.push(op.id); active++; maxActive = Math.max(active, maxActive); await Promise.resolve(); active--;
    if (op.id === sorted[0]) throw new Error('bad row with private data'); return r.protocol.checkDelivery(op, options); });
  await w.watch.start(); assert.equal(seen.length, 10); assert.deepEqual(seen, sorted.slice(0, 10));
  assert.equal(w.timer.runs[0].ms, DELIVERY_DEADLINE_SWEEP_MS); assert.equal(w.logs.length, 1); assert.deepEqual(w.logs[0], ['delivery_deadline_purchase_check_failed', { operationId: sorted[0] }]);
  await w.timer.runs[0].run(); assert.deepEqual(seen.slice(10), sorted.slice(10)); assert.equal(maxActive, 1); assert.equal(r.sellerRequests.length, 0);
  await w.watch.sweep(); assert.equal(seen.at(-1), sorted[0]); await w.watch.stop();
});

test('passes never overlap; stop prevents saves and waits for the in-flight read', async t => {
  const w = world(t), r = await reader(w), gate = deferred(), entered = deferred(); w.clock(afterGrace);
  r.gate = async () => { entered.resolve(); await gate.promise; };
  const before = stateBytes(w), pass = w.watch.start(); await entered.promise;
  const overlap = w.watch.sweep(); assert.equal(r.reads.length, 1);
  let stopped = false; const close = w.watch.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false);
  assert.equal(w.timer.delays[0].ms, DELIVERY_DEADLINE_STOP_MS);
  gate.resolve(); await Promise.all([pass, overlap, close]); assert.equal(stopped, true); assert.equal(stateBytes(w), before);
  await w.timer.runs[0].run(); assert.equal(r.reads.length, 2); assert.deepEqual(w.timer.cancelled, [1]);
});

test('shutdown is bounded with the injected timer, and a resumed hung read still cannot save', async t => {
  const w = world(t), r = await reader(w), gate = deferred(), entered = deferred(); w.clock(afterGrace);
  r.gate = async () => { entered.resolve(); await gate.promise; };
  const pass = w.watch.start(); await entered.promise; const before = stateBytes(w), close = w.watch.stop();
  w.timer.delays[0].run(); await close; gate.resolve(); await pass; assert.equal(stateBytes(w), before);
});

test('off starts no sweep or timer; application close waits for its watch', async () => {
  for (const mode of ['off', 'on']) {
    const timer = fakeTimer(), app = await createApp({ config: loadConfig({ ...baseEnv, DACS_DELIVERY_DEADLINE_WATCH: mode }), testOnlyDeliveryDeadlineTimer: timer });
    assert.equal(timer.runs.length, 0); await app.startDeliveryDeadlineWatch(); assert.equal(timer.runs.length, mode === 'on' ? 1 : 0);
    await app.close(); assert.deepEqual(timer.cancelled, mode === 'on' ? [1] : []); await timer.runs[0]?.run();
  }
});

test('application shutdown awaits an in-flight delivery pass before closing the database', async t => {
  const w = world(t), gate = deferred(), entered = deferred(), timer = fakeTimer(); w.clock(afterGrace);
  const app = await createApp({ config: loadConfig({ ...baseEnv, DACS_DELIVERY_DEADLINE_WATCH: 'on' }), now: w.now, testOnlyDeliveryDeadlineTimer: timer,
    dacsProtocol: { anchorUrl: 'http://127.0.0.1:2', sellerEndpoint: () => 'http://127.0.0.1:1' },
    fetchImpl: async () => { entered.resolve(); await gate.promise; return new Response('{}', { status: 404, headers: { 'x-dacs-simulation': 'fixture' } }); } });
  const { accounts, ops, coordinates } = app.services;
  const account = accounts.resolveFromToken({ issuer: 'https://issuer.example', subject: 'TEST-buyer' });
  const { operation } = ops.createIdempotent({ accountId: account.id, kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'settled_verified', terms: w.terms,
    termsHash: contentHash(w.terms), expiresAt: w.operation.expiresAt, state: w.operation.state });
  coordinates.save({ operationId: operation.id, kind: 'purchase', network: 'TEST', from: w.buyer.address, target: w.seller.address, nonceFence: 0, expectedNonce: 1, payload: {} });
  coordinates.reportHash(operation.id, 'd'.repeat(64)); coordinates.recordObservation(operation.id, { chainMode: 'simulated-fixture', observation: { txHash: 'd'.repeat(64), blockNumber: 1 } }, true);
  const before = ops.history(operation.id);
  const pass = app.startDeliveryDeadlineWatch(); await entered.promise;
  let closed = false; const closing = app.close().then(() => { closed = true; });
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  assert.equal(closed, false); assert.equal(timer.delays[0].ms, DELIVERY_DEADLINE_STOP_MS);
  assert.deepEqual(ops.history(operation.id), before); gate.resolve(); await Promise.all([pass, closing]); assert.equal(closed, true);
});

test('MCP status is read-only, passes registered outputSchema, and exposes honest observation and later time', async t => {
  const w = world(t), absent = await reader(w); w.clock(afterGrace);
  const server = createMcpServerFactory({ config: w.config, services: { purchases: w.purchases, accounts: w.accounts }, logger: { info() {}, error() {} } })(); t.after(() => server.close());
  const tool = server._registeredTools.get_purchase_status;
  const ctx = { http: { authInfo: { scopes: ['dacs.account.read'], extra: { issuer: 'https://issuer.example', subject: 'TEST-buyer' } } } };
  const read = async () => { const before = stateBytes(w), count = absent.reads.length, history = w.ops.history(w.operation.id);
    const out = await tool.handler({ operationId: w.operation.id }, ctx); assert.equal(out.isError, undefined); tool.outputSchema.parse(out.structuredContent);
    assert.equal(stateBytes(w), before); assert.equal(absent.reads.length, count); assert.deepEqual(w.ops.history(w.operation.id), history); return out; };
  assert.match((await read()).content[0].text, /Delivery is not confirmed yet; verify_deal checks the chain again/);
  await absent.protocol.checkDelivery(w.get()); const overdue = await read();
  assert.match(overdue.content[0].text, /plugin's own observation, not a recorded fault/); assert.match(overdue.content[0].text, /Nothing has been refunded. Do not pay again/);
  assert.equal(overdue.structuredContent.protocol.stage, 'payment-evidenced');
  const good = await reader(w, deadline - 1); await good.protocol.checkDelivery(w.get()); const later = await read(); assert.match(later.content[0].text, /within the deadline/);
});

test('production listener starts the watch and signal shutdown stops it', async () => {
  const source = readFileSync(new URL('../bin/dacs-chatgpt-plugin.mjs', import.meta.url), 'utf8').replace(/^import .+;$/gm, '').replace(/^#!.*\n/, '');
  const calls = [], signals = {}, server = { address: () => ({ address: 'TEST', port: 0 }), close: fn => fn(), closeIdleConnections() {} };
  const context = { loadConfig: () => ({ port: 0, host: 'TEST' }), ConfigError: class extends Error {}, createLogger: () => ({ info() {}, error() {} }),
    createApp: async () => ({ app: { listen: (_port, _host, fn) => { queueMicrotask(fn); return server; } }, close: async () => calls.push('closed'), startDeliveryDeadlineWatch: () => calls.push('started'), stopDeliveryDeadlineWatch: () => calls.push('stopped') }),
    process: { env: {}, on: (event, fn) => { signals[event] = fn; }, exit: () => calls.push('exit') }, setTimeout: () => ({ unref() {} }) };
  await vm.runInNewContext(`(async () => {${source}\n})()`, context); assert.deepEqual(calls, ['started']);
  await signals.SIGTERM(); await Promise.resolve(); assert.deepEqual(calls, ['started', 'stopped', 'closed', 'exit']);
});
