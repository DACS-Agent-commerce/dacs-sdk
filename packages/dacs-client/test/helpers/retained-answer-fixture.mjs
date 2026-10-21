// Protocol fields of a verified final delegated purchase whose retained seller
// answer is bound the way retirement requires: the signed payment CREATE
// projection is signed by the seller wallet and is the one the verified
// payment-evidence receipt names, and the Agreement hashes to its canonical
// reference and carries the purchase's own terms (boundTerms). Test-only
// bytes; no chain is read or written.
// signer/from make a projection the receipt names but the seller never authorized.
import { baseUnits, canonicalize, contentHash, demosSignedTransactionProofHash, fixedPriceAgreementLogicalAddress, logicalToStorageProgramName, paymentEvidenceAddress, sha256Hex } from '@kynesyslabs/dacs';
import { DEM_DECIMALS, DEM_RAIL } from '../../src/dacs/listing.mjs';

export const FIXTURE_LISTING = Object.freeze({ listingId: 'listing', version: 1, contentHash: 'a'.repeat(64) });
// The operation terms the fixture Agreement binds (merge into operation.terms).
export const boundTerms = ({ seller, amount = '1' }) => ({ seller: { claim: seller.claim, payee: seller.address }, rail: DEM_RAIL.railId,
  price: { amount, currency: 'DEM', amountOs: baseUnits(amount, DEM_DECIMALS) } });

export function retainedAnswerFixture({ buyer, seller, jobId, stage = 'delivery-ready', id = 'TEST', time = Date.parse('2026-10-08T09:00:00.000Z'), deliveryReceipt, signer = seller, from = seller.address, listing = FIXTURE_LISTING }) {
  const phaseIndex = 2, address = paymentEvidenceAddress(jobId, DEM_RAIL.railId, phaseIndex), programName = logicalToStorageProgramName(address);
  const nativeAddress = `0x${'4'.repeat(64)}`, evidenceContentHash = 'c'.repeat(64);
  const artifact = { jobId, listingRef: { ...listing }, parties: [{ role: 'buyer', primaryClaim: buyer.claim }, { role: 'seller', primaryClaim: seller.claim }],
    terms: { payoutBindings: [{ payeeAddress: seller.address, phaseIndex, railId: DEM_RAIL.railId }], price: { amount: '1', currency: 'DEM' }, deadline: time + 3600000 } };
  const agreementHash = contentHash(artifact);
  const content = { type: 'storageProgram', from, to: nativeAddress, nonce: 1, timestamp: time,
    data: ['storageProgram', { operation: 'CREATE_STORAGE_PROGRAM', programName, storageAddress: nativeAddress, salt: '', encoding: 'json', data: { TEST: 'payment evidence' },
      metadata: { logicalAddress: address, contentHash: evidenceContentHash } }] };
  const hash = sha256Hex(JSON.stringify(content));
  const signedProjection = { hash, content, signature: { type: 'ed25519', data: signer.signHex(hash) } };
  const proof = { proofVersion: '1', chainIdentity: 'TEST-chain', writer: seller.address, operation: 'create', signedTransactionHash: demosSignedTransactionProofHash(signedProjection),
    finalityProofHash: '1'.repeat(64), nativeRead: { programName, valueHash: '2'.repeat(64), observedAt: time } };
  const paymentReceipt = { receiptVersion: '1', substrate: 'demos', finalityProfile: 'demos-bft-confirmed-native-read', logicalAddress: address, nativeAddress,
    contentHash: evidenceContentHash, transactionRef: { kind: 'demos-storage-program', value: hash }, writer: seller.claim, nonce: '1', state: 'finalized',
    observationDisposition: 'established', observedAt: time, blockRef: { id: '3'.repeat(64), height: '1', timestamp: time },
    evidence: { kind: 'demos-bft-write-proof-v1', value: Buffer.from(canonicalize(proof), 'utf8').toString('base64url') } };
  const locator = `dacs4:deliverable:${jobId}`, payload = 'f'.repeat(64), receipt = deliveryReceipt ?? { logicalAddress: locator, contentHash: payload, TEST: 'receipt' };
  const delivery = { status: stage, fulfilmentId: `TEST-fulfilment-${id}`, deliverableRef: { anchor: { kind: 'storage-program', locator }, contentHash: payload }, anchorReceipt: receipt,
    payloadHash: payload, evidenceHash: 'e'.repeat(64), report: { jobId, settlementId: `TEST-settlement-${id}` } };
  return {
    agreement: { artifact, hash: agreementHash, ref: { anchor: { kind: 'storage-program', locator: fixedPriceAgreementLogicalAddress(jobId) }, contentHash: agreementHash } },
    paymentEvidence: { ref: { anchor: { kind: 'storage-program', locator: address }, contentHash: evidenceContentHash }, anchorReceipt: paymentReceipt, txHash: '9'.repeat(64), blockNumber: 1 },
    delivery,
    sellerAnswer: { status: 'payment-evidenced', settlementId: delivery.report.settlementId, evidenceAddress: address, evidenceHash: evidenceContentHash, signedProjection,
      delivery: { status: stage, fulfilmentId: delivery.fulfilmentId, logicalAddress: locator, contentHash: payload, evidenceHash: delivery.evidenceHash, anchorReceipt: receipt } },
  };
}
