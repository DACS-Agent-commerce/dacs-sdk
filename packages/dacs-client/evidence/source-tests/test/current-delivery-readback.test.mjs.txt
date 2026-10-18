// The buyer's current delivery projection is valid only while a fresh native
// read authenticates the original signed Deliverable. Historical delivery-ready
// bytes must not survive a later absent, rejected or unavailable read as the
// current MCP/portal result. This is ordinary owned-loopback interaction coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelReport } from './helpers/model-report.mjs';
import { contentHash } from '@kynesyslabs/dacs';
import { protocolView } from '../src/dacs/protocol-purchases.mjs';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { acceptedCreates, kindOf } from './helpers/review-native-delivery-coverage-reader.mjs';
import { tool } from './helpers/flows.mjs';

const protocolOf = (answer) => answer?.protocol ?? answer?.evidence?.protocol;

async function effects(w) {
  return {
    kinds: acceptedCreates(w).map(kindOf).sort(),
    createAttempts: w.h.chain.wire.record.broadcastAttempts.length,
    demPayments: w.h.chain.record.broadcasts.length,
    sellerApprovals: w.seller.sellerApprovals.length,
    deliveryApprovals: w.seller.sellerApprovals.filter((entry) => entry.content?.artifactKind === 'Deliverable').length,
    evidenceAttempts: w.seller.evidenceAttempts.length,
    fixtureWrites: w.seller.anchorWrites.length,
    journalRows: (await w.seller.walletJournal.entries()).length,
  };
}

function assertNoCurrentDelivery(answer, expectedStage, signedReport) {
  const protocol = protocolOf(answer);
  assert.equal(protocol?.stage, expectedStage, JSON.stringify(protocol));
  assert.equal(protocol?.layers?.service, 'not-delivered', JSON.stringify(protocol?.layers));
  assert.equal(protocol?.delivery, null, JSON.stringify(protocol?.delivery));
  assert.equal(JSON.stringify(answer).includes(JSON.stringify(signedReport)), false, 'historical report bytes must not appear in the current projection');
}

function assertReady(answer, expected) {
  const protocol = protocolOf(answer);
  assert.equal(protocol?.stage, 'delivery-ready', JSON.stringify(protocol));
  assert.equal(protocol?.layers?.service, 'test-report-delivered-and-verified');
  assert.equal(protocol?.delivery?.fulfilmentId, expected.fulfilmentId);
  assert.equal(protocol?.delivery?.deliverableRef?.contentHash, expected.contentHash);
  assert.deepEqual(answer.protocol ? modelReport(protocol?.delivery?.report) : protocol?.delivery?.report, expected.report);
}

test('current delivery projection is stage-gated even for a legacy merged stale delivery field', () => {
  const delivery = { status: 'delivery-ready', fulfilmentId: 'historical', report: { historical: true } };
  const operation = {
    status: 'settled_verified',
    terms: { protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', jobId: 'legacy-state', orchestration: 'test', sellerAgent: 'http://127.0.0.1', substrate: 'test' } },
    state: { protocol: { stage: 'payment-evidenced', delivery, attempts: [] } },
  };
  const held = protocolView(operation);
  assert.equal(held.delivery, null);
  assert.equal(held.layers.service, 'not-delivered');
  operation.state.protocol.stage = 'delivery-ready';
  assert.deepEqual(protocolView(operation).delivery.report, delivery.report);
});

test('current native delivery readback: MCP and portal clear stale current report on absent, rejected and thrown reads, survive restart, and recover the exact original without effects', { timeout: 120000 }, async (t) => {
  const w = await sourceDemoFlow(t);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const { handoff } = await w.approve();
  assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const sent = await w.send(handoff.payload);
  assert.equal(sent.success, true, JSON.stringify(sent));

  const first = await w.api('report', { txHash: sent.data.hash });
  assertReady(first, {
    fulfilmentId: protocolOf(first).delivery.fulfilmentId,
    contentHash: protocolOf(first).delivery.deliverableRef.contentHash,
    report: protocolOf(first).delivery.report,
  });
  const deliveryCreate = acceptedCreates(w).find((tx) => kindOf(tx) === 'Deliverable');
  const original = {
    fulfilmentId: deliveryCreate.content.data[1].metadata.deliveryBinding.fulfilmentId,
    contentHash: contentHash(deliveryCreate.content.data[1].data),
    report: deliveryCreate.content.data[1].data,
  };
  assertReady(first, original);
  const baseline = await effects(w);
  assert.deepEqual(baseline, {
    kinds: ['Agreement', 'Deliverable', 'SettlementEvidence'],
    createAttempts: 3,
    demPayments: 1,
    sellerApprovals: 2,
    deliveryApprovals: 1,
    evidenceAttempts: 1,
    fixtureWrites: 3,
    journalRows: 3,
  });

  const authenticRead = w.seller.nativeDeliveryProvider.read;

  // MCP mutation + MCP read-only status + portal view: authoritative absence.
  w.seller.nativeDeliveryProvider.read = async () => ({ status: 'absent', reason: 'TEST current Deliverable projection absent' });
  assertNoCurrentDelivery(await w.verify(), 'payment-evidenced', original.report);
  assert.equal(w.op().state.protocol.delivery, null);
  assertNoCurrentDelivery(await tool(w.h, w.buyer, 'get_purchase_status', { operationId: w.id }), 'payment-evidenced', original.report);
  assertNoCurrentDelivery(await w.api('view'), 'payment-evidenced', original.report);
  assert.deepEqual(await effects(w), baseline);

  w.seller.nativeDeliveryProvider.read = authenticRead;
  assertReady(await w.verify(), original);
  assert.deepEqual(await effects(w), baseline);

  // Portal report + MCP status: authenticated rejection is a delivery rejection.
  w.seller.nativeDeliveryProvider.read = async () => ({ status: 'rejected', reason: 'TEST current Deliverable projection rejected' });
  assertNoCurrentDelivery(await w.api('report', { txHash: sent.data.hash }), 'delivery-rejected', original.report);
  assert.equal(w.op().state.protocol.delivery, null);
  assertNoCurrentDelivery(await tool(w.h, w.buyer, 'get_purchase_status', { operationId: w.id }), 'delivery-rejected', original.report);
  assert.deepEqual(await effects(w), baseline);

  w.seller.nativeDeliveryProvider.read = authenticRead;
  assertReady(await w.verify(), original);

  // Portal recheck: storage exception is unavailable, not rejection. Persist the
  // cleared state across both app and seller restart before restoring the reader.
  w.seller.nativeDeliveryProvider.read = async () => { throw new Error('TEST current Deliverable storage unavailable'); };
  assertNoCurrentDelivery(await w.api('protocol/recheck'), 'payment-evidenced', original.report);
  assert.equal(w.op().state.protocol.delivery, null);
  await w.h.restart();
  await w.seller.restart();
  assertNoCurrentDelivery(await w.api('view'), 'payment-evidenced', original.report);
  assertNoCurrentDelivery(await tool(w.h, w.buyer, 'get_purchase_status', { operationId: w.id }), 'payment-evidenced', original.report);
  assert.deepEqual(await effects(w), baseline);

  w.seller.nativeDeliveryProvider.read = authenticRead;
  const recovered = await w.api('protocol/recheck');
  const replay = await w.verify();
  assertReady(recovered, original);
  assertReady(replay, original);
  assert.deepEqual(await effects(w), baseline);
  assert.equal((await w.api('completion/request')).error, 'native_completion_held');
  t.diagnostic(JSON.stringify({ baseline, fulfilmentId: original.fulfilmentId, contentHash: original.contentHash,
    stages: ['delivery-ready', 'payment-evidenced', 'delivery-ready', 'delivery-rejected', 'delivery-ready', 'payment-evidenced', 'delivery-ready'] }));
});
