// The seller receipt gate against the shipped seller: the standalone native seller host, started with explicit receipt fee
// ceilings, answers the ordinary commitment through its signed HTTP route; the buyer's own HTTPS seller client sends that
// request and keeps only the body the wire verified; the buyer's native composition, configured with the same ceilings,
// accepts the receipt the answer carries and refuses the same purchase without it. Nothing reaches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '@kynesyslabs/dacs';

// The seller host refuses to start while the kit's operation guard is off. This test-only loader hook admits it in this
// process, so it is registered before any seller module is loaded.
await import('../../dacs-seller/test/helpers/kit-guard-fixture.mjs');
const { nativePaymentWorld } = await import('../../dacs-seller/test/helpers/native-payment-wire-fixture.mjs');
const { RECEIPT_FEE_CEILINGS } = await import('../../dacs-seller/test/helpers/protocol-fixture.mjs');
const { wireAuthentication } = await import('../../dacs-seller/test/helpers/wire-buyer.mjs');
const { fetchAsHost } = await import('../../dacs-seller/test/helpers/listener-host.mjs');
const { sellerApi } = await import('../../dacs-seller/test/helpers/seller-internal-api.mjs');
const { createSellerHttpsClient } = await import('../src/dacs/seller-http.mjs');
const { fetchClient, NO_TRANSMIT_GUARDS } = await import('./helpers/seller-https-rig.mjs');
const { receiptWorld } = await import('./helpers/seller-receipt-reservation-world.mjs');
const { OperationError } = await import('../src/index.mjs');

const refused = (error) => error instanceof OperationError && error.code === 'seller_receipt_reservation_insufficient';

test('the shipped native seller host signs a commitment answer whose receipt the buyer reservation gate accepts', async (t) => {
  // The seller host completes proposal, Agreement and the first ordinary commitment through its signed routes.
  const seller = await nativePaymentWorld(t);
  const purchase = await seller.purchase();
  const agreementHash = contentHash(purchase.agreement);
  assert.equal(agreementHash, purchase.agreementHash);

  // The buyer's own HTTPS seller client sends the ordinary commitment to the host's signed route. It signs each request as
  // the buyer and returns only the body the wire verified over the exact bytes the host sent.
  const publicEndpoint = seller.listing.seller.publicEndpoint;
  const hostFetch = fetchAsHost({ authority: new URL(publicEndpoint).host });
  const signed = wireAuthentication({ buyer: seller.buyerKey, seller: seller.sellerKey, listingPin: sellerApi.listingPin(seller.listing), clock: seller.clock, publicEndpoint },
    () => agreementHash);
  const client = fetchClient(createSellerHttpsClient)({ url: publicEndpoint, fetchImpl: (url, init) => hostFetch(`${seller.host().url}${new URL(url).pathname}`, init), authentication: {
    request: async (...args) => ({ ...await signed.request(...args), transmitGuards: NO_TRANSMIT_GUARDS }),
    verifyResponse: (request, { header, status, body }) => signed.verifyResponse(request, { header, status, responseBytes: body }),
  } });
  const answer = await client.commit(purchase.jobId);
  assert.equal(answer.status, 'committed');
  const payFeeOs = BigInt(RECEIPT_FEE_CEILINGS.payFeeCeilingOs), anchorFeeOs = BigInt(RECEIPT_FEE_CEILINGS.anchorFeeCeilingOs), priceOs = BigInt(purchase.amountOs);
  assert.deepEqual(answer.sellerReceipt, { agreementHash, reservedMaximumOs: (priceOs + payFeeOs + anchorFeeOs).toString() });

  // The buyer's native composition with the same two ceilings, and its purchase at the Agreement's price, now holding that
  // Agreement and the receipt from the verified answer: the gate passes.
  const buyer = await receiptWorld(t, { priceOs, payFeeOs, anchorFeeOs });
  const row = buyer.get();
  assert.equal(row.terms.price.amountOs, purchase.amountOs);
  const withReceipt = { ...row.state.protocol, agreement: { artifact: purchase.agreement, hash: agreementHash }, sellerReceipt: answer.sellerReceipt };
  const operation = (protocol) => ({ ...row, state: { ...row.state, protocol } });
  assert.doesNotThrow(() => buyer.protocol.assertSellerReceiptReservation(operation(withReceipt)));

  // The same answer with its receipt removed fails closed.
  const withoutReceipt = { ...withReceipt };
  delete withoutReceipt.sellerReceipt;
  assert.throws(() => buyer.protocol.assertSellerReceiptReservation(operation(withoutReceipt)), refused);
});
