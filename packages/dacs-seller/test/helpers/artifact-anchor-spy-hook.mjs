// Module-customization hook behind importSpiedWalletSession: a copy of the wallet-session module loaded with the spy query
// imports the artifact-anchor spy in place of the anchor module. Unshipped, like the guard hook.
const ANCHOR_SPECIFIER = './artifact-anchor.mjs';
let spy = null;

/** Receives the spy module's URL and the query that marks the spied copy from `register(..., { data })`. */
export async function initialize(data) {
  spy = data;
}

/** Serves the spy for the spied copy's anchor import; every other specifier resolves unchanged. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === ANCHOR_SPECIFIER && context.parentURL !== undefined && new URL(context.parentURL).search === spy.query) return { url: spy.spyUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
