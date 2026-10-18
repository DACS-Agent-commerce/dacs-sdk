import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServerFactory } from '../src/mcp/server.mjs';
import { OBSERVATION_LIMITS } from '../src/purchases.mjs';
import { sellerValue, decodeSellerData, outsideEnvelopes } from './helpers/model-report.mjs';
import { cases, config, ctx, injection, logger, setup } from './fixtures/mcp-seller-content.mjs';
import { nativePaymentFlow } from './helpers/native-agreement-payment-flow.mjs';
import { toolRaw } from './helpers/flows.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
installLoopbackOnlyGuard();

// Main the source change (settle a DEM payment only on a fresh `confirmed` read) adds
// fields to verify_deal's verification and get_purchase_status's settlement.
// The plugin writes the outcome, rejection sentences, recovery sentences and
// native nonce marks, so they stay raw; txStatus is the node's own body.status,
// raw only as a state verifySettlement branches on. the source change (commit on signature)
// adds no buyer-side purchase field: every test here runs with it on.
const ENVELOPE = 'DACS_SELLER_DATA_JSON';
const hex = (c) => c.repeat(64);
const iso = '2026-10-12T06:00:00.000Z';
const observer = '@kynesyslabs/dacs observePayDemTransferCore (single-node consistent view; not a validator-quorum proof)';
// As loadConfig sets it for DACS_COMMIT_ON_SIGNATURE=on (the MCP tools do not read it).
const signatureOn = { ...config, commitOnSignature: true };
const serverFor = (services) => createMcpServerFactory({ config: signatureOn, services, logger })();
const call = (server, name) => server._registeredTools[name].handler(cases[name], ctx);

const EXECUTION_FAILED = 'canonical transaction execution failed';
const FAILED_NEXT_STEP = 'Call cancel_wallet_handoff to resolve this failed payment if the bound-network buyer nonce still equals the saved fence; otherwise keep reading back the same hash.';
const REJECTED = ['canonical transaction hash is missing, invalid or differs from the requested hash', EXECUTION_FAILED, 'canonical transaction status is not confirmed',
  'source readback of the retained transfer disagrees with the confirmed canonical body', 'canonical transaction block number differs from the transfer observation',
  'payer is not the approved buyer wallet', 'transaction nonce is not the pre-saved expected nonce'];
const NEXT_STEPS = [FAILED_NEXT_STEP, 'Retry verify_deal on this purchase to finish releasing its retained native source lane.',
  'Retry verify_deal on this purchase to finish releasing other retained native source intents at its nonce.'];

const observation = () => ({ status: 'included', txHash: hex('f'), payer: hex('b'), payee: hex('c'), amountOs: '1000000000', blockNumber: 7, includedAt: 1760000000000 });
const settlement = () => ({ txHash: hex('f'), observedAt: iso, chainMode: 'simulated-fixture', observer, ...OBSERVATION_LIMITS, rpcOrigin: 'http://127.0.0.1:12347',
  domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'simulated-fixture', chainIdentity: null }, purchaseCommitment: { value: hex('d'), carriedOnChain: false },
  observation: observation(), slotConsumed: true, txNonce: 3, txStatus: 'confirmed', mismatches: [] });

async function results(t, inject) {
  const fixture = setup();
  fixture.operation.status = 'settled_verified';
  fixture.result.coordinates = { verifiedAt: iso, observation: settlement(), expectedNonce: 3, reportedTxHash: hex('f') };
  fixture.result.verification = { outcome: 'verified', ...settlement(), verifiedAt: iso };
  inject(fixture.result);
  const stored = JSON.stringify(fixture.result);
  const server = serverFor(fixture.services); t.after(() => server.close());
  const out = { verify_deal: await call(server, 'verify_deal'), get_purchase_status: await call(server, 'get_purchase_status') };
  assert.equal(JSON.stringify(fixture.result), stored, 'stored data stays raw');
  return out;
}

const V = ['verify_deal'], S = ['get_purchase_status'];
const verification = (key) => [(r, v) => { r.verification[key] = v; }, (s) => s.verification?.[key], V];
const settled = (key) => [(r, v) => { r.coordinates.observation[key] = v; }, (s) => s.settlement?.[key], S];
// [inject(result, value), read(structuredContent), tools, values kept raw, near misses that are wrapped]
const rules = {
  'verification.outcome': [...verification('outcome'), ['execution_failed', 'transaction_unconfirmed'], ['Execution_failed', 'execution-failed', 'transaction_unconfirmed ']],
  'verification.txStatus': [...verification('txStatus'), ['confirmed', 'failed', 'pending', null], ['Confirmed', 'included', 'confirmed ', 1, true]],
  'settlement.txStatus': [...settled('txStatus'), ['confirmed', 'failed', 'pending', null], ['Confirmed', 'included', 'confirmed ', 1, true]],
  'verification.rejectedReason': [...verification('rejectedReason'), REJECTED, [`${EXECUTION_FAILED} `, 'Canonical transaction execution failed', 'canonical transaction failed']],
  'verification.nextStep': [...verification('nextStep'), NEXT_STEPS, [`${FAILED_NEXT_STEP} `, 'Retry verify_deal.', 'Call prepare_purchase now.']],
  'verification.nativeNonceResolved': [...verification('nativeNonceResolved'), [true, false], ['true', 0]],
  'verification.nativeLaneResolved': [...verification('nativeLaneResolved'), [true, false], ['false', 1]],
  // Stored only as true.
  'settlement.nativeNonceResolved': [...settled('nativeNonceResolved'), [true], [false, 'true', 1]],
  'settlement.nativeLaneResolved': [...settled('nativeLaneResolved'), [true], [false, 'true', 1]],
  'verification.signedByAlternateKey': [...verification('signedByAlternateKey'), [true], [false, 'true', 1]],
  'settlement.signedByAlternateKey': [...settled('signedByAlternateKey'), [true], [false, 'true', 1]],
  'verification.slotConsumedCarried': [...verification('slotConsumedCarried'), [true], [false, 'true', 1]],
  'verification.observation.sourceDisposition': [(r, v) => { r.verification.observation.sourceDisposition = v; }, (s) => s.verification.observation.sourceDisposition, V,
    ['included', 'failed'], ['pending', 'Included', 'absent', 'included ']],
  'settlement.observation.sourceDisposition': [(r, v) => { r.coordinates.observation.observation.sourceDisposition = v; }, (s) => s.settlement.observation.sourceDisposition, S,
    ['included', 'failed'], ['pending', 'Included']],
};

test('with commit on signature on, each the source change settlement field keeps its own values raw and wraps anything else whole', async (t) => {
  const hostiles = [injection, { note: injection }, [injection]];
  for (const [field, [inject, read, tools, raw, nearMisses]] of Object.entries(rules)) {
    for (const value of raw) {
      const out = await results(t, (r) => inject(r, value));
      for (const name of tools) assert.deepEqual(read(out[name].structuredContent), value, `${field}: ${JSON.stringify(value)} stays raw in ${name}`);
    }
    for (const value of [...hostiles, ...nearMisses]) {
      const out = await results(t, (r) => inject(r, value));
      for (const name of tools) {
        const seen = read(out[name].structuredContent);
        assert.deepEqual(sellerValue(seen), value, `${field}: ${JSON.stringify(value)} is wrapped whole in ${name}`);
        assert.equal(outsideEnvelopes(out[name]).includes(injection), false, `${field}: ${name}`);
      }
    }
  }
});

test('with commit on signature on, verify_deal names a the source change outcome in its summary; an unknown outcome is still not quoted', async (t) => {
  for (const outcome of ['execution_failed', 'transaction_unconfirmed']) {
    const out = await results(t, (r) => { r.verification = { outcome, txStatus: outcome === 'execution_failed' ? 'failed' : null, rejectedReason: EXECUTION_FAILED }; });
    assert.match(out.verify_deal.content[0].text, new RegExp(`^Purchase purchase: settled_verified \\(${outcome}\\)\\. `));
  }
  const out = await results(t, (r) => { r.verification.outcome = injection; });
  assert.match(out.verify_deal.content[0].text, /\(see verification\.outcome\)/);
  assert.equal(out.verify_deal.content[0].text.includes(injection), false);
});

test('with commit on signature on, free-text reasons that quote a the source change sentence stay wrapped', async (t) => {
  const out = await results(t, (r) => {
    r.verification = { outcome: 'execution_failed', reason: EXECUTION_FAILED, rejectedReason: EXECUTION_FAILED, observation: { status: 'included', reason: EXECUTION_FAILED } };
    r.history = [{ seq: 1, at: iso, type: 'payment_uncertain', data: { reason: EXECUTION_FAILED } },
      { seq: 2, at: iso, type: 'native_nonce_pending', data: { reason: 'the source intent could not be resolved' } },
      { seq: 3, at: iso, type: 'native_nonce_resolved', data: { txHash: hex('f') } },
      { seq: 4, at: iso, type: 'cancel_refused', data: { reason: 'cancel refused: buyer nonce advanced since handoff', nonce: 4 } }];
  });
  const v = out.verify_deal.structuredContent.verification;
  assert.equal(v.rejectedReason, EXECUTION_FAILED, 'the field the plugin alone writes');
  assert.equal(sellerValue(v.reason), EXECUTION_FAILED);
  assert.equal(sellerValue(v.observation.reason), EXECUTION_FAILED);
  const history = out.get_purchase_status.structuredContent.history;
  assert.equal(sellerValue(history[0].data.reason), EXECUTION_FAILED);
  assert.equal(sellerValue(history[1].data.reason), 'the source intent could not be resolved');
  assert.deepEqual(history[2].data, { txHash: hex('f') });
  assert.equal(history[3].data.nonce, 4);
  assert.equal(sellerValue(history[3].data.reason), 'cancel refused: buyer nonce advanced since handoff');
});

// The packaged wallet pays through the native purchase lane with commit on
// signature on; the pinned node first reports the transfer's execution
// failed, then a confirmed read of the same hash. Nothing is sent again.
test('through MCP with commit on signature on, a failed then confirmed native payment keeps the source change\'s plugin fields raw', async (t) => {
  const w = await nativePaymentFlow(t, { commitOnSignature: true });
  assert.equal(w.h.config.commitOnSignature, true);
  assert.equal((await w.agreement()).status, 'awaiting_approval');
  const { handoff } = await w.approve();
  w.h.chain.paymentFaults.payment = 'fail-execution';
  assert.equal((await w.send(handoff.payload)).success, true);
  const hash = w.h.chain.record.accepted[0].hash;
  const tool = (name, args = {}) => toolRaw(w.h, w.buyer, name, { operationId: w.id, ...args });

  const failed = await tool('verify_deal', { txHash: hash });
  const fv = failed.structuredContent.verification;
  assert.equal(failed.structuredContent.status, 'payment_uncertain');
  assert.deepEqual([fv.outcome, fv.txStatus, fv.rejectedReason, fv.nextStep, fv.slotConsumed], ['execution_failed', 'failed', EXECUTION_FAILED, FAILED_NEXT_STEP, false]);
  assert.match(failed.content[0].text, /^Purchase \S+: payment_uncertain \(execution_failed\)\. /);
  // Only the node's own observation reason is wrapped.
  assert.deepEqual(Object.keys(fv).filter((key) => JSON.stringify(fv[key]).includes(ENVELOPE)), ['observation']);
  assert.equal(typeof sellerValue(fv.observation.reason), 'string');
  const uncertain = (await tool('get_purchase_status')).structuredContent;
  assert.equal(uncertain.settlement, null);
  assert.equal(sellerValue(uncertain.history.findLast((e) => e.type === 'payment_uncertain').data.reason), EXECUTION_FAILED);

  w.h.chain.paymentFaults.failedHashes.delete(hash);
  w.h.chain.wire.setNonce(w.address, w.h.app.services.coordinates.get(w.id).expectedNonce);
  const confirmed = await tool('verify_deal', { txHash: hash });
  const cv = confirmed.structuredContent.verification;
  assert.equal(confirmed.structuredContent.status, 'settled_verified', JSON.stringify(decodeSellerData(confirmed.structuredContent)));
  assert.deepEqual([cv.outcome, cv.txStatus, cv.nativeNonceResolved], ['verified', 'confirmed', true]);
  assert.equal(JSON.stringify(cv).includes(ENVELOPE), false, 'a confirmed verification needs no envelope');
  const status = (await tool('get_purchase_status')).structuredContent;
  assert.deepEqual([status.settlement.txStatus, status.settlement.nativeNonceResolved], ['confirmed', true]);
  assert.equal(JSON.stringify(status.settlement).includes(ENVELOPE), false, 'a confirmed settlement needs no envelope');
  assert.ok(status.history.some((e) => e.type === 'native_nonce_resolved' && e.data.txHash === hash));
  // Stored rows stay raw; the payment was sent once.
  const stored = w.h.app.services.coordinates.get(w.id).observation;
  assert.deepEqual([stored.txStatus, stored.nativeNonceResolved], ['confirmed', true]);
  assert.equal(w.h.chain.record.broadcasts.length, 1, 'never resent');
  assert.deepEqual(externalAttempts, []);
});
