// The seller's effect paths. The CREATE lanes at the artifact anchor's publish, over the production wallet session: every
// refusal is raised before publish reaches the wallet, with no authority or node read, no stored intent and no signature.
// The agent's signatures and the answer that carries its Agreement co-signature, through the host's effect boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS } from '@kynesyslabs/dacs/wire';
import { anchorFixture, signSdkCreate } from './helpers/anchor-isolated-fixture.mjs';
import { agentFixture, fixtureProposal } from './helpers/seller-agent-isolated-fixture.mjs';
import { countedKeyRoles } from './helpers/counted-key-roles.mjs';
import { proposalWireWorld } from './helpers/proposal-wire-world.mjs';
import { PATHS } from './helpers/wire-routes-world.mjs';
import { MONOTONIC_CLOCK, TEST_BINDING, integrityRoleOf } from './helpers/agent-signing.mjs';
import { TEST_CONNECTION } from './helpers/wire-authority-fixture.mjs';
import { JOBS } from './helpers/bilateral-vet-fixture.mjs';
import { T0, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';
import { walletSessionWorld } from './helpers/seller-wallet-session-world.mjs';

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

// The Listing publisher over `anchor`, with the world's signer, and the Listing draft it publishes.
function listingPublisher(world, anchor) {
  const publish = createDevnetDemoListingPublisher({ anchor, sign: (bytes) => world.signer.signBytes(bytes), scanOwnListings: async () => ({ status: 'ok', anchors: [] }),
    loadRailResolution: railAuthority });
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
  await assert.rejects(anchor.publish({ ...input, ...PASS }), { code: 'nonce_lane_unavailable' }, 'with both it passes the parameter check');
  assert.deepEqual(world.effects(), NOTHING);
  assert.equal(await anchor.hasIntent(LISTING_ADDRESS), false);
});

test('the Listing publisher passes operationClass job-create and its publication check: over the real session its publish passes publish\'s parameter check and stops at nonce_lane_unavailable, storing no intent, while a publish without them refuses at the parameter check', async (t) => {
  const { world, anchor } = await finalizedWorld(t);
  const inputs = [];
  const recording = Object.freeze({ ...anchor, publish: (input) => { inputs.push(input); return anchor.publish(input); } });
  const { publish, draft } = listingPublisher(world, recording);
  world.baseline();
  const refusal = await publish(draft).then(() => assert.fail('expected a refusal'), (error) => error);
  const codes = [];
  for (let link = refusal; link instanceof Error; link = link.cause) codes.push(link.code);
  assert.ok(codes.includes('nonce_lane_unavailable'), `the publish passed the parameter check: ${codes} ${refusal}`);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].operationClass, 'job-create');
  assert.equal(inputs[0].currentAuthorization(), true);
  const withoutPass = { ...inputs[0] };
  delete withoutPass.operationClass;
  delete withoutPass.currentAuthorization;
  await assert.rejects(anchor.publish(withoutPass), { code: 'invalid' }, 'the same publish without them');
  assert.deepEqual(world.effects(), NOTHING);
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
    const agent = await createSellerAgent({ ...w.config, effectSigner, integritySigner, effectBoundary });
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
  assert.deepEqual(roles.counts, { effect: beforeSignOnce.effect, integrity: beforeSignOnce.integrity + 1 }, 'the only signature was the intent\'s journal record');
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
  w.agent.agreementState = (identity) => w.realAgent().agreementState(identity);
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
