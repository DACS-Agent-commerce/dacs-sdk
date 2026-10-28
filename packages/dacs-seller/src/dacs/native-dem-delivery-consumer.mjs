// Opaque process-local native delivery authority; operations own bounded transport
// reads and deadlines. A submit timeout never proves that no write occurred.
import { isDemDeliveryContextAuthority } from './dem-delivery-context-consumer.mjs';
export const NATIVE_DEM_DELIVERY_SOURCE = 'dacs-chatgpt-plugin/native-dem-delivery/v1';
const capabilities = new WeakMap();

/** Register all four native operations; throws for invalid labels or missing operations. */
export function createNativeDemDeliveryCapability({ authority, submit, reconcile, read, verifyReceipt }) {
  if (!isDemDeliveryContextAuthority(authority) || [submit, reconcile, read, verifyReceipt].some(fn => typeof fn !== 'function')) {
    throw new TypeError('native DEM delivery requires explicit TEST authority and complete seller/buyer operations');
  }
  const capability = Object.freeze({ source: NATIVE_DEM_DELIVERY_SOURCE, authority });
  capabilities.set(capability, { submit, reconcile, read, verifyReceipt });
  return capability;
}

/** Admit a registered native capability or absence; throws for copied descriptors. */
export function nativeDemDeliveryConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('nativeDemDelivery requires a constructed application capability');
  return value;
}

/** The `submit` a capability was made with, or undefined for anything that is not a capability. */
export function nativeDemDeliverySubmitOf(value) {
  return capabilities.get(value)?.submit;
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

/** Submit an isolated input copy; rejects without registered native authority. */
export async function submitNativeDemDelivery(capability, input) {
  return operations(capability).submit(structuredClone(input));
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
