# Seller completed-bundle finalization

`finalizeCompletedSellerBundleCore` is the transport- and substrate-independent
seller implementation of the DACS-5 completed-bundle audit gate. It consumes a
verified payee-bound agreement and the completed delivery contribution emitted
by `runFulfilmentCore`; it does not host HTTP, WebSocket, L2PS, or any private
application service.

The implementation follows the repository's reproducibly vendored
DACS-Standard `next` oracle. The package remains on the common public
`DACS_SPEC_VERSION = "0.1"` baseline; the applicable chapter is the draft
DACS-5 v0.4 line in that oracle. Changes to the oracle still require the SDK's
normal Standard pin/version review before release.

## Normative traceability

| SDK behavior | Normative source | Enforcement |
| --- | --- | --- |
| Completed commercial performance remains non-terminal until audit publication completes | DACS-5 §10.3 ST-6, ST-11 | The only successful result is `state: "finalised"`; no partial result is labelled terminal. |
| Every referenced Listing, agreement, commitment/phase attestation, vet record, settlement/delivery evidence, amendment, and rating has exact finalized receipt coverage | DACS-5 §10.3 ST-11(1); CORE §5.1 SR2-6, SR2-8, SR2-9 | Dependency hashes must have exact one-to-one coverage by structurally valid, `finalized`, `established` `AnchorReceipt`s. |
| Finality assertions are independently authenticated | CORE §5.1 SR2-4..SR2-7; DACS-5 §10.3 ST-11(1) | The substrate binding must return `valid` from `verifyDependencyReceipt`; every other disposition fails closed. |
| Every receipt's native artifact is independently readable, canonically re-hashed, and session-bound | CORE §5.1 read trichotomy and SR2-9; DACS-5 §10.3 ST-11(2) | `absent` contradicts a finalized receipt; `indeterminate` pauses progress; `present` is re-hashed locally and passed through artifact-specific logical/session binding verification. |
| Completed bundle uses the exact `FaultAttestationBundle` v1 shape and all required signatures | DACS-5 §10.4.1; ST-11(3) | The core pre-validates the unsigned normative scope, then delegates signing to `buildTwoSidedBundle` and independently verifies the produced signatures. Unknown fields, phase kinds, outcomes, or missing required signers are rejected. |
| Delivery evidence is included once in `phaseSummary` and `settlementEvidence` | DACS-5 §10.4.1, §10.4.3; DACS-4 §9.7 | The exact `SellerBundleContribution` hash/ref is appended idempotently; conflicting indexes or references are rejected. |
| Seller anchors only its seller-role copy at the deterministic logical address | DACS-5 §10.4.2 | The address is `stor-{sha256(jobId + "-bundle-seller")}` and the anchored copy must carry `anchoredByRole: "seller"`. Buyer/orchestrator copies are returned for their own independent publication. |
| Existing content is resolved before any write and never overwritten on ambiguity | CORE §5.1 read trichotomy; SR2-9; DACS-5 §10.4.2 | `indeterminate` is never treated as `absent`; an existing exact verified copy resumes without signing or submission. A thrown submission is reconciled by hash before the caller is told to resolve before retry. |
| Bundle anchor is finalized, independently readable, hash-bound, and proof-verified | DACS-5 §10.3 ST-11(3); CORE §5.1 SR2-4..SR2-9 | The resolved copy, logical/native address, `attestation_bundle_hash`, finalized receipt, and binding-native proof must all verify. |
| Write-input mappings publish the exact signed `BundleBinding`; pure mappings do not | DACS-5 §10.3 ST-11(4); §10.4.2 BB-1, BB-4, BB-5 | The SDK emits the normative object under `dacs-bundle-binding:v1:`, requires top-level and signature signer equality, derives the logical address from the signed tuple, and verifies the signature before publication. |

## Provider contract

The provider keeps substrate facts explicit:

- Reads return `present`, authoritative `absent`, or `indeterminate`.
- Receipt, artifact-binding, bundle-signature, and binding-signature checks
  return `valid`, `invalid`, `indeterminate`, or `error`; only `valid` passes.
- A write-input mapping must supply binding resolution, verification, and
  publication. A pure mapping must not publish a `BundleBinding`.
- `verifyDependencyBinding` owns artifact-specific logical-address, signer,
  session, and receipt-native checks after the core has independently recomputed
  the canonical content hash.

These are operational interfaces, not new signed wire types.

## Deliberate scope boundary

This core advances seller bundle production in #17 and the delivery-evidence
path in #15. It does not close durable recovery #55: bundle intent/outcome,
anchor-reconciliation, and binding-publication checkpoints belong in the next
focused durability layer. It also does not publish the buyer copy on the
seller's behalf or replace buyer session orchestration #81; each signing party
anchors its own role-specific copy as required by DACS-5 §10.4.2.
