// Opaque process-local native delivery authority; operations own bounded transport
// reads and deadlines. A submit timeout never proves that no write occurred.
import { isDemDeliveryContextAuthority } from './dem-delivery-context-consumer.mjs';
export const NATIVE_DEM_DELIVERY_SOURCE = 'dacs-chatgpt-plugin/native-dem-delivery/v1';
const capabilities = new WeakMap();

/** Register native operations; optional submitAuthorized must enforce its callback under the publisher's lock. */
export function createNativeDemDeliveryCapability({ authority, submitAuthorized, submit = submitAuthorized, reconcile, read, verifyReceipt }) {
  if (!isDemDeliveryContextAuthority(authority) || [submit, reconcile, read, verifyReceipt].some(fn => typeof fn !== 'function')) {
    throw new TypeError('native DEM delivery requires explicit TEST authority and complete seller/buyer operations');
  }
  const capability = Object.freeze({ source: NATIVE_DEM_DELIVERY_SOURCE, authority });
  capabilities.set(capability, { submit, submitAuthorized, reconcile, read, verifyReceipt });
  return capability;
}

/** Admit a registered native capability or absence; throws for copied descriptors. */
export function nativeDemDeliveryConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('nativeDemDelivery requires a constructed application capability');
  return value;
}

function operations(value) {
  const configured = nativeDemDeliveryConfig(value);
  if (!configured) throw new TypeError('native DEM delivery capability is absent');
  return capabilities.get(configured);
}

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

/** Submit isolated data; an authorization callback requires a registered guarded operation or holds delivery. */
export async function submitNativeDemDelivery(capability, input, authorize) {
  const { submit, submitAuthorized } = operations(capability);
  if (authorize !== undefined && (typeof authorize !== 'function' || typeof submitAuthorized !== 'function')) return { status: 'indeterminate', reason: 'native delivery requires guarded submission' };
  return (authorize === undefined ? submit : submitAuthorized)(structuredClone(input), authorize);
}
/** Reconcile an isolated input copy; rejects without registered native authority. */
export async function reconcileNativeDemDelivery(capability, input) {
  return operations(capability).reconcile(structuredClone(input));
}
/** Read an isolated input copy; rejects without registered native authority. */
export async function readNativeDemDelivery(capability, input) {
  return operations(capability).read(structuredClone(input));
}
/** Verify an isolated receipt input; rejects without registered native authority. */
export async function verifyNativeDemDeliveryReceipt(capability, input) {
  return operations(capability).verifyReceipt(structuredClone(input));
}
