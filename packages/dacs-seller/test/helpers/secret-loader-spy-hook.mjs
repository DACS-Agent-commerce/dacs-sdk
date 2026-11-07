// Module-customization hook behind seller-key-fixture.mjs: it answers the
// secrets subpath with the pass-through spy. Unshipped, like the guard hook.
const SECRETS_SPECIFIER = '@kynesyslabs/dacs-node/secrets';
let spyUrl = null;

/** Receives the spy module's URL from `register(..., { data })`. */
export async function initialize(data) {
  spyUrl = data.spyUrl;
}

/** Serves the spy for the secrets subpath; every other specifier resolves unchanged. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === SECRETS_SPECIFIER) return { url: spyUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
