import test from 'node:test';
import assert from 'node:assert/strict';
import { finalityCommitmentAddress } from '@kynesyslabs/dacs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { evaluateCompletionReadiness } from '../src/dacs/completion-readiness.mjs';

// Pins how the recorded-state evaluator treats the receipt `finalityProfile` literal.
// Known deviation: the pinned Standard (spec/DEMOS-MAPPING.md) names `demos-bft-final`,
// while the SDK emits and the evaluator requires `demos-bft-confirmed-native-read`.
// Moving to the Standard's literal is a separate change to the emitter and every check.
const JOB = '01J8ME0SXKQ4T9V2RC5HJ6WX7D';
const NOW = 1_790_000_000_000, H = 'a'.repeat(64);
const SDK_PROFILE = 'demos-bft-confirmed-native-read';
const PINNED_STANDARD_PROFILE = 'demos-bft-final';

function commitmentOperation(receiptOverrides) {
  const buyer = createEphemeralWallet(), seller = createEphemeralWallet();
  const logicalAddress = finalityCommitmentAddress(JOB);
  const anchorReceipt = {
    receiptVersion: '1', substrate: 'demos', finalityProfile: SDK_PROFILE, logicalAddress,
    nativeAddress: `stor-${'b'.repeat(40)}`, contentHash: H, writer: seller.claim, nonce: '4',
    transactionRef: { kind: 'demos', value: H }, state: 'finalized', observationDisposition: 'established',
    observedAt: NOW, blockRef: { id: H, height: '120', timestamp: NOW },
    evidence: { kind: 'untrusted-test-proof', value: 'no-consensus-authority' },
    ...receiptOverrides,
  };
  return {
    terms: {
      buyer: { wallet: buyer.address }, seller: { claim: seller.claim, payee: seller.address },
      protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', jobId: JOB },
    },
    state: { protocol: { stage: 'delivered', commitment: {
      status: 'verified', contentHash: H, signer: seller.claim,
      ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: H, signer: seller.claim },
      anchorReceipt,
    } } },
  };
}

function evaluate(receiptOverrides) {
  const result = evaluateCompletionReadiness(commitmentOperation(receiptOverrides), null);
  const row = (id) => {
    const found = result.requirements.find((requirement) => requirement.id === id);
    assert.ok(found, id);
    return found;
  };
  return { result, receiptRow: row('commitment.receipt'), finalityRow: row('finality') };
}

test('receipt with finalityProfile demos-bft-final is refused with receipt.profile', () => {
  const { receiptRow } = evaluate({ finalityProfile: PINNED_STANDARD_PROFILE });
  assert.equal(receiptRow.status, 'mismatch');
  assert.equal(receiptRow.code, 'receipt.profile');
});

test('receipt with the SDK finalityProfile demos-bft-confirmed-native-read passes the profile step', () => {
  const { receiptRow } = evaluate({ finalityProfile: SDK_PROFILE });
  assert.notEqual(receiptRow.code, 'receipt.profile');
  assert.equal(receiptRow.status, 'unavailable');
  assert.equal(receiptRow.code, 'receipt.unauthenticated');
});

test('an unknown finalityProfile literal is refused with receipt.profile', () => {
  const { receiptRow } = evaluate({ finalityProfile: 'demos-bft-unreleased-literal' });
  assert.equal(receiptRow.status, 'mismatch');
  assert.equal(receiptRow.code, 'receipt.profile');
});

test('SDK profile receipt that is not finalized stays receipt.nonfinal', () => {
  const { receiptRow } = evaluate({ finalityProfile: SDK_PROFILE, state: 'included' });
  assert.equal(receiptRow.status, 'unavailable');
  assert.equal(receiptRow.code, 'receipt.nonfinal');
});

for (const finalityProfile of [SDK_PROFILE, PINNED_STANDARD_PROFILE]) {
  test(`${finalityProfile} receipt does not make completion final`, () => {
    const { result, receiptRow, finalityRow } = evaluate({ finalityProfile });
    assert.equal(result.status, 'held');
    assert.notEqual(receiptRow.status, 'present');
    assert.equal(finalityRow.status, 'unavailable');
    assert.equal(finalityRow.code, 'finality.no-authenticated-source');
  });
}
