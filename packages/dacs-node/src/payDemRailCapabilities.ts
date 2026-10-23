import type { PayDemRail } from "@kynesyslabs/dacs";

const deferredWalletReservationRails = new WeakSet<object>();
const recordVerifyingRuntimeRails = new WeakSet<object>();

/** Internal capability: only the SDK-owned Demos runtime may mark its default rail. */
export function markDacsSdkPreparedPayDemRailV1<T extends Readonly<PayDemRail>>(
  rail: T,
): T {
  deferredWalletReservationRails.add(rail);
  return rail;
}

/** True only for the exact SDK-default runtime rail object, never injected rails. */
export function isDacsSdkPreparedPayDemRailV1(
  rail: Readonly<PayDemRail>,
): boolean {
  return deferredWalletReservationRails.has(rail);
}

/**
 * Internal capability: only the SDK-owned Demos runtime may mark its wallet
 * wrapper, and only around a rail `isPayDemRecordVerifyingRail` accepts (#338).
 */
export function markDacsRecordVerifyingPayDemRailV1<T extends Readonly<PayDemRail>>(
  rail: T,
): T {
  recordVerifyingRuntimeRails.add(rail);
  return rail;
}

/**
 * True only for the exact runtime wrapper around a record-verifying rail. It
 * relays that rail's result unchanged, so the SDK can make its success final.
 */
export function isDacsRecordVerifyingPayDemRailV1(
  rail: Readonly<PayDemRail>,
): boolean {
  return recordVerifyingRuntimeRails.has(rail);
}
