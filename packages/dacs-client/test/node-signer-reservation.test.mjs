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
const create = journal => { if (module.error) throw module.error; return module.createSignerReservations(options(journal)); };
const REQUEST = 'TEST-exact-request';
const LEDGER = { ledgerId: 'TEST-ledger', requestText: REQUEST };
function world(t, { wrap = journal => journal, limits = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'signer-reservation-')), path = join(directory, 'wallet.sqlite');
  const journal = open(path, 'create', limits), handles = [journal];
  const reopen = () => { const next = open(path, 'open', limits); handles.push(next); return next; };
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, journal, reopen, reservations: create(wrap(journal)) };
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

test('the package exports expose no reservation member; only the composition reaches it', async t => {
  const { exports: entries } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.deepEqual(Object.keys(entries), ['.', './wallet/durable-journal', './node-wallet']);
  await assert.rejects(import('@kynesyslabs/dacs-client/src/wallet/signer-reservation.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.equal(Object.keys(await import('../src/wallet/node-wallet-session.mjs')).some(name => /reservation/i.test(name)), false);
  const { gateWorld } = await import('./helpers/effect-gate-world.mjs');
  const w = await gateWorld(t);
  assert.equal(Object.keys(w.session).some(name => /reservation|reserve|bindSigned/.test(name)), false);
});

test('no socket or DNS lookup leaves the process in the reservation suite', () => { assert.deepEqual(trap.attempts, []); });
