// Showcase 1 (report view, DACS_SHOWCASE_REPORT_VIEW=1) with main the source change's
// payment recovery (final review of the source change, finding 1). With the view on, every
// field main's purchase results carry reaches the model and the App (which
// reads the same structuredContent) exactly as with the view off: the source change's
// settlement and recovery fields, the plugin's own outcomes and main's history
// stages. Only seller-supplied text is inside a seller-data envelope; the
// plugin's verdicts and recovery sentences stay outside it, and the
// instructions name them as the plugin's own. In-process fixtures plus one
// native payment over the packaged wallet; loopback only, nothing is resent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '@kynesyslabs/dacs';
import { createMcpServerFactory } from '../src/mcp/server.mjs';
import { OBSERVATION_LIMITS } from '../src/purchases.mjs';
import { outsideEnvelopes, sellerValue } from './helpers/model-report.mjs';
import { cases, config, ctx, injection, logger, report, setup } from './fixtures/mcp-seller-content.mjs';
import { nativePaymentFlow } from './helpers/native-agreement-payment-flow.mjs';
import { toolRaw } from './helpers/flows.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
installLoopbackOnlyGuard();

const hex = (c) => c.repeat(64);
const iso = '2026-10-12T06:00:00.000Z';
const observer = '@kynesyslabs/dacs observePayDemTransferCore (single-node consistent view; not a validator-quorum proof)';
const EXECUTION_FAILED = 'canonical transaction execution failed';
const FAILED_NEXT_STEP = 'Call cancel_wallet_handoff to resolve this failed payment if the bound-network buyer nonce still equals the saved fence; otherwise keep reading back the same hash.';
const LANE_NEXT_STEP = 'Retry verify_deal on this purchase to finish releasing its retained native source lane.';
const settlement = () => ({ txHash: hex('f'), observedAt: iso, chainMode: 'simulated-fixture', observer, ...OBSERVATION_LIMITS, rpcOrigin: 'http://127.0.0.1:12347',
  domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'simulated-fixture', chainIdentity: null }, purchaseCommitment: { value: hex('d'), carriedOnChain: false },
  observation: { status: 'included', txHash: hex('f'), payer: hex('b'), payee: hex('c'), amountOs: '1000000000', blockNumber: 7, includedAt: 1760000000000, sourceDisposition: 'failed' },
  slotConsumed: true, txNonce: 3, txStatus: 'failed', mismatches: [], signedByAlternateKey: true, nativeNonceResolved: true, nativeLaneResolved: true });

// The fixture's verified report, as a kind the purchase view shows, at a valid
// block and address: so the view keeps the report wrapper too, and every field
// of the result can be compared with main's.
const viewReport = { kind: 'dacs-chatgpt-plugin/fixture-test-report', ...report };
function viewable(fixture) {
  Object.assign(fixture.operation.state.protocol.delivery, { report: viewReport, anchorReceipt: { nativeAddress: `stor-${'b'.repeat(40)}`, blockRef: { id: hex('a'), height: '12', timestamp: 1 } },
    deliverableRef: { ...fixture.operation.state.protocol.delivery.deliverableRef, contentHash: contentHash(viewReport) } });
  return fixture;
}

// One fixture purchase through verify_deal and get_purchase_status, with the view off and on.
async function both(t, edit) {
  const out = {};
  for (const showcaseReportView of [false, true]) {
    const fixture = viewable(setup({ current: true }));
    edit(fixture);
    const server = createMcpServerFactory({ config: { ...config, commitOnSignature: true, showcaseReportView }, services: fixture.services, logger })();
    t.after(() => server.close());
    const call = (name) => server._registeredTools[name].handler(cases[name], ctx);
    out[showcaseReportView ? 'on' : 'off'] = { verify_deal: await call('verify_deal'), get_purchase_status: await call('get_purchase_status'), instructions: server.server._instructions };
  }
  return out;
}

// As purchases.mjs verifySettlement records a native payment whose transaction failed (the review's probe).
const failedNative = ({ operation, result }) => {
  operation.status = 'payment_uncertain';
  result.coordinates = { verifiedAt: iso, observation: settlement(), expectedNonce: 3, reportedTxHash: hex('f') };
  result.verification = { outcome: 'execution_failed', ...settlement(), rejectedReason: EXECUTION_FAILED, nextStep: FAILED_NEXT_STEP, nativeNonceResolved: false, nativeLaneResolved: false };
};

test('report view on: a failed native payment keeps the source change\'s recovery fields, exactly as main\'s result with the view off', async (t) => {
  const { off, on } = await both(t, failedNative);
  for (const name of ['verify_deal', 'get_purchase_status']) {
    assert.deepEqual(on[name].structuredContent, off[name].structuredContent, `${name}: the model's and the App's copy is main's`);
    assert.ok(on[name].structuredContent.protocol.delivery.report, `${name}: the report wrapper included`);
  }
  const v = on.verify_deal.structuredContent.verification;
  assert.deepEqual([v.outcome, v.rejectedReason, v.nextStep, v.txStatus, v.nativeNonceResolved, v.nativeLaneResolved, v.signedByAlternateKey, v.observation.sourceDisposition],
    ['execution_failed', EXECUTION_FAILED, FAILED_NEXT_STEP, 'failed', false, false, true, 'failed']);
  const s = on.get_purchase_status.structuredContent.settlement;
  assert.deepEqual([s.txStatus, s.nativeNonceResolved, s.nativeLaneResolved, s.signedByAlternateKey, s.observation.sourceDisposition], ['failed', true, true, true, 'failed']);
  // The recovery sentence and the verdicts are outside every envelope: the plugin's, not seller data.
  const plain = outsideEnvelopes(on.verify_deal);
  for (const value of [FAILED_NEXT_STEP, EXECUTION_FAILED, '"outcome":"execution_failed"']) assert.ok(plain.includes(value), value);
  assert.match(on.verify_deal.content[0].text, /^Purchase purchase: payment_uncertain \(execution_failed\)\. /);
});

test('report view on: a superseded native purchase keeps its lane-release guidance raw', async (t) => {
  const { off, on } = await both(t, ({ operation, result }) => {
    operation.status = 'superseded';
    result.verification = { outcome: 'superseded', supersededBy: 'pur_abcdefghijklmnop', nextStep: LANE_NEXT_STEP, nativeLaneResolved: false };
  });
  assert.deepEqual(on.verify_deal.structuredContent, off.verify_deal.structuredContent);
  assert.equal(on.verify_deal.structuredContent.verification.nextStep, LANE_NEXT_STEP);
  assert.ok(outsideEnvelopes(on.verify_deal).includes(LANE_NEXT_STEP));
});

test('report view on: the plugin\'s own outcomes and main\'s history stages stay raw; only seller text is wrapped', async (t) => {
  const stages = ['identity', 'pre-approval', 'handoff', 'handoff-reissue', 'wallet-native-lane-read'];
  const { off, on } = await both(t, ({ operation, result }) => {
    operation.state.protocol.attempts = [{ at: iso, step: 'payment-evidence', outcome: 'payment-evidenced', reason: injection }];
    result.history = [
      { seq: 1, at: iso, type: 'protocol_claim', data: { outcome: 'waiting', reason: injection } },
      ...stages.map((stage, i) => ({ seq: i + 2, at: iso, type: 'protocol_check_not_saved', data: { stage, savedStage: stage } })),
    ];
  });
  const status = on.get_purchase_status.structuredContent;
  assert.deepEqual(status, off.get_purchase_status.structuredContent);
  assert.equal(status.protocol.lastAttempt.outcome, 'payment-evidenced');
  assert.equal(status.history[0].data.outcome, 'waiting');
  assert.deepEqual(status.history.slice(1).map((e) => [e.data.stage, e.data.savedStage]), stages.map((stage) => [stage, stage]));
  // Seller text: inside main's envelope, never outside it.
  assert.equal(sellerValue(status.protocol.lastAttempt.reason), injection);
  assert.equal(sellerValue(status.history[0].data.reason), injection);
  assert.equal(outsideEnvelopes(on.get_purchase_status).includes(injection), false);
});

test('report view on: the instructions name the plugin\'s verdicts and recovery guidance as its own, and no result carries _meta', async (t) => {
  const { off, on } = await both(t, failedNative);
  assert.ok(on.instructions.startsWith(off.instructions), 'main\'s instructions first, unchanged');
  assert.match(on.instructions.slice(off.instructions.length),
    /status, next and protocol\.stage, and verification\.outcome, verification\.rejectedReason and verification\.nextStep whenever they are not inside an envelope, are the plugin's own verdicts and recovery guidance, not seller data\./);
  for (const name of ['verify_deal', 'get_purchase_status']) assert.equal(on[name]._meta, undefined, name);
});

// The packaged wallet pays through the native purchase lane with the view and
// commit on signature on; the pinned node reports the transfer's execution failed.
test('through MCP with the report view on, a failed native payment shows the source change\'s recovery step to the model, outside every envelope', async (t) => {
  const w = await nativePaymentFlow(t, { commitOnSignature: true, env: { DACS_SHOWCASE_REPORT_VIEW: '1' } });
  assert.deepEqual([w.h.config.showcaseReportView, w.h.config.commitOnSignature], [true, true]);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  const { handoff } = await w.approve();
  w.h.chain.paymentFaults.payment = 'fail-execution';
  assert.equal((await w.send(handoff.payload)).success, true);
  const hash = w.h.chain.record.accepted[0].hash;
  const failed = await toolRaw(w.h, w.buyer, 'verify_deal', { operationId: w.id, txHash: hash });
  const fv = failed.structuredContent.verification;
  assert.equal(failed.structuredContent.status, 'payment_uncertain');
  assert.deepEqual([fv.outcome, fv.txStatus, fv.rejectedReason, fv.nextStep, fv.slotConsumed], ['execution_failed', 'failed', EXECUTION_FAILED, FAILED_NEXT_STEP, false]);
  assert.ok(outsideEnvelopes(failed).includes(FAILED_NEXT_STEP));
  assert.equal(failed._meta, undefined);
  assert.equal(w.h.chain.record.broadcasts.length, 1, 'never resent');
  assert.deepEqual(externalAttempts, []);
});
