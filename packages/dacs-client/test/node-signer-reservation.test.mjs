import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { installNoEgress } from './helpers/no-egress.mjs';
import { args, open, options, otherSigner, recordKey, signed, signer } from './helpers/signer-reservation-world.mjs';

const trap = installNoEgress();
test.after(() => { trap.restore(); assert.deepEqual(trap.attempts, []); });
// Imported late so that, before the module exists, each test fails on its own instead of the whole file failing to load.
const module = await import('../src/wallet/signer-reservation.mjs').catch(error => ({ error }));
const create = (journal, ledger) => { if (module.error) throw module.error; return module.createSignerReservations({ ...options(journal), ...ledger }); };
const REQUEST = 'TEST-exact-request';
const LEDGER = { ledgerId: 'TEST-ledger', requestText: REQUEST };
// The approval ledger's two calls, recorded. `open` answers the lookup; `settle` may throw.
function ledgerDouble({ open = async () => null, settle = async () => {} } = {}) {
  const settled = [];
  return { settled, openApproval: open, settleApproval: async (ledgerId, outcome, reason) => { await settle(ledgerId, outcome, reason); settled.push([ledgerId, outcome, reason]); } };
}
function world(t, { wrap = journal => journal, limits = {}, ledger } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'signer-reservation-')), path = join(directory, 'wallet.sqlite');
  const journal = open(path, 'create', limits), handles = [journal];
  const reopen = () => { const next = open(path, 'open', limits); handles.push(next); return next; };
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, journal, reopen, ownership: { directory, held: async () => true }, reservations: create(wrap(journal), ledger) };
}
// Only the three members the reservation needs, so every test also shows it uses nothing else of the journal.
const narrow = (journal, put = (key, value) => journal.put(key, value), get = key => journal.get(key)) => ({ get, put, withWalletLock: (key, work) => journal.withWalletLock(key, work) });
async function approved(reservations, request = args()) {
  const { reservation } = await reservations.reserve(request);
  return reservations.bindApproval(await reservations.bindApprovalIntent(reservation, REQUEST), LEDGER);
}
function child(t, path, mode, operationKey = 'TEST-child') {
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const worker = fork(new URL('./helpers/signer-reservation-child.mjs', import.meta.url), [path, mode, operationKey], { execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; worker.stderr.on('data', bytes => { stderr += bytes; });
  const messages = [], waiting = [];
  worker.on('message', row => { const resolve = waiting.shift(); if (resolve) resolve(row); else messages.push(row); });
  const exit = once(worker, 'exit');
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); });
  return { process: worker, exit, next: () => messages.length ? Promise.resolve(messages.shift()) : Promise.race([new Promise(resolve => waiting.push(resolve)), exit.then(() => { throw new Error('TEST-child-exited:' + stderr); })]) };
}
const rejectCode = (promise, code) => assert.rejects(promise, { code });
const noChainRead = () => { throw new Error('TEST-unexpected-chain-read'); };

test('two different evidence addresses: the second reserve refuses signer_lane_busy and the two never receive the same nonce', async t => {
  const w = world(t), reservation = await w.reservations.bindSigned(await approved(w.reservations), signed());
  await rejectCode(w.reservations.reserve(args('TEST-evidence-b')), 'signer_lane_busy');
  for (const operation of ['native', 'artifact']) await rejectCode(w.reservations.reserve({ ...args(), operation }), 'signer_lane_busy');
  assert.deepEqual(await w.reservations.current(signer), reservation);
  assert.equal(reservation.active.nonce, 1);
});

test('killed after bindSigned: a reopened instance reads the same bytes, a same-operation reserve returns them unchanged and other operations refuse signer_lane_busy', async t => {
  const w = world(t), c = child(t, w.path, 'signed');
  assert.equal((await c.next()).event, 'signed'); await c.exit;
  const reopened = create(w.reopen()), stored = await reopened.current(signer);
  assert.deepEqual(stored.active.signed, signed());
  assert.deepEqual(await reopened.reserve({ ...args('TEST-child'), readChainNonce: noChainRead }), { reservation: stored, nonce: 1 });
  await rejectCode(reopened.reserve(args('TEST-other')), 'signer_lane_busy');
});

test('a chain nonce at Number.MAX_SAFE_INTEGER, or a floor whose successor is not a safe integer, refuses invalid_nonce before any reservation', async t => {
  const w = world(t);
  await rejectCode(w.reservations.reserve({ ...args(), readChainNonce: async () => Number.MAX_SAFE_INTEGER }), 'invalid_nonce');
  assert.equal(await w.journal.get(recordKey()), undefined);
  const { reservation } = await w.reservations.reserve(args());
  await w.journal.put(recordKey(), { ...reservation, revision: 2, active: null, floor: Number.MAX_SAFE_INTEGER });
  await rejectCode(w.reservations.reserve(args()), 'invalid_nonce');
  assert.equal((await w.journal.get(recordKey())).active, null);
});

test('the nonce floor beats a stale chain answer and a chain answer beats a lower floor', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  await w.journal.put(recordKey(), { ...reservation, revision: 2, active: null, floor: 8 });
  assert.equal((await w.reservations.reserve(args())).nonce, 8);
  const later = await w.reservations.current(signer);
  await w.journal.put(recordKey(), { ...later, revision: 4, active: null });
  assert.equal((await w.reservations.reserve({ ...args(), readChainNonce: async () => 20 })).nonce, 21);
});

test('two journal handles on one file contend for one signer; exactly one reserves', async t => {
  const w = world(t), other = create(w.reopen());
  const results = await Promise.allSettled([w.reservations.reserve(args()), other.reserve(args('TEST-b'))]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.ok(['signer_lane_busy', 'journal-busy'].includes(results.find(row => row.status === 'rejected').reason.code));
});

test("two instances of our program reserving through the module on one journal file contend; exactly one reserves, and a stalled holder's lock is never taken over by a timeout", async t => {
  const w = world(t), holder = child(t, w.path, 'stall', 'TEST-holder');
  assert.equal((await holder.next()).event, 'reading');
  const contender = child(t, w.path, 'reserve', 'TEST-contender');
  assert.equal((await contender.next()).code, 'journal-busy'); await contender.exit;
  assert.equal(w.journal.inspectLocks().length, 1);
  holder.process.send('finish'); assert.equal((await holder.next()).event, 'result'); await holder.exit;
  const again = child(t, w.path, 'reserve', 'TEST-later');
  assert.equal((await again.next()).code, 'signer_lane_busy'); await again.exit;
});

test('killed before or after the claim commits: before leaves no reservation, after keeps the nonce and a repeat returns the claim unchanged', async t => {
  for (const mode of ['before', 'after']) {
    const w = world(t), c = child(t, w.path, mode); await c.next(); await c.exit;
    const reopened = create(w.reopen()), stored = await reopened.current(signer);
    if (mode === 'before') {
      assert.equal(stored, null);
      assert.equal((await reopened.reserve(args())).nonce, 1, 'the journal reclaims a proven-dead holder, without a timeout');
    } else {
      const prior = await w.journal.entries();
      assert.deepEqual(await reopened.reserve({ ...args('TEST-child'), readChainNonce: noChainRead }), { reservation: stored, nonce: 1 });
      assert.deepEqual(await w.journal.entries(), prior);
      await rejectCode(reopened.reserve(args('TEST-other')), 'signer_lane_busy');
    }
  }
});

test('an unreadable or malformed chain nonce answer reserves nothing and signs nothing', async t => {
  const w = world(t), sentinel = new Error('TEST-nonce-read');
  await assert.rejects(w.reservations.reserve({ ...args(), readChainNonce: async () => { throw sentinel; } }), error => error === sentinel);
  for (const value of [undefined, null, -1, 1.5, '1', {}, NaN]) await rejectCode(w.reservations.reserve({ ...args(), readChainNonce: async () => value }), 'invalid_nonce');
  assert.deepEqual(await w.journal.entries(), []);
});

test('an abort before or after the chain read reserves nothing and frees the signer lock', async t => {
  const w = world(t), sentinel = new Error('TEST-aborted');
  const early = new AbortController(); early.abort(sentinel);
  await assert.rejects(w.reservations.reserve({ ...args(), signal: early.signal, readChainNonce: noChainRead }), error => error === sentinel);
  const late = new AbortController();
  await assert.rejects(w.reservations.reserve({ ...args(), signal: late.signal, readChainNonce: async ({ signal }) => { assert.equal(signal, late.signal); late.abort(sentinel); return 0; } }), error => error === sentinel);
  assert.deepEqual(await w.journal.entries(), []);
  assert.deepEqual(w.journal.inspectLocks(), []);
  assert.equal((await w.reservations.reserve(args())).nonce, 1);
});

test('a handle that is not the stored record is refused signer_reservation_stale at every step', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  const intent = await w.reservations.bindApprovalIntent(reservation, REQUEST);
  await rejectCode(w.reservations.bindApprovalIntent(reservation, REQUEST), 'signer_reservation_stale');
  await rejectCode(w.reservations.bindApproval(reservation, LEDGER), 'signer_reservation_stale');
  await w.reservations.bindApproval(intent, LEDGER);
  await rejectCode(w.reservations.bindSigned(intent, signed()), 'signer_reservation_stale');
});

test('identical retries return the stored record without advancing its revision', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  assert.deepEqual((await w.reservations.reserve({ ...args(), readChainNonce: noChainRead })).reservation, reservation);
  const intent = await w.reservations.bindApprovalIntent(reservation, REQUEST);
  assert.deepEqual(await w.reservations.bindApprovalIntent(intent, REQUEST), intent);
  await rejectCode(w.reservations.bindApprovalIntent(intent, 'TEST-rebuilt-request'), 'signer_reservation_invalid');
  const approval = await w.reservations.bindApproval(intent, LEDGER);
  assert.deepEqual(await w.reservations.bindApproval(approval, LEDGER), approval);
  await rejectCode(w.reservations.bindApproval(approval, { ...LEDGER, ledgerId: 'TEST-other-ledger' }), 'signer_reservation_invalid');
  assert.equal((await w.reservations.current(signer)).revision, 3);
});

test('the approval intent is durable before preparation: after a restart it authorizes nothing and still takes the ledger id', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  await w.reservations.bindApprovalIntent(reservation, REQUEST);
  const reopened = create(w.reopen()), stored = await reopened.current(signer);
  assert.equal(stored.active.approvalIntent, REQUEST);
  await rejectCode(reopened.bindSigned(stored, signed()), 'signer_reservation_invalid');
  await rejectCode(reopened.bindApproval(stored, { ...LEDGER, requestText: REQUEST + ' ' }), 'signer_reservation_invalid');
  assert.equal((await reopened.bindApproval(stored, LEDGER)).active.approvalId, LEDGER.ledgerId);
});

test('a manual approval is kept by this instance only: a reopened instance refuses bindSigned, and a ledger approval can still follow', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  const intent = await w.reservations.bindApprovalIntent(reservation, REQUEST);
  const manual = await w.reservations.bindApproval(intent, { ledgerId: null, requestText: REQUEST });
  assert.deepEqual(manual, intent, 'nothing durable records a manual approval');
  const reopened = create(w.reopen());
  await rejectCode(reopened.bindSigned(await reopened.current(signer), signed()), 'signer_reservation_invalid');
  await rejectCode(w.reservations.bindSigned(manual, { ...signed(), txHash: '0'.repeat(64) }), 'signer_reservation_invalid');
  const ledger = await w.reservations.bindApproval(manual, LEDGER);
  assert.equal(ledger.active.approvalId, LEDGER.ledgerId);
  assert.deepEqual((await reopened.bindSigned(ledger, signed())).active.signed, signed());
});

test('bindApproval after bindSigned refuses and the record still reads', async t => {
  const w = world(t), bound = await w.reservations.bindSigned(await approved(w.reservations), signed());
  await rejectCode(w.reservations.bindApproval(bound, LEDGER), 'signer_reservation_invalid');
  await rejectCode(w.reservations.bindApproval(bound, { ledgerId: null, requestText: REQUEST }), 'signer_reservation_invalid');
  await rejectCode(w.reservations.bindSigned(bound, signed()), 'signer_reservation_invalid');
  assert.deepEqual(await w.reservations.current(signer), bound);
});

test('bindSigned refuses a zeroed signature, another key\'s signature and a signature over another hash, and binds the real signature with or without 0x', async t => {
  const w = world(t), reservation = await approved(w.reservations), before = await w.journal.entries();
  const otherHash = JSON.parse(signed({ program: 'TEST-other-program' }).projectionText).signature.data;
  for (const variant of [signed({ signature: '0'.repeat(128) }), signed({ signWith: 'other' }), signed({ signature: otherHash })]) {
    await rejectCode(w.reservations.bindSigned(reservation, variant), 'signer_reservation_invalid');
  }
  assert.deepEqual(await w.journal.entries(), before);
  const prefixed = signed({ signature: '0x' + JSON.parse(signed().projectionText).signature.data });
  assert.deepEqual((await w.reservations.bindSigned(reservation, prefixed)).active.signed, prefixed);
});

test('bindSigned refuses a projection whose hash, signer, nonce, content digest or input digest does not match', async t => {
  const w = world(t), reservation = await approved(w.reservations), projection = JSON.parse(signed().projectionText);
  const altered = change => ({ ...signed(), projectionText: JSON.stringify(change(structuredClone(projection))) });
  for (const variant of [
    { ...signed(), txHash: '0'.repeat(64) },
    signed({ address: otherSigner }),
    signed({ nonce: 2 }),
    altered(row => { row.content.timestamp += 1; return row; }),
    altered(row => { row.signature.type = 'secp256k1'; return row; }),
    { ...signed(), inputDigest: 'TEST-not-a-digest' },
    { ...signed(), projectionText: '{' },
  ]) await rejectCode(w.reservations.bindSigned(reservation, variant), 'signer_reservation_invalid');
  assert.deepEqual(await w.reservations.current(signer), reservation);
});

test('malformed, oversized and NUL-containing arguments refuse at every step before any write', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args()), before = await w.journal.entries();
  const bad = ['', 'TEST\0nul', 'x'.repeat(257), 42, undefined];
  for (const value of bad) {
    await rejectCode(w.reservations.reserve({ ...args(), operationKey: value }), 'signer_reservation_invalid');
    await rejectCode(w.reservations.bindApproval(reservation, { ledgerId: value, requestText: REQUEST }), 'signer_reservation_invalid');
  }
  for (const value of ['0x12', signer.toUpperCase(), 7]) await rejectCode(w.reservations.reserve({ ...args(), signer: value }), 'signer_reservation_invalid');
  await rejectCode(w.reservations.reserve({ ...args(), operation: 'TEST-other' }), 'signer_reservation_invalid');
  await rejectCode(w.reservations.reserve({ ...args(), readChainNonce: undefined }), 'signer_reservation_invalid');
  for (const value of ['', 'TEST\0nul', 'x'.repeat(256 * 1024 + 1), 7]) await rejectCode(w.reservations.bindApprovalIntent(reservation, value), 'signer_reservation_invalid');
  for (const value of ['', 'TEST\0nul', ' '.repeat(256 * 1024 + 1)]) await rejectCode(w.reservations.bindSigned(reservation, { ...signed(), projectionText: value }), 'signer_reservation_invalid');
  await rejectCode(w.reservations.bindSigned(reservation, {}), 'signer_reservation_invalid');
  assert.deepEqual(await w.journal.entries(), before);
});

test('a record of another format, chain or signer refuses with its cause while another signer stays usable', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  const other = await w.reservations.reserve(args('TEST-evidence-a', otherSigner));
  assert.notEqual(other.reservation.active.attemptId, reservation.active.attemptId);
  for (const change of [{ format: 'TEST-old' }, { chainIdentity: 'f'.repeat(64) }, { signer: otherSigner }, { revision: 0 },
    { active: { ...reservation.active, nonce: 0 } }, { active: { ...reservation.active, approvalId: 'TEST-ledger' } },
    { active: { ...reservation.active, approvalIntent: REQUEST, signed: signed({ signature: '0'.repeat(128) }) } }]) {
    await w.journal.put(recordKey(), { ...reservation, ...change });
    await rejectCode(w.reservations.reserve(args()), 'signer_reservation_invalid');
    await rejectCode(w.reservations.current(signer), 'signer_reservation_invalid');
    assert.deepEqual(await w.reservations.current(otherSigner), other.reservation);
  }
  const next = await w.reservations.bindApprovalIntent(other.reservation, REQUEST);
  assert.equal(next.active.approvalIntent, REQUEST);
});

test('a put that throws is read back at every step: committed returns the stored record, not committed rethrows and keeps the previous record, unreadable is signer_reservation_uncertain', async t => {
  const steps = [
    ['reserve', async r => (await r.reserve(args())).reservation],
    ['bindApprovalIntent', (r, handle) => r.bindApprovalIntent(handle, REQUEST)],
    ['bindApproval', (r, handle) => r.bindApproval(handle, LEDGER)],
    ['bindSigned', (r, handle) => r.bindSigned(handle, signed())],
  ];
  for (const fault of ['committed', 'not-committed', 'unreadable']) {
    for (let index = 0; index < steps.length; index++) {
      let armed = false, failed = false;
      const sentinel = new Error('TEST-write-cut');
      const w = world(t, { wrap: journal => narrow(journal,
        async (key, value) => { if (!armed) return journal.put(key, value); armed = false; if (fault !== 'not-committed') await journal.put(key, value); failed = true; throw sentinel; },
        async key => { if (failed && fault === 'unreadable') throw new Error('TEST-read-back'); return journal.get(key); }) });
      let handle = null;
      for (const [, run] of steps.slice(0, index)) handle = await run(w.reservations, handle);
      armed = true;
      const attempt = steps[index][1](w.reservations, handle);
      if (fault === 'committed') assert.deepEqual(await attempt, await w.journal.get(recordKey()), steps[index][0]);
      if (fault === 'not-committed') { await assert.rejects(attempt, error => error === sentinel); assert.deepEqual(await w.journal.get(recordKey()) ?? null, handle); }
      if (fault === 'unreadable') await assert.rejects(attempt, error => error.code === 'signer_reservation_uncertain' && error.cause === sentinel);
    }
  }
});

test('a record the journal refuses leaves the previous record usable: a too-large intent or projection changes nothing and a fitting one then binds', async t => {
  const w = world(t, { limits: { maxValueBytes: 4096 } }), { reservation } = await w.reservations.reserve(args());
  await rejectCode(w.reservations.bindApprovalIntent(reservation, 'x'.repeat(5000)), 'journal-capacity');
  assert.deepEqual(await w.reservations.current(signer), reservation);
  const approval = await w.reservations.bindApproval(await w.reservations.bindApprovalIntent(reservation, REQUEST), LEDGER);
  await rejectCode(w.reservations.bindSigned(approval, signed({ program: 'x'.repeat(5000) })), 'journal-capacity');
  assert.deepEqual(await w.reservations.current(signer), approval);
  assert.equal((await w.journal.entries()).length, 1);
  assert.deepEqual((await w.reservations.reserve({ ...args(), readChainNonce: noChainRead })).reservation, approval);
  assert.deepEqual((await w.reservations.bindSigned(approval, signed())).active.signed, signed());
});

test('a journal configured above the default record limit binds a projection the default journal refuses', async t => {
  const large = signed({ program: '"'.repeat(120 * 1024) });
  assert.ok(Buffer.byteLength(large.projectionText) <= 256 * 1024);
  const small = world(t), refused = await approved(small.reservations);
  await rejectCode(small.reservations.bindSigned(refused, large), 'journal-capacity');
  const w = world(t, { limits: { maxValueBytes: 1024 * 1024 } });
  assert.deepEqual((await w.reservations.bindSigned(await approved(w.reservations), large)).active.signed, large);
});

test('the whole flow fits a journal of one record, and a full journal refuses reserve with journal-capacity and writes nothing', async t => {
  const w = world(t, { limits: { maxRecords: 1 } });
  assert.deepEqual((await w.reservations.bindSigned(await approved(w.reservations), signed())).active.signed, signed());
  const full = world(t, { limits: { maxRecords: 1 } });
  await full.journal.put('TEST-other-record', { value: 1 });
  await rejectCode(full.reservations.reserve(args()), 'journal-capacity');
  assert.deepEqual((await full.journal.entries()).map(([key]) => key), ['TEST-other-record']);
});

const executed = (bytes, change = {}) => ({ status: 'executed', authenticated: true, txHash: bytes.txHash, projectionText: bytes.projectionText, ...change });
const failOnce = () => { let failed = false; return () => { if (failed) return; failed = true; throw new Error('TEST-put-refused'); }; };

test('retireUnsigned settles the approval released, keeps the floor and frees the signer: the nonce is chosen again and the old handle is stale', async t => {
  const ledger = ledgerDouble(), w = world(t, { ledger });
  const reservation = await approved(w.reservations), retired = await w.reservations.retireUnsigned(reservation);
  assert.equal(retired.active, null);
  assert.equal(retired.floor, 0);
  assert.deepEqual(ledger.settled, [[LEDGER.ledgerId, 'released', 'unsigned-retired']]);
  await rejectCode(w.reservations.bindSigned(reservation, signed()), 'signer_reservation_stale');
  await rejectCode(w.reservations.retireUnsigned(reservation), 'signer_reservation_stale');
  const next = await w.reservations.reserve(args('TEST-evidence-b'));
  assert.equal(next.nonce, 1);
  assert.equal(next.reservation.floor, 0);
  assert.equal(ledger.settled.length, 1);
});

test('retireUnsigned refuses signed bytes and changes nothing', async t => {
  const ledger = ledgerDouble(), w = world(t, { ledger });
  const reservation = await w.reservations.bindSigned(await approved(w.reservations), signed());
  await rejectCode(w.reservations.retireUnsigned(reservation), 'signer_reservation_invalid');
  assert.deepEqual(await w.reservations.current(signer), reservation);
  assert.deepEqual(ledger.settled, []);
});

async function withIntent(t, answer) {
  const looked = [], ledger = ledgerDouble({ open: async text => { looked.push(text); if (answer instanceof Error) throw answer; return answer; } }), w = world(t, { ledger });
  const { reservation } = await w.reservations.reserve(args());
  return { w, ledger, looked, intent: await w.reservations.bindApprovalIntent(reservation, REQUEST) };
}

test('a recorded intent without a ledger id is looked up by its exact text before retirement: the open approval found is released, none found settles nothing', async t => {
  const found = await withIntent(t, { ...LEDGER });
  assert.equal((await found.w.reservations.retireUnsigned(found.intent)).active, null);
  assert.deepEqual(found.looked, [REQUEST]);
  assert.deepEqual(found.ledger.settled, [[LEDGER.ledgerId, 'released', 'unsigned-retired']]);
  const none = await withIntent(t, null);
  assert.equal((await none.w.reservations.retireUnsigned(none.intent)).active, null);
  assert.deepEqual(none.ledger.settled, []);
});

test('an unavailable, inexact, empty or malformed lookup answer keeps the reservation and its intent and releases nothing', async t => {
  const answers = [new Error('TEST-lookup-down'), { ledgerId: 'TEST-other', requestText: REQUEST + ' ' }, { ledgerId: '', requestText: REQUEST }, 'TEST-text', undefined, [{ ...LEDGER }]];
  for (const answer of answers) {
    const { w, ledger, intent } = await withIntent(t, answer);
    await assert.rejects(w.reservations.retireUnsigned(intent), error => error.code === 'approval_lookup_refused' && (!(answer instanceof Error) || error.cause === answer));
    assert.deepEqual(await w.reservations.current(signer), intent);
    assert.deepEqual(ledger.settled, []);
  }
});

test('a manual grant is retired without a lookup or a settlement', async t => {
  const { w, ledger, looked, intent } = await withIntent(t, new Error('TEST-lookup-must-not-run'));
  const manual = await w.reservations.bindApproval(intent, { ledgerId: null, requestText: REQUEST });
  assert.equal((await w.reservations.retireUnsigned(manual)).active, null);
  assert.deepEqual(looked, []);
  assert.deepEqual(ledger.settled, []);
});

test('consume ends the reservation only on an authenticated execution of the exact bytes: pending, failed, unauthenticated and other bytes change nothing; the real one settles spent and moves the floor', async t => {
  const ledger = ledgerDouble(), w = world(t, { ledger }), bytes = signed();
  const reservation = await w.reservations.bindSigned(await approved(w.reservations), bytes);
  for (const change of [{ status: 'pending' }, { status: 'failed' }, { authenticated: false }, { authenticated: 'true' }, { txHash: '0'.repeat(64) }, { projectionText: bytes.projectionText + ' ' }]) {
    await rejectCode(w.reservations.consume(reservation, executed(bytes, change)), 'signer_execution_unproven');
  }
  await rejectCode(w.reservations.consume(reservation, undefined), 'signer_execution_unproven');
  assert.deepEqual(await w.reservations.current(signer), reservation);
  assert.deepEqual(ledger.settled, []);
  const consumed = await w.reservations.consume(reservation, executed(bytes));
  assert.equal(consumed.active, null);
  assert.equal(consumed.floor, 2);
  assert.deepEqual(ledger.settled, [[LEDGER.ledgerId, 'spent', 'executed']]);
  await rejectCode(w.reservations.consume(reservation, executed(bytes)), 'signer_reservation_stale');
  assert.equal(ledger.settled.length, 1, 'a repeated consume settles nothing again');
  assert.equal((await w.reservations.reserve(args('TEST-evidence-b'))).nonce, 2, 'the floor beats a stale chain answer of 0');
});

test('consume refuses a reservation without signed bytes', async t => {
  const w = world(t, { ledger: ledgerDouble() }), reservation = await approved(w.reservations);
  await rejectCode(w.reservations.consume(reservation, executed(signed())), 'signer_reservation_invalid');
  assert.deepEqual(await w.reservations.current(signer), reservation);
});

test('a manual grant is consumed without a settlement', async t => {
  const ledger = ledgerDouble(), w = world(t, { ledger }), bytes = signed();
  const { reservation } = await w.reservations.reserve(args()), intent = await w.reservations.bindApprovalIntent(reservation, REQUEST);
  const manual = await w.reservations.bindSigned(await w.reservations.bindApproval(intent, { ledgerId: null, requestText: REQUEST }), bytes);
  assert.equal((await w.reservations.consume(manual, executed(bytes))).floor, 2);
  assert.deepEqual(ledger.settled, []);
});

test('a put that fails after the settlement leaves the reservation whole, and repeating the call finishes it: the settlement is the same id and outcome', async t => {
  for (const [name, finish] of [['consume', (reservations, held, bytes) => reservations.consume(held, executed(bytes))], ['retireUnsigned', (reservations, held) => reservations.retireUnsigned(held)]]) {
    const ledger = ledgerDouble(), refuse = failOnce(), bytes = signed();
    const w = world(t, { ledger, wrap: journal => narrow(journal, async (key, value) => { if (value.active === null) refuse(); return journal.put(key, value); }) });
    const approvedHeld = await approved(w.reservations), held = name === 'consume' ? await w.reservations.bindSigned(approvedHeld, bytes) : approvedHeld;
    await assert.rejects(finish(w.reservations, held, bytes), { message: 'TEST-put-refused' });
    assert.deepEqual(await w.reservations.current(signer), held, `${name}: the previous record is unchanged`);
    assert.equal((await finish(w.reservations, held, bytes)).active, null);
    assert.equal(new Set(ledger.settled.map(row => row.join('/'))).size, 1, `${name}: one id and outcome settled`);
    assert.equal((await w.reservations.current(signer)).floor, name === 'consume' ? 2 : 0);
  }
});

test('a settlement that throws keeps the reservation, the original cause and a way to repeat', async t => {
  let down = true;
  const ledger = ledgerDouble({ settle: async () => { if (down) throw new Error('TEST-ledger-down'); } }), w = world(t, { ledger }), bytes = signed();
  const reservation = await w.reservations.bindSigned(await approved(w.reservations), bytes);
  await assert.rejects(w.reservations.consume(reservation, executed(bytes)), error => error.code === 'signer_settlement_failed' && error.cause.message === 'TEST-ledger-down');
  assert.deepEqual(await w.reservations.current(signer), reservation);
  down = false;
  assert.equal((await w.reservations.consume(reservation, executed(bytes))).active, null);
  assert.equal(ledger.settled.length, 1);
});

test('recover retires every reservation without signed bytes and keeps signed ones; a second recover changes nothing', async t => {
  const ledger = ledgerDouble(), w = world(t, { ledger }), bytes = signed({ address: otherSigner });
  await approved(w.reservations);
  const kept = await w.reservations.bindSigned(await approved(w.reservations, args('TEST-evidence-b', otherSigner)), bytes);
  const reopened = create(w.reopen(), ledger);
  await reopened.recover({ stateOwnership: w.ownership });
  const retired = await reopened.current(signer);
  assert.equal(retired.active, null);
  assert.equal(retired.floor, 0);
  assert.deepEqual(await reopened.current(otherSigner), kept);
  assert.deepEqual(ledger.settled, [[LEDGER.ledgerId, 'released', 'unsigned-retired']]);
  await reopened.recover({ stateOwnership: w.ownership });
  assert.deepEqual(await reopened.current(signer), retired);
  assert.equal(ledger.settled.length, 1);
  assert.equal((await reopened.reserve(args('TEST-evidence-c'))).nonce, 1, 'the retired nonce can be reserved again');
  await rejectCode(reopened.reserve(args('TEST-evidence-c', otherSigner)), 'signer_lane_busy');
});

test('recover on an empty journal, or one with a record of another chain, writes nothing and reserves nothing', async t => {
  const w = world(t, { ledger: ledgerDouble() });
  await w.reservations.recover({ stateOwnership: w.ownership });
  assert.deepEqual(await w.journal.entries(), []);
  await w.journal.put(recordKey(signer).replace(/"[a-f0-9]{64}"/, `"${'f'.repeat(64)}"`),{ format: 'dacs-signer-reservation/v3', signer, active: { nonce: 1 } });
  const before = await w.journal.entries();
  await w.reservations.recover({ stateOwnership: w.ownership });
  assert.deepEqual(await w.journal.entries(), before);
});

test('recover refuses without a valid ownership proof before it changes anything', async t => {
  const ledger = ledgerDouble(), w = world(t, { ledger }), reservation = await approved(w.reservations), outside = mkdtempSync(join(tmpdir(), 'signer-reservation-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  for (const proof of [undefined, {}, { directory: w.ownership.directory }, { ...w.ownership, held: async () => false }, { ...w.ownership, held: async () => { throw new Error('TEST-proof-down'); } },
    { directory: outside, held: async () => true }, { directory: join(w.ownership.directory, 'missing'), held: async () => true }]) {
    await rejectCode(w.reservations.recover({ stateOwnership: proof }), 'state_ownership_required');
  }
  assert.deepEqual(await w.reservations.current(signer), reservation);
  assert.deepEqual(ledger.settled, []);
});

test('a lock row of a dead holder that had this process\'s pid is released; this instance, this process and a live holder are kept', async t => {
  const w = world(t), row = (key, extra) => ({ key, instance: 'TEST-instance', fence: 1, pid: process.pid, thisInstance: false, holder: 'no-identity', ...extra });
  const rows = [row('dead'), row('mine', { thisInstance: true, holder: 'this-process' }), row('sibling', { holder: 'this-process' }), row('alive', { holder: 'live' }), row('boot', { holder: 'other-boot' })];
  const released = [], journal = { path: w.path, inspectLocks: () => rows, releaseAbandonedLock: ({ key }) => released.push(key) };
  assert.deepEqual(await module.releaseAbandonedJournalLocks({ journal, stateOwnership: w.ownership }), { released: ['dead', 'boot'] });
  assert.deepEqual(released, ['dead', 'boot']);
});

test('recovery keeps the lock row of another live handle in this process and releases no reservation', async t => {
  const w = world(t, { ledger: ledgerDouble() }), reservation = await approved(w.reservations), other = w.reopen();
  await w.journal.withWalletLock(recordKey(otherSigner), async () => {
    assert.deepEqual(await module.releaseAbandonedJournalLocks({ journal: other, stateOwnership: w.ownership }), { released: [] });
    assert.equal(other.inspectLocks().length, 1);
  });
  assert.deepEqual(await w.reservations.current(signer), reservation);
});

test('the package exports expose no reservation member; only the composition reaches it', async t => {
  const { exports: entries } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(Object.values(entries).some(target => /signer-reservation/.test(target)), false);
  await assert.rejects(import('@kynesyslabs/dacs-client/src/wallet/signer-reservation.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.equal(Object.keys(await import('../src/wallet/node-wallet-session.mjs')).some(name => /reservation/i.test(name)), false);
  const { gateWorld } = await import('./helpers/effect-gate-world.mjs');
  const w = await gateWorld(t);
  assert.equal(Object.keys(w.session).some(name => /reservation|reserve|bindSigned/.test(name)), false);
});

test('no socket or DNS lookup leaves the process in the reservation suite', () => { assert.deepEqual(trap.attempts, []); });
