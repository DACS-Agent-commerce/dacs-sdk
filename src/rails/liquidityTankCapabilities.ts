// Internal capabilities, deliberately absent from package exports. Registration
// is bound to the exact frozen implementation, never copied by object spread.
const stores = new WeakSet<object>();
const verifiers = new WeakSet<object>();
export function registerProductionTankStore<T extends object>(store: T): T {
  stores.add(store);
  return store;
}
export function isProductionTankStore(store: unknown): boolean {
  return typeof store === "object" && store !== null && stores.has(store);
}
export function registerSourceFinalityVerifier<T extends object>(verifier: T): T {
  verifiers.add(verifier);
  return verifier;
}
export function isSourceFinalityVerifier(verifier: unknown): boolean {
  return typeof verifier === "object" && verifier !== null && verifiers.has(verifier);
}
