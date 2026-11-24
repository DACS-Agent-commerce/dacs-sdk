import { isCanonicalJobId } from '@kynesyslabs/dacs';
import { OperationError } from './client-errors.mjs';
import { assertPurchaseRuntime, readAdmission } from './public-admission.mjs';

const PURCHASE_EVIDENCE_LIMIT = 8;
const RESULT_KIND = 'unverified-wallet-result';
const RESULT_STATES = ['submitted', 'rejected', 'unknown'];
const REPORT_MEMBERS = 'deliveryId,hash,nonce,state';
const JOURNAL_MEMBERS = ['get', 'entries', 'withWalletLock', 'appendUnderLock'];
const HASH = /^[0-9a-f]{64}$/;

const laneFor = (deliveryId) => `purchase-evidence/${deliveryId}`;
const keyFor = (deliveryId, seq) => `${laneFor(deliveryId)}/result/${seq}`;
const membersOf = ({ deliveryId, hash, nonce, state }) => ({ deliveryId, hash, nonce, state });

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function isReport(report) {
  return report !== null && typeof report === 'object' && !Array.isArray(report) && Object.keys(report).sort().join() === REPORT_MEMBERS
    && isCanonicalJobId(report.deliveryId) && typeof report.hash === 'string' && HASH.test(report.hash)
    && Number.isSafeInteger(report.nonce) && report.nonce >= 0 && RESULT_STATES.includes(report.state);
}

function assertDeliveryId(deliveryId) {
  if (!isCanonicalJobId(deliveryId)) throw new TypeError('delivery_id_invalid');
}

// The stored report at result number `seq`, or a refusal: a record that is not exactly what this recorder writes is never counted or returned.
function storedReport(value, deliveryId, seq) {
  const { kind, seq: storedSeq, ...report } = value ?? {};
  if (kind !== RESULT_KIND || storedSeq !== seq || report.deliveryId !== deliveryId || !isReport(report)) {
    throw new OperationError('evidence_record_invalid', `the stored result record ${seq} is not a well-formed unverified report`);
  }
  return report;
}

async function readReports(journal, deliveryId) {
  const reports = [];
  for (let seq = 1; seq <= PURCHASE_EVIDENCE_LIMIT; seq += 1) {
    const value = await journal.get(keyFor(deliveryId, seq));
    if (value === undefined) break;
    reports.push(storedReport(value, deliveryId, seq));
  }
  return reports;
}

function namesDelivery(value, deliveryId) {
  const content = value?.signedTransaction?.content?.data?.[1];
  return content?.data?.jobId === deliveryId || content?.metadata?.artifactBinding?.jobId === deliveryId;
}

/**
 * createPurchaseEvidenceRecorder({admission, journal}) returns a frozen recorder over the caller's open durable wallet journal.
 * Construction applies the admission shape check and the Node floor, then checks that `journal` has get, entries, withWalletLock and appendUnderLock.
 * Throws TypeError(admission_required | admission_input_untrusted | journal_required) and OperationError(runtime_unsupported) before the journal is used.
 * No call consults the binding check, the hold or the stop check, so every member works while held, stopped and with a failing binding.
 * - recordWalletResult({deliveryId, hash, nonce, state}) appends one unverified wallet report under the delivery's lane lock and resolves
 *   {status: 'recorded' | 'repeat' | 'evidence_limit', count} or {status: 'invalid_report'}. At most eight distinct reports are kept per delivery;
 *   an identical repeat uses no slot. Journal errors pass through unchanged; OperationError(evidence_record_invalid) refuses a malformed stored report.
 * - resultHistory(deliveryId) resolves the frozen reports in acceptance order, each with `verified: false`. It throws TypeError(delivery_id_invalid).
 * - openRetainedCreateJournal({deliveryId, laneKey}) resolves a frozen copy of the journal records under `laneKey` and the retained CREATEs that
 *   name `deliveryId`. It reads with get and entries only. It throws TypeError(delivery_id_invalid | lane_key_invalid).
 * A report is a pointer the wallet gave, never proof that anything settled. The recorder signs, sends and continues nothing.
 */
export function createPurchaseEvidenceRecorder(options) {
  readAdmission(options);
  assertPurchaseRuntime(process.version);
  const { journal } = options;
  if (!JOURNAL_MEMBERS.every((name) => typeof journal?.[name] === 'function')) throw new TypeError('journal_required');

  async function recordWalletResult(report) {
    if (!isReport(report)) return { status: 'invalid_report' };
    const { deliveryId } = report;
    const lane = laneFor(deliveryId);
    return journal.withWalletLock(lane, async () => {
      const reports = await readReports(journal, deliveryId);
      const wanted = JSON.stringify(membersOf(report));
      if (reports.some((seen) => JSON.stringify(membersOf(seen)) === wanted)) return { status: 'repeat', count: reports.length };
      if (reports.length >= PURCHASE_EVIDENCE_LIMIT) return { status: 'evidence_limit', count: reports.length };
      const seq = reports.length + 1;
      await journal.appendUnderLock(lane, keyFor(deliveryId, seq), { kind: RESULT_KIND, ...membersOf(report), seq });
      return { status: 'recorded', count: seq };
    });
  }

  async function resultHistory(deliveryId) {
    assertDeliveryId(deliveryId);
    const reports = await readReports(journal, deliveryId);
    return deepFreeze(reports.map((report, index) => ({ ...report, seq: index + 1, verified: false })));
  }

  async function openRetainedCreateJournal({ deliveryId, laneKey }) {
    assertDeliveryId(deliveryId);
    if (typeof laneKey !== 'string' || laneKey === '') throw new TypeError('lane_key_invalid');
    const records = (await journal.entries()).filter(([key, value]) => key === laneKey || key.startsWith(`${laneKey}/`) || namesDelivery(value, deliveryId));
    return deepFreeze(structuredClone({ deliveryId, laneKey, records }));
  }

  return Object.freeze({ recordWalletResult, resultHistory, openRetainedCreateJournal });
}
