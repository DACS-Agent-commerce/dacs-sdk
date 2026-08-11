# Seller completed-bundle finalization

`finalizeCompletedSellerBundleCore` is the transport- and substrate-independent
seller implementation of the DACS-5 completed-bundle audit gate. It consumes a
verified payee-bound agreement and the completed delivery contribution emitted
by `runFulfilmentCore`, plus the canonical off-chain DACS-5 `SessionRecord` in
`audit-pending`. It does not host HTTP, WebSocket, L2PS, or any private
application service. `prepareCompletedSellerBundleCounterSignatureRequest`
exports the exact normative signed scope and bytes for an out-of-band buyer
review/sign step; the seller API never receives a buyer private key or invokes a
buyer signing oracle.

The implementation follows the repository's reproducibly vendored
DACS-Standard `next` oracle. The package remains on the common public
`DACS_SPEC_VERSION = "0.1"` baseline; the applicable chapter is the draft
DACS-5 v0.4 line in that oracle. Changes to the oracle still require the SDK's
normal Standard pin/version review before release.

## Normative traceability

| SDK behavior | Normative source | Enforcement |
| --- | --- | --- |
| Completed commercial performance remains non-terminal until audit publication completes | DACS-5 §10.3 ST-6, ST-11 | The only successful result is `state: "finalised"`; no partial result is labelled terminal. |
| Bundle facts are derived from one complete canonical session | DACS-5 §10.3, §10.3.2, §10.4.3 | The input record must be `recordVersion: "1"`, `audit-pending`, forward-complete, and contain exactly one `PhaseEntry` for every pinned pipeline step. Phase outcomes and registry pins cannot be supplied separately. A declined/failed rate remains non-fatal under ST-5. |
| Listing publisher and agreement roles come from the executed negotiation mode | DACS-1 §6.3.4; DACS-3 §8.4.3 SE-8 | Exactly one successful negotiation result must be retained under its exact `contextDelta` key and bind the resolved agreement. Ordinary modes map the Listing publisher to agreement seller; procurement maps it to agreement buyer and the winning bidder to agreement seller. The Listing logical address is checked under that publisher claim. |
| Published and post-Vet IdentityBundles are linked without equating their hashes | DACS-1 §6.3.2 | The published bundle must present the negotiation-derived publisher claim. `verifyListingPublisherIdentityLinkage` must authenticate the same primary-claim/key lineage against the exact post-Vet session bundle hash; a fresh session nonce may legitimately make the hashes different. |
| Optional phase pointers do not become mandatory by accident | DACS-5 §10.4.3 “Per-phase `attestationRef` (optional)” | `CompletedSellerSessionArtifacts` retains the commitment, composite-Vet, settlement, and rating candidate refs beside (not inside) the normative SessionRecord. Every candidate is resolved and assigned to the canonical session before it enters the authoritative top-level bundle sets; an omitted phase pointer is accepted, while a present pointer must agree. |
| Unsupported repeated-delivery identity fails closed | DACS-5 §10.4.3; DACS Standard issue #329 | A non-payment evidence ref may fill an omitted phase pointer only when exactly one still-unmatched phase has the same kind/outcome. Two pointerless repeated delivery candidates are rejected as ambiguous; inventory order is never treated as normative identity. |
| Every direct and transitive dependency has exact finalized receipt coverage | DACS-2 §7.7; DACS-5 §10.3 ST-11(1), §10.4.3; CORE §5.1 SR2-6, SR2-8, SR2-9 | Typed dependency sources must exactly cover the recursively discovered graph. The walk includes current-shape CompositeVerificationRecords, their freshness/deal-specific VerifyResults and authority attestations, Listing IdentityBundle VerifyResults, agreement party vet refs, raw-byte price anchors, amendments, ST-8 supersession, delivered content, and the full DPA payload-attestation chain. Extra or missing nodes fail closed. |
| Every Vet record retains its exact requirement invocation and is aggregated locally | DACS-2 §7.7, §7.7.1, §7.8 VPC-2; DACS-Standard #331 | `vetRequirements` contains exactly one tuple per Vet ref: evaluated party, exact `BundleRequirement`, and verifier. Listing-owned requirements are mapped by negotiation mode and must equal the pinned Listing body. Every invocation passes the mandatory provenance verifier; the complementary requirement therefore fails closed pending #331. The SDK resolves the current VerifyResults and recomputes §7.7.1 instead of trusting `overallDecision` or a provider assertion. |
| Finality assertions are independently authenticated | CORE §5.1 SR2-4..SR2-7; DACS-5 §10.3 ST-11(1) | The substrate binding must return `valid` from `verifyDependencyReceipt`; every other disposition fails closed. |
| Every receipt's native artifact is independently readable, locally re-hashed with the artifact-appropriate hash, and session-bound | CORE §5.1 read trichotomy and SR2-9; DACS-5 §10.3 ST-11(2) | `absent` contradicts a finalized receipt; `indeterminate` pauses progress. Signed JSON artifacts use their normative signature omission; ordinary JSON deliverables hash their complete JCS bytes; attested payloads hash the exact raw bytes. |
| Attested deliveries close the complete proof chain | DACS-4 §9.6.3 DPA-2..DPA-9; DACS-5 §10.4.3 | The core resolves `SettlementEvidence → PayloadAttestationRecord → methodEvidenceRef` and the exact delivered bytes, checks commerce/method hashes locally, then requires `verifyPayloadMethodProof` to establish that method-native evidence commits to those bytes. Any method-defined native transaction is authenticated separately. The evidence signer cannot substitute for either proof. |
| Amendments and ST-8 supersession remain auditable | DACS-4 §9.5.1 PC-2, §9.7.1 AMEND-1..AMEND-4; DACS-5 §10.3 ST-8, §10.4.3 | Amendment targets are resolved, session/job/outcome/currency bindings are checked, aggregate refunds cannot exceed settled value, and a superseding success must bind one prior same-phase failure that is omitted from the top-level settlement set. Both interim and `:resolved` anchors are authenticated independently and must preserve the exact `(jobId, railId, phaseIndex)` tuple. |
| Completed bundle uses the exact `FaultAttestationBundle` v1 shape and all required signatures | DACS-5 §10.4.1; ST-11(3) | The buyer (and distinct orchestrator) signs the exported detached scope. The seller ingests those signatures, adds only its own signature, then the SDK locally resolves keys and verifies the exact, duplicate-free required signer set. Unknown algorithms/variants fail closed. The same local gate applies on resume. |
| Bundle signatures have one canonical wire encoding and role copies do not alias | CORE §B.7 SIG-6; DACS-5 §10.4.1; SDK #101 | The structural validator, `verifyBundleCopy`, detached assembly, and resumed-bundle path all require canonical unpadded Base64URL (including zero residual pad bits). Seller, buyer, and orchestrator role copies are deep snapshots; mutating one returned copy cannot change another. |
| Delivery evidence is derived once from the executed SessionRecord | DACS-5 §10.4.1, §10.4.3; DACS-4 §9.7 | Every pay/deliver invocation contributes exactly one independently verified top-level evidence ref. Evidence phase, outcome, orchestrator authority, and any duplicated payment tx refs must match an executed SessionRecord entry. The `runFulfilmentCore` result must identify the same delivery invocation and evidence ref; caller-selected gaps or non-contiguous indexes are rejected. |
| Repeated payment phases cannot reuse an evidence anchor | DACS-4 §9.5.1 PC-2, §9.5.8 SB-1 | `resolvePaymentPhaseIndex` must recover the authenticated phase index from the payment-evidence anchor (or substrate-equivalent binding). The core requires the exact still-unmatched pipeline entry and rejects duplicate or contradictory index bindings. |
| Seller anchors only its seller-role copy at the deterministic logical address | DACS-5 §10.4.2 | The address is `stor-{sha256(jobId + "-bundle-seller")}` and the anchored copy must carry `anchoredByRole: "seller"`. Buyer/orchestrator copies are returned for their own independent publication. |
| Existing content is resolved before any write and never overwritten on ambiguity | CORE §5.1 read trichotomy; SR2-9; DACS-5 §10.4.2 | `indeterminate` is never treated as `absent`; an existing exact verified copy resumes without signing or submission. A thrown submission is reconciled by hash before the caller is told to resolve before retry. |
| Bundle anchor is finalized, independently readable, hash-bound, and proof-verified | DACS-5 §10.3 ST-11(3); CORE §5.1 SR2-4..SR2-9 | The resolved copy, logical/native address, `attestation_bundle_hash`, finalized receipt, and binding-native proof must all verify. |
| Write-input mappings publish and read back the exact signed `BundleBinding`; pure mappings do not | DACS-5 §10.3 ST-11(4); §10.4.2 BB-1, BB-4, BB-5, BB-7 | The SDK emits the normative object under `dacs-bundle-binding:v1:`, locally verifies its seller signature, publishes it, then independently resolves the exact signed binding before returning. Optional `anchorTx` learning/loss cannot invalidate an otherwise identical mapping, but conflicting known pointers fail. |
| Bundle recovery inherits the exact consumed fulfilment authority | DACS-4 §9.5.8 SB-1/SB-2; DACS-5 §10.3 ST-7 | The durable wrapper requires an existing v2 fulfilment record and re-authenticates its complete handoff, payment authorization, delivery/evidence publication and readback spine, final receipt, terminal result, indexed receipts, SettlementEvidence signature, and anchor proof before acquiring a bundle lease. Missing state is never synthesized. |
| Restarted signature/write intents reconcile under a generation fence | DACS-5 §10.3 ST-7; CORE §5.1 read/lifecycle reconciliation | Every seller-sign, bundle-submit, binding-sign, and binding-publish invocation and reconciler receives the exact frozen `{ owner, generation, idempotencyKey }`. Re-drive is permitted only after the reconciler returns `authoritatively-absent`, which contractually means it atomically raised the adapter's minimum accepted generation. |
| Detached signatures cannot be spliced across retries | DACS-5 §10.4.1; CORE §B.7 SIG-6 | Buyer and distinct-orchestrator signatures remain out-of-band inputs, but the durable input checkpoint binds each complete `(party, algorithm, canonical value)` envelope as well as the reviewed signed bytes before any seller effect. |
| Terminal bundle state is atomic and read-only | DACS-5 §10.3 ST-1, ST-6, ST-11 | One fenced CAS appends the exact finalized-result outcome and immutable bundle receipt, enters `seller:finalised`, and releases the lease. Replay receives no signer or write capability: it re-audits the dependency closure, cryptographically verifies the exact signer set and role copies, authenticates the finalized receipt and current bundle readback, and (for write-input mappings) verifies the exact signed `BundleBinding` readback before returning the retained result. Failure cleanup never demotes terminal state or releases a successor generation. |

## Provider contract

The provider keeps substrate facts explicit:

- Reads return `present`, authoritative `absent`, or `indeterminate`.
- Receipt and artifact-binding checks
  return `valid`, `invalid`, `indeterminate`, or `error`; only `valid` passes.
- `verifyBundleAnchorReceipt` establishes the complete SR-2 proof and the
  mapping-specific logical/native binding: deterministic derivation for a pure
  mapping, or the authenticated native anchor later published in the
  `BundleBinding` for a write-input mapping.
- `bundleCopyVerifier` resolves party keys and performs cryptographic verification;
  required roles, exact signer multiplicity, algorithms, signature encoding, and
  signed scope are enforced inside the SDK rather than delegated as a boolean.
- A write-input mapping must supply binding resolution and
  publication. A pure mapping must not publish a `BundleBinding`.
- `verifyDependencyBinding` is a required authenticity gate after the core has
  independently recomputed the canonical content hash. `valid` means the
  artifact's exact domain-separated signature and authenticated authority, its
  logical/native anchor, and its session binding all verified. A finalized
  receipt or matching hash alone cannot return `valid`; raw-byte nodes apply
  their method-/pointer-specific authenticated proof instead. For a DACS-2
  CompositeVerificationRecord this includes authority and signature semantics;
  the SDK independently enforces the current §7.7 shape, session/party/bundle
  binding, exact retained requirement hash, recursive reference set, and
  deterministic §7.7.1 aggregation.
- `verifyListingPublisherIdentityLinkage` is mandatory. It resolves the exact
  session bundle named by its hash and authenticates shared primary-claim/key
  lineage with the published Listing bundle; equality of bundle hashes is not
  required and is not accepted as a substitute for linkage verification.
- `verifyVetRequirementProvenance` is mandatory for every retained Vet
  invocation. Only `valid` passes. This is the explicit fail-closed boundary for
  complementary requirement provenance while DACS-Standard #331 remains open;
  it adds no field to the signed CompositeVerificationRecord.
- `verifyPayloadMethodProof` is conditionally mandatory for
  `deliver-attested-payload`; it receives the exact Listing method, signed
  PayloadAttestationRecord, method-native evidence, and delivered bytes and must
  establish the DPA-3 commitment between them.
- `resolvePaymentPhaseIndex` is conditionally mandatory for every payment
  evidence record (including an ST-8 interim record) and must recover PC-2's
  authenticated `jobId`, `railId`, `phaseIndex`, and `resolved` discriminator;
  a caller-supplied array position or evidence body field is not accepted as
  SB-1.
- A `resolveBundleBinding` implementation on a write-input substrate is a BB-6
  candidate resolver, not a “first index hit” lookup: it must apply authorized
  signer pruning, bounded multiplicity, precedence, and fail-closed disposition
  before returning one `present` binding.

`AuditPendingSellerSessionRecord`, `CompletedSellerSessionArtifacts`, dependency
sources, and the counter-signature request are operational interfaces. They add
no field to a Listing, agreement, SettlementEvidence,
PayloadAttestationRecord, FaultAttestationBundle, or BundleBinding.

## Deliberate scope boundary

`finalizeCompletedSellerBundleDurable` composes this core with the public
`FencedSessionStoreV2`. It will not create a bundle-only session: callers must
provide the same store record completed by `runDurableFulfilmentCore`, together
with the two cryptographic verification callbacks needed to authenticate that
retained terminal fulfilment. Bundle work then advances monotonically through
`seller:bundle-signing`, anchor pending, optional binding signing/publication,
and `seller:finalised` under one unscoped generation lease.

The durability adapters must enforce the supplied fence at their own commit
boundary. In particular, `authoritatively-absent` is not an advisory read: it is
a promise that the adapter atomically registered the supplied generation as its
minimum accepted fence before reporting absence. `indeterminate`, malformed,
rejected, or thrown reconciliation never authorizes a duplicate effect.

Terminal replay is intentionally not an offline cache hit. It performs fresh
read-only authenticity checks and can pause on a resolver or verifier outage,
but the verifier is capability-narrow: seller/binding signers and bundle/binding
write callbacks are removed before the first await.

The public `getSellerBundleFinalizationStatus` projection exposes checkpoint
states and the immutable native bundle receipt without requiring an
application-specific job database. Checkpoints contain references, hashes, and
already-public signature values only; they are operational recovery state, not
new signed DACS fields.

Together the pure and durable cores advance seller bundle production in #17,
the delivery-evidence path in #15, and the remaining bundle recovery scope in
#55. They do not publish the buyer copy on the seller's behalf or replace buyer
session orchestration #81; each signing party anchors its own role-specific copy
as required by DACS-5 §10.4.2.
