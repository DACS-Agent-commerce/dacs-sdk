import { isCanonicalJobId } from '@kynesyslabs/dacs';
import { OperationError } from './client-errors.mjs';
import { assertPurchaseRuntime, readAdmission } from './public-admission.mjs';
import { deepFreeze } from './util/deep-freeze.mjs';

const PURCHASE_EVIDENCE_LIMIT = 8;
const RESULT_KIND = 'unverified-wallet-result';
const RESULT_STATES = ['submitted', 'rejected', 'unknown'];
const REPORT_MEMBERS = 'deliveryId,hash,nonce,state';
const JOURNAL_MEMBERS = ['get', 'entries', 'withWalletLock', 'appendUnderLock'];
const HASH = /^[0-9a-f]{64}$/;
const STORAGE_PROGRAM_MARKER = 'storageProgram';
const CREATE_OPERATION = 'CREATE_STORAGE_PROGRAM';

const laneFor = (deliveryId) => `purchase-evidence/${deliveryId}`;
const keyFor = (deliveryId, seq) => `${laneFor(deliveryId)}/result/${seq}`;
const membersOf = ({ deliveryId, hash, nonce, state }) => ({ deliveryId, hash, nonce, state });

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

// True for a retained signed CREATE whose signed delivery fields name `deliveryId`. This is a structural selection of what the journal holds:
// it neither verifies the signature nor confirms anything on chain.
function isSignedCreateFor(value, deliveryId) {
  const { signature, content } = value?.signedTransaction ?? {};
  if (signature?.type !== 'ed25519' || typeof signature.data !== 'string' || signature.data === '') return false;
  if (content?.type !== 'storageProgram' || content.data?.[0] !== STORAGE_PROGRAM_MARKER) return false;
  const program = content.data[1];
  if (program?.operation !== CREATE_OPERATION) return false;
  const named = [program.data?.jobId, program.metadata?.artifactBinding?.jobId].filter((id) => id !== undefined);
  return named.length > 0 && named.every((id) => id === deliveryId);
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
 * - openRetainedCreateJournal({deliveryId}) resolves {deliveryId, records}, a frozen copy of the journal entries that are signed CREATEs naming
 *   `deliveryId`, in journal order, whatever their key. The caller authenticates the delivery first. It reads `entries` once and writes nothing.
 *   It throws TypeError(reader_input_invalid) for any input but an object whose only key is `deliveryId`, before any read, and
 *   TypeError(delivery_id_invalid) for a malformed ID.
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

  async function openRetainedCreateJournal(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join() !== 'deliveryId') throw new TypeError('reader_input_invalid');
    const { deliveryId } = input;
    assertDeliveryId(deliveryId);
    const records = (await journal.entries()).filter(([, value]) => isSignedCreateFor(value, deliveryId));
    return deepFreeze(structuredClone({ deliveryId, records }));
  }

  return Object.freeze({ recordWalletResult, resultHistory, openRetainedCreateJournal });
}
