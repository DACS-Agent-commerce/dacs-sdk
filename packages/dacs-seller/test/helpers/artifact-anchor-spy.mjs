// A pass-through spy for the devnet demo artifact anchor, served by artifact-anchor-spy-hook.mjs to a spied copy of the
// wallet-session module. It builds the real anchor and records the options each composition passed.
import { register } from 'node:module';
import { createDevnetDemoArtifactAnchor as createRealAnchor } from '../../src/devnet-demo/artifact-anchor.mjs';

const SPY_QUERY = '?anchor-spy';

/** The options of every anchor the spied wallet-session module composed, in order. */
export const anchorOptions = [];

/**
 * `anchorSubstitute.build(options)`, while set, is called with the options a composition passed and returns the anchor the
 * composition gets in place of the real one; with it null the real anchor is built.
 */
export const anchorSubstitute = { build: null };

/** The anchor over `options`, after recording them: the substitute's while one is set, otherwise the real one. */
export function createDevnetDemoArtifactAnchor(options) {
  anchorOptions.push(options);
  return anchorSubstitute.build ? anchorSubstitute.build(options) : createRealAnchor(options);
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
