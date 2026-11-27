// Node qualification: the seller signs and sends a native write only to a serving node whose build is a reviewed one. The host's
// deployment evidence must match a reviewed build of the shipped QUALIFIED_NODE_BUILDS, the bound endpoint and chain, and be
// current; the node's own version answer must agree on an unchanged connection. The client effect gate runs the check first in
// every pass, before each transaction signature and each confirmTx and broadcastTx; the artifact anchor runs it as a preflight.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindTp1Profile, canonicalNodeEndpoint, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { installNoNetworkTrap } from './helpers/no-network-trap.mjs';
import { agreementRequest } from '../../dacs-client/test/helpers/tp1-node-fixture.mjs';
import { api, ENDPOINT, evidenceInput, finalization, inWalletPass, jsonResponse, ok, preparedWrite, privateDataDirectory, replayNode, replyTo, restartedWorld,
  runWalletChild, sellerApproval, sellerWalletWorld, setPurchaseAdmission, spyTransactionSignatures, T0 } from './helpers/seller-node-wallet-world.mjs';
import { mnemonicSigner, walletSessionWorld } from './helpers/seller-wallet-session-world.mjs';
import { listingCreateRequest, pendingNode, rpc } from './helpers/listing-create-fixture.mjs';
import { journalOverAdapter, journalOverPass } from './helpers/payment-evidence-test-journals.mjs';
import { RECORDED_REVIEWED_BUILD, shippedBuildEvidence } from './helpers/shipped-build-evidence.mjs';
import { EVIDENCE_MAX_AGE_MS, qualificationInputs, signedDeploymentRecord, testDeployerKey } from './helpers/qualification-inputs.mjs';
import { importQualificationWith } from './helpers/qualified-builds-fixture.mjs';

const networkTrap = installNoNetworkTrap();
const lookups = [];
for (const resolver of [dns, dns.promises]) mock.method(resolver, 'lookup', (...args) => { lookups.push(args[0]); throw new Error('TEST no DNS lookup'); });

const { createAuthorityFixture } = await import('../../dacs-client/test/fixtures/tp1-authority-reader.mjs');
const { recordingApproval } = await import('../../dacs-client/test/helpers/payment-evidence-approval-double.mjs');
const guard = await import('../src/kit-operation-guard.mjs');
const { createStopCheck } = await import('../src/kill-switch.mjs');
const { assertQualifiedDeployment, assertReleaseQualification, createVerifiedDeploymentEvidenceReader, QUALIFIED_NODE_BUILDS, readPackagedDeploymentRecord,
  readQualificationObservation } = await import('../src/devnet-demo/deployment-qualification.mjs');
const { verifyDeploymentRecord } = await import('../src/devnet-demo/deployment-record-verifier.mjs');

const APPROVED_CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const OTHER_CHAIN = 'e'.repeat(64);
const OTHER_VERSION = 'TEST-0.0.1';
const MIB4 = 4 * 1024 * 1024;
const PASS_WINDOW_MS = 10_000;
const QUALIFICATION_DEADLINE_MS = 10_000;
const HTTP_ROOT = 'http://node.example.invalid/';

const flush = async () => { for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };
const refusalOf = (promise, label = '') => promise.then((value) => assert.fail(`${label}: expected a refusal, got ${JSON.stringify(value)}`), (error) => error);
// Every error on the cause chain of `error`, outermost first.
const causeChain = (error) => { const chain = []; for (let link = error; link instanceof Error; link = link.cause) chain.push(link); return chain; };
// The qualification refusal on the chain: the kit's deployment_unqualified error that carries its reason.
const qualificationRefusal = (error) => causeChain(error).find((link) => link.code === 'deployment_unqualified' && typeof link.details === 'string');
const evidenceAt = (observedAt, changes = {}) => ({ ...shippedBuildEvidence({ endpoint: ENDPOINT, observedAt }), ...changes });
// The scripted node's getNetworkInfo answer (its forks and chain id, which the wallet also reads) reporting `version`.
const networkInfo = (version) => ({ forks: { osDenomination: { activated: true }, signatureDomain: { activated: false } }, chainId: 1, nodeVersion: { version } });
const nodeVersionReply = (node, version) => replyTo(node, 'getNetworkInfo', () => jsonResponse(ok(networkInfo(version))));
const shippedEntry = () => ({ ...QUALIFIED_NODE_BUILDS[0], qualifiedOperations: [...QUALIFIED_NODE_BUILDS[0].qualifiedOperations] });

// True when the owner's connection fence can be taken at once: the gate released it.
async function fenceReleased(owner) {
  const lease = owner.acquireConnectionFence();
  const taken = await Promise.race([lease.then(() => true), flush().then(() => false)]);
  if (taken) (await lease).release();
  return taken;
}

// The composition journal's rows as `<key> <state or stage> <cause>`, in commit order: the dispatch history and the retained writes.
const compositionHistory = async (wallet) => (await wallet.sourceCapability.journal.entries())
  .map(([key, value]) => `${key} ${value?.state ?? value?.stage ?? ''} ${value?.cause?.code ?? value?.cause ?? ''}`);
// The record a refused transmission leaves after its started one: the client transport writes a gate refusal at confirmTx or
// broadcastTx as `<stage>-unknown` (cause effect_failed), keeping the possible-dispatch history, and its own refusals as `-withheld`.
const withheld = (history) => history.some((row) => /\/(recovery-)?(confirm|dispatch)-(withheld|unknown) /.test(row));

/**
 * A seller Node wallet world whose host evidence reader answers `controls.evidence(clock)` (the reviewed build's evidence by default)
 * after `controls.onRead(n)` for its n-th call, with transaction signatures and node transmissions counted.
 */
async function gatedWorld(t, { options = {}, ...world } = {}) {
  const signatures = await spyTransactionSignatures(t.mock, (transaction) => controls.onSigned?.(transaction));
  const controls = { reads: 0, onRead: null, onSigned: null, evidence: (clock) => evidenceAt(clock.now()) };
  const readDeploymentEvidence = async ({ signal } = {}) => {
    controls.reads += 1;
    await controls.onRead?.(controls.reads);
    signal?.throwIfAborted();
    return controls.evidence(w.options.clock);
  };
  const w = await sellerWalletWorld(t, { ...world, options: { readDeploymentEvidence, ...options } });
  w.controls = controls;
  w.signatures = signatures;
  w.effects = () => ({ signatures: signatures.length, transmissions: w.node.confirms.length + w.node.broadcasts.length });
  w.history = () => compositionHistory(w.wallet);
  return w;
}
// One payment-evidence CREATE through the wallet's adapter inside one test pass (sign, confirm, broadcast).
const anchorEvidence = (world, label = 'a') => inWalletPass(world, () => journalOverAdapter(world).anchorEvidence(evidenceInput(world, label)));
const reconcileEvidence = (world, label = 'a') => inWalletPass(world, () => journalOverAdapter(world).reconcilePaymentEvidence(evidenceInput(world, label)));
const keptProjection = (world, label = 'a') => journalOverAdapter(world).readSignedProjection(evidenceInput(world, label));
// The production payment-evidence chain over the world (kit boundary, runCreate, pass and journal): `ensure(label)` signs or resends
// the evidence with a current-authorization check that answers true.
function productionChain(world, options) {
  const chain = journalOverPass(world, options);
  chain.ensure = (label = 'a') => chain.journal.ensureEvidence({ ...evidenceInput(world, label), expectedJournalId: chain.journal.journalId, authorize: () => true });
  chain.kept = (label = 'a') => chain.journal.readSignedProjection(evidenceInput(world, label));
  return chain;
}
const loseBroadcastAnswer = (world) => replyTo(world.node, 'broadcastTx', () => { throw new Error('TEST-acknowledgement-lost'); });
const ARTIFACT_OP = Object.freeze({ operationId: 'demo/artifact/TEST-qualification', lane: 'seller-wallet', operationClass: 'job-create', currentAuthorization: () => true });

/**
 * The artifact path the anchor takes, over `chain`'s runCreate: `send()` sends the seller's Listing CREATE to a node that acknowledges
 * it without applying it, so the transport retains the signed bytes (`retained()`) with a possible dispatch; `resend(signedTransaction)`
 * is the one recovery resend of those bytes, its RPC-authentication signatures made through the pass's guarded signer.
 */
async function listingPath(world, chain) {
  const signer = await mnemonicSigner(), transport = world.wallet.sourceCapability;
  const wallet = world.wallet.walletFactory({ anchorJournal: world.wallet.artifactJournal });
  const request = listingCreateRequest({ transport, address: world.wallet.address, signer, nonce: world.node.nonce + 1 });
  const send = async () => {
    world.node.reply = pendingNode({ statusUnavailable: true });
    try { return await chain.runCreate(ARTIFACT_OP, () => wallet.request(request)); } finally {
      // From now on the node also answers the recovery's numeric block-0 identity read.
      const pending = pendingNode({ statusUnavailable: false });
      world.node.reply = (row) => (row.body?.params[0]?.message === 'getBlockByNumber' && row.body.params[0].data.blockNumber === 0
        ? rpc({ number: 0, status: 'confirmed', hash: APPROVED_CHAIN }, '') : pending(row));
    }
  };
  const retained = async () => (await transport.journal.entries()).find(([key, value]) => key.startsWith('devnet/native-transfer/') && value?.signedTransaction)?.[1].signedTransaction;
  const resend = (signedTransaction) => chain.runCreate({ ...ARTIFACT_OP, operationId: `demo/recovery/${signedTransaction.hash}` }, ({ guardedSigner }) => transport.recoverStorageWrite({
    signedTransaction, signRpc: guardedSigner(async (message) => `0x${signer.signBytes(Buffer.from(message)).toString('hex')}`) }));
  return { send, retained, resend };
}
const JOB_CREATE = () => api.passContext({ operationClass: 'job-create', currentAuthorization: () => true });
// One artifact CREATE through the composed walletFactory inside one test pass; resolves the wallet's answer envelope.
const artifactCreate = async (world) => { const { wallet, request } = await preparedWrite(world); return inWalletPass(world, () => wallet.request(request), { context: JOB_CREATE() }); };

test('the shipped reviewed build entry with current verified evidence for the serving endpoint admits a native write on the real composed session, with no list substitution', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  let evidenceReads = 0;
  const world = await walletSessionWorld(t, { options: { readDeploymentEvidence: () => { evidenceReads += 1; return evidenceAt(T0); } } });
  const { session } = await world.finalize();
  assert.equal(QUALIFIED_NODE_BUILDS.length, 1, 'the shipped list holds the one reviewed build');
  const wallet = session.walletFactory({ anchorJournal: session.artifactJournal });
  const request = await agreementRequest({ session: { wallet }, node: world.node });
  world.node.reads.length = 0;
  const lease = await session.acquireConnectionFence();
  let answer;
  try {
    answer = await session.runInEffectPass(session.effectPass({ fence: lease, deadline: T0 + PASS_WINDOW_MS, refreshAuthority() {}, finalStop() {}, synchronousChecks: [],
      feeCeilingOs: finalization.feeCeilingOs, context: JOB_CREATE() }), () => wallet.request(request));
  } finally { lease.release(); }
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.equal(signatures.length, 1);
  assert.equal(evidenceReads, 3, 'qualification ran for the signature, the confirmation and the broadcast');
  const reads = world.node.reads, confirm = reads.indexOf('confirmTx'), broadcast = reads.indexOf('broadcastTx');
  assert.ok(reads.slice(0, confirm).includes('getNetworkInfo') && reads.slice(confirm, broadcast).includes('getNetworkInfo'), reads.join());
});

test('same chain and same reported version but another artifactSha256 is deployment_unqualified with signer and publication calls 0', async (t) => {
  const world = await gatedWorld(t);
  world.controls.evidence = (clock) => evidenceAt(clock.now(), { artifactSha256: 'a'.repeat(64) });
  const refusal = qualificationRefusal(await refusalOf(anchorEvidence(world)));
  assert.equal(refusal?.details, 'node_build_unverified');
  const answer = await artifactCreate(world);
  assert.equal(answer.success, false, JSON.stringify(answer));
  assert.match(JSON.stringify(answer), /deployment_unqualified/);
  assert.deepEqual(world.effects(), { signatures: 0, transmissions: 0 });
});

test('signed evidence with dirty: true matching the shipped approved-testnet entry that records dirty: true qualifies; the same evidence with dirty: false, or against an entry recording dirty: false, refuses node_build_unverified with signer and publication calls 0', async (t) => {
  assert.equal(QUALIFIED_NODE_BUILDS[0].dirty, true);
  const world = await gatedWorld(t);
  world.controls.evidence = (clock) => evidenceAt(clock.now(), { dirty: false });
  assert.equal(qualificationRefusal(await refusalOf(anchorEvidence(world, 'clean')))?.details, 'node_build_unverified');
  assert.deepEqual(world.effects(), { signatures: 0, transmissions: 0 });
  world.controls.evidence = (clock) => evidenceAt(clock.now());
  assert.equal((await anchorEvidence(world, 'dirty')).status, 'submitted');
  assert.deepEqual(world.effects(), { signatures: 1, transmissions: 2 });

  const cleanEntry = await importQualificationWith({ builds: [{ ...shippedEntry(), dirty: false }] });
  const { inputs } = await qualificationInputs(t);
  const refusal = await refusalOf(cleanEntry.assertQualifiedDeployment({ phase: 'preflight', ...inputs }));
  assert.deepEqual([refusal.code, refusal.details], ['deployment_unqualified', 'node_build_unverified']);
});

test('evidence for a canonical HTTP serving root qualifies only with the binding\'s approved testnet chain identity; the same HTTP root without that pinned identity is refused before a signature', async (t) => {
  const node = replayNode();
  const owner = api.createNodeTransportOwner({ endpoint: HTTP_ROOT, transportAuthority: 'vector-authority', fetchImpl: node.fetch, chainIdentity: APPROVED_CHAIN });
  t.after(() => owner.close());
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: owner.currentLocal(), readAuthority: createAuthorityFixture().read });
  const clock = { now: () => T0 };
  const made = await api.createQualificationObserverSource({ owner, binding, clock });
  const inputs = { binding, currentLocal: made.currentLocal, observer: made.observer, source: made.source, clock,
    readDeploymentEvidence: () => ({ ...shippedBuildEvidence({ endpoint: HTTP_ROOT, observedAt: T0 }) }) };
  assert.equal(canonicalNodeEndpoint(HTTP_ROOT, { chainIdentity: APPROVED_CHAIN }), HTTP_ROOT);
  assert.equal(await assertQualifiedDeployment({ phase: 'sign', ...inputs }), owner.currentLocal().connectionId);
  const unpinned = { ...binding, profile: { ...binding.profile, chainIdentity: OTHER_CHAIN } };
  assert.equal(canonicalNodeEndpoint(HTTP_ROOT, { chainIdentity: OTHER_CHAIN }), null);
  const nodeReads = node.reads.length;
  const refusal = await refusalOf(assertQualifiedDeployment({ phase: 'sign', ...inputs, binding: unpinned }));
  assert.deepEqual([refusal.code, refusal.details], ['deployment_unqualified', 'node_build_unverified']);
  assert.match(refusal.message, /another endpoint/);
  assert.equal(node.reads.length, nodeReads, 'the refusal came before any node read');
});

test('loading a build list whose dirty: true entry names a chain identity other than TP1_APPROVED_IDENTITY_RECORD.chainIdentity throws at module load with the error that names dirty, so a non-testnet network never accepts a dirty build; removing the dirty load check lets the later testnet-only pin check throw its own different message instead and fails this test', async () => {
  const refusal = await refusalOf(importQualificationWith({ builds: [{ ...shippedEntry(), chainIdentity: OTHER_CHAIN, dirty: true }] }));
  assert.match(refusal.message, /dirty/);
  assert.doesNotMatch(refusal.message, /testnet-only deployer key pin/);
});

test('a testnet-only deployer key pin qualifies only the approved testnet chain', async () => {
  const otherChainBuild = await refusalOf(importQualificationWith({ builds: [{ ...shippedEntry(), chainIdentity: OTHER_CHAIN, dirty: false }] }));
  assert.equal(otherChainBuild.message, `testnet-only deployer key pin cannot qualify chain ${OTHER_CHAIN}`);

  const { privateKey, publicKey } = testDeployerKey();
  const clock = { now: () => T0 };
  const verify = (record, testnetOnly) => verifyDeploymentRecord(record.bytes, { digest: record.digest, publicKey, clock, maxAgeMs: EVIDENCE_MAX_AGE_MS, testnetOnly });
  const otherChainRecord = signedDeploymentRecord(evidenceAt(T0, { chainIdentity: OTHER_CHAIN }), privateKey);
  assert.throws(() => verify(otherChainRecord, true), { code: 'deployment_unqualified', details: 'node_build_unverified', message: 'deployment record for another chain under a testnet-only deployer key' });
  assert.equal(verify(otherChainRecord, false).chainIdentity, OTHER_CHAIN, 'without the testnet-only marker the same record verifies');
  assert.equal(verify(signedDeploymentRecord(evidenceAt(T0), privateKey), true).chainIdentity, APPROVED_CHAIN);
  assert.throws(() => verify(otherChainRecord, undefined), TypeError);
});

test('another commit, a dirty build with no approved-testnet entry recording it, stale evidence, evidence for another endpoint or a missing qualified operation each refuse node_build_unverified with signer and publication calls 0', async (t) => {
  const world = await gatedWorld(t);
  const cases = [['another commit', { commit: 'b'.repeat(40) }], ['an unrecorded dirty build', { commit: 'b'.repeat(40), dirty: true }],
    ['stale evidence', { observedAt: T0 - EVIDENCE_MAX_AGE_MS - 1 }], ['another endpoint', { endpoint: 'https://other.example.invalid/' }],
    ['a missing operation', { qualifiedOperations: ['fee', 'nonce', 'broadcast'] }]];
  for (const [label, change] of cases) {
    world.controls.evidence = (clock) => ({ ...evidenceAt(clock.now()), ...change });
    assert.equal(qualificationRefusal(await refusalOf(anchorEvidence(world, label.replaceAll(' ', '-'))))?.details, 'node_build_unverified', label);
  }
  assert.deepEqual(world.effects(), { signatures: 0, transmissions: 0 });
});

test('a node self-report naming another version is deployment_unqualified, cause node_build_drift, before any signature', async (t) => {
  const world = await gatedWorld(t);
  nodeVersionReply(world.node, OTHER_VERSION);
  const refusal = await refusalOf(anchorEvidence(world));
  assert.ok(causeChain(refusal).some((link) => link.code === 'deployment_unqualified'), 'the gate refuses deployment_unqualified');
  assert.equal(qualificationRefusal(refusal)?.details, 'node_build_drift');
  assert.deepEqual(world.effects(), { signatures: 0, transmissions: 0 });
});

test('a build answer that drifts between two writes stops the second write and every later new write', async (t) => {
  const world = await gatedWorld(t);
  assert.equal((await anchorEvidence(world, 'first')).status, 'submitted');
  nodeVersionReply(world.node, OTHER_VERSION);
  for (const label of ['second', 'third']) assert.equal(qualificationRefusal(await refusalOf(anchorEvidence(world, label)))?.details, 'node_build_drift', label);
  assert.equal((await artifactCreate(world)).success, false, 'a later artifact CREATE is refused too');
  assert.deepEqual(world.effects(), { signatures: 1, transmissions: 2 }, 'only the first write was signed and sent');
});

test('the serving build changes during approval, during signing or before a recovery dispatch on the real composed paths: refused before signing means signer 0; after signing the bytes are kept and transmissions are 0', async (t) => {
  // During approval: the ledger's prepare is where the build changes; the signature's qualification then sees the drift.
  const approving = await gatedWorld(t);
  const prepare = approving.approval.prepare;
  approving.approval.prepare = async (...args) => { nodeVersionReply(approving.node, OTHER_VERSION); return prepare(...args); };
  assert.equal(qualificationRefusal(await refusalOf(anchorEvidence(approving)))?.details, 'node_build_drift');
  assert.deepEqual(approving.effects(), { signatures: 0, transmissions: 0 });

  // During signing, on the production chain: the build changes once the inner signature is made; the confirmation's qualification refuses.
  const signing = await gatedWorld(t);
  const chain = productionChain(signing);
  signing.controls.onSigned = () => nodeVersionReply(signing.node, OTHER_VERSION);
  assert.equal(qualificationRefusal(await refusalOf(chain.ensure()))?.details, 'node_build_drift');
  assert.deepEqual(signing.effects(), { signatures: 1, transmissions: 0 });
  const kept = await chain.kept();
  assert.ok(kept, 'the signed bytes are kept');

  // Before a recovery dispatch: the kept bytes are not resent while the build differs, and are still kept.
  signing.controls.onSigned = null;
  assert.equal(qualificationRefusal(await refusalOf(chain.ensure()))?.details, 'node_build_drift');
  assert.deepEqual(signing.effects(), { signatures: 1, transmissions: 0 });
  assert.deepEqual(await chain.kept(), kept, 'the same signed bytes are still kept');
});

test('an evidence read or drift read that stalls past its deadline or fails is deployment_unqualified with its cause kept; direct and preflight timeouts expose node_build_timeout, while a gated timeout exposes the gate\'s remaining-deadline OutboundError', async (t) => {
  const node = replayNode(), { inputs } = await qualificationInputs(t, { node });
  const failure = new Error('TEST-evidence-unavailable');
  const failed = await refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs, readDeploymentEvidence: () => { throw failure; } }));
  assert.deepEqual([failed.code, failed.details, failed.cause], ['deployment_unqualified', 'node_build_unavailable', failure]);
  replyTo(node, 'getNetworkInfo', () => jsonResponse({ result: 500, response: 'TEST-unavailable', require_reply: false, extra: null }));
  const driftFailed = await refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs }));
  assert.deepEqual([driftFailed.details, driftFailed.cause?.code], ['node_build_unavailable', 'upstream_unavailable']);
  node.reply = null;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalledEvidence = refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs, readDeploymentEvidence: () => new Promise(() => {}) }));
  await flush();
  t.mock.timers.tick(QUALIFICATION_DEADLINE_MS);
  const evidenceTimeout = await stalledEvidence;
  assert.deepEqual([evidenceTimeout.details, evidenceTimeout.cause?.message], ['node_build_timeout', 'resolver-timeout']);
  replyTo(node, 'getNetworkInfo', () => new Promise(() => {}));
  const stalledDrift = refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs }));
  await flush();
  t.mock.timers.tick(QUALIFICATION_DEADLINE_MS);
  assert.equal((await stalledDrift).details, 'node_build_timeout');
  node.reply = null;
  t.mock.timers.reset();

  // The anchor's preflight runs the wallet's own step outside any pass; the gate's pass deadline is shorter than the read's.
  const world = await gatedWorld(t);
  world.controls.onRead = () => new Promise(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const preflight = refusalOf(world.wallet.qualify({ phase: 'publish' }));
  await flush();
  t.mock.timers.tick(QUALIFICATION_DEADLINE_MS);
  const preflightTimeout = await preflight;
  assert.equal(preflightTimeout.details, 'node_build_timeout');
  assert.match(preflightTimeout.message, /^publish: /);
  const gatedDeadlineMs = 5_000;
  const gated = refusalOf(inWalletPass(world, () => journalOverAdapter(world).anchorEvidence(evidenceInput(world)), { deadline: T0 + gatedDeadlineMs }));
  await flush();
  t.mock.timers.tick(gatedDeadlineMs);
  const gatedTimeout = await gated;
  t.mock.timers.reset();
  const chain = causeChain(gatedTimeout);
  assert.ok(chain.some((link) => link.code === 'deployment_unqualified'), chain.map((link) => link.code).join());
  assert.ok(chain.some((link) => link.constructor.name === 'OutboundError' && link.kind === 'timeout'), 'the gate\'s remaining-deadline OutboundError is the cause');
  assert.deepEqual(world.effects(), { signatures: 0, transmissions: 0 });
  assert.ok(await fenceReleased(world.owner), 'the fence is released');
});

test('an oversized, malformed or wrongly shaped evidence or build answer is refused before use', async (t) => {
  const node = replayNode(), { inputs } = await qualificationInputs(t, { node });
  const evidence = evidenceAt(T0);
  const refusedEvidence = [
    ['oversized bytes', new Uint8Array(MIB4 + 1)],
    ['not JSON', new TextEncoder().encode('{"dirty":')],
    ['an extra key', { ...evidence, verified: true }],
    ['a missing key', (({ endpoint, ...rest }) => rest)(evidence)],
    ['a numeric commit', { ...evidence, commit: 1 }],
    ['a string observedAt', { ...evidence, observedAt: String(T0) }],
    ['repeated operations', { ...evidence, qualifiedOperations: ['fee', 'fee', 'nonce', 'broadcast'] }],
    ['an empty version', { ...evidence, reportedVersion: '' }],
  ];
  for (const [label, answer] of refusedEvidence) {
    const refusal = await refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs, readDeploymentEvidence: () => answer }), label);
    assert.equal(refusal.details, 'node_build_unverified', label);
  }
  assert.equal(node.reads.filter((read) => read === 'getNetworkInfo').length, 0, 'no refused evidence reached the node version read');
  for (const [label, response] of [['a null nodeVersion', { chainId: 1, nodeVersion: null }], ['a version list', { nodeVersion: ['0.9.9 RC'] }], ['a numeric version', { nodeVersion: { version: 1 } }],
    ['an overlong version', { nodeVersion: { version: 'v'.repeat(65) } }]]) {
    replyTo(node, 'getNetworkInfo', () => jsonResponse(ok(response)));
    assert.equal((await refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs }))).details, 'node_build_unverified', label);
  }
});

test('the eight-key evidence at exactly 13 values, depth 3 and four operation entries passes; 14 values, depth 4 or five entries each fail with the matching bounded-resolution limit cause before any signature', async (t) => {
  const world = await gatedWorld(t);
  const limits = [['14 values', { extra: 1 }, /value limit/], ['depth 4', { qualifiedOperations: [['fee'], 'nonce', 'broadcast', 'confirmation'] }, /depth limit/],
    ['five entries', { qualifiedOperations: ['fee', 'nonce', 'broadcast', 'confirmation', 'TEST-extra'] }, /list limit/]];
  for (const [label, change, cause] of limits) {
    world.controls.evidence = (clock) => ({ ...evidenceAt(clock.now()), ...change });
    const refusal = qualificationRefusal(await refusalOf(anchorEvidence(world, label.replaceAll(' ', '-'))));
    assert.equal(refusal?.details, 'node_build_unverified', label);
    assert.ok(refusal.cause instanceof RangeError && cause.test(refusal.cause.message), `${label}: ${refusal.cause?.message}`);
  }
  assert.deepEqual(world.effects(), { signatures: 0, transmissions: 0 });
  world.controls.evidence = (clock) => evidenceAt(clock.now());
  assert.equal((await anchorEvidence(world, 'at-the-limits')).status, 'submitted', 'the eight keys are 13 values at depth 3 with four entries');
});

// A getNetworkInfo answer of `values` values (the answer object counted), nested to `depth` and with one list of `entries`.
function networkInfoAt({ values = 256, depth = 8, entries = 64 } = {}) {
  let deep = 0;
  for (let level = depth; level > 2; level -= 1) deep = { [`level${level}`]: deep };
  const answer = { ...networkInfo(RECORDED_REVIEWED_BUILD.reportedVersion), list: Array(entries).fill(0), deep };
  // The answer, its forks (five values), chain id and version (two values), the list and the nested chain.
  const used = 1 + 5 + 1 + 2 + 1 + entries + (depth - 1);
  for (let pad = 0; pad < values - used; pad += 1) answer[`pad${pad}`] = 0;
  return answer;
}

test('a getNetworkInfo answer at exactly 256 values, depth 8 and 64 list entries passes; 257 values, depth 9 or 65 entries each fail with the matching bounded-resolution limit cause before any signature', async (t) => {
  const world = await gatedWorld(t);
  for (const [label, shape, cause] of [['257 values', { values: 257 }, /value limit/], ['depth 9', { depth: 9 }, /depth limit/], ['65 entries', { entries: 65 }, /list limit/]]) {
    replyTo(world.node, 'getNetworkInfo', () => jsonResponse(ok(networkInfoAt(shape))));
    const refusal = qualificationRefusal(await refusalOf(anchorEvidence(world, label.replaceAll(' ', '-'))));
    assert.equal(refusal?.details, 'node_build_unverified', label);
    assert.ok(refusal.cause instanceof RangeError && cause.test(refusal.cause.message), `${label}: ${refusal.cause?.message}`);
  }
  assert.deepEqual(world.effects(), { signatures: 0, transmissions: 0 });
  replyTo(world.node, 'getNetworkInfo', () => jsonResponse(ok(networkInfoAt())));
  assert.equal((await anchorEvidence(world, 'at-the-limits')).status, 'submitted');
});

// `json` followed by spaces to exactly `size` bytes.
const paddedTo = (json, size) => new TextEncoder().encode(json + ' '.repeat(size - Buffer.byteLength(json)));

test('evidence at exactly 4 MiB reaches bounded validation and one byte over gets the bounded-resolution byte-limit cause; getNetworkInfo at exactly 4 MiB reaches bounded validation and one byte over is refused by the client observer as node_build_unavailable with its capped-reply cause', async (t) => {
  const node = replayNode(), { inputs } = await qualificationInputs(t, { node });
  const evidence = JSON.stringify(evidenceAt(T0));
  assert.equal(typeof await assertQualifiedDeployment({ phase: 'preflight', ...inputs, readDeploymentEvidence: () => paddedTo(evidence, MIB4) }), 'string');
  const over = await refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs, readDeploymentEvidence: () => paddedTo(evidence, MIB4 + 1) }));
  assert.equal(over.details, 'node_build_unverified');
  assert.match(over.cause?.message, /byte limit/);
  const info = JSON.stringify(ok({ chainId: 1, nodeVersion: { version: RECORDED_REVIEWED_BUILD.reportedVersion } }));
  const sized = (size) => () => new Response(paddedTo(info, size), { headers: { 'content-type': 'application/json' } });
  replyTo(node, 'getNetworkInfo', sized(MIB4));
  assert.equal(typeof await assertQualifiedDeployment({ phase: 'preflight', ...inputs }), 'string');
  replyTo(node, 'getNetworkInfo', sized(MIB4 + 1));
  const capped = await refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs }));
  assert.equal(capped.details, 'node_build_unavailable');
  assert.ok(capped.cause instanceof Error, 'the observer\'s capped-reply error is the cause');
  assert.match(JSON.stringify(causeChain(capped.cause).map((link) => [link.code, link.kind, link.message])), /byte|limit|large/i);
});

test('a caller-supplied deployment pin or verifyDeployment on the source authorizes nothing', async (t) => {
  const { inputs } = await qualificationInputs(t);
  let verified = 0;
  const pinned = { ...inputs.source, pins: { deployment: { ...RECORDED_REVIEWED_BUILD, dirty: false } }, verifyDeployment: async () => { verified += 1; return true; } };
  const refusal = await refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs, source: pinned }));
  assert.equal(refusal.details, 'node_build_unverified', 'a copy of the source with a pin is not a registered source');
  const unreviewed = await refusalOf(assertQualifiedDeployment({ phase: 'preflight', ...inputs, readDeploymentEvidence: () => evidenceAt(T0, { commit: 'b'.repeat(40) }) }));
  assert.equal(unreviewed.details, 'node_build_unverified', 'the registered source cannot vouch for an unreviewed build');
  assert.equal(verified, 0, 'verifyDeployment is never called');
});

test('the authority class comes from the registered composition\'s declared publications: a TEST- declaration yields fixture and is refused as release evidence; no caller value sets the class', async (t) => {
  const world = await gatedWorld(t);
  const clock = world.options.clock;
  const fixtureInputs = { binding: world.admission.binding, currentLocal: world.admission.currentLocal, observer: world.wallet.observer, source: world.wallet.sourceCapability,
    readDeploymentEvidence: () => evidenceAt(T0), clock };
  const observation = await readQualificationObservation({ ...fixtureInputs, authorityClass: 'live' });
  assert.equal(observation.authorityClass, 'fixture');
  assert.throws(() => assertReleaseQualification(observation, shippedEntry(), { clock }), { code: 'deployment_unqualified', details: 'node_build_fixture' });
  const { inputs } = await qualificationInputs(t);
  assert.equal((await readQualificationObservation(inputs)).authorityClass, 'live', 'the observer source declares the binding\'s own TP-1 label');
});

test('payment-evidence signing and its confirm and broadcast transmissions, artifact CREATE signing and transmission, and the artifact recovery dispatch each run qualification inside their gate pass; the publish-entry check is preflight only', async (t) => {
  const world = await gatedWorld(t);
  const seen = [];
  world.controls.onRead = () => { seen.push([world.signatures.length, world.node.confirms.length, world.node.broadcasts.length]); };
  assert.equal((await anchorEvidence(world)).status, 'submitted');
  assert.deepEqual(seen.splice(0), [[0, 0, 0], [1, 0, 0], [1, 1, 0]], 'payment evidence: before the signature, the confirmation and the broadcast');
  assert.equal((await artifactCreate(world)).success, true);
  assert.deepEqual(seen.splice(0), [[1, 1, 1], [2, 1, 1], [2, 2, 1]], 'artifact CREATE: before the signature, the confirmation and the broadcast');

  // The artifact recovery dispatch: a CREATE the node acknowledged but never applied is resent from its retained bytes.
  const recovering = await gatedWorld(t);
  const listing = await listingPath(recovering, productionChain(recovering));
  assert.equal((await listing.send())?.success, true);
  const signedTransaction = await listing.retained();
  assert.ok(signedTransaction, 'the transport retained the signed CREATE');
  const recoverySeen = [];
  recovering.controls.onRead = () => { recoverySeen.push([recovering.signatures.length, recovering.node.confirms.length, recovering.node.broadcasts.length]); };
  assert.equal((await listing.resend(signedTransaction))?.disposition, 'pending');
  assert.deepEqual(recoverySeen, [[1, 1, 1], [1, 2, 1]], 'recovery: before its confirmation and before its resend, with nothing signed again');
  assert.equal(recovering.node.broadcasts.length, 2);

  // The publish-entry check is the same step run outside any pass: its answer authorizes no later pass.
  const preflighted = await gatedWorld(t);
  assert.equal(await preflighted.wallet.qualify({ phase: 'publish' }), preflighted.owner.currentLocal().connectionId);
  assert.equal(preflighted.controls.reads, 1);
  nodeVersionReply(preflighted.node, OTHER_VERSION);
  assert.equal(qualificationRefusal(await refusalOf(anchorEvidence(preflighted)))?.details, 'node_build_drift', 'the gate qualifies again inside the pass');
  assert.deepEqual(preflighted.effects(), { signatures: 0, transmissions: 0 });
});

// The condition each K0 barrier flips inside the qualification read, and how it is restored.
const barrierConditions = (world) => [
  ['KILL appears', () => writeFileSync(join(world.directory, 'KILL'), ''), null],
  ['the kit guard turns off', () => guard.setKitOperationGuardForTest('off'), () => guard.setKitOperationGuardForTest('testnet-tp1')],
  ['the client hold turns on', () => setPurchaseAdmission('held'), () => setPurchaseAdmission('testnet-tp1')],
  ['the approval closes', () => world.approval.withdraw(world.approval.grants.at(-1).requestText), null],
];

test('at a barrier inside the qualification read, KILL appears, the guard or hold flips, the approval closes, or the owner is replaced between passes: signer 0 before signing; after signing transport 0, the signed evidence kept and a withheld record written; the fence released', async (t) => {
  for (const signed of [false, true]) {
    for (let index = 0; index < 4; index += 1) {
      const directory = privateDataDirectory(t);
      const world = await gatedWorld(t, { directory, options: { stopped: createStopCheck(directory), approve: sellerApproval(recordingApproval({ manual: true })) } });
      const chain = productionChain(world, { stopped: createStopCheck(directory) });
      const [label, flip, restore] = barrierConditions(world)[index];
      let flipped = false;
      // The barrier: the first qualification read before the signature, or the first one after it.
      world.controls.onRead = () => { if (!flipped && (world.signatures.length > 0) === signed) { flipped = true; flip(); } };
      const refusal = await refusalOf(chain.ensure());
      restore?.();
      const name = `payment evidence, ${label}, ${signed ? 'after' : 'before'} signing`;
      assert.ok(flipped && refusal instanceof Error, name);
      assert.deepEqual(world.effects(), { signatures: signed ? 1 : 0, transmissions: 0 }, name);
      // The signer reservation keeps holding the signed bytes; this path writes no dispatch history.
      if (signed) assert.ok(await chain.kept(), `${name}: the signed evidence is kept`);
      assert.ok(await fenceReleased(world.owner), `${name}: the fence is released`);
    }
  }
  // After signing on the artifact path, whose transport writes its dispatch history: a withheld record follows the started one.
  for (let index = 0; index < 3; index += 1) {
    const directory = privateDataDirectory(t);
    const world = await gatedWorld(t, { directory, options: { stopped: createStopCheck(directory) } });
    const chain = productionChain(world, { stopped: createStopCheck(directory) });
    const [label, flip, restore] = barrierConditions(world)[index];
    let flipped = false;
    world.controls.onRead = () => { if (!flipped && world.signatures.length > 0) { flipped = true; flip(); } };
    const answer = await (await listingPath(world, chain)).send().catch((error) => error);
    restore?.();
    const name = `artifact CREATE, ${label}, after signing`;
    assert.ok(flipped && (answer instanceof Error || answer?.success === false), `${name}: refused`);
    assert.deepEqual(world.effects(), { signatures: 1, transmissions: 0 }, name);
    const history = await world.history();
    assert.ok(history.some((row) => / signed /.test(row)), `${name}: the signed CREATE is kept: ${history.join(' | ')}`);
    assert.ok(withheld(history), `${name}: a withheld record is written: ${history.join(' | ')}`);
    assert.ok(await fenceReleased(world.owner), `${name}: the fence is released`);
  }
  // The owner is replaced between passes: the closed owner's wallet qualifies nothing and opens no pass, and the replacement's
  // qualification answers its own connection only.
  const world = await gatedWorld(t);
  const replacement = await gatedWorld(t);
  await world.owner.close();
  const closed = await refusalOf(world.wallet.qualify({ phase: 'sign' }));
  assert.equal(closed.details, 'node_build_unavailable');
  assert.ok(closed.cause instanceof Error, 'the closed connection\'s error is the cause');
  await assert.rejects(productionChain(world).ensure());
  assert.equal(await replacement.wallet.qualify({ phase: 'sign' }), replacement.owner.currentLocal().connectionId);
  assert.deepEqual(world.effects(), { signatures: 0, transmissions: 0 });
});

// The authority changes the K0/K7 rows make on the same local generation: the observed chain, or the participant's authority.
const authorityChanges = (world) => [
  ['the observed chain changes', () => { world.authority.state.chainIdentity = OTHER_CHAIN; }, () => { world.authority.state.chainIdentity = APPROVED_CHAIN; }],
  ['a participant is revoked', () => { world.authority.state.failure = Object.assign(new Error('TEST-participant-revoked'), { code: 'TEST_participant_revoked' }); },
    () => { world.authority.state.failure = null; }],
];

test('on real native sends, session anchors and payment-evidence CREATEs, revoke a participant or change the observed chain without changing local generation during SDK preparation (regression coverage through refreshAuthority) or qualification (new qualification coverage): the fresh trusted authority read refuses with inner signatures 0, the original cause kept and the fence released', async (t) => {
  for (const when of ['preparation', 'qualification']) {
    for (const kind of ['payment-evidence CREATE', 'artifact CREATE']) {
      for (let index = 0; index < 2; index += 1) {
        const world = await gatedWorld(t);
        const chain = productionChain(world);
        const [label, change, restore] = authorityChanges(world)[index];
        const generation = world.owner.currentLocal().connectionId;
        if (when === 'qualification') world.controls.onRead = (n) => { if (n === 1) change(); };
        let refusal;
        if (kind === 'payment-evidence CREATE') {
          if (when === 'preparation') { const prepare = world.approval.prepare; world.approval.prepare = async (...args) => { change(); return prepare(...args); }; }
          refusal = await refusalOf(chain.ensure());
        } else {
          const { wallet, request } = await preparedWrite(world);
          if (when === 'preparation') change();
          refusal = await refusalOf(chain.runCreate(ARTIFACT_OP, async () => {
            const answer = await wallet.request(request);
            if (answer?.success === false) throw Object.assign(new Error(answer.error?.message), { code: answer.error?.code, answer });
            return answer;
          }));
        }
        restore();
        const name = `${kind}, ${label} during ${when}`;
        assert.equal(world.owner.currentLocal().connectionId, generation, `${name}: the local generation is unchanged`);
        assert.equal(world.signatures.length, 0, `${name}: no inner signature`);
        const codes = causeChain(refusal).map((link) => link.code);
        assert.ok(codes.some((code) => (index === 0 ? /^tp1_/.test(code ?? '') : code === 'TEST_participant_revoked')), `${name}: the original cause is kept: ${codes}`);
        assert.ok(await fenceReleased(world.owner), `${name}: the fence is released`);
      }
    }
  }
});

test('on real confirm/broadcast and recovery egress, revoke a participant or change the observed chain on the same local generation during qualification: fresh authority refuses after durable intent, transmissions 0, exact signed bytes retained, withheld history appended without erasing earlier possible dispatch, cause kept and fence released; restore evidence for the permitted explicit replay control', async (t) => {
  for (let index = 0; index < 2; index += 1) {
    const world = await gatedWorld(t);
    const chain = productionChain(world);
    const [label, change, restore] = authorityChanges(world)[index];
    // The first broadcast's answer is lost: it may have been dispatched.
    loseBroadcastAnswer(world);
    await refusalOf(chain.ensure());
    world.node.reply = null;
    const kept = await chain.kept();
    assert.ok(kept, `${label}: the signed bytes are kept`);
    const before = { ...world.effects(), history: await world.history() };
    const generation = world.owner.currentLocal().connectionId;
    world.controls.onRead = () => change();
    const refusal = await refusalOf(chain.ensure(), label);
    world.controls.onRead = null;
    restore();
    const codes = causeChain(refusal).map((link) => link.code);
    assert.ok(codes.some((code) => (index === 0 ? /^tp1_/.test(code ?? '') : code === 'TEST_participant_revoked')), `${label}: the cause is kept: ${codes}`);
    assert.equal(world.owner.currentLocal().connectionId, generation, `${label}: the local generation is unchanged`);
    assert.deepEqual(world.effects(), { signatures: before.signatures, transmissions: before.transmissions }, `${label}: no transmission`);
    // The payment-evidence reservation still holds the bytes: nothing it recorded is erased.
    assert.deepEqual((await world.history()).filter((row) => before.history.includes(row)), before.history, `${label}: the earlier possible dispatch is not erased`);
    assert.deepEqual(await chain.kept(), kept, `${label}: the exact signed bytes are retained`);
    assert.ok(await fenceReleased(world.owner), `${label}: the fence is released`);
    const broadcastsBefore = world.node.broadcasts.length;
    await chain.ensure();
    assert.equal(world.signatures.length, before.signatures, `${label}: the replay signs nothing new`);
    assert.equal(world.node.broadcasts.length, broadcastsBefore + 1, `${label}: the explicit replay sends once`);
    assert.equal(new Set(world.node.broadcasts.map((tx) => JSON.stringify(tx))).size, 1, `${label}: only the kept bytes are sent`);
  }
  // The artifact recovery egress: a CREATE the node acknowledged but never applied, resent while the authority changes.
  for (let index = 0; index < 2; index += 1) {
    const world = await gatedWorld(t);
    const listing = await listingPath(world, productionChain(world));
    const [label, change, restore] = authorityChanges(world)[index];
    await listing.send();
    const signedTransaction = await listing.retained();
    const before = { ...world.effects(), history: await world.history() };
    world.controls.onRead = () => change();
    // The transport answers a withheld resend as pending with no resend; the withheld record keeps the refusal's cause.
    const answer = await listing.resend(signedTransaction).catch((error) => error);
    world.controls.onRead = null;
    restore();
    const name = `artifact recovery, ${label}`;
    assert.ok(answer instanceof Error || answer?.noResend === true, `${name}: refused: ${JSON.stringify(answer)}`);
    assert.deepEqual(world.effects(), { signatures: before.signatures, transmissions: before.transmissions }, `${name}: no transmission`);
    const history = await world.history(), appended = history.filter((row) => !before.history.includes(row));
    assert.deepEqual(history.filter((row) => before.history.includes(row)), before.history, `${name}: the earlier possible dispatch is not erased`);
    assert.ok(withheld(appended), `${name}: a withheld record is appended: ${history.join(' | ')}`);
    assert.deepEqual(await listing.retained(), signedTransaction, `${name}: the exact signed bytes are retained`);
    assert.ok(await fenceReleased(world.owner), `${name}: the fence is released`);
    assert.equal((await listing.resend(signedTransaction))?.disposition, 'pending', `${name}: the explicit replay runs once authority is restored`);
    assert.equal(world.node.broadcasts.length, 2, `${name}: the replay sends once`);
    assert.equal(new Set(world.node.broadcasts.map((tx) => JSON.stringify(tx))).size, 1, `${name}: only the retained bytes are sent`);
  }
});

test('kill during post-intent qualification then reopen under drift and preserve unknown history', async (t) => {
  const directory = privateDataDirectory(t), stateDirectory = privateDataDirectory(t);
  const killed = await runWalletChild('qualify:3', directory, stateDirectory);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await restartedWorld(t, directory, stateDirectory);
  const history = await compositionHistory(world.wallet);
  const sentBefore = world.node.broadcasts.length;
  assert.equal(sentBefore, 0, 'the child was killed before its broadcast');
  nodeVersionReply(world.node, OTHER_VERSION);
  const drifted = await reconcileEvidence(world).then((answer) => ({ answer }), (error) => ({ error }));
  assert.ok(drifted.error ? qualificationRefusal(drifted.error)?.details === 'node_build_drift' : drifted.answer.status === 'pending', JSON.stringify(drifted.answer ?? causeChain(drifted.error).map((link) => link.code)));
  assert.equal(world.node.broadcasts.length, sentBefore, 'nothing is sent under drift');
  assert.equal(signatures.length, 0, 'nothing is signed again');
  assert.deepEqual((await compositionHistory(world.wallet)).filter((row) => history.includes(row)), history, 'the earlier dispatch history is kept');
  world.node.reply = null;
  const replay = await reconcileEvidence(world);
  assert.equal(replay.status, 'rebroadcast', JSON.stringify(replay));
  assert.equal(signatures.length, 0, 'the replay sends the kept bytes');
  assert.equal(world.node.broadcasts.length, 1);
});

test('a qualification result after the pass\'s deadline authorizes nothing; the gate\'s remaining-deadline OutboundError is the cause, signer or transport 0, and the fence released', async (t) => {
  const world = await gatedWorld(t);
  let answer;
  world.controls.onRead = () => new Promise((resolve) => { answer = resolve; });
  const passDeadlineMs = 5_000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const refused = refusalOf(inWalletPass(world, () => journalOverAdapter(world).anchorEvidence(evidenceInput(world)), { deadline: T0 + passDeadlineMs }));
  await flush();
  t.mock.timers.tick(passDeadlineMs);
  const refusal = await refused;
  answer();
  t.mock.timers.reset();
  await flush();
  assert.ok(causeChain(refusal).some((link) => link.constructor.name === 'OutboundError' && link.kind === 'timeout'), causeChain(refusal).map((link) => link.code).join());
  assert.deepEqual(world.effects(), { signatures: 0, transmissions: 0 });
  assert.ok(await fenceReleased(world.owner));
});

test('a passing observation is not reused as authority for a later write', async (t) => {
  const world = await gatedWorld(t);
  assert.equal((await anchorEvidence(world, 'first')).status, 'submitted');
  const readsAfterFirst = world.controls.reads;
  world.controls.evidence = (clock) => evidenceAt(clock.now(), { commit: 'b'.repeat(40) });
  assert.equal(qualificationRefusal(await refusalOf(anchorEvidence(world, 'second')))?.details, 'node_build_unverified');
  assert.equal(world.controls.reads, readsAfterFirst + 1, 'the later write read the evidence again');
  assert.deepEqual(world.effects(), { signatures: 1, transmissions: 2 });
});

test('a payment-evidence broadcast with signed bytes retained and evidence older than evidenceMaxAgeMs refuses node_build_unverified, sends zero transmissions, and retains the exact bytes for a qualified replay', async (t) => {
  const world = await gatedWorld(t);
  const chain = productionChain(world);
  loseBroadcastAnswer(world);
  await refusalOf(chain.ensure());
  world.node.reply = null;
  const kept = await chain.kept();
  assert.ok(kept, 'the signed bytes are kept');
  const sent = world.effects();
  world.controls.evidence = (clock) => evidenceAt(clock.now() - EVIDENCE_MAX_AGE_MS - 1);
  assert.equal(qualificationRefusal(await refusalOf(chain.ensure()))?.details, 'node_build_unverified');
  assert.deepEqual(world.effects(), sent, 'no transmission');
  assert.deepEqual(await chain.kept(), kept, 'the exact bytes are retained');
  world.controls.evidence = (clock) => evidenceAt(clock.now());
  const broadcastsBefore = world.node.broadcasts.length;
  await chain.ensure();
  assert.equal(world.node.broadcasts.length, broadcastsBefore + 1, 'the qualified replay sends once');
  assert.equal(new Set(world.node.broadcasts.map((tx) => JSON.stringify(tx))).size, 1, 'the replay sends the same bytes');
  assert.equal(world.signatures.length, sent.signatures, 'nothing is signed again');
});

test('the production readDeploymentEvidence verifies the package file against the pinned digest and deployer key, returns only the eight-key payload and cannot be replaced with a caller pin or fixture', async () => {
  const recordBytes = await readPackagedDeploymentRecord();
  const observedAt = JSON.parse(Buffer.from(recordBytes).toString('utf8')).payload.observedAt;
  const clock = { now: () => observedAt + 1 };
  const read = createVerifiedDeploymentEvidenceReader({ recordBytes, evidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS, clock });
  const payload = await read({});
  assert.deepEqual(Object.keys(payload).sort(), ['artifactSha256', 'chainIdentity', 'commit', 'dirty', 'endpoint', 'observedAt', 'qualifiedOperations', 'reportedVersion']);
  assert.deepEqual(payload, shippedBuildEvidence({ endpoint: payload.endpoint, observedAt }), 'the record names the reviewed build');
  // A fixture record signed by another key, offered with that key and its digest as caller pins: the reader keeps its own pins.
  const fixtureKey = testDeployerKey();
  const fixture = signedDeploymentRecord(payload, fixtureKey.privateKey);
  const withCallerPins = createVerifiedDeploymentEvidenceReader({ recordBytes: fixture.bytes, evidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS, clock, digest: fixture.digest,
    publicKey: fixtureKey.publicKey, testnetOnly: false });
  await assert.rejects(withCallerPins({}), { details: 'node_build_unverified' }, 'a fixture record with caller pins is not the pinned record');
  for (const bound of [EVIDENCE_MAX_AGE_MS - 1, EVIDENCE_MAX_AGE_MS + 1, undefined]) {
    assert.throws(() => createVerifiedDeploymentEvidenceReader({ recordBytes, evidenceMaxAgeMs: bound, clock }), TypeError, String(bound));
  }
  await assert.rejects(createVerifiedDeploymentEvidenceReader({ recordBytes, evidenceMaxAgeMs: EVIDENCE_MAX_AGE_MS, clock: { now: () => observedAt + EVIDENCE_MAX_AGE_MS + 1 } })({}),
    { details: 'node_build_unverified' }, 'an expired record');
});

test('a qualified node produces a live observation from the client\'s registered read-only source while the purchase hold is on; a forged or fixture source cannot become live', async (t) => {
  setPurchaseAdmission('held');
  const { inputs } = await qualificationInputs(t);
  const observation = await readQualificationObservation(inputs);
  assert.equal(observation.authorityClass, 'live');
  assert.ok(Object.isFrozen(observation) && Object.isFrozen(observation.evidence) && Object.isFrozen(observation.qualifiedOperations));
  assert.equal(observation.connectionGeneration, inputs.currentLocal().connectionId);
  const forged = Object.freeze({ ...inputs.source });
  assert.equal((await refusalOf(readQualificationObservation({ ...inputs, source: forged }))).details, 'node_build_unverified', 'a copy of the source is not registered');
  const other = await qualificationInputs(t);
  assert.equal((await refusalOf(readQualificationObservation({ ...inputs, observer: other.inputs.observer }))).details, 'node_build_drift',
    'another owner\'s observer reads another connection');
  assert.equal((await refusalOf(readQualificationObservation({ ...inputs, observer: other.inputs.observer, currentLocal: other.inputs.currentLocal }))).details,
    'node_build_unverified', 'a source registered for another owner is not this one\'s');
  const fixture = Object.freeze({ ...inputs.source, settlementPublication: Object.freeze({ authority: 'TEST-forged' }) });
  assert.equal((await refusalOf(readQualificationObservation({ ...inputs, source: fixture }))).details, 'node_build_unverified');
});

test('no socket or DNS lookup leaves the process in the node qualification suite', () => {
  assert.deepEqual({ network: networkTrap.calls, lookups }, { network: [], lookups: [] });
});
