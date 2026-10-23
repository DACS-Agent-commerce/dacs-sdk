// Run-time port of http-mcp/src/dacs/native-dem-delivery-consumer.mjs at
// DACS-Agent-commerce/frontend 15fdf23: the whole file.
// Explicit application capability for native DEM deliverable publication and
// public readback. It is deliberately opaque/default-absent: copying its
// descriptor or setting a Boolean never grants a seller write or buyer proof.
export const NATIVE_DEM_DELIVERY_SOURCE = 'dacs-chatgpt-plugin/native-dem-delivery/v1';

const capabilities = new WeakMap();

export function createNativeDemDeliveryCapability({ authority, submit, reconcile, read, verifyReceipt }) {
  if (typeof authority !== 'string' || !authority.startsWith('TEST-') ||
      [submit,reconcile,read,verifyReceipt].some((fn)=>typeof fn!=='function')) {
    throw new TypeError('native DEM delivery requires explicit TEST authority and complete seller/buyer operations');
  }
  const capability=Object.freeze({source:NATIVE_DEM_DELIVERY_SOURCE,authority});
  capabilities.set(capability,{submit,reconcile,read,verifyReceipt});
  return capability;
}

export function nativeDemDeliveryConfig(value) {
  if (value==null) return null;
  if (!capabilities.has(value)) throw new TypeError('nativeDemDelivery requires a constructed application capability');
  return value;
}

function operations(value) {
  const configured=nativeDemDeliveryConfig(value);
  return configured ? capabilities.get(configured) : null;
}

// The one absence a reader has proved: a shutdown (operator_closing) ended the
// CREATE's approval before anything was signed, so publishing it again asks
// the operator again. The proof is this module's own object identity, never a
// field: no journal row, session or response body can carry it.
const provenUnsigned=new WeakSet();
export function provenUnsignedAbsence(reason) {
  const value={status:'absent',reason};
  provenUnsigned.add(value);
  return value;
}
export function isProvenUnsignedAbsence(value) {
  return provenUnsigned.has(value) && value.status==='absent';
}

export async function submitNativeDemDelivery(capability,input) {
  return operations(capability).submit(structuredClone(input));
}
export async function reconcileNativeDemDelivery(capability,input) {
  return operations(capability).reconcile(structuredClone(input));
}
export async function readNativeDemDelivery(capability,input) {
  return operations(capability).read(structuredClone(input));
}
export async function verifyNativeDemDeliveryReceipt(capability,input) {
  return operations(capability).verifyReceipt(structuredClone(input));
}
