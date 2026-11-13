// A committed TP-1 purchase from the SDK's own primitives: a seller-signed
// Listing, an Agreement both parties signed, and a seller-signed finality
// commitment with a finalized receipt. No network and no wall clock.
import { contentHash, deriveFixedPriceAgreement, signFixedPriceAgreement } from '@kynesyslabs/dacs';
import { anchoredTupleMembers } from '../../src/dacs/continuation-evidence.mjs';
import { T0, party } from './wire-client-fixture.mjs';

const RAIL = { railId: 'demos-native:DEM', railVersion: 1 };
const identity = (claim, presentedAt) => ({
  bundleVersion: '1', presentedBy: claim, presentedAt, claims: [{ ref: claim }],
  presentation: { kind: 'per-claim', signatures: [{ ref: claim, signature: 'identity-proof' }] },
});
const reference = (locator, digit) => ({ anchor: { kind: 'storage-program', locator }, contentHash: digit.repeat(64) });
const signed = (signer, domain, value) => signer.sign(Buffer.from(`${domain}${contentHash(value)}`, 'utf8')).toString('base64url');

/**
 * Returns the Listing, its pin, the two-party Agreement, the commitment's
 * anchored tuple and the verified summary a purchase row keeps, for `jobId`.
 * The buyer and seller are the fixture's parties 1 and 2.
 */
export async function committedPurchase({ jobId, publicEndpoint, listingId = 'committed-listing', validity = { notBefore: T0 - 3600000, notAfter: T0 + 3600000 }, generatedAt = T0 - 5000, committedAt = T0 - 1000 }) {
  const buyer = party(1), seller = party(2);
  const unsigned = {
    dacsVersion: '1', listingVersion: 1, listingId,
    seller: { identity: identity(seller.claim, validity.notBefore), displayName: 'Report', publicEndpoint },
    offering: { title: 'Report', description: 'A fixed-text report', category: 'data.test', tags: ['report'], deliverable: { kind: 'storage-program' } },
    buyerRequirement: { requirementVersion: '1', required: [] },
    pipeline: [{ kind: 'negotiate-fixed-price' }, { kind: 'commit-payee-bound-agreement' }, { kind: 'pay-dem', parameters: { rail: RAIL.railId } }, { kind: 'deliver-storage-program' }],
    pricing: { kind: 'fixed', price: { amount: '1', currency: 'DEM' } }, acceptedRails: [RAIL], terms: { deadlineSecAfterCommit: 600 }, validity,
  };
  const listing = { ...unsigned, signature: { algorithm: 'ed25519', signer: seller.claim, value: signed(seller, 'dacs-listing:v1:', unsigned) } };
  const pin = { listingId, version: 1, contentHash: contentHash(unsigned) };
  const draft = deriveFixedPriceAgreement({ jobId, verifiedListing: { disposition: 'verified', listing, pin },
    buyer: { identityBundle: identity(buyer.claim, validity.notBefore), vetRecordRef: reference('buyer-vet', 'a') },
    seller: { identityBundle: identity(seller.claim, validity.notBefore), vetRecordRef: reference('seller-vet', 'b') },
    selectedRail: RAIL, payoutBindings: [{ railId: RAIL.railId, phaseIndex: 2, payeeAddress: seller.raw }], generatedAt });
  const agreement = await signFixedPriceAgreement(draft, { party: buyer.claim, algorithm: 'ed25519', sign: (input) => buyer.sign(input) }, { party: seller.claim, algorithm: 'ed25519', sign: (input) => seller.sign(input) });
  const agreementHash = contentHash(agreement);
  const unsignedRecord = { finalityCommitmentVersion: '1', jobId, agreementHash, listingRef: pin, parties: [buyer.claim, seller.claim], pattern: 'fixed-price', createdAt: committedAt - 1000 };
  const record = { ...unsignedRecord, signature: { algorithm: 'ed25519', signer: seller.claim, value: signed(seller, 'dacs-finality-commitment:v1:', unsignedRecord) } };
  const logicalAddress = `dacs3:commit:${jobId}`;
  const anchored = {
    record, nativeAddress: 'stor-commitment', anchorTxRef: { kind: 'storage-program', address: 'stor-commitment', writeTxHash: 'c'.repeat(64) },
    anchorReceipt: { receiptVersion: '1', substrate: 'demos', finalityProfile: 'demos-bft-final', logicalAddress, nativeAddress: 'stor-commitment', contentHash: contentHash(record),
      transactionRef: { kind: 'demos', value: 'commitment-write-tx' }, writer: 'demos-writer', nonce: '1', state: 'finalized', observationDisposition: 'established',
      observedAt: committedAt + 1000, blockRef: { id: 'block-1', height: '1', timestamp: committedAt }, evidence: { kind: 'demos-finality-proof', value: 'proof-1' } },
  };
  const summary = { address: 'stor-commitment', ref: { anchor: { kind: 'storage-program', locator: 'stor-commitment' }, contentHash: contentHash(record), signer: seller.claim },
    contentHash: contentHash(record), signer: seller.claim, committedAt, verifiedAt: new Date(T0).toISOString(), substrate: 'source-native-one-node' };
  return { listing, pin, agreement, agreementHash, anchored, summary, summaryWithBytes: { ...summary, ...anchoredTupleMembers(anchored) } };
}
