// The private context of one effect pass: the class of the pass and the check that its current
// authorization still holds. Trusted composition code builds it with `passContext` and installs it
// with `runInPassContext` around a wallet call; the native transport reads it once at the entry of
// each effectful request and runs the check right before the request leaves. Nothing a request,
// header or wallet method carries can stand in for it. Internal: not exported by the package.
import { AsyncLocalStorage } from 'node:async_hooks';
import { OperationError } from '../client-errors.mjs';

const JOB_OPERATION_CLASSES = ['job-create', 'payment-evidence', 'job-resume'];
const contexts = new WeakSet();
const installed = new AsyncLocalStorage();
const PLAIN_CONTEXT = Object.freeze({ operationClass: null });
contexts.add(PLAIN_CONTEXT);

const refusal = (code, message) => new OperationError(code, message);

/**
 * Builds a pass context: `operationClass` is 'job-create', 'payment-evidence', 'job-resume' or null (a plain
 * pass); `operationId` is the id of the seller job the pass belongs to, used as its history's operation id;
 * `currentAuthorization()` is a synchronous check that returns true or throws its cause. A job pass
 * without a usable check is refused when it transmits. Throws TypeError for any other class.
 */
export function passContext({ operationClass = null, operationId, currentAuthorization } = {}) {
  if (operationClass !== null && !JOB_OPERATION_CLASSES.includes(operationClass)) throw new TypeError(`operationClass must be null or one of ${JOB_OPERATION_CLASSES.join(', ')}`);
  const context = Object.freeze({ operationClass, operationId, currentAuthorization });
  contexts.add(context);
  return context;
}

/** Runs `work` with `context` installed and returns its result. Throws TypeError for an object `passContext` did not build. */
export function runInPassContext(context, work) {
  if (!contexts.has(context)) throw new TypeError('a pass context must come from passContext');
  return installed.run(context, work);
}

/** The installed context, or the plain one (class null, no check) when none is installed. */
export const currentPassContext = () => installed.getStore() ?? PLAIN_CONTEXT;

/**
 * Runs the context's check: returns when it answers true, throws `context_authorization_required` for a job
 * pass without a function, `context_authorization_refused` for any other answer (a thenable's rejection is
 * consumed), and the check's own error when it throws. A plain pass has no check.
 */
export function assertCurrentAuthorization({ operationClass, currentAuthorization }) {
  if (operationClass === null) return;
  if (typeof currentAuthorization !== 'function') throw refusal('context_authorization_required', `a ${operationClass} pass has no current-authorization check`);
  const answer = currentAuthorization();
  if (answer === true) return;
  const asynchronous = typeof answer?.then === 'function';
  if (asynchronous) Promise.resolve(answer).catch(() => {});
  throw refusal('context_authorization_refused', asynchronous ? 'the current-authorization check answered asynchronously' : 'the current-authorization check did not answer true');
}
