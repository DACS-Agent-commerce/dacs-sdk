# Buyer bundle finalization trust boundary

`verifyFinalizedSessionSettlement` authenticates one finalized settlement
observation. It verifies the signed `SettlementEvidence`, its exact PC-2 anchor
(`dacs4:payment:{jobId}:{CF-4 railId}:{phaseIndex}[:resolved]`), the finalized
anchor receipt, the content-addressed native proof, live rail finality, and the
canonical event/instruction-level SB-1 settlement identity. Current contexts
require canonical uppercase ULID job IDs before PC-2 address derivation.

For a failed settlement, retain the exact handler result in the authenticated
`SessionSettlementContext.phaseResult`, for example
`{ ok: false, errorClass: "substrate" }`. Its error class must be one of
`permanent`, `transient`, `counterparty`, `substrate`, or
`settlement-atomicity`; PC-4 allows `settlement-atomicity` only for cross-chain
payment phases, so any other phase carrying it is rejected. A missing failure
result is a configuration `error`: the signed free-text evidence reason cannot
substitute for a handler classification, and retrying cannot supply the missing
input.
Successful contexts may also supply the exact result and transaction refs;
when supplied they must agree with the signed evidence.

The returned `AuthenticatedSessionSettlementObservation` is deliberately not:

- an irreversible payment, fulfilment, signing, or publication permit;
- proof that the settlement identity is unique in a consumer's evidence set; or
- authority to count the session in reputation.

Buyer bundle effects are authorized only after independently authenticating the
seller counter-signature request and finalized seller result. Those seller
artifacts inherit the exact one-shot consumed payment authorization retained by
the seller fulfilment stack. Recovery reauthenticates the retained seller state
and the live settlement observation before continuing.

DACS-4 SB-2 applies to the complete presented evidence set. A collision across
`(jobId, phaseIndex)` tuples makes the whole group indeterminate and non-countable
unless independently authenticated settlement-side authority binds the exact
canonical settlement identity, pinned rail/profile, job ID and phase index to
one tuple. Timestamps, evidence hashes and publication order cannot select a
winner. A later collision requires recomputing the group and removing any
provisional count. This point verifier supplies no global uniqueness authority.

`resolveSettlementEventIdentity` now reports `indeterminate` for an otherwise
valid point projection: an arrival-order `priorClaims` index cannot authorize
its first claimant. Use `resolveSettlementEventIdentities` with the complete
presented evidence set and count only its deduplicated `countable` list. Re-run
it over the expanded set when evidence arrives later; replace prior counts with
the new list. Distinct event indices in a batched transaction remain distinct.
Collisions select nobody unless the trusted `authenticateCollision` capability
verifies finalized settlement-side authority for the exact settlement ID,
RailDefinition hash, registered binding profile, job ID and phase index supplied
by authenticated agreement context. A job-only Permit2 or AP2 proof cannot
supply phase authority. Absent, incomplete or conflicting authority leaves the
whole group indeterminate. The callback must verify the proof; returning caller
fields or trusting an outer evidence signature violates its contract.
