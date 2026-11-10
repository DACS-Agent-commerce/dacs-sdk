/**
 * Freezes `value` and every object reachable from it through enumerable own
 * properties, then returns `value`.
 *
 * - Objects that are already frozen are still walked, so a frozen parent never
 *   hides a mutable child.
 * - Typed arrays and other `ArrayBuffer` views are left unfrozen: a non-empty
 *   view cannot be frozen, and callers that need fixed bytes copy them first.
 * - Shared and cyclic references are visited once.
 *
 * Use it on SDK-owned snapshots (structured clones, parsed JSON, freshly built
 * records), not on objects a caller still owns.
 */
export function deepFreeze<T>(value: T): T {
  freezeReachable(value, new WeakSet<object>());
  return value;
}

function freezeReachable(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return;
  for (const child of Object.values(value)) freezeReachable(child, seen);
  Object.freeze(value);
}
