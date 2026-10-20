/**
 * Runtime mark of the SDK's own native DEM settlement adapter.
 *
 * `payDemSettle` marks the function it returns, and SDK wrappers that only
 * forward to a marked function keep the mark. `runSessionCore` completes a
 * recovered native success only through a marked `resumeSettlement`: that
 * adapter requires the reconciler's executed record and binds it to the
 * prepared-transfer journal or this key's own rail record. A caller's own
 * function is never marked, so its `ok: true` alone cannot complete a native
 * payment. Not re-exported from any package entry point.
 */
const payDemSettleAdapters = new WeakSet<object>();

/** @internal Called by `payDemSettle` on the function it returns. */
export function markPayDemSettleAdapter<T extends object>(adapter: T): T {
  payDemSettleAdapters.add(adapter);
  return adapter;
}

/** @internal Whether `value` is a `payDemSettle` adapter or an SDK forwarder of one. */
export function isPayDemSettleAdapter(value: unknown): boolean {
  return typeof value === "function" && payDemSettleAdapters.has(value);
}

/** @internal Mark an SDK wrapper that only forwards to `source`, when `source` is marked. */
export function forwardPayDemSettleAdapter<T>(source: unknown, wrapper: T): T {
  if (isPayDemSettleAdapter(source) && typeof wrapper === "function") {
    payDemSettleAdapters.add(wrapper);
  }
  return wrapper;
}
