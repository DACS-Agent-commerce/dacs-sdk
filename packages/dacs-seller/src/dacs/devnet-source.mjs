// The devnet source transport is the client's: the held facade of its Node seller
// composition (`@kynesyslabs/dacs-client/node-wallet`), which the seller's Node
// wallet builds (src/devnet-demo/seller-node-wallet.mjs). The native adapters
// accept only an object the client registered, so these are the client's own
// checks and publication labels, re-exported so the kit has one source for them.
export {
  DEVNET_AGREEMENT_PROFILE,
  DEVNET_DEMO_ARTIFACT_KIND,
  DEVNET_DEMO_ARTIFACT_POLICY,
  DEVNET_DEMO_ARTIFACT_TYPES,
  isDevnetAgreementTransport,
  isDevnetDemoTransport,
  isDevnetSettlementTransport,
} from '@kynesyslabs/dacs-client/node-wallet';
