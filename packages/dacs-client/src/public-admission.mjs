import { canonicalize } from '@kynesyslabs/dacs';
import { assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { OperationError } from './client-errors.mjs';
import { PURCHASE_ADMISSION } from './dacs/purchase-admission-state.mjs';

const ADMITTED_STATE = 'testnet-tp1';
const ADMISSION_MEMBERS = 'binding,currentLocal';
const UNTRUSTED_OPTIONS = ['profile', 'record', 'identityRecord', 'actionsAdmitted'];
const NODE_VERSION = /^v(\d+)\.(\d+)\.\d+$/;

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
  const major = Number(match[1]), minor = Number(match[2]);
  return (major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24;
}

/** assertPurchaseRuntime(version) returns undefined when `version` (a process.version string) is ^22.13.0 || >=23.4.0, and throws OperationError(runtime_unsupported) naming it otherwise, including for text that is not a version. */
export function assertPurchaseRuntime(version) {
  if (!runtimeSupported(version)) throw new OperationError('runtime_unsupported', `purchases need Node ^22.13.0 || >=23.4.0; this is ${String(version)}`);
}

function readAdmission(options) {
  const admission = options?.admission;
  if (admission === null || typeof admission !== 'object' || Object.keys(admission).sort().join() !== ADMISSION_MEMBERS
    || typeof admission.binding !== 'object' || admission.binding === null || typeof admission.currentLocal !== 'function') {
    throw new TypeError('admission_required');
  }
  if (UNTRUSTED_OPTIONS.some((name) => name in options)) throw new TypeError('admission_input_untrusted');
  return { binding: admission.binding, currentLocal: admission.currentLocal };
}

// Step 3: the wire's binding check, bounded by the read deadline. The timer is
// cleared on every path; a late answer finds the race already settled.
async function checkBinding({ binding, currentLocal }) {
  let local, timer;
  try {
    local = currentLocal();
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
  return local;
}

// Step 3a, synchronous: the hold and the actor's connection are as they were when the check began.
function assertUnchangedSinceCheck(checkedLocal, currentLocal) {
  if (!purchaseActionsAdmitted()) throw notAdmittedError();
  let unchanged;
  try {
    unchanged = canonicalize(currentLocal()) === canonicalize(checkedLocal);
  } catch (error) {
    throw notAdmittedError(error);
  }
  if (!unchanged) throw notAdmittedError(new OperationError('tp1_local_binding_changed', 'the actor\'s connection changed during the admission check'));
}

async function callAdmitted(original, receiver, args, admission, purchase) {
  if (!purchaseActionsAdmitted()) throw notAdmittedError();
  if (purchase) assertPurchaseRuntime(process.version);
  const checkedLocal = await checkBinding(admission);
  assertUnchangedSinceCheck(checkedLocal, admission.currentLocal);
  return original.apply(receiver, args);
}

/**
 * admitPublicFactory(factory, {passive, purchase, onCreated}) returns a factory that requires `admission: {binding, currentLocal}` and returns a frozen object
 * whose function members are Promise-returning, except the names in `passive`, which pass through unchanged. Each wrapped call, in order: refuses while the
 * hold is held, checks the Node floor when `purchase` is set, awaits the wire's binding check under AUTHORITY_READ_DEADLINE_MS, re-checks the hold and
 * `currentLocal()` synchronously, then invokes the original once with its receiver and arguments. `actionsAdmitted` is a construction-time snapshot, never
 * authority. `onCreated(publicObject, original)` runs once after construction.
 * Throws TypeError(admission_required | admission_input_untrusted) and, for purchase factories, OperationError(runtime_unsupported) before building anything.
 * Wrapped calls reject with OperationError(profile_not_admitted) carrying the cause, or with runtime_unsupported or the original's own error.
 */
export function admitPublicFactory(factory, { passive = [], purchase = false, onCreated } = {}) {
  const passiveNames = new Set(passive);
  return function admittedFactory(options) {
    const admission = readAdmission(options);
    if (purchase) assertPurchaseRuntime(process.version);
    const factoryOptions = { ...options };
    delete factoryOptions.admission;
    const original = factory(factoryOptions);
    const members = Object.entries(original).map(([name, value]) => [name,
      typeof value !== 'function' || passiveNames.has(name) ? value : function admittedAction(...args) { return callAdmitted(value, original, args, admission, purchase); }]);
    const publicObject = Object.freeze({ ...Object.fromEntries(members), actionsAdmitted: purchaseActionsAdmitted() });
    onCreated?.(publicObject, original);
    return publicObject;
  };
}
