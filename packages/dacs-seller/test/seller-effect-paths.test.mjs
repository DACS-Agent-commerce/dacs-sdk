// The seller's effect paths. The CREATE lanes at the artifact anchor's publish, over the production wallet session: every
// refusal is raised before publish reaches the wallet, with no stored intent and no signature, and a refusal before the admitted
// binding check makes no node read.
// The agent's signatures and the answer that carries its Agreement co-signature, through the host's effect boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as core from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, TP1_APPROVED_IDENTITY_RECORD, WireError, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { T0, evidenceInput, inWalletPass, jsonResponse, privateDataDirectory, replyTo, runWalletChild, sellerApproval, sellerWalletWorld,
  spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';
import { walletSessionWorld } from './helpers/seller-wallet-session-world.mjs';
import { approvingChainJournal, causeCodes, heldOperator, holdableStop, journalOverAdapter, journalOverPass, manualSellerApproval,
  PAYMENT_EVIDENCE_JOURNAL } from './helpers/payment-evidence-test-journals.mjs';
import { evidenceInput as chainEvidenceInput, newWalletChainState, walletChain } from './helpers/payment-evidence-wallet-chain.mjs';
import { recordingApproval } from '../../dacs-client/test/helpers/payment-evidence-approval-double.mjs';

// Static imports are all resolved before any module runs, so a module that reaches the client's admission state must be imported
// after the world helper above has installed the purchase-admission hook.
const { anchorFixture, signSdkCreate } = await import('./helpers/anchor-isolated-fixture.mjs');
const { agentFixture, fixtureProposal } = await import('./helpers/seller-agent-isolated-fixture.mjs');
const { countedKeyRoles } = await import('./helpers/counted-key-roles.mjs');
const { proposalWireWorld } = await import('./helpers/proposal-wire-world.mjs');
const { PATHS } = await import('./helpers/wire-routes-world.mjs');
const { MONOTONIC_CLOCK, TEST_BINDING, TEST_PASS_SESSION, integrityRoleOf, readOnlyRoleOf, testEffectBoundary, testRunCreate } = await import('./helpers/agent-signing.mjs');
const { createSellerCreatePass, isSellerCreatePass, lateSellerCreatePass } = await import('../src/devnet-demo/create-pass.mjs');
const { signInPass, signRetainedInPass } = await import('../src/devnet-demo/wallet-signature-pass.mjs');
const { createAnswerSigners } = await import('../src/dacs/answer-signers.mjs');
const { createStopCheck } = await import('../src/kill-switch.mjs');
const { createSellerAgentClient } = await import('../src/dacs/seller-http.mjs');
const { createWireContext } = await import('../src/dacs/seller-wire-requests.mjs');
const { orchestratorFixture } = await import('./helpers/vet-orchestrator-fixture.mjs');
const { productionFixture } = await import('./helpers/vet-production-fixture.mjs');
const { contextHostFixture } = await import('./helpers/host-context-client.mjs');
const { JOB: protocolJob, seller: protocolSeller } = await import('./helpers/protocol-fixture.mjs');
const { composedVetHost, composedVetHostProcess, vetRecordAnchor } = await import('./helpers/composed-vet-host.mjs');
const { default: Database } = await import('better-sqlite3');
const { world: wireWorld, proposeJob, identityBody } = await import('./helpers/wire-routes-world.mjs');
const { authorityReader } = await import('./helpers/wire-authority-fixture.mjs');
const { SELLER_STATE_SIGNING_DOMAIN } = await import('../src/dacs/seller-durable-state.mjs');
const { LOCAL: KEY_LOCAL, discoveryPayload, testBinding: keyTestBinding, wire: wireApi } = await import('./helpers/seller-key-fixture.mjs');
const { TEST_CONNECTION } = await import('./helpers/wire-authority-fixture.mjs');
const { JOBS } = await import('./helpers/bilateral-vet-fixture.mjs');
const guard = await import('../src/kit-operation-guard.mjs');
const { createDevnetDemoArtifactAnchor } = await import('../src/devnet-demo/artifact-anchor.mjs');
const { createDevnetDemoListingPublisher } = await import('../src/devnet-demo/listing.mjs');
const { createDevnetDemoDeliveryCapability } = await import('../src/devnet-demo/native-delivery.mjs');
const { submitNativeDemDelivery } = await import('../src/dacs/native-dem-delivery-consumer.mjs');
const { fixtureListing } = await import('./fixtures/listings.mjs');
const { createSellerAgent } = await import('../src/dacs/seller-agent.mjs');
const { createSellerDurableState } = await import('../src/dacs/seller-durable-state.mjs');
const { WRITE_FEE_CEILING_OS, createEffectBoundary } = await import('../src/dacs/effect-boundary.mjs');
const { createEffectHistory } = await import('../src/dacs/effect-history.mjs');
const { createDemDeliveryContext } = await import('../src/dacs/dem-delivery-context-consumer.mjs');
const { anchorWriteMessage } = await import('../src/dacs/fixture-anchors.mjs');

const JOB_ID = '01M5YKPJG0248H248H248H248H';
const LISTING_ADDRESS = 'dacs1:listing:fixture-report:1';
const PASS = Object.freeze({ operationClass: 'job-create', currentAuthorization: () => true });
const railAuthority = () => ({ trustPhase: 'PA-1', trustPolicyAcceptsPA1: true, registry: { state: 'not-used', entries: [], definitions: [] },
  inCodeDefinitions: [{ railId: 'demos-native:DEM', railVersion: 1, phaseHandler: 'pay-dem', governanceAnchoring: 'in-code', signatureValid: true }] });
// The job lanes' publish inputs; the guard and the parameter check refuse before the artifact is read.
const JOB_LANES = [
  ['commitment', { logicalAddress: `dacs3:commit:${JOB_ID}`, artifactKind: 'FinalityCommitmentRecord', artifact: {} }],
  ['delivery SettlementEvidence', { logicalAddress: `dacs4:evidence:${JOB_ID}`, artifactKind: 'SettlementEvidence', artifact: {} }],
  ['counterparty Vet', { logicalAddress: `dacs2:composite:${JOB_ID}:counterparty`, artifactKind: 'CompositeVerificationRecord', artifact: {}, verifier: 'did:demos:agent:TEST' }],
  ['seller\'s own Vet', { logicalAddress: `dacs2:composite:${JOB_ID}:seller`, artifactKind: 'CompositeVerificationRecord', artifact: {} }],
];

// The production port finalized over the scripted node, with authority reads counted; `baseline()` zeroes every counter.
async function finalizedWorld(t) {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await walletSessionWorld(t, { countAuthority: true });
  const { session } = await world.finalize();
  world.baseline = () => { world.authorityReads = 0; world.node.reads.length = 0; signatures.length = 0; };
  world.effects = () => ({ authorityReads: world.authorityReads, nodeReads: [...world.node.reads], signatures: signatures.length });
  return { world, session, anchor: world.port.artifactAnchor };
}
const NOTHING = Object.freeze({ authorityReads: 0, nodeReads: [], signatures: 0 });
// An admitted publish makes one authority read, the node's block read behind the binding check, and then refuses the unqualified
// deployment, before any nonce read or signature.
const BINDING_READ_ONLY = Object.freeze({ authorityReads: 1, nodeReads: ['getBlockByNumber'], signatures: 0 });
// The Listing's own signature pass checks the binding three times before its signer (the boundary's pre-checks, the session
// pass's refresh and signPass's pre-checks), each with one authority read and its block read; then its publish reads as above.
const SIGNED_LISTING_BINDING_READS = Object.freeze({ authorityReads: 4, nodeReads: Array(4).fill('getBlockByNumber'), signatures: 0 });

// The Listing publisher over `anchor`, with the world's signer and the port's runCreate, and the Listing draft it publishes.
function listingPublisher(world, anchor) {
  const publish = createDevnetDemoListingPublisher({ anchor, sign: (bytes) => world.signer.signBytes(bytes), scanOwnListings: async () => ({ status: 'ok', anchors: [] }),
    loadRailResolution: railAuthority, runCreate: world.port.runCreate });
  const draft = fixtureListing(world.signer, { now: T0 });
  delete draft.signature;
  return { publish, draft };
}

test('the artifact anchor is built only with runCreate: without it construction throws a TypeError before the wallet factory is asked', async (t) => {
  const { session } = await finalizedWorld(t);
  let walletFactoryCalls = 0;
  assert.throws(() => createDevnetDemoArtifactAnchor({ sourceCapability: session.transport, walletFactory: () => { walletFactoryCalls += 1; } }),
    { name: 'TypeError', message: 'runCreate from createSellerCreatePass is required' });
  assert.equal(walletFactoryCalls, 0);
});

test('with the guard off, the Listing and the five job CREATE lanes refuse kit_operation_guard_off at publish or in their caller, before any read, with no intent stored and nothing signed', async (t) => {
  const { world, anchor } = await finalizedWorld(t);
  const { publish: publishListing, draft } = listingPublisher(world, anchor);
  const delivery = createDevnetDemoDeliveryCapability({ authority: anchor.authority, anchor });
  world.baseline();
  guard.setKitOperationGuardForTest('off');
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  await assert.rejects(publishListing(draft), { code: 'kit_operation_guard_off' }, 'the Listing publisher');
  await assert.rejects(submitNativeDemDelivery(delivery, { logicalAddress: `dacs4:deliverable:${JOB_ID}` }, () => true), { code: 'kit_operation_guard_off' }, 'the Deliverable');
  for (const [label, input] of JOB_LANES) await assert.rejects(anchor.publish({ ...input, ...PASS }), { code: 'kit_operation_guard_off' }, label);
  guard.setKitOperationGuardForTest('testnet-tp1');
  assert.deepEqual(world.effects(), NOTHING);
  for (const address of [LISTING_ADDRESS, `dacs4:deliverable:${JOB_ID}`, ...JOB_LANES.map(([, input]) => input.logicalAddress)]) {
    assert.equal(await anchor.hasIntent(address), false, `no intent for ${address}`);
  }
});

test('a publish without its pass operationClass or currentAuthorization check refuses at publish\'s parameter check, before any read, storing no intent and signing nothing', async (t) => {
  const { world, anchor } = await finalizedWorld(t);
  const input = { logicalAddress: LISTING_ADDRESS, artifact: fixtureListing(world.signer, { now: T0 }), artifactKind: 'Listing' };
  world.baseline();
  for (const [label, pass] of [['neither', {}], ['no check', { operationClass: 'job-create' }], ['no class', { currentAuthorization: () => true }],
    ['a check that is not a function', { operationClass: 'job-create', currentAuthorization: true }]]) {
    await assert.rejects(anchor.publish({ ...input, ...pass }), { code: 'invalid', message: /operationClass and currentAuthorization/ }, label);
  }
  await assert.rejects(anchor.publish({ ...input, ...PASS }), { code: 'deployment_unqualified' }, 'with both it passes the parameter check');
  assert.deepEqual(world.effects(), BINDING_READ_ONLY);
  assert.equal(await anchor.hasIntent(LISTING_ADDRESS), false);
});

test('the Listing publisher passes operationClass job-create and its publication check: over the real session its publish passes publish\'s parameter check and stops at deployment_unqualified, storing no intent, while a publish without them refuses at the parameter check', async (t) => {
  const { world, anchor } = await finalizedWorld(t);
  const inputs = [];
  const recording = Object.freeze({ ...anchor, publish: (input) => { inputs.push(input); return anchor.publish(input); } });
  const { publish, draft } = listingPublisher(world, recording);
  world.baseline();
  const refusal = await publish(draft).then(() => assert.fail('expected a refusal'), (error) => error);
  const codes = [];
  for (let link = refusal; link instanceof Error; link = link.cause) codes.push(link.code);
  assert.ok(codes.includes('deployment_unqualified'), `the publish passed the parameter check: ${codes} ${refusal}`);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].operationClass, 'job-create');
  assert.equal(inputs[0].currentAuthorization(), true);
  const withoutPass = { ...inputs[0] };
  delete withoutPass.operationClass;
  delete withoutPass.currentAuthorization;
  await assert.rejects(anchor.publish(withoutPass), { code: 'invalid' }, 'the same publish without them');
  assert.deepEqual(world.effects(), SIGNED_LISTING_BINDING_READS);
  assert.equal(await anchor.hasIntent(inputs[0].logicalAddress), false, 'no intent was stored');
});

// A runCreate that refuses before it calls its work, as the kit boundary's pre-checks do when the seller is stopping.
const refusingRunCreate = async () => { throw Object.assign(new Error('TEST-seller-stopping'), { code: 'seller_stopped' }); };
const FIXTURE_JOB = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

test('a runCreate refusal after publish stored its intent makes no CREATE, and the intent it leaves is read as unsigned, so the next publish asks the wallet once from the same nonce', async () => {
  const f = await anchorFixture();
  f.controls.runCreate = refusingRunCreate;
  await assert.rejects(f.publish(f.open(), FIXTURE_JOB), { code: 'seller_stopped' });
  assert.equal(f.captured.length, 0, 'the wallet was never asked');
  assert.deepEqual([...f.journal.rows.values()].map(({ stage }) => stage), ['intent'], 'only the intent is stored');
  f.controls.runCreate = undefined;
  await f.publish(f.open(), FIXTURE_JOB);
  assert.deepEqual(f.captured.map(({ transaction }) => transaction.content.nonce), [1], 'the retry asked the wallet once, from the nonce the refused attempt never used');
});

test('a runCreate stop refusal before a retained CREATE\'s resend leaves the read answering its readback, records no recovery intent and sends nothing, so the one resend stays open for the next read', async () => {
  const f = await anchorFixture({ signRpc: async () => 'TEST-rpc-auth' }), resends = [];
  f.source.binding = async () => ({ disposition: 'pending' });
  f.source.recoverStorageWrite = async ({ signedTransaction }) => { resends.push(signedTransaction.hash); return {}; };
  f.controls.request = async (request) => {
    const signedTransaction = await signSdkCreate(request.transaction), hash = signedTransaction.hash;
    await f.journal.put(`demo/wallet/${request.jobId}`, { stage: 'broadcast-started', hash, signedTransaction });
    await f.sourceJournal.put(`source/${request.jobId}`, { stage: 'signed', hash, signedTransaction });
    return { success: false, error: { code: 'internal_error' } };
  };
  await f.publish(f.open(), FIXTURE_JOB);
  const { input } = [...f.journal.rows.values()].find((row) => row.input);
  const resend = { resend: true, authorizeResend: () => true };
  f.controls.runCreate = refusingRunCreate;
  assert.equal(typeof (await f.open().read(input, resend)).status, 'string', 'the stopped read answers its readback');
  assert.deepEqual(resends, [], 'nothing was resent');
  assert.equal([...f.journal.rows.keys()].some((key) => key.startsWith('demo/recovery/')), false, 'no recovery intent was recorded');
  f.controls.runCreate = undefined;
  await f.open().read(input, resend);
  assert.equal(resends.length, 1, 'the next read used the one resend');
});

// ---- The agent's signatures and the answer that carries its Agreement co-signature ----

const AGREEMENT_PREFIX = 'dacs-payee-bound-agreement:v1:';
const ANCHOR_PREFIX = anchorWriteMessage('', '').slice(0, -1);
const isAgreement = (bytes) => Buffer.from(bytes).toString().startsWith(AGREEMENT_PREFIX);
const isAnchorWrite = (bytes) => Buffer.from(bytes).toString().startsWith(ANCHOR_PREFIX);
const laneStates = async (directory, jobId) => (await createEffectHistory({ dataDirectory: directory }).read(`job-${jobId}`)).map((record) => record.state);
const signedOperations = async (directory, jobIds) => {
  const history = createEffectHistory({ dataDirectory: directory });
  return (await Promise.all(jobIds.map((jobId) => history.read(`job-${jobId}`)))).flat().filter((record) => record.state === 'signed').map((record) => record.operationId);
};
// The world's next proposal answer is computed and signed as a response, then `change(w)` runs before its answer pass writes it.
const changeBeforeAnswerWritten = (w, change) => {
  const receive = w.agent.receiveProposal;
  w.agent.receiveProposal = (...args) => {
    w.agent.receiveProposal = receive;
    w.signing.before = (bytes) => {
      assert.ok(Buffer.from(bytes).toString().startsWith(DACS_SELLER_HTTP_DOMAINS.response), 'the next signature is the answer\'s');
      change(w);
    };
    return receive(...args);
  };
};
// Moves the wire's clock past the open attempt's lease, so the next request recovers it.
const pastLease = (w) => { w.state.time += w.leaseMs + 1; };
const readState = async (w) => w.send(PATHS.state, await w.buyerWire.signRequest(PATHS.state, { transportIdentity: w.body.transportIdentity },
  { jobId: w.jobId, agreementHash: w.body.transportIdentity.agreementHash }));

test('an answer that carries a new co-signature is withheld when the stop check or the guard flips before it is written, and a signed refusal goes out instead', async (t) => {
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  for (const [label, flip, unflip, code] of [
    ['the stop check', (w) => { w.f.stop.requested = true; }, (w) => { w.f.stop.requested = false; }, 'seller_stopped'],
    ['the guard', () => guard.setKitOperationGuardForTest('off'), () => guard.setKitOperationGuardForTest('testnet-tp1'), 'kit_operation_guard_off'],
  ]) {
    const w = await proposalWireWorld(t);
    changeBeforeAnswerWritten(w, flip);
    const withheld = await w.post();
    unflip(w);
    assert.deepEqual([withheld.body.error, withheld.signed, withheld.body.contribution], [code, true, undefined], `${label}: a signed refusal, with no co-signature`);
    assert.equal(w.agreementSignatures(), 1, `${label}: the Agreement was signed once`);
    assert.deepEqual(await laneStates(w.f.effectsDirectory, w.jobId), ['signed'], `${label}: the signature is held, never dispatched`);
    pastLease(w);
    const answered = await w.post();
    assert.deepEqual([answered.status, answered.body.disposition], [200, 'complete'], `${label}: the next request answers the held signature`);
    assert.equal(w.agreementSignatures(), 1, `${label}: nothing new was signed`);
    assert.equal((await laneStates(w.f.effectsDirectory, w.jobId)).at(-1), 'dispatch-acknowledged', label);
  }
});

test('an agent composed without the host\'s effect boundary refuses at construction; the non-durable branch signs only as the boundary\'s inner signer, refusing a wrong identity and signing the approved control', async (t) => {
  const counted = { agreementSignatures: 0 };
  const w = await agentFixture({ memory: true });
  t.after(() => w.close());
  const effectSigner = { claim: w.seller.claim, sign: (bytes) => { if (isAgreement(bytes)) counted.agreementSignatures++; return w.seller.sign(bytes); } };
  const integritySigner = integrityRoleOf(effectSigner);
  const history = mkdtempSync(join(tmpdir(), 'TEST-agent-identity-'));
  t.after(() => rmSync(history, { recursive: true, force: true }));
  const boundaryOver = (connection) => createEffectBoundary({ stopped: () => false, binding: TEST_BINDING, currentLocal: () => ({ ...connection }), feeCeilingOs: String(WRITE_FEE_CEILING_OS),
    history: createEffectHistory({ dataDirectory: history }), clock: MONOTONIC_CLOCK });
  for (const [label, signing] of [
    ['no boundary', { effectSigner, integritySigner }],
    ['an object that is not the host\'s boundary', { effectSigner, integritySigner, effectBoundary: { signPass: () => {} } }],
    ['no effect role', { integritySigner, effectBoundary: boundaryOver(TEST_CONNECTION) }],
    ['no integrity role', { effectSigner, effectBoundary: boundaryOver(TEST_CONNECTION) }],
  ]) await assert.rejects(createSellerAgent({ ...w.config, ...signing }), TypeError, label);
  const negotiate = async (effectBoundary) => {
    const agent = await createSellerAgent({ ...w.config, effectSigner, integritySigner, readOnlyAnswerSigner: readOnlyRoleOf(effectSigner), effectBoundary });
    try { return await agent.receiveProposal((await fixtureProposal(w.listing, JOBS[0])).body); } finally { agent.close(); }
  };
  const refused = await negotiate(boundaryOver({ ...TEST_CONNECTION, connectionId: 'TEST-other-connection' }));
  assert.notEqual(refused.disposition, 'complete', 'a connection other than the bound identity signs nothing');
  assert.equal(counted.agreementSignatures, 0, 'the effect role was never called');
  const approved = await negotiate(boundaryOver(TEST_CONNECTION));
  assert.equal(approved.disposition, 'complete', 'the approved control signs');
  assert.equal(counted.agreementSignatures, 1, 'once');
});

test('journal-authentication signatures sign only their local domain, never enter the effect boundary, and persisting boundary evidence starts no nested pass; the durable state is built with the integrity role only and holds no effect signer; integrity signatures are counted apart from effect signatures, and the integrity role refuses Agreement, commitment, evidence and wire bytes with no cryptographic signer call', async (t) => {
  const roles = await countedKeyRoles(t);
  const w = await agentFixture({ roles });
  t.after(() => w.close());
  assert.equal((await w.agent.commit({ jobId: JOBS[0] })).status, 'committed');
  const effectSignatures = roles.counts.effect;
  assert.ok(roles.counts.integrity > 0 && effectSignatures > 0, 'both roles signed, each counted on its own');
  assert.deepEqual((await signedOperations(w.effectsDirectory, JOBS)).sort(), roles.effectBytes.map((bytes) => `signature-${core.sha256Hex(bytes)}`).sort(),
    'the boundary recorded each effect signature once and no journal signature, and the run finished with no nested pass waiting on its fence');

  const directory = mkdtempSync(join(tmpdir(), 'TEST-integrity-only-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const integrityBefore = roles.counts.integrity;
  const state = await createSellerDurableState({ dir: directory, integritySigner: roles.integritySigner, listingPin: w.pin });
  t.after(() => state.close());
  assert.ok(roles.counts.integrity > integrityBefore, 'a new store signs its journal with the integrity role');
  const agreementBytes = roles.effectBytes.find(isAgreement), beforeSignOnce = { ...roles.counts };
  await state.withJob(JOBS[0], () => {
    assert.throws(() => state.signOnce(`signature:${core.sha256Hex(agreementBytes)}`, agreementBytes), /seller_effect_signer_required/, 'the store has no effect signer of its own');
    assert.deepEqual(roles.counts, beforeSignOnce, 'refused before its intent: nothing was signed');
    assert.throws(() => state.signOnce(`signature:${core.sha256Hex(agreementBytes)}`, agreementBytes, roles.integritySigner.sign), { code: 'seller_key_role_refused' }, 'the integrity role signs no effect');
  });
  assert.deepEqual(roles.counts, { effect: beforeSignOnce.effect, integrity: beforeSignOnce.integrity + 1, readOnly: 0 }, 'the only signature was the intent\'s journal record');
  const counts = { ...roles.counts };
  const wireBytes = Buffer.from(`${DACS_SELLER_HTTP_DOMAINS.response}{}`);
  for (const bytes of [...roles.effectBytes, wireBytes]) assert.throws(() => roles.integritySigner.sign(bytes), { code: 'seller_key_role_refused' });
  assert.deepEqual(roles.counts, counts, 'none of the refusals made a cryptographic call');
});

test('durable and non-durable simulated fixture anchoring awaits the shared authorization under the effect boundary before the synchronous validation transaction, whose closure returns the retained signature bytes synchronously; a settlement change refuses before anchoring, the unchanged controls anchor once, no promise reaches the signature bytes, and effect and integrity calls are counted apart', async (t) => {
  const roles = await countedKeyRoles(t);
  // After an anchor authorization is signed, the pass's next stop check runs `beforeAnchor`, while the pass is still open.
  const hook = { armed: false, beforeAnchor: null };
  const effectSigner = { claim: roles.effectSigner.claim, sign: (bytes) => { const signature = roles.effectSigner.sign(bytes); if (isAnchorWrite(bytes) && hook.beforeAnchor) hook.armed = true; return signature; } };
  const stopped = async () => { if (hook.armed) { hook.armed = false; await hook.beforeAnchor(); } return false; };
  const w = await agentFixture({ roles: { effectSigner, integritySigner: roles.integritySigner }, stopped });
  t.after(() => w.close());
  const pay = (jobId, txHash) => w.agent.submitPayment({ jobId, txHash, payerPayingKey: w.buyer.claim });
  const anchorSignatures = () => roles.effectBytes.filter(isAnchorWrite).length;

  const integrityBefore = roles.counts.integrity, buyerWrites = w.anchors.writes.length;
  assert.equal((await w.agent.commit({ jobId: JOBS[0] })).status, 'committed');
  assert.equal((await pay(JOBS[0], 'a'.repeat(64))).status, 'delivered', 'the durable control anchors');
  // The local anchor accepts a write only when its writer signature verifies over the exact write message.
  const sellerWrites = w.anchors.writes.slice(buyerWrites);
  assert.ok(sellerWrites.length > 0 && sellerWrites.every((address) => w.anchors.rows.get(address)?.receipt.evidence.kind === 'fixture-writer-signature'), 'every anchor write carries a verified signature');
  assert.equal(anchorSignatures(), sellerWrites.length, 'one authorization per anchor write');
  assert.ok(roles.counts.integrity > integrityBefore && roles.counts.effect === roles.effectBytes.length, 'the journal writes used the integrity role; each effect signature one call');

  assert.equal((await w.agent.commit({ jobId: JOBS[1] })).status, 'committed');
  const writes = w.anchors.writes.length, authorized = anchorSignatures();
  hook.beforeAnchor = async () => {
    const session = w.store.loadSession(JOBS[1]), settlementId = session.paymentWork?.intake?.settlementId ?? session.payment?.settlementId;
    await w.store.withJob(JOBS[0], () => w.store.bindSettlement(settlementId, JOBS[0], { jobId: JOBS[0], phaseIndex: 2 }));
  };
  const contested = await pay(JOBS[1], 'b'.repeat(64)).catch((error) => ({ status: error.code }));
  hook.beforeAnchor = null;
  assert.notEqual(contested.status, 'delivered');
  assert.equal(anchorSignatures(), authorized + 1, 'the authorization was signed under its pass');
  assert.equal(w.anchors.writes.length, writes, 'the settlement change refused before the anchor transaction');

  const memory = await agentFixture({ memory: true, roles: { effectSigner, integritySigner: roles.integritySigner } });
  t.after(() => memory.close());
  const memoryWrites = memory.anchors.writes.length;
  assert.equal((await memory.agent.commit({ jobId: JOBS[0] })).status, 'committed');
  assert.equal((await memory.agent.submitPayment({ jobId: JOBS[0], txHash: 'c'.repeat(64), payerPayingKey: memory.buyer.claim })).status, 'delivered', 'the non-durable control anchors');
  const added = memory.anchors.writes.slice(memoryWrites);
  assert.ok(added.length > 0 && added.every((address) => memory.anchors.rows.get(address)?.receipt.evidence.kind === 'fixture-writer-signature'), 'every non-durable anchor write carries a verified signature');
});

test('an answer withheld after its co-signature was retained leaves held evidence in its job\'s history; after a restart neither the retried proposal nor the Agreement state read returns the held signature while the seller is stopped, and a lost answer makes no new Agreement signature', async (t) => {
  const w = await proposalWireWorld(t);
  changeBeforeAnswerWritten(w, () => { w.f.stop.requested = true; });
  assert.equal((await w.post()).body.error, 'seller_stopped');
  assert.deepEqual(await laneStates(w.f.effectsDirectory, w.jobId), ['signed'], 'the signature is held, never dispatched');
  await w.restart();
  pastLease(w);
  const retried = await w.post(), read = await readState(w);
  assert.deepEqual([retried.body.contribution, read.body.contribution], [undefined, undefined], 'no answer carries the held signature');
  assert.deepEqual([retried.body.error, read.body.error], ['seller_stopped', 'seller_stopped']);
  w.f.stop.requested = false;
  const state = await readState(w);
  assert.equal(state.status, 200);
  assert.equal(typeof state.body.contribution?.signature?.value, 'string', 'once admitted, the state read returns the retained signature');
  assert.equal(w.agreementSignatures(), 1, 'the lost answer made no new Agreement signature');
});

test('a repeated proposal answered from the completed-answer cache carries its co-signature only through its answer pass: while the seller is stopped it is refused with no co-signature and nothing recorded, and once admitted the same answer is sent with its dispatch recorded and no new signature', async (t) => {
  const w = await proposalWireWorld(t);
  const first = await w.post();
  assert.deepEqual([first.status, typeof first.body.contribution?.signature?.value], [200, 'string']);
  const recorded = await laneStates(w.f.effectsDirectory, w.jobId);
  w.f.stop.requested = true;
  const stopped = await w.post();
  assert.deepEqual([stopped.body.error, stopped.signed, stopped.body.contribution], ['seller_stopped', true, undefined], 'a signed refusal, with no co-signature');
  assert.deepEqual(await laneStates(w.f.effectsDirectory, w.jobId), recorded, 'the refused repeat recorded nothing');
  w.f.stop.requested = false;
  const repeated = await w.post();
  assert.deepEqual([repeated.status, repeated.text], [200, first.text], 'the completed answer, as it was first sent');
  assert.deepEqual((await laneStates(w.f.effectsDirectory, w.jobId)).slice(recorded.length), ['dispatch-started', 'dispatch-acknowledged']);
  assert.equal(w.agreementSignatures(), 1, 'nothing new was signed');
});

test('a repeated proposal whose cached answer carries a co-signature the agent no longer names for that proposal is refused, never sent without its answer pass', async (t) => {
  const w = await proposalWireWorld(t);
  assert.equal((await w.post()).status, 200);
  const recorded = await laneStates(w.f.effectsDirectory, w.jobId);
  w.agent.agreementState = () => ({ proposal: null, contribution: null });
  const refused = await w.post();
  assert.deepEqual([refused.status, refused.body.error, refused.body.contribution], [409, 'cosignature_answer_unavailable', undefined]);
  assert.deepEqual(await laneStates(w.f.effectsDirectory, w.jobId), recorded);
});

// The state of the job's last boundary record, read synchronously at the moment an answer is written.
const lastLaneState = (directory, jobId) => {
  const lane = join(directory, 'effects', `job-${jobId}`);
  return JSON.parse(readFileSync(join(lane, readdirSync(lane).filter((name) => name.endsWith('.json')).sort().at(-1)), 'utf8')).state;
};

test('a co-signature answer sent outside the agent\'s job lock (a repeated proposal served from the cache, and a state read) is written inside its answer pass, after the pass\'s checks and before its acknowledgement is recorded', async (t) => {
  const w = await proposalWireWorld(t);
  assert.equal((await w.post()).status, 200);
  const atWrite = [];
  const handler = w.handle.handler;
  w.handle.handler = (req, res) => {
    const end = res.end;
    res.end = function (text) { atWrite.push(lastLaneState(w.f.effectsDirectory, w.jobId)); return end.call(this, text); };
    return handler(req, res);
  };
  const answers = [await w.post(), await readState(w)];
  assert.deepEqual(answers.map((answer) => [answer.status, typeof answer.body.contribution?.signature?.value]), [[200, 'string'], [200, 'string']]);
  assert.deepEqual(atWrite, ['dispatch-started', 'dispatch-started'], 'each answer went out while its pass held the dispatch open');
  assert.equal((await laneStates(w.f.effectsDirectory, w.jobId)).at(-1), 'dispatch-acknowledged');
});

// Wraps the world's handler: `at.states` collects the job's last boundary record at each write of an answer, and `at.response` is the
// response being answered.
const watchResponses = (w) => {
  const at = { states: [], response: null };
  const handler = w.handle.handler;
  w.handle.handler = (req, res) => {
    at.response = res;
    const end = res.end;
    res.end = function (text) { at.states.push(lastLaneState(w.f.effectsDirectory, w.jobId)); return end.call(this, text); };
    return handler(req, res);
  };
  return at;
};

test('a first proposal answer and a recovered one are written inside their answer pass, while the dispatch is recorded as started and before it is acknowledged', async (t) => {
  const first = await proposalWireWorld(t);
  const atFirst = watchResponses(first);
  assert.deepEqual([(await first.post()).status], [200]);
  assert.deepEqual(atFirst.states, ['dispatch-started'], 'the first answer went out while its pass held the dispatch open');
  assert.equal((await laneStates(first.f.effectsDirectory, first.jobId)).at(-1), 'dispatch-acknowledged');

  const recovered = await proposalWireWorld(t);
  changeBeforeAnswerWritten(recovered, (w) => { w.f.stop.requested = true; });
  assert.equal((await recovered.post()).body.error, 'seller_stopped');
  recovered.f.stop.requested = false;
  pastLease(recovered);
  const atRecovered = watchResponses(recovered);
  const answered = await recovered.post();
  assert.deepEqual([answered.status, typeof answered.body.contribution?.signature?.value], [200, 'string']);
  assert.deepEqual(atRecovered.states, ['dispatch-started'], 'the recovered answer went out while its pass held the dispatch open');
  assert.equal(recovered.agreementSignatures(), 1, 'nothing new was signed');
});

test('an answer carrying the co-signature whose response is already closed is never acknowledged: a first proposal, a cached repeat and a state read are refused inside their pass and the next request is answered', async (t) => {
  const answeredLater = async (w, request) => {
    assert.equal((await laneStates(w.f.effectsDirectory, w.jobId)).includes('dispatch-acknowledged'), false, 'a closed response is never acknowledged as sent');
    pastLease(w);
    const answered = await request();
    assert.deepEqual([answered.status, typeof answered.body.contribution?.signature?.value], [200, 'string']);
    assert.equal(w.agreementSignatures(), 1, 'nothing new was signed');
  };

  const first = await proposalWireWorld(t);
  const atFirst = watchResponses(first);
  changeBeforeAnswerWritten(first, () => { atFirst.response.destroyed = true; });
  await first.post().catch(() => {});
  assert.deepEqual(atFirst.states, [], 'nothing was written to the closed response');
  await answeredLater(first, () => first.post());

  for (const [label, request] of [['a cached repeat', (w) => w.post()], ['a state read', readState]]) {
    const w = await proposalWireWorld(t);
    assert.equal((await w.post()).status, 200);
    const recorded = (await laneStates(w.f.effectsDirectory, w.jobId)).length;
    const state = w.agent.agreementState;
    const at = watchResponses(w);
    w.agent.agreementState = (...args) => { const answer = state(...args); at.response.destroyed = true; return answer; };
    await request(w).catch(() => {});
    w.agent.agreementState = state;
    assert.deepEqual(at.states, [], `${label}: nothing was written to the closed response`);
    assert.equal((await laneStates(w.f.effectsDirectory, w.jobId)).slice(recorded).includes('dispatch-acknowledged'), false, `${label}: a closed response is never acknowledged as sent`);
    assert.equal(w.agreementSignatures(), 1, label);
  }
});

for (const [label, change, refusal] of [
  ...['aborted-by-other', 'finalised', 'aborted-by-self'].map((terminal) => [`the context session ending as ${terminal}`, (w) => { w.state.session = terminal; }, 'context_session_terminal']),
  ['the transport reservation lapsing to a new owner', pastLease, 'peer_reconciliation_conflict'],
]) {
  test(`an authenticated proposal through the real route and stores refuses its Agreement signature at the signing-time recheck when ${label} during its held context read, and withholds the answer when it happens after the signature and before the answer is written; the unchanged control signs once and answers 200`, async (t) => {
    // The proposal's context read is held open while `hold.during(w)` runs.
    const hold = { during: null };
    const heldContext = (f) => {
      f.config.demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-held-context', resolveBuyer: async () => null, resolveSeller: async ({ jobId }) => {
        await hold.during?.();
        return { disposition: 'present', value: structuredClone(f.contexts.get(jobId)) };
      } });
    };
    const during = await proposalWireWorld(t, { configure: heldContext });
    hold.during = () => { hold.during = null; change(during); };
    const refused = await during.post();
    assert.deepEqual([refused.status, refused.body.contribution], [503, undefined], 'the attempt answers no co-signature');
    assert.equal(during.agreementSignatures(), 0, 'no cryptographic signer call for the Agreement');
    const kept = during.realAgent().durableSessionOf(during.jobId);
    assert.deepEqual([kept?.agreementSignatureKey, kept?.railPinSigned, kept?.sellerContribution], [undefined, undefined, undefined], 'no signing pointer, rail pin or contribution is kept');
    assert.deepEqual(await laneStates(during.f.effectsDirectory, during.jobId), [], 'the boundary kept no signature');

    const after = await proposalWireWorld(t);
    changeBeforeAnswerWritten(after, change);
    const withheld = await after.post();
    assert.deepEqual([withheld.body.error, withheld.body.contribution], [refusal, undefined], 'the answer is withheld');
    assert.equal(after.agreementSignatures(), 1);
    assert.deepEqual(await laneStates(after.f.effectsDirectory, after.jobId), ['signed'], 'the retained signature stays evidence only, never dispatched');

    const control = await proposalWireWorld(t);
    const answered = await control.post();
    assert.deepEqual([answered.status, answered.body.disposition], [200, 'complete']);
    assert.equal(control.agreementSignatures(), 1);
  });
}

// ---- The Listing, Vet and presentation signatures and the seller's answers through the boundary ----

const LISTING_WALLET = Object.freeze({ claim: protocolSeller.claim, signBytes: protocolSeller.signBytes });
const PUBLISHED = 'TEST_published';
const historyOf = (directory) => createEffectHistory({ dataDirectory: directory });
const listingLanes = (directory) => { try { return readdirSync(join(directory, 'effects')).filter((name) => name.startsWith('listing-signature-')).sort(); } catch { return []; } };
const statesOf = async (directory, lane) => (await historyOf(directory).read(lane)).map((record) => record.state);
const codesOf = (error) => { const codes = []; for (let link = error; link; link = link.cause ?? link.errors?.[0]) codes.push(link.code); return codes; };
const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error, codes: codesOf(error) }));
// Asserts that `promise` rejects with `code` somewhere in its cause chain (the Listing core wraps its callbacks' errors).
const rejectsWith = async (promise, code, label) => {
  const { value, codes = [] } = await settled(promise);
  assert.ok(value === undefined && codes.includes(code), `${label ?? 'refused'}: expected ${code} in ${codes}`);
};

// A monotonic test clock that moves only when the test moves it, firing the timers that come due.
function manualClock() {
  let now = 0;
  const timers = new Set();
  return { now: () => now, after(ms, callback) { const timer = { at: now + ms, callback }; timers.add(timer); return () => timers.delete(timer); },
    advance(ms) { now += ms; for (const timer of [...timers].sort((a, b) => a.at - b.at)) if (timer.at <= now && timers.delete(timer)) timer.callback(); } };
}

// A Listing publisher over `runCreate` whose anchor ends each publication at publish, after its signature; `sign` is the wallet's.
function stoppingListing(runCreate, { now = T0, sign = (bytes) => LISTING_WALLET.signBytes(bytes) } = {}) {
  const counts = { signs: 0, publishes: 0, signed: [] };
  const anchor = { publish: async () => { counts.publishes++; throw Object.assign(new Error('TEST the publication ends at publish'), { code: PUBLISHED }); },
    read: async () => ({ status: 'absent' }), verifyReceipt: async () => 'invalid' };
  const publish = createDevnetDemoListingPublisher({ anchor, runCreate, scanOwnListings: async () => ({ status: 'ok', anchors: [] }), loadRailResolution: railAuthority,
    sign: async (bytes, options) => { counts.signs++; counts.signed.push(Buffer.from(bytes)); return sign(bytes, options); } });
  const draft = fixtureListing(LISTING_WALLET, { now });
  delete draft.signature;
  return { publish, draft, counts };
}

test('the Listing signature and the identity presentation are retained by signPass: each leaves one signed record with the signed bytes on its lane before the call returns, a second call for the same Listing returns those bytes with zero signer calls, a refusal after the signature keeps the signed record and adds signed-held, a signer that has not answered within 10 s on the test clock refuses eb_sign_timeout and retains nothing, and a signer that answers after the pass window but within its own 10 s is retained and refused stop_check_timeout with signed-held, after which the Listing retry reuses it with zero signer calls; two Listing drafts use two lanes; the Vet component signatures add no effect-history record', async (t) => {
  const retained = testEffectBoundary();
  const listing = stoppingListing(testRunCreate({ effectBoundary: retained.effectBoundary }).runCreate);
  await rejectsWith(listing.publish(listing.draft), PUBLISHED);
  const [lane] = listingLanes(retained.dataDirectory);
  assert.equal(lane, `listing-signature-${core.sha256Hex(listing.counts.signed[0])}`, 'the lane is the signature\'s own operation');
  const [record, ...more] = await historyOf(retained.dataDirectory).read(lane);
  assert.deepEqual([record.state, record.operationId, more.length], ['signed', lane, 0]);
  assert.equal(Buffer.from(record.bytes, 'base64').toString(), LISTING_WALLET.signBytes(listing.counts.signed[0]).toString('base64url'), 'the record holds the wallet\'s signature');
  assert.equal(listing.counts.publishes, 1, 'the publication went on only after the signature was retained');
  await rejectsWith(listing.publish(listing.draft), PUBLISHED);
  assert.deepEqual([listing.counts.signs, listing.counts.publishes, (await statesOf(retained.dataDirectory, lane)).length], [1, 2, 1], 'the second call reused the retained bytes');
  const other = stoppingListing(testRunCreate({ effectBoundary: retained.effectBoundary }).runCreate, { now: T0 + 1000 });
  await rejectsWith(other.publish(other.draft), PUBLISHED);
  assert.equal(listingLanes(retained.dataDirectory).length, 2, 'two drafts, two lanes');

  let stop = false;
  const held = testEffectBoundary({ stopped: () => stop });
  const heldListing = stoppingListing(testRunCreate({ effectBoundary: held.effectBoundary }).runCreate, { sign: (bytes) => { stop = true; return LISTING_WALLET.signBytes(bytes); } });
  await rejectsWith(heldListing.publish(heldListing.draft), 'seller_stopped');
  assert.deepEqual(await statesOf(held.dataDirectory, listingLanes(held.dataDirectory)[0]), ['signed', 'signed-held'], 'a refusal after the signature keeps it and records signed-held');
  stop = false;
  await rejectsWith(heldListing.publish(heldListing.draft), PUBLISHED);
  assert.equal(heldListing.counts.signs, 1, 'the retry reused the held signature');

  const late = manualClock(), timing = testEffectBoundary({ clock: late });
  let called = false;
  const silent = stoppingListing(testRunCreate({ effectBoundary: timing.effectBoundary }).runCreate, { sign: () => { called = true; return new Promise(() => {}); } });
  const timedOut = settled(silent.publish(silent.draft));
  for (let turn = 0; turn < 200 && !called; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, true, 'the signer was called');
  late.advance(10_000);
  assert.ok((await timedOut).codes.includes('eb_sign_timeout'), `refused eb_sign_timeout: ${(await timedOut).codes}`);
  assert.deepEqual(listingLanes(timing.dataDirectory).length === 0 ? [] : await statesOf(timing.dataDirectory, listingLanes(timing.dataDirectory)[0]), [], 'nothing was retained');

  const between = manualClock(), window = testEffectBoundary({ clock: between });
  let lateStart = true, answer;
  // The session pass starts 6 s into the kit pass window, so the signer is called inside the window and answers 5 s later, after it ends.
  const session = { ...TEST_PASS_SESSION, runInEffectPass: async (handle, work) => { if (lateStart) { lateStart = false; between.advance(6_000); } return TEST_PASS_SESSION.runInEffectPass(handle, work); } };
  const { runCreate: betweenRunCreate } = createSellerCreatePass({ effectBoundary: window.effectBoundary, session, stopped: () => false, feeCeilingOs: String(WRITE_FEE_CEILING_OS), clock: between });
  const slow = stoppingListing(betweenRunCreate, { sign: (bytes) => new Promise((resolve) => { answer = () => resolve(LISTING_WALLET.signBytes(bytes)); }) });
  const outcome = settled(slow.publish(slow.draft));
  for (let turn = 0; turn < 200 && answer === undefined; turn++) await new Promise((resolve) => setImmediate(resolve));
  between.advance(5_000);
  answer();
  assert.ok((await outcome).codes.includes('stop_check_timeout'), `refused stop_check_timeout: ${(await outcome).codes}`);
  assert.deepEqual(await statesOf(window.dataDirectory, listingLanes(window.dataDirectory)[0]), ['signed', 'signed-held'], 'the late answer is retained, then held');
  await rejectsWith(slow.publish(slow.draft), PUBLISHED);
  assert.equal(slow.counts.signs, 1, 'the Listing retry reused it with zero signer calls');

  const presentation = productionFixture();
  t.after(() => presentation.base.close());
  await presentation.run();
  assert.equal(presentation.controls.presentationSigns, 1);
  const jobLanes = readdirSync(join(presentation.effectsDirectory, 'effects'));
  const presentations = (await Promise.all(jobLanes.map((name) => historyOf(presentation.effectsDirectory).read(name)))).flat().filter((entry) => entry.operationId.startsWith('presentation-'));
  assert.deepEqual(presentations.map((entry) => entry.state), ['signed'], 'one signed record of the presentation');
  assert.match(Buffer.from(presentations[0].bytes, 'base64').toString(), /^[A-Za-z0-9_-]+$/, 'it holds the wallet\'s signature string');

  const vet = await orchestratorFixture(t);
  assert.equal((await vet.run()).disposition, 'present');
  assert.equal(vet.controls.signatures.length, 2, 'both Vet component signatures were made');
  const vetLanes = existsSync(join(vet.effectsDirectory, 'effects')) ? readdirSync(join(vet.effectsDirectory, 'effects')) : [];
  const vetRecords = (await Promise.all(vetLanes.map((name) => historyOf(vet.effectsDirectory).read(name)))).flat();
  assert.deepEqual(vetRecords, [], 'the Vet component signatures add no effect-history record');
});

test('a restart between the Listing signature and its CREATE intent reuses the retained Listing signature, calls the signer zero times and stores one intent, and a restart after the intent issues no second CREATE', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-listing-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await anchorFixture({ writer: { claim: LISTING_WALLET.claim, sign: LISTING_WALLET.signBytes }, artifactKinds: ['Listing'], now: () => T0 });
  // The wallet signs the CREATE and journals its broadcast, then the process loses the answer.
  f.controls.request = async (request) => {
    const signedTransaction = await signSdkCreate(request.transaction, { writer: protocolSeller }), hash = signedTransaction.hash;
    await f.journal.put(`demo/wallet/${request.jobId}`, { stage: 'broadcast-started', hash, signedTransaction });
    await f.sourceJournal.put(`source/${request.jobId}`, { stage: 'signed', hash, signedTransaction });
    return { success: false, error: { code: 'internal_error' } };
  };
  const signs = { count: 0 };
  // One process: a new boundary over the same data directory, an issued runCreate and a publisher over `anchor`.
  const processOver = (anchor) => createDevnetDemoListingPublisher({ anchor, runCreate: testRunCreate({ effectBoundary: testEffectBoundary({ dataDirectory: directory }).effectBoundary }).runCreate,
    scanOwnListings: async () => ({ status: 'ok', anchors: [] }), loadRailResolution: railAuthority, sign: (bytes) => { signs.count++; return LISTING_WALLET.signBytes(bytes); } });
  const draft = fixtureListing(LISTING_WALLET, { now: T0 });
  delete draft.signature;
  const intents = () => [...f.journal.rows.values()].filter((row) => row.input?.artifactKind === 'Listing').length;
  const crashing = { ...f.open(), publish: async () => { throw Object.assign(new Error('TEST the process dies before the CREATE intent is stored'), { code: 'TEST_crash' }); } };
  await rejectsWith(processOver(crashing)(draft), 'TEST_crash');
  assert.deepEqual({ signs: signs.count, intents: intents(), lanes: listingLanes(directory).length }, { signs: 1, intents: 0, lanes: 1 }, 'signed and retained, no intent');
  await assert.rejects(processOver(f.open())(draft));
  assert.deepEqual({ signs: signs.count, intents: intents(), creates: f.captured.length }, { signs: 1, intents: 1, creates: 1 }, 'the restart reused the signature and stored one intent');
  await assert.rejects(processOver(f.open())(draft));
  assert.deepEqual({ signs: signs.count, intents: intents(), creates: f.captured.length }, { signs: 1, intents: 1, creates: 1 }, 'a restart after the intent issued no second CREATE');
});

// A runCreate the kit did not issue: one that calls `work` with a bare signer, a wrapper around an issued one, and a non-function.
const unissuedRunCreates = (issued) => [
  ['a pass-through substitute', async (op, work) => work({ guardedSigner: (sign) => sign, signPass: async (inner) => inner() })],
  ['a wrapper around an issued runCreate', (op, work) => issued(op, work)],
  ['a non-function', Object.freeze({ runCreate: issued })],
];

test('the Vet provider, the Listing publisher and the signature helpers refuse a runCreate the kit did not issue: a pass-through substitute that calls work with a bare signer, a wrapper around an issued runCreate and a non-function each throw a TypeError at construction or call, and the wallet and Listing signers are called zero times; the port\'s runCreate and createSellerCreatePass\'s runCreate are accepted', async (t) => {
  const { runCreate: issued } = testRunCreate();
  const f = await orchestratorFixture(t);
  let walletCalls = 0;
  const wallet = { claim: f.config.wallet.claim, signBytes: (bytes) => { walletCalls++; return f.config.wallet.signBytes(bytes); } };
  const op = (runCreate) => ({ runCreate, operationId: 'TEST-signature', lane: 'TEST-signature', operationClass: 'job-create', currentAuthorization: () => true });
  for (const [label, runCreate] of unissuedRunCreates(issued)) {
    assert.equal(isSellerCreatePass(runCreate), false, label);
    assert.throws(() => f.provider({ runCreate, wallet }), TypeError, `${label}: the provider`);
    assert.throws(() => stoppingListing(runCreate), TypeError, `${label}: the publisher`);
    await assert.rejects(signRetainedInPass(op(runCreate), async () => { walletCalls++; return 'TEST'; }), TypeError, `${label}: signRetainedInPass`);
    await assert.rejects(signInPass(op(runCreate), wallet.signBytes, Buffer.from('TEST')), TypeError, `${label}: signInPass`);
  }
  assert.equal(walletCalls, 0, 'no signer was called');
  const { world } = await finalizedWorld(t);
  for (const [label, runCreate] of [['the port\'s runCreate', world.port.runCreate], ['createSellerCreatePass\'s runCreate', issued], ['a late-bound issued runCreate', lateSellerCreatePass(() => issued)]]) {
    assert.equal(isSellerCreatePass(runCreate), true, label);
    assert.doesNotThrow(() => f.provider({ runCreate }), label);
    assert.doesNotThrow(() => stoppingListing(runCreate), label);
  }
  assert.equal(await signRetainedInPass(op(issued), async () => 'TEST-signature-value'), 'TEST-signature-value', 'the issued runCreate signs');
  await assert.rejects(lateSellerCreatePass(() => async () => {})(op(issued), () => {}), TypeError, 'a late-bound pass that resolves an unissued runCreate refuses at call');
});

test('createSellerAgent without readOnlyAnswerSigner, createWireContext with a signer that has no read-only role, and the host with a signer that lacks one of the three roles each throw a TypeError before anything is opened', async (t) => {
  const agent = await agentFixture({ memory: true });
  t.after(() => agent.close());
  const durableDirectory = join(mkdtempSync(join(tmpdir(), 'TEST-three-roles-')), 'seller');
  t.after(() => rmSync(dirname(durableDirectory), { recursive: true, force: true }));
  const { effectSigner, integritySigner, effectBoundary } = { effectSigner: agent.config.signer, integritySigner: integrityRoleOf(agent.config.signer), effectBoundary: testEffectBoundary().effectBoundary };
  await assert.rejects(createSellerAgent({ ...agent.config, durableDirectory, effectSigner, integritySigner, effectBoundary }), { name: 'TypeError', message: /readOnlyAnswerSigner/ });
  assert.equal(existsSync(durableDirectory), false, 'the agent opened no durable state');

  const w = await wireWorld(t);
  const { binding, journal, store, readCommitmentReceipt } = w.handle.wire;
  const bindings = [];
  const watched = { ...store, bind: (input) => { bindings.push(input); return store.bind(input); } };
  assert.throws(() => createWireContext({ binding, tp1Network: { connection: () => ({ ...TEST_CONNECTION }) }, signer: { claim: protocolSeller.claim, sign: protocolSeller.signBytes },
    effectBoundary: w.effectBoundary, journal, store: watched, ready: () => true, stopped: () => false, now: w.clock, agent: w.agent, requireDelegation: false, readCommitmentReceipt }), TypeError);
  assert.deepEqual(bindings, [], 'the wire context bound no store');

  const host = await contextHostFixture(t);
  const { signer } = host.config;
  for (const missing of ['sign', 'integritySigner', 'readOnlyAnswerSigner']) {
    const partial = { ...signer };
    delete partial[missing];
    await assert.rejects(host.start({ signer: partial }), { name: 'TypeError', message: /signing roles \(sign, integritySigner and readOnlyAnswerSigner\)/ }, missing);
    assert.deepEqual(readdirSync(host.dataDirectory), [], `${missing}: the host opened nothing, the state lock included`);
  }
});

test('a success answer on an effect route is signed by the effect role in its own short pass before the co-signature answer pass opens, and never waits on the fence that pass holds', async (t) => {
  const w = await proposalWireWorld(t);
  const roles = { effect: 0, readOnly: 0 }, sellerSigner = w.f.config.signer;
  const counted = { claim: sellerSigner.claim, sign: (bytes) => { roles.effect++; return sellerSigner.sign(bytes); },
    readOnlyAnswerSigner: async (request) => { const signer = await sellerSigner.readOnlyAnswerSigner(request); return { claim: signer.claim, sign: (bytes) => { roles.readOnly++; return signer.sign(bytes); } }; } };
  // The wire signs in the agent's own boundary, as the host composes them: one fence for the co-signature pass and the answer's pass.
  await w.withWire({ binding: TEST_BINDING, effectBoundary: w.f.effectBoundary, signer: counted }, async () => {
    const atResponse = [];
    w.signing.before = null;
    const sign = counted.sign;
    counted.sign = (bytes) => {
      if (Buffer.from(bytes).toString().startsWith(DACS_SELLER_HTTP_DOMAINS.response)) atResponse.push(lastLaneState(w.f.effectsDirectory, w.jobId));
      return sign(bytes);
    };
    const started = Date.now();
    const answer = await w.post();
    assert.deepEqual([answer.status, typeof answer.body.contribution?.signature?.value], [200, 'string'], 'the co-signature answer is sent');
    assert.deepEqual(atResponse, ['signed'], 'the response was signed by the effect role after the co-signature was retained and before its answer pass opened');
    assert.ok(Date.now() - started < 10_000, 'the answer never waited out the fence');
    assert.equal(roles.readOnly, 0, 'the read-only role signed nothing for an effect-route success');
    assert.equal((await laneStates(w.f.effectsDirectory, w.jobId)).at(-1), 'dispatch-acknowledged');
  });
});

// ---- The seller inventory paths this composition signs on ----

// The identity records no binding may be made from, each as a copy of the test binding carrying the record's digest:
// bindTp1Profile never made such a binding, so a boundary over it refuses tp1_binding_required.
const REFUSED_RECORDS = [
  ['a mainnet-labelled record', { ...TP1_APPROVED_IDENTITY_RECORD, network: 'demos-mainnet' }],
  ['a self-approved record', { ...TP1_APPROVED_IDENTITY_RECORD, recordId: 'dacs-demos-testnet-identity/TEST-self-approved',
    provenance: { ...TP1_APPROVED_IDENTITY_RECORD.provenance, approvedBy: protocolSeller.claim } }],
  ['an approved-but-refused record', { ...TP1_APPROVED_IDENTITY_RECORD, refused: true }],
];
const forgedBinding = (record) => ({ ...structuredClone(TEST_BINDING), recordDigest: core.sha256Hex(core.canonicalize(record)) });
const EFFECT_ANSWER = Object.freeze({ request: { path: PATHS.proposals, jobId: JOB_ID }, status: 200, text: '{"disposition":"complete"}' });

// Each seller inventory path of this composition over `pass` (`{ runCreate, effectBoundary, binding }`): `attempt()` runs the path once,
// `signatures()` counts its cryptographic signer calls and `transmissions()` its wallet requests or POSTs.
async function inventory(t, pass) {
  const listing = stoppingListing(pass.runCreate);
  const vet = await orchestratorFixture(t);
  const provider = vet.provider({ runCreate: pass.runCreate });
  const presentation = productionFixture();
  t.after(() => presentation.base.close());
  presentation.config.runCreate = pass.runCreate;
  const answerSigns = { count: 0 };
  const roles = { claim: protocolSeller.claim, sign: (bytes) => { answerSigns.count++; return protocolSeller.signBytes(bytes); }, readOnlyAnswerSigner: readOnlyRoleOf(protocolSeller) };
  const answers = createAnswerSigners({ roles, effectBoundary: pass.effectBoundary, binding: pass.binding, local: () => ({ ...TEST_CONNECTION }) });
  return [
    { label: 'the Listing publication', attempt: () => settled(listing.publish(listing.draft)), signatures: () => listing.counts.signs, transmissions: () => listing.counts.publishes },
    { label: 'the Vet component signatures through the provider\'s resolveBuyer', attempt: () => settled(provider.resolveBuyer(vet.input, { writable: () => true })),
      signatures: () => vet.controls.signatures.length, transmissions: () => vet.controls.creates.length },
    { label: 'the identity presentation', attempt: () => settled(presentation.run()), signatures: () => presentation.controls.signs, transmissions: () => presentation.local.writes.length },
    { label: 'an effect-route answer', attempt: () => settled(answers.signAnswer(EFFECT_ANSWER, (signer) => signer.sign(Buffer.from('TEST-answer')))), signatures: () => answerSigns.count, transmissions: () => 0 },
  ];
}
// A data directory that holds a KILL entry, removed when the test ends.
const killedDirectory = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-killed-'));
  writeFileSync(join(directory, 'KILL'), '');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const passOver = ({ binding = TEST_BINDING, stopped = () => false } = {}) => {
  const { effectBoundary } = testEffectBoundary({ binding, stopped });
  return { effectBoundary, binding, runCreate: testRunCreate({ effectBoundary, stopped }).runCreate };
};
// The kit client's returned method over a counting fetch that answers 200.
const countingClient = () => {
  const posts = { count: 0 };
  const client = createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl: async () => { posts.count++; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  return { posts, client };
};

test('zero signatures and transmissions on every seller inventory path, returned methods and Vet component signatures included, for a mainnet-labelled, self-approved or approved-but-refused record; the same inventory table, Listing publication included, with the in-process stop flag set before the call makes zero cryptographic signer calls and zero wallet requests, counted on the signer, not on anchor.publish; repeat with a re-hold; the closed read-only and integrity roles are tested separately', async (t) => {
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  const conditions = [
    ...REFUSED_RECORDS.map(([label, record]) => [label, () => passOver({ binding: forgedBinding(record) }), () => {}]),
    ['the stop flag set before the call', () => passOver({ stopped: () => true }), () => {}],
    ['a KILL file present before the call', () => passOver({ stopped: createStopCheck(killedDirectory(t)) }), () => {}],
    ['a re-hold', () => passOver(), () => guard.setKitOperationGuardForTest('off')],
  ];
  for (const [condition, makePass, before] of conditions) {
    const rows = await inventory(t, makePass());
    const client = countingClient();
    before();
    for (const row of rows) {
      const outcome = await row.attempt();
      assert.ok(outcome.error !== undefined || outcome.value?.disposition !== 'present', `${condition}, ${row.label}: refused`);
      assert.deepEqual([row.signatures(), row.transmissions()], [0, 0], `${condition}, ${row.label}: zero signatures and transmissions`);
    }
    if (condition === 'a re-hold') {
      assert.throws(() => client.client.propose({}), { code: 'kit_operation_guard_off' }, 'the kit client\'s returned method');
      assert.equal(client.posts.count, 0, 'the kit client sent nothing');
    }
    guard.setKitOperationGuardForTest('testnet-tp1');
  }
  await paymentEvidenceRefusals(t);
});

// The payment-evidence entries of the inventory: the journal's ensureEvidence (signature and send) and the pass's signature and
// send, for each refused record and after a re-hold, over the real wallet; then the session's journal with its stop flag set.
async function paymentEvidenceRefusals(t) {
  const signatures = await spyTransactionSignatures(t.mock), signal = new AbortController().signal, authorize = () => true;
  const conditions = [...REFUSED_RECORDS.map(([label, record]) => [label, record]), ['a re-hold', null]];
  for (const [condition, record] of conditions) {
    const world = await sellerWalletWorld(t), input = evidenceInput(world), ledger = world.approval;
    const binding = record === null ? world.admission.binding : { ...structuredClone(world.admission.binding), recordDigest: core.sha256Hex(core.canonicalize(record)) };
    const { journal, pass } = journalOverPass(world, { binding });
    if (record === null) guard.setKitOperationGuardForTest('off');
    const entries = { ensureEvidence: () => evidenceAt(journal, input), 'paymentEvidence.signCreate': () => pass.signCreate(input, { signal, approval: STAND_IN_HOLD, authorize }),
      'paymentEvidence.broadcast': () => pass.broadcast(STAND_IN_RETAINED, { signal, approval: STAND_IN_HOLD, authorize, jobId: input.jobId }) };
    for (const [entry, run] of Object.entries(entries)) assert.ok((await settled(run())).error, `${condition}, ${entry}: refused`);
    guard.setKitOperationGuardForTest('testnet-tp1');
    assert.deepEqual({ signatures: signatures.length, ...executeCounts(world.node) }, { signatures: 0, confirmTx: 0, broadcastTx: 0 }, `${condition}: zero signatures and transmissions`);
    // The approval is asked ahead of the pass, outside every fence; under a refused record the pass then refuses and the hold is released unused.
    const asked = record === null ? { asked: 0, released: 0 } : { asked: 1, released: 1 };
    assert.deepEqual({ asked: ledger.prepared.length, released: releasesOf(ledger, 'TEST-ledger-1') }, asked, `${condition}: approvals`);
    await world.wallet.close();
  }
  // The session's journal over each stop: the in-process flag, and the data directory's real KILL file read by the kit's check.
  for (const stop of ['the stop flag', 'a KILL file']) {
    let stopped = false;
    const stopping = await walletSessionWorld(t);
    const { session } = await stopping.finalize(stop === 'the stop flag' ? () => stopped : createStopCheck(stopping.directory));
    if (stop === 'the stop flag') stopped = true;
    else writeFileSync(join(stopping.directory, 'KILL'), '');
    const input = evidenceInput({ wallet: session });
    for (const run of [() => evidenceAt(session.paymentEvidence, input), () => session.paymentEvidence.anchorEvidence(input)]) assert.ok((await settled(run())).error, `${stop} refuses`);
    assert.deepEqual({ signatures: signatures.length, asked: stopping.options.approve.retained.prepared.length, ...executeCounts(stopping.node) },
      { signatures: 0, asked: 0, confirmTx: 0, broadcastTx: 0 }, `with ${stop} set nothing is asked, signed or sent`);
  }
}

test('the approved record signs and transmits on every seller inventory path', async (t) => {
  for (const row of await inventory(t, passOver())) {
    await row.attempt();
    assert.ok(row.signatures() >= 1, `${row.label}: signed`);
    if (row.label !== 'an effect-route answer') assert.ok(row.transmissions() >= 1, `${row.label}: transmitted after signing`);
  }
  const { posts, client } = countingClient();
  await client.propose({});
  assert.equal(posts.count, 1, 'the kit client\'s returned method sends');

  // The payment-evidence lane: the journal signs and sends once, and so do the pass's four members called in turn.
  const signatures = await spyTransactionSignatures(t.mock), signal = new AbortController().signal, authorize = () => true;
  for (const through of ['the journal', 'the pass']) {
    const world = await sellerWalletWorld(t), input = evidenceInput(world), { journal, pass } = journalOverPass(world), before = signatures.length;
    if (through === 'the journal') await evidenceAt(journal, input);
    else {
      const signed = await pass.signCreate(input, { signal, approval: (await pass.approveAhead(input, { signal, authorize })).approval, authorize });
      const retained = { signedTransaction: signed.signedTransaction, txHash: signed.txHash };
      await pass.broadcast(retained, { signal, approval: (await pass.approveSendAhead(retained, { signal, authorize })).approval, authorize, jobId: input.jobId });
    }
    assert.deepEqual({ signatures: signatures.length - before, ...executeCounts(world.node) }, { signatures: 1, confirmTx: 1, broadcastTx: 1 }, `${through}: signed and sent once`);
    await world.wallet.close();
  }
});

test('with the guard off, every seller effect path refuses kit_operation_guard_off before any read; effect, permitted read-only and integrity signatures are counted separately', async (t) => {
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  const roles = await countedKeyRoles(t);
  const f = await orchestratorFixture(t);
  const reads = { store: 0, scans: 0 };
  const store = { ...f.store, read: (...args) => { reads.store++; return f.store.read(...args); }, entries: (...args) => { reads.store++; return f.store.entries(...args); } };
  const provider = f.provider({ store });
  const { runCreate, effectBoundary } = passOver();
  const listing = createDevnetDemoListingPublisher({ anchor: { publish: async () => {}, read: async () => {}, verifyReceipt: async () => {} }, runCreate, sign: roles.effectSigner.sign,
    scanOwnListings: async () => { reads.scans++; return { status: 'ok', anchors: [] }; }, loadRailResolution: () => { reads.scans++; return railAuthority(); } });
  const answers = createAnswerSigners({ roles: { claim: roles.key.claim, sign: roles.effectSigner.sign, readOnlyAnswerSigner: roles.readOnlyAnswerSigner }, effectBoundary, binding: TEST_BINDING,
    local: () => ({ ...TEST_CONNECTION }) });
  const { posts, client } = countingClient();
  const op = { runCreate, operationId: 'TEST-off', lane: 'TEST-off', operationClass: 'job-create', currentAuthorization: () => true };
  const discoveryBinding = await keyTestBinding();
  // The payment-evidence lane, built while the guard is on: the pass's and the wallet adapter's four effect members, and the journal's entries.
  const evidenceWorld = await sellerWalletWorld(t), evidence = evidenceInput(evidenceWorld), { journal: evidenceJournal, pass: evidencePass } = journalOverPass(evidenceWorld);
  const evidenceCall = { signal: new AbortController().signal, approval: STAND_IN_HOLD, authorize: () => true, jobId: evidence.jobId };
  const evidenceReads = evidenceWorld.node.reads.length;
  guard.setKitOperationGuardForTest('off');
  const refusals = {
    'agreementContextProvider.resolveBuyer': () => provider.resolveBuyer(f.input, { writable: () => true }),
    'agreementContextProvider.recoverBuyer': () => provider.recoverBuyer(f.input),
    'agreementContextProvider.resolveSeller': () => provider.resolveSeller(f.sellerRequest()),
    createDevnetDemoListingPublisher: () => listing(fixtureListing(LISTING_WALLET, { now: T0 })),
    'signRetainedInPass (effectBoundary)': () => signRetainedInPass(op, async () => roles.effectSigner.sign(Buffer.from('TEST'))),
    'signInPass (effectBoundary)': () => signInPass(op, roles.effectSigner.sign, Buffer.from('TEST')),
    'signAnswer (effectBoundary)': () => answers.signAnswer(EFFECT_ANSWER, (signer) => signer.sign(Buffer.from('TEST-answer'))),
    ...Object.fromEntries(['propose', 'agreementState', 'commit', 'submitPayment', 'bundleRequest', 'countersign', 'confirmBuyerCopy', 'agreementContext', 'contextChallenge']
      .map((method) => [`sellerAgentClient.${method}`, () => client[method]({})])),
    ...Object.fromEntries(['approveAhead', 'signCreate', 'approveSendAhead', 'broadcast'].flatMap((member) => [
      [`paymentEvidence.${member}`, () => evidencePass[member](evidence, evidenceCall)],
      [`paymentEvidenceAdapter.${member}`, () => evidenceWorld.wallet.paymentEvidenceAdapter[member](evidence, evidenceCall)]])),
    ...Object.fromEntries(['anchorEvidence', 'ensureEvidence', 'reconcilePaymentEvidence']
      .map((entry) => [entry, () => evidenceJournal[entry]({ ...evidence, expectedJournalId: evidenceJournal.journalId, authorize: () => true })])),
  };
  for (const [entry, run] of Object.entries(refusals)) {
    const outcome = await settled(Promise.resolve().then(run));
    assert.ok(outcome.codes?.includes('kit_operation_guard_off'), `${entry}: refused kit_operation_guard_off, got ${outcome.codes}`);
  }
  assert.deepEqual({ ...reads, posts: posts.count, effect: roles.counts.effect }, { store: 0, scans: 0, posts: 0, effect: 0 },
    'refused before any read, POST or signature');
  assert.deepEqual({ nodeReads: evidenceWorld.node.reads.length - evidenceReads, asked: evidenceWorld.approval.prepared.length }, { nodeReads: 0, asked: 0 },
    'the payment-evidence entries refused before any read or approval');
  roles.integritySigner.sign(Buffer.concat([Buffer.from(SELLER_STATE_SIGNING_DOMAIN), Buffer.from('TEST-journal-record')]));
  await (await roles.readOnlyAnswerSigner({ purpose: 'discovery', binding: discoveryBinding, local: KEY_LOCAL }))
    .sign(wireApi.discoverySigningBytes(discoveryPayload(discoveryBinding, { seller: roles.key.claim })));
  assert.deepEqual(roles.counts, { effect: 0, integrity: 1, readOnly: 1 }, 'while off the integrity role signs journal bytes and the read-only role a ready:false document, each counted on its own');
});

test('the kit\'s createSellerAgentClient refuses authentication at construction, and a client built while admitted sends zero POSTs after a re-hold', async (t) => {
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  const adapterCalls = { count: 0 };
  const authentication = { request: async () => { adapterCalls.count++; return { header: 'TEST', payload: {} }; }, verifyResponse: () => { adapterCalls.count++; } };
  const posts = { count: 0 };
  const fetchImpl = async () => { posts.count++; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  assert.throws(() => createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl, authentication }), { code: 'seller_client_signing_unsupported' });

  const client = createSellerAgentClient({ url: 'http://127.0.0.1:1', fetchImpl, commitOnSignature: true });
  const methods = Object.keys(client).filter((name) => typeof client[name] === 'function');
  assert.equal(methods.length, 10, 'every request method, commitOnSignature included');
  guard.setKitOperationGuardForTest('off');
  for (const method of methods) assert.throws(() => client[method]({}), { code: 'kit_operation_guard_off', entry: `sellerAgentClient.${method}` }, method);
  assert.deepEqual({ posts: posts.count, adapterCalls: adapterCalls.count }, { posts: 0, adapterCalls: 0 }, 'nothing signed or sent after the re-hold');

  guard.setKitOperationGuardForTest('testnet-tp1');
  await client.propose({});
  assert.equal(posts.count, 1, 'admitted again, the same client sends');
});

test('read-only and refusal answers are signed after the binding check only, through the read-only role, never through effect sign', async (t) => {
  const roles = await countedKeyRoles(t);
  const w = await wireWorld(t);
  const signer = { claim: roles.key.claim, sign: roles.effectSigner.sign, readOnlyAnswerSigner: roles.readOnlyAnswerSigner };
  await w.withWire({ signer }, async () => {
    const job = await proposeJob(w, 'read-only-answers');
    const proposed = await job.post();
    assert.equal(proposed.status, 200);
    assert.deepEqual([roles.counts.effect, roles.counts.readOnly], [1, 0], 'an effect-route success is the effect role\'s');
    const read = await w.post(PATHS.state, identityBody(job.jobId, job.agreementHash), { jobId: job.jobId, agreementHash: job.agreementHash });
    assert.equal(read.status, 200);
    assert.ok(await w.verified(read), 'the read answer verifies under the binding');
    assert.deepEqual([roles.counts.effect, roles.counts.readOnly], [1, 1], 'a read answer is the read-only role\'s');
    w.state.ready = false;
    const refused = await (await proposeJob(w, 'read-only-refusal')).post();
    w.state.ready = true;
    assert.ok(refused.status >= 400 && refused.signed, `a signed refusal: ${refused.status} ${refused.text}`);
    assert.ok(await w.verified(refused), 'the refusal verifies under the binding');
    assert.deepEqual([roles.counts.effect, roles.counts.readOnly], [1, 2], 'a refusal is the read-only role\'s');
  });
});

// A pass whose authority reads and stop checks can each be paused at a chosen call: `gate.pause('authority' | 'stop', at)` holds that
// call until `gate.resume()`; `gate.closed` makes the authority refuse and `gate.stop` makes the stop check answer true.
async function pausablePass() {
  const reader = authorityReader();
  const gate = { calls: { authority: 0, stop: 0 }, at: null, held: null, closed: false, stop: false,
    pause(kind, at) { this.calls = { authority: 0, stop: 0 }; this.at = { kind, at }; },
    resume() { const held = this.held; this.held = null; held?.(); } };
  const hold = async (kind) => { gate.calls[kind] += 1; if (gate.at?.kind === kind && gate.at.at === gate.calls[kind]) await new Promise((resume) => { gate.held = resume; }); };
  const readAuthority = async (scope) => {
    await hold('authority');
    if (gate.closed) throw new WireError('tp1_participant_refused', 503, undefined, new Error('TEST authority closed'));
    return reader(scope);
  };
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: { ...TEST_CONNECTION }, readAuthority });
  const stopped = async () => { await hold('stop'); return gate.stop; };
  const { effectBoundary } = testEffectBoundary({ binding, stopped });
  return { gate, binding, effectBoundary, runCreate: testRunCreate({ effectBoundary }).runCreate };
}

// The paths whose final checks are paused outside the composed host: each `make(pass)` gives `{ attempt(), signatures(), onSign(hook), restart? }`.
// The presentation runs over the production Vet fixture, the Listing over the isolated anchor with an issued runCreate, and the answer
// signer over a boundary whose stop check can be paused (the host's own stop check is the process-wide stop flag, which a test cannot hold).
const PAUSED_PATHS = [
  ['the identity presentation', async (t, pass) => {
    const p = productionFixture();
    t.after(() => p.base.close());
    p.config.runCreate = pass.runCreate;
    const signBytes = p.config.wallet.signBytes;
    let hook = null;
    p.config.wallet.signBytes = (bytes, request) => { if (Buffer.from(bytes).toString().startsWith('dacs-bundle-presentation:v1:')) hook?.(bytes); return signBytes(bytes, request); };
    return { attempt: () => settled(p.run()), signatures: () => p.controls.presentationSigns, onSign: (next) => { hook = next; } };
  }],
  ['the Listing signature', async (t, pass) => {
    let hook = null;
    const listing = stoppingListing(pass.runCreate, { sign: (bytes) => { hook?.(bytes); return LISTING_WALLET.signBytes(bytes); } });
    return { attempt: () => settled(listing.publish(listing.draft)), signatures: () => listing.counts.signs, onSign: (next) => { hook = next; },
      restart: () => settled(listing.publish(listing.draft)) };
  }],
  ['an effect-route answer', async (t, pass) => {
    let hook = null, count = 0;
    const roles = { claim: protocolSeller.claim, sign: (bytes) => { count++; hook?.(bytes); return protocolSeller.signBytes(bytes); }, readOnlyAnswerSigner: readOnlyRoleOf(protocolSeller) };
    const answers = createAnswerSigners({ roles, effectBoundary: pass.effectBoundary, binding: pass.binding, local: () => ({ ...TEST_CONNECTION }) });
    return { attempt: () => settled(answers.signAnswer(EFFECT_ANSWER, (signer) => signer.sign(Buffer.from('TEST-answer')))), signatures: () => count, onSign: (next) => { hook = next; } };
  }],
];

// The composed host's context admission row for `jobId`: `contextRow` reads its state, `moveContextRow` rewrites its record as another
// writer of the store would (a reclaimed attempt, or a compensation that advances its revision).
const HOST_JOB = protocolJob, NEXT_HOST_JOB = '01J8N4YV7YVYQ4DB7M8T4C7W0B';
const transportStore = (directory, options) => new Database(join(directory, 'transport', 'transport.sqlite'), options);
const contextRow = (directory, jobId = HOST_JOB) => {
  const db = transportStore(directory, { readonly: true });
  try { return db.prepare('SELECT state FROM kit_context_admissions WHERE jobId = ?').get(jobId)?.state ?? null; } finally { db.close(); }
};
const moveContextRow = (directory, change, jobId = HOST_JOB) => {
  const db = transportStore(directory);
  try {
    const next = change(JSON.parse(db.prepare('SELECT record FROM kit_context_admissions WHERE jobId = ?').get(jobId).record));
    db.prepare('UPDATE kit_context_admissions SET state = ?, rev = ?, record = ? WHERE jobId = ?').run(next.state, next.rev, JSON.stringify(next), jobId);
  } finally { db.close(); }
};
// Resolves once `gate` holds a call, and fails when the request ends first.
const heldBefore = async (gate, request, name) => {
  let ended = false;
  void request.then(() => { ended = true; }, () => { ended = true; });
  while (gate.held === null && !ended) await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(gate.held, null, `${name}: paused at its final await`);
};

test('run the final pause-and-resume subcases at the real final authority and stop awaits through the composed host and the real seller routes: issuance and reclamation, rollback, closure and restart, each with its expected outcome and refusal cause; closed authority grants no signature or transmission, and the unchanged authorized control succeeds; the payment-evidence leg and the CREATE-lane matrix included', async (t) => {
  // The composed host over the real Vet provider, its buyer through the real challenge and context routes. The control finds the final
  // authority read and final stop check of the first Vet component signature's pass, and the final authority read of the context answer's.
  const control = await composedVetHost(t), started = await control.start(), finals = { vet: null, answer: null };
  control.gate.pause('none', 0);
  control.hooks.onSign = () => { finals.vet ??= { ...control.gate.calls }; };
  control.hooks.onEffect = () => { if (control.signatures.length === 2) finals.answer ??= { ...control.gate.calls }; };
  const answered = await started.buyer.requestContext();
  assert.deepEqual([answered.status, control.signatures.length], [200, 2], `the control signs both Vet records and answers: ${answered.text}`);
  assert.ok(finals.vet.authority >= 1 && finals.vet.stop >= 1 && finals.answer.authority > finals.vet.authority, 'the control reached each signer after its checks');

  for (const kind of ['authority', 'stop']) {
    const subcases = [
      ['the unchanged authorized control', null, null],
      ['closure', (w) => { if (kind === 'authority') w.gate.closed = true; else w.gate.stop = true; }, kind === 'authority' ? 'tp1_participant_refused' : 'seller_stopped'],
      ['issuance and reclamation', (w) => moveContextRow(w.dataDirectory, (row) => ({ ...row, attempt: row.attempt + 1 })), 'not-pending'],
      ['rollback', (w) => moveContextRow(w.dataDirectory, (row) => ({ ...row, state: 'compensating', rev: row.rev + 1 })), 'not-pending'],
    ];
    for (const [subcase, change, code] of subcases) {
      const name = `the Vet component signature through the composed host, final ${kind} await, ${subcase}`;
      const w = await composedVetHost(t), { buyer } = await w.start();
      w.gate.pause(kind, finals.vet[kind]);
      const request = buyer.requestContext();
      await heldBefore(w.gate, request, name);
      change?.(w);
      w.gate.resume();
      const answer = await request;
      if (change === null) {
        assert.deepEqual([answer.status, w.signatures.length], [200, 2], `${name}: signs both Vet records and answers`);
        continue;
      }
      // A closed authority grants no signature at all: the read-only role checks it too, so that refusal goes out unsigned.
      const signedRefusal = !(subcase === 'closure' && kind === 'authority');
      assert.deepEqual([answer.status >= 400, answer.signed, w.signatures.length], [true, signedRefusal, 0], `${name}: a refusal and no signature: ${answer.text}`);
      assert.ok((await w.failedSteps()).includes(code), `${name}: the Vet step keeps ${code}, got ${await w.failedSteps()}`);
    }

    // Restart: the host process is killed at the final await; the host started again over its data directory and party Vet store fences the
    // attempt at its startup sweep and signs nothing for it, and the next purchase signs each Vet record once.
    const name = `the Vet component signature through the composed host, final ${kind} await, restart`;
    const anchor = vetRecordAnchor(), w = await composedVetHost(t, { anchor });
    await (await w.start()).host.close();
    const killed = await composedVetHostProcess(t, { dataDirectory: w.dataDirectory, vetPath: w.vetPath, anchor, kind, at: finals.vet[kind] });
    const ended = (await w.buyerFor(killed.host)).requestContext().then(() => null, (error) => error);
    await killed.held;
    await killed.kill();
    assert.ok((await ended) instanceof Error, `${name}: the killed host sends no answer`);
    assert.deepEqual([killed.signatures(), anchor.records.size, contextRow(w.dataDirectory)], [0, 0, 'running'], `${name}: the killed host signed and published nothing`);
    const { buyer } = await w.start();
    assert.deepEqual([contextRow(w.dataDirectory), w.signatures.length], ['compensating', 0], `${name}: the restarted host fences the attempt and signs nothing for it`);
    const next = await buyer.requestContext(NEXT_HOST_JOB);
    assert.deepEqual([next.status, w.signatures.length, new Set(w.signatures).size], [200, 2, 2], `${name}: the next purchase signs each Vet record once`);
  }

  // The context answer's own effect pass in the composed host, paused at its final authority read: the control answers with the effect
  // role's signature; closed there, the answer is an unsigned refusal carrying the cause, and nothing signs it.
  for (const [subcase, closed] of [['the unchanged authorized control', false], ['closure', true]]) {
    const name = `the context answer through the composed host, final authority await, ${subcase}`;
    const w = await composedVetHost(t), { buyer } = await w.start();
    w.gate.pause('authority', finals.answer.authority);
    const request = buyer.requestContext();
    await heldBefore(w.gate, request, name);
    const effectBefore = w.effectSigns();
    w.gate.closed = closed;
    w.gate.resume();
    const answer = await request;
    if (!closed) {
      assert.deepEqual([answer.status, w.effectSigns() - effectBefore], [200, 1], `${name}: the effect role signs the answer`);
      continue;
    }
    assert.deepEqual([answer.status >= 400, answer.signed, answer.body.error, w.effectSigns() - effectBefore], [true, false, 'tp1_participant_refused', 0], `${name}: ${answer.text}`);
  }

  // The paths that run outside the composed host (see PAUSED_PATHS).
  for (const [label, make] of PAUSED_PATHS) {
    // The control finds where the final authority read and stop check of the first signature's pass are: the last of each before the signer.
    const probe = await pausablePass(), probed = await make(t, probe);
    let finals = null;
    probe.gate.pause('none', 0);
    probed.onSign(() => { finals ??= { ...probe.gate.calls }; });
    await probed.attempt();
    assert.ok(finals !== null && finals.authority >= 1 && finals.stop >= 1, `${label}: the control reached its signer after its checks`);
    for (const kind of ['authority', 'stop']) {
      const subcases = [
        ['the unchanged authorized control', null, null],
        ['closure', (target, gate) => { if (kind === 'authority') gate.closed = true; else gate.stop = true; }, kind === 'authority' ? 'tp1_participant_refused' : 'seller_stopped'],
        ['issuance and reclamation', 'reclaim', 'not-pending'],
        ['rollback', 'rollback', 'not-pending'],
        ['restart', 'restart', null],
      ];
      for (const [subcase, change, code] of subcases) {
        const pass = await pausablePass(), target = await make(t, pass);
        if (typeof change === 'string' && target[change] === undefined) continue;
        pass.gate.pause(kind, finals[kind]);
        const outcome = target.attempt();
        for (let turn = 0; turn < 500 && pass.gate.held === null; turn++) await new Promise((resolve) => setImmediate(resolve));
        assert.notEqual(pass.gate.held, null, `${label}, ${kind}, ${subcase}: paused at the final ${kind} await`);
        const name = `${label}, final ${kind} await, ${subcase}`;
        if (subcase === 'restart') {
          // The paused process dies there; a new process over the same durable state signs the same signature at most once.
          const restarted = await target.restart();
          const signedAfterRestart = target.signatures();
          pass.gate.stop = true;
          pass.gate.resume();
          await outcome;
          assert.ok(signedAfterRestart <= 1 && target.signatures() === signedAfterRestart, `${name}: no second signature (${signedAfterRestart}, ${restarted.codes ?? 'answered'})`);
          continue;
        }
        if (typeof change === 'string') target[change](); else change?.(target, pass.gate);
        pass.gate.resume();
        const result = await outcome;
        if (change === null) {
          assert.ok(target.signatures() >= 1, `${name}: signs`);
          continue;
        }
        assert.equal(target.signatures(), 0, `${name}: no signature`);
        assert.ok(result.codes?.includes(code) || JSON.stringify(result.value ?? {}).includes(code), `${name}: refused ${code}, got ${result.codes} ${JSON.stringify(result.value)}`);
      }
    }
  }
});

// Runs `change(w)` at the boundary's stop read inside the dispatch pass of the world's next answer: after the answer is stored,
// while the pass awaits its reads, and before its synchronous callback.
const changeDuringDispatch = (w, change) => {
  let flipped = false;
  const stateNow = () => { try { return lastLaneState(w.f.effectsDirectory, w.jobId); } catch { return null; } };
  Object.defineProperty(w.f.stop, 'requested', { configurable: true, get: () => {
    if (!flipped && stateNow() === 'dispatch-started') { flipped = true; change(w); }
    return false;
  } });
};

test('an answer carrying the co-signature is withheld when the context session ends during its answer pass, after the answer was stored: a first proposal, a recovered one and a stored answer never acknowledged, while a repeat of an acknowledged answer is still returned', async (t) => {
  for (const terminal of ['aborted-by-other', 'finalised', 'aborted-by-self']) {
    const ends = (w) => { w.state.session = terminal; };
    const first = await proposalWireWorld(t);
    changeDuringDispatch(first, ends);
    const refused = await first.post();
    assert.deepEqual([refused.status, refused.body.error, refused.body.contribution], [409, 'context_session_terminal', undefined], `${terminal}: a first proposal's answer is withheld`);
    assert.equal((await laneStates(first.f.effectsDirectory, first.jobId)).includes('dispatch-acknowledged'), false, `${terminal}: never acknowledged as sent`);
    assert.equal(first.agreementSignatures(), 1, terminal);

    const recovered = await proposalWireWorld(t);
    changeBeforeAnswerWritten(recovered, (w) => { w.f.stop.requested = true; });
    assert.equal((await recovered.post()).body.error, 'seller_stopped');
    recovered.f.stop.requested = false;
    pastLease(recovered);
    changeDuringDispatch(recovered, ends);
    const withheld = await recovered.post();
    assert.deepEqual([withheld.status, withheld.body.error, withheld.body.contribution], [409, 'context_session_terminal', undefined], `${terminal}: a recovered proposal's answer is withheld`);
    assert.equal((await laneStates(recovered.f.effectsDirectory, recovered.jobId)).includes('dispatch-acknowledged'), false, `${terminal}: never acknowledged as sent`);
    assert.equal(recovered.agreementSignatures(), 1, terminal);

    // A repeat of an answer that was acknowledged only reads it back, so the session ending during its pass does not withhold it.
    const cached = await proposalWireWorld(t);
    const delivered = await cached.post();
    assert.equal(delivered.status, 200);
    const recorded = await laneStates(cached.f.effectsDirectory, cached.jobId);
    changeDuringDispatch(cached, ends);
    const repeat = await cached.post();
    assert.deepEqual([repeat.status, repeat.text], [200, delivered.text], `${terminal}: a cached repeat returns the retained answer`);
    assert.deepEqual((await laneStates(cached.f.effectsDirectory, cached.jobId)).slice(recorded.length), ['dispatch-started', 'dispatch-acknowledged'], terminal);
    assert.equal(cached.agreementSignatures(), 1, `${terminal}: no new signature`);

    // A stored answer that was never acknowledged is a first transmission: a retry is refused while the session has ended,
    // both when it ends during the retry's pass and when it had ended before the retry.
    for (const [when, endBefore] of [['during the retry', false], ['before the retry', true]]) {
      const unsent = await proposalWireWorld(t);
      changeDuringDispatch(unsent, ends);
      assert.equal((await unsent.post()).body.error, 'context_session_terminal', terminal);
      if (endBefore) assert.equal(unsent.state.session, terminal);
      else { unsent.state.session = null; changeDuringDispatch(unsent, ends); }
      const retry = await unsent.post();
      assert.deepEqual([retry.status, retry.body.error, retry.body.contribution], [409, 'context_session_terminal', undefined], `${terminal}: a retry of an unsent answer ${when} is refused`);
      assert.equal((await laneStates(unsent.f.effectsDirectory, unsent.jobId)).includes('dispatch-acknowledged'), false, `${terminal}: never acknowledged as sent`);
      assert.equal(unsent.agreementSignatures(), 1, terminal);
    }
  }
});

// ---- The payment-evidence lane through the boundary ----

// An authorized ensureEvidence of `journal` for `input`.
const evidenceAt = (journal, input, authorize = () => true) => journal.ensureEvidence({ ...input, expectedJournalId: journal.journalId, authorize });
const executeCounts = (node) => Object.fromEntries(['confirmTx', 'broadcastTx'].map((stage) => [stage, node.reads.filter((read) => read === stage).length]));
const REFUSED_BROADCAST = () => jsonResponse({ result: 400, response: 'TEST-refused' });
// Runs `call` while the node refuses every broadcast, so the CREATE it signs is kept and unsent.
async function keptUnsent(node, call) {
  replyTo(node, 'broadcastTx', REFUSED_BROADCAST);
  await settled(call());
  node.reply = null;
}
const releasesOf = (ledger, ledgerId) => ledger.settlements.filter((entry) => entry.ledgerId === ledgerId && entry.outcome === 'released').length;
// A hold no adapter issued: the pass accepts its shape, and the boundary or the adapter refuses it before any signature or send.
const STAND_IN_HOLD = Object.freeze({ revision: () => 'TEST-hold', release: async () => {} });
const STAND_IN_RETAINED = Object.freeze({ signedTransaction: '{}', txHash: 'a'.repeat(64) });
const REPLACEMENT_CHILD = new URL('./helpers/payment-evidence-replacement-child.mjs', import.meta.url);
// The node answers each block read as another chain's node.
const otherChainBlocks = (row) => (row.body?.params[0].message === 'getBlockByNumber'
  ? jsonResponse({ result: 200, response: { number: row.body.params[0].data.blockNumber, status: 'confirmed', hash: 'd'.repeat(64), content: { previousHash: 'd'.repeat(64) } } }) : undefined);
// Inner transaction signatures, counted beneath the client gate.
async function innerTransactionSignatures(t) {
  const counted = { signatures: 0 };
  await spyTransactionSignatures(t.mock, () => {}, { onInnerSign: ({ inTransaction }) => { if (inTransaction) counted.signatures++; } });
  return counted;
}

test('the payment-evidence journal runs the boundary\'s tail inside signCreate and the final check inside the adapter broadcast reaches, with no microtask between the final check and the call', async (t) => {
  const events = [], late = [];
  let microtaskRan = true;
  const effect = (label) => { if (microtaskRan) late.push(label); events.push(label); };
  await spyTransactionSignatures(t.mock, () => {}, { onInnerSign: ({ inTransaction }) => { if (inTransaction) effect('inner-sign'); } });
  const world = await walletSessionWorld(t);
  // The scripted fetch records each request in its first step after the body parse, reached with no await from the gate.
  const calls = world.node.calls, push = calls.push;
  calls.push = (row) => {
    const call = row.body?.params?.[0];
    const transaction = call?.extra === 'confirmTx' ? call.data : call?.extra === 'broadcastTx' ? call.data.response.data.transaction : null;
    if (transaction?.content?.type === 'storageProgram') effect(call.extra);
    return Reflect.apply(push, calls, [row]);
  };
  const { session } = await world.finalize();
  const authorize = () => { events.push('authorization'); microtaskRan = false; queueMicrotask(() => { microtaskRan = true; }); return true; };
  assert.equal((await evidenceAt(session.paymentEvidence, evidenceInput({ wallet: session }), authorize)).status, 'submitted');
  const effects = events.filter((event) => event !== 'authorization');
  assert.deepEqual(effects, ['inner-sign', 'confirmTx', 'broadcastTx'], 'one signature, one confirmation and one broadcast');
  for (const label of effects) assert.equal(events[events.indexOf(label) - 1], 'authorization', `${label} comes right after the pass's last authorization check`);
  assert.deepEqual(late, [], 'no microtask ran between the last check and the signer or the request');
});

test('the payment-evidence lane sends again only the exact retained CREATE under fresh checks, and the wallet CREATE lane never resends a native broadcast; after an authenticated applied observation both retry paths make zero broadcast calls, a duplicate-rejecting broadcaster is called once in total, and the row and hash stay unchanged; an unobserved or pending CREATE still replays its exact bytes once; a refusal before sending (the node\'s chain check, journal-busy) leaves the row unchanged and counts as nothing sent', async (t) => {
  // The applied skip, the chain-check refusal and the native-broadcast half rest on rules this lane does not change: regression coverage.
  const world = await walletSessionWorld(t);
  const { session } = await world.finalize();
  const journal = session.paymentEvidence, input = evidenceInput({ wallet: session }), ledger = world.options.approve.retained;
  await keptUnsent(world.node, () => evidenceAt(journal, input));
  const kept = await journal.readSignedProjection(input);
  const counts = () => ({ ...executeCounts(world.node), asked: ledger.prepared.length });
  const before = counts();
  assert.equal((await journal.reconcilePaymentEvidence(input)).status, 'pending', 'the reconcile resend has no authorization check: pending');
  assert.deepEqual(counts(), before, 'it asked and sent nothing');
  world.node.reply = otherChainBlocks;
  assert.ok((await settled(evidenceAt(journal, input))).error, 'the node\'s chain check refuses before sending');
  world.node.reply = null;
  assert.deepEqual(executeCounts(world.node), { confirmTx: before.confirmTx, broadcastTx: before.broadcastTx }, 'nothing was sent');
  assert.deepEqual(await evidenceAt(journal, input), { status: 'submitted', txHash: kept.hash }, 'under fresh checks the kept CREATE goes out again');
  assert.deepEqual(executeCounts(world.node), { confirmTx: before.confirmTx + 1, broadcastTx: before.broadcastTx + 1 }, 'once');
  assert.deepEqual(world.node.broadcasts.at(-1), kept, 'as its exact bytes');
  let duplicates = 0;
  replyTo(world.node, 'broadcastTx', () => { duplicates++; return jsonResponse({ result: 400, response: 'TEST-duplicate' }); });
  const applied = counts();
  assert.deepEqual(await evidenceAt(journal, input), { status: 'applied', txHash: kept.hash });
  assert.deepEqual(await journal.reconcilePaymentEvidence(input), { status: 'applied', txHash: kept.hash });
  assert.deepEqual({ ...counts(), duplicates }, { ...applied, duplicates: 0 }, 'after the applied observation neither retry path broadcasts');
  assert.deepEqual(await journal.readSignedProjection(input), kept, 'the row and hash are unchanged');
  assert.ok(world.node.broadcasts.every((transaction) => transaction.content.type === 'storageProgram'), 'every broadcast was a storage CREATE, never a native transfer');
  await session.close();

  // The send is bound to the exact live kept row: each case holds the send pass at its final stop, the last await before the
  // gate's synchronous run, and changes the row's file. Every other check passes there (the hold, the binding, the stop and the
  // caller's check), so without the live-row check confirmTx would be called once.
  const cases = [['superseded', (raw, hash) => raw.prepare('UPDATE evidence_creates SET superseded_at = 1 WHERE tx_hash = ?').run(hash), 'wallet_journal_conflict'],
    ['busy', (raw) => raw.exec('BEGIN EXCLUSIVE'), 'wallet_journal_busy']];
  for (const [label, change, code] of cases) {
    const sellerWorld = await sellerWalletWorld(t), stop = holdableStop(), evidence = evidenceInput(sellerWorld);
    const { journal: direct } = journalOverPass(sellerWorld, { stopped: stop.stopped });
    const held = stop.holdNext(1);
    const call = settled(evidenceAt(direct, evidence));
    const { release } = await held;
    const row = await direct.readSignedProjection(evidence), sent = executeCounts(sellerWorld.node);
    const raw = new Database(join(sellerWorld.directory, PAYMENT_EVIDENCE_JOURNAL));
    change(raw, row.hash);
    release();
    assert.ok(causeCodes((await call).error).includes(code), `${label}: refused ${code}`);
    assert.deepEqual(executeCounts(sellerWorld.node), sent, `${label}: nothing was confirmed or sent`);
    if (label === 'busy') {
      raw.exec('ROLLBACK');
      assert.deepEqual(await direct.readSignedProjection(evidence), row, 'busy: the row is unchanged');
      assert.deepEqual(await evidenceAt(direct, evidence), { status: 'submitted', txHash: row.hash }, 'busy: the next authorized call sends the kept bytes');
      assert.deepEqual(executeCounts(sellerWorld.node), { confirmTx: sent.confirmTx + 1, broadcastTx: sent.broadcastTx + 1 }, 'busy: once');
    }
    raw.close();
    await sellerWorld.wallet.close();
  }
});

test('a payment-evidence signature pass that waits for the effect fence past the journal\'s deadline signs nothing: its approval is released, and the next authorized call asks the ledger once more and signs once', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  const world = await sellerWalletWorld(t), input = evidenceInput(world), ledger = world.approval;
  const { journal, runCreate } = journalOverPass(world, { readTimeoutMs: 300 });
  // Another runCreate of the same boundary holds its one fence (one per boundary, not per lane) until the row frees it.
  let free, holding;
  const holds = new Promise((resolve) => { holding = resolve; });
  const holder = runCreate({ operationId: 'TEST-fence-holder', lane: 'TEST-fence-holder', operationClass: 'job-create', currentAuthorization: () => true },
    () => { holding(); return new Promise((resolve) => { free = resolve; }); });
  await holds;
  assert.equal((await settled(evidenceAt(journal, input))).error?.code, 'wallet_sign_timeout');
  assert.deepEqual({ signatures: signatures.length, asked: ledger.prepared.length, released: releasesOf(ledger, 'TEST-ledger-1') }, { signatures: 0, asked: 1, released: 1 },
    'asked once outside the fence, signed nothing, and the untaken approval was released once');
  // Granted the fence late, the pass stops at its work's first step: its signal was aborted, so the adapter is never reached.
  free();
  await holder;
  assert.equal((await evidenceAt(journal, input)).status, 'submitted');
  assert.deepEqual({ signatures: signatures.length, asked: ledger.prepared.length, ...executeCounts(world.node) }, { signatures: 1, asked: 2, confirmTx: 1, broadcastTx: 1 });
});

test('a payment-evidence signature that finishes after the journal\'s deadline grants no send: the late signature is dropped, its reservation is retired and its approval released once, the journal keeps nothing, and the next authorized call asks the ledger once more, signs once at the same nonce and sends once', async (t) => {
  // The adapter's drop of a late signature is the client's rule: that half is regression coverage.
  let hold = null;
  const signatures = await spyTransactionSignatures(t.mock, () => { const held = hold; hold = null; return held; });
  const world = await sellerWalletWorld(t), input = evidenceInput(world), ledger = world.approval;
  const { journal } = journalOverPass(world, { readTimeoutMs: 300 });
  let finish;
  hold = new Promise((resolve) => { finish = resolve; });
  assert.equal((await settled(evidenceAt(journal, input))).error?.code, 'wallet_sign_timeout', 'the first signature finishes after the deadline');
  assert.equal(await journal.readSignedProjection(input), null, 'the journal kept nothing');
  // The first call's retirement runs in the adapter's queue ahead of the next call's ask, so it is asserted once that ask is made.
  const asked = new Promise((resolve) => { ledger.script.push(() => resolve()); });
  const next = settled(evidenceAt(journal, input));
  await asked;
  assert.equal(releasesOf(ledger, 'TEST-ledger-1'), 1, 'the late signature\'s reservation was retired and its approval released once');
  finish();
  assert.equal((await next).value?.status, 'submitted');
  assert.equal(ledger.prepared.length, 2, 'the next call asked the ledger once more');
  assert.equal(signatures.length, 2, 'two transaction signatures');
  assert.equal(signatures[0], signatures[1], 'both at the same nonce');
  assert.deepEqual(executeCounts(world.node), { confirmTx: 1, broadcastTx: 1 }, 'only the next call\'s CREATE was sent');
});

test('a failed or lost commit between signCreate and the stored row sends nothing; a committed row is replayed only as the identical CREATE under fresh authorization', async (t) => {
  let path = null, reader = null;
  // From inside the signature, a raw handle starts a read transaction on the journal file, so the round's commit fails busy.
  const signatures = await spyTransactionSignatures(t.mock, () => {
    if (path === null || reader !== null) return;
    reader = new Database(path, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS kept FROM evidence_creates').get();
  });
  const world = await sellerWalletWorld(t), input = evidenceInput(world), ledger = world.approval;
  const { journal } = journalOverPass(world);
  path = join(world.directory, PAYMENT_EVIDENCE_JOURNAL);
  assert.ok((await settled(evidenceAt(journal, input))).error, 'the round\'s commit failed');
  reader.exec('COMMIT');
  reader.close();
  assert.equal(await journal.readSignedProjection(input), null, 'no row was kept');
  assert.deepEqual(executeCounts(world.node), { confirmTx: 0, broadcastTx: 0 }, 'nothing was sent');
  // The next call takes the bytes the adapter stored: no new ask and no new signature. The node refuses its broadcast.
  const asked = ledger.prepared.length;
  await keptUnsent(world.node, () => evidenceAt(journal, input));
  const kept = await journal.readSignedProjection(input);
  assert.ok(kept, 'the stored bytes are kept');
  assert.deepEqual({ asked: ledger.prepared.length, signatures: signatures.length }, { asked, signatures: 1 }, 'no ledger ask and no new signature');
  assert.deepEqual(await evidenceAt(journal, input), { status: 'submitted', txHash: kept.hash }, 'the committed row is sent again under fresh authorization');
  assert.deepEqual(world.node.broadcasts, [kept, kept], 'as the identical CREATE each time');
  assert.equal(signatures.length, 1);
});

test('an applied row never broadcasts again; supersession needs complete nonce-fenced absence; a crash during replacement leaves at most one executable CREATE', async (t) => {
  // Regression coverage of the journal's unchanged rules, through its approve-ahead rounds over the stand-in wallet chain: the client
  // adapter's readback never proves that a kept CREATE will not execute, so the session's journal never supersedes one.
  const directory = privateDataDirectory(t), path = join(directory, PAYMENT_EVIDENCE_JOURNAL), chainFile = join(directory, 'chain.json');
  writeFileSync(chainFile, JSON.stringify(newWalletChainState()));
  let wallet;
  const reopen = () => { wallet = walletChain({ file: chainFile }); return approvingChainJournal(path, wallet); };
  const sent = () => wallet.chain.sent ?? [];
  let journal = reopen();
  const appliedInput = chainEvidenceInput(wallet.claim, { logicalAddress: 'dacs4:payment:TEST-applied:demos-native:DEM:2', jobId: 'TEST-applied' });
  const landed = await evidenceAt(journal, appliedInput);
  wallet.land(landed.txHash);
  const sends = sent().length;
  assert.deepEqual(await evidenceAt(journal, appliedInput), { status: 'applied', txHash: landed.txHash });
  assert.deepEqual(await journal.reconcilePaymentEvidence(appliedInput), { status: 'applied', txHash: landed.txHash });
  assert.equal(sent().length, sends, 'an applied row is never broadcast again');

  const input = chainEvidenceInput(wallet.claim);
  const original = await evidenceAt(journal, input);
  assert.deepEqual(await evidenceAt(journal, input), original, 'while its nonce is free, a fenced absence supersedes nothing: the same CREATE goes out again');
  wallet.other();
  journal.close();
  const replace = (cut) => runWalletChild(cut, directory, directory, { child: { url: REPLACEMENT_CHILD, args: [cut, path, chainFile] } });
  for (const cut of ['update', 'insert']) {
    const child = await replace(cut);
    assert.equal(child.signal, 'SIGKILL', `${cut}: ${child.stderr}`);
    journal = reopen();
    assert.equal((await journal.readSignedProjection(input)).hash, original.txHash, `${cut}: the killed transaction left the original CREATE live`);
    assert.deepEqual(sent().filter((hash) => ![landed.txHash, original.txHash].includes(hash)), [], `${cut}: no successor was sent`);
    journal.close();
  }
  const committed = await replace('kept');
  assert.equal(committed.signal, 'SIGKILL', committed.stderr);
  journal = reopen();
  const successor = await journal.readSignedProjection(input);
  assert.notEqual(successor.hash, original.txHash, 'after the commit the replacement is the live CREATE');
  assert.equal(sent().includes(successor.hash), false, 'and it was not sent');
  assert.deepEqual(await evidenceAt(journal, input), { status: 'submitted', txHash: successor.hash });
  const executable = [...new Set(sent())].filter((hash) => wallet.chain.signed[hash] > wallet.accountNonce());
  assert.deepEqual(executable, [successor.hash], 'at most one executable CREATE was sent: the committed replacement, as its exact bytes');
  assert.equal(sent().filter((hash) => hash === successor.hash).length, 1, 'sent once');
  journal.close();
});

test('the operator\'s payment-evidence approval is asked before the effect pass opens: an approval that waits longer than the pass window holds no effect fence and still signs once it is given', async (t) => {
  // While the operator decides no lock is held and nothing waits on this call, as the client's default reads "no lane held";
  // the signer's next nonce stays reserved. The port's clock moves 30 s while the answer is pending: a pass open across it
  // would be refused as late.
  const signatures = await spyTransactionSignatures(t.mock);
  const directory = privateDataDirectory(t), operator = heldOperator();
  let offset = 0;
  const clock = { now: () => T0 + offset };
  const world = await walletSessionWorld(t, { directory, options: { approvalMode: 'manual', clock,
    approve: manualSellerApproval({ directory, operator: operator.operator, now: clock.now, t }) } });
  const { session } = await world.finalize();
  const asked = operator.nextAsk();
  const call = settled(evidenceAt(session.paymentEvidence, evidenceInput({ wallet: session })));
  await asked;
  const other = { operationId: 'TEST-other', lane: 'TEST-other', operationClass: 'job-create', currentAuthorization: () => true };
  assert.equal(await world.port.runCreate(other, async () => 'TEST-granted'), 'TEST-granted', 'another operation is granted the kit fence');
  (await session.acquireConnectionFence()).release();
  const raw = new Database(join(directory, PAYMENT_EVIDENCE_JOURNAL), { timeout: 0 });
  raw.exec('BEGIN IMMEDIATE; COMMIT');
  raw.close();
  offset += 30_000;
  operator.asked[0].answer(true);
  assert.equal((await call).value?.status, 'submitted', 'the CREATE signs once the operator answers, in a pass that meets its deadline');
  assert.deepEqual({ signatures: signatures.length, asked: operator.asked.length }, { signatures: 1, asked: 1 });
});

test('an approval taken while another journal handle keeps a CREATE for the same evidence is released unused: one signature, one kept row, and the approval\'s authorization released once', async (t) => {
  const signatures = await spyTransactionSignatures(t.mock);
  // World 1's operator decides alone and answers only when the row says so.
  const operator = recordingApproval({ manual: true });
  let answer, asking;
  const asked = new Promise((resolve) => { asking = resolve; });
  operator.script.push(async () => { asking(); await new Promise((resolve) => { answer = resolve; }); });
  const world1 = await sellerWalletWorld(t, { options: { approvalMode: 'manual', approve: sellerApproval(operator) } });
  const world2 = await sellerWalletWorld(t, { node: world1.node });
  const input = evidenceInput(world1), path = join(world1.directory, PAYMENT_EVIDENCE_JOURNAL);
  const { journal } = journalOverPass(world1);
  const first = settled(evidenceAt(journal, input));
  await asked;
  // Meanwhile a second handle on the same file, over world 2's wallet with its own signer reservation, keeps a CREATE unsent.
  await keptUnsent(world1.node, () => inWalletPass(world2, () => journalOverAdapter(world2, { path }).anchorEvidence(input)));
  const kept = await journal.readSignedProjection(input);
  answer();
  const { error } = await first;
  assert.ok(causeCodes(error).includes('retained_transaction_invalid'), `world 1's adapter does not hold those bytes, so nothing is sent: ${causeCodes(error)}`);
  assert.equal(signatures.length, 1, 'one signature in total, world 2\'s');
  const raw = new Database(path, { readonly: true });
  assert.equal(raw.prepare('SELECT COUNT(*) AS kept FROM evidence_creates').get().kept, 1, 'one kept row');
  raw.close();
  assert.deepEqual(await journal.readSignedProjection(input), kept);
  assert.deepEqual(operator.settlements.map(({ outcome }) => outcome), ['released'], 'the unused approval was released once');
});

test('a payment-evidence approval withdrawn at the ledger while the signature pass awaits its final stop makes no inner signature, and neither does a release of another binding started at its final stop: the gate\'s last synchronous run refuses it, nothing is kept, and the next authorized call asks the ledger once more and signs once', async (t) => {
  const counted = await innerTransactionSignatures(t);
  // Only the last synchronous run can see the release: the refresh compares the approval's revision before the binding's await,
  // and the final stop comes after the refresh.
  for (const withdrawn of ['the evidence approval', 'another binding']) {
    const world = await sellerWalletWorld(t), stop = holdableStop(), input = evidenceInput(world), ledger = world.approval;
    const { journal } = journalOverPass(world, { stopped: stop.stopped });
    // A release of another binding refuses too: the ledger's count of started releases is ledger-wide, the giver's conservative
    // contract. In shipped flows it moves only on this lane's own releases.
    const unrelated = withdrawn === 'another binding' ? (await ledger.prepare({ content: { kind: 'TEST-unrelated' } })).ledgerId : null;
    const before = counted.signatures;
    const held = stop.holdNext();
    const call = settled(evidenceAt(journal, input));
    const { release } = await held;
    const evidenceLedgerId = ledger.entries.find((entry) => entry.ledgerId !== unrelated).ledgerId;
    await ledger.settle(ledger.bindingOf(unrelated ?? evidenceLedgerId), 'released', 'TEST-operator');
    release();
    const { error } = await call;
    assert.ok(causeCodes(error).includes('write-fee-cap'), `${withdrawn}: refused at the last synchronous run: ${causeCodes(error)}`);
    assert.equal(counted.signatures, before, `${withdrawn}: no inner signature`);
    assert.equal(await journal.readSignedProjection(input), null, `${withdrawn}: nothing was kept`);
    assert.equal(executeCounts(world.node).confirmTx, 0, `${withdrawn}: nothing was confirmed`);
    if (unrelated) assert.equal(releasesOf(ledger, evidenceLedgerId), 1, 'the evidence approval was released once, by the adapter\'s retirement');
    const asks = ledger.prepared.length;
    assert.equal((await evidenceAt(journal, input)).status, 'submitted', `${withdrawn}: the next authorized call signs and sends`);
    assert.deepEqual({ asked: ledger.prepared.length - asks, signed: counted.signatures - before }, { asked: 1, signed: 1 }, `${withdrawn}: asked once more and signed once`);
    await world.wallet.close();
  }
});
