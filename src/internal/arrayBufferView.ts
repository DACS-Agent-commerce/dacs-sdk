/**
 * Whether `value`, or any object reachable from it through enumerable own
 * properties, is a typed array or other `ArrayBuffer` view. Shared and cyclic
 * references are visited once.
 *
 * `deepFreeze` leaves such views writable, so a record that must not change
 * after it is checked refuses them before freezing.
 */
export function containsArrayBufferView(value: unknown): boolean {
  return reaches(value, new WeakSet<object>());
}

function reaches(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  if (ArrayBuffer.isView(value)) return true;
  seen.add(value);
  return Object.values(value).some((child) => reaches(child, seen));
}
