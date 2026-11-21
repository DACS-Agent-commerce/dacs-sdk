// The seller's production wallet-session port: stage one binds the host through the client's connection reader, finalize
// checks the host's boundary and binding before the key is loaded, builds the seller Node wallet under the state lock, zero-fills
// the key bytes on every outcome, and binds the one artifact anchor handle the operator gives the host.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { SELLER_FULFILMENT_VET_MODES } from '@kynesyslabs/dacs';
import { agreementRequest } from '../../dacs-client/test/helpers/tp1-node-fixture.mjs';
import { ARTIFACT_JOURNAL, COMPOSITION_JOURNAL, T0, api, finalization, jsonResponse, keyRecordBytes, ok, replayNode, sellerPublications, setPurchaseAdmission,
  spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';
import { allZero, createSellerWalletSession, portOptions, walletSessionWorld } from './helpers/seller-wallet-session-world.mjs';

const guard = await import('../src/kit-operation-guard.mjs');
const { createEffectBoundary, effectBoundaryBinding } = await import('../src/dacs/effect-boundary.mjs');
const { createEffectHistory } = await import('../src/dacs/effect-history.mjs');
const { isBoundedCallTimeout } = await import('../src/dacs/bounded-call.mjs');
const { acquireSellerStateLock } = await import('../src/devnet-demo/seller-state-lock.mjs');
const { fixtureListing } = await import('./fixtures/listings.mjs');
const { contextHostFixture } = await import('./helpers/host-context-client.mjs');

const PORT_MEMBERS = ['authority', 'connectionAuthority', 'artifactAnchor', 'finalize', 'close'];
const SESSION_MEMBERS = ['effectPass', 'runInEffectPass', 'walletFactory', 'transport', 'acquireConnectionFence', 'address', 'observer', 'artifactJournal',
  'paymentEvidence', 'readBalance', 'close'];
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
const finalizeInput = (world, changes = {}) => ({ binding: world.stages.binding, stopped: async () => false, feeCeilingOs: finalization.feeCeilingOs, stateLock: world.lock,
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

test('after finalization the port\'s artifactAnchor is the anchor composed over the finalized session: its writer, authority, source and Vet mode are unchanged from before finalization and match the session\'s address and declared publication; a Listing publish with a signing check refuses not-authorized and one without refuses nonce_lane_unavailable, and a job\'s retained read with the default buyer access refuses buyer_access_closed, each before any read, storing no intent and signing and sending nothing', async (t) => {
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
  const input = { logicalAddress: 'dacs1:listing:fixture-report:1', artifact: listing, artifactKind: 'Listing' };
  const reads = world.node.calls.length;
  await assert.rejects(anchor.publish({ ...input, authorizeSigning: () => true }), { code: 'not-authorized' });
  await assert.rejects(anchor.publish(input), { code: 'nonce_lane_unavailable' });
  await assert.rejects(anchor.readRetained({ logicalAddress: `dacs4:deliverable:${JOB_ID}`, artifactKind: 'Deliverable' }), { code: 'buyer_access_closed' });
  assert.equal(await anchor.hasIntent(input.logicalAddress), false, 'no intent was stored');
  assert.deepEqual({ reads: world.node.calls.length - reads, stages: world.executeStages(), signatures: signatures.length }, { reads: 0, stages: 0, signatures: 0 });
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

test('createSellerWalletSession refuses an unknown option and a missing or malformed signer, loadKeyRecord or demo artifact publication authority with a TypeError naming the option, before any node read, key load or file', async () => {
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
  assert.deepEqual({ calls: node.calls.length, keyLoads }, { calls: 0, keyLoads: 0 });
});

test('createSellerWalletSession refuses an endpoint that is not a canonical HTTPS root, a transport authority that is not a plain token and a fetchImpl that is not a function with transport_mismatch, at construction and before any node read', async () => {
  const node = replayNode();
  let keyLoads = 0;
  const valid = await portOptions(node, async () => { keyLoads += 1; return keyRecordBytes(); });
  for (const changes of [{ endpoint: 'http://rpc.example.invalid/' }, { endpoint: 'https://rpc.example.invalid/path' }, { transportAuthority: 'vector authority' }, { fetchImpl: 'x' }]) {
    assert.throws(() => createSellerWalletSession({ ...valid, ...changes }), { code: 'transport_mismatch' }, JSON.stringify(changes));
  }
  assert.deepEqual({ calls: node.calls.length, keyLoads }, { calls: 0, keyLoads: 0 });
});

test('finalize refuses a binding whose authority is no longer current with tp1_connection_unverified, and one whose authority read stalls with tp1_authority_timeout at 10,000 ms but not at 9,999 ms, each before the key is loaded or an issuance journal opens', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const otherChain = (row) => (row.body?.params[0].message === 'getBlockByNumber'
    ? jsonResponse(ok({ number: row.body.params[0].data.blockNumber, status: 'confirmed', hash: OTHER_CHAIN, content: { previousHash: OTHER_CHAIN } })) : undefined);
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
