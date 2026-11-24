import { cutText } from '../util/text.mjs';

/** Seller codes that end a bootstrap and require an explicit new purchase. */
export const FAILED_BOOTSTRAP_CODES = Object.freeze(['context_challenge_failed', 'context_challenge_consumed', 'context_challenge_expired', 'context_challenge_mismatch', 'context_job_closed', 'context_admission_closed']);
/** The seller's Vet refusal and the error classes that make it definite. */
export const VET_NON_PASS = Object.freeze({ code: 'party_vet_non_pass', errorClasses: Object.freeze(['counterparty', 'permanent']) });

/** Returns the allowlisted refusal members a context answer may retain; malformed Vet refusals retain none. */
export function heldContextMembers(answer) {
  const { code, errorClass, status, cause } = answer;
  if (code === VET_NON_PASS.code) return Object.keys(answer).sort().join() === 'code,disposition,errorClass,reason'
    && answer.disposition === 'rejected' && typeof answer.reason === 'string' && VET_NON_PASS.errorClasses.includes(errorClass) ? { code, errorClass } : {};
  if (!FAILED_BOOTSTRAP_CODES.includes(code) && !(status >= 400 && status < 500)) return {};
  return { ...(typeof code === 'string' ? { code } : {}), ...(Number.isInteger(status) ? { status } : {}), ...(typeof cause === 'string' ? { cause: cutText(cause, 240) } : {}) };
}

/** Classifies a captured context answer without changing it or starting any work. */
export function bootstrapOutcomeOf(resolved) {
  const members = heldContextMembers(resolved), { code, status, errorClass } = members;
  const kind = resolved.disposition !== 'rejected' ? 'held' : errorClass ? 'vet-non-pass'
    : FAILED_BOOTSTRAP_CODES.includes(code) || status === 429 ? 'failed-bootstrap' : status >= 400 && status < 500 ? 'definite-refusal' : 'held';
  return { kind, ...members, ...(status === 429 && !code ? { code: 'seller_rate_limited' } : {}), reason: resolved.reason };
}

/** Converts a classified seller refusal to a rejected context answer, or returns null for an unknown outcome. */
export function refusalAnswer(error) {
  return ['definite', 'failed-bootstrap'].includes(error?.answerClass) ? { disposition: 'rejected', reason: `${error.code}: ${error.message}`, code: error.code, status: error.status,
    ...(typeof error.cause === 'string' ? { cause: cutText(error.cause, 240) } : {}) } : null;
}

/** Returns the terminal protocol patch for a definite bootstrap end, or null when the outcome must stay pending. */
export function bootstrapEndPatch({ kind, code, errorClass, cause, status, reason, local }) {
  if (kind === 'vet-non-pass') return { stage: 'agreement-rejected', bootstrapEnd: { kind, code, errorClass, reason } };
  return kind === 'failed-bootstrap' ? { stage: 'bootstrap-failed', bootstrapEnd: { kind, code,
    ...(status === undefined ? {} : { status }), ...(cause === undefined ? {} : { cause }), ...(local ? { local: true } : {}) } } : null;
}
