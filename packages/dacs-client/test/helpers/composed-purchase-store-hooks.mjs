// Module hooks that load composed-purchase-store.mjs wherever a module imports
// the offline harness database or operations store, so a harness suite runs
// with its assertions unchanged on the store a deployed buyer composes.
const composed = new URL('./composed-purchase-store.mjs', import.meta.url).href;
const harness = new Set(['./purchase-integrity-database.mjs', './purchase-integrity-operations.mjs'].map((name) => new URL(name, import.meta.url).href));

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  return harness.has(resolved.url) ? { ...resolved, url: composed } : resolved;
}
