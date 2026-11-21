import { canonicalize } from '@kynesyslabs/dacs';
import { assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { OperationError } from './client-errors.mjs';
import { PURCHASE_ADMISSION } from './dacs/purchase-admission-state.mjs';

const ADMITTED_STATE = 'testnet-tp1';
const ADMISSION_MEMBERS = 'binding,currentLocal';
const UNTRUSTED_OPTIONS = ['profile', 'record', 'identityRecord', 'actionsAdmitted'];
const NODE_VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;

/** K0's aggregate deadline for the authority read behind one admitted call. */
export const AUTHORITY_READ_DEADLINE_MS = 10_000;

/** Whether the one hold constant currently admits purchase actions; read live on every call. */
export const purchaseActionsAdmitted = () => PURCHASE_ADMISSION === ADMITTED_STATE;

/** Returns the refusal every held or unverified action gets: OperationError(profile_not_admitted) carrying the original `cause`, if any. */
export function notAdmittedError(cause) {
  return new OperationError('profile_not_admitted', 'Purchase actions are held: no coordinated Standard release and authenticated session/participant profile tuple is admitted.',
    undefined, cause === undefined ? undefined : { cause });
}

function runtimeSupported(version) {
  const match = NODE_VERSION.exec(version);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  return (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) || (major === 24 && minor >= 15);
}

/** assertPurchaseRuntime(version) returns undefined when `version` (a process.version string) is ^22.22.2 || ^24.15.0, and throws OperationError(runtime_unsupported) naming it otherwise, including for text that is not a version. */
export function assertPurchaseRuntime(version) {
  if (!runtimeSupported(version)) throw new OperationError('runtime_unsupported', `purchases need Node ^22.22.2 || ^24.15.0; this is ${String(version)}`);
}

/** readAdmission(options) checks only the exact `admission: {binding, currentLocal}` shape and that no untrusted option is present; it calls neither member. Returns them, or throws TypeError(admission_required | admission_input_untrusted). */
export function readAdmission(options) {
  const admission = options?.admission;
  if (admission === null || typeof admission !== 'object' || Object.keys(admission).sort().join() !== ADMISSION_MEMBERS
    || typeof admission.binding !== 'object' || admission.binding === null || typeof admission.currentLocal !== 'function') {
    throw new TypeError('admission_required');
  }
  if (UNTRUSTED_OPTIONS.some((name) => name in options)) throw new TypeError('admission_input_untrusted');
  return { binding: admission.binding, currentLocal: admission.currentLocal };
}

function readStopped(options) {
  if (typeof options.stopped !== 'function') throw new TypeError('stopped_required');
  return options.stopped;
}

function readPassiveOnly(options) {
  if (options.passiveOnly !== undefined && options.passiveOnly !== true) throw new TypeError('passive_only_invalid');
  return options.passiveOnly === true;
}

// The host's stop check, bounded by the read deadline. Resolves only for the answer `false`; every other outcome is a
// refusal that keeps its cause: stopped, thrown or rejected, no answer in time, or an answer that is not a boolean.
async function checkStopped(stopped) {
  let answer, timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new OperationError('stop_check_timeout', 'the stop check did not answer in time')), AUTHORITY_READ_DEADLINE_MS);
  });
  try {
    answer = await Promise.race([Promise.resolve().then(() => stopped()), deadline]);
  } catch (error) {
    throw error?.code === 'stop_check_timeout' ? error : new OperationError('stop_check_failed', 'the stop check failed', undefined, { cause: error });
  } finally {
    clearTimeout(timer);
  }
  if (typeof answer !== 'boolean') throw new OperationError('stop_check_invalid', 'the stop check did not answer true or false');
  if (answer) throw new OperationError('writes_stopped', 'writes are stopped');
}

// Step 3: the wire's binding check, bounded by the read deadline. The timer is
// cleared on every path; a late answer finds the race already settled. Returns
// the canonical text of the connection that was checked, taken before the
// await: a host's live object may change while the authority read is pending.
async function checkBinding({ binding, currentLocal }) {
  let local, checked, timer;
  try {
    local = currentLocal();
    checked = canonicalize(local);
  } catch (error) {
    throw notAdmittedError(error);
  }
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new OperationError('tp1_authority_timeout', 'the authority read did not answer in time')), AUTHORITY_READ_DEADLINE_MS);
  });
  try {
    await Promise.race([assertTp1Binding(binding, local), deadline]);
  } catch (error) {
    throw notAdmittedError(error);
  } finally {
    clearTimeout(timer);
  }
  return checked;
}

// Step 3a, synchronous: the hold and the actor's connection are as they were when the check began.
function assertUnchangedSinceCheck(checkedText, currentLocal) {
  if (!purchaseActionsAdmitted()) throw notAdmittedError();
  let unchanged;
  try {
    unchanged = canonicalize(currentLocal()) === checkedText;
  } catch (error) {
    throw notAdmittedError(error);
  }
  if (!unchanged) throw notAdmittedError(new OperationError('tp1_local_binding_changed', 'the actor\'s connection changed during the admission check'));
}

async function callAdmitted(original, receiver, args, { admission, purchase, stopped }) {
  if (!purchaseActionsAdmitted()) throw notAdmittedError();
  if (purchase) assertPurchaseRuntime(process.version);
  if (stopped) await checkStopped(stopped);
  const checkedText = await checkBinding(admission);
  assertUnchangedSinceCheck(checkedText, admission.currentLocal);
  return original.apply(receiver, args);
}

/**
 * admitPublicFactory(factory, {passive, purchase, stopSeam, onCreated}) returns a factory that requires `admission: {binding, currentLocal}` and returns a frozen object
 * whose function members are Promise-returning, except the names in `passive`, which pass through unchanged. Each wrapped call, in order: refuses while the
 * hold is held, checks the Node floor when `purchase` is set, awaits the host's stop check when `stopSeam` is set, awaits the wire's binding check under
 * AUTHORITY_READ_DEADLINE_MS, re-checks the hold and `currentLocal()` synchronously, then invokes the original once with its receiver and arguments.
 * `actionsAdmitted` is a construction-time snapshot, never authority. `onCreated(publicObject, original)` runs once after construction.
 * With `stopSeam` the factory also requires `stopped`, a function answering true or false, and accepts `passiveOnly: true`, which leaves only the `passive`
 * functions and the non-function members on the returned object. The original factory receives `passiveOnly` and `checkStopped()`, the same bounded stop
 * check, which resolves for `false` and rejects with the refusal otherwise; the stop check is the host's, never a default.
 * Throws TypeError(admission_required | admission_input_untrusted | stopped_required | passive_only_invalid) and, for purchase factories, OperationError(runtime_unsupported) before building anything.
 * Wrapped calls reject with OperationError(profile_not_admitted) carrying the cause, with OperationError(writes_stopped | stop_check_failed | stop_check_invalid | stop_check_timeout), or with runtime_unsupported or the original's own error.
 */
export function admitPublicFactory(factory, { passive = [], purchase = false, stopSeam = false, onCreated } = {}) {
  const passiveNames = new Set(passive);
  return function admittedFactory(options) {
    const admission = readAdmission(options);
    if (purchase) assertPurchaseRuntime(process.version);
    const stopped = stopSeam ? readStopped(options) : undefined;
    const passiveOnly = stopSeam && readPassiveOnly(options);
    const factoryOptions = { ...options };
    factoryOptions.admission = admission;
    if (stopSeam) {
      delete factoryOptions.stopped;
      factoryOptions.checkStopped = () => checkStopped(stopped);
    }
    const original = factory(factoryOptions);
    const gate = { admission, purchase, stopped };
    const members = Object.entries(original).flatMap(([name, value]) => {
      if (typeof value !== 'function' || passiveNames.has(name)) return [[name, value]];
      return passiveOnly ? [] : [[name, function admittedAction(...args) { return callAdmitted(value, original, args, gate); }]];
    });
    const publicObject = Object.freeze({ ...Object.fromEntries(members), actionsAdmitted: purchaseActionsAdmitted() });
    onCreated?.(publicObject, original);
    return publicObject;
  };
}
