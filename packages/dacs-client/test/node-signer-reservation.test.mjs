import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { installNoEgress } from './helpers/no-egress.mjs';
import { T0, args, digest, dispatchKey, open, options, otherSigner, ownershipKey, signed, signer, transactionKey } from './helpers/signer-reservation-world.mjs';

const trap = installNoEgress();
test.after(() => { trap.restore(); assert.deepEqual(trap.attempts, []); });
// Imported late so that, before the module exists, each test fails on its own instead of the whole file failing to load.
const module = await import('../src/wallet/signer-reservation.mjs').catch(error => ({ error }));
const create = journal => { if (module.error) throw module.error; return module.createSignerReservations(options(journal)); };
function world(t, wrap = journal => journal, limits = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'signer-reservation-')), path = join(directory, 'wallet.sqlite');
  const journal = open(path, 'create', limits), handles = [journal];
  const reopen = () => { const next = open(path, 'open', limits); handles.push(next); return next; };
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  const wrapped = wrap(journal);
  // Insert-only steps go through the same deterministic cut as the mutable puts.
  if (wrapped !== journal) wrapped.appendUnderLock = (lane, key, value) => wrapped.put(key, value);
  return { path, journal, reopen, reservations: create(wrapped) };
}
async function approved(w, request = args()) {
  let { reservation } = await w.reservations.reserve(request);
  reservation = await w.reservations.bindApprovalIntent(reservation, 'TEST-exact-request');
  return w.reservations.bindApproval(reservation, { ledgerId: 'TEST-ledger', requestText: 'TEST-exact-request' });
}
const bound = async w => w.reservations.bindSigned(await approved(w), signed());
function child(t, path, mode, attemptId = 'TEST-child') {
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const worker = fork(new URL('./helpers/signer-reservation-child.mjs', import.meta.url), [path, mode, attemptId], { execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; worker.stderr.on('data', bytes => { stderr += bytes; });
  const messages = [], waiting = [];
  worker.on('message', row => { const resolve = waiting.shift(); if (resolve) resolve(row); else messages.push(row); });
  const exit = once(worker, 'exit');
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); });
  return { process: worker, exit, next: () => messages.length ? Promise.resolve(messages.shift()) : Promise.race([new Promise(resolve => waiting.push(resolve)), exit.then(() => { throw new Error('TEST-child-exited:' + stderr); })]) };
}
const rejectCode = (promise, code) => assert.rejects(promise, { code });
const causedBy = sentinel => error => error === sentinel || error.cause === sentinel;

test('two different evidence addresses: the second reserve refuses signer_lane_busy while the first CREATE can execute, and the two never receive the same nonce', async t => {
  const w = world(t), reservation = await bound(w);
  await rejectCode(w.reservations.reserve(args('TEST-evidence-b', 'TEST-attempt-b')), 'signer_lane_busy');
  assert.equal((await w.reservations.current(signer)).active.nonce, 1);
  const recorded = await w.reservations.recordStage(reservation, 'confirm-started');
  assert.equal(recorded.active.txHash, signed().txHash);
  assert.deepEqual(JSON.parse((await w.reservations.ownerOfHash(signed().txHash)).transaction.projectionText), JSON.parse(signed().projectionText));
});

test('killed after confirm-started: a reopened composition finds the owner; other operations and a repeated reserve for the same operation after possible dispatch refuse signer_lane_busy, and only exact-byte replay may proceed', async t => {
  const w = world(t), c = child(t, w.path, 'dispatch');
  assert.equal((await c.next()).event, 'dispatched'); await c.exit;
  const reopened = create(w.reopen()), owner = await reopened.current(signer);
  assert.equal(owner.active.txHash, signed().txHash);
  await rejectCode(reopened.reserve(args('TEST-child')), 'signer_lane_busy');
  await rejectCode(reopened.reserve(args('TEST-other')), 'signer_lane_busy');
  assert.equal((await reopened.ownerOfHash(owner.active.txHash)).transaction.projectionText, signed().projectionText);
});

test('a chain nonce at Number.MAX_SAFE_INTEGER, or a floor whose successor is not a safe integer, refuses invalid_nonce before any reservation', async t => {
  const w = world(t);
  await rejectCode(w.reservations.reserve({ ...args(), readChainNonce: async () => Number.MAX_SAFE_INTEGER }), 'invalid_nonce');
  assert.equal(await w.journal.get(ownershipKey), undefined);
  const { reservation } = await w.reservations.reserve(args());
  await w.journal.put(ownershipKey, { ...reservation, active: null, floor: Number.MAX_SAFE_INTEGER });
  await rejectCode(w.reservations.reserve(args()), 'invalid_nonce');
  assert.equal((await w.journal.get(ownershipKey)).active, null);
});

test('two journal handles on one file contend for one signer; exactly one reserves', async t => {
  const w = world(t), other = create(w.reopen());
  const results = await Promise.allSettled([w.reservations.reserve(args()), other.reserve(args('TEST-b', 'TEST-b'))]);
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

test('an unreadable or malformed chain nonce answer reserves nothing and signs nothing', async t => {
  const w = world(t), sentinel = new Error('TEST-nonce-read');
  await assert.rejects(w.reservations.reserve({ ...args(), readChainNonce: async () => { throw sentinel; } }), causedBy(sentinel));
  for (const value of [undefined, null, -1, 1.5, '1', {}, NaN]) await rejectCode(w.reservations.reserve({ ...args(), readChainNonce: async () => value }), 'invalid_nonce');
  assert.deepEqual(await w.journal.entries(), []);
});

test('dispatch history is appended by compare-and-swap and never rewritten; a write carrying a stale revision is refused', async t => {
  const w = world(t), reservation = await bound(w);
  const first = await w.reservations.recordStage(reservation, 'confirm-started');
  const prefix = (await w.journal.get(dispatchKey(reservation.active.attemptId))).history;
  await rejectCode(w.reservations.recordStage(reservation, 'broadcast-started'), 'signer_reservation_stale');
  await w.reservations.recordStage(first, 'confirm-answered', { cause: { code: 'TEST-refused', message: 'TEST-no-effect-proof' } });
  const history = (await w.journal.get(dispatchKey(reservation.active.attemptId))).history;
  assert.deepEqual(history.slice(0, prefix.length), prefix);
  assert.equal(history.at(-1).stage, 'confirm-answered');
  await rejectCode(w.reservations.bindSigned(reservation, signed()), 'signer_reservation_stale');
});

test('a record of another format, chain or signer, or a transaction record whose immutable fields or projection digest do not match, refuses effects with its cause while reads still answer', async t => {
  const w = world(t), reservation = await bound(w), tx = await w.journal.get(transactionKey(signed().txHash));
  for (const change of [{ format: 'TEST-other-format' }, { chainIdentity: '0'.repeat(64) }, { signer: otherSigner }, { nonce: 8 }, { projectionDigest: '0'.repeat(64) }, { operationKey: 'TEST-other' }]) {
    await w.journal.put(transactionKey(signed().txHash), { ...tx, ...change });
    await assert.rejects(w.reservations.recordStage(reservation, 'confirm-started'), error => error.code === 'signer_reservation_invalid' && error.cause instanceof Error);
    assert.ok((await w.journal.entries()).length > 0, 'passive journal reads still answer');
  }
  await w.journal.put(transactionKey(signed().txHash), tx);
  for (const change of [{ format: 'TEST-format' }, { chainIdentity: '0'.repeat(64) }, { signer: otherSigner }, { revision: -1 }]) {
    await w.journal.put(ownershipKey, { ...reservation, ...change });
    await rejectCode(w.reservations.reserve(args()), 'signer_reservation_invalid');
  }
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

test('kill before and after fresh ownership commit preserves nonce exclusivity and unchanged unsent retry', async t => {
  for (const mode of ['before', 'after']) {
    const w = world(t), c = child(t, w.path, mode); await c.next(); await c.exit;
    const reopened = create(w.reopen()), owner = await reopened.current(signer);
    if (mode === 'before') {
      assert.equal(owner, null);
      assert.equal((await reopened.reserve(args())).nonce, 1, 'the journal reclaims a proven-dead holder, without a timeout');
    } else {
      const prior = await w.journal.entries();
      const repeated = await reopened.reserve({ ...args('TEST-child', 'TEST-ignored'), readChainNonce: () => { throw new Error('TEST-unexpected-read'); } });
      assert.deepEqual(repeated.reservation, owner); assert.deepEqual(await w.journal.entries(), prior);
      await rejectCode(reopened.reserve(args('TEST-other')), 'signer_lane_busy');
    }
  }
});

test('approval-intent commit is durable before preparation can begin', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  const requestText = '{"at":1793102400000,"fee":"50","memo":"TEST-exact"}';
  const updated = await w.reservations.bindApprovalIntent(reservation, requestText);
  assert.equal((await create(w.reopen()).current(signer)).active.approvalIntent.requestText, requestText);
  await rejectCode(w.reservations.bindApproval(updated, { ledgerId: 'TEST-ledger', requestText: requestText + ' ' }), 'signer_reservation_invalid');
  await rejectCode(w.reservations.bindApprovalIntent(reservation, 'TEST-rebuilt'), 'signer_reservation_stale');
});

test('committed approval with lost id binds only through exact-intent recovery', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  await w.reservations.bindApprovalIntent(reservation, 'TEST-exact-request');
  // The ledger may have committed here. This card keeps the exact intent; it neither infers an id nor looks one up (P21a3ab).
  const reopened = create(w.reopen()), owner = await reopened.current(signer);
  assert.equal(owner.active.approval, null);
  await rejectCode(reopened.bindSigned(owner, signed()), 'signer_reservation_invalid');
  assert.equal((await reopened.current(signer)).active.approvalIntent.requestText, 'TEST-exact-request');
  const recovered = { ledgerId: 'TEST-recovered-ledger', requestText: owner.active.approvalIntent.requestText };
  assert.deepEqual((await reopened.bindApproval(owner, recovered)).active.approval, recovered);
});

for (const [name, cut] of [
  ['bind-started to transaction-put crash prefix is reconciled twice', 2],
  ['immutable transaction without signed append cannot authorize dispatch', 3],
  ['signed attempt without ownership link is never exposed', 4],
]) test(name, async t => {
  let writes = 0, armed = false;
  const sentinel = new Error('TEST-write-cut');
  const w = world(t, journal => ({ ...journal, put: async (key, value) => { if (armed && ++writes === cut) throw sentinel; return journal.put(key, value); } }));
  const reservation = await approved(w); armed = true;
  await assert.rejects(w.reservations.bindSigned(reservation, signed()), causedBy(sentinel));
  const prefix = await w.journal.entries(), reopened = create(w.reopen());
  // Reconciliation of the prefix is P21a3ab's; here every look at it is repeatable and writes nothing.
  for (let repeat = 0; repeat < 2; repeat++) {
    const owner = await reopened.current(signer); assert.equal(owner.active.txHash, null);
    await rejectCode(reopened.recordStage(owner, 'confirm-started'), 'signer_reservation_invalid');
    await assert.rejects(reopened.bindSigned(owner, signed()));
    assert.deepEqual(await w.journal.entries(), prefix);
  }
  const attempt = await w.journal.get(dispatchKey(reservation.active.attemptId));
  assert.equal(attempt.txHash, signed().txHash);
  assert.equal(attempt.history.at(-1).stage, cut === 4 ? 'signed' : 'bind-started');
});

test('commit-then-throw reads back each bindSigned step before returning', async t => {
  for (let cut = 1; cut <= 4; cut++) {
    let writes = 0, armed = false, readbacks = 0;
    const sentinel = new Error('TEST-commit-then-throw');
    const w = world(t, journal => ({ ...journal, get: async key => { if (armed && writes === cut) readbacks++; return journal.get(key); },
      put: async (key, value) => { await journal.put(key, value); if (armed && ++writes === cut) throw sentinel; } }));
    const reservation = await approved(w); armed = true;
    const linked = await w.reservations.bindSigned(reservation, signed());
    assert.ok(readbacks > 0); assert.equal(linked.active.txHash, signed().txHash);
    assert.equal((await create(w.reopen()).current(signer)).active.txHash, signed().txHash);
  }
});

test('failed readback retains ownership and its original write cause', async t => {
  let armed = false, failed = false;
  const sentinel = new Error('TEST-write-failed'), unavailable = new Error('TEST-readback-failed');
  const w = world(t, journal => ({ ...journal, get: async key => { if (failed) throw unavailable; return journal.get(key); },
    put: async (key, value) => { if (armed) { failed = true; throw sentinel; } return journal.put(key, value); } }));
  const reservation = await approved(w); armed = true;
  await assert.rejects(w.reservations.bindSigned(reservation, signed()), error => error.code === 'signer_reservation_uncertain' && error.cause === sentinel);
  assert.deepEqual(await w.journal.get(ownershipKey), reservation);
});

test('aborted nonce read leaves no ownership and receives the caller signal', async t => {
  const w = world(t), controller = new AbortController(), sentinel = new Error('TEST-aborted');
  let reads = 0;
  const request = { ...args(), signal: controller.signal, readChainNonce: async ({ signal }) => {
    reads++; assert.equal(signal, controller.signal); controller.abort(sentinel); signal.throwIfAborted();
  } };
  await assert.rejects(w.reservations.reserve(request), error => error === sentinel);
  assert.equal(reads, 1);
  await assert.rejects(w.reservations.reserve(request), error => error === sentinel);
  assert.equal(reads, 1, 'already aborted calls never start another read');
  assert.equal(await w.reservations.current(signer), null);
});

test('immutable identity validates exact projection bytes and all historical attempts without granting authorization by hash', async t => {
  const w = world(t), reservation = await bound(w), first = await w.journal.get(dispatchKey(reservation.active.attemptId));
  const released = { ...first, revision: first.revision + 1, terminal: 'never-dispatched', history: [...first.history, { stage: 'never-dispatched', at: 1793102400000 }] };
  await w.journal.put(dispatchKey(first.attemptId), released);
  await w.journal.put(ownershipKey, { ...reservation, revision: reservation.revision + 1, active: null });
  let { reservation: next } = await w.reservations.reserve(args('TEST-evidence-a', 'TEST-attempt-b'));
  next = await w.reservations.bindApprovalIntent(next, 'TEST-exact-request');
  next = await w.reservations.bindApproval(next, { ledgerId: 'TEST-next-ledger', requestText: 'TEST-exact-request' });
  await rejectCode(w.reservations.bindSigned(next, { ...signed(), inputDigest: digest('TEST-changed') }), 'signer_reservation_invalid');
  next = await w.reservations.bindSigned(next, signed());
  const rows = await w.reservations.ownerOfHash(signed().txHash);
  assert.equal(rows.attempts.length, 2); assert.deepEqual(rows.attempts[0], released);
  assert.equal(rows.currentAttempt.attemptId, next.active.attemptId);
  assert.equal(rows.transaction.projectionText, signed().projectionText);
  assert.deepEqual(await w.journal.get(dispatchKey(first.attemptId)), released);
});

test('lookups write nothing and reject oversized or altered signed projections before persistence', async t => {
  const w = world(t), reservation = await approved(w), before = await w.journal.entries();
  for (const projectionText of [' '.repeat(256 * 1024 + 1), '{', JSON.stringify({ ...JSON.parse(signed().projectionText), hash: '0'.repeat(64) })]) {
    await rejectCode(w.reservations.bindSigned(reservation, { ...signed(), projectionText }), 'signer_reservation_invalid');
  }
  assert.deepEqual(await w.journal.entries(), before);
  assert.equal(await w.reservations.ownerOfHash(signed().txHash), null);
  await w.reservations.current(signer); assert.deepEqual(await w.journal.entries(), before);
});

test('an unsent bound repeat returns the same bytes, approval, attempt and revision without reading or writing', async t => {
  const w = world(t), reservation = await bound(w), before = await w.journal.entries();
  const repeated = await w.reservations.reserve({ ...args('TEST-evidence-a', 'TEST-unused'), readChainNonce: () => { throw new Error('TEST-no-chain-read'); } });
  assert.deepEqual(repeated, { reservation, nonce: 1 }); assert.deepEqual(await w.journal.entries(), before);
});

test('the nonce floor beats a stale chain answer and native or artifact operations cannot call around a live signer owner', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  for (const operation of ['native', 'artifact']) await rejectCode(w.reservations.reserve({ ...args(), operation }), 'signer_lane_busy');
  await w.journal.put(ownershipKey, { ...reservation, revision: reservation.revision + 1, active: null, floor: 8 });
  assert.equal((await w.reservations.reserve(args('TEST-evidence-a', 'TEST-second'))).nonce, 8);
});

test('a cleaned terminal attempt gains a fresh attempt id; an uncleaned terminal prefix refuses', async t => {
  const w = world(t), reservation = await bound(w), first = await w.journal.get(dispatchKey(reservation.active.attemptId));
  const released = { ...first, revision: first.revision + 1, terminal: 'never-dispatched', history: [...first.history, { stage: 'never-dispatched', at: 1793102400000 }] };
  await w.journal.put(dispatchKey(first.attemptId), released);
  await rejectCode(w.reservations.reserve(args('TEST-evidence-a', 'TEST-fresh')), 'signer_reservation_uncertain');
  const cleaned = { ...reservation.active, txHash: null, approvalIntent: null, approval: null };
  await w.journal.put(ownershipKey, { ...reservation, revision: reservation.revision + 1, active: cleaned });
  const { reservation: fresh } = await w.reservations.reserve(args('TEST-evidence-a', 'TEST-fresh'));
  assert.equal(fresh.active.attemptId, 'TEST-fresh'); assert.equal(fresh.active.txHash, null); assert.equal(fresh.revision, reservation.revision + 2);
  assert.deepEqual(await w.journal.get(dispatchKey(first.attemptId)), released);
});

test('a null manual ledger id never becomes durable approval authority', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  const intent = await w.reservations.bindApprovalIntent(reservation, 'TEST-manual-request');
  const manual = await w.reservations.bindApproval(intent, { ledgerId: null, requestText: 'TEST-manual-request' });
  assert.equal(manual.active.approval, null, 'manual authority is never saved');
  const reopened = create(w.reopen());
  await rejectCode(reopened.bindSigned(await reopened.current(signer), signed()), 'signer_reservation_invalid');
  const changed = await w.reservations.bindApprovalIntent(manual, 'TEST-manual-request');
  await rejectCode(w.reservations.bindSigned(changed, signed()), 'signer_reservation_invalid');
  const renewed = await w.reservations.bindApproval(changed, { ledgerId: null, requestText: 'TEST-manual-request' });
  assert.equal((await w.reservations.bindSigned(renewed, signed())).active.txHash, signed().txHash);
  assert.equal((await w.journal.get(dispatchKey(manual.active.attemptId))).approval, null);
});

test('a reused attempt id cannot overwrite a different signer attempt even if both unsigned owners already exist', async t => {
  const w = world(t), first = await approved(w);
  let { reservation: other } = await w.reservations.reserve({ ...args(), signer: otherSigner });
  other = await w.reservations.bindApprovalIntent(other, 'TEST-other-request');
  other = await w.reservations.bindApproval(other, { ledgerId: 'TEST-other-ledger', requestText: 'TEST-other-request' });
  await w.reservations.bindSigned(first, signed());
  const before = await w.journal.get(dispatchKey(first.active.attemptId));
  const candidate = JSON.parse(signed().projectionText); candidate.content.from = otherSigner; candidate.hash = digest(JSON.stringify(candidate.content));
  await rejectCode(w.reservations.bindSigned(other, { ...signed(), txHash: candidate.hash, projectionText: JSON.stringify(candidate) }), 'signer_reservation_invalid');
  assert.deepEqual(await w.journal.get(dispatchKey(first.active.attemptId)), before);
});

// A projection under the 256 KiB text limit whose serialized transaction record is over the journal's record limit.
function oversizedSigned(bytes = 262000) {
  const make = filler => {
    const content = { type: 'storageProgram', from: signer, nonce: 1, timestamp: T0, data: ['CREATE', { program: filler }] };
    const hash = digest(JSON.stringify(content));
    return { txHash: hash, inputDigest: digest('TEST-public-input'), projectionText: JSON.stringify({ content, hash, signature: { type: 'ed25519', data: JSON.parse(signed().projectionText).signature.data } }) };
  };
  const base = Buffer.byteLength(make('').projectionText);
  return make('a'.repeat(bytes - base));
}

test('a projection that fits the text limit but not the journal record limit refuses before any attempt is written, and the reservation stays usable', async t => {
  const w = world(t), reservation = await approved(w), large = oversizedSigned();
  assert.ok(Buffer.byteLength(large.projectionText) <= 256 * 1024);
  await rejectCode(w.reservations.bindSigned(reservation, large), 'signer_reservation_invalid');
  assert.equal(await w.journal.get(dispatchKey(reservation.active.attemptId)), undefined, 'no bind-started attempt blocks the signer');
  assert.equal(await w.journal.get(transactionKey(large.txHash)), undefined);
  const reopened = create(w.reopen());
  assert.deepEqual((await reopened.reserve(args())).reservation, reservation);
  assert.equal((await reopened.bindSigned(await reopened.current(signer), signed())).active.txHash, signed().txHash);
});

test('an approval intent whose approval could not later be recorded refuses before it is stored', async t => {
  const w = world(t), { reservation } = await w.reservations.reserve(args());
  await rejectCode(w.reservations.bindApprovalIntent(reservation, 'x'.repeat(200 * 1024)), 'signer_reservation_invalid');
  assert.deepEqual(await w.reservations.current(signer), reservation, 'the oversized intent was not stored');
  const intent = await w.reservations.bindApprovalIntent(reservation, 'x'.repeat(100 * 1024));
  const approval = await w.reservations.bindApproval(intent, { ledgerId: 'L'.repeat(256), requestText: 'x'.repeat(100 * 1024) });
  assert.equal((await w.reservations.bindSigned(approval, signed())).active.txHash, signed().txHash);
});

test("a journal configured with a smaller record limit refuses an intent it could not hold and a projection it could not store, before any write", async t => {
  const tiny = world(t, undefined, { maxValueBytes: 800 }), { reservation: unbound } = await tiny.reservations.reserve(args());
  await rejectCode(tiny.reservations.bindApprovalIntent(unbound, 'TEST-exact-request'), 'signer_reservation_invalid');
  assert.deepEqual(await tiny.reservations.current(signer), unbound, 'the intent was not stored');
  const w = world(t, undefined, { maxValueBytes: 4096 }), reservation = await approved(w), large = oversizedSigned(4000);
  await rejectCode(w.reservations.bindSigned(reservation, large), 'signer_reservation_invalid');
  assert.equal(await w.journal.get(dispatchKey(reservation.active.attemptId)), undefined, 'no bind-started attempt blocks the signer');
  assert.equal((await w.reservations.bindSigned(reservation, signed())).active.txHash, signed().txHash);
});

test('a journal configured above the default record limit binds an approval and signed bytes that the default limit could not hold', async t => {
  const w = world(t, undefined, { maxValueBytes: 1024 * 1024 }), request = 'x'.repeat(200 * 1024), { reservation } = await w.reservations.reserve(args());
  const intent = await w.reservations.bindApprovalIntent(reservation, request);
  const approval = await w.reservations.bindApproval(intent, { ledgerId: 'L'.repeat(256), requestText: request });
  assert.equal((await w.reservations.bindSigned(approval, signed())).active.txHash, signed().txHash);
});

test('an approval intent refuses when its ownership record would outgrow the limit at a later revision, and a text that fits at the widest revision binds after repeated intents', async t => {
  const limit = 4096, ledgerId = '\u0001'.repeat(256);
  const sizeAt = (reservation, text, revision) => Buffer.byteLength(JSON.stringify({ ...reservation, revision, active: { ...reservation.active, txHash: 'f'.repeat(64),
    approvalIntent: { requestText: text }, approval: { ledgerId, requestText: text } } }));
  let w = world(t, undefined, { maxValueBytes: limit }), { reservation } = await w.reservations.reserve(args());
  // Every text byte is counted twice, so an odd remainder is fixed by one more byte in the operation key.
  if ((limit - sizeAt(reservation, '', 8)) % 2) { w = world(t, undefined, { maxValueBytes: limit }); ({ reservation } = await w.reservations.reserve(args('TEST-evidence-ab'))); }
  const text = 'x'.repeat((limit - sizeAt(reservation, '', 8)) / 2);
  assert.equal(sizeAt(reservation, text, 8), limit, 'fits when the link is measured at the revision after this intent');
  assert.equal(sizeAt(reservation, text, 10), limit + 1, 'the link, after seven intents and the approval, is one byte over');
  await rejectCode(w.reservations.bindApprovalIntent(reservation, text), 'signer_reservation_invalid');
  assert.deepEqual(await w.reservations.current(signer), reservation, 'the intent was not stored');
  const fitting = text.slice(8);
  let current = reservation;
  for (let call = 0; call < 7; call++) current = await w.reservations.bindApprovalIntent(current, fitting);
  current = await w.reservations.bindApproval(current, { ledgerId, requestText: fitting });
  assert.equal((await w.reservations.bindSigned(current, signed())).active.txHash, signed().txHash);
});
