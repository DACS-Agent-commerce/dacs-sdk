// The seller wallet's journal for the Deliverable CREATE (DACS-4 PC-7(b),
// write-once): the payment-evidence journal's rules (payment-evidence-wallet-journal.mjs
// describes them) for the paid order's Deliverable. The exact signed CREATE is
// kept durably, with its nonce, before it is broadcast; an address has at most
// one live signed CREATE; the kept bytes are broadcast again while they can
// still be executed and are superseded only once they provably cannot, and only
// then is the address signed anew. A name-index miss is none of that proof.
//
// createDeliverableWalletJournal({ path, signCreate, broadcast, readAccountNonce,
//   readTransactionState, now, readTimeoutMs }) takes the wallet primitives of
// the payment-evidence journal, and signCreate is asked for the Deliverable's
// storage CREATE: { logicalAddress, artifact (the report), writer, artifactKind:
// 'Deliverable', jobId, receiptContentHash, deliveryBinding }. The CREATE it
// answers is checked as that journal checks one, and its metadata must carry
// exactly that deliveryBinding.
// Returns { submit, reconcile, readSignedProjection, journalId, close }:
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
// deliveryBinding }, where receiptContentHash is the SHA-256 of the canonical
// report; anything else is refused (TypeError) before the wallet is asked.
// startSellerHost and createSellerAgent take the pair only from one journal
// (isDeliverableWalletJournalPair) with the capability whose submit it is.
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { nativeDemDeliverySubmitOf } from './native-dem-delivery-consumer.mjs';
import { createSignedCreateJournal } from './payment-evidence-wallet-journal.mjs';

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

// The input of the shared journal for this Deliverable, or a TypeError.
function createInput({ logicalAddress, report, writer, jobId, receiptContentHash, deliveryBinding } = {}) {
  if (!object(report) || !object(deliveryBinding) || typeof writer !== 'string' || typeof jobId !== 'string' || receiptContentHash !== sha256Hex(canonicalize(report))) {
    throw new TypeError('the Deliverable journal needs the report, its writer, job, delivery binding and the report\'s canonical SHA-256 as receiptContentHash');
  }
  return { logicalAddress, artifact: report, writer, artifactKind: DELIVERABLE_KIND, jobId, receiptContentHash, deliveryBinding };
}

/** Opens the seller's Deliverable journal (see above). Throws TypeError for an unusable option, path or file. */
export function createDeliverableWalletJournal(options) {
  const core = createSignedCreateJournal({ ...options, table: DELIVERABLE_TABLE });
  const submit = async (input) => ({ status: 'accepted', reconciliationId: (await core.anchor(createInput(input))).txHash });
  const reconcile = async (input) => core.reconcile(createInput(input));
  const journal = Object.freeze({ submit, reconcile, readSignedProjection: core.readSignedProjection, journalId: core.journalId, close: core.close });
  journals.set(submit, journal);
  journals.set(reconcile, journal);
  return journal;
}
