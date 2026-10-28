import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorBuyerAccess, operatorBuyerAccessConfig } from '../src/devnet-demo/buyer-access.mjs';
import { buyer, seller, JOB } from './helpers/protocol-fixture.mjs';

test('buyer access requires constructed authority and the configured custody identity', () => {
  const access = createOperatorBuyerAccess({ custodyBuyer: buyer.claim, custodySeller: seller.claim, buyerForJob: () => buyer.address });
  assert.equal(access.allowsWallet(buyer.address), true); assert.equal(access.allowsWallet(seller.address), false);
  assert.equal(access.jobAccess(JOB), 'custody'); assert.throws(() => access.assertRelayWallet(seller.address));
  assert.throws(() => operatorBuyerAccessConfig({ ...access }));
});

for (const method of ['assertSellerWallet', 'sellerNotice']) {
  for (const [label, retained, ready, wallet] of [
    ['another buyer', buyer.address, true, seller.address],
    ['no retained buyer', null, true, seller.address],
    ['lookup unavailable', seller.address, false, seller.address],
    ['malformed wallet', 'malformed', true, 'malformed'],
  ]) test(`paid outside ${method} refuses ${label}`, () => {
    const access = createOperatorBuyerAccess({ custodyBuyer: buyer.claim, buyerForJob: () => retained,
      buyerLookupReady: () => ready, paymentObserved: () => true });
    assert.throws(() => access[method](wallet, JOB), { code: 'buyer_access_closed' });
  });
  test(`paid outside ${method} admits only the retained wallet and preserves other access policies`, () => {
    let paid = true;
    const access = createOperatorBuyerAccess({ custodyBuyer: buyer.claim, buyerForJob: () => seller.address,
      paymentObserved: () => paid });
    assert.doesNotThrow(() => access[method](seller.address.toUpperCase(), JOB));
    paid = false;
    assert.throws(() => access[method](seller.address, JOB), { code: 'buyer_access_closed' });
    // The custody wallet is not this job's retained buyer, so it is refused even
    // though closed access otherwise trusts it.
    assert.throws(() => access[method](buyer.address, JOB), { code: 'buyer_access_closed' });
    const custodyJob = createOperatorBuyerAccess({ custodyBuyer: buyer.claim, buyerForJob: () => buyer.address });
    assert.doesNotThrow(() => custodyJob[method](buyer.address, JOB));
    if (method === 'sellerNotice') assert.equal(custodyJob.sellerNotice(buyer.address, JOB), null);
    // Open mode admits any wallet for new buyer requests, never for a job that
    // has no retained buyer: the seller-side join still has to succeed.
    const open = createOperatorBuyerAccess({ openBuyerAccess: true });
    assert.throws(() => open[method](seller.address, JOB), { code: 'buyer_access_closed' });
    assert.throws(() => open[method]('malformed', JOB), { code: 'buyer_access_closed' });
  });
}

test('seller wallet access joins the retained buyer before the custody or paid policy', () => {
  const otherBuyer = `0x${'52'.repeat(32)}`;
  for (const [label, options] of [
    ['another buyer', { custodyBuyer: buyer.claim, buyerForJob: () => otherBuyer, paymentObserved: () => true }],
    ['unknown job', { custodyBuyer: buyer.claim, buyerForJob: () => null }],
    ['unavailable lookup', { custodyBuyer: buyer.claim, buyerForJob: () => buyer.address, buyerLookupReady: () => false }],
  ]) for (const method of ['assertSellerWallet', 'sellerNotice']) {
    const access = createOperatorBuyerAccess(options);
    assert.throws(() => access[method](buyer.address, JOB), { code: 'buyer_access_closed' }, label);
  }
});

test('open access still requires a well-formed Demos wallet', () => {
  const open = createOperatorBuyerAccess({ openBuyerAccess: true });
  for (const wallet of ['garbage', '0x1234', null]) {
    assert.equal(open.allowsWallet(wallet), false);
    assert.throws(() => open.assertWallet(wallet), { code: 'buyer_access_closed' });
    assert.throws(() => open.assertRelayWallet(wallet), { code: 'buyer_access_closed' });
  }
  assert.equal(open.allowsWallet(seller.address), true);
});

// Open mode widens who may start a new purchase, but a seller operation on a
// named job is still that job's retained buyer's operation. No wallet, paid or
// not, may act for another buyer's job.
test('open access joins the retained buyer for job-specific seller operations', () => {
  for (const [label, options] of [
    ['another wallet', { openBuyerAccess: true, buyerForJob: () => buyer.address }],
    ['no retained buyer', { openBuyerAccess: true, buyerForJob: () => null }],
    ['lookup unavailable', { openBuyerAccess: true, buyerForJob: () => buyer.address, buyerLookupReady: () => false }],
  ]) for (const method of ['assertSellerWallet', 'sellerNotice']) {
    const access = createOperatorBuyerAccess(options);
    assert.throws(() => access[method](seller.address, JOB), { code: 'buyer_access_closed' }, label);
  }
  const open = createOperatorBuyerAccess({ openBuyerAccess: true, buyerForJob: () => buyer.address });
  assert.doesNotThrow(() => open.assertSellerWallet(buyer.address, JOB));
  assert.equal(open.sellerNotice(buyer.address, JOB), null);
});

test('open access requires the retained job lookup before admitting a seller job', () => {
  for (const [label, options] of [
    ['no retained buyer', { openBuyerAccess: true, buyerForJob: () => null }],
    ['lookup unavailable', { openBuyerAccess: true, buyerForJob: () => buyer.address, buyerLookupReady: () => false }],
  ]) assert.throws(() => createOperatorBuyerAccess(options).assertSellerJob(JOB), { code: 'buyer_access_closed' }, label);
  assert.doesNotThrow(() => createOperatorBuyerAccess({ openBuyerAccess: true, buyerForJob: () => buyer.address }).assertSellerJob(JOB));
});

test('a configured custody seller must be the seller claim so the relay exclusion stays armed', () => {
  for (const bad of [seller.address, 'malformed', 'did:demos:agent:' + 'A'.repeat(64)]) {
    assert.throws(() => createOperatorBuyerAccess({ openBuyerAccess: true, custodySeller: bad }), /custodySeller/);
  }
  assert.throws(() => createOperatorBuyerAccess({ custodyBuyer: buyer.claim, custodySeller: seller.claim }).assertRelayWallet(seller.address),
    { code: 'seller_wallet_in_process' });
});
