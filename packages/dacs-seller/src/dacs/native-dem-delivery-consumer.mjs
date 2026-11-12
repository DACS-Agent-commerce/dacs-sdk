// Opaque process-local native delivery authority. Operations cap wire bytes before decoding;
// each call here also runs under a deadline and a reply-size limit. A submit timeout never
// proves that no write occurred.
import { isDemDeliveryContextAuthority } from './dem-delivery-context-consumer.mjs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { resolveWithDeadline, boundedResolutionValue } from '../util/bounded-resolution.mjs';
export const NATIVE_DEM_DELIVERY_SOURCE = 'dacs-chatgpt-plugin/native-dem-delivery/v1';
const capabilities = new WeakMap();

/** Register native operations. submitAuthorized(input, authorize) calls authorize('signing') last before it signs; anything but true signs nothing. A seller agent requires submitAuthorized; submit defaults to it. */
export function createNativeDemDeliveryCapability({ authority, submitAuthorized, submit = submitAuthorized, reconcile, read, verifyReceipt }) {
  if (!isDemDeliveryContextAuthority(authority) || [submit, reconcile, read, verifyReceipt].some(fn => typeof fn !== 'function')) {
    throw new TypeError('native DEM delivery requires explicit TEST authority and complete seller/buyer operations');
  }
  const capability = Object.freeze({ source: NATIVE_DEM_DELIVERY_SOURCE, authority });
  capabilities.set(capability, { submit, submitAuthorized, reconcile, read, verifyReceipt });
  return capability;
}
/** True when the capability rechecks authority right before it signs; a seller agent is built only with one. */
export const hasGuardedNativeDemDelivery = (capability) => typeof capabilities.get(capability)?.submitAuthorized === 'function';

/** Admit a registered native capability or absence; throws for copied descriptors. */
export function nativeDemDeliveryConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('nativeDemDelivery requires a constructed application capability');
  return value;
}

/** The { submit, submitAuthorized } a capability was made with, or undefined for anything that is not a capability. */
export function nativeDemDeliverySubmitsOf(value) {
  const registered = capabilities.get(value);
  return registered && { submit: registered.submit, submitAuthorized: registered.submitAuthorized };
}

function operations(value) {
  const configured = nativeDemDeliveryConfig(value);
  if (!configured) throw new TypeError('native DEM delivery capability is absent');
  return capabilities.get(configured);
}

/**
 * Options for a retained read whose caller holds no authority to write: the
 * capability reads the CREATE back and never broadcasts it again.
 */
export const PASSIVE_RETAINED_READ = Object.freeze({ resend: false });

const provenUnsigned = new WeakSet();
/** Mark proven unsigned shutdown absence. Only this object's identity carries proof. */
export function provenUnsignedAbsence(reason) {
  const value = { status: 'absent', reason };
  provenUnsigned.add(value);
  return value;
}
/** Test process-local unsigned absence; serialized/copied results confer no proof. */
export function isProvenUnsignedAbsence(value) {
  return provenUnsigned.has(value) && value.status === 'absent';
}

const deadRefusedCreates = new WeakSet();
/**
 * The `rejected` answer for a node-refused CREATE that can no longer be included (the account nonce passed it and
 * the readback proves it absent), so publishing it again cannot make a second CREATE. Only this object's identity carries the proof.
 */
export function deadRefusedCreate(reason) {
  const value = { status: 'rejected', reason, noResend: true };
  deadRefusedCreates.add(value);
  return value;
}
/** Test process-local dead refused CREATE; serialized/copied results confer no proof. */
export function isDeadRefusedCreate(value) {
  return deadRefusedCreates.has(value) && value.status === 'rejected';
}

/** True when a read proves nothing signed for the address can still land (never signed, or refused and dead), so publishing it again makes no second CREATE. */
export const mayPublishAgain = (value) => isProvenUnsignedAbsence(value) || isDeadRefusedCreate(value);

// Fixed limits for one native delivery operation and the reply it hands back.
const NATIVE_DEM_DELIVERY_LIMITS = Object.freeze({ timeoutMs: 30_000, maxBytes: 256 * 1024, maxValues: 16_384, maxDepth: 32, maxListEntries: 1024 });

/**
 * Run a registered operation under NATIVE_DEM_DELIVERY_LIMITS. A missed deadline or a reply over the
 * limits is answered with `indeterminate(reason)`: neither proves that nothing was written or that
 * the Deliverable is absent. The reply is checked in its JSON form (replies may carry keys whose
 * value is undefined); the capability's own object is returned,
 * because the unsigned-absence and dead-refusal proofs are carried by object identity. An error the
 * operation throws reaches the caller unchanged.
 */
async function runWithinLimits(operation, indeterminate) {
  let reply;
  try {
    reply = await resolveWithDeadline(() => operation(), NATIVE_DEM_DELIVERY_LIMITS);
  } catch (error) {
    if (error?.message === 'resolver-timeout') return indeterminate('native delivery operation exceeded its deadline');
    throw error;
  }
  try {
    boundedResolutionValue(JSON.parse(JSON.stringify(reply)), NATIVE_DEM_DELIVERY_LIMITS);
  } catch (error) {
    return indeterminate(`native delivery reply exceeds its read limits: ${error.message}`);
  }
  return reply;
}
const indeterminateStatus = (reason) => ({ status: 'indeterminate', reason });
const indeterminateVerdict = () => 'indeterminate';

/** Submit isolated data; an authorization callback requires a registered guarded operation or holds delivery. A missed deadline or an oversized reply answers indeterminate; the write may still have happened. */
export async function submitNativeDemDelivery(capability, input, authorize) {
  assertKitOperationAdmitted('submitNativeDemDelivery');
  const { submit, submitAuthorized } = operations(capability);
  if (authorize !== undefined && (typeof authorize !== 'function' || typeof submitAuthorized !== 'function')) return { status: 'indeterminate', reason: 'native delivery requires guarded submission' };
  const operation = authorize === undefined ? submit : submitAuthorized;
  return runWithinLimits(() => operation(structuredClone(input), authorize), indeterminateStatus);
}
/** Reconcile an isolated input copy; rejects without registered native authority. A missed deadline or an oversized reply answers indeterminate. */
export async function reconcileNativeDemDelivery(capability, input) {
  const { reconcile } = operations(capability);
  return runWithinLimits(() => reconcile(structuredClone(input)), indeterminateStatus);
}
/**
 * Read an isolated input copy; rejects without registered native authority. The
 * read is passive. Only the restart path of a seller passes `resendOptions`
 * ({ resend: true, authorizeResend }): the capability may then send a retained
 * CREATE's original bytes again, once, after authorizeResend answers true.
 * A missed deadline or an oversized reply answers { status: 'indeterminate' }, never absent.
 */
export async function readNativeDemDelivery(capability, input, resendOptions) {
  const { read } = operations(capability);
  return runWithinLimits(() => read(structuredClone(input), resendOptions), indeterminateStatus);
}
/** Verify an isolated receipt input; rejects without registered native authority. A missed deadline or an oversized reply answers 'indeterminate'. */
export async function verifyNativeDemDeliveryReceipt(capability, input) {
  const { verifyReceipt } = operations(capability);
  return runWithinLimits(() => verifyReceipt(structuredClone(input)), indeterminateVerdict);
}
