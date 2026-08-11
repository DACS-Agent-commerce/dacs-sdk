/**
 * Role-neutral DACS-5 completed-bundle counter-signing and publication.
 *
 * The implementation is shared with the historical buyer surface so existing
 * callers retain their API while buyer and distinct-orchestrator processes can
 * each authenticate the seller handoff and publish only their own role copy.
 */
export {
  createCompletedCounterpartyBundleCounterSignature,
  finalizeCompletedCounterpartyBundleCore,
  type AnchoredCounterpartyBundle,
  type CounterpartyBundleFinalizationProvider,
  type CounterpartyBundleLookup,
  type CounterpartyBundleRole,
  type CounterpartySigningSessionParty,
  type CreateCompletedCounterpartyBundleCounterSignatureInput,
  type FinalizeCompletedCounterpartyBundleInput,
  type FinalizedCounterpartyBundle,
} from "./buyerBundleFinalization.js";
