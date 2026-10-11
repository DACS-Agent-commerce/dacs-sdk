import type { PayDemRail } from "@kynesyslabs/dacs";

const deferredWalletReservationRails = new WeakSet<object>();

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
