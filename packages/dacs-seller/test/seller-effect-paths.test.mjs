// The seller's CREATE lanes at the artifact anchor's publish, over the production wallet session. Every refusal here is raised
// before publish reaches the wallet: no stored intent and no signature follows any of them, and a refusal before the admitted binding check makes no node read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { T0, spyTransactionSignatures } from './helpers/seller-node-wallet-world.mjs';
import { walletSessionWorld } from './helpers/seller-wallet-session-world.mjs';

// Static imports are all resolved before any module runs, so a module that reaches the client's admission state must be imported
// after the world helper above has installed the purchase-admission hook.
const { anchorFixture, signSdkCreate } = await import('./helpers/anchor-isolated-fixture.mjs');
const guard = await import('../src/kit-operation-guard.mjs');
const { createDevnetDemoArtifactAnchor } = await import('../src/devnet-demo/artifact-anchor.mjs');
const { createDevnetDemoListingPublisher } = await import('../src/devnet-demo/listing.mjs');
const { createDevnetDemoDeliveryCapability } = await import('../src/devnet-demo/native-delivery.mjs');
const { submitNativeDemDelivery } = await import('../src/dacs/native-dem-delivery-consumer.mjs');
const { fixtureListing } = await import('./fixtures/listings.mjs');

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
  assert.deepEqual(world.effects(), BINDING_READ_ONLY);
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
