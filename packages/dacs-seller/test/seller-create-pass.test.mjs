// runCreate over the seller's production wallet session: the kit effect boundary's checks and fence come first, then one
// session effect pass whose steps are the boundary's refresh, the host's stop check and the boundary's synchronous tail.
// Every test calls runCreate directly; the anchor's publish is not in the path. A refused path makes no signature and no
// transmission; its authority reads are counted exactly (S: the step-1 read, F: the reads of each refresh).
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash, listingAddress, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { agreementRequest } from '../../dacs-client/test/helpers/tp1-node-fixture.mjs';
import { T0, jsonResponse, ok, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';
import { EXECUTE_STAGES, walletSessionWorld } from './helpers/seller-wallet-session-world.mjs';

const guard = await import('../src/kit-operation-guard.mjs');
const { WRITE_FEE_CEILING_OS, createEffectBoundary, effectPassRemainingMs } = await import('../src/dacs/effect-boundary.mjs');
const { createEffectHistory } = await import('../src/dacs/effect-history.mjs');
const { createSellerCreatePass, currentAuthorizationFor } = await import('../src/devnet-demo/create-pass.mjs');
const { buildStorageProgramCreatePayload, deriveStorageAddress } = await import('../src/dacs/wallet-transactions.mjs');
const { DEVNET_AGREEMENT_PROFILE, DEVNET_DEMO_ARTIFACT_KIND, DEVNET_DEMO_ARTIFACT_POLICY } = await import('../src/dacs/devnet-source.mjs');
const { fixtureListing } = await import('./fixtures/listings.mjs');

const FEE_CEILING_OS = WRITE_FEE_CEILING_OS.toString();
const KIT_WINDOW_MS = 10_000;
const CREATE_PHASES = ['sign', 'confirmTx', 'broadcastTx'];
// The node messages of one authority read through the stages' binding.
const AUTHORITY_READS = ['getBlockByNumber', 'getNetworkInfo'];
const OTHER_CHAIN = 'd'.repeat(64);
const otherChain = (row) => (row.body?.params[0].message === 'getBlockByNumber'
  ? jsonResponse(ok({ number: row.body.params[0].data.blockNumber, status: 'confirmed', hash: OTHER_CHAIN, content: { previousHash: OTHER_CHAIN } })) : undefined);
const createOp = (changes = {}) => ({ operationId: 'demo/artifact/TEST-create-pass', lane: 'seller-wallet', operationClass: 'job-create', currentAuthorization: () => true, ...changes });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

// A monotonic test clock for a kit boundary: `advanceTo(ms)` moves it and runs, in order, every timer that is due.
function manualClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    after(ms, callback) { const timer = { at: now + ms, callback }; timers.add(timer); return () => timers.delete(timer); },
    advanceTo(at) { now = at; for (const timer of [...timers].sort((a, b) => a.at - b.at)) if (timer.at <= now && timers.delete(timer)) timer.callback(); },
  };
}

// A node answer in the RPC envelope.
const rpc = (response, extra = null) => jsonResponse({ result: 200, response, require_reply: false, extra });
// A node that acknowledges a broadcast it never applies, so the CREATE reads back pending and its one resend stays open.
const pendingNode = (row) => {
  const call = row.body?.params[0], message = call?.message || call?.extra;
  if (message === 'broadcastTx') return rpc({ hash: call.data.response.data.transaction.hash });
  if (message === 'getTransactionStatus') return rpc({ state: 'unknown' }, '');
  if (message === 'getTxByHash') return jsonResponse({ result: 400, response: 'error', require_reply: false, extra: null });
  return undefined;
};

/**
 * The production port and finalized session over the scripted node, with authority reads counted and transaction signatures
 * spied (`onSigned(transaction)` runs after each). `w.session` delegates every member of the real session; its `effectPass`
 * records the read count when it is called and the session lease (`w.passes`), and the reads each refreshAuthority call made
 * (`w.refreshes`); `w.onRefresh(phase)` runs as a refresh starts and `w.onRefreshed(phase)` once it has answered.
 * `w.fenceAsked` resolves when runCreate asks for the session fence. `w.boundary(options)` is a real kit boundary over the
 * stages' binding and history on a manual clock; `w.switchConnection()` moves its default connection to another one.
 */
async function createWorld(t, { onSigned } = {}) {
  const signatures = await spyTransactionSignatures(t.mock, (transaction) => onSigned?.(transaction));
  const world = await walletSessionWorld(t, { countAuthority: true });
  const { effectBoundary, session } = await world.finalize();
  const w = { world, signatures, effectBoundary, real: session, passes: [], refreshes: [], refusals: [], rpcSignatures: 0, fenceAsked: deferred(), onRefresh: null, onRefreshed: null };
  w.session = Object.freeze({ ...session,
    acquireConnectionFence() { w.fenceAsked.resolve(); return session.acquireConnectionFence(); },
    effectPass(options) {
      w.passes.push({ deadline: options.deadline, reads: world.authorityReads, fence: options.fence });
      const refused = (name, step, error) => { w.refusals.push([name, step?.phase, error?.code]); throw error; };
      const refreshAuthority = async (step) => {
        const before = world.authorityReads;
        try {
          await w.onRefresh?.(step?.phase);
          const answer = await options.refreshAuthority(step);
          await w.onRefreshed?.(step?.phase);
          return answer;
        } catch (error) { return refused('refreshAuthority', step, error); } finally { w.refreshes.push([step?.phase, world.authorityReads - before]); }
      };
      const finalStop = (step) => Promise.resolve().then(() => options.finalStop(step)).catch((error) => refused('finalStop', step, error));
      const synchronousChecks = options.synchronousChecks.map((check) => (step) => { try { return check(step); } catch (error) { return refused('synchronousChecks', step, error); } });
      return session.effectPass({ ...options, refreshAuthority, finalStop, synchronousChecks });
    } });
  let switched = false;
  w.switchConnection = (on = true) => { switched = on; };
  const currentLocal = () => (switched ? { ...world.stages.local(), connectionId: 'TEST-other-connection' } : world.stages.local());
  w.boundary = ({ clock = manualClock(), stopped = async () => false } = {}) => createEffectBoundary({ stopped, binding: world.stages.binding,
    currentLocal, feeCeilingOs: FEE_CEILING_OS, history: createEffectHistory({ dataDirectory: world.directory }), clock });
  w.runCreate = (effectBoundary, { stopped = async () => false } = {}) => createSellerCreatePass({ effectBoundary, session: w.session, stopped, feeCeilingOs: FEE_CEILING_OS,
    clock: world.options.clock }).runCreate;
  // The one resend of `signedTransaction`, as the anchor makes it, with its RPC-authentication signer counted in `w.rpcSignatures`.
  w.recoveryWork = (signedTransaction) => {
    const work = ({ guardedSigner }) => {
      work.calls += 1;
      return session.transport.recoverStorageWrite({ signedTransaction, signRpc: guardedSigner(async (message) => {
        w.rpcSignatures += 1;
        return `0x${world.signer.signBytes(Buffer.from(message)).toString('hex')}`;
      }) });
    };
    work.calls = 0;
    return work;
  };
  // A CREATE the anchor would make: a request over the session's walletFactory, sent by the work; `work.calls` counts the calls.
  w.createWork = async () => {
    const wallet = session.walletFactory({ anchorJournal: session.artifactJournal });
    const request = await agreementRequest({ session: { wallet }, node: world.node });
    const work = () => { work.calls += 1; return wallet.request(request); };
    work.calls = 0;
    return work;
  };
  w.zero = () => {
    world.authorityReads = 0; world.node.reads.length = 0; signatures.length = 0; w.passes.length = 0; w.refreshes.length = 0; w.refusals.length = 0; w.rpcSignatures = 0;
    w.fenceAsked = deferred();
  };
  w.executes = () => world.node.reads.filter((read) => EXECUTE_STAGES.includes(read));
  return w;
}

// The seller's own Listing CREATE request, built as the artifact anchor builds it, for the session's next nonce.
function listingRequest(w) {
  const { world, real: session } = w, transport = session.transport, owner = session.address, writer = world.signer.claim;
  const artifact = fixtureListing(world.signer, { now: T0 }), contentHashOf = contentHash(artifact), envelopeHash = sha256Hex(canonicalize(artifact));
  const logicalAddress = listingAddress(writer, artifact.listingId, artifact.listingVersion), programName = logicalToStorageProgramName(logicalAddress), nonce = world.node.nonce + 1;
  const transaction = buildStorageProgramCreatePayload({ from: owner, storageAddress: deriveStorageAddress(owner, programName, nonce, ''), programName, logicalAddress,
    signedListing: artifact, nonce, timestamp: T0 });
  Object.assign(transaction.content, { from_ed25519_address: owner, network: transport.pins.network, chainIdentity: transport.pins.chainIdentity });
  const jobId = `listing:${artifact.listingId}`;
  Object.assign(transaction.content.data[1].metadata, { contentHash: contentHashOf, envelopeHash, artifactKind: 'Listing', networkBinding: structuredClone(transport.transportBinding),
    artifactBinding: { version: '1', policy: DEVNET_DEMO_ARTIFACT_POLICY, authority: transport.demoArtifactPublication.authority, artifactKind: 'Listing', jobId, logicalAddress, writer } });
  return { method: 'sendTransaction', params: [{ kind: DEVNET_DEMO_ARTIFACT_KIND, profile: DEVNET_AGREEMENT_PROFILE, network: transport.pins.network, owner: writer,
    artifactKind: 'Listing', jobId, logicalAddress, contentHash: contentHashOf, envelopeHash, transaction }] };
}

/**
 * Seeds a CREATE whose one resend is open: `runCreate` transmits the Listing CREATE once to a node that never applies it, and
 * the CREATE's control reads and effects are asserted. The node then also answers the recovery's numeric block-0 identity read.
 * Resolves the retained signed transaction.
 */
async function seedPendingCreate(w, runCreate) {
  const wallet = w.real.walletFactory({ anchorJournal: w.real.artifactJournal }), request = listingRequest(w);
  w.world.node.reply = pendingNode;
  w.zero();
  const answer = await runCreate(createOp(), () => wallet.request(request));
  assert.equal(answer?.success, true, JSON.stringify(answer));
  assert.deepEqual(w.passes.map(({ reads }) => reads), [1], 'seeding CREATE: one session pass, after the step-1 read');
  assert.deepEqual(w.refreshes, CREATE_PHASES.map((phase) => [phase, 1]), 'seeding CREATE: one refresh read per gated phase');
  assert.deepEqual({ signatures: w.signatures.length, executes: w.executes() }, { signatures: 1, executes: ['confirmTx', 'broadcastTx'] }, 'seeding CREATE: transmitted once');
  const chainIdentity = w.world.stages.binding.profile.chainIdentity;
  w.world.node.reply = (row) => {
    const call = row.body?.params[0];
    if (call?.message === 'getBlockByNumber' && call.data.blockNumber === 0) return rpc({ number: 0, status: 'confirmed', hash: chainIdentity }, '');
    return pendingNode(row);
  };
  const retained = (await w.real.transport.journal.entries()).find(([key, value]) => key.startsWith('devnet/native-transfer/') && value?.signedTransaction);
  return retained[1].signedTransaction;
}

// The runCreate-level recovery control: the resend runs once in one session pass with two RPC-authentication signatures, one
// confirmation and one resend: S = 1 and one refresh read at each of the recovery's two gated phases.
async function assertRecoveryControl(w, runCreate, signedTransaction) {
  const work = w.recoveryWork(signedTransaction);
  w.zero();
  const answer = await runCreate(createOp({ operationId: `demo/recovery/${signedTransaction.hash}` }), work);
  assert.equal(answer?.disposition, 'pending', JSON.stringify(answer));
  assert.equal(work.calls, 1, 'recovery control: the work ran once');
  assert.deepEqual(w.passes.map(({ reads }) => reads), [1], 'recovery control: one session pass, after the step-1 read');
  assert.deepEqual(w.refreshes, [['confirmTx', 1], ['broadcastTx', 1]], 'recovery control: one refresh read per gated phase');
  assert.deepEqual({ rpcSignatures: w.rpcSignatures, executes: w.executes() }, { rpcSignatures: 2, executes: ['confirmTx', 'broadcastTx'] }, 'recovery control: resent once');
}

// Lets pending promise callbacks and node answers run until `predicate()` holds; fails after a bounded number of turns.
async function until(predicate, label) {
  for (let turn = 0; turn < 500; turn++) { if (predicate()) return; await new Promise((resolve) => setImmediate(resolve)); }
  assert.fail(`never reached: ${label}`);
}
const turns = async (count) => { for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve)); };
// Another seller operation on the kit boundary, which holds its fence while its work runs.
const holderOp = (w) => ({ operationId: 'TEST-other-operation', lane: 'seller-wallet', kind: 'seller-create', paidWrite: false, pinVersion: w.world.stages.binding.profile.pinVersion });

// A path refused before the work: exactly `reads` authority reads, only their node messages, no signature and no transmission.
function assertRefusedBeforeWork(w, work, reads, label) {
  assert.equal(work.calls, 0, `${label}: the work was never called`);
  assert.equal(w.world.authorityReads, reads, `${label}: authority reads`);
  if (reads === 0) assert.deepEqual(w.world.node.reads, [], `${label}: no node read`);
  else assert.ok(w.world.node.reads.length > 0 && w.world.node.reads.every((read) => AUTHORITY_READS.includes(read)), `${label}: only the authority read's messages: ${w.world.node.reads}`);
  assert.deepEqual({ signatures: w.signatures.length, executes: w.executes() }, { signatures: 0, executes: [] }, `${label}: nothing signed or sent`);
}

// The runCreate-level control: the same call with nothing cut runs the work once in one session pass, which signs, confirms and
// broadcasts the CREATE once: S = 1 and one refresh read at each of sign, confirmTx and broadcastTx.
async function assertCreateControl(w, runCreate, op = createOp()) {
  const work = await w.createWork();
  w.zero();
  const answer = await runCreate(op, work);
  assert.equal(answer?.success, true, JSON.stringify(answer));
  assert.equal(work.calls, 1, 'control: the work ran once');
  assert.deepEqual(w.passes.map(({ reads }) => reads), [1], 'control: one session pass, after the step-1 read');
  assert.deepEqual(w.refreshes, CREATE_PHASES.map((phase) => [phase, 1]), 'control: one refresh read per gated phase');
  assert.deepEqual({ signatures: w.signatures.length, executes: w.executes() }, { signatures: 1, executes: ['confirmTx', 'broadcastTx'] }, 'control: signed, confirmed and broadcast once');
}

test('effectPassRemainingMs returns the kit pass\'s remaining milliseconds on the boundary\'s clock for the held capability of a live pass, 0 after the pass is released and for any other value, and never throws; createSellerCreatePass refuses a boundary createEffectBoundary did not make', async (t) => {
  const world = await walletSessionWorld(t);
  const clock = manualClock();
  const boundary = createEffectBoundary({ stopped: async () => false, binding: world.stages.binding, currentLocal: world.stages.local, feeCeilingOs: FEE_CEILING_OS,
    history: createEffectHistory({ dataDirectory: world.directory }), clock });
  const op = { operationId: 'TEST-window', lane: 'seller-wallet', kind: 'seller-create', paidWrite: false, pinVersion: world.stages.binding.profile.pinVersion };
  let kept;
  await boundary.withFence(op, (held) => {
    kept = held;
    assert.equal(effectPassRemainingMs(held), KIT_WINDOW_MS, 'the window starts when the fence is granted');
    clock.advanceTo(2_500);
    assert.equal(effectPassRemainingMs(held), KIT_WINDOW_MS - 2_500);
    clock.advanceTo(KIT_WINDOW_MS + 1);
    assert.equal(effectPassRemainingMs(held), -1, 'a window that ran out is not positive');
  });
  assert.equal(effectPassRemainingMs(kept), 0, 'a released pass has none');
  const throwing = Object.defineProperty({}, 'capability', { get() { throw new Error('TEST-getter'); } });
  for (const value of [undefined, null, {}, { ...kept, capability: Object.freeze({}) }, throwing]) assert.equal(effectPassRemainingMs(value), 0);

  const { session } = await world.finalize();
  for (const effectBoundary of [{ ...boundary }, Object.freeze({ withFence() {} }), undefined]) {
    assert.throws(() => createSellerCreatePass({ effectBoundary, session, stopped: async () => false, feeCeilingOs: FEE_CEILING_OS, clock: world.options.clock }),
      { name: 'TypeError', message: 'effectBoundary must come from createEffectBoundary' });
  }
});

test('runCreate computes the session pass deadline on the port\'s clock from the kit pass\'s remaining window after the session fence is granted: a session fence granted when that window has run out refuses effect_pass_invalid before effectPass, the work is never called and nothing is signed or sent, while with 1 ms left the pass is made and the work runs once', async (t) => {
  const w = await createWorld(t);
  // The test holds the session fence while runCreate holds the kit fence, and releases it at `releasedAt` on the kit clock.
  const releasedAt = async (at, work) => {
    const clock = manualClock();
    const runCreate = w.runCreate(w.boundary({ clock }));
    const lease = await w.real.acquireConnectionFence();
    w.zero();
    const running = settle(runCreate(createOp(), work));
    await w.fenceAsked.promise;
    clock.advanceTo(at);
    lease.release();
    return running;
  };

  const work = () => { work.calls += 1; return 'TEST-ran'; };
  work.calls = 0;
  const gone = await releasedAt(KIT_WINDOW_MS, work);
  assert.equal(gone.error?.code, 'effect_pass_invalid', String(gone.error));
  assert.equal(w.passes.length, 0, 'effectPass was never called');
  assertRefusedBeforeWork(w, work, 1, 'window gone');

  const left = await releasedAt(KIT_WINDOW_MS - 1, work);
  assert.equal(left.value, 'TEST-ran', String(left.error));
  assert.equal(work.calls, 1, 'with 1 ms left the work runs once');
  assert.deepEqual(w.passes.map(({ deadline }) => deadline), [T0 + 1], 'the session deadline is the kit window left, on the port\'s clock');

  const create = await w.createWork();
  const control = await releasedAt(4_000, create);
  assert.equal(control.value?.success, true, JSON.stringify(control));
  assert.deepEqual(w.passes.map(({ deadline, reads }) => [deadline, reads]), [[T0 + 6_000, 1]]);
  assert.deepEqual(w.refreshes, CREATE_PHASES.map((phase) => [phase, 1]));
  assert.deepEqual({ signatures: w.signatures.length, executes: w.executes() }, { signatures: 1, executes: ['confirmTx', 'broadcastTx'] });
});

test('with the guard off, runCreate refuses kit_operation_guard_off for a CREATE and for a recovery before any node read, and neither the wallet request nor recoverStorageWrite is called', async (t) => {
  const w = await createWorld(t);
  const runCreate = w.runCreate(w.effectBoundary);
  const create = await w.createWork();
  let recoveries = 0;
  const recovery = ({ guardedSigner }) => { recovery.calls += 1; return w.real.transport.recoverStorageWrite({ signedTransaction: null, signRpc: guardedSigner(async () => { recoveries += 1; }) }); };
  recovery.calls = 0;
  guard.setKitOperationGuardForTest('off');
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  for (const [label, work] of [['CREATE', create], ['recovery', recovery]]) {
    w.zero();
    await assert.rejects(runCreate(createOp(), work), { code: 'kit_operation_guard_off' }, label);
    assertRefusedBeforeWork(w, work, 0, label);
  }
  assert.equal(recoveries, 0, 'no RPC-authentication signature');
  guard.setKitOperationGuardForTest('testnet-tp1');
  await assertCreateControl(w, runCreate);
});

test('runCreate runs the kit boundary\'s pre-checks before any session pass: guard off, a stop, a stop check that throws, stalls or answers a non-boolean, a debit above the ceiling, a missing or changed approval hold, a stale binding and a malformed operation each refuse with the boundary\'s code and the work is never called', async (t) => {
  const w = await createWorld(t);
  const work = await w.createWork();
  const stall = new Promise(() => {});
  const cases = [
    ['guard off', {}, {}, 'kit_operation_guard_off', 0],
    ['a stop', { stopped: async () => true }, {}, 'seller_stopped', 0],
    ['a stop check that throws', { stopped: async () => { throw new Error('TEST-stop-check'); } }, {}, 'stop_check_failed', 0],
    ['a stop check that stalls', { stopped: () => stall }, {}, 'stop_check_timeout', 0],
    ['a stop check that answers a non-boolean', { stopped: async () => 'TEST' }, {}, 'stop_check_invalid', 0],
    ['a debit above the ceiling', {}, { debitOs: (WRITE_FEE_CEILING_OS + 1n).toString() }, 'write-fee-cap', 0],
    ['a missing approval hold', {}, { approvalRef: { revision: () => null } }, 'write-fee-cap', 0],
    ['a changed approval hold that is gone', {}, { approvalRef: { revision: () => undefined } }, 'write-fee-cap', 0],
    ['a stale binding', {}, {}, 'tp1_connection_unverified', 1],
    ['a malformed operation', {}, { operationId: '' }, 'eb_operation_invalid', 0],
  ];
  for (const [label, boundaryOptions, changes, code, reads] of cases) {
    const clock = manualClock();
    const runCreate = w.runCreate(w.boundary({ clock, ...boundaryOptions }));
    w.zero();
    if (label === 'guard off') guard.setKitOperationGuardForTest('off');
    if (label === 'a stale binding') w.world.node.reply = otherChain;
    const running = settle(runCreate(createOp(changes), work));
    if (label === 'a stop check that stalls') { await new Promise((resolve) => setImmediate(resolve)); clock.advanceTo(KIT_WINDOW_MS); }
    const { error } = await running;
    guard.setKitOperationGuardForTest('testnet-tp1');
    w.world.node.reply = null;
    assert.equal(error?.code, code, `${label}: ${error}`);
    assert.equal(w.passes.length, 0, `${label}: no session pass`);
    assertRefusedBeforeWork(w, work, reads, label);
  }
  await assertCreateControl(w, w.runCreate(w.boundary()));
});

test('runCreate keeps the kit fence across the wallet request: a connection changed without the fence while the seller lane\'s signer is awaited leaves the CREATE signed and held with zero transmissions, and a fenced replacement waits until runCreate releases', async (t) => {
  const events = [];
  let boundary, replacement;
  const w = await createWorld(t, { onSigned: () => {
    w.switchConnection();
    replacement = boundary.replaceConnection(() => { events.push('replaced'); });
  } });
  boundary = w.boundary();
  const create = await w.createWork();
  w.zero();
  const answer = await w.runCreate(boundary)(createOp(), async (pass) => { const result = await create(pass); events.push('request answered'); return result; });
  assert.equal(answer?.success, false, JSON.stringify(answer));
  assert.deepEqual(w.refusals, [['refreshAuthority', 'confirmTx', 'tp1_local_binding_changed']], 'the confirmation\'s refresh refused');
  assert.deepEqual(w.passes.map(({ reads }) => reads), [1]);
  assert.deepEqual(w.refreshes, [['sign', 1], ['confirmTx', 0]], 'the confirmation\'s refresh refused at the connection check, before its read');
  assert.deepEqual({ signatures: w.signatures.length, executes: w.executes() }, { signatures: 1, executes: [] }, 'signed and held, nothing sent');
  await replacement;
  assert.deepEqual(events, ['request answered', 'replaced'], 'the fenced replacement ran only after runCreate released the kit fence');
  const control = await createWorld(t);
  await assertCreateControl(control, control.runCreate(control.boundary()));
});

test('after a connection swap between a CREATE\'s transmission and its recovery, runCreate refuses the recovery pass with tp1_local_binding_changed before recoverStorageWrite runs, so the retained CREATE is only read back', async (t) => {
  const w = await createWorld(t);
  const runCreate = w.runCreate(w.boundary());
  const signedTransaction = await seedPendingCreate(w, runCreate);
  const recoveryOp = createOp({ operationId: `demo/recovery/${signedTransaction.hash}` });
  w.switchConnection();
  const work = w.recoveryWork(signedTransaction);
  w.zero();
  await assert.rejects(runCreate(recoveryOp, work), { code: 'tp1_local_binding_changed' });
  assertRefusedBeforeWork(w, work, 0, 'after the swap');
  assert.equal(w.rpcSignatures, 0, 'no RPC-authentication signature');
  const readback = await w.real.transport.binding({ phase: 'readback', address: w.real.address, hash: signedTransaction.hash });
  assert.equal(readback.disposition, 'pending', 'the retained CREATE is read back');
  w.switchConnection(false);
  await assertRecoveryControl(w, runCreate, signedTransaction);
});

test('runCreate refuses tp1_fence_timeout with its cause when another seller operation holds the kit fence for 10 s, still pending at 9,999 ms, and the work is never called', async (t) => {
  const w = await createWorld(t);
  const clock = manualClock(), boundary = w.boundary({ clock }), runCreate = w.runCreate(boundary);
  const held = deferred(), release = deferred();
  const holder = boundary.withFence(holderOp(w), () => { held.resolve(); return release.promise; });
  await held.promise;
  const work = await w.createWork();
  w.zero();
  let settled = false;
  const running = settle(runCreate(createOp(), work)).finally(() => { settled = true; });
  await until(() => w.world.authorityReads === 1, 'the pre-checks\' read');
  await turns(20);
  clock.advanceTo(KIT_WINDOW_MS - 1);
  await turns(20);
  assert.equal(settled, false, 'still waiting at 9,999 ms');
  clock.advanceTo(KIT_WINDOW_MS);
  const { error } = await running;
  assert.equal(error?.code, 'tp1_fence_timeout', String(error));
  assert.equal(error.cause?.name, 'TimeoutError');
  assert.equal(w.passes.length, 0, 'no session pass');
  assertRefusedBeforeWork(w, work, 1, 'fence held');
  release.resolve();
  await holder;
  await assertCreateControl(w, runCreate);
});

test('the connection changing while runCreate waits for the kit fence, while it waits for the session fence, during the session pass\'s final authority read, or before runCreate is entered refuses tp1_local_binding_changed and signs nothing', async (t) => {
  const w = await createWorld(t);
  const refusedAtSign = async (label, run, refreshes) => {
    const answer = await run();
    w.switchConnection(false);
    w.onRefreshed = null;
    assert.equal(answer?.error?.code, 'tp1_local_binding_changed', `${label}: ${JSON.stringify(answer)}`);
    assert.deepEqual(w.passes.map(({ reads }) => reads), [1], `${label}: S`);
    assert.deepEqual(w.refreshes, refreshes, `${label}: F`);
    assert.deepEqual({ signatures: w.signatures.length, executes: w.executes() }, { signatures: 0, executes: [] }, `${label}: nothing signed or sent`);
  };

  await refusedAtSign('waiting for the kit fence', async () => {
    const clock = manualClock(), boundary = w.boundary({ clock }), held = deferred(), release = deferred();
    const holder = boundary.withFence(holderOp(w), () => { held.resolve(); return release.promise; });
    await held.promise;
    const work = await w.createWork();
    w.zero();
    const running = w.runCreate(boundary)(createOp(), work);
    await until(() => w.world.authorityReads === 1, 'the pre-checks\' read');
    await turns(20);
    w.switchConnection();
    release.resolve();
    await holder;
    return running;
  }, [['sign', 0]]);

  await refusedAtSign('waiting for the session fence', async () => {
    const runCreate = w.runCreate(w.boundary()), work = await w.createWork(), lease = await w.real.acquireConnectionFence();
    w.zero();
    const running = runCreate(createOp(), work);
    await w.fenceAsked.promise;
    w.switchConnection();
    lease.release();
    return running;
  }, [['sign', 0]]);

  await refusedAtSign('during the final authority read', async () => {
    const runCreate = w.runCreate(w.boundary()), work = await w.createWork();
    w.zero();
    w.onRefreshed = (phase) => { if (phase === 'sign') w.switchConnection(); };
    return runCreate(createOp(), work);
  }, [['sign', 1]]);

  const runCreate = w.runCreate(w.boundary()), work = await w.createWork();
  w.zero();
  w.switchConnection();
  await assert.rejects(runCreate(createOp(), work), { code: 'tp1_local_binding_changed' }, 'before entry');
  w.switchConnection(false);
  assertRefusedBeforeWork(w, work, 0, 'before entry');
  await assertCreateControl(w, runCreate);
});

test('a stop raised during the session pass\'s final stop await at the broadcast withholds the broadcast with zero broadcastTx, and no transmission follows after the stop clears or after a restart that reopens the session\'s journals without a new runCreate', async (t) => {
  const w = await createWorld(t);
  // The host's stop check answers true once, at the broadcast's final stop await (its third call in the pass), then false.
  let stops = 0;
  const runCreate = w.runCreate(w.boundary(), { stopped: async () => { stops += 1; return stops === 3; } });
  const work = await w.createWork();
  w.zero();
  const answer = await runCreate(createOp(), work);
  assert.equal(answer?.success, false, JSON.stringify(answer));
  assert.deepEqual(w.refusals, [['finalStop', 'broadcastTx', 'seller_stopped']], 'the final stop await refused the broadcast');
  assert.deepEqual(w.passes.map(({ reads }) => reads), [1]);
  assert.deepEqual(w.refreshes, CREATE_PHASES.map((phase) => [phase, 1]));
  assert.deepEqual({ signatures: w.signatures.length, executes: w.executes() }, { signatures: 1, executes: ['confirmTx'] }, 'confirmed, never broadcast');
  // The transport's lane state, as observed: the lane row stays broadcast-started and its boundary history ends dispatch-unknown,
  // so the bytes are only read back from here on.
  const rows = (await w.real.transport.journal.entries()).map(([, row]) => row);
  assert.deepEqual(rows.filter((row) => row?.signedTransaction).map(({ stage }) => stage), ['broadcast-started', 'broadcast-started']);
  assert.equal(rows.findLast((row) => typeof row?.state === 'string')?.state, 'dispatch-unknown');

  await turns(50);
  assert.deepEqual({ signatures: w.signatures.length, executes: w.executes(), refreshes: w.refreshes.length }, { signatures: 1, executes: ['confirmTx'], refreshes: 3 },
    'nothing is sent once the stop clears');
  await w.world.stages.close();
  w.world.lock.release();
  const restarted = await walletSessionWorld(t, { directory: w.world.directory, options: { journalMode: 'open' } });
  await restarted.finalize();
  await turns(50);
  assert.deepEqual({ executes: restarted.executeStages(), signatures: w.signatures.length, refreshes: w.refreshes.length }, { executes: 0, signatures: 1, refreshes: 3 },
    'the restart transmits and signs nothing');
  const control = await createWorld(t);
  await assertCreateControl(control, control.runCreate(control.boundary()));
});

test('a current-authorization check from currentAuthorizationFor that starts to throw settlement_collision during the session pass\'s final authority await, and separately during its final stop await, refuses settlement_collision with zero broadcasts', async (t) => {
  const collisionCheck = () => {
    const state = { collided: false };
    state.check = currentAuthorizationFor({ held: () => { if (state.collided) throw Object.assign(new Error('TEST-second-claim'), { code: 'settlement_collision' }); return true; }, revision: null });
    return state;
  };
  for (const cut of ['final authority await', 'final stop await']) {
    const w = await createWorld(t), job = collisionCheck();
    let stops = 0;
    w.onRefresh = (phase) => { if (cut === 'final authority await' && phase === 'broadcastTx') job.collided = true; };
    const runCreate = w.runCreate(w.boundary(), { stopped: async () => { stops += 1; if (cut === 'final stop await' && stops === 3) job.collided = true; return false; } });
    const work = await w.createWork();
    w.zero();
    const answer = await runCreate(createOp({ currentAuthorization: job.check }), work);
    assert.equal(answer?.success, false, `${cut}: ${JSON.stringify(answer)}`);
    assert.deepEqual(w.refusals, [['synchronousChecks', 'broadcastTx', 'settlement_collision']], `${cut}: the last synchronous check refused with the hold's own code`);
    assert.deepEqual(w.passes.map(({ reads }) => reads), [1], `${cut}: S`);
    assert.deepEqual(w.refreshes, CREATE_PHASES.map((phase) => [phase, 1]), `${cut}: F`);
    assert.deepEqual({ signatures: w.signatures.length, executes: w.executes() }, { signatures: 1, executes: ['confirmTx'] }, `${cut}: zero broadcasts`);
  }
  const control = await createWorld(t);
  await assertCreateControl(control, control.runCreate(control.boundary()), createOp({ currentAuthorization: collisionCheck().check }));
});

test('runCreate with no current-authorization check, or with one that returns false or a promise, refuses before anything is signed', async (t) => {
  const w = await createWorld(t);
  const runCreate = w.runCreate(w.boundary());
  for (const [label, currentAuthorization, code] of [['no check', undefined, 'context_authorization_required'], ['false', () => false, 'context_authorization_refused'],
    ['a promise', () => Promise.resolve(true), 'context_authorization_refused']]) {
    const work = await w.createWork();
    w.zero();
    const answer = await runCreate(createOp({ currentAuthorization }), work);
    assert.equal(answer?.error?.code, code, `${label}: ${JSON.stringify(answer)}`);
    assert.deepEqual(w.passes.map(({ reads }) => reads), [1], `${label}: S`);
    assert.deepEqual(w.refreshes, [['sign', 1]], `${label}: F`);
    assert.deepEqual({ signatures: w.signatures.length, executes: w.executes() }, { signatures: 0, executes: [] }, `${label}: nothing signed or sent`);
  }
  await assertCreateControl(w, runCreate);
});

test('a session lease released or a port closed during the pass, an approval hold whose revision changed, a K1 revision that moved and a currentAuthorizationFor revision that changed or expired each refuse before signing, with zero signatures and transmissions', async (t) => {
  // The port closed during the pass gets its own world: its close fails journal-busy while the request holds the wallet lane (after
  // it has closed the owner), and the world's cleanup meets that same failure.
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch((error) => assert.equal(error?.code, 'journal-busy')); });
  const closing = await createWorld({ mock: t.mock, after: (cleanup) => cleanups.push(cleanup) });
  const w = await createWorld(t);
  const state = { approval: 1, k1: 1, revision: 'TEST-revision-1', change: null };
  // Each change is made at the sign phase's final stop await, the host's first stop check in the pass.
  const stopped = async () => { const change = state.change; state.change = null; await change?.(); return false; };
  const op = () => createOp({ approvalRef: { revision: () => state.approval }, k1Rev: { expected: 1, current: () => state.k1 },
    currentAuthorization: currentAuthorizationFor({ held: () => true, revision: { expected: 'TEST-revision-1', current: () => state.revision } }) });
  const cases = [
    [w, 'a session lease released', () => w.passes.at(-1).fence.release(), 'effect_pass_invalid'],
    [w, 'an approval hold whose revision changed', () => { state.approval = 2; }, 'write-fee-cap'],
    [w, 'a K1 revision that moved', () => { state.k1 = 2; }, 'context_admission_closed'],
    [w, 'a currentAuthorizationFor revision that changed', () => { state.revision = 'TEST-revision-2'; }, 'job_revision_changed'],
    [w, 'a currentAuthorizationFor revision that expired', () => { state.revision = null; }, 'job_revision_expired'],
    [closing, 'a port closed', () => closing.world.port.close().catch(() => {}), 'transport_closed'],
  ];
  for (const [world, label, change, code] of cases) {
    Object.assign(state, { approval: 1, k1: 1, revision: 'TEST-revision-1', change });
    await refusedBeforeSigning(world, label, code);
  }
  async function refusedBeforeSigning(w, label, code) {
    const runCreate = w.runCreate(w.boundary(), { stopped });
    const work = await w.createWork();
    w.zero();
    const answer = await settle(runCreate(op(), work));
    assert.equal(answer.value?.error?.code ?? answer.error?.code, code, `${label}: ${JSON.stringify(answer.value ?? String(answer.error))}`);
    assert.deepEqual(w.passes.map(({ reads }) => reads), [1], `${label}: S`);
    assert.deepEqual(w.refreshes, [['sign', 1]], `${label}: F`);
    assert.deepEqual({ signatures: w.signatures.length, executes: w.executes() }, { signatures: 0, executes: [] }, `${label}: nothing signed or sent`);
  }
  const control = await createWorld(t);
  await assertCreateControl(control, control.runCreate(control.boundary()), createOp({ approvalRef: { revision: () => 1 }, k1Rev: { expected: 1, current: () => 1 },
    currentAuthorization: currentAuthorizationFor({ held: () => true, revision: { expected: 'TEST-revision-1', current: () => 'TEST-revision-1' } }) }));
});

// The three identity records no binding may be made from, as bindTp1Profile's options.
const refusedRecords = (sellerClaim) => [
  ['a mainnet-labelled record', { record: { ...TP1_APPROVED_IDENTITY_RECORD, network: 'demos-mainnet' } }, 'tp1_identity_record_invalid'],
  ['a self-approved record', { record: { ...TP1_APPROVED_IDENTITY_RECORD, recordId: 'dacs-demos-testnet-identity/TEST-self-approved',
    provenance: { ...TP1_APPROVED_IDENTITY_RECORD.provenance, approvedBy: sellerClaim } } }, 'tp1_identity_unapproved'],
  ['an approved-but-refused record', { record: TP1_APPROVED_IDENTITY_RECORD, refusedChainIdentities: [TP1_APPROVED_IDENTITY_RECORD.chainIdentity] }, 'tp1_identity_refused'],
];
// A copy of the stages' real binding that carries `record`'s digest: bindTp1Profile never made it.
const forgedBinding = (binding, record) => ({ ...structuredClone(binding), recordDigest: sha256Hex(canonicalize(record)) });
const boundaryOver = (world, binding) => createEffectBoundary({ stopped: async () => false, binding, currentLocal: world.stages.local, feeCeilingOs: FEE_CEILING_OS,
  history: createEffectHistory({ dataDirectory: world.directory }), clock: manualClock() });

test('bindTp1Profile refuses a mainnet-labelled record with tp1_identity_record_invalid, a self-approved record with tp1_identity_unapproved and an approved record whose chain identity is refused with tp1_identity_refused, each before its authority reader is called, so no binding exists', async (t) => {
  const world = await walletSessionWorld(t);
  const calls = world.node.calls.length;
  for (const [label, options, code] of refusedRecords(world.signer.claim)) {
    let reads = 0;
    await assert.rejects(bindTp1Profile({ ...options, local: world.stages.local(), readAuthority: async () => { reads += 1; return {}; } }), { code }, label);
    assert.equal(reads, 0, `${label}: the authority reader was not called`);
  }
  assert.equal(world.node.calls.length - calls, 0, 'no node call');
});

test('the production port\'s finalize refuses a binding forged from each of the mainnet-labelled, self-approved and approved-but-refused records with tp1_binding_required before the key is loaded, with zero signatures and transmissions', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  for (const [label, { record }] of refusedRecords('did:demos:agent:TEST')) {
    const world = await walletSessionWorld(t, { countAuthority: true });
    const binding = forgedBinding(world.stages.binding, record), calls = world.node.calls.length;
    world.authorityReads = 0;
    await assert.rejects(world.port.finalize({ binding, effectBoundary: boundaryOver(world, binding), stopped: async () => false, feeCeilingOs: FEE_CEILING_OS,
      stateLock: world.lock, dataDirectory: world.directory }), { code: 'tp1_binding_required' }, label);
    assert.deepEqual({ reads: world.authorityReads, nodeCalls: world.node.calls.length - calls, keyLoads: world.keyLoads, journals: world.issuanceJournals(), signatures: signatures.length },
      { reads: 0, nodeCalls: 0, keyLoads: 0, journals: [], signatures: 0 }, label);
  }
});

test('a kit boundary built over a binding forged from each of the mainnet-labelled, self-approved and approved-but-refused records makes runCreate refuse tp1_binding_required for a CREATE and a recovery with zero signatures and transmissions', async (t) => {
  const w = await createWorld(t);
  const create = await w.createWork(), recovery = w.recoveryWork(null);
  for (const [label, { record }] of refusedRecords(w.world.signer.claim)) {
    const runCreate = w.runCreate(boundaryOver(w.world, forgedBinding(w.world.stages.binding, record)));
    for (const [kind, work] of [['CREATE', create], ['recovery', recovery]]) {
      w.zero();
      await assert.rejects(runCreate(createOp(), work), { code: 'tp1_binding_required' }, `${label}, ${kind}`);
      assertRefusedBeforeWork(w, work, 0, `${label}, ${kind}`);
      assert.equal(w.rpcSignatures, 0);
    }
  }
  const runCreate = w.runCreate(w.effectBoundary);
  await assertRecoveryControl(w, runCreate, await seedPendingCreate(w, runCreate));
});

test('inside runCreate\'s recovery pass the RPC-authentication signature shares the kit fence and runs the boundary\'s fresh tail first: a stop or a lost approval hold just before it refuses with zero RPC-authentication signatures and zero recovery-dispatch stages, and another operation\'s withFence started during the pass waits until runCreate releases', async (t) => {
  const w = await createWorld(t);
  let stop = false, approval = 1;
  const boundary = w.boundary({ stopped: async () => stop }), runCreate = w.runCreate(boundary);
  const signedTransaction = await seedPendingCreate(w, runCreate);
  const seeded = w.world.node.reply;
  // The recovery's nonce read is the last node call before its first RPC-authentication signature.
  const beforeSignature = (cut) => { w.world.node.reply = (row) => { if (row.body?.params[0]?.message === 'getAddressNonce') cut(); return seeded(row); }; };
  const recoveryOp = createOp({ operationId: `demo/recovery/${signedTransaction.hash}`, approvalRef: { revision: () => approval } });
  const refusedBeforeSignature = (label, answer, work) => {
    assert.equal(answer?.disposition, 'pending', `${label}: ${JSON.stringify(answer)}`);
    assert.equal(work.calls, 1, `${label}: the recovery ran`);
    assert.deepEqual(w.passes.map(({ reads }) => reads), [1], `${label}: S`);
    assert.deepEqual(w.refreshes, [], `${label}: the refusal came before the first gated phase`);
    assert.deepEqual({ rpcSignatures: w.rpcSignatures, executes: w.executes() }, { rpcSignatures: 0, executes: [] }, `${label}: nothing signed or sent`);
  };

  beforeSignature(() => { stop = true; });
  let work = w.recoveryWork(signedTransaction);
  w.zero();
  refusedBeforeSignature('a stop', await runCreate(recoveryOp, work), work);
  stop = false;

  const events = [];
  let other;
  beforeSignature(() => { approval = null; other ??= boundary.withFence(holderOp(w), () => { events.push('other operation ran'); }); });
  work = w.recoveryWork(signedTransaction);
  w.zero();
  const answer = await runCreate(recoveryOp, async (pass) => { const result = await work(pass); events.push('recovery answered'); return result; });
  refusedBeforeSignature('a lost approval hold', answer, work);
  await other;
  assert.deepEqual(events, ['recovery answered', 'other operation ran'], 'the other operation waited for runCreate to release the kit fence');

  approval = 1;
  w.world.node.reply = seeded;
  await assertRecoveryControl(w, runCreate, signedTransaction);
});
