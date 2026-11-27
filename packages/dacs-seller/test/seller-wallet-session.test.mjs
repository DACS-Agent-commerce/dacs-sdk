// The seller's production wallet-session port: stage one binds the host through the client's connection reader, finalize
// checks the host's boundary and binding before the key is loaded, builds the seller Node wallet under the state lock, zero-fills
// the key bytes on every outcome, and binds the one artifact anchor handle the operator gives the host.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { SELLER_FULFILMENT_VET_MODES } from '@kynesyslabs/dacs';
import { agreementRequest } from '../../dacs-client/test/helpers/tp1-node-fixture.mjs';
import { ARTIFACT_JOURNAL, COMPOSITION_JOURNAL, T0, api, evidenceInput, finalization, jsonResponse, keyRecordBytes, ok, privateDataDirectory, replayNode, replyTo,
  sellerPublications, setPurchaseAdmission, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';
import { allZero, createSellerWalletSession, portOptions, walletSessionWorld } from './helpers/seller-wallet-session-world.mjs';
import { heldOperator, manualSellerApproval, PAYMENT_EVIDENCE_JOURNAL } from './helpers/payment-evidence-test-journals.mjs';

const guard = await import('../src/kit-operation-guard.mjs');
const { createEffectBoundary, effectBoundaryBinding } = await import('../src/dacs/effect-boundary.mjs');
const { createEffectHistory } = await import('../src/dacs/effect-history.mjs');
const { isBoundedCallTimeout } = await import('../src/dacs/bounded-call.mjs');
const { acquireSellerStateLock } = await import('../src/devnet-demo/seller-state-lock.mjs');
const { fixtureListing } = await import('./fixtures/listings.mjs');
const { contextHostFixture } = await import('./helpers/host-context-client.mjs');
const { anchorOptions, importSpiedWalletSession } = await import('./helpers/artifact-anchor-spy.mjs');
const { isSellerCreatePass } = await import('../src/devnet-demo/create-pass.mjs');
const CRASH_CHILD = new URL('./helpers/seller-wallet-session-crash-child.mjs', import.meta.url);
const { default: Database } = await import('better-sqlite3');

const PORT_MEMBERS = ['authority', 'connectionAuthority', 'sessionAdmission', 'readCommitmentReceipt', 'observePayment', 'artifactAnchor', 'runCreate', 'finalize', 'close'];
const SESSION_MEMBERS = ['effectPass', 'runInEffectPass', 'walletFactory', 'transport', 'acquireConnectionFence', 'address', 'observer', 'artifactJournal',
  'paymentEvidence', 'nativePaymentEvidence', 'endApprovalWaits', 'readBalance', 'close'];
const ANCHOR_METHODS = ['publish', 'read', 'readRetained', 'retainedSignedCreate', 'hasIntent', 'verifyReceipt'];
const PASS_WINDOW_MS = 10_000;
const AUTHORITY_DEADLINE_MS = 10_000;
const JOB_ID = '01M5YKPJG0248H248H248H248H';
const OTHER_CHAIN = 'd'.repeat(64);
const SECOND_MNEMONIC = entropyToMnemonic(new Uint8Array(32).fill(4), wordlist);
const BOUNDARY_CLOCK = Object.freeze({ now: () => 0, after: () => () => {} });
// The only node reads the stage-one capability sends: the binding check's.
const AUTHORITY_READS = Object.freeze(['getBlockByNumber', 'getNetworkInfo']);

const refusalOf = (promise) => promise.then(() => assert.fail('expected a refusal'), (error) => error);
// The node answers each block read as another chain's node.
const otherChain = (row) => (row.body?.params[0].message === 'getBlockByNumber'
  ? jsonResponse(ok({ number: row.body.params[0].data.blockNumber, status: 'confirmed', hash: OTHER_CHAIN, content: { previousHash: OTHER_CHAIN } })) : undefined);
const flush = async () => { for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve)); };
const staticsOf = ({ source, authority, writer, vetMode }) => ({ source, authority, writer, vetMode });
const jobCreate = () => api.passContext({ operationClass: 'job-create', currentAuthorization: () => true });
// The error code of a failed wallet answer envelope, or null for any other answer.
const refusalCode = (answer) => (answer?.success === false ? answer.error?.code : null);

// A pass of `session` over `fence`, opened as the host's effect boundary opens one.
const passOver = (session, fence) => session.effectPass({ fence, deadline: T0 + PASS_WINDOW_MS, refreshAuthority() {}, finalStop() {}, synchronousChecks: [],
  feeCeilingOs: finalization.feeCeilingOs, context: jobCreate() });

// Sends `request` through `wallet` in one pass of `session` on a fence the session leased.
async function inSessionPass(session, wallet, request) {
  const lease = await session.acquireConnectionFence();
  try { return await session.runInEffectPass(passOver(session, lease), () => wallet.request(request)); } finally { lease.release(); }
}

// A kit effect boundary over `binding`, with its history in `directory`.
const boundaryOver = (binding, directory) => createEffectBoundary({ stopped: () => false, binding, currentLocal: () => binding.local, feeCeilingOs: finalization.feeCeilingOs,
  history: createEffectHistory({ dataDirectory: directory }), clock: BOUNDARY_CLOCK });

// The input the host's stages give the port's finalize, for `world`, with `changes`.
const finalizeInput = (world, changes = {}) => ({ binding: world.stages.binding, stopped: () => false, feeCeilingOs: finalization.feeCeilingOs, stateLock: world.lock,
  dataDirectory: world.directory, ...changes });

// A fresh port over `directory` finalizes once the first world's lock is released: the journals a refused finalize opened were closed.
async function reopens(t, world, overrides = {}) {
  world.lock.release();
  const journalMode = world.issuanceJournals().length > 0 ? 'open' : 'create';
  const fresh = await walletSessionWorld(t, { directory: world.directory, options: { journalMode, ...overrides } });
  const { session } = await fresh.finalize();
  assert.equal(typeof session.close, 'function', `a fresh port finalizes in ${journalMode} mode`);
  return journalMode;
}

test('the production wallet-session port binds through the host\'s stages and, finalized under the state lock with the host\'s boundary and binding, exposes effectPass, runInEffectPass, walletFactory, transport.recoverStorageWrite and the owner\'s acquireConnectionFence; a CREATE in a pass on that fence is confirmed and broadcast once, and the same CREATE outside a pass signs and sends nothing', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await walletSessionWorld(t);
  assert.ok(world.node.reads.length > 0, 'the host\'s reader bound through the port\'s connection reader before finalize');
  assert.deepEqual({ journals: world.issuanceJournals(), keyLoads: world.keyLoads }, { journals: [], keyLoads: 0 }, 'nothing is opened and no key is loaded before finalize');
  const { effectBoundary, session } = await world.finalize();
  assert.equal(effectBoundaryBinding(effectBoundary), world.stages.binding, 'the host\'s one boundary is over the stages\' binding');
  assert.deepEqual(world.issuanceJournals(), [COMPOSITION_JOURNAL, ARTIFACT_JOURNAL], 'finalize built the wallet under the lock');
  assert.deepEqual(Object.keys(session).sort(), [...SESSION_MEMBERS].sort());
  assert.ok(Object.isFrozen(session));
  assert.equal(api.isDevnetDemoTransport(session.transport), true);
  assert.equal(typeof session.transport.recoverStorageWrite, 'function');
  assert.equal(world.returnedKeys.length, 1, 'the key was loaded once');
  assert.ok(world.returnedKeys.every(allZero), 'every key array the loader returned is zero-filled');

  const wallet = session.walletFactory({ anchorJournal: session.artifactJournal });
  const request = await agreementRequest({ session: { wallet }, node: world.node });
  assert.equal(refusalCode(await wallet.request(request)), 'effect_pass_required', 'outside a pass the CREATE is refused');
  assert.deepEqual({ stages: world.executeStages(), signatures: signatures.length }, { stages: 0, signatures: 0 }, 'outside a pass nothing is signed or sent');

  const answer = await inSessionPass(session, wallet, request);
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.deepEqual(world.node.reads.filter((read) => read === 'confirmTx' || read === 'broadcastTx'), ['confirmTx', 'broadcastTx'], 'confirmed and broadcast once');
  assert.equal(signatures.length, 1, 'signed once');
  assert.equal(world.options.approve.confirmed.length, 1, 'the operator\'s approval passed through: the confirmed-write policy ran once');
});

test('before finalization the port can neither sign, send nor anchor: every artifactAnchor method and authority.claim refuse wallet_session_not_finalized with zero node reads and no issuance journal; after close they and finalize refuse wallet_session_closed', async (t) => {
  const world = await walletSessionWorld(t);
  const { port } = world;
  assert.deepEqual(Object.keys(port), PORT_MEMBERS);
  assert.deepEqual(Object.keys(port.authority).filter((name) => /sign|send|broadcast/i.test(name)), [], 'the stage-one capability can neither sign nor send');
  const reads = world.node.calls.length;
  for (const name of ANCHOR_METHODS) await assert.rejects(port.artifactAnchor[name]({}), { code: 'wallet_session_not_finalized' }, name);
  assert.throws(() => port.authority.claim(), { code: 'wallet_session_not_finalized' });
  assert.deepEqual({ reads: world.node.calls.length - reads, journals: world.issuanceJournals() }, { reads: 0, journals: [] });

  await world.stages.close();
  for (const name of ANCHOR_METHODS) await assert.rejects(port.artifactAnchor[name]({}), { code: 'wallet_session_closed' }, name);
  assert.throws(() => port.authority.claim(), { code: 'wallet_session_closed' });
  await assert.rejects(port.finalize(finalizeInput(world, { effectBoundary: boundaryOver(world.stages.binding, world.directory) })), { code: 'wallet_session_closed' });
  assert.deepEqual({ reads: world.node.calls.length - reads, keyLoads: world.keyLoads, journals: world.issuanceJournals() }, { reads: 0, keyLoads: 0, journals: [] });
});

test('the port\'s runCreate refuses wallet_session_not_finalized before finalize and wallet_session_closed after close, before any read, and after finalize runs in the same pass builder the anchor uses', async (t) => {
  const { createSellerWalletSession: createSpiedPort } = await importSpiedWalletSession();
  const world = await walletSessionWorld(t, { createPort: createSpiedPort });
  const { port } = world;
  assert.equal(isSellerCreatePass(port.runCreate), true, 'the port\'s runCreate is one the kit issued');
  const op = { operationId: 'TEST-port-pass', lane: 'TEST-port-pass', operationClass: 'job-create', currentAuthorization: () => true };
  let worked = 0;
  const reads = world.node.calls.length;
  await assert.rejects(port.runCreate(op, () => { worked += 1; }), { code: 'wallet_session_not_finalized' });
  assert.deepEqual({ worked, reads: world.node.calls.length - reads, keyLoads: world.keyLoads }, { worked: 0, reads: 0, keyLoads: 0 }, 'refused before any read');

  const composed = anchorOptions.length;
  await world.finalize();
  const anchorRunCreate = anchorOptions[composed].runCreate;
  assert.equal(isSellerCreatePass(anchorRunCreate), true, 'the anchor got an issued runCreate');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const order = [];
  const first = port.runCreate(op, async (members) => { order.push(['port', Object.keys(members).sort()]); await held; return 'TEST-port-answer'; });
  for (let turn = 0; turn < 50 && order.length === 0; turn++) await new Promise((resolve) => setImmediate(resolve));
  const second = anchorRunCreate({ ...op, operationId: 'TEST-anchor-pass', lane: 'TEST-anchor-pass' }, async () => { order.push(['anchor']); return 'TEST-anchor-answer'; });
  await flush();
  assert.deepEqual(order, [['port', ['guardedSigner', 'signPass']]], 'the anchor\'s pass waits on the fence the port\'s pass holds: one boundary and one pass builder');
  release();
  assert.deepEqual([await first, await second], ['TEST-port-answer', 'TEST-anchor-answer']);
  assert.deepEqual(order.at(-1), ['anchor']);

  await world.stages.close();
  await assert.rejects(port.runCreate(op, () => { worked += 1; }), { code: 'wallet_session_closed' });
  assert.equal(worked, 0, 'a closed port runs no work');
});

test('finalize refuses an effect boundary that is not the kit\'s or was built over another binding with wallet_session_boundary_mismatch, a binding bindTp1Profile did not make with tp1_binding_required and another connection\'s binding with tp1_local_binding_changed, each before the key is loaded or a journal opens; a second finalize refuses wallet_session_finalize_once', async (t) => {
  const other = await walletSessionWorld(t);
  const cases = [
    ['a boundary that is not the kit\'s', () => ({ effectBoundary: Object.freeze({}) }), 'wallet_session_boundary_mismatch'],
    ['a kit boundary over another binding', (world) => ({ effectBoundary: boundaryOver(other.stages.binding, world.directory) }), 'wallet_session_boundary_mismatch'],
    ['a copy of the binding', (world) => { const forged = structuredClone(world.stages.binding); return { binding: forged, effectBoundary: boundaryOver(forged, world.directory) }; }, 'tp1_binding_required'],
    ['another connection\'s binding', (world) => ({ binding: other.stages.binding, effectBoundary: boundaryOver(other.stages.binding, world.directory) }), 'tp1_local_binding_changed'],
  ];
  for (const [label, changes, code] of cases) {
    const world = await walletSessionWorld(t);
    const reads = world.node.calls.length;
    await assert.rejects(world.port.finalize(finalizeInput(world, changes(world))), { code }, label);
    assert.deepEqual({ keyLoads: world.keyLoads, journals: world.issuanceJournals(), stages: world.executeStages(), reads: world.node.calls.length - reads },
      { keyLoads: 0, journals: [], stages: 0, reads: 0 }, `${label}: refused before any read, key load or journal`);
    await assert.rejects(world.port.finalize(finalizeInput(world, { effectBoundary: boundaryOver(world.stages.binding, world.directory) })), { code: 'wallet_session_finalize_once' },
      `${label}: the first outcome stands`);
  }
  assert.equal(effectBoundaryBinding(boundaryOver(other.stages.binding, other.directory)), other.stages.binding);
  for (const value of [undefined, null, {}, Object.freeze({ withFence() {} })]) assert.equal(effectBoundaryBinding(value), undefined);

  const world = await walletSessionWorld(t);
  await world.finalize();
  await assert.rejects(world.port.finalize(finalizeInput(world, { effectBoundary: boundaryOver(world.stages.binding, world.directory) })), { code: 'wallet_session_finalize_once' },
    'a finalized port refuses a second finalize');
  assert.equal(world.keyLoads, 1);
});

test('the finalized session\'s pass needs a live fence from its own owner: a released lease, another port\'s lease and a copied lease refuse effect_pass_invalid, a request outside any pass refuses effect_pass_required, each with zero signatures and transmissions, and once the session closes acquireConnectionFence refuses wallet_session_closed', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await walletSessionWorld(t), other = await walletSessionWorld(t);
  const { session } = await world.finalize(), { session: otherSession } = await other.finalize();
  const released = await session.acquireConnectionFence();
  released.release();
  assert.throws(() => passOver(session, released), { code: 'effect_pass_invalid' }, 'a released lease');
  const foreign = await otherSession.acquireConnectionFence();
  assert.throws(() => passOver(session, foreign), { code: 'effect_pass_invalid' }, 'another port\'s lease');
  foreign.release();
  const live = await session.acquireConnectionFence();
  assert.throws(() => passOver(session, { ...live }), { code: 'effect_pass_invalid' }, 'a copy of a live lease');
  live.release();

  const wallet = session.walletFactory({ anchorJournal: session.artifactJournal });
  const request = await agreementRequest({ session: { wallet }, node: world.node });
  assert.equal(refusalCode(await wallet.request(request)), 'effect_pass_required', 'a request outside any pass');
  assert.deepEqual({ stages: world.executeStages(), signatures: signatures.length }, { stages: 0, signatures: 0 }, 'no refusal signed or sent');

  const answer = await inSessionPass(session, wallet, request);
  assert.equal(answer.success, true, `a lease from the session's own fence is accepted: ${JSON.stringify(answer)}`);
  assert.deepEqual({ stages: world.executeStages(), signatures: signatures.length }, { stages: 2, signatures: 1 });

  await session.close();
  await assert.rejects(session.acquireConnectionFence(), { code: 'wallet_session_closed' });
  await assert.rejects(world.port.artifactAnchor.hasIntent('dacs1:listing:TEST'), { code: 'wallet_session_closed' }, 'the handle closes with the session');
});

test('after finalization the port\'s artifactAnchor is the anchor composed over the finalized session: its writer, authority, source and Vet mode are unchanged from before finalization and match the session\'s address and declared publication; a Listing publish whose signing check is not a function refuses not-authorized and one with a signing check or without refuses deployment_unqualified, and a job\'s retained read with the default buyer access refuses buyer_access_closed, each before any artifact read, storing no intent and signing and sending nothing', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await walletSessionWorld(t);
  const anchor = world.port.artifactAnchor;
  const before = staticsOf(anchor);
  assert.deepEqual(before, { source: 'dacs-devnet-demo-native-artifacts/v1', authority: sellerPublications().demoArtifactPublication.authority, writer: world.signer.claim,
    vetMode: SELLER_FULFILMENT_VET_MODES.tp1G3Orchestrator });
  const { session } = await world.finalize();
  assert.ok(Object.isFrozen(anchor));
  assert.deepEqual(staticsOf(anchor), before, 'the static members are fixed at stage one');
  assert.equal(anchor.writer, `did:demos:agent:${session.address.slice(2)}`, 'the writer is the session\'s address');
  assert.equal(anchor.authority, session.transport.demoArtifactPublication.authority, 'the authority is the declared publication\'s');

  const listing = fixtureListing(world.signer, { now: T0 });
  const input = { logicalAddress: 'dacs1:listing:fixture-report:1', artifact: listing, artifactKind: 'Listing', operationClass: 'job-create', currentAuthorization: () => true };
  const reads = world.node.calls.length;
  await assert.rejects(anchor.publish({ ...input, authorizeSigning: true }), { code: 'not-authorized' });
  await assert.rejects(anchor.publish({ ...input, authorizeSigning: () => true }), { code: 'deployment_unqualified' });
  await assert.rejects(anchor.publish(input), { code: 'deployment_unqualified' });
  await assert.rejects(anchor.readRetained({ logicalAddress: `dacs4:deliverable:${JOB_ID}`, artifactKind: 'Deliverable' }), { code: 'buyer_access_closed' });
  assert.equal(await anchor.hasIntent(input.logicalAddress), false, 'no intent was stored');
  assert.deepEqual(world.node.calls.slice(reads).map((call) => call.body.params[0].message), ['getBlockByNumber', 'getBlockByNumber']);
  assert.deepEqual({ stages: world.executeStages(), signatures: signatures.length }, { stages: 0, signatures: 0 });
});

test('after loadKeyRecord returns, finalize zero-fills the key bytes itself on every path: a close during the key load, a close during the wallet build, a value that is not a Uint8Array, malformed key bytes, a refused state lock and a key loader that throws each leave no live journal and no live anchor, and every array the loader returned is all zeros', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  // Every refusal leaves the key bytes zeroed, nothing signed or sent, and the handle closed once the stages closed the port.
  // A refusal before the wallet build also asked the node nothing but the binding check's authority reads.
  const readsOnlyTheBinding = (world, label) => assert.deepEqual(world.node.reads.filter((read) => !AUTHORITY_READS.includes(read)), [], `${label}: no node call but the binding read`);
  const leavesNothingLive = async (world, label) => {
    assert.ok(world.returnedKeys.every(allZero), `${label}: every byte array the loader returned is zeros`);
    assert.deepEqual({ stages: world.executeStages(), signatures: signatures.length }, { stages: 0, signatures: 0 }, `${label}: nothing signed or sent`);
    await assert.rejects(world.port.artifactAnchor.read({}), { code: 'wallet_session_closed' }, `${label}: the handle is closed`);
  };

  const loading = await walletSessionWorld(t, { gateKeyLoad: true });
  const pending = refusalOf(loading.finalize());
  await loading.keyLoadStarted;
  await loading.port.close();
  loading.releaseKeyLoad();
  assert.equal((await pending).code, 'wallet_session_closed', 'a close during the key load');
  assert.deepEqual(loading.issuanceJournals(), [], 'the wallet was never built');
  readsOnlyTheBinding(loading, 'close during the load');
  await leavesNothingLive(loading, 'close during the load');

  const building = await walletSessionWorld(t, { closeInsideWalletBuild: true });
  const closedInBuild = await refusalOf(building.finalize());
  assert.equal(closedInBuild.code, 'wallet_session_closed', 'a close during the wallet build');
  if (closedInBuild.cause !== undefined) assert.ok(closedInBuild.cause instanceof Error, 'the wallet build\'s own refusal is kept as the cause');
  await leavesNothingLive(building, 'close during the build');
  await reopens(t, building);

  for (const [label, keyBytes] of [['an ArrayBuffer', () => keyRecordBytes().buffer], ['a string', () => 'TEST-not-key-bytes']]) {
    const world = await walletSessionWorld(t, { keyBytes });
    await assert.rejects(world.finalize(), { name: 'SellerKeyError', code: 'seller_key_format_invalid' }, label);
    assert.deepEqual(world.issuanceJournals(), [], `${label}: the wallet was never built`);
    readsOnlyTheBinding(world, label);
    await leavesNothingLive(world, label);
  }

  const malformed = await walletSessionWorld(t, { keyBytes: () => new TextEncoder().encode('{"format":"other"}') });
  await assert.rejects(malformed.finalize(), { code: 'seller_key_format_invalid' }, 'malformed key bytes');
  await leavesNothingLive(malformed, 'malformed bytes');
  assert.equal(await reopens(t, malformed), 'open', 'the journals the wallet build opened were closed and reopen');

  const unlocked = await walletSessionWorld(t);
  unlocked.lock.release();
  await assert.rejects(unlocked.finalize(), { code: 'state_ownership_required' }, 'a released lock');
  assert.deepEqual(unlocked.issuanceJournals(), []);
  readsOnlyTheBinding(unlocked, 'released lock');
  await leavesNothingLive(unlocked, 'released lock');

  const loaderError = new Error('TEST-key-loader-failed');
  const throwing = await walletSessionWorld(t, { keyBytes: () => { throw loaderError; } });
  assert.equal(await refusalOf(throwing.finalize()), loaderError, 'the loader\'s own error');
  assert.deepEqual({ returned: throwing.returnedKeys.length, journals: throwing.issuanceJournals() }, { returned: 0, journals: [] });
  readsOnlyTheBinding(throwing, 'throwing loader');
  await leavesNothingLive(throwing, 'throwing loader');
});

test('with the guard off, createSellerWalletSession and a constructed port\'s finalize refuse kit_operation_guard_off before any read, key load or file', async (t) => {
  const node = replayNode();
  let keyLoads = 0;
  const options = await portOptions(node, async () => { keyLoads += 1; return keyRecordBytes(); });
  guard.setKitOperationGuardForTest('off');
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  assert.throws(() => createSellerWalletSession(options), { name: 'KitOperationGuardError', code: 'kit_operation_guard_off', entry: 'createSellerWalletSession' });
  assert.deepEqual({ calls: node.calls.length, keyLoads }, { calls: 0, keyLoads: 0 });

  guard.setKitOperationGuardForTest('testnet-tp1');
  const world = await walletSessionWorld(t);
  const input = finalizeInput(world, { effectBoundary: boundaryOver(world.stages.binding, world.directory) });
  const entries = readdirSync(world.directory).sort(), reads = world.node.calls.length;
  guard.setKitOperationGuardForTest('off');
  await assert.rejects(world.port.finalize(input), { name: 'KitOperationGuardError', code: 'kit_operation_guard_off', entry: 'sellerWalletSession.finalize' });
  assert.deepEqual({ reads: world.node.calls.length - reads, keyLoads: world.keyLoads, entries: readdirSync(world.directory).sort() }, { reads: 0, keyLoads: 0, entries });
});

test('startSellerHost refuses a production port given with an artifactAnchor that is not the port\'s own with a TypeError before any node read, lock or file, and leaves the port unfinalized', async (t) => {
  const f = await contextHostFixture(t);
  const node = replayNode();
  let keyLoads = 0;
  const port = createSellerWalletSession(await portOptions(node, async () => { keyLoads += 1; return keyRecordBytes(); }));
  t.after(() => port.close());
  await assert.rejects(f.start({ walletSession: port }), (error) => error instanceof TypeError && /artifactAnchor must be walletSession\.artifactAnchor/.test(error.message));
  assert.deepEqual({ calls: node.calls.length, keyLoads, entries: readdirSync(f.dataDirectory) }, { calls: 0, keyLoads: 0, entries: [] });
  await assert.rejects(port.artifactAnchor.read({}), { code: 'wallet_session_not_finalized' }, 'the port was not finalized');
});

test('startSellerHost finalizes the production port under the state lock and hands the agent the port\'s anchor: a Listing seller other than the port\'s key refuses startup at the agent\'s writer check, after which the session, the port and the lock are closed and the anchor refuses wallet_session_closed', async (t) => {
  const f = await contextHostFixture(t);
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const node = replayNode();
  const port = createSellerWalletSession(await portOptions(node, async () => keyRecordBytes()));
  assert.notEqual(f.config.listing.seller.identity.presentedBy, port.artifactAnchor.writer, 'the fixture Listing\'s seller is not the port\'s key');
  const refused = await refusalOf(f.start({ walletSession: port, artifactAnchor: port.artifactAnchor }));
  assert.ok(refused instanceof TypeError, `the agent refuses the anchor's writer: ${refused?.stack}`);
  assert.match(refused.message, /belongs to another seller/, 'refused at the agent\'s writer check');
  const entries = readdirSync(f.dataDirectory);
  assert.ok(entries.includes(COMPOSITION_JOURNAL) && entries.includes(ARTIFACT_JOURNAL), 'finalize built the wallet under the lock');
  const lock = await acquireSellerStateLock(f.dataDirectory);
  lock.release();
  await assert.rejects(port.artifactAnchor.read({}), { code: 'wallet_session_closed' });
  assert.throws(() => port.authority.claim(), { code: 'wallet_session_closed' });
});

test('createSellerWalletSession accepts a participantImplementations source and a sessionOf function, and refuses an unknown option and a missing or malformed signer, loadKeyRecord or demo artifact publication authority with a TypeError naming the option, before any node read, key load or file', async () => {
  const node = replayNode();
  let keyLoads = 0;
  const valid = await portOptions(node, async () => { keyLoads += 1; return keyRecordBytes(); });
  const { sign, claim } = valid.signer;
  const withAuthority = (authority) => ({ ...valid.publications, demoArtifactPublication: { ...valid.publications.demoArtifactPublication, authority } });
  const cases = [
    [{ ...valid, extra: 1 }, 'extra'],
    [{ ...valid, signer: undefined }, 'signer'],
    [{ ...valid, signer: { claim: 1, sign } }, 'signer'],
    [{ ...valid, signer: { claim, sign: 'x' } }, 'signer'],
    [{ ...valid, loadKeyRecord: undefined }, 'loadKeyRecord'],
    [{ ...valid, loadKeyRecord: 'x' }, 'loadKeyRecord'],
    [{ ...valid, publications: withAuthority(undefined) }, 'publications.demoArtifactPublication.authority'],
    [{ ...valid, publications: withAuthority(1) }, 'publications.demoArtifactPublication.authority'],
  ];
  for (const [options, name] of cases) {
    if (options.signer === undefined) delete options.signer;
    if (options.loadKeyRecord === undefined) delete options.loadKeyRecord;
    assert.throws(() => createSellerWalletSession(options), (error) => error instanceof TypeError && error.message.includes(name), name);
  }
  const accepted = createSellerWalletSession({ ...valid, participantImplementations: { entriesFor: () => [] }, sessionOf: () => null });
  await accepted.close();
  assert.deepEqual({ calls: node.calls.length, keyLoads }, { calls: 0, keyLoads: 0 });
});

test('trusted finality accepts only an absent or plain object option before finalization', async () => {
  const node = replayNode();
  let keyLoads = 0;
  const valid = await portOptions(node, async () => { keyLoads += 1; return keyRecordBytes(); });
  for (const trustedFinality of [undefined, {}, { checkpoint: { height: 1 }, source: 'TEST operator pin' }]) await createSellerWalletSession({ ...valid, trustedFinality }).close();
  class OperatorPin { checkpoint = { height: 1 }; }
  for (const trustedFinality of [null, [], 'TEST-pin', new OperatorPin()]) {
    assert.throws(() => createSellerWalletSession({ ...valid, trustedFinality }), (error) => error instanceof TypeError && error.message.includes('trustedFinality'), String(trustedFinality));
  }
  assert.deepEqual({ calls: node.calls.length, keyLoads }, { calls: 0, keyLoads: 0 });
});

test('createSellerWalletSession refuses an endpoint that is not a canonical root, a transport authority that is not a plain token and a fetchImpl that is not a function with transport_mismatch, at construction and before any node read', async () => {
  const node = replayNode();
  let keyLoads = 0;
  const valid = await portOptions(node, async () => { keyLoads += 1; return keyRecordBytes(); });
  for (const changes of [{ endpoint: 'https://rpc.example.invalid/path' }, { endpoint: 'http://rpc.example.invalid/path' }, { endpoint: 'http://u:p@rpc.example.invalid/' },
    { endpoint: 'http://rpc.example.invalid/?x=1' }, { endpoint: 'http://rpc.example.invalid/#f' }, { endpoint: 'http://rpc.example.invalid' },
    { transportAuthority: 'vector authority' }, { fetchImpl: 'x' }]) {
    assert.throws(() => createSellerWalletSession({ ...valid, ...changes }), { code: 'transport_mismatch' }, JSON.stringify(changes));
  }
  assert.deepEqual({ calls: node.calls.length, keyLoads }, { calls: 0, keyLoads: 0 });
});

test('finalize refuses a binding whose authority is no longer current with tp1_connection_unverified, and one whose authority read stalls with tp1_authority_timeout at 10,000 ms but not at 9,999 ms, each before the key is loaded or an issuance journal opens', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const stale = await walletSessionWorld(t, { nodeScript: otherChain });
  await assert.rejects(stale.finalize(), { code: 'tp1_connection_unverified' });
  assert.deepEqual({ keyLoads: stale.keyLoads, journals: stale.issuanceJournals(), stages: stale.executeStages() }, { keyLoads: 0, journals: [], stages: 0 });

  const stalled = await walletSessionWorld(t, { nodeScript: () => new Promise(() => {}) });
  // The client's own read deadlines are computed from performance.now(); held still, only the mocked timers move time.
  const frozenNow = performance.now();
  const heldClock = t.mock.method(performance, 'now', () => frozenNow);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { mock.timers.reset(); heldClock.mock.restore(); });
  let outcome = 'pending';
  const reads = stalled.node.calls.length;
  const finalizing = stalled.finalize().then(() => { outcome = 'finalized'; }, (error) => { outcome = error; });
  // The deadline starts with the read: wait until the node has been asked.
  for (let turn = 0; stalled.node.calls.length === reads && turn < 1000; turn++) await flush();
  assert.equal(stalled.node.calls.length, reads + 1, 'the binding check asked the node once');
  mock.timers.tick(AUTHORITY_DEADLINE_MS - 1);
  await flush();
  assert.equal(outcome, 'pending', 'still waiting at 9,999 ms');
  mock.timers.tick(1);
  await finalizing;
  mock.timers.reset();
  heldClock.mock.restore();
  assert.deepEqual({ code: outcome.code, deadline: isBoundedCallTimeout(outcome.cause) }, { code: 'tp1_authority_timeout', deadline: true });
  assert.deepEqual({ keyLoads: stalled.keyLoads, journals: stalled.issuanceJournals(), stages: stalled.executeStages(), signatures: signatures.length },
    { keyLoads: 0, journals: [], stages: 0, signatures: 0 });
});

test('finalize refuses a key whose address is not signer.claim with seller_key_claim_mismatch: nothing signed or sent, every journal it opened closed, the key bytes zero-filled, and the port closed by the stages', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await walletSessionWorld(t, { keyBytes: () => keyRecordBytes(SECOND_MNEMONIC) });
  await assert.rejects(world.finalize(), { code: 'seller_key_claim_mismatch' });
  assert.ok(world.returnedKeys.length === 1 && world.returnedKeys.every(allZero), 'the loaded key bytes are zero-filled');
  assert.deepEqual({ stages: world.executeStages(), signatures: signatures.length }, { stages: 0, signatures: 0 });
  await assert.rejects(world.port.artifactAnchor.read({}), { code: 'wallet_session_closed' });
  assert.equal(await reopens(t, world), 'open', 'the refused attempt left its journals closed and reopenable');
});

test('finalize passes journalMode, approvalMode and approve through unchanged and never infers create or open: open over a fresh directory refuses journal-absent and creates no journal, create over a used directory refuses journal-exists, and an omitted journalMode refuses the mode TypeError, each with the key bytes zero-filled', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const opened = await walletSessionWorld(t, { options: { journalMode: 'open' } });
  await assert.rejects(opened.finalize(), { code: 'journal-absent' });
  assert.deepEqual(opened.issuanceJournals(), [], 'no journal was created');

  const used = await walletSessionWorld(t);
  await used.finalize();
  await used.stages.close();
  used.lock.release();
  const created = await walletSessionWorld(t, { directory: used.directory, options: { journalMode: 'create' } });
  await assert.rejects(created.finalize(), { code: 'journal-exists' });

  const omitted = await walletSessionWorld(t, { options: { journalMode: undefined } });
  await assert.rejects(omitted.finalize(), (error) => error instanceof TypeError && /journalMode/.test(error.message));
  const noApproval = await walletSessionWorld(t, { options: { approvalMode: undefined } });
  await assert.rejects(noApproval.finalize(), (error) => error instanceof TypeError && /approvalMode/.test(error.message));

  for (const world of [opened, created, omitted, noApproval]) assert.ok(world.returnedKeys.length === 1 && world.returnedKeys.every(allZero), 'the key bytes are zero-filled');
  assert.equal(signatures.length, 0, 'nothing was signed');
});

// The identity observer the port composed its anchor with at finalize, read from a copy of the module whose anchor is spied.
async function composedObserver(t) {
  const { createSellerWalletSession: createSpiedPort } = await importSpiedWalletSession();
  const world = await walletSessionWorld(t, { createPort: createSpiedPort });
  const composed = anchorOptions.length;
  await world.finalize();
  assert.equal(anchorOptions.length, composed + 1, 'finalize composed one anchor');
  const { binding, observeIdentity, runCreate } = anchorOptions.at(-1);
  assert.equal(typeof runCreate, 'function', 'the anchor runs its wallet CREATEs through runCreate');
  assert.equal(binding, world.stages.binding, 'the anchor reads back against the host\'s binding');
  return { world, observeIdentity };
}

test('the anchor composed at finalize observes the chain identity of the port\'s connection decision, and observes undefined when the connection reader returns no decision', async (t) => {
  const { world, observeIdentity } = await composedObserver(t);
  assert.equal(await observeIdentity({ timeoutMs: AUTHORITY_DEADLINE_MS }), world.stages.binding.profile.chainIdentity);
  world.node.reply = otherChain;
  assert.equal(await world.port.connectionAuthority({ local: world.stages.binding.local, sessionId: null, participants: [] }), undefined, 'the reader has no decision');
  assert.equal(await observeIdentity({ timeoutMs: AUTHORITY_DEADLINE_MS }), undefined);
});

test('the anchor\'s identity observer stops waiting at the readback\'s remaining time, at most 10,000 ms, with tp1_authority_timeout, and an aborted signal refuses before any node read', async (t) => {
  const { world, observeIdentity } = await composedObserver(t);
  const reads = world.node.calls.length;
  const aborted = new Error('TEST-readback-aborted');
  assert.equal(await refusalOf(observeIdentity({ signal: AbortSignal.abort(aborted), timeoutMs: 50 })), aborted, 'the signal\'s reason');
  assert.equal(world.node.calls.length, reads, 'an aborted readback asks the node nothing');

  world.node.reply = () => new Promise(() => {});
  // The client's own read deadlines are computed from performance.now(); held still, only the mocked timers move time.
  const frozenNow = performance.now();
  const heldClock = t.mock.method(performance, 'now', () => frozenNow);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => { mock.timers.reset(); heldClock.mock.restore(); });
  for (const [timeoutMs, waitedMs] of [[50, 50], [60_000, AUTHORITY_DEADLINE_MS]]) {
    let outcome = 'pending';
    observeIdentity({ timeoutMs }).then(() => { outcome = 'resolved'; }, (error) => { outcome = error; });
    mock.timers.tick(waitedMs - 1);
    await flush();
    assert.equal(outcome, 'pending', `asked for ${timeoutMs} ms: still waiting at ${waitedMs - 1} ms`);
    mock.timers.tick(1);
    await flush();
    assert.deepEqual({ code: outcome.code, deadline: isBoundedCallTimeout(outcome.cause) }, { code: 'tp1_authority_timeout', deadline: true }, `asked for ${timeoutMs} ms`);
  }
});

test('a seller process killed after finalize opens the issuance journals and before the anchor handle binds has confirmed and broadcast nothing, and a restart in open mode over the same directory finalizes, binds the handle and confirms and broadcasts a CREATE once', async (t) => {
  const directory = privateDataDirectory(t), stateFile = join(privateDataDirectory(t), 'node-state.json');
  const child = fork(CRASH_CHILD, [directory, stateFile], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  assert.deepEqual(await once(child, 'exit'), [null, 'SIGKILL'], `the child died inside finalize: ${stderr}`);
  assert.deepEqual([COMPOSITION_JOURNAL, ARTIFACT_JOURNAL].filter((name) => existsSync(join(directory, name))), [COMPOSITION_JOURNAL, ARTIFACT_JOURNAL], 'the journals were open');
  assert.equal(existsSync(stateFile), false, 'the killed process confirmed and broadcast nothing');

  const signatures = await spyTransactionSignatures(t.mock);
  const restarted = await walletSessionWorld(t, { directory, node: replayNode(stateFile), options: { journalMode: 'open' } });
  const { session } = await restarted.finalize();
  assert.equal(await restarted.port.artifactAnchor.hasIntent('dacs1:listing:fixture-report:1'), false, 'the restarted port bound its anchor handle');
  const wallet = session.walletFactory({ anchorJournal: session.artifactJournal });
  const answer = await inSessionPass(session, wallet, await agreementRequest({ session: { wallet }, node: restarted.node }));
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.deepEqual({ confirms: restarted.node.confirms.length, broadcasts: restarted.node.broadcasts.length, signatures: signatures.length }, { confirms: 1, broadcasts: 1, signatures: 1 });
});

// ---- The session's payment-evidence journal ----

const KEPT_UNSENT = 'payment-evidence approvals have ended because the seller host or this journal is closing: this call did not send the signed, kept evidence CREATE; '
  + 'it keeps the seller wallet reserved until it executes, and an authorized claim can send it';
// An authorized ensureEvidence of the session's journal for the evidence `label`, written by the session's own address.
const ensureOver = (session, label = 'a') => session.paymentEvidence.ensureEvidence({ ...evidenceInput({ wallet: session }, label), expectedJournalId: session.paymentEvidence.journalId,
  authorize: () => true });
const keptOf = (session, label = 'a') => session.paymentEvidence.readSignedProjection(evidenceInput({ wallet: session }, label));
const transmissions = (node) => node.reads.filter((read) => read === 'confirmTx' || read === 'broadcastTx').length;
// A finalized session in manual mode, whose operator holds every request until the test answers it.
async function manualSession(t) {
  const directory = privateDataDirectory(t), operator = heldOperator();
  const world = await walletSessionWorld(t, { directory, options: { approvalMode: 'manual', approve: manualSellerApproval({ directory, operator: operator.operator, t }) } });
  const { session } = await world.finalize();
  return { world, session, operator };
}
// Starts an ensureEvidence of `session` and, once the operator holds its approval request, resolves `{ outcome }`: the call's
// settled `{ value }` or `{ error }`, still pending.
async function waitingForTheOperator({ session, operator }) {
  const asked = operator.nextAsk();
  const outcome = ensureOver(session).then((value) => ({ value }), (error) => ({ error }));
  await asked;
  return { outcome };
}

test('the finalized session builds its payment-evidence journal and consumer over the session\'s own passes; ending its approval waits ends a pending approval and refuses later ones while the journal stays open, and its close closes the journal and the wallet once', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await walletSessionWorld(t);
  const { session } = await world.finalize();
  assert.equal(session.nativePaymentEvidence.anchorEvidence, session.paymentEvidence.anchorEvidence, 'the consumer anchors with the session journal\'s own anchorEvidence');
  assert.equal((await ensureOver(session)).status, 'submitted', 'with no test pass around it, the journal signs and sends in the session\'s own passes');
  assert.deepEqual({ signatures: signatures.length, transmissions: transmissions(world.node), asked: world.options.approve.retained.prepared.length },
    { signatures: 1, transmissions: 2, asked: 1 }, 'asked once, signed once, confirmed and broadcast once');
  const closing = session.close();
  await closing;
  assert.equal(session.close(), closing, 'a second close returns the same promise');
  for (const file of [PAYMENT_EVIDENCE_JOURNAL, COMPOSITION_JOURNAL]) {
    const raw = new Database(join(world.directory, file), { timeout: 0 });
    raw.exec('BEGIN IMMEDIATE; COMMIT');
    raw.close();
  }

  // The worlds run one after another: each session is closed before the next one starts.
  const manual = await manualSession(t);
  const { outcome: pending } = await waitingForTheOperator(manual);
  manual.session.endApprovalWaits();
  assert.equal((await pending).error?.code, 'signer_reservation_uncertain', 'the pending approval ended without the operator\'s answer');
  assert.equal(await keptOf(manual.session), null, 'nothing was kept, and the journal is still open');
  const later = await refusalOf(ensureOver(manual.session));
  assert.equal(later.code, 'operator_closing');
  assert.match(later.message, /nothing was signed or kept for this call$/);
  assert.equal(manual.operator.asked.length, 1, 'a later call asks the operator nothing');
  manual.session.endApprovalWaits();
  await manual.session.close();

  // The journal's own close ends a wait too.
  const second = await manualSession(t);
  const { outcome: waiting } = await waitingForTheOperator(second);
  await second.session.close();
  assert.equal((await waiting).error?.code, 'signer_reservation_uncertain', 'the close ended the wait without the operator\'s answer');
  second.operator.asked[0].answer(true);
  await flush();
  const raw = new Database(join(second.world.directory, PAYMENT_EVIDENCE_JOURNAL), { readonly: true });
  assert.equal(raw.prepare('SELECT COUNT(*) AS kept FROM evidence_creates').get().kept, 0, 'no row was kept');
  raw.close();
  assert.equal(signatures.length, 1, 'a yes given after the close signs nothing');
});

test('a signed CREATE kept unsent is not sent once the approval waits have ended, and says so', async (t) => {
  for (const ended of [true, false]) {
    const world = await walletSessionWorld(t);
    const { session } = await world.finalize();
    replyTo(world.node, 'broadcastTx', () => jsonResponse({ result: 400, response: 'TEST-refused' }));
    await refusalOf(ensureOver(session));
    world.node.reply = null;
    const kept = await keptOf(session);
    assert.ok(kept, 'the refused send left the signed CREATE kept');
    const before = transmissions(world.node);
    if (ended) session.endApprovalWaits();
    const outcome = await ensureOver(session).then((value) => value, (error) => error);
    if (ended) {
      assert.deepEqual({ code: outcome.code, message: outcome.message, txHash: outcome.txHash }, { code: 'operator_closing', message: KEPT_UNSENT, txHash: kept.hash });
      assert.equal(transmissions(world.node), before, 'nothing more was confirmed or broadcast');
    } else {
      assert.deepEqual(outcome, { status: 'submitted', txHash: kept.hash }, 'the control sends the kept bytes');
      assert.equal(transmissions(world.node) - before, 2, 'confirmed and broadcast once');
      assert.deepEqual(world.node.broadcasts.at(-1), kept, 'the exact kept bytes');
    }
    assert.deepEqual(await keptOf(session), kept, 'the row is still the kept one');
    await session.close();
  }
});
