/** deepFreeze(value) freezes `value` and every object it holds, in place, and returns `value`. A primitive is returned unchanged. */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
