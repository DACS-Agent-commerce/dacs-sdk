import { readAdmissionCapability, REPLY_LIMIT_CODE } from './session-admission.mjs';
import { isProvenUnsignedAbsence, provenUnsignedAbsence, isDeadRefusedCreate, deadRefusedCreate } from './native-dem-delivery-consumer.mjs';

/**
 * Read one retained artifact from the native anchor capability under the
 * admission read bounds (deadline, reply bytes, value and list counts).
 * `options` are the capability's own read options (`resend`, `authorizeResend`);
 * the bounds' limits and abort signal are added to them. A proven-unsigned
 * absence, and a dead refused CREATE, are recognised on the capability's own
 * reply and stay proven on the bounded copy. Throws a TimeoutError past the deadline, a RangeError coded
 * `REPLY_LIMIT_CODE` for a reply over a limit, or the capability's own error.
 */
const proofReason = (reason) => (typeof reason === 'string' ? reason : typeof reason?.message === 'string' ? reason.message : 'the reader proved nothing was signed');

export function readRetainedBounded(anchor, query, options = {}) {
  let unsignedProven = false;
  let deadRefused = false;
  const retained = {
    readRetained: async (input, limits) => {
      const reply = await anchor.readRetained(input, { ...options, ...limits });
      unsignedProven = isProvenUnsignedAbsence(reply);
      deadRefused = isDeadRefusedCreate(reply);
      // Both proofs are marked again on the bounded copy below. The whole reply still passes the plain-JSON bounds;
      // only its reason becomes text, so a proof made with no reason, or with an Error, is not lost to the check.
      return unsignedProven || deadRefused ? { ...reply, reason: proofReason(reply.reason) } : reply;
    },
  };
  return readAdmissionCapability(retained, 'readRetained', query).then((reply) => (unsignedProven ? provenUnsignedAbsence(reply.reason) : deadRefused ? deadRefusedCreate(reply.reason) : reply));
}

const failureKind = (failure) => (failure?.name === 'TimeoutError' || failure?.code === 'ETIMEDOUT' ? 'timeout' : failure?.code === REPLY_LIMIT_CODE ? 'reply-limit' : 'reader');

/** Why a read failed, looking through one wrapping error: 'timeout', 'reply-limit' (reply over an admission limit) or 'reader' (the capability's own error). */
export function readFailureCode(failure) {
  return [failure, failure?.cause].map(failureKind).find((kind) => kind !== 'reader') ?? 'reader';
}
