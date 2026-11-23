// A pass-through spy for the devnet demo artifact anchor, served by artifact-anchor-spy-hook.mjs to a spied copy of the
// wallet-session module. It builds the real anchor and records the options each composition passed.
import { register } from 'node:module';
import { createDevnetDemoArtifactAnchor as createRealAnchor } from '../../src/devnet-demo/artifact-anchor.mjs';

const SPY_QUERY = '?anchor-spy';

/** The options of every anchor the spied wallet-session module composed, in order. */
export const anchorOptions = [];

/** The real anchor over `options`, after recording them. */
export function createDevnetDemoArtifactAnchor(options) {
  anchorOptions.push(options);
  return createRealAnchor(options);
}

let spiedModule = null;
/** A copy of src/devnet-demo/seller-wallet-session.mjs whose anchor composition goes through this spy. */
export async function importSpiedWalletSession() {
  if (spiedModule === null) {
    register('./artifact-anchor-spy-hook.mjs', import.meta.url, { data: { spyUrl: import.meta.url, query: SPY_QUERY } });
    spiedModule = await import(`../../src/devnet-demo/seller-wallet-session.mjs${SPY_QUERY}`);
  }
  return spiedModule;
}
