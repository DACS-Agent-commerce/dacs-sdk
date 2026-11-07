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
// Returns { submitAuthorized, resume, readSignedProjection, journalId, close }.
// Both wallet operations take (input, authorize) and are guarded: input names
// the journal the seller recorded for the order before anything could be signed
// (expectedJournalId; another is wallet_journal_changed), and authorize() must
// answer true, synchronously, under the journal's lease and again right before
// each signature and each broadcast (else wallet_not_authorized: nothing more
// is signed or sent, and a kept CREATE stays kept). There is no unguarded one.
//  - submitAuthorized is both the `submitAuthorized` and the `submit` of
//    createNativeDemDeliveryCapability: it signs once, keeps and broadcasts, or
//    broadcasts the kept CREATE again, and answers { status: 'accepted',
//    reconciliationId: txHash }. It throws when the wallet fails (the kept
//    CREATE stays live for resume);
//  - resume is the host's resumeDeliverableCreate and never signs: { status:
//    'unsigned' } when no signed CREATE can still land (the only answer that
//    lets submitAuthorized sign anew), otherwise { status: 'rebroadcast' |
//    'pending' | 'applied', txHash } for the one kept CREATE, broadcast again
//    unchanged unless it is applied;
//  - readSignedProjection({ logicalAddress }) is the kept CREATE's public projection.
// input is { logicalAddress, report, writer, jobId, receiptContentHash,
// deliveryBinding, expectedJournalId }, where writer names an account, receiptContentHash is the
// SHA-256 of the canonical report, the report, the binding and logicalAddress
// (the Deliverable address) must all name jobId, and the binding (version 1,
// with its fulfilmentId) commits to the report as its payloadHash; anything else
// is refused (TypeError) before the wallet is asked.
import { canonicalize, isCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { addressForClaim } from './demos-claims.mjs';
import { nativeDemDeliverySubmitsOf } from './native-dem-delivery-consumer.mjs';
import { createSignedCreateJournal } from './payment-evidence-wallet-journal.mjs';
import { deliverableAddress } from './purchase-protocol.mjs';

const DELIVERABLE_TABLE = 'deliverable_creates';
const DELIVERABLE_KIND = 'Deliverable';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Each journal's own submitAuthorized and resume, mapped to it.
const journals = new WeakMap();

/**
 * The journal a seller takes its Deliverable recovery from: null when there is
 * no `resume` and the delivery capability is no journal's, otherwise the
 * journal whose submitAuthorized is both the capability's submitAuthorized and
 * its submit, and whose `resume` this is. Throws TypeError for any other pair:
 * an unguarded capability, a wrapper, two journals, a scripted resume, an
 * evidence journal, or a journal's capability without its resume.
 */
export function deliverableJournalFor(nativeDemDelivery, resume) {
  const submits = nativeDemDeliverySubmitsOf(nativeDemDelivery) ?? {};
  const journal = journals.get(submits.submitAuthorized) ?? journals.get(submits.submit);
  if (resume === null && journal === undefined) return null;
  if (journal?.resume !== resume || submits.submitAuthorized !== journal.submitAuthorized || submits.submit !== journal.submitAuthorized) {
    throw new TypeError('resumeDeliverableCreate must be the resume of the createDeliverableWalletJournal whose submitAuthorized is the nativeDemDelivery capability\'s submitAuthorized and submit, or null');
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
  const guarded = (input, authorize, resume) => core.guardedCreate({ ...createInput(input), expectedJournalId: input.expectedJournalId, authorize }, { resume });
  const submitAuthorized = async (input, authorize) => ({ status: 'accepted', reconciliationId: (await guarded(input, authorize, false)).txHash });
  const resume = async (input, authorize) => guarded(input, authorize, true);
  const journal = Object.freeze({ submitAuthorized, resume, readSignedProjection: core.readSignedProjection, journalId: core.journalId, close: core.close });
  journals.set(submitAuthorized, journal);
  journals.set(resume, journal);
  return journal;
}
