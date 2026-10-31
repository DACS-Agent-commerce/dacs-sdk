// The seller wallet's journal for the Deliverable CREATE: the retry rule the
// payment-evidence journal applies (DACS-4 PC-7(b), described in
// payment-evidence-wallet-journal.mjs), applied to the paid order's Deliverable.
// A name-index or native-address miss is no proof of absence (CORE §5.1). The
// exact signed CREATE is kept durably, with its nonce, before it is broadcast;
// an address has at most one live signed CREATE; the kept bytes are broadcast
// again while they can still be executed and are superseded only once they
// provably cannot, and only then is the address signed anew.
//
// createDeliverableWalletJournal({ path, signCreate, broadcast, readAccountNonce,
//   readTransactionState, now, readTimeoutMs }) takes the wallet primitives of
// the payment-evidence journal, and signCreate is asked for the Deliverable's
// storage CREATE: { logicalAddress, artifact (the report), writer, artifactKind:
// 'Deliverable', jobId, receiptContentHash, deliveryBinding }. The CREATE it
// answers is checked as that journal checks one, and its metadata must carry
// exactly that deliveryBinding.
// Returns { submit, reconcile, readSignedProjection, journalId, close }:
// submit and reconcile accept an optional authorization callback as their second
// argument; it is checked after wallet reads before signing or broadcasting.
//  - submit(input) is the `submit` of createNativeDemDeliveryCapability: it signs
//    once, keeps and broadcasts, or broadcasts the kept CREATE again, and answers
//    { status: 'accepted', reconciliationId: txHash }. It throws when the wallet
//    fails (the kept CREATE stays live for reconcile);
//  - reconcile(input) is the host's reconcileDeliverableCreate: { status:
//    'unsigned' } when no signed CREATE can still land (the only answer that
//    lets submit sign anew), otherwise { status: 'rebroadcast' | 'pending' |
//    'applied', txHash } for the one kept CREATE, broadcast again unchanged
//    unless it is applied;
//  - readSignedProjection({ logicalAddress }) is the kept CREATE's public projection.
// input is { logicalAddress, report, writer, jobId, receiptContentHash,
// deliveryBinding }, where writer names an account, receiptContentHash is the
// SHA-256 of the canonical report, the report, the binding and logicalAddress
// (the Deliverable address) must all name jobId, and the binding (version 1,
// with its fulfilmentId) commits to the report as its payloadHash; anything else
// is refused (TypeError) before the wallet is asked.
// startSellerHost and createSellerAgent take the pair only from one journal
// (deliverableJournalFor) with the capability whose submit it is.
import { canonicalize, isCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { addressForClaim } from './demos-claims.mjs';
import { nativeDemDeliverySubmitOf } from './native-dem-delivery-consumer.mjs';
import { createSignedCreateJournal } from './payment-evidence-wallet-journal.mjs';
import { deliverableAddress } from './purchase-protocol.mjs';

const DELIVERABLE_TABLE = 'deliverable_creates';
const DELIVERABLE_KIND = 'Deliverable';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Each journal's own submit and reconcile, mapped to it.
const journals = new WeakMap();

/**
 * The journal a seller takes its Deliverable question from: null when there is
 * no `reconcile`, otherwise the journal whose `submit` is the delivery
 * capability's and whose `reconcile` this is. Throws TypeError for any other
 * pair: a wrapper, two journals, a scripted question or an evidence journal.
 */
export function deliverableJournalFor(nativeDemDelivery, reconcile) {
  if (reconcile === null) return null;
  const submit = nativeDemDeliverySubmitOf(nativeDemDelivery), journal = typeof submit === 'function' ? journals.get(submit) : undefined;
  if (journal === undefined || journal.submit !== submit || journal.reconcile !== reconcile) {
    throw new TypeError('reconcileDeliverableCreate must be the reconcile of the createDeliverableWalletJournal whose submit is the nativeDemDelivery capability\'s submit, or null');
  }
  return journal;
}

// The canonical JSON serialisation of a plain JSON record, or null: a Date, a
// class instance or a nested non-JSON value has no canonical form to keep or
// compare, so it is refused before the wallet is asked.
function canonicalRecord(value) {
  if (!object(value)) return null;
  try { return canonicalize(value); } catch { return null; }
}
// True when the claim names a writer account: the shared journal derives the
// signer's address from it only after signCreate, so it is checked first.
function writerHasAddress(writer) {
  if (typeof writer !== 'string' || writer.length === 0) return false;
  try { addressForClaim(writer); return true; } catch { return false; }
}
// The input of the shared journal for this Deliverable, or a TypeError. The job
// id is checked as CORE §B.1 names it before the wallet is asked, and the
// report, the delivery binding and the Deliverable address must all name that
// same job, so no protocol effect is ever derived from an alternate spelling.
function createInput({ logicalAddress, report, writer, jobId, receiptContentHash, deliveryBinding } = {}) {
  const canonicalReport = canonicalRecord(report), canonicalBinding = canonicalRecord(deliveryBinding);
  if (canonicalReport === null || canonicalBinding === null || !writerHasAddress(writer) || !isCanonicalJobId(jobId)
      || receiptContentHash !== sha256Hex(canonicalReport)) {
    throw new TypeError('the Deliverable journal needs the report, a writer that names an account, a canonical job id, a canonical delivery binding and the report\'s canonical SHA-256 as receiptContentHash');
  }
  if (deliveryBinding.version !== '1' || typeof deliveryBinding.fulfilmentId !== 'string' || deliveryBinding.fulfilmentId.length === 0 || deliveryBinding.payloadHash !== receiptContentHash) {
    throw new TypeError('the Deliverable journal needs a delivery binding of version 1 that names its fulfilment and commits to the report\'s canonical SHA-256 as payloadHash');
  }
  if (report.jobId !== jobId || deliveryBinding.jobId !== jobId || logicalAddress !== deliverableAddress(jobId)) {
    throw new TypeError('the Deliverable journal is asked about another job: the report, the delivery binding and the Deliverable address must name the same canonical job id');
  }
  return { logicalAddress, artifact: report, writer, artifactKind: DELIVERABLE_KIND, jobId, receiptContentHash, deliveryBinding };
}

/** Opens the seller's Deliverable journal (see above). Throws TypeError for an unusable option, path or file. */
export function createDeliverableWalletJournal(options) {
  const core = createSignedCreateJournal({ ...options, table: DELIVERABLE_TABLE });
  const submit = async (input, authorize) => ({ status: 'accepted', reconciliationId: (await core.anchor(createInput(input), authorize)).txHash });
  const reconcile = async (input, authorize) => core.reconcile(createInput(input), authorize);
  const journal = Object.freeze({ submit, reconcile, readSignedProjection: core.readSignedProjection, journalId: core.journalId, close: core.close });
  journals.set(submit, journal);
  journals.set(reconcile, journal);
  return journal;
}
