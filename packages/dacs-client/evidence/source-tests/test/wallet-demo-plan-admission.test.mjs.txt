// Embedded wallet plan admission for the Node2 demo transport. The demo
// transport admits exactly the demo artifact kinds plus, only when its
// publication declares it, the seller's demo-kind delivery SettlementEvidence.
// Every other plan shape keeps its pre-existing routing: in particular a
// delivery-kind fixture-test-report Deliverable is refused on a demo transport.
// The plan is checked before any network call; an admitted plan's first
// effect is the source binding fetch, which this test answers with a stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalize, contentHash } from '@kynesyslabs/dacs';
import * as wallet from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const ORIGIN = globalThis.location.origin, NETWORK = 'demos-devnet', CHAIN = 'd'.repeat(64), AUTHORITY = 'TEST-RUN-plan-admission';
const jobId = '01ARZ3NDEKTSV4RRFFQ69G5FAV', agreementHash = 'e'.repeat(64), pin = { listingId: 'plan-listing', version: 1, contentHash: 'b'.repeat(64) };
const settlementPublication = { policy: wallet.DEVNET_SETTLEMENT_POLICY, artifactKind: 'SettlementEvidence', phase: 'pay-dem', railId: 'demos-native:DEM', phaseIndex: 2, authority: 'TEST-settlement' };
const deliveryPublication = { policy: wallet.DEVNET_DELIVERY_POLICY, artifactKind: 'Deliverable', phase: 'deliver-storage-program', phaseIndex: 3, authority: 'TEST-delivery' };
const DEMO = [...wallet.DEVNET_DEMO_ARTIFACT_TYPES], DEMO_WITH_EVIDENCE = [...wallet.DEVNET_DEMO_ARTIFACT_TYPES, 'SettlementEvidence'];

function transportFor(artifactKinds) {
  const demo = artifactKinds ? { policy: wallet.DEVNET_DEMO_ARTIFACT_POLICY, artifactKinds, authority: AUTHORITY } : null;
  const transportBinding = { source: 'devnet-agreement-transport/v1', bindingVersion: 'dacs-demos-network-binding/v1', bindingId: 'c'.repeat(64), network: NETWORK, chainIdentity: CHAIN,
    pinVersion: 'TEST-pin', endpoint: 'https://node2.test.invalid/', transportAuthority: 'TEST-owner', settlementPublication, deliveryPublication, ...(demo ? { demoArtifactPublication: demo } : {}) };
  return wallet.createDevnetAgreementWalletTransport({ profile: wallet.DEVNET_AGREEMENT_TRANSPORT_PROFILE, network: NETWORK,
    rpcUrl: `${ORIGIN}/portal/api/devnet-native-wallet-rpc`, bindingUrl: `${ORIGIN}/portal/api/devnet-native-wallet-binding`,
    transportBinding, settlementPublication, deliveryPublication, ...(demo ? { demoArtifactPublication: demo } : {}) });
}

async function walletFor(t, transactionTransport) {
  const session = wallet.createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, anchorJournal: memoryAnchorJournal(), transactionTransport, approve: async () => true });
  await session.create(); t.after(() => session.lock());
  const address = (await session.request({ method: 'connect' })).data;
  return { session, address, owner: `did:demos:agent:${address.slice(2)}` };
}

function anchorRequest({ transport, address, kind, artifactKind, artifact, logicalAddress, metadata = {} }) {
  const programName = logicalAddress.replace(/:/g, '%3A'), nonce = 1, storageAddress = deriveStorageAddress(address, programName, nonce, '');
  const transaction = buildStorageProgramCreatePayload({ from: address, storageAddress, programName, logicalAddress, signedListing: artifact, nonce, timestamp: 7 });
  Object.assign(transaction.content, { from_ed25519_address: address, network: NETWORK, chainIdentity: CHAIN });
  Object.assign(transaction.content.data[1].metadata, { contentHash: contentHash(artifact), envelopeHash: sha(canonicalize(artifact)), artifactKind, networkBinding: structuredClone(transport.transportBinding), ...metadata });
  return { kind, profile: wallet.DEVNET_AGREEMENT_TRANSPORT_PROFILE, network: NETWORK, owner: `did:demos:agent:${address.slice(2)}`, artifactKind, jobId: artifact.jobId,
    logicalAddress, contentHash: contentHash(artifact), envelopeHash: sha(canonicalize(artifact)), transaction };
}
const deliveryBinding = (payloadHash) => ({ version: '1', profile: wallet.DEVNET_DELIVERY_POLICY, jobId, phase: 'deliver-storage-program', phaseIndex: 3, listing: pin, agreementHash,
  fulfilmentId: 'TEST-fulfilment', purchaseAmount: { amount: '1', currency: 'DEM' }, payloadHash });
const artifactBinding = (artifactKind, logicalAddress, writer) => ({ version: '1', policy: wallet.DEVNET_DEMO_ARTIFACT_POLICY, authority: AUTHORITY, artifactKind, jobId, logicalAddress, writer });

// The fixture-test-report Deliverable that only the delivery profile carries.
function testReportDeliverable(transport, address) {
  const artifact = { reportVersion: '1', kind: 'dacs-chatgpt-plugin/fixture-test-report', jobId, agreementHash, listing: pin, title: 'Fixture report', settlementId: 'demos:TEST', body: ['line'] };
  return anchorRequest({ transport, address, kind: wallet.DEVNET_DELIVERY_STORAGE_KIND, artifactKind: 'Deliverable', artifact, logicalAddress: `dacs4:deliverable:${jobId}`,
    metadata: { deliveryBinding: deliveryBinding(contentHash(artifact)) } });
}
// The demo lane's purchased-report Deliverable.
function purchasedDeliverable(transport, address, owner) {
  const artifact = { reportVersion: '1', kind: 'dacs-chatgpt-plugin/devnet-purchased-report', jobId, agreementHash, listing: pin, title: 'Purchased report', settlementId: 'demos:TEST', producer: owner,
    content: { mediaType: 'text/plain; charset=utf-8', text: 'Purchased bytes' } };
  const logicalAddress = `dacs4:deliverable:${jobId}`;
  return anchorRequest({ transport, address, kind: wallet.DEVNET_DEMO_STORAGE_KIND, artifactKind: 'Deliverable', artifact, logicalAddress,
    metadata: { artifactBinding: artifactBinding('Deliverable', logicalAddress, owner), deliveryBinding: deliveryBinding(contentHash(artifact)) } });
}
// The seller's delivery SettlementEvidence, signed by this wallet over the SDK
// evidence separator unless a forged signature is requested.
async function deliveryEvidence(transport, { session, address, owner }, { forged = false } = {}) {
  const unsigned = { evidenceVersion: '1', jobId, phase: 'deliver-storage-program', outcome: 'success', dacsSdkAuditSourceHash: 'f'.repeat(64), deliverableContentHash: 'a'.repeat(64),
    deliverableAnchor: { kind: 'storage-program', locator: `dacs4:deliverable:${jobId}` }, observedAt: 7 };
  let value = 'A'.repeat(86);
  if (!forged) {
    const signed = await session.request({ method: 'sign', params: [`dacs-evidence:v1:${sha(canonicalize(unsigned))}`] });
    assert.equal(signed.success, true);
    value = Buffer.from(signed.data.signature, 'hex').toString('base64url');
  }
  const artifact = { ...unsigned, signature: { algorithm: 'ed25519', signer: owner, value } };
  const logicalAddress = `dacs4:evidence:${jobId}`;
  return anchorRequest({ transport, address, kind: wallet.DEVNET_DEMO_STORAGE_KIND, artifactKind: 'SettlementEvidence', artifact, logicalAddress,
    metadata: { artifactBinding: artifactBinding('SettlementEvidence', logicalAddress, owner) } });
}

// Answers the source binding fetch with a stop, so an admitted plan ends at
// its first network call; anything else is refused and recorded.
function stubFetch(t) {
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options?.body ?? 'null') });
    if (String(url) === `${ORIGIN}/portal/api/devnet-native-wallet-binding`) return new Response(JSON.stringify({ error: 'TEST-binding-stopped' }), { status: 503, headers: { 'content-type': 'application/json' } });
    throw new TypeError('TEST unexpected fetch');
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const send = (session, request) => session.request({ method: 'sendTransaction', params: [request] });
function assertAdmitted(answer, calls) {
  assert.equal(answer.success, false); assert.equal(answer.error.code, 'TEST-binding-stopped');
  assert.deepEqual(calls.map((c) => [c.url, c.body?.phase]), [[`${ORIGIN}/portal/api/devnet-native-wallet-binding`, 'bind']]);
}
function assertRefused(answer, calls, message) {
  assert.equal(answer.success, false); assert.equal(answer.error.code, 'invalid_params'); assert.match(answer.error.message, message);
  assert.deepEqual(calls, []);
}
const SCOPE = /explicit anchor scope, immutable CREATE or network is malformed/;

test('demo transport refuses a delivery-kind fixture-test-report Deliverable before any network call, with or without declared delivery evidence', async (t) => {
  for (const kinds of [DEMO, DEMO_WITH_EVIDENCE]) {
    const transport = transportFor(kinds), w = await walletFor(t, transport), calls = stubFetch(t);
    assertRefused(await send(w.session, testReportDeliverable(transport, w.address)), calls, SCOPE);
  }
});

test('the same fixture-test-report Deliverable is admitted on a delivery-only transport, so the demo refusal is the narrowing itself', async (t) => {
  const transport = transportFor(null), w = await walletFor(t, transport), calls = stubFetch(t);
  assertAdmitted(await send(w.session, testReportDeliverable(transport, w.address)), calls);
});

test('demo transport still admits its demo-kind purchased-report Deliverable', async (t) => {
  for (const kinds of [DEMO, DEMO_WITH_EVIDENCE]) {
    const transport = transportFor(kinds), w = await walletFor(t, transport), calls = stubFetch(t);
    assertAdmitted(await send(w.session, purchasedDeliverable(transport, w.address, w.owner)), calls);
  }
});

test('demo-kind delivery SettlementEvidence is admitted only when the demo publication declares it, and only with the seller signature', async (t) => {
  const undeclared = transportFor(DEMO), w1 = await walletFor(t, undeclared), calls1 = stubFetch(t);
  assertRefused(await send(w1.session, await deliveryEvidence(undeclared, w1)), calls1, SCOPE);

  const declared = transportFor(DEMO_WITH_EVIDENCE), w2 = await walletFor(t, declared), calls2 = stubFetch(t);
  assertRefused(await send(w2.session, await deliveryEvidence(declared, w2, { forged: true })), calls2, /demo artifact kind, bindings or original bytes differ/);
  assertAdmitted(await send(w2.session, await deliveryEvidence(declared, w2)), calls2);
  assert.deepEqual(externalAttempts, []);
});
