// The seller's effect paths. The CREATE lanes at the artifact anchor's publish, over the production wallet session: every
// refusal is raised before publish reaches the wallet, with no stored intent and no signature, and a refusal before the admitted
// binding check makes no node read.
// The agent's signatures and the answer that carries its Agreement co-signature, through the host's effect boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as core from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, TP1_APPROVED_IDENTITY_RECORD, WireError, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import { T0, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';
import { walletSessionWorld } from './helpers/seller-wallet-session-world.mjs';

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
const { createSellerAgentClient } = await import('../src/dacs/seller-http.mjs');
const { createWireContext } = await import('../src/dacs/seller-wire-requests.mjs');
const { orchestratorFixture } = await import('./helpers/vet-orchestrator-fixture.mjs');
const { productionFixture } = await import('./helpers/vet-production-fixture.mjs');
const { contextHostFixture } = await import('./helpers/host-context-client.mjs');
const { seller: protocolSeller } = await import('./helpers/protocol-fixture.mjs');
const { world: wireWorld, proposeJob, identityBody, BUYER, PIN } = await import('./helpers/wire-routes-world.mjs');
const { FIXTURE_ENDPOINT } = await import('./helpers/wire-buyer.mjs');
const { createSellerWireClientAuth } = await import('../src/dacs/seller-wire-client-auth.mjs');
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

test('a runCreate refusal before a retained CREATE\'s resend records no recovery intent and sends nothing, so the one resend stays open for the next read', async () => {
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
  await assert.rejects(f.open().read(input, resend), { code: 'seller_stopped' });
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
    assert.deepEqual((await laneStates(after.f.effectsDirectory, after.jobId)).slice(0, 2), ['signed', 'dispatch-started'], 'the retained signature stays evidence only');

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
    effectBoundary: w.effectBoundary, journal, store: watched, ready: () => true, now: w.clock, agent: w.agent, requireDelegation: false, readCommitmentReceipt }), TypeError);
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
});

test('the approved record signs and transmits on every seller inventory path', async (t) => {
  for (const row of await inventory(t, passOver())) {
    await row.attempt();
    assert.ok(row.signatures() >= 1, `${row.label}: signed`);
    if (row.label !== 'an effect-route answer') assert.ok(row.transmissions() >= 1, `${row.label}: transmitted after signing`);
  }
  const { posts, client } = countingClient();
  await client.propose({});
  assert.equal(posts.count, 1, 'the kit client\'s returned method sends');
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
  const w = await wireWorld(t);
  const buyerSigns = { count: 0 };
  const buyerSigner = createSellerWireClientAuth({ signer: { claim: BUYER.claim, sign: (bytes) => { buyerSigns.count++; return BUYER.sign(bytes); } }, binding: w.buyerWire.binding,
    connection: w.buyerWire.connection, endpointProof: w.buyerWire.endpointProof, publicEndpoint: FIXTURE_ENDPOINT, seller: protocolSeller.claim,
    resolveJob: async () => ({ listingPin: PIN, agreementHash: 'a'.repeat(64) }) });
  const op = { runCreate, operationId: 'TEST-off', lane: 'TEST-off', operationClass: 'job-create', currentAuthorization: () => true };
  const discoveryBinding = await keyTestBinding();
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
    'createSellerWireClientAuth.request': () => buyerSigner.request(PATHS.proposals, {}, '{}'),
  };
  for (const [entry, run] of Object.entries(refusals)) {
    const outcome = await settled(Promise.resolve().then(run));
    assert.ok(outcome.codes?.includes('kit_operation_guard_off'), `${entry}: refused kit_operation_guard_off, got ${outcome.codes}`);
  }
  assert.deepEqual({ ...reads, posts: posts.count, effect: roles.counts.effect, buyerSigns: buyerSigns.count }, { store: 0, scans: 0, posts: 0, effect: 0, buyerSigns: 0 },
    'refused before any read, POST or signature');
  roles.integritySigner.sign(Buffer.concat([Buffer.from(SELLER_STATE_SIGNING_DOMAIN), Buffer.from('TEST-journal-record')]));
  await (await roles.readOnlyAnswerSigner({ purpose: 'discovery', binding: discoveryBinding, local: KEY_LOCAL }))
    .sign(wireApi.discoverySigningBytes(discoveryPayload(discoveryBinding, { seller: roles.key.claim })));
  assert.deepEqual(roles.counts, { effect: 0, integrity: 1, readOnly: 1 }, 'while off the integrity role signs journal bytes and the read-only role a ready:false document, each counted on its own');
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

// The paths whose final checks are paused: each `make(pass)` gives `{ attempt(), signatures(), onSign(hook), reclaim?, rollback?, restart? }`.
const PAUSED_PATHS = [
  ['the Vet component signature', async (t, pass) => {
    const f = await orchestratorFixture(t), open = { value: true };
    const provider = f.provider({ runCreate: pass.runCreate });
    return { attempt: () => settled(provider.resolveBuyer(f.input, { writable: () => open.value })), signatures: () => f.controls.signatures.length,
      onSign: (hook) => { f.controls.beforeSign = hook; }, reclaim: () => { open.value = false; }, rollback: () => { open.value = 'TEST-rev-advanced'; },
      restart: () => settled(f.fresh({ runCreate: testRunCreate().runCreate }).resolveBuyer(f.input, { writable: () => true })) };
  }],
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

test('run the final pause-and-resume subcases at the real final authority and stop awaits through the composed host and the real seller routes: issuance and reclamation, rollback, closure and restart, each with its expected outcome and refusal cause; closed authority grants no signature or transmission, and the unchanged authorized control succeeds; the payment-evidence leg and the CREATE-lane matrix included', async (t) => {
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


