// The party Vet state across an upgrade, cancellation, restarts, crashes and
// a second process (src/devnet-demo/agreement-context.mjs over its own store,
// src/devnet-demo/party-vet-store.mjs). The goal: one Vet record per party per
// job: immutable bytes, one deterministic signature value and at most one
// CREATE per party. A crash before the signature checkpoint can call the
// deterministic, side-effect-free signer again.
//
// Fixture chain only, no network (test/helpers/party-vet-fixture.mjs). With
// durable: true the artifact journal and the party Vet store are SQLite files
// and a restart opens new instances of both, a new anchor and a new provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, generateCanonicalJobId } from '@kynesyslabs/dacs';
import { releaseDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createInMemoryPartyVetStore } from '../src/devnet-demo/party-vet-store.mjs';
import { setupPartyVet as setup, deferred, never, sleep } from './helpers/party-vet-fixture.mjs';

// The live server's jammed job.
const LIVE_JOB = '01M4JVVNG7316GJB6DZ2QK6202';
const LEGACY = 'legacy_party_vet_state_missing: this purchase was started by an earlier server version; nothing was signed or sent; start a new purchase';
const until = async (check) => { while (!(await check())) await sleep(10); };

test('upgrade: a job whose Vets an earlier version started (anchor intents, no party Vet state) is quarantined; nothing is read back, signed or sent', { timeout: 180000 }, async (t) => {
  const s = await setup(t, { durable: true, jobId: LIVE_JOB });
  const { ctl } = s;
  // da459ee kept a job's Vet state in memory only: a provider over a
  // throwaway store stands in for it. The live jam's shape: the buyer CVR
  // finalized, the seller's approval of its own CVR refused.
  const earlier = s.build({ store: createInMemoryPartyVetStore() });
  const g0 = Date.now(), jam = s.plan(g0, s.buyerBundle, { via: earlier });
  await s.waitForSellerPrompt(); ctl.sellerGate.resolve(false);
  assert.equal((await jam).disposition, 'indeterminate');
  assert.equal((await s.journalStage(ctl.buyerAddr)).stage, 'verified'); assert.equal((await s.journalStage(ctl.sellerAddr)).stage, 'denied');
  assert.deepEqual(await s.vetState(), [], 'nothing in this version\'s store');
  // The server restarts onto this version, over the same artifact journal.
  s.restart();
  const before = { signatures: ctl.recordSignatures, creates: s.accepted(), prompts: ctl.prompts.length, calls: { ...ctl.anchorCalls } };
  for (const [i, writable] of [[1, true], [2, true], [3, 'purchase is expired']]) {
    const out = await s.plan(g0 + i * 1000, s.buyerBundle, { writable: () => writable });
    assert.deepEqual(out, { disposition: 'rejected', reason: LEGACY, code: 'legacy_party_vet_state_missing' });
  }
  assert.equal(ctl.recordSignatures, before.signatures, 'nothing signed'); assert.equal(s.accepted(), before.creates, 'nothing sent'); assert.equal(ctl.prompts.length, before.prompts, 'no approval asked');
  for (const call of ['publish', 'read', 'readRetained']) assert.equal(ctl.anchorCalls[call], before.calls[call], `no anchor ${call}`);
  assert.equal(ctl.anchorCalls.hasIntent - before.calls.hasIntent, 2, 'one passive check of the two CVR keys, before the first binding only');
  const rows = await s.vetState();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['jobId', 'quarantine', 'revision', 'version', 'writer'], 'a compact quarantine marker');
  assert.equal(rows[0].quarantine, 'legacy_party_vet_state_missing');
  // The marker outlives another restart; a new job on the upgraded server works.
  s.restart();
  assert.equal((await s.plan(g0 + 4000)).code, 'legacy_party_vet_state_missing');
  s.switchJob(); ctl.sellerAuto = true;
  const fresh = await s.plan(Date.now());
  assert.equal(fresh.disposition, 'present', JSON.stringify(fresh));
  assert.equal(s.accepted() - before.creates, 2, 'one buyer and one seller CVR for the new job');
});

// a an earlier review: a cancellation between the purchase check and the effect.
test('a purchase cancelled while the first write mark is being stored gets no Vet signature', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl } = s;
  ctl.sellerAuto = true;
  let cancelled = false;
  // The mark is stored; its caller has not resumed yet when the purchase is cancelled.
  ctl.afterStoreUpdate = (_n, row) => { if (!cancelled && row?.writeStarted === true) { cancelled = true; ctl.writable = 'purchase is cancelled'; } };
  const out = await s.plan(Date.now());
  assert.ok(cancelled, 'the gate was reached');
  assert.equal(out.disposition, 'indeterminate', JSON.stringify(out));
  assert.match(out.reason, /^DEM delivery context failed: buyer Vet record write failed \(not-pending: the purchase is no longer pending; no new write was started\); /);
  assert.equal(ctl.recordSignatures, 0, 'nothing was signed');
  assert.equal(s.accepted(), 1, 'Listing only'); assert.equal(ctl.prompts.length, 1);
});

test('a purchase cancelled while the anchor reconciles before the CREATE intent stores no intent and sends nothing', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl } = s;
  ctl.sellerAuto = true;
  let cancelled = false;
  // Inside publish, under the address lock, after the buyer CVR was signed.
  ctl.onReconcile = () => { if (!cancelled && ctl.recordSignatures === 1) { cancelled = true; ctl.writable = 'purchase is cancelled'; } };
  const out = await s.plan(Date.now());
  assert.ok(cancelled, 'the gate was reached');
  assert.equal(out.disposition, 'indeterminate', JSON.stringify(out));
  assert.match(out.reason, /^DEM delivery context failed: buyer Vet record write failed \(not-pending: the purchase is no longer pending; no new write was started\); /);
  assert.equal(await s.journalStage(ctl.buyerAddr), null, 'no buyer CVR intent was stored');
  assert.equal(s.accepted(), 1, 'Listing only'); assert.equal(s.prompted(ctl.buyerAddr), 0, 'no approval asked');
  assert.ok(ctl.writerLog.some((line) => line.includes('buyer CVR not-pending: not-authorized: the caller withdrew this write (purchase is cancelled)')), 'the raw cause is logged');
});

// a an earlier review: a restart after the plan is saved, before the seller's
// Agreement step reads its context.
test('after the plan is saved and the server restarts, the seller gets the exact saved context; nothing is signed or sent', { timeout: 180000 }, async (t) => {
  const s = await setup(t, { durable: true });
  const { ctl, buyerBundle } = s;
  ctl.sellerAuto = true;
  const g1 = Date.now();
  assert.equal((await s.plan(g1)).disposition, 'present');
  const saved = await s.plan(g1 + 1000);
  assert.equal(saved.disposition, 'present');
  // The plan is saved from the second request.
  releaseDemDeliveryContext(s.capability, { jobId: s.jobId, generatedAt: g1 + 1000 });
  await until(async () => (await s.vetState())[0].seller.generatedAts.length === 1);
  const pin = s.published.listingPin, seller = (generatedAt, bundle = buyerBundle, listingPin = pin) => s.provider.resolveSeller({ jobId: s.jobId, listingPin, buyerIdentityBundle: bundle, generatedAt });
  const before = await seller(g1 + 1000);
  const counts = () => [ctl.recordSignatures, s.accepted(), ctl.prompts.length];
  const was = counts();
  s.restart();
  assert.equal(s.provider.contexts.size, 0, 'nothing in memory');
  const after = await seller(g1 + 1000);
  assert.equal(after.disposition, 'present', JSON.stringify(after));
  assert.equal(canonicalize(after), canonicalize(before), 'byte-identical to the context before the restart');
  assert.equal(canonicalize(after.value.input), canonicalize(saved.input), 'the saved request\'s exact derive input');
  // Only the saved request, with its exact bundle and Listing pin.
  const differs = { disposition: 'rejected', reason: 'seller context differs from buyer context' };
  assert.deepEqual(await seller(g1), differs);
  const changed = structuredClone(buyerBundle); changed.presentation.signatures[0].signature = `${changed.presentation.signatures[0].signature.slice(0, -1)}${changed.presentation.signatures[0].signature.endsWith('0') ? '1' : '0'}`;
  assert.deepEqual(await seller(g1 + 1000, changed), differs);
  assert.deepEqual(await seller(g1 + 1000, buyerBundle, { ...pin, version: pin.version + 1 }), differs);
  assert.equal((await s.provider.resolveSeller({ jobId: generateCanonicalJobId(), listingPin: pin, buyerIdentityBundle: buyerBundle, generatedAt: g1 + 1000 })).disposition, 'indeterminate');
  assert.deepEqual(counts(), was, 'no signature, CREATE or approval');
});

// a an earlier review P2: a crash between the signature and its checkpoint.
test('a failure after the buyer signature, before it is stored, then a restart: the written-ahead bytes are signed again and give the same record', { timeout: 180000 }, async (t) => {
  const s = await setup(t, { durable: true });
  const { ctl } = s;
  ctl.sellerAuto = true;
  let failNext = true;
  // The first store change after the signature (the signature record) fails.
  ctl.onStoreUpdate = () => { if (failNext && ctl.recordSignatures === 1) { failNext = false; throw Object.assign(new Error('TEST store write failed'), { code: 'journal-error' }); } };
  const failed = await s.plan(Date.now());
  assert.equal(failed.disposition, 'indeterminate', JSON.stringify(failed));
  assert.match(failed.reason, /^DEM delivery context failed: buyer Vet record write failed \(failed: the write failed\); /);
  assert.equal(ctl.recordSignatures, 1); assert.equal(s.accepted(), 1, 'nothing sent');
  s.restart(); ctl.onStoreUpdate = null;
  const retry = await s.plan(Date.now() + 1000);
  assert.equal(retry.disposition, 'present', JSON.stringify(retry));
  const buyerBytes = ctl.signed[0].bytes, again = ctl.signed.filter((entry) => entry.bytes === buyerBytes);
  assert.equal(again.length, 2, 'one buyer call before the failed checkpoint and one after restart');
  assert.equal(ctl.recordSignatures, 3, 'two buyer signer calls and one seller signer call in this failure/restart sequence');
  assert.equal(new Set(again.map((entry) => entry.signature)).size, 1, 'and got the same signature: Ed25519 is deterministic');
  assert.equal(new Set(ctl.signed.map((entry) => entry.bytes)).size, 2, 'one buyer and one seller record');
  assert.equal(s.acceptedFor(ctl.buyerAddr), 1, 'one buyer CREATE despite two signer calls');
  assert.equal(s.acceptedFor(ctl.sellerAddr), 1, 'one seller CREATE');
  assert.equal((await s.vetState()).length, 1, 'one durable job row');
  assert.equal(retry.input.buyer.vetRecordRef.contentHash, (await s.journalStage(ctl.buyerAddr)).hash);
});

test('a crash after the buyer signature was stored, before its step result, then a restart: the stored signature is replayed and nothing is signed again', { timeout: 180000 }, async (t) => {
  const s = await setup(t, { durable: true });
  const { ctl } = s;
  ctl.sellerAuto = true;
  let crashed = false;
  const signatureStored = (row) => Object.values(row?.ops?.buyer?.signing ?? {}).some((entry) => entry.signature);
  ctl.afterStoreUpdate = (_n, row) => { if (!crashed && signatureStored(row)) { crashed = true; return never(); } };
  const first = s.plan(Date.now());
  await until(() => crashed);
  assert.equal(ctl.recordSignatures, 1); assert.equal(s.accepted(), 1);
  const [row] = await s.vetState();
  assert.deepEqual(row.ops.buyer.steps, {}, 'no step result was stored');
  s.restart(); ctl.afterStoreUpdate = null;
  const retry = await s.plan(Date.now() + 1000);
  assert.equal(retry.disposition, 'present', JSON.stringify(retry));
  assert.equal(ctl.recordSignatures, 2, 'only the seller record was signed after the restart');
  assert.equal(s.acceptedFor(ctl.buyerAddr), 1); assert.equal(s.acceptedFor(ctl.sellerAddr), 1);
  void first;
});

// a an earlier review P3: two provider instances (two processes) on one store.
test('two providers on one store and journal, same job at once: one record per party and at most one CREATE each; a later retry converges', { timeout: 180000 }, async (t) => {
  const s = await setup(t, { durable: true });
  const { ctl } = s;
  ctl.sellerAuto = true;
  const a = s.provider, b = s.restart();
  const both = await Promise.all([s.plan(Date.now(), s.buyerBundle, { via: a }), s.plan(Date.now() + 5, s.buyerBundle, { via: b })]);
  t.diagnostic(JSON.stringify(both.map((out) => [out.disposition, out.reason ?? null])));
  assert.ok(s.acceptedFor(ctl.buyerAddr) <= 1 && s.acceptedFor(ctl.sellerAddr) <= 1, 'never two CREATEs for one CVR');
  const records = new Set(ctl.signed.map((entry) => entry.bytes));
  assert.ok(records.size <= 2, 'one record per party');
  for (const bytes of records) assert.equal(new Set(ctl.signed.filter((entry) => entry.bytes === bytes).map((entry) => entry.signature)).size, 1, 'one signature per record');
  s.restart();
  const later = await s.plan(Date.now() + 1000);
  assert.equal(later.disposition, 'present', JSON.stringify(later));
  assert.equal(s.acceptedFor(ctl.buyerAddr), 1); assert.equal(s.acceptedFor(ctl.sellerAddr), 1);
  assert.equal(new Set(ctl.signed.map((entry) => entry.bytes)).size, 2);
});

// Code review R6: the compare in every operation-store change.
test('a run whose binding was replaced before its first write writes nothing into the new binding\'s state', { timeout: 180000 }, async (t) => {
  const s = await setup(t);
  const { ctl } = s;
  ctl.sellerAuto = true;
  // Each run is held before its first checkpoint (its second store change).
  const holdA = deferred(), holdB = deferred();
  const a = s.build({ onStoreUpdate: (_n, _key, mine) => (mine === 2 ? holdA.p : undefined) });
  const b = s.build({ onStoreUpdate: (_n, _key, mine) => (mine === 2 ? holdB.p : undefined) });
  const fresh = s.identity(s.buyer, Date.now() - 5000);
  const bound = async (bundle) => canonicalize((await s.vetState())[0]?.binding?.buyerIdentityBundle ?? null) === canonicalize(bundle);
  const ranA = s.plan(Date.now(), s.buyerBundle, { via: a });
  await until(() => bound(s.buyerBundle));
  // No write was started under A's binding, so B's bundle replaces it.
  const ranB = s.plan(Date.now() + 1000, fresh, { via: b });
  await until(() => bound(fresh));
  holdA.resolve();
  const outA = await ranA;
  t.diagnostic(JSON.stringify(outA));
  assert.notEqual(outA.disposition, 'present');
  assert.equal(ctl.recordSignatures, 0, 'the replaced run signed nothing');
  assert.deepEqual((await s.vetState())[0].ops.buyer.checkpoints, {}, 'and wrote nothing into the new binding\'s state');
  holdB.resolve();
  const outB = await ranB;
  assert.equal(outB.disposition, 'present', JSON.stringify(outB));
  assert.equal(ctl.recordSignatures, 2); assert.equal(s.accepted(), 3);
});

// Code review P2: rows of ended purchases are deleted, also when the purchase
// ended without a status change this process saw (lazy expiry, a restart).
test('the sweep deletes the rows of ended purchases and keeps a job still running here until it settles', { timeout: 180000 }, async (t) => {
  const s = await setup(t, { durable: true });
  const { ctl } = s;
  ctl.sellerAuto = true;
  const first = s.jobId;
  assert.equal((await s.plan(Date.now())).disposition, 'present');
  const second = s.switchJob();
  ctl.sellerAuto = false;
  const running = s.plan(Date.now());
  await s.waitForSellerPrompt();
  const swept = await s.provider.sweep(() => true);
  assert.equal(swept.deleted, 1); assert.equal(swept.usage.jobs, 1);
  assert.deepEqual((await s.vetState()).map((row) => row.jobId), [second], 'the running job is kept');
  ctl.sellerGate.resolve(true);
  assert.equal((await running).disposition, 'present');
  assert.equal((await s.provider.sweep((jobId) => jobId === first)).deleted, 0, 'a purchase not known to have ended is kept');
  assert.equal((await s.provider.sweep((jobId) => jobId === second)).deleted, 1);
  assert.deepEqual(await s.vetState(), []);
});

test('a purchase that ends while its Vet waits in the seller\'s approval keeps its row until that run settles', { timeout: 180000 }, async (t) => {
  const s = await setup(t);
  const { ctl } = s;
  const running = s.plan(Date.now());
  await s.waitForSellerPrompt();
  // The purchase ends; the seller CVR's approval prompt is still open.
  releaseDemDeliveryContext(s.capability, { jobId: s.jobId });
  await sleep(50);
  assert.equal((await s.vetState()).length, 1, 'kept: the waiting write may still land');
  ctl.sellerGate.resolve(true);
  const out = await running;
  t.diagnostic(JSON.stringify(out.disposition));
  await until(async () => (await s.vetState()).length === 0);
  assert.equal(s.acceptedFor(ctl.sellerAddr), 1, 'the approved CREATE landed while the row was kept');
});

// Code review P2 and P3-2: the store's capacity, and journal errors named as such.
test('a full party Vet store refuses a new job before anything is signed; the store reports its use', { timeout: 120000 }, async (t) => {
  const s = await setup(t, { storeOptions: { maxJobs: 1 } });
  const { ctl } = s;
  ctl.sellerAuto = true;
  assert.equal((await s.plan(Date.now())).disposition, 'present');
  assert.deepEqual({ ...s.provider.usage(), bytes: undefined, remainingBytes: undefined }, { jobs: 1, bytes: undefined, maxJobs: 1, maxTotalBytes: 256 * 1024 * 1024, remainingJobs: 0, remainingBytes: undefined });
  s.switchJob();
  const full = await s.plan(Date.now());
  assert.deepEqual(full, { disposition: 'indeterminate', reason: 'DEM delivery context failed: the party Vet store is full; nothing was written' });
  assert.equal(ctl.recordSignatures, 2); assert.equal(s.accepted(), 3, 'nothing sent for the second job');
});

test('journal capacity and busy errors and a changed binding get their own writer codes', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl } = s;
  ctl.sellerAuto = true;
  // A fresh job's store changes: bind, first checkpoint, record time, then the write mark.
  const expected = {
    'journal-capacity': 'capacity: a seller journal is full; this write was not stored',
    'journal-busy': 'busy: a seller journal is busy or its lock is held; this write was not started',
  };
  for (const [code, text] of Object.entries(expected)) {
    s.switchJob();
    const start = ctl.storeUpdates;
    ctl.onStoreUpdate = (n) => { if (n === start + 4) throw Object.assign(new Error(`TEST ${code}`), { code }); };
    const out = await s.plan(Date.now());
    assert.equal(out.disposition, 'indeterminate', JSON.stringify(out));
    assert.ok(out.reason.startsWith(`DEM delivery context failed: buyer Vet record write failed (${text}); `), out.reason);
    assert.equal(ctl.recordSignatures, 0);
  }
  // The binding replaced (as another process with no write would) between
  // the record time and the write mark.
  s.switchJob();
  const start = ctl.storeUpdates, fresh = s.identity(s.buyer, Date.now() - 5000);
  ctl.onStoreUpdate = async (n) => {
    if (n !== start + 4) return;
    ctl.onStoreUpdate = null;
    const [[key]] = (await s.store.entries()).filter(([, row]) => row.jobId === s.jobId);
    await s.store.update(key, (row) => ({ ...row, binding: { ...row.binding, buyerIdentityBundle: fresh } }));
  };
  const out = await s.plan(Date.now());
  assert.ok(out.reason.startsWith('DEM delivery context failed: buyer Vet record write failed (binding-changed: the job\'s Vet binding changed under this run; nothing was written); '), out.reason);
  assert.equal(ctl.recordSignatures, 0);
});

test('the raw writer cause is logged on one line', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const { ctl } = s;
  ctl.sellerAuto = true; ctl.transientSellerFailures = 0;
  const start = ctl.storeUpdates;
  ctl.onStoreUpdate = (n) => { if (n === start + 4) throw Object.assign(new Error('TEST line one\nline two\r three\\'), { code: 'journal-busy' }); };
  await s.plan(Date.now());
  const line = ctl.writerLog.find((entry) => entry.startsWith('party-vet-writer:'));
  assert.ok(line.endsWith('busy: journal-busy: TEST line one\\nline two\\r\\u2028three\\\\\n'), JSON.stringify(line));
  assert.equal(line.split('\n').length, 2, 'one line');
});
