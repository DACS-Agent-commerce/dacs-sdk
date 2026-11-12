// The class of a seller answer, from the answer and the request's own
// context. Pure: it reads no clock, file or network.
//
// The answer record is made by the transport, never by the wire or the seller:
// {status, signed: true, body} exists only after the wire verified the exact
// received bytes. Anything else (no record, signed not true, a malformed
// record) is unknown. Each status, code, route and provenance cell has exactly
// one class; an unlisted signed 5xx, 408 or 429 is unknown, any other unlisted
// signed 4xx with an error is a definite refusal.
import { DACS_SELLER_HTTP_PATHS as PATHS } from '@kynesyslabs/dacs/wire';

/** The classes of a seller answer: a frozen map of constant name to class string. */
export const SELLER_ANSWER_CLASS = Object.freeze({
  RESULT: 'result',
  PROGRESS: 'progress',
  UNKNOWN: 'unknown',
  SUSPENDED: 'suspended',
  HELD: 'held',
  NOT_STARTED: 'not-started',
  NOT_SENT: 'not-sent',
  DEFINITE: 'definite',
  READBACK_ONLY: 'readback-only',
  FAILED_BOOTSTRAP: 'failed-bootstrap',
});
const { RESULT, PROGRESS, UNKNOWN, SUSPENDED, HELD, NOT_STARTED, NOT_SENT, DEFINITE, READBACK_ONLY, FAILED_BOOTSTRAP } = SELLER_ANSWER_CLASS;

/** The seller's code for work that only its operator can resolve. */
export const SELLER_EFFECT_UNRESOLVED = 'seller_effect_unresolved';
const SELLER_NOT_READY = 'seller_not_ready';
const BUNDLE_PATHS = new Set([PATHS.bundleRequest, PATHS.bundleCountersignature]);
// A 200 on these routes can be a nonterminal answer; other routes' 200 is a result.
const PROGRESS_PATHS = new Set([PATHS.payments, PATHS.proposals]);
const NONTERMINAL_VALUES = new Set(['held', 'indeterminate', 'waiting']);
const DELIVERY_FINAL_VALUES = new Set(['delivered', 'delivery-ready']);
const BOOTSTRAP_CODES = ['context_challenge_failed', 'context_challenge_consumed', 'context_challenge_expired', 'context_challenge_mismatch', 'context_job_closed', 'context_admission_closed'];

// Rows keyed by "status code" for every route.
const ROWS = new Map([
  ['409 peer_request_replayed', UNKNOWN],
  ['503 seller_effect_pending', UNKNOWN],
  ['503 context_attempt_pending', UNKNOWN],
  ['408 peer_expired', UNKNOWN],
  ['503 seller_stopped', SUSPENDED],
  [`500 ${SELLER_EFFECT_UNRESOLVED}`, HELD],
  ['408 peer_delegation_expired', READBACK_ONLY],
  ['409 peer_operation_mismatch', DEFINITE],
  ...BOOTSTRAP_CODES.map((code) => [`409 ${code}`, FAILED_BOOTSTRAP]),
]);
// Rows that hold only on the bundle routes.
const BUNDLE_ROWS = new Map([['503 bundle_finalization_unavailable', HELD], ['422 not_delivered', HELD]]);
// A 429 is a failed bootstrap on the context step and a definite refusal on challenge issuance.
const RATE_LIMIT_ROWS = new Map([[PATHS.context, FAILED_BOOTSTRAP], [PATHS.contextChallenge, DEFINITE]]);
// A timeout or rate limit says nothing about the request's own merit and clears on its own: unlisted, it is unknown, never a refusal.
const RETRYABLE_4XX = new Set([408, 429]);

const answer = (answerClass, code) => ({ answerClass, code });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonterminalPayment = (body) => body.status === 'payment-evidenced'
  && (!DELIVERY_FINAL_VALUES.has(body.delivery?.status) || body.delivery?.evidencePublication === 'held-readback-only');

function classifySigned(status, body, { path, continuation, newPurchase }) {
  const code = typeof body.error === 'string' ? body.error : undefined;
  if (status === 200) {
    const nonterminal = NONTERMINAL_VALUES.has(body.status) || NONTERMINAL_VALUES.has(body.disposition) || isNonterminalPayment(body);
    return answer(PROGRESS_PATHS.has(path) && nonterminal ? PROGRESS : RESULT);
  }
  if (status === 429 && RATE_LIMIT_ROWS.has(path)) return answer(RATE_LIMIT_ROWS.get(path), code);
  if (status === 503 && code === SELLER_NOT_READY) return answer(newPurchase && !continuation ? NOT_STARTED : UNKNOWN, code);
  const key = `${status} ${code}`;
  if (BUNDLE_PATHS.has(path) && BUNDLE_ROWS.has(key)) return answer(BUNDLE_ROWS.get(key), code);
  if (ROWS.has(key)) return answer(ROWS.get(key), code);
  return answer(status >= 400 && status < 500 && !RETRYABLE_4XX.has(status) && code !== undefined ? DEFINITE : UNKNOWN, code);
}

/**
 * Classifies one seller answer by the seller answer table.
 * `verified` is `{status, signed: true, body}` built by the transport after the wire verified the answer, or null when no answer arrived.
 * `context` is the adapter's own record of the request: `path` (a seller route), `dispatched` (false only for a failure before the request left), `continuation` (the request carried a capability the client minted) and `newPurchase` (the adapter's durable records establish a new purchase).
 * Returns `{answerClass, code}`: `code` is the seller's `error` string when it sent one. Throws TypeError for a record whose context says nothing was dispatched.
 */
export function classifySellerAnswer(verified, context) {
  if (verified === null) return answer(context.dispatched ? UNKNOWN : NOT_SENT);
  if (!context.dispatched) throw new TypeError('seller_answer_context_invalid');
  if (verified?.signed !== true || !Number.isSafeInteger(verified.status) || !isObject(verified.body)) return answer(UNKNOWN);
  return classifySigned(verified.status, verified.body, context);
}
