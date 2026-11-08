import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { installNoEgress } from './helpers/no-egress.mjs';
import { T0, args, digest, dispatchKey, executed, open, options, otherSigner, ownership, ownershipKey, recordingSettlements, signed, signer, transactionKey } from './helpers/signer-reservation-world.mjs';

const trap = installNoEgress();
test.after(() => { trap.restore(); assert.deepEqual(trap.attempts, []); });
// Imported late so that, before the module exists, each test fails on its own instead of the whole file failing to load.
const module = await import('../src/wallet/signer-reservation.mjs').catch(error => ({ error }));
const create = (journal, extra) => { if (module.error) throw module.error; return module.createSignerReservations(options(journal, extra)); };
function world(t, wrap = journal => journal, limits = {}, extra) {
  const directory = mkdtempSync(join(tmpdir(), 'signer-reservation-')), path = join(directory, 'wallet.sqlite');
  const journal = open(path, 'create', limits), handles = [journal];
  const reopen = () => { const next = open(path, 'open', limits); handles.push(next); return next; };
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  const wrapped = wrap(journal);
  // Insert-only steps go through the same deterministic cut as the mutable puts.
  if (wrapped !== journal) wrapped.appendUnderLock = (lane, key, value) => wrapped.put(key, value);
  return { path, journal, reopen, reservations: create(wrapped, extra) };
}
async function approve(w, reservation, ledgerId = 'TEST-ledger') {
  const intent = await w.reservations.bindApprovalIntent(reservation, 'TEST-exact-request');
  return w.reservations.bindApproval(intent, { ledgerId, requestText: 'TEST-exact-request' });
}
const approved = async (w, request = args(), ledgerId) => approve(w, (await w.reservations.reserve(request)).reservation, ledgerId);
const bound = async (w, request, ledgerId, transaction = signed()) => w.reservations.bindSigned(await approved(w, request, ledgerId), transaction);
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
  const released = { ...first, revision: first.revision + 2, terminal: 'never-dispatched', history: [...first.history, { stage: 'never-dispatched', at: T0 }, { stage: 'settled', at: T0 }] };
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

test('a cleaned terminal attempt gains a fresh attempt id; an uncleaned terminal prefix is finished by reserve first', async t => {
  const settle = recordingSettlements(), w = world(t, x => x, {}, { settleApproval: settle.settleApproval });
  const reservation = await bound(w), first = await w.journal.get(dispatchKey(reservation.active.attemptId));
  const released = { ...first, revision: first.revision + 2, terminal: 'never-dispatched', history: [...first.history, { stage: 'never-dispatched', at: T0 }, { stage: 'settled', at: T0 }] };
  await w.journal.put(dispatchKey(first.attemptId), { ...first, revision: first.revision + 1, terminal: 'never-dispatched', history: [...first.history, { stage: 'never-dispatched', at: T0 }] });
  const { reservation: fresh } = await w.reservations.reserve(args('TEST-evidence-a', 'TEST-fresh'));
  assert.equal(fresh.active.attemptId, 'TEST-fresh'); assert.equal(fresh.active.txHash, null); assert.equal(fresh.revision, reservation.revision + 2);
  assert.deepEqual(await w.journal.get(dispatchKey(first.attemptId)), released);
  assert.deepEqual([...settle.effects], [['TEST-ledger', 'released']]);
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

// ---- terminal transitions, crash reconciliation and lock recovery ----
const proof = path => ownership(dirname(path));
const hashOf = signed().txHash, retiredKey = id => `devnet/signer-reservation-retired/${id}`;
const stages = attempt => attempt.history.map(entry => entry.stage);
const settledCount = attempt => stages(attempt).filter(stage => stage === 'settled').length;
const settling = (t, settle, wrap, extra) => world(t, wrap, {}, { settleApproval: settle.settleApproval, ...extra });
/** A world whose reservation journal throws before its Nth write once armed, so the cut stands for a death between two steps. */
function cutWorld(t, cut, settle) {
  const state = { armed: false, writes: 0 }, sentinel = new Error('TEST-write-cut');
  const w = settling(t, settle, journal => ({ ...journal, put: async (key, value) => { if (state.armed && ++state.writes === cut) throw sentinel; return journal.put(key, value); } }));
  return { w, sentinel, arm: () => { state.armed = true; } };
}
/** Reopens the journal as a restarted process would: a new reservation instance, then recovery under the ownership proof. */
async function restarted(w, settle, extra) { const reservations = create(w.reopen(), { settleApproval: settle.settleApproval, ...extra }); await reservations.recover({ stateOwnership: proof(w.path) }); return reservations; }
async function sellerWorld(t) {
  const { api, mnemonicBytes, world: buildWorld } = await import('./helpers/tp1-node-fixture.mjs');
  const { reentrantOwner, sellerPublications } = await import('./helpers/effect-gate-world.mjs');
  const w = await buildWorld(t, { ownerWrap: reentrantOwner, createSession: api.createNodeSellerComposition, sessionOptions: { approveConfirmedWrite: null, publications: sellerPublications() } });
  const construct = stateOwnership => api.createNodeSellerComposition({ admission: w.admission, owner: w.owner, journal: w.journal(), key: mnemonicBytes(), publications: sellerPublications(),
    approveConfirmedWrite: null, approve: async () => true, clock: w.clock, ...(stateOwnership === undefined ? {} : { stateOwnership }) });
  return Object.assign(w, { construct });
}

test('a reservation takes chain nonce plus one, writes bind-started for the attempt, the stable transaction, signed and the attempt/hash ownership link in commit order before signCreate returns, and advances only on an authenticated execution of those bytes', async t => {
  const settle = recordingSettlements(), writes = [];
  const w = settling(t, settle, journal => ({ ...journal, put: async (key, value) => { writes.push(key); return journal.put(key, value); } }));
  const reservation = await approved(w, { ...args(), readChainNonce: async () => 4 }), five = signed(5), attempt = dispatchKey(reservation.active.attemptId);
  assert.equal(reservation.active.nonce, 5);
  writes.length = 0;
  await w.reservations.bindSigned(reservation, five);
  assert.deepEqual(writes, [attempt, transactionKey(five.txHash), attempt, ownershipKey]);
  assert.deepEqual(stages(await w.journal.get(attempt)), ['bind-started', 'signed']);
  await rejectCode(w.reservations.consume(five.txHash, { ...executed(five), status: 'pending' }), 'signer_execution_unproven');
  assert.equal((await w.journal.get(ownershipKey)).active.txHash, five.txHash);
  await w.reservations.consume(five.txHash, executed(five));
  const owner = await w.journal.get(ownershipKey);
  assert.deepEqual([owner.active, owner.floor], [null, 6]);
  assert.deepEqual([...settle.effects], [['TEST-ledger', 'spent']]);
});

test('an evidence CREATE and an artifact write, in both orders: the later operation refuses signer_lane_busy until the earlier is consumed', async t => {
  for (const [first, second] of [['payment-evidence', 'artifact'], ['artifact', 'payment-evidence']]) {
    const w = settling(t, recordingSettlements());
    await bound(w, { ...args('TEST-first', 'TEST-attempt-first'), operation: first });
    const later = { ...args('TEST-second', 'TEST-attempt-second'), operation: second };
    await rejectCode(w.reservations.reserve(later), 'signer_lane_busy');
    await w.reservations.consume(hashOf, executed());
    assert.equal((await w.reservations.reserve(later)).nonce, 2);
  }
});

test('killed at each step of bindSigned before the ownership link: reopening twice marks that attempt never-dispatched, retains the stable transaction if present, retires the unsigned ownership and settles its recovered approval released once; permitted work can then reserve the same nonce', async t => {
  for (let cut = 1; cut <= 4; cut++) {
    const settle = recordingSettlements(), { w, sentinel, arm } = cutWorld(t, cut, settle);
    const reservation = await approved(w), attemptId = reservation.active.attemptId; arm();
    await assert.rejects(w.reservations.bindSigned(reservation, signed()), causedBy(sentinel));
    const reopened = await restarted(w, settle), recovered = await w.journal.entries();
    await reopened.recover({ stateOwnership: proof(w.path) });
    assert.deepEqual(await w.journal.entries(), recovered, 'the second reopen changes nothing');
    const attempt = await w.journal.get(dispatchKey(attemptId)), owner = await w.journal.get(ownershipKey);
    if (cut === 1) assert.equal(attempt, undefined);
    else assert.deepEqual([attempt.terminal, settledCount(attempt), attempt.txHash], ['never-dispatched', 1, hashOf]);
    assert.equal((await w.journal.get(transactionKey(hashOf))) !== undefined, cut >= 3);
    assert.equal((await w.journal.get(retiredKey(attemptId))).attemptId, attemptId);
    assert.deepEqual([owner.active, owner.floor], [null, 0]);
    assert.deepEqual([...settle.effects], [['TEST-ledger', 'released']]);
    assert.equal((await reopened.reserve(args('TEST-evidence-a', 'TEST-attempt-fresh'))).nonce, 1);
  }
});

test('killed after the ownership link and before any egress: the same operation finds its bound, unsent transaction to adopt or retire never-dispatched without an ownership write or a chain nonce read, and any other operation refuses signer_lane_busy', async t => {
  for (const branch of ['adopt', 'retire']) {
    const settle = recordingSettlements(), w = settling(t, settle), c = child(t, w.path, 'bound');
    assert.equal((await c.next()).event, 'bound'); await c.exit;
    const reopened = await restarted(w, settle), before = await w.journal.entries();
    const found = await reopened.boundUnsent(signer, 'TEST-child');
    assert.equal(found.transaction.projectionText, signed().projectionText);
    const repeated = await reopened.reserve({ ...args('TEST-child', 'TEST-unused'), readChainNonce: () => { throw new Error('TEST-no-chain-read'); } });
    assert.deepEqual(repeated.reservation, found.reservation); assert.deepEqual(await w.journal.entries(), before);
    await rejectCode(reopened.reserve(args('TEST-other')), 'signer_lane_busy');
    const attemptKey = dispatchKey(found.reservation.active.attemptId);
    if (branch === 'adopt') {
      assert.deepEqual((await reopened.adopt(found.reservation)).transaction, found.transaction);
      assert.deepEqual(stages(await w.journal.get(attemptKey)).slice(-1), ['adopted']);
      assert.deepEqual(await w.journal.get(ownershipKey), found.reservation, 'adoption writes no ownership record');
      assert.equal(settle.calls.length, 0);
    } else {
      await reopened.retireNeverDispatched(found.reservation);
      assert.equal((await w.journal.get(attemptKey)).terminal, 'never-dispatched');
      assert.deepEqual([...settle.effects], [['TEST-ledger', 'released']]);
      assert.equal(await reopened.boundUnsent(signer, 'TEST-child'), null);
    }
  }
});

const SCENARIOS = {
  consume: { outcome: 'spent', writes: 3, start: w => bound(w), run: w => w.reservations.consume(hashOf, executed()), retry: r => r.consume(hashOf, executed()),
    check: owner => assert.deepEqual([owner.active, owner.floor], [null, 2]) },
  retireNeverDispatched: { outcome: 'released', writes: 3, start: w => bound(w), run: (w, reservation) => w.reservations.retireNeverDispatched(reservation),
    retry: async r => { const owner = await r.current(signer); if (owner.active.txHash) await r.retireNeverDispatched(owner); },
    check: owner => assert.deepEqual([owner.active, owner.floor], [{ attemptId: owner.active.attemptId, operation: 'payment-evidence', operationKey: 'TEST-evidence-a', nonce: 1, txHash: null, approvalIntent: null, approval: null }, 0]) },
  retireUnsigned: { outcome: 'released', writes: 2, start: w => approved(w), run: (w, reservation) => w.reservations.retireUnsigned(reservation, { revision: reservation.revision, cause: new Error('TEST-declined') }),
    retry: async () => {}, check: owner => assert.deepEqual([owner.active, owner.floor], [null, 0]) },
};
test('a kill between each pair of steps of consume, retireNeverDispatched and retireUnsigned, including after settled before ownership cleanup: two reopens finish cleanup without changing a newer owner, release or spend once, preserve the correct floor and transmit nothing', async t => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) for (const cut of Array.from({ length: scenario.writes + 1 }, (_, index) => index)) {
    // cut 0 fails the ledger settlement call instead of a journal write.
    const settle = recordingSettlements({ failFirst: cut === 0 }), { w, sentinel, arm } = cutWorld(t, cut, settle);
    const reservation = await scenario.start(w); arm();
    await assert.rejects(scenario.run(w, reservation), error => cut === 0 ? error.code === 'signer_settlement_failed' && error.cause.message === 'TEST-settlement-barrier' : causedBy(sentinel)(error));
    const reopened = await restarted(w, settle);
    await scenario.retry(reopened);
    const finished = await w.journal.entries();
    await reopened.recover({ stateOwnership: proof(w.path) }); await scenario.retry(reopened);
    assert.deepEqual(await w.journal.entries(), finished, `${name} cut ${cut}: a further reopen changes nothing`);
    scenario.check(await w.journal.get(ownershipKey));
    assert.deepEqual([...settle.effects], [['TEST-ledger', scenario.outcome]], `${name} cut ${cut}`);
    const attempt = await w.journal.get(dispatchKey(reservation.active.attemptId));
    if (attempt) assert.equal(settledCount(attempt), 1, `${name} cut ${cut}`);
  }
  // A newer owner reserved before any recovery is never changed by finishing the older consume.
  const settle = recordingSettlements(), { w, sentinel, arm } = cutWorld(t, 3, settle);
  await bound(w); arm();
  await assert.rejects(w.reservations.consume(hashOf, executed()), causedBy(sentinel));
  const next = create(w.reopen(), { settleApproval: settle.settleApproval }), { reservation } = await next.reserve(args('TEST-evidence-b', 'TEST-attempt-b'));
  assert.equal(reservation.active.nonce, 2);
  assert.deepEqual([...settle.effects], [['TEST-ledger', 'spent']]);
  const second = await next.bindSigned(await approve({ reservations: next }, reservation, 'TEST-ledger-b'), signed(2));
  await next.recover({ stateOwnership: proof(w.path) });
  assert.deepEqual(await w.journal.get(ownershipKey), second);
});

test('a node nonce answer below the consumed floor yields the floor; a consumed or reserved nonce is never signed again', async t => {
  const w = settling(t, recordingSettlements());
  await bound(w); await w.reservations.consume(hashOf, executed());
  const stale = { ...args('TEST-evidence-a', 'TEST-attempt-2'), readChainNonce: async () => 0 };
  const second = await approved(w, stale, 'TEST-ledger-2');
  assert.equal(second.active.nonce, 2);
  await rejectCode(w.reservations.bindSigned(second, signed(1)), 'signer_reservation_invalid');
  await w.reservations.retireUnsigned(second, { revision: second.revision, cause: new Error('TEST-declined') });
  assert.equal((await w.reservations.reserve({ ...stale, attemptId: 'TEST-attempt-3' })).nonce, 2);
});

test('consume requires an authenticated execution observation of the bound hash; included-but-failed, pending or a saved earlier answer leave the reservation live', async t => {
  const settle = recordingSettlements(), w = settling(t, settle);
  await bound(w); const before = await w.journal.entries(), good = executed();
  for (const observation of [undefined, null, 'executed', { ...good, status: 'included' }, { ...good, status: 'failed' }, { ...good, status: 'pending' },
    { ...good, authenticated: false }, { ...good, authenticated: undefined }, { ...good, txHash: signed(2).txHash }, { ...good, projectionText: signed(2).projectionText }, { ...good, projectionText: good.projectionText + ' ' }]) {
    await rejectCode(w.reservations.consume(hashOf, observation), 'signer_execution_unproven');
  }
  await rejectCode(w.reservations.consume(signed(2).txHash, executed(signed(2))), 'signer_reservation_unknown');
  assert.deepEqual(await w.journal.entries(), before); assert.equal(settle.calls.length, 0);
});

test('transaction A executed and consumed, then B reserved: ownerOfHash(A) still validates, and consuming A again changes nothing, B\'s ownership and nonce included', async t => {
  const w = settling(t, recordingSettlements());
  await bound(w); await w.reservations.consume(hashOf, executed());
  const second = await bound(w, args('TEST-evidence-b', 'TEST-attempt-b'), 'TEST-ledger-b', signed(2)), before = await w.journal.entries();
  const rows = await w.reservations.ownerOfHash(hashOf);
  assert.deepEqual([rows.attempts.map(row => row.terminal), rows.currentAttempt], [['consumed'], null]);
  await w.reservations.consume(hashOf, executed()); await w.reservations.consume(hashOf, executed());
  assert.deepEqual(await w.journal.entries(), before);
  assert.deepEqual(await w.reservations.current(signer), second); assert.equal(second.active.nonce, 2);
});

test('consuming one hash twice settles spent once and writes settled once', async t => {
  const settle = recordingSettlements(), w = settling(t, settle);
  const reservation = await bound(w);
  await w.reservations.consume(hashOf, executed()); await w.reservations.consume(hashOf, executed());
  assert.deepEqual(settle.calls.map(call => [call.ledgerId, call.outcome]), [['TEST-ledger', 'spent']]);
  const attempt = await w.journal.get(dispatchKey(reservation.active.attemptId));
  assert.deepEqual([settledCount(attempt), stages(attempt).filter(stage => stage === 'consumed').length, attempt.terminal], [1, 1, 'consumed']);
});

test('retireUnsigned needs the current revision and an unsigned reservation, keeps the floor, writes the retirement record and settles a bound approval released; a late bindSigned from the retired revision is refused', async t => {
  const settle = recordingSettlements(), w = settling(t, settle), declined = Object.assign(new Error('TEST-declined'), { code: 'TEST-declined-code' });
  const linked = await bound(w);
  await rejectCode(w.reservations.retireUnsigned(linked, { revision: linked.revision, cause: declined }), 'signer_reservation_invalid');
  await w.reservations.consume(hashOf, executed());
  const unsigned = await approved(w, args('TEST-evidence-a', 'TEST-attempt-2'), 'TEST-ledger-2');
  await rejectCode(w.reservations.retireUnsigned(unsigned, { revision: unsigned.revision - 1, cause: declined }), 'signer_reservation_stale');
  const retired = await w.reservations.retireUnsigned(unsigned, { revision: unsigned.revision, cause: declined });
  assert.deepEqual([retired.active, retired.floor], [null, 2]);
  assert.deepEqual((await w.journal.get(retiredKey('TEST-attempt-2'))).cause, { code: 'TEST-declined-code', message: 'TEST-declined' });
  assert.equal(settle.effects.get('TEST-ledger-2'), 'released');
  await rejectCode(w.reservations.bindSigned(unsigned, signed(2)), 'signer_reservation_stale');
  assert.equal(await w.journal.get(dispatchKey('TEST-attempt-2')), undefined);
});

test('retirement killed after settled before cleanup: reopen twice clears exactly txHash, approvalIntent and approval, retains operation and nonce with unchanged floor, excludes retired-byte adoption, records one released completion and admits subsequent permitted work', async t => {
  const settle = recordingSettlements(), { w, sentinel, arm } = cutWorld(t, 3, settle);
  const reservation = await bound(w); arm();
  await assert.rejects(w.reservations.retireNeverDispatched(reservation), causedBy(sentinel));
  const attemptId = reservation.active.attemptId, before = await w.journal.get(dispatchKey(attemptId));
  assert.deepEqual([stages(before).slice(-2), (await w.journal.get(ownershipKey)).active.txHash], [['never-dispatched', 'settled'], hashOf]);
  const reopened = await restarted(w, settle); await reopened.recover({ stateOwnership: proof(w.path) });
  const owner = await w.journal.get(ownershipKey);
  assert.deepEqual(owner.active, { attemptId, operation: 'payment-evidence', operationKey: 'TEST-evidence-a', nonce: 1, txHash: null, approvalIntent: null, approval: null });
  assert.equal(owner.floor, 0);
  assert.equal(await reopened.boundUnsent(signer, 'TEST-evidence-a'), null);
  await rejectCode(reopened.adopt(reservation), 'signer_reservation_stale');
  assert.deepEqual(await w.journal.get(dispatchKey(attemptId)), before, 'the one released completion is unchanged');
  assert.equal(settledCount(before), 1); assert.deepEqual([...settle.effects], [['TEST-ledger', 'released']]);
  const fresh = await reopened.reserve(args('TEST-evidence-a', 'TEST-attempt-fresh'));
  assert.deepEqual([fresh.nonce, fresh.reservation.active.attemptId], [1, 'TEST-attempt-fresh']);
});

test('an intent is durable before prepare may run; a missing id resolves only by its stored requestText before continuation or retirement, attaches the recovered id under the same attempt/revision and releases an unused preparation once', async t => {
  const settle = recordingSettlements(), lookups = [], found = { ledgerId: 'TEST-recovered', requestText: 'TEST-exact-request' };
  const intentOf = async w => w.reservations.bindApprovalIntent((await w.reservations.reserve(args())).reservation, 'TEST-exact-request');
  const w = settling(t, settle), intent = await intentOf(w);
  const lookup = async requestText => { lookups.push([requestText, (await w.journal.get(ownershipKey)).active.approvalIntent.requestText]); return found; };
  const attached = await create(w.reopen(), { openApproval: lookup, settleApproval: settle.settleApproval }).resolveApprovalIntent(intent);
  assert.deepEqual([attached.active.approval, attached.active.attemptId, attached.revision], [found, intent.active.attemptId, intent.revision + 1]);
  assert.deepEqual(lookups, [['TEST-exact-request', 'TEST-exact-request']]);
  // The same recovery before retirement: an unused preparation is released once, by the id the lookup found.
  const lost = settling(t, settle), pending = await intentOf(lost);
  const again = create(lost.reopen(), { openApproval: lookup, settleApproval: settle.settleApproval });
  await again.retireUnsigned(pending, { revision: pending.revision, cause: new Error('TEST-declined') });
  await again.recover({ stateOwnership: proof(lost.path) });
  assert.deepEqual([...settle.effects], [['TEST-recovered', 'released']]);
  assert.equal((await lost.journal.get(ownershipKey)).active, null);
  // An exact lookup with no match authorizes nothing and settles nothing.
  const none = settling(t, settle), unmatched = await intentOf(none);
  const empty = create(none.reopen(), { openApproval: async () => null, settleApproval: settle.settleApproval });
  assert.equal((await empty.resolveApprovalIntent(unmatched)).active.approval, null);
  await empty.retireUnsigned(unmatched, { revision: unmatched.revision, cause: new Error('TEST-declined') });
  assert.equal(settle.calls.length, 1);
});

test('unavailable, ambiguous or malformed intent lookup keeps the exact intent and refuses effects; no rebuilt request, retirement or manual fallback loses a possible policy hold', async t => {
  const sentinel = new Error('TEST-lookup-unavailable'), binding = { ledgerId: 'TEST-x', requestText: 'TEST-exact-request' };
  const answers = [() => { throw sentinel; }, () => [binding, binding], () => ({ ledgerId: 7, requestText: 'TEST-exact-request' }), () => ({ ledgerId: 'TEST-x', requestText: 'TEST-other' }), () => undefined, () => 'TEST-string'];
  for (const answer of answers) {
    const settle = recordingSettlements(), w = settling(t, settle);
    const intent = await w.reservations.bindApprovalIntent((await w.reservations.reserve(args())).reservation, 'TEST-exact-request'), before = await w.journal.entries();
    const reopened = create(w.reopen(), { openApproval: async () => answer(), settleApproval: settle.settleApproval });
    for (const refused of [() => reopened.resolveApprovalIntent(intent), () => reopened.retireUnsigned(intent, { revision: intent.revision, cause: new Error('TEST-declined') }),
      () => reopened.reserve(args()), () => reopened.recover({ stateOwnership: proof(w.path) })]) {
      await assert.rejects(refused(), error => error.code === 'approval_lookup_refused' && error.cause instanceof Error);
    }
    await rejectCode(reopened.bindApprovalIntent(intent, 'TEST-rebuilt'), 'signer_reservation_invalid');
    await rejectCode(reopened.bindSigned(intent, signed()), 'signer_reservation_invalid');
    assert.deepEqual(await w.journal.entries(), before); assert.equal(settle.calls.length, 0);
  }
  const w = world(t), intent = await w.reservations.bindApprovalIntent((await w.reservations.reserve(args())).reservation, 'TEST-exact-request');
  await assert.rejects(create(w.reopen(), { openApproval: async () => { throw sentinel; } }).resolveApprovalIntent(intent), error => error.cause === sentinel);
});

test('same hash and stable operation/input under a new attempt reuse the byte-equal immutable record only after every prior attempt is proven never dispatched; earlier history remains, a consumed hash or a different operation/input refuses, and no stale attempt alters the new owner', async t => {
  const settle = recordingSettlements(), w = settling(t, settle);
  const first = await bound(w), tx = await w.journal.get(transactionKey(hashOf));
  await w.reservations.retireNeverDispatched(first);
  const retired = await w.journal.get(dispatchKey(first.active.attemptId));
  const second = await approved(w, args('TEST-evidence-a', 'TEST-attempt-b'), 'TEST-ledger-b');
  await rejectCode(w.reservations.bindSigned(second, { ...signed(), inputDigest: digest('TEST-changed') }), 'signer_reservation_invalid');
  await w.reservations.bindSigned(second, signed());
  assert.deepEqual(await w.journal.get(transactionKey(hashOf)), tx);
  assert.deepEqual(await w.journal.get(dispatchKey(first.active.attemptId)), retired);
  const rows = await w.reservations.ownerOfHash(hashOf);
  assert.deepEqual([rows.attempts.map(row => row.attemptId), rows.currentAttempt.attemptId], [['TEST-attempt-a', 'TEST-attempt-b'], 'TEST-attempt-b']);
  const before = await w.journal.entries();
  await rejectCode(w.reservations.recordStage(first, 'confirm-started'), 'signer_reservation_stale');
  await rejectCode(w.reservations.adopt(first), 'signer_reservation_stale');
  assert.deepEqual(await w.journal.entries(), before);
  await w.reservations.consume(hashOf, executed());
  assert.deepEqual((await w.reservations.ownerOfHash(hashOf)).attempts.map(row => row.terminal), ['never-dispatched', 'consumed']);
  assert.deepEqual([...settle.effects], [['TEST-ledger', 'released'], ['TEST-ledger-b', 'spent']]);
  // A hash whose earlier attempt may have been dispatched is never bound again, and the earlier record is untouched.
  const d = world(t), sent = await bound(d); await d.reservations.recordStage(sent, 'confirm-started');
  const owner = await d.journal.get(ownershipKey);
  await d.journal.put(ownershipKey, { ...owner, revision: owner.revision + 1, active: { ...owner.active, attemptId: 'TEST-attempt-c', txHash: null, approvalIntent: null, approval: null } });
  const prior = await d.journal.get(dispatchKey(sent.active.attemptId));
  await rejectCode(approve(d, await d.reservations.current(signer)).then(next => d.reservations.bindSigned(next, signed())), 'signer_reservation_invalid');
  assert.deepEqual(await d.journal.get(dispatchKey(sent.active.attemptId)), prior);
});

test('SIGKILL while the signer lock is held, before the nonce reply, inside bindSigned and inside consume: a restarted owner with the ownership proof removes the abandoned lock rows and reconciles, and the lock removal changes no record', async t => {
  for (const mode of ['before', 'cut:5', 'cut:9']) {
    const settle = recordingSettlements(), w = world(t), c = child(t, w.path, mode); await c.exit;
    assert.deepEqual(w.journal.inspectLocks().map(row => [row.key, row.pid === process.pid]), [[ownershipKey, false]], mode);
    const handle = w.reopen(), before = await handle.entries();
    assert.deepEqual((await module.releaseAbandonedJournalLocks({ journal: handle, stateOwnership: proof(w.path) })).released, [ownershipKey]);
    assert.deepEqual(await handle.entries(), before, 'lock removal changes no record'); assert.deepEqual(handle.inspectLocks(), []);
    await create(handle, { settleApproval: settle.settleApproval }).recover({ stateOwnership: proof(w.path) });
    const owner = await handle.get(ownershipKey), attempt = await handle.get(dispatchKey('TEST-child'));
    if (mode === 'before') assert.equal(owner, undefined);
    else if (mode === 'cut:5') assert.deepEqual([owner.active, owner.floor, attempt.terminal, [...settle.effects]], [null, 0, 'never-dispatched', [['TEST-ledger', 'released']]]);
    else assert.deepEqual([owner.active, owner.floor, attempt.terminal, [...settle.effects]], [null, 2, 'consumed', [['TEST-ledger', 'spent']]]);
  }
});

test('with the first instance alive and holding the state lock and the signer lock, a second instance gets no ownership proof, its construction refuses state_ownership_required, and the first instance\'s lock row is untouched', async t => {
  const w = await sellerWorld(t), holder = child(t, w.path, 'stall', 'TEST-holder');
  assert.equal((await holder.next()).event, 'reading');
  const rows = w.journal().inspectLocks(), before = await w.journal().entries();
  assert.deepEqual(rows.map(row => row.key), [ownershipKey]);
  for (const stateOwnership of [ownership(dirname(w.path), false), undefined, {}, ownership(dirname(w.path), 'yes'), ownership(join(dirname(w.path), 'elsewhere'))]) {
    await rejectCode(w.construct(stateOwnership), 'state_ownership_required');
  }
  assert.deepEqual(w.journal().inspectLocks(), rows); assert.deepEqual(await w.journal().entries(), before);
  holder.process.send('finish'); assert.equal((await holder.next()).event, 'result'); await holder.exit;
});

test('a seller composition built with the ownership proof removes a killed holder\'s lock rows before it returns', async t => {
  const w = await sellerWorld(t), c = child(t, w.path, 'before'); await c.exit;
  assert.equal(w.journal().inspectLocks().length, 1);
  const composition = await w.construct(ownership(dirname(w.path)));
  assert.deepEqual(w.journal().inspectLocks(), []); await composition.close();
});

test('a restart killed inside the retirement of a bindSigned prefix is finished by the next reopen, which settles released once and leaves permitted work able to reserve', async t => {
  for (let cut = 1; cut <= 4; cut++) {
    const settle = recordingSettlements(), { w, sentinel, arm } = cutWorld(t, 4, settle);
    const reservation = await approved(w); arm();
    await assert.rejects(w.reservations.bindSigned(reservation, signed()), causedBy(sentinel));
    // The first restart dies before the Nth write of its own recovery: attempt never-dispatched, audit record, settled, ownership cleared.
    const raw = w.reopen(); let writes = 0;
    const dying = async (key, value) => { if (++writes === cut) throw sentinel; return raw.put(key, value); };
    await assert.rejects(create({ ...raw, put: dying, appendUnderLock: (lane, key, value) => dying(key, value) }, { settleApproval: settle.settleApproval }).recover({ stateOwnership: proof(w.path) }), causedBy(sentinel));
    const reopened = await restarted(w, settle), finished = await w.journal.entries();
    await reopened.recover({ stateOwnership: proof(w.path) });
    assert.deepEqual(await w.journal.entries(), finished, `cut ${cut}: a further reopen changes nothing`);
    const attempt = await w.journal.get(dispatchKey(reservation.active.attemptId)), owner = await w.journal.get(ownershipKey);
    assert.deepEqual([attempt.terminal, settledCount(attempt), owner.active, owner.floor], ['never-dispatched', 1, null, 0], `cut ${cut}`);
    assert.deepEqual([...settle.effects], [['TEST-ledger', 'released']], `cut ${cut}`);
    assert.equal((await reopened.reserve(args('TEST-evidence-a', 'TEST-attempt-fresh'))).nonce, 1);
  }
});

test('recovery never removes a lock row of this handle or of another live handle in this process, and never releases a transaction reservation', async t => {
  const settle = recordingSettlements(), w = settling(t, settle), reservation = await bound(w), other = w.reopen();
  const before = await w.journal.entries();
  await w.journal.withWalletLock(ownershipKey, async () => {
    const rows = w.journal.inspectLocks();
    assert.deepEqual((await module.releaseAbandonedJournalLocks({ journal: other, stateOwnership: proof(w.path) })).released, [], 'another live handle of this process');
    assert.deepEqual((await module.releaseAbandonedJournalLocks({ journal: w.journal, stateOwnership: proof(w.path) })).released, [], 'this handle');
    assert.deepEqual(w.journal.inspectLocks(), rows);
  });
  await create(other, { settleApproval: settle.settleApproval }).recover({ stateOwnership: proof(w.path) });
  assert.deepEqual(await w.journal.entries(), before); assert.deepEqual(await w.reservations.current(signer), reservation);
  assert.equal(settle.calls.length, 0);
});
