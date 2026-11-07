// boundTermsMismatch compares an Agreement with the terms the buyer approved.
// DACS-4 §9.5.1 PB-1: the Agreement carries exactly one payout binding, for the
// Listing's rail, to the seller payee; payment goes to no other destination, so
// a missing, wrong-rail, duplicate or extra binding is a mismatch. DV-2 reaches
// this function only through the Listing pin (the declared access mode is part
// of the pinned Listing); DV-1 compares delivered bytes and is not an Agreement
// term (see delivery-evidence-gate.test.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundTermsMismatch } from '../src/dacs/purchase-protocol.mjs';
import { claimForAddress } from '../src/signatures.mjs';

const JOB_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BUYER_WALLET = '0x' + 'b'.repeat(64), SELLER_PAYEE = '0x' + 'a'.repeat(64), OTHER_PAYEE = '0x' + 'c'.repeat(64);
const RAIL = 'demos-native:DEM', OTHER_RAIL = 'TEST-other:DEM', PAYMENT_PHASE = 2;
const LISTING = { listingId: 'TEST-listing', version: 1, contentHash: 'd'.repeat(64) };

const operation = () => ({ terms: { buyer: { wallet: BUYER_WALLET }, seller: { claim: claimForAddress(SELLER_PAYEE), payee: SELLER_PAYEE },
  protocol: { jobId: JOB_ID }, listing: { ...LISTING }, rail: RAIL, price: { amount: '2.5', amountOs: '2500000000' } } });
const binding = (payeeAddress = SELLER_PAYEE, railId = RAIL) => ({ railId, phaseIndex: PAYMENT_PHASE, payeeAddress });
const agreement = (payoutBindings = [binding()], listingRef = LISTING) => ({ jobId: JOB_ID, listingRef: { ...listingRef },
  parties: [{ role: 'buyer', primaryClaim: claimForAddress(BUYER_WALLET) }, { role: 'seller', primaryClaim: claimForAddress(SELLER_PAYEE) }],
  terms: { payoutBindings, price: { amount: '2.5', currency: 'DEM' }, deadline: 1 } });

test('an Agreement with exactly the approved terms is not a mismatch', () => {
  assert.equal(boundTermsMismatch(operation(), agreement()), null);
});

test('PB-1: a binding to an address other than the seller payee is a payee mismatch', () => {
  assert.equal(boundTermsMismatch(operation(), agreement([binding(OTHER_PAYEE)])), 'payee');
});

test('PB-1: a binding on a rail other than the Listing rail is a payee mismatch', () => {
  assert.equal(boundTermsMismatch(operation(), agreement([binding(SELLER_PAYEE, OTHER_RAIL)])), 'payee');
});

test('PB-1: a second binding is a payee mismatch whether it repeats the payee or names another address', () => {
  assert.equal(boundTermsMismatch(operation(), agreement([binding(), binding()])), 'payee');
  assert.equal(boundTermsMismatch(operation(), agreement([binding(), binding(OTHER_PAYEE)])), 'payee');
  assert.equal(boundTermsMismatch(operation(), agreement([binding(OTHER_PAYEE), binding()])), 'payee');
});

test('PB-1: a missing payout binding is a payee mismatch', () => {
  assert.equal(boundTermsMismatch(operation(), agreement([])), 'payee');
  const withoutTerms = agreement();
  delete withoutTerms.terms;
  assert.equal(boundTermsMismatch(operation(), withoutTerms), 'payee');
});

test('DV-2: an Agreement pinned to a different Listing is a listing mismatch', () => {
  assert.equal(boundTermsMismatch(operation(), agreement([binding()], { ...LISTING, contentHash: 'e'.repeat(64) })), 'listing');
});
