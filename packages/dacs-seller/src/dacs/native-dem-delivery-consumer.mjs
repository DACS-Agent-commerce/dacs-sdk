// Opaque process-local native delivery authority. Every reply is checked against a size and list
// limit after the capability returns it; wire bytes inside a capability's own transport are not
// capped here. Reconcile, read and verify also run under a deadline; a submit does not.
// A missed deadline never proves that no write occurred.
import { isDemDeliveryContextAuthority } from './dem-delivery-context-consumer.mjs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { resolveWithDeadline, boundedResolutionValue, isResolverDeadline } from '../util/bounded-resolution.mjs';
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

// Fixed limits for the reply of a native delivery operation, and the deadline of the operations that only read.
// They cover every Deliverable the seller can send (at most 16 KiB and 64 levels deep): a read reply holds
// the report twice, the second copy a few levels down.
const NATIVE_DEM_DELIVERY_LIMITS = Object.freeze({ timeoutMs: 30_000, maxBytes: 256 * 1024, maxValues: 32_768, maxDepth: 80, maxListEntries: 16_384 });

/**
 * Check a reply against NATIVE_DEM_DELIVERY_LIMITS. A reply over them is answered with
 * `indeterminate(reason)`: it proves neither that nothing was written nor that the Deliverable is
 * absent. The reply is checked in its JSON form (replies may carry keys whose value is undefined)
 * and that checked copy is what the caller gets, so nothing unchecked passes through. Only the
 * unsigned-absence and dead-refusal objects are returned as they are, because their proofs are
 * carried by object identity; the object itself is checked too, so a `toJSON` cannot hide a field.
 */
function boundedReply(reply, indeterminate) {
  try {
    const plain = JSON.parse(JSON.stringify(reply));
    boundedResolutionValue(plain, NATIVE_DEM_DELIVERY_LIMITS);
    if (!isProvenUnsignedAbsence(reply) && !isDeadRefusedCreate(reply)) return plain;
    boundedResolutionValue(reply, NATIVE_DEM_DELIVERY_LIMITS);
    return reply;
  } catch (error) {
    return indeterminate(`native delivery reply exceeds its read limits: ${error.message}`);
  }
}

/**
 * Run a read-only operation under the deadline, then check its reply. A missed deadline is answered
 * with `indeterminate(reason)`, which proves nothing about what was written. An error the operation
 * throws reaches the caller unchanged.
 */
async function runWithinLimits(operation, indeterminate) {
  let reply;
  try {
    reply = await resolveWithDeadline(() => operation(), NATIVE_DEM_DELIVERY_LIMITS);
  } catch (error) {
    if (isResolverDeadline(error)) return indeterminate('native delivery operation exceeded its deadline');
    throw error;
  }
  return boundedReply(reply, indeterminate);
}
const indeterminateStatus = (reason) => ({ status: 'indeterminate', reason });
const indeterminateVerdict = () => 'indeterminate';

/**
 * Submit isolated data; an authorization callback requires a registered guarded operation or holds delivery.
 * A submit has no deadline: it waits for the operator's approval and signs and sends the CREATE, and the
 * seller keeps its settlement gate until the call returns. Only the reply is checked, and an oversized one answers indeterminate.
 */
export async function submitNativeDemDelivery(capability, input, authorize) {
  assertKitOperationAdmitted('submitNativeDemDelivery');
  const { submit, submitAuthorized } = operations(capability);
  if (authorize !== undefined && (typeof authorize !== 'function' || typeof submitAuthorized !== 'function')) return { status: 'indeterminate', reason: 'native delivery requires guarded submission' };
  const operation = authorize === undefined ? submit : submitAuthorized;
  return boundedReply(await operation(structuredClone(input), authorize), indeterminateStatus);
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
