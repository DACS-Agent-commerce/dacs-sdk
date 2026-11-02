import { readAdmissionCapability } from './session-admission.mjs';
import { isProvenUnsignedAbsence, provenUnsignedAbsence } from './native-dem-delivery-consumer.mjs';

/**
 * Read one retained artifact from the native anchor capability under the
 * admission read bounds (deadline, reply bytes, value and list counts).
 * `options` are the capability's own read options (`resend`, `authorizeResend`);
 * the bounds' limits and abort signal are added to them. A proven-unsigned
 * absence is recognised on the capability's own reply and stays proven on the
 * bounded copy. Throws a TimeoutError past the deadline, a RangeError for a
 * reply over a limit, or the capability's own error.
 */
export function readRetainedBounded(anchor, query, options = {}) {
  let unsignedProven = false;
  const retained = {
    readRetained: async (input, limits) => {
      const reply = await anchor.readRetained(input, { ...options, ...limits });
      unsignedProven = isProvenUnsignedAbsence(reply);
      return reply;
    },
  };
  return readAdmissionCapability(retained, 'readRetained', query).then((reply) => (unsignedProven ? provenUnsignedAbsence(reply.reason) : reply));
}

const failureKind = (failure) => (failure?.name === 'TimeoutError' || failure?.code === 'ETIMEDOUT' ? 'timeout' : failure instanceof RangeError ? 'reply-limit' : 'reader');

/** Why a read failed, looking through one wrapping error: 'timeout', 'reply-limit' (reply over a limit) or 'reader' (the capability's own error). */
export function readFailureCode(failure) {
  return [failure, failure?.cause].map(failureKind).find((kind) => kind !== 'reader') ?? 'reader';
}
