// The private context of one effect pass: the job class the pass belongs to and the
// synchronous check that its authority is still current. The host that owns the job creates
// one with `passContext` (exported by `./node-wallet`), and only the native transport reads it,
// once at the start of each effectful call. A request field, a header, an operation field or
// a wallet method never supplies a class or a check.
import { AsyncLocalStorage } from 'node:async_hooks';
import { OperationError } from '../client-errors.mjs';

const JOB_CLASSES = ['job-create', 'payment-evidence', 'job-resume'];
const contexts = new WeakSet();
const stored = new AsyncLocalStorage();
const brand = (context) => { contexts.add(context); return Object.freeze(context); };
const PLAIN_CONTEXT = brand({ operationClass: null });

/**
 * Creates the context of a pass. `operationClass` is `'job-create'`, `'payment-evidence'` or
 * `'job-resume'` for a seller job pass, or `null` for a plain pass. `operationId` (optional) is
 * the job's own operation id, used as the effect boundary's operation id. `currentAuthorization`
 * is a synchronous function that returns `true` while the job's authority is current and throws
 * its cause otherwise; a job pass needs one. Throws `TypeError` for any other class.
 */
export function passContext({ operationClass = null, operationId, currentAuthorization } = {}) {
  if (operationClass !== null && !JOB_CLASSES.includes(operationClass)) throw new TypeError(`operationClass is null or one of ${JOB_CLASSES.join(', ')}`);
  return brand({ operationClass, operationId, currentAuthorization });
}

/** Returns true for a context `passContext` made, false for anything else. */
export const isPassContext = (value) => contexts.has(value);

/** Runs `work` with `context` as the current pass context; throws `TypeError` for an object `passContext` did not create. */
export function runInPassContext(context, work) {
  if (!contexts.has(context)) throw new TypeError('a pass context made by passContext is required');
  return stored.run(context, work);
}

/** The context of the running pass, or the plain context when none is running. */
export const currentPassContext = () => stored.getStore() ?? PLAIN_CONTEXT;

/** True while `runInPassContext` runs: inside an effect pass's work or an explicit reopen. Never throws. */
export const insideEffectPass = () => stored.getStore() !== undefined;

/**
 * Throws unless the pass may still transmit: a plain pass always may; a job pass needs a check that
 * returns `true`. A missing check refuses `context_authorization_required`, any other answer
 * (`false`, a promise) `context_authorization_refused`; the check's own throw is kept as it is.
 */
export function assertCurrentAuthorization({ operationClass, currentAuthorization }) {
  if (operationClass === null) return;
  if (typeof currentAuthorization !== 'function') throw new OperationError('context_authorization_required', `a ${operationClass} pass has no current-authorization check`);
  const answer = currentAuthorization();
  if (answer === true) return;
  const asynchronous = typeof answer?.then === 'function';
  if (asynchronous) Promise.resolve(answer).catch(() => {});
  throw new OperationError('context_authorization_refused', asynchronous ? 'the current-authorization check answered asynchronously' : 'the current-authorization check did not return true');
}
