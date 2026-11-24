// Answers the two fresh chain readbacks the active handoff and the first wallet guard read make, the buyer's Agreement
// CREATE readback and the seller's finalized commitment readback, from what the world retained for each purchase, and
// counts each call. Every other module, the protocol and service included, is the real one.
import * as moduleApi from 'node:module';

const STATE_KEY = Symbol.for('TEST-retained-native-readbacks');
const STATE = "globalThis[Symbol.for('TEST-retained-native-readbacks')]";
const source = (name) => new URL(`../../src/dacs/${name}.mjs`, import.meta.url).href;
const replaced = (name, text) => ({ url: 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(source(name))}; ${text}`), shortCircuit: true });

export function resolve(specifier, context, next) {
  if (context.parentURL === source('native-agreement-payment-consumer') && specifier.endsWith('/seller-sr2-agreement-consumer.mjs')) {
    return replaced('seller-sr2-agreement-consumer', `export const createSellerSr2AgreementAnchor = () => ${STATE}.agreementReader;`);
  }
  if (context.parentURL === source('protocol-purchases') && specifier.endsWith('/buyer-chain-readback.mjs')) {
    return replaced('buyer-chain-readback', `export const createBuyerChainReadback = () => ${STATE}.commitmentReader;`);
  }
  return next(specifier, context);
}

/**
 * Installs the stand-ins; call before the first import of any module under src/. Returns their state: `agreements` (logical
 * address to retained AnchorReceipt) and `commitments` (job id to retained commitment summary), which the world fills, and
 * `reads`, the count of each readback.
 */
export function installRetainedReadbackStandIns() {
  const state = { agreements: new Map(), commitments: new Map(), reads: { agreement: 0, commitment: 0 } };
  state.agreementReader = {
    async readAgreement({ logicalAddress }) {
      state.reads.agreement++;
      const receipt = state.agreements.get(logicalAddress);
      if (!receipt) return { disposition: 'indeterminate', reason: 'TEST-no-retained-agreement' };
      return { disposition: 'present', native: { nativeAddress: receipt.nativeAddress, txRef: { writeTxHash: receipt.transactionRef.value }, receipt } };
    },
    async recheckAgreement() { state.reads.agreement++; return { disposition: 'present' }; },
  };
  state.commitmentReader = {
    async readCommitment({ agreement }) {
      state.reads.commitment++;
      const commitment = state.commitments.get(agreement.jobId);
      return commitment ? { status: 'verified', ...commitment } : { status: 'indeterminate', reason: 'TEST-no-retained-commitment' };
    },
  };
  globalThis[STATE_KEY] = state;
  if (moduleApi.registerHooks) moduleApi.registerHooks({ resolve });
  else moduleApi.register(import.meta.url);
  return state;
}
