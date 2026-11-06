// Module resolve hook for the seller tests (registered by
// payment-evidence-wallet-sdk.mjs): demosdk 4.0.16 publishes one extensionless
// ESM directory import, demoswork/operations/, which plain Node refuses. The
// same rule as packages/dacs-node/src/demosLoaderHook.ts, in JavaScript, since
// the seller tests run on Node 20 before the host kit is built.
const DEMOS_OPERATIONS_DIRECTORY = '/@kynesyslabs/demosdk/build/demoswork/operations/';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT' || typeof error.url !== 'string' || !error.url.endsWith(DEMOS_OPERATIONS_DIRECTORY)) throw error;
    return { url: new URL('index.js', error.url).href, shortCircuit: true };
  }
}
