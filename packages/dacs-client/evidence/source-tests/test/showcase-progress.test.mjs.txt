import test from 'node:test';
import assert from 'node:assert/strict';
import { showcaseProgress } from '../src/mcp/showcase-progress.mjs';
import { STAGE_HELP, protocolView } from '../src/dacs/protocol-purchases.mjs';
import { showcaseProgressHtml } from '../public/portal/showcase-progress.mjs';

const ref = (key) => ({ anchor: { kind: 'storage-program', locator: key }, contentHash: 'a'.repeat(64) });
const receipt = { logicalAddress: 'artifact-key', contentHash: 'b'.repeat(64), transactionRef: { value: 'c'.repeat(64) }, blockRef: { height: 17 }, state: 'included', substrate: 'TEST one-node' };
const event = (step, outcome, reason) => ({ type: `protocol_${step}`, data: { outcome, reason } });
// The named checks src/dacs/verification.mjs records for a found Listing (the integration test pins this list to the real verifier).
const LISTING_CHECKS =['directory-detail-hash-matches-summary', 'directory-coordinates-match', 'chain-anchor-present', 'chain-readback-equals-directory-detail', 'chain-anchor-owner-is-seller', 'catalog-observation-fresh', 'standard-reader-verified', 'v0.1-purchase-support'];
const passedChecks = () => LISTING_CHECKS.map((name) => ({ name, ok: true }));
function fixture(stage = 'identity', profile = 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1') {
  const operation = { status: 'agreement_pending', terms: { listing: { listingId: 'TEST-listing', version: 1, ...ref('Listing-key') }, protocol: { profile }, profile: 'purchase' }, state: { preparedVerification: { checks: passedChecks(), evidence: { chainMode: 'TEST' } }, protocol: { stage } } };
  const protocol = { stage, profile, substrate: 'TEST', limits: { vet: 'not-performed' } };
  return { operation, protocol, history: [], evidence: {} };
}
const project = (input) => showcaseProgress(input).stages;

const stageStates = {
  identity: ['pending', 'pending', 'pending'], 'agreement-signing': ['pending', 'pending', 'pending'], 'agreement-anchored': ['pending', 'pending', 'pending'],
  committed: ['pending', 'pending', 'pending'], 'seller-committed': ['pending', 'pending', 'pending'], 'payment-observed': ['pending', 'pending', 'pending'],
  'awaiting-claim': ['pending', 'pending', 'pending'], 'payment-evidenced': ['pending', 'pending', 'pending'], 'native-payment-evidence-held': ['pending', 'held', 'pending'],
  'delivery-ready': ['pending', 'pending', 'pending'], delivered: ['pending', 'pending', 'pending'], 'awaiting-countersignature': ['pending', 'pending', 'pending'], completed: ['pending', 'pending', 'pending'],
  'agreement-rejected': ['rejected', 'pending', 'pending'], 'claim-rejected': ['pending', 'rejected', 'pending'], 'evidence-rejected': ['pending', 'rejected', 'pending'], 'delivery-rejected': ['pending', 'rejected', 'pending'], 'bundle-rejected': ['pending', 'pending', 'rejected'],
};
test('the state table covers every named protocol state', () => {
  for (const stage of Object.keys(STAGE_HELP)) assert.ok(Object.hasOwn(stageStates, stage), stage);
});
for (const profile of ['dacs-chatgpt-plugin/sr2-wallet-agreement/v1', 'dacs-chatgpt-plugin/devnet-pay-dem-purchase/v1', 'dacs-chatgpt-plugin/fixed-price-pay-dem/v1']) {
  test(`${profile}: every protocol state alone proves no completed stage`, () => {
   for (const [stage, expected] of Object.entries(stageStates)) {
    const rows = project(fixture(stage, profile));
    assert.deepEqual(rows.map((s) => s.name), ['Identify', 'Vet', 'Negotiate', 'Settle', 'Verify']);
    assert.deepEqual(rows.slice(2).map((s) => s.state), expected);
    assert.equal(rows[1].state, 'held');
    assert.equal(rows[0].state, 'verified');
    if (stage.endsWith('rejected')) assert.match(rows.find((s) => s.state === 'rejected').reason, /reason proof is missing/);
   }
  });
}
const statuses = { agreement_pending: 'pending', awaiting_approval: 'pending', approved: 'pending', payment_handoff: 'pending', broadcast_reported: 'unknown', payment_uncertain: 'unknown', settled_verified: 'pending', payment_failed: 'failed', payment_mismatch: 'rejected', expired: 'expired', terms_changed: 'rejected', cancelled: 'cancelled', superseded: 'superseded', agreement_rejected: 'rejected' };
test('every purchase status preserves its disposition', () => {
 for (const [status, expected] of Object.entries(statuses)) {
  const input = fixture(); input.operation.status = status;
  input.history = [{ type: status, data: { reason: 'TEST recorded reason' } }];
  const index = status === 'terms_changed' ? 0 : ['expired', 'cancelled', 'superseded', 'agreement_rejected'].includes(status) ? 2 : 3;
  const rows = project(input);
  assert.equal(rows[index].state, expected);
  if (!['pending'].includes(expected)) assert.match(rows[index].reason, /TEST recorded reason/);
  if (expected === 'unknown') assert.match(rows[index].reason, /readback-only; do not pay again/);
 }
});
test('Vet never follows linked identities, bound references or successful composite labels', () => {
  const input = fixture(); input.operation.state.protocol.identity = { github: { verified: true } };
  input.operation.state.protocol.agreement = { artifact: { parties: ['buyer', 'seller'].map((role) => ({ role, vetRecordRef: ref(role) })) } };
  input.protocol.limits.vet = 'two composites read back and closure-verified; seller/orchestrator-signed';
  const vet = project(input)[1];
  assert.equal(vet.state, 'held'); assert.equal(vet.evidence[0].artifactKey, 'buyer');
  assert.ok(vet.evidence.every((row) => row.check === null && row.state === 'missing'));
});
test('included payment displays its block and exact hash without establishing finality or completion', () => {
  const input = fixture('completed'); input.operation.status = 'settled_verified';
  input.evidence.receipt = { txHash: 'tx-exact', blockNumber: 17, chainMode: 'TEST', finalized: true };
  const rows = project(input);
  assert.equal(rows[3].state, 'included'); assert.match(rows[3].reason, /included in block 17; finality is not established/);
  assert.equal(rows[3].evidence[0].txHash, 'tx-exact'); assert.equal(rows[3].evidence[0].block, 17);
  assert.equal(rows[4].state, 'pending');
});
test('Agreement and commitment require both recorded checks, retain coordinates, and clear earlier unknown state', () => {
  const input = fixture(); input.protocol.agreement = { ref: ref('Agreement'), anchorReceipt: receipt }; input.protocol.commitment = { ref: ref('Commitment') };
  assert.equal(project(input)[2].state, 'pending');
  assert.deepEqual(project(input)[2].evidence.map((row) => row.state), ['missing', 'missing']);
  input.history = [event('agreement', 'anchored'), event('commit-request', 'unavailable', 'TEST lost response'), event('commitment', 'verified')];
  const stage = project(input)[2]; assert.equal(stage.state, 'verified');
  assert.equal(stage.evidence[0].txHash, receipt.transactionRef.value); assert.equal(stage.evidence[0].block, 17);
  assert.equal(stage.evidence[1].artifactKey, 'Commitment'); assert.equal(stage.evidence[1].artifactHash, 'a'.repeat(64));
  assert.equal(stage.evidence[1].txHash, null); assert.ok(stage.evidence.some((row) => row.reason === 'TEST lost response'));
});
test('payment and verified delivery stop at delivery-ready; fixture bundle copies never complete Verify', () => {
  const input = fixture('completed'); input.protocol.paymentEvidence = { ref: ref('Payment') }; input.protocol.delivery = { deliverableRef: ref('Report'), anchorReceipt: receipt };
  input.protocol.bundle = { buyerCopy: ref('Buyer-copy'), sellerCopy: ref('Seller-copy') };
  input.history = [event('payment-evidence', 'verified'), event('delivery', 'verified')];
  const rows = project(input); assert.equal(rows[3].state, 'delivery-ready'); assert.equal(rows[4].state, 'pending');
  assert.equal(rows[4].evidence[0].artifactKey, 'Buyer-copy'); assert.equal(rows[4].evidence[0].state, 'missing');
  assert.match(rows[4].reason, /Completion audit pending/);
});
for (const [outcome, expected] of [['held', 'held'], ['rejected', 'rejected'], ['unknown', 'unknown'], ['indeterminate', 'unknown'], ['unavailable', 'unknown'], ['absent', 'missing'], ['refused', 'rejected']]) test(`recorded ${outcome} is visible with its reason`, () => {
  const input = fixture(); input.history = [event('commitment', outcome, `TEST ${outcome}`)];
  const stage = project(input)[2]; assert.equal(stage.state, expected); assert.equal(stage.reason, `TEST ${outcome}`);
});
test('missing checks fail closed and a false Listing check is rejected', () => {
  const input = fixture(); input.operation.state.preparedVerification.checks = [];
  assert.equal(project(input)[0].state, 'pending');
  input.operation.state.preparedVerification.checks = [{ name: 'signature', ok: false, detail: 'TEST wrong signer' }];
  assert.equal(project(input)[0].state, 'rejected'); assert.equal(project(input)[0].evidence[0].reason, 'TEST wrong signer');
});
test('current delivery evidence holds preserve pending and rejected reasons', () => {
  for (const [status, expected] of [['pending', 'pending'], ['rejected', 'rejected'], ['held', 'held']]) {
    const input = fixture('delivery-ready'); input.protocol.delivery = { deliverableRef: ref('Report'), evidenceHold: { status, reason: 'TEST evidence mismatch' } };
    const row = project(input)[3]; assert.equal(row.state, expected); assert.equal(row.reason, 'TEST evidence mismatch');
  }
});
test('an unsuccessful current delivery projection does not promote retained historical report bytes', () => {
  const input = fixture('native-payment-evidence-held'); input.operation.state.protocol.delivery = { deliverableRef: ref('Old-report') };
  input.protocol = protocolView(input.operation); input.history = [event('delivery', 'verified'), event('native-evidence', 'held', 'TEST fresh read unavailable')];
  const row = project(input)[3]; assert.equal(row.state, 'held'); assert.equal(row.evidence[2].artifactKey, null); assert.equal(row.evidence[2].state, 'missing');
});
test('projection is read-only and deterministic', () => {
  const input = fixture(); const before = JSON.stringify(input); const result = showcaseProgress(input);
  assert.equal(JSON.stringify(input), before); assert.deepEqual(showcaseProgress(input), result);
});
test('fixture and native delivery evidence require their recorded verification and profile-specific proof', () => {
  for (const native of [false, true]) {
    const input = fixture('delivered', native ? 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1' : 'dacs-chatgpt-plugin/fixed-price-pay-dem/v1');
    input.protocol.delivery = { deliverableRef: ref('Report'), evidenceRef: ref('Delivery-evidence'), evidenceReceipt: receipt, evidencePublication: 'native-read-back' };
    if (native) input.protocol.nativePayment = {};
    assert.equal(project(input)[3].evidence[3].state, 'missing');
    input.history = [event('delivery', 'verified')];
    const row = project(input)[3].evidence[3]; assert.equal(row.state, 'passed'); assert.equal(row.artifactKey, 'Delivery-evidence'); assert.equal(row.txHash, receipt.transactionRef.value);
    if (native) { delete input.protocol.delivery.evidenceReceipt; assert.equal(project(input)[3].evidence[3].state, 'missing'); }
  }
});
test('Agreement storage gaps and profile payment holds stay visible', () => {
  const input = fixture('agreement-signing'); input.protocol.storageGap = { message: 'TEST missing storage writer' }; input.protocol.limits.payment = 'held';
  const rows = project(input); assert.equal(rows[2].state, 'held'); assert.equal(rows[2].reason, 'TEST missing storage writer');
  assert.equal(rows[3].state, 'held'); assert.match(rows[3].reason, /Payment remains held/);
});
test('native payment evidence requires recorded fresh readback and stays separate from delivery', () => {
  const input = fixture('payment-evidenced'); input.protocol.paymentEvidence = { ref: ref('Native-payment'), anchorReceipt: receipt };
  assert.equal(project(input)[3].evidence[1].state, 'missing');
  input.history = [event('native-evidence', 'verified-fixture-native-read')];
  const rows = project(input); assert.equal(rows[3].state, 'payment-evidenced'); assert.equal(rows[3].evidence[1].state, 'passed'); assert.equal(rows[4].state, 'pending');
});
test('prepared Vet references and recorded refused reads remain inspectable without promoting a stage', () => {
  const input = fixture(); input.operation.state.protocol.planned = { draft: { parties: [{ role: 'buyer', vetRecordRef: ref('Planned-buyer') }] } };
  input.history = [{ type: 'pointer_rejected', data: { txHash: 'TEST-pointer', reason: 'TEST wrong payer' } }, { type: 'handoff_refused', data: { reason: 'TEST nonce hold' } }, { type: 'wallet_error', data: { message: 'TEST wallet unknown' } }];
  const rows = project(input); assert.equal(rows[1].evidence[0].artifactKey, 'Planned-buyer'); assert.equal(rows[1].state, 'held');
  assert.equal(rows[3].state, 'pending');
  for (const [name, state, reason] of [['pointer_rejected', 'rejected', 'TEST wrong payer'], ['handoff_refused', 'held', 'TEST nonce hold'], ['wallet_error', 'unknown', 'TEST wallet unknown']]) {
    const proof = rows[3].evidence.find((row) => row.label === name); assert.equal(proof.state, state); assert.equal(proof.reason, reason);
  }
});
test('failed Listing rechecks retain the exact failed check and reason', () => {
  const input = fixture(); input.operation.status = 'terms_changed'; input.history = [{ type: 'terms_changed', data: { checks: [{ name: 'signature', ok: false, detail: 'TEST revoked Listing' }] } }];
  const row = project(input)[0].evidence.find((row) => row.label === 'Listing recheck'); assert.equal(row.state, 'rejected'); assert.equal(row.check, 'signature'); assert.equal(row.reason, 'TEST revoked Listing');
});

// Review fixes: complete Listing check set, refused commitment rechecks, current payment evidence, same-step history.
const row = (stage, label) => stage.evidence.filter((r) => r.label === label);
test('Identify requires every named verifier check and the Listing binding; partial or older records stay pending', () => {
  const partial = fixture(); partial.operation.state.preparedVerification.checks = [{ name: 'chain-anchor-present', ok: true }];
  assert.equal(project(partial)[0].state, 'pending'); assert.match(project(partial)[0].reason, /incomplete/);
  for (const name of LISTING_CHECKS) {
    const input = fixture(); input.operation.state.preparedVerification.checks = passedChecks().filter((c) => c.name !== name);
    assert.equal(project(input)[0].state, 'pending', `omitted ${name}`);
  }
  const renamed = fixture(); renamed.operation.state.preparedVerification.checks = [...passedChecks().slice(1), { name: 'only-one-check', ok: true }];
  assert.equal(project(renamed)[0].state, 'pending');
  for (const field of ['listingId', 'version', 'contentHash', 'anchor']) {
    const input = fixture(); delete input.operation.terms.listing[field];
    assert.equal(project(input)[0].state, 'pending', `unbound ${field}`);
  }
  const complete = project(fixture())[0]; assert.equal(complete.state, 'verified');
  assert.deepEqual(complete.evidence.map((r) => r.check), LISTING_CHECKS);
  const failed = fixture(); failed.operation.state.preparedVerification.checks = [...passedChecks().slice(1), { name: LISTING_CHECKS[0], ok: false, detail: 'TEST differs' }];
  assert.equal(project(failed)[0].state, 'rejected');
});

const refusal = (reason = 'commitment_unverified', stage = 'pre-approval') => ({ type: 'commitment_recheck_refused', data: { stage, reason } });
const committedInput = () => {
  const input = fixture('committed'); input.protocol.agreement = { ref: ref('Agreement'), anchorReceipt: receipt }; input.protocol.commitment = { ref: ref('Commitment'), anchorReceipt: receipt };
  input.history = [event('agreement', 'anchored'), event('commitment', 'verified')]; return input;
};
test('a refused fresh commitment readback downgrades Negotiate and keeps the earlier pass as historical', () => {
  const input = committedInput(); input.history.push(refusal(), { type: 'approved', data: {} });
  const stage = project(input)[2]; assert.equal(stage.state, 'rejected'); assert.match(stage.reason, /commitment_unverified/);
  const [current] = row(stage, 'Seller commitment'); assert.equal(current.state, 'rejected'); assert.equal(current.artifactKey, null); assert.equal(current.txHash, null);
  const [historical] = row(stage, 'Seller commitment (historical)'); assert.equal(historical.state, 'passed');
  assert.equal(historical.artifactKey, 'Commitment'); assert.equal(historical.txHash, receipt.transactionRef.value); assert.match(historical.scope, /^Historical/);
  assert.equal(row(stage, 'commitment_recheck_refused')[0].reason, 'commitment_unverified');
  assert.equal(row(stage, 'Agreement')[0].state, 'passed');
});
test('only a recorded recovery restores Negotiate after a refused commitment readback', () => {
  for (const recovery of [event('commitment', 'verified'), { type: 'payment_handoff', data: {} }, { type: 'handoff_reissued', data: {} }]) {
    const input = committedInput(); input.history.push(refusal('commitment_unverified', 'handoff'), recovery);
    const stage = project(input)[2]; assert.equal(stage.state, 'verified', recovery.type);
    assert.equal(row(stage, 'Seller commitment')[0].state, 'passed'); assert.equal(row(stage, 'Seller commitment (historical)').length, 0);
    assert.equal(row(stage, 'commitment_recheck_refused')[0].state, 'rejected');
    input.history.push(refusal()); assert.equal(project(input)[2].state, 'rejected', `refused again after ${recovery.type}`);
  }
  const other = committedInput(); other.history.push(refusal('seller_delegation_expiring'));
  assert.equal(project(other)[2].state, 'verified');
});

const nativePaid = () => {
  const input = fixture('payment-evidenced'); input.protocol.nativePayment = {};
  input.protocol.paymentEvidence = { ref: ref('Native-payment'), anchorReceipt: receipt }; input.protocol.nativeEvidence = { nativeReadback: 'present' };
  return input;
};
test('a later held native evidence read makes retained payment evidence historical', () => {
  const input = nativePaid(); input.history = [event('delivery', 'verified'), event('native-evidence', 'held', 'TEST fresh read unavailable')];
  const settle = project(input)[3]; assert.equal(settle.state, 'held');
  const [current] = row(settle, 'Payment evidence'); assert.equal(current.state, 'held'); assert.equal(current.reason, 'TEST fresh read unavailable'); assert.equal(current.artifactKey, null);
  const [historical] = row(settle, 'Payment evidence (historical)'); assert.equal(historical.state, 'passed'); assert.equal(historical.artifactKey, 'Native-payment'); assert.match(historical.scope, /^Historical/);
  input.history.push(event('delivery', 'verified'));
  assert.equal(row(project(input)[3], 'Payment evidence')[0].state, 'passed'); assert.equal(row(project(input)[3], 'Payment evidence (historical)').length, 0);
});
test('delivery failures are not payment evidence attempts; only a native delivery read also verifies payment', () => {
  const input = fixture('payment-evidenced'); input.protocol.paymentEvidence = { ref: ref('Payment') };
  input.history = [event('payment-evidence', 'verified'), event('delivery', 'unavailable', 'TEST delivery read timed out')];
  const settle = project(input)[3]; assert.equal(row(settle, 'Payment evidence')[0].state, 'passed'); assert.equal(settle.state, 'unknown');
  const native = nativePaid(); native.history = [event('native-evidence', 'verified-fixture-native-read'), event('delivery', 'rejected', 'TEST wrong report')];
  assert.equal(row(project(native)[3], 'Payment evidence')[0].state, 'passed');
  const fixtureDelivery = fixture('delivered', 'dacs-chatgpt-plugin/fixed-price-pay-dem/v1'); fixtureDelivery.protocol.paymentEvidence = { ref: ref('Payment') };
  fixtureDelivery.history = [event('delivery', 'verified')];
  assert.equal(row(project(fixtureDelivery)[3], 'Payment evidence')[0].state, 'missing', 'only a native delivery read also verifies payment evidence');
});

test('same-step failures stay as historical rows with their reasons after recovery', () => {
  const commitment = committedInput(); commitment.history = [event('agreement', 'anchored'), event('commitment', 'unavailable', 'TEST first read timed out'), event('commitment', 'verified')];
  const negotiate = project(commitment)[2]; assert.equal(negotiate.state, 'verified');
  const [old] = row(negotiate, 'commitment'); assert.equal(old.state, 'unknown'); assert.equal(old.reason, 'TEST first read timed out'); assert.match(old.scope, /^Historical/);

  const native = nativePaid(); native.history = [event('native-evidence', 'held', 'TEST native read held'), event('native-evidence', 'held', 'TEST second hold'), event('native-evidence', 'verified-fixture-native-read')];
  const settle = project(native)[3]; assert.equal(settle.state, 'payment-evidenced'); assert.equal(row(settle, 'Payment evidence')[0].state, 'passed');
  assert.deepEqual(row(settle, 'native-evidence').map((r) => [r.state, r.reason]), [['held', 'TEST native read held'], ['held', 'TEST second hold']]);

  const delivery = fixture('delivered'); delivery.protocol.paymentEvidence = { ref: ref('Payment') }; delivery.protocol.delivery = { deliverableRef: ref('Report') };
  delivery.history = [event('payment-evidence', 'verified'), event('delivery', 'unavailable', 'TEST delivery read timed out'), event('delivery', 'verified')];
  const delivered = project(delivery)[3]; assert.equal(delivered.state, 'delivery-ready');
  const [failed] = row(delivered, 'delivery'); assert.equal(failed.state, 'unknown'); assert.equal(failed.reason, 'TEST delivery read timed out'); assert.match(failed.scope, /^Historical/);
});
test('the latest negative outcome is current and protocol.lastAttempt is not duplicated', () => {
  const input = committedInput(); input.history = [event('agreement', 'anchored'), event('commitment', 'unavailable', 'TEST lost read')];
  input.protocol.lastAttempt = { at: '2026-10-08T00:00:00.000Z', step: 'commitment', outcome: 'unavailable', reason: 'TEST lost read' };
  let stage = project(input)[2]; assert.equal(stage.state, 'unknown');
  const rows = row(stage, 'commitment'); assert.equal(rows.length, 1); assert.match(rows[0].scope, /^Current/);
  input.history = [event('agreement', 'anchored')];
  stage = project(input)[2]; assert.equal(stage.state, 'unknown'); assert.equal(row(stage, 'commitment').length, 1);
});

// an earlier review: refused fresh Agreement readbacks, and every recorded refusal kept in order.
const scopes = (stage, label) => row(stage, label).map((r) => [r.state, r.reason, r.txHash, /^Current/.test(r.scope) ? 'current' : /^Historical/.test(r.scope) ? 'historical' : r.scope]);
test('a refused fresh Agreement readback downgrades Negotiate and keeps the earlier Agreement pass as historical', () => {
  for (const reason of ['agreement_unverified', 'agreement_terms_mismatch']) {
    const input = committedInput(); input.history.push(refusal(reason), { type: 'approved', data: {} }, event('commitment', 'verified'));
    const stage = project(input)[2]; assert.equal(stage.state, 'rejected', reason); assert.match(stage.reason, new RegExp(reason));
    const [current] = row(stage, 'Agreement'); assert.equal(current.state, 'rejected'); assert.match(current.reason, new RegExp(reason)); assert.equal(current.txHash, null); assert.equal(current.artifactKey, null);
    const [historical] = row(stage, 'Agreement (historical)'); assert.equal(historical.state, 'passed');
    assert.equal(historical.txHash, receipt.transactionRef.value); assert.equal(historical.block, 17); assert.match(historical.scope, /^Historical/);
    assert.equal(row(stage, 'Seller commitment')[0].state, 'passed', 'the commitment check itself was not refused');
    assert.deepEqual(row(stage, 'commitment_recheck_refused').map((r) => [r.state, r.reason]), [['rejected', reason]]);
  }
});
test('only a passed fresh gate restores Negotiate after a refused Agreement readback', () => {
  for (const recovery of [{ type: 'payment_handoff', data: {} }, { type: 'handoff_reissued', data: {} }]) {
    const input = committedInput(); input.history.push(refusal('agreement_unverified', 'handoff'), recovery);
    const stage = project(input)[2]; assert.equal(stage.state, 'verified', recovery.type);
    assert.equal(row(stage, 'Agreement')[0].state, 'passed'); assert.equal(row(stage, 'Agreement (historical)').length, 0);
    input.history.push(refusal('agreement_terms_mismatch')); assert.equal(project(input)[2].state, 'rejected', `refused again after ${recovery.type}`);
  }
  const both = committedInput(); both.history.push(refusal('agreement_unverified'), refusal('commitment_unverified'));
  const stage = project(both)[2]; assert.equal(stage.state, 'rejected'); assert.match(stage.reason, /agreement_unverified/); assert.match(stage.reason, /commitment_unverified/);
  assert.equal(row(stage, 'Agreement')[0].state, 'rejected'); assert.equal(row(stage, 'Seller commitment')[0].state, 'rejected');
  both.history.push(event('commitment', 'verified'));
  const later = project(both)[2]; assert.equal(later.state, 'rejected', 'a commitment readback is not a fresh Agreement readback'); assert.equal(row(later, 'Seller commitment')[0].state, 'passed');
  assert.doesNotMatch(later.reason, /commitment_unverified/);
  assert.deepEqual(scopes(later, 'commitment_recheck_refused').map((r) => [r[1], r[3]]), [['agreement_unverified', 'current'], ['commitment_unverified', 'historical']]);
});

test('every recorded refusal stays visible in order, labelled current or historical', () => {
  const input = fixture();
  input.history = [{ type: 'pointer_rejected', data: { txHash: 'TEST-first', reason: 'TEST wrong payer' } }, { type: 'pointer_rejected', data: { txHash: 'TEST-second', reason: 'TEST wrong nonce' } },
    { type: 'readback_refused', data: { txHash: 'TEST-second', reason: 'TEST network A' } }, { type: 'readback_refused', data: { txHash: 'TEST-second', reason: 'TEST network B' } },
    { type: 'wallet_error', data: { message: 'TEST wallet first' } }, { type: 'wallet_error', data: { message: 'TEST wallet second' } },
    { type: 'handoff_readback_only', data: { reason: 'TEST issued' } }, { type: 'handoff_readback_only', data: { reason: 'TEST issued' } }];
  let settle = project(input)[3];
  assert.deepEqual(scopes(settle, 'pointer_rejected'), [['rejected', 'TEST wrong payer', 'TEST-first', 'historical'], ['rejected', 'TEST wrong nonce', 'TEST-second', 'current']]);
  assert.deepEqual(scopes(settle, 'readback_refused'), [['rejected', 'TEST network A', 'TEST-second', 'historical'], ['rejected', 'TEST network B', 'TEST-second', 'current']]);
  // Unknown outcomes are kept: never labelled historical.
  assert.deepEqual(scopes(settle, 'wallet_error'), [['unknown', 'TEST wallet first', null, 'current'], ['unknown', 'TEST wallet second', null, 'current']]);
  assert.deepEqual(scopes(settle, 'handoff_readback_only'), [['unknown', 'TEST issued', null, 'current'], ['unknown', 'TEST issued', null, 'current']]);
  input.history.push({ type: 'settled_verified', data: {} });
  settle = project(input)[3];
  assert.deepEqual(scopes(settle, 'pointer_rejected').map((r) => r[3]), ['historical', 'historical']);
  assert.deepEqual(scopes(settle, 'readback_refused').map((r) => r[3]), ['historical', 'historical']);
  assert.deepEqual(scopes(settle, 'wallet_error').map((r) => r[3]), ['current', 'current']);
});
// Sequences purchases.mjs records: a pre-approval gate refusal; a handoff gate refusal (commitment_recheck_refused, then
// handoff_refused with the same reason); after payment_handoff, a re-issue gate refusal (no handoff_refused) or a
// bound-network refusal (handoff_refused only). recheckCommitment checks the delegation margin, then the Agreement,
// then the commitment, then the committed terms.
const handoffRefusal = (reason) => [refusal(reason, 'handoff'), { type: 'handoff_refused', data: { reason } }];
test('repeated gate refusals keep every reason; recovery makes them historical without hiding them', () => {
  const input = committedInput();
  input.history.push(refusal('commitment_unverified', 'pre-approval'), { type: 'approved', data: {} }, ...handoffRefusal('commitment_unverified'), { type: 'payment_handoff', data: {} },
    refusal('commitment_unverified', 'handoff-reissue'), { type: 'handoff_refused', data: { reason: 'network_identity_mismatch' } });
  let rows = project(input);
  assert.deepEqual(scopes(rows[2], 'commitment_recheck_refused'), [['rejected', 'commitment_unverified', null, 'historical'], ['rejected', 'commitment_unverified', null, 'historical'], ['rejected', 'commitment_unverified', null, 'current']]);
  assert.deepEqual(scopes(rows[3], 'handoff_refused'), [['held', 'commitment_unverified', null, 'historical'], ['held', 'network_identity_mismatch', null, 'current']]);
  assert.equal(rows[2].state, 'rejected', 'the re-issue gate refused the commitment after the handoff passed');
  input.history.push({ type: 'handoff_reissued', data: {} });
  rows = project(input);
  assert.deepEqual(scopes(rows[2], 'commitment_recheck_refused').map((r) => r[3]), ['historical', 'historical', 'historical']);
  assert.deepEqual(scopes(rows[3], 'handoff_refused').map((r) => r[3]), ['historical', 'historical']);
  assert.equal(rows[2].state, 'verified');
  // A different later refusal does not make an unrecovered commitment refusal historical.
  const open = committedInput(); open.history.push(refusal('commitment_unverified'), refusal('agreement_unverified'));
  const negotiate = project(open)[2]; assert.equal(negotiate.state, 'rejected');
  assert.deepEqual(scopes(negotiate, 'commitment_recheck_refused').map((r) => [r[1], r[3]]), [['commitment_unverified', 'current'], ['agreement_unverified', 'current']]);
  open.history.push(refusal('commitment_unverified'));
  assert.deepEqual(scopes(project(open)[2], 'commitment_recheck_refused').map((r) => [r[1], r[3]]), [['commitment_unverified', 'historical'], ['agreement_unverified', 'current'], ['commitment_unverified', 'current']]);
});
test('a handoff refusal stays current until its own check passes or refuses again, as in Negotiate', () => {
  const input = committedInput();
  input.history.push({ type: 'approved', data: {} }, ...handoffRefusal('agreement_unverified'), ...handoffRefusal('agreement_unverified'));
  assert.deepEqual(scopes(project(input)[3], 'handoff_refused').map((r) => [r[1], r[3]]), [['agreement_unverified', 'historical'], ['agreement_unverified', 'current']]);
  // The delegation check runs before the Agreement read, so it never re-checked the Agreement.
  input.history.push(...handoffRefusal('seller_delegation_expiring'));
  const [, , negotiate, settle] = project(input);
  assert.deepEqual(scopes(settle, 'handoff_refused').map((r) => [r[1], r[3]]), [['agreement_unverified', 'historical'], ['agreement_unverified', 'current'], ['seller_delegation_expiring', 'current']]);
  assert.deepEqual(scopes(negotiate, 'commitment_recheck_refused').map((r) => [r[1], r[3]]), [['agreement_unverified', 'historical'], ['agreement_unverified', 'current'], ['seller_delegation_expiring', 'current']]);
  assert.equal(negotiate.state, 'rejected'); assert.match(negotiate.reason, /agreement_unverified/);
});

// an earlier review: after payment, a native evidence re-check reads the Agreement first.
const agreementHeld = (code = 'agreement_unverified') => ({ type: 'protocol_native-evidence', data: { outcome: 'held', reason: 'fresh native Agreement/projection readback did not verify; no payment is issued', ...(code ? { code } : {}) } });
const nativeCommitted = () => {
  const input = committedInput(); input.protocol.stage = input.operation.state.protocol.stage = 'payment-evidenced'; input.operation.status = 'settled_verified';
  input.protocol.nativePayment = {}; input.protocol.paymentEvidence = { ref: ref('Native-payment'), anchorReceipt: receipt }; input.protocol.nativeEvidence = { nativeReadback: 'present' };
  input.history.push({ type: 'approved', data: {} }, { type: 'payment_handoff', data: {} }, { type: 'settled_verified', data: {} }, event('native-evidence', 'verified-fixture-native-read'));
  return input;
};
test('a native evidence re-check whose Agreement read did not verify downgrades Negotiate until a verified native read or a passed gate', () => {
  const input = nativeCommitted(); assert.equal(project(input)[2].state, 'verified');
  input.history.push(agreementHeld());
  const [, , negotiate, settle] = project(input);
  assert.equal(negotiate.state, 'rejected'); assert.match(negotiate.reason, /agreement_unverified/);
  assert.equal(row(negotiate, 'Agreement')[0].state, 'rejected'); assert.match(row(negotiate, 'Agreement')[0].reason, /agreement_unverified/);
  assert.equal(row(negotiate, 'Agreement (historical)')[0].state, 'passed'); assert.equal(row(negotiate, 'Seller commitment')[0].state, 'passed');
  assert.equal(settle.state, 'held'); assert.match(settle.reason, /did not verify/);
  for (const recovery of [event('native-evidence', 'verified-fixture-native-read'), event('delivery', 'verified'), { type: 'handoff_reissued', data: {} }]) {
    const recovered = nativeCommitted(); recovered.history.push(agreementHeld(), recovery);
    const stage = project(recovered)[2]; assert.equal(stage.state, 'verified', recovery.type);
    assert.equal(row(stage, 'Agreement')[0].state, 'passed'); assert.equal(row(stage, 'Agreement (historical)').length, 0);
  }
  for (const later of [event('native-evidence', 'held', 'TEST native read held'), agreementHeld(null), event('commitment', 'verified'), { type: 'settled_verified', data: {} }]) {
    const still = nativeCommitted(); still.history.push(agreementHeld(), later);
    assert.equal(project(still)[2].state, 'rejected', `${later.type} ${later.data.outcome ?? ''} did not verify the Agreement`);
  }
  // Only the plugin's agreement_unverified code is an Agreement refusal; other held reads leave Negotiate alone.
  for (const other of [agreementHeld(null), agreementHeld('seller_agent_changed'), event('native-evidence', 'held', 'TEST native read held'), event('delivery', 'rejected', 'TEST wrong report')]) {
    const held = nativeCommitted(); held.history.push(other);
    const stage = project(held)[2]; assert.equal(stage.state, 'verified', JSON.stringify(other.data)); assert.equal(row(stage, 'Agreement (historical)').length, 0);
  }
});

// an earlier review: refusal history is labelled in one pass, and each stage lists only its latest recorded attempts.
const ATTEMPT_ROWS = 20, SUMMARY = 'Earlier recorded attempts';
const counted = (entries) => {
  const reads = { count: 0 };
  return [new Proxy(entries, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads.count += 1; return Reflect.get(target, key, receiver); } }), reads];
};
// A buyer repeats refused gates and handoffs while readback is faulty; one early unknown wallet outcome stays current.
const longHistory = (n) => {
  const entries = [...committedInput().history, { type: 'wallet_error', data: { message: 'TEST early unknown' } }, { type: 'handoff_readback_only', data: { reason: 'TEST issued' } }];
  for (let i = 0; i < n; i += 1) entries.push(refusal('commitment_unverified', 'handoff'), { type: 'handoff_refused', data: { reason: `TEST refusal ${i}` } }, event('commitment', 'unavailable', `TEST read ${i}`));
  return entries.map((entry, i) => ({ seq: i + 1, ...entry }));
};
test('a long refusal history projects with linear history reads and lists a bounded window that counts older attempts', () => {
  const project2 = (n) => { const input = committedInput(), [history, reads] = counted(longHistory(n)); input.history = history; const ledger = showcaseProgress(input); return { ledger, reads: reads.count, entries: history.length, html: showcaseProgressHtml(ledger) }; };
  const small = project2(3000), large = project2(6000);
  // Pre-fix: each refusal copied the rest of the history (about entries² / 3 reads, ~108M at 6,000 iterations).
  assert.ok(large.reads <= 20 * large.entries, `${large.reads} history reads for ${large.entries} entries`);
  assert.ok(large.reads <= 2.2 * small.reads, `reads grew from ${small.reads} to ${large.reads} when the history doubled`);
  assert.ok(large.html.length <= 1.05 * small.html.length, `rendered ledger grew from ${small.html.length} to ${large.html.length} bytes`);
  for (const stage of large.ledger.stages) assert.ok(stage.evidence.length <= 12 + 3 * (ATTEMPT_ROWS + 1), `${stage.name}: ${stage.evidence.length} rows`);

  const [, , negotiate, settle] = large.ledger.stages, n = 6000;
  const handoffs = row(settle, 'handoff_refused');
  assert.deepEqual(handoffs.map((r) => r.reason), Array.from({ length: ATTEMPT_ROWS }, (_, i) => `TEST refusal ${n - ATTEMPT_ROWS + i}`), 'the latest attempts, in order');
  // Each handoff refusal has its own reason and no gate passed, so every one is still current.
  assert.deepEqual(handoffs.map((r) => /^Current/.test(r.scope)), Array(ATTEMPT_ROWS).fill(true));
  // The older rows are counted in one row placed before them; the omitted unknown outcomes keep it current and unknown.
  const [older] = row(settle, SUMMARY), at = settle.evidence.indexOf(older);
  assert.equal(settle.evidence[at + 1], handoffs[0]);
  assert.equal(older.state, 'unknown'); assert.equal(older.check, `${n - ATTEMPT_ROWS + 2} earlier recorded attempts not listed`);
  assert.match(older.scope, new RegExp(`^Current: ${n - ATTEMPT_ROWS + 2} of them are still current, including 2 unknown outcomes that are never superseded`));
  assert.match(older.reason, new RegExp(`latest ${ATTEMPT_ROWS} .*history seq 3–${6 + 3 * (n - ATTEMPT_ROWS - 1)}\\)`));
  assert.equal(row(settle, 'wallet_error').length, 0); assert.equal(row(settle, 'handoff_readback_only').length, 0);
  // Gate refusals and protocol attempts are bounded separately, so the current protocol outcome stays listed.
  assert.equal(row(negotiate, 'commitment_recheck_refused').length, ATTEMPT_ROWS); assert.equal(row(negotiate, 'commitment').length, ATTEMPT_ROWS);
  assert.equal(row(negotiate, SUMMARY).length, 2);
  assert.match(row(negotiate, 'commitment').at(-1).scope, /^Current/); assert.equal(negotiate.state, 'unknown'); assert.equal(negotiate.reason, `TEST read ${n - 1}`);
  for (const summary of row(negotiate, SUMMARY)) assert.match(summary.scope, /^Historical/);
});

// The quadratic definition the one-pass labelling must reproduce.
const recoveredBy = { gate: (h) => ['payment_handoff', 'handoff_reissued'].includes(h.type), settled: (h) => h.type === 'settled_verified' };
recoveredBy.commitment = (h) => (h.type === 'protocol_commitment' && h.data?.outcome === 'verified') || recoveredBy.gate(h);
const refusalStage = { commitment_recheck_refused: 2, handoff_refused: 3, readback_refused: 3, pointer_rejected: 3, wallet_error: 3, handoff_readback_only: 3 };
const recoveryFor = (e) => e.type === 'commitment_recheck_refused' ? (e.data.reason === 'commitment_unverified' ? recoveredBy.commitment : recoveredBy.gate)
  : e.type === 'handoff_refused' ? recoveredBy.gate : ['readback_refused', 'pointer_rejected'].includes(e.type) ? recoveredBy.settled : null;
const reference = (history) => history.flatMap((e, i) => {
  if (!refusalStage[e.type]) return [];
  const recovered = recoveryFor(e), later = history.slice(i + 1);
  const historical = Boolean(recovered) && later.some((h) => recovered(h) || (h.type === e.type && (!['commitment_recheck_refused', 'handoff_refused'].includes(e.type) || h.data?.reason === e.data?.reason)));
  return [{ stage: refusalStage[e.type], label: e.type, reason: e.data.reason ?? e.data.message, historical, unknown: !recovered }];
});
test('one-pass refusal labels match the full later-history definition, and the count row matches the omitted rows', () => {
  const pool = [refusal('commitment_unverified'), refusal('agreement_unverified'), refusal('seller_delegation_expiring'), { type: 'handoff_refused', data: { reason: 'TEST A' } }, { type: 'handoff_refused', data: { reason: 'TEST B' } },
    { type: 'readback_refused', data: { reason: 'TEST network' } }, { type: 'pointer_rejected', data: { reason: 'TEST payer' } }, { type: 'wallet_error', data: { message: 'TEST wallet' } }, { type: 'handoff_readback_only', data: { reason: 'TEST issued' } },
    { type: 'payment_handoff', data: {} }, { type: 'handoff_reissued', data: {} }, { type: 'settled_verified', data: {} }, event('commitment', 'verified'), { type: 'approved', data: {} }];
  let seed = 7; const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % pool.length;
  let truncated = 0;
  for (let run = 0; run < 400; run += 1) {
    const input = committedInput(); input.history.push(...Array.from({ length: 1 + (run % 70) }, () => pool[next()]));
    const stages = project(input), expected = reference(input.history);
    for (const index of [2, 3]) {
      const want = expected.filter((r) => r.stage === index);
      const got = stages[index].evidence.filter((r) => Object.hasOwn(refusalStage, r.label) || r.label === SUMMARY);
      const kept = want.slice(-ATTEMPT_ROWS), omitted = want.slice(0, -ATTEMPT_ROWS);
      assert.deepEqual(got.filter((r) => r.label !== SUMMARY).map((r) => [r.label, r.reason, /^Historical/.test(r.scope)]), kept.map((r) => [r.label, r.reason, r.historical]), `run ${run} stage ${index}`);
      if (want.length <= ATTEMPT_ROWS) { assert.equal(got.length, want.length); continue; }
      truncated += 1;
      const current = omitted.filter((r) => !r.historical), unknown = omitted.filter((r) => r.unknown);
      assert.equal(got[0].label, SUMMARY); assert.equal(got[0].check, `${omitted.length} earlier recorded attempts not listed`);
      assert.equal(got[0].state, unknown.length ? 'unknown' : omitted.some((r) => r.label !== 'handoff_refused') ? 'rejected' : 'held', `run ${run}`);
      assert.equal(got[0].scope, current.length ? `Current: ${current.length} of them are still current${unknown.length ? `, including ${unknown.length} unknown outcomes that are never superseded` : ''}` : 'Historical attempts; later recorded attempts or recoveries supersede them', `run ${run}`);
    }
  }
  assert.ok(truncated > 50, `${truncated} truncated stages exercised`);
});
