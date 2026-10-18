import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ARTIFACT_SEPARATORS,
  contentHash,
  generateCanonicalJobId,
  isSettlementEvidence,
  paymentEvidenceAddress,
  signComponentArtifact,
  verifySettlementEvidence,
} from '@kynesyslabs/dacs';
import * as shippedWallet from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createDemosSr2WalletBridge } from '../src/dacs/demos-sr2-wallet-bridge.mjs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { canonicalSignature } from '../src/dacs/fixture-anchors.mjs';
import { ed25519Deps } from '../src/dacs/purchase-protocol.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { startAgreementChain } from './helpers/offline-agreement-fixture.mjs';
import { startHarness } from './helpers/harness.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

const clone = (value) => structuredClone(value);
const RAIL = 'demos-native:DEM';
const PHASE_INDEX = 2;
const NOW = 1791144000123;

function bridgeJournal() {
  const journal = memoryAnchorJournal();
  return { ...journal, entries: journal.snapshot };
}

async function setup(t, { walletApi = shippedWallet } = {}) {
  const chain = await startAgreementChain();
  const h = await startHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => h.close());
  const journal = bridgeJournal();
  const approvals = [];
  const network = h.config.chain.network;
  const factory = ({ anchorJournal }) => walletApi.createSdkWalletSession({
    DemosCtor: Demos,
    IdentitiesCtor: Identities,
    validateMnemonic,
    anchorJournal,
    transactionTransport: { profile: 'simulated-loopback', network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(clone(request)); return true; },
  });
  const bridge = createDemosSr2WalletBridge({ rpcUrl: chain.url, network, journal, walletFactory: factory, now: () => NOW });
  const account = await bridge.wallet.create();
  t.after(() => bridge.wallet.lock());
  return { chain, h, journal, approvals, network, factory, bridge, account };
}

async function sellerEvidence(w) {
  const jobId = generateCanonicalJobId({ timestamp: NOW });
  const writer = `did:demos:agent:${w.account.address.slice(2)}`;
  const unsigned = {
    evidenceVersion: '1',
    jobId,
    phase: 'pay-dem',
    outcome: 'success',
    paymentTxRefs: [{ kind: 'demos', txHash: 'a'.repeat(64), blockNumber: 7 }],
    paymentAmount: { amount: '2.5', currency: 'DEM' },
    settlementFinality: { model: 'bft-final', finalityObservedAt: NOW },
    observedAt: NOW,
  };
  const artifact = await signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.SettlementEvidence, {
    algorithm: 'ed25519',
    signer: writer,
    sign: async (bytes) => {
      const answer = await w.bridge.wallet.request({ method: 'sign', params: [Buffer.from(bytes).toString('utf8')] });
      assert.equal(answer.success, true, JSON.stringify(answer));
      return canonicalSignature(answer.data.signature);
    },
  });
  const logicalAddress = paymentEvidenceAddress(jobId, RAIL, PHASE_INDEX);
  const evidenceHash = contentHash(artifact);
  assert.equal(isSettlementEvidence(artifact), true);
  assert.equal(Object.hasOwn(artifact, 'artifactType'), false);
  assert.equal((await verifySettlementEvidence(artifact, {
    orchestrator: writer,
    agreement: { amount: '2.5', currency: 'DEM' },
    rail: { railId: RAIL, railType: 'demos-native', asset: 'DEM', assetSpec: { kind: 'native-dem' }, network: 'demos', networkSpec: { kind: 'demos' }, handler: 'pay-dem' },
    attestationRef: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: evidenceHash },
    result: { ok: true, txRefs: clone(artifact.paymentTxRefs) },
    paymentAddress: { railId: RAIL, phaseIndex: PHASE_INDEX },
  }, ed25519Deps)).decision, 'pass');
  return { artifact, artifactKind: 'SettlementEvidence', logicalAddress, writer, jobId, receiptContentHash: evidenceHash };
}

test('genuine SDK SettlementEvidence keeps exact seller-signed bytes through packaged-wallet CREATE and independent public readback', async (t) => {
  const w = await setup(t);
  const input = await sellerEvidence(w);
  const before = JSON.stringify(input.artifact);
  const signature = clone(input.artifact.signature);
  const out = await w.bridge.anchor(input);
  assert.equal(out.status, 'simulated-read-visible', JSON.stringify(out));
  assert.equal(out.artifactKind, 'SettlementEvidence');
  assert.equal(JSON.stringify(out.artifact), before);
  assert.deepEqual(out.artifact.signature, signature);
  assert.equal(contentHash(out.artifact), input.receiptContentHash);
  assert.equal(Object.hasOwn(out.artifact, 'artifactType'), false);

  const storageApprovals = w.approvals.filter((request) => request.method === 'sendTransaction');
  assert.equal(storageApprovals.length, 1);
  assert.equal(storageApprovals[0].content.artifactKind, 'SettlementEvidence');
  assert.equal(storageApprovals[0].content.jobId, input.jobId);
  assert.equal(storageApprovals[0].content.logicalAddress, input.logicalAddress);
  assert.equal(storageApprovals[0].content.exactStorageBytes, before);
  assert.equal(w.approvals.filter((request) => request.method === 'sign').length, 1, 'seller component signature used the normal packaged-wallet approval');

  const signedProjection = w.chain.wire.record.accepted[0];
  assert.equal(JSON.stringify(signedProjection.content.data[1].data), before);
  assert.equal(signedProjection.content.data[1].metadata.artifactKind, 'SettlementEvidence');
  assert.equal(Object.hasOwn(signedProjection.content.data[1].data, 'artifactType'), false);
  const reader = createDemosSr2Adapter({ rpcUrl: w.chain.url, journal: createInMemoryDemosSr2Journal(), now: () => NOW + 1 });
  const read = await reader.read(input.logicalAddress, { expectedWriter: input.writer, expectedArtifactKind: 'SettlementEvidence', signedProjection });
  assert.equal(read.status, 'present');
  assert.equal(JSON.stringify(read.artifact), before);
  assert.deepEqual(read.artifact.signature, signature);
  assert.equal(read.receipt.contentHash, input.receiptContentHash);
  assert.equal(await reader.verifyReceipt({ receipt: out.receipt, logicalAddress: input.logicalAddress, artifact: input.artifact,
    expectedWriter: input.writer, artifactKind: 'SettlementEvidence', signedProjection }), 'valid');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.deepEqual(externalAttempts, []);
});

test('SettlementEvidence kind is narrow: job/rail/phase/address/seller/signature changes stop before approval or send', async (t) => {
  const w = await setup(t);
  const input = await sellerEvidence(w);
  const alteredPhase = clone(input.artifact); alteredPhase.phase = 'pay-x402';
  const alteredSigner = clone(input.artifact); alteredSigner.signature.signer = `did:demos:agent:${'f'.repeat(64)}`;
  const alteredSignature = clone(input.artifact); alteredSignature.signature.value = `${alteredSignature.signature.value.slice(0, -1)}${alteredSignature.signature.value.endsWith('A') ? 'B' : 'A'}`;
  const injectedKind = { ...clone(input.artifact), artifactType: 'SettlementEvidence' };
  const cases = [
    { ...input, logicalAddress: paymentEvidenceAddress(input.jobId, RAIL, PHASE_INDEX + 1) },
    { ...input, logicalAddress: paymentEvidenceAddress(input.jobId, 'other:DEM', PHASE_INDEX) },
    { ...input, artifact: alteredPhase, receiptContentHash: contentHash(alteredPhase) },
    { ...input, artifact: alteredSigner, receiptContentHash: contentHash(alteredSigner) },
    { ...input, artifact: alteredSignature, receiptContentHash: contentHash(alteredSignature) },
    { ...input, artifact: injectedKind, receiptContentHash: contentHash(injectedKind) },
    { ...input, artifactKind: 'Agreement' },
  ];
  for (const candidate of cases) await assert.rejects(w.bridge.anchor(candidate), (error) => error.code === 'invalid');
  assert.equal(w.approvals.filter((request) => request.method === 'sendTransaction').length, 0);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  assert.deepEqual(externalAttempts, []);
});

test('unknown-after-apply SettlementEvidence reconstruction reads retained receipt without approval or resend', async (t) => {
  const w = await setup(t);
  const input = await sellerEvidence(w);
  w.chain.wire.faults.dropAfterApply = true;
  const first = await w.bridge.anchor(input);
  assert.equal(first.status, 'indeterminate');
  assert.equal(first.code, 'outcome_unknown');
  assert.equal(w.chain.wire.record.accepted.length, 1);
  w.chain.wire.faults.dropAfterApply = false;
  const reopened = createDemosSr2WalletBridge({ rpcUrl: w.chain.url, network: w.network, journal: w.journal,
    walletFactory: () => w.bridge.wallet, now: () => NOW + 2 });
  const recovered = await reopened.resume(input);
  assert.equal(recovered.status, 'simulated-read-visible', JSON.stringify(recovered));
  assert.equal(JSON.stringify(recovered.artifact), JSON.stringify(input.artifact));
  assert.equal((await reopened.anchor(input)).receipt.contentHash, input.receiptContentHash);
  assert.equal(w.approvals.filter((request) => request.method === 'sendTransaction').length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.deepEqual(externalAttempts, []);
});

async function settlementRejectedMutant() {
  const url = new URL('../public/portal/embedded-wallet/sdk-provider.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const target = '&& !await normativeSettlementMatches(r, op.data)';
  assert.equal(source.split(target).length, 2);
  return import(`data:text/javascript;base64,${Buffer.from(source.replace(target, '&& true')).toString('base64')}`);
}

test('guard witness: accepting control catches an implementation that drops SettlementEvidence compatibility', async (t) => {
  const mutant = await settlementRejectedMutant();
  const w = await setup(t, { walletApi: mutant });
  const input = await sellerEvidence(w);
  const out = await w.bridge.anchor(input);
  assert.equal(out.status, 'rejected');
  assert.equal(out.code, 'invalid_params');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  assert.deepEqual(externalAttempts, []);
});
