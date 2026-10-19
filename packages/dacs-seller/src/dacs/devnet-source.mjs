// The devnet source transport (the operator wallet's pinned node connection)
// is not part of this package. The native adapters accept it only as an
// opaque object that its own constructor registered, so here no value is
// one: every branch that needs that transport refuses instead of running.
// The labels are the publication policy those adapters compare with.
export const DEVNET_AGREEMENT_PROFILE = 'devnet-agreement';
export const DEVNET_DEMO_ARTIFACT_KIND = 'devnet-demo-artifact-storage-create';
export const DEVNET_DEMO_ARTIFACT_POLICY = 'dacs-devnet-demo-artifacts/v1';
export const DEVNET_DEMO_ARTIFACT_TYPES = Object.freeze(['CompositeVerificationRecord', 'Deliverable', 'FinalityCommitmentRecord', 'Listing']);

export const isDevnetAgreementTransport = () => false;
export const isDevnetSettlementTransport = () => false;
export const isDevnetDemoTransport = () => false;
