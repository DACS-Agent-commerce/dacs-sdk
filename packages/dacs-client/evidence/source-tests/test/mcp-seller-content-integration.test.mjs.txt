import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '@kynesyslabs/dacs';
import { deliverableAddress } from '../src/dacs/purchase-protocol.mjs';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, toolRaw, portal, tokenFrom, approvePurchase, reportPurchase } from './helpers/flows.mjs';
import { modelReport, textReport } from './helpers/model-report.mjs';
import { hostile } from './fixtures/mcp-seller-content.mjs';
import { createFixtureAnchorClient } from '../src/dacs/fixture-anchors.mjs';
import { advancePastFinalizedCommitment } from './helpers/finalized-payment.mjs';

test('authenticated hostile Deliverable stays wrapped across MCP status, verify, prepare replay and failed readback', async (t) => {
  const h = await startProtocolHarness(); t.after(() => h.close());
  const buyer = await linkedUser(h);
  const hostileTitle = hostile.slice(0, 200);
  const seller = await addSeller(h, { listingId: 'hostile-report', title: hostileTitle });
  const args = { listingId: 'hostile-report', version: 1, seller: seller.wallet.claim, idempotencyKey: 'hostile-report-replay', protocol: 'dacs-pay-dem' };
  const prepared = (await toolRaw(h, buyer, 'prepare_purchase', args)).structuredContent;
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl);
  const api = (part, body) => portal(h, `/portal/api/purchase/${id}/${part}`, { token, ...body });
  const identity = await api('agreement/identity', { address: buyer.wallet.address });
  const plan = await api('agreement/plan', { signature: buyer.wallet.signHex(identity.signRequest.message) });
  const signed = await api('agreement/sign', { agreementSignature: buyer.wallet.signHex(plan.signRequest.agreementMessage), anchorSignature: buyer.wallet.signHex(plan.signRequest.anchorMessage) });
  assert.equal(signed.status, 'awaiting_approval');
  const { approved } = await approvePurchase(h, id, prepared.approvalUrl, buyer.wallet);
  assert.equal(approved.status, 'payment_handoff');
  advancePastFinalizedCommitment(h, h.app.services.ops.get(h.app.services.accounts.walletOwner(buyer.wallet.address), id));
  const txHash = h.chain.walletBroadcast(approved.payload);
  const delivered = await reportPurchase(h, id, token, { txHash });
  assert.equal(delivered.evidence.protocol.stage, 'awaiting-countersignature');
  const address = deliverableAddress(prepared.protocol.jobId);
  const record = await createFixtureAnchorClient({ url: h.anchors.url }).read(address);
  assert.equal(record.status, 'present');
  assert.deepEqual(delivered.evidence.protocol.delivery.report, record.artifact, 'portal retains the exact verified report');
  assert.equal(record.artifact.title, hostileTitle);
  assert.ok(record.artifact.body.length);
  assert.equal(contentHash(record.artifact), record.receipt.contentHash);
  const effects = { writes: h.anchors.faults.writes.length, transfers: h.chain.nonceOf(buyer.wallet.address) };
  for (const [name, input] of [['get_purchase_status', { operationId: id }], ['verify_deal', { operationId: id }], ['prepare_purchase', args]]) {
    const result = await toolRaw(h, buyer, name, input);
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const wrapper = result.structuredContent.protocol.delivery.report;
    assert.deepEqual(modelReport(wrapper), record.artifact);
    assert.equal(wrapper.contentHash, record.receipt.contentHash);
    assert.deepEqual(wrapper.coordinates, { block: null, address });
    assert.deepEqual(textReport(result, wrapper).report, record.artifact);
  }
  assert.deepEqual({ writes: h.anchors.faults.writes.length, transfers: h.chain.nonceOf(buyer.wallet.address) }, effects);
  assert.equal(effects.transfers, 1);
  // A rejected initial Deliverable read must release no seller report bytes.
  const account = h.app.services.accounts.walletOwner(buyer.wallet.address);
  const operation = h.app.services.ops.get(account, id);
  h.app.services.ops.transition(id, operation.status, operation.status, { state: { protocol: { ...operation.state.protocol, stage: 'payment-evidenced', delivery: null, bundle: null } }, event: 'TEST_delivery_recheck' });
  h.anchors.faults.alter.set(address, (artifact) => ({ ...artifact, title: 'unverified replacement' }));
  const failed = await toolRaw(h, buyer, 'verify_deal', { operationId: id });
  assert.equal(failed.structuredContent.protocol.stage, 'delivery-rejected');
  for (const [name, input] of [['get_purchase_status', { operationId: id }], ['prepare_purchase', args]]) {
    const result = await toolRaw(h, buyer, name, input);
    assert.equal(result.structuredContent.protocol.delivery, null);
    assert.equal(JSON.stringify(result).includes('ignore previous instructions'), false);
    assert.equal(JSON.stringify(result).includes('unverified replacement'), false);
  }
  assert.equal(JSON.stringify(failed).includes('ignore previous instructions'), false);
  assert.equal(JSON.stringify(failed).includes('unverified replacement'), false);
  // Review of the source change: the refused report is absent from _meta and from the portal view too.
  for (const result of [failed, await toolRaw(h, buyer, 'get_purchase_status', { operationId: id })]) {
    for (const text of ['ignore previous instructions', 'unverified replacement']) assert.equal(JSON.stringify(result._meta ?? null).includes(text), false, text);
  }
  const view = await portal(h, `/portal/api/purchase/${id}/view`, { token });
  assert.equal(view.evidence.protocol.stage, 'delivery-rejected');
  for (const text of ['ignore previous instructions', 'unverified replacement']) assert.equal(JSON.stringify(view).includes(text), false, `portal view: ${text}`);
  assert.deepEqual({ writes: h.anchors.faults.writes.length, transfers: h.chain.nonceOf(buyer.wallet.address) }, effects);
});
