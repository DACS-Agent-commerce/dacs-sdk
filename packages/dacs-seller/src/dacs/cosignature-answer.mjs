// An answer that carries the Agreement co-signature is that signature's transmission: it is written only inside a
// dispatch pass of the host's effect boundary, over the signature the sign pass retained.
import { WireError } from '@kynesyslabs/dacs/wire';

/** The own symbol under which an answer carrying the co-signature names its answer pass `{ jobId, operationId, send }`; JSON never carries it. */
export const COSIGNATURE_ANSWER =Symbol('Agreement co-signature answer');

const noRetainedSignature = () => {
  throw new WireError('eb_signature_not_retained', 500, 'a co-signature answer is sent only over a signature its sign pass retained');
};

/**
 * Builds the co-signature answer over `effectBoundary`. `send({ op, recheck, write })` runs one pass for `op` (the
 * operation the signature was made under): it never signs, so without a retained `signed` record it refuses
 * eb_signature_not_retained and writes nothing. After the boundary's dispatch checks it calls `recheck()` and then
 * `write()`, synchronously. Resolves once written. Rejects with the boundary's refusal (the answer is then not
 * written and the signature stays held) or with the error `recheck` or `write` threw.
 */
export function createCosignatureAnswer({ effectBoundary }) {
  return Object.freeze({
    async send({ op, recheck, write }) {
      await effectBoundary.pass(op, noRetainedSignature, () => { recheck(); write(); return 'written'; }, { stage: 'dispatch' });
    },
  });
}
