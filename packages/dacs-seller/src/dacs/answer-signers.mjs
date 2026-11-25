// Which of the seller key's roles signs each wire answer. A read answer and a refusal use the closed read-only role, one
// single-use signer per answer, so a re-held host still answers them. Any other answer (a success on an effect route or on
// the context routes) is signed by the effect role inside its own short pass of the host's effect boundary, so it waits
// behind any pass that holds the fence.
import { sha256Hex } from '@kynesyslabs/dacs';
import { isReadRoute } from '@kynesyslabs/dacs/wire';

const REFUSAL_STATUS_MIN = 400;
const REFUSAL_STATUS_MAX = 599;
const isSuccess = (status) => status >= 200 && status <= 299;

/**
 * Builds the answer signer over `roles` (the seller key's roles: `claim`, `sign` and `readOnlyAnswerSigner`), the host's
 * `effectBoundary` built over `binding`, and `local()` (the current connection). Signing an answer creates nothing; the
 * returned `signAnswer` signs only through those roles.
 * `signAnswer({ request, status, text }, signWith)` picks one signer and resolves `signWith(signer)`: the read-only role with
 * purpose `read-answer` for a 2xx answer on a read route, the same role with purpose `refusal` for status 400 to 599, and
 * otherwise the effect role through `effectBoundary.signerFor` inside a `withFence` pass of its own. Rejects with the role's or
 * the boundary's refusal, or with `signWith`'s own error.
 */
export function createAnswerSigners({ roles, effectBoundary, binding, local }) {
  const readOnly = (purpose, text) => roles.readOnlyAnswerSigner({ purpose, binding, local: local(), body: text });
  async function signAnswer({ request, status, text }, signWith) {
    if (isSuccess(status) && isReadRoute(request.path)) return signWith(await readOnly('read-answer', text));
    if (status >= REFUSAL_STATUS_MIN && status <= REFUSAL_STATUS_MAX) return signWith(await readOnly('refusal', text));
    const op = { operationId: `answer-${sha256Hex(text)}`, lane: `job-${request.jobId}`, kind: 'wire-request', paidWrite: false, debitOs: null, approvalRef: null, k1Rev: null,
      pinVersion: binding.profile.pinVersion };
    return effectBoundary.withFence(op, (held) => signWith(effectBoundary.signerFor(held, roles)));
  }
  return Object.freeze({ signAnswer });
}
