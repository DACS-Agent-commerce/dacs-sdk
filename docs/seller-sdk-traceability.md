# Seller SDK traceability

This audit uses the DACS Standard [`next` branch at commit
`c2ecd9fa658776f5511f2414d7b4c3e23b847463`](https://github.com/DACS-Agent-commerce/DACS-Standard/tree/c2ecd9fa658776f5511f2414d7b4c3e23b847463)
as the current normative source.
The SDK conformance runner remains reproducibly pinned by
`scripts/sync-vectors.mjs` to [Standard commit
`c2ecd9fa658776f5511f2414d7b4c3e23b847463`](https://github.com/DACS-Agent-commerce/DACS-Standard/tree/c2ecd9fa658776f5511f2414d7b4c3e23b847463).

This document describes only public DACS behavior. The SDK core must not depend
on a private service, deployment, transport, repository, or URL.

## Standard to SDK matrix

| Concern | Normative source | Required public behavior | `main` baseline before this PR | Tracker / focused delivery |
| --- | --- | --- | --- | --- |
| Listing artifact and seller identity | DACS-1 §6.3.4 (`Listing`, `ListingSignature`, reader validation steps 1–9; LP-1..LP-6; LR-1..LR-3); DACS-1 §6.3.2 (`IdentityBundle`); DACS-1 §6.3.3 (`BundleRequirement`); CORE §B.7 (SIG-1..SIG-6) | New publications use the complete normative `Listing` shape. `seller.identity` is the publisher identity, `seller.displayName` is bounded to 200 characters, and optional `seller.publicEndpoint` is HTTPS. The normative structural predicate permits a signer from `seller.identity.claims`; until the SDK verifies the complete IdentityBundle presentation, operational discovery and session admission apply the producer profile `signature.signer == seller.identity.presentedBy` so an unproven claim cannot become the payee. The signature is structured, domain-separated, and unpadded Base64URL. Unknown inert fields remain in the signed scope, while unknown action variants fail closed. | `Listing` is a reduced MVP artifact (`agentId`, `serviceId`, flat capability arrays) with a legacy string signature. Shape validation and signing are non-normative. | #5 (shared type/validator substrate), #41 (Listing signature migration). This focused PR adds normative Listing publication and an explicit legacy-read boundary; it does not claim full DACS-1 reader-disposition or rail-registry conformance. |
| Listing engagement and reachability | DACS-1 §6.3.4 “Operational engagement and reachability” (LP-5); §6.3.6 (`reachabilityHint` and bounded server-side probing); Standard PR #296 | `seller.publicEndpoint`, when present, is an HTTPS engagement surface. Reachability is operational evidence only: it never changes hash, signature, validity, revocation, identity, or reputation. Network probing is outside artifact validation and must apply the §6.3.6 SSRF, DNS-rebinding, redirect, timeout, response-size, and ambient-credential controls. Non-HTTPS coordinates are owned by the applicable negotiation or rail registry; the SDK must not invent `communication[]`. | No normative seller structure or public endpoint. Discovery accepts caller-supplied anchor refs and has no endpoint projection. | #112 adds a separate operational result plus HTTPS, DNS/public-address, redirect, timeout, response-size, and credential-free probe contracts. Hosted HTTP/WebSocket/L2PS surfaces remain outside core. |
| Attested-payload Listing coherence | DACS-4 §9.6.3 DPA-1 and DPA-4; §9.12 compatibility; DACS-1 §6.3.4 reader step 7 | A Listing selecting `deliver-attested-payload` resolves an `attested-payload` deliverable with a present, well-formed method that the local producer or verifier can execute over the exact payload bytes. Unsupported configuration rejects before session/payment; dependency failures remain `indeterminate`/`error`. The complete signed method and DeliverableSpec, including inert extensions, determine their hashes. | A recognized method discriminator is treated as sufficient even when no local implementation or dependency is available. | #137/#138 add the static step-7 gate and an injected, transport-neutral producer/verifier capability resolver before publication or session admission. |
| Exact Listing version pin | DACS-1 §6.3.4 versioning and LR-1; DACS-3 §8.4.1 `listingHash` / `listingRef`; DACS-3 §8.5 `AgreementArtifact.listingRef` | A session pins `(listingId, listingVersion, contentHash)` from the exact verified listing bytes. Newer listing versions never alter a committed or in-progress session. | Bundle production partially derives a version but falls back from reduced fields; the reduced agreement carries only a string anchor ref. | #98 owns complete agreement fidelity. This focused PR introduces one exact `ListingPin` derivation and uses it wherever the existing session path records a Listing tuple; no new agreement shape is invented. |
| Fixed-price term derivation | DACS-3 §8.4.1 procedure 1–5; §8.5.2 checks 1–9 and MTR-1..MTR-5; DACS-4 §9.3 (`PricingSpec`, `PriceTerm`, `DeliverableSpec`, `PaymentRailRef`) | Copy fixed terms from the pinned Listing, select a complete accepted rail, hash the anchored deliverable, derive the deadline, reject unsupported pricing variants, and never accept caller-selected economic terms as authority. | `runSessionCore` accepts caller-selected price, delivery, and expiry after membership-only checks. | #98. Separate post-Listing PR; not widened into this PR. |
| Seller authorization | DACS-3 §8.4.1 steps 2–3 and auto-accept rules; §8.5 (`AgreementSignature`); §8.5.2; CORE §B.7 | Fixed-price agreements carry valid buyer and seller signatures. Auto-accept requires an anchored, unrevoked, in-window commitment plus a live per-instance seller signature bound to the agreement hash. | Buyer/orchestrator-only agreement and final bundle production; strict verification correctly refuses the missing seller authorization. | #17 (seller lifecycle), #53 (RFQ buyer/seller), #81 (strict bundle producer), #98 (fixed-price authorization). |
| Agreement commitment | DACS-3 §8.6 (CA-1..CA-9; `FinalityCommitmentRecord` / legacy `CommitmentRecord`); DACS-3 §8.5.2 post-finality deadline and validity checks | Validate listing conformance and party signatures, anchor the type-correct commitment, obtain a verified finalized receipt, derive authoritative `committedAt`, and enter DACS-4 only after an `ok` commitment. Retries reconcile the same immutable commitment. | The session anchors the reduced agreement and can settle after broadcast acceptance. | #99. Separate focused PR after normative agreement construction. |
| Payment destination and payment evidence | DACS-3 §8.5 (`PayeeBoundAgreementDocument`, `PayoutBinding`); DACS-4 §9.5.1 (PC-1..PC-7, PB-1..PB-3); §9.5.7 (X402-1..X402-4); §9.5.8 (SB-1..SB-3); §9.5.9 (pay-DEM); §9.7 (`SettlementEvidence`) | Verify the co-signed payout destination before payment, bind settlement to `(jobId, phaseIndex)`, preserve the rail-specific transaction reference and actual finality, and anchor finalized evidence without resubmitting a rail-final payment. | Buyer rail seams exist; x402/EVM evidence is reduced. There is no transport-neutral seller payment-intake verifier. | #24 (x402 seller/paywall), #33 (settlement identity), #94 (atomic evidence impact), #102 (rail-specific receipts/finality). A seller-side pay-DEM/x402 intake-verification tracker is genuinely missing. |
| Delivery evidence | DACS-4 §9.6.1–§9.6.3; §9.7 (delivery `SettlementEvidence`); DACS-5 §10.4.3 required references | Invoke an application callback only after the required payment gate, validate the declared delivery variant, anchor delivery evidence, and include its reference in both final bundle copies. Unsupported delivery variants fail closed. | Delivery is a caller-selected string and the bundle has no high-level fulfilment/evidence seam. | #15 (delivery evidence in bundle), #17 (seller fulfilment), #55 (durable seller recovery). |
| Two-sided final bundles | DACS-5 §10.4, especially §10.4.1 signatures, §10.4.2 BB-1..BB-8, and §10.4.3 production/consumption rules; DACS-5 §10.3.1 ST-11 | Produce role-specific, canonically equal buyer and seller copies, collect required signatures, verify finalized referenced artifacts, publish signed bindings where native addresses cannot be recomputed, and remain `audit-pending` until both copies are final and resolvable. | Low-level two-sided/FaultAttestationBundle support exists; `runSessionCore` emits a legacy buyer-only bundle that strict verification rejects. | #81, with #15 for delivery references and #54 for public binding/index resolution. |
| Replay, retry, and recovery | CORE §B.8 (SN-1..SN-4); DACS-4 §9.5.1 PC-7, §9.5.6 AP2-5/AP2-6, §9.5.7 X402 retry rules, §9.5.8 SB-1..SB-3; DACS-5 §10.3.1 ST-1, ST-7..ST-11; DACS-5 §10.11 | Persist exact session/listing/agreement/payment/delivery identities; enforce single-use session and settlement identifiers; reconcile ambiguous external effects before retry; never repeat payment or fulfilment after restart; resume only the recorded forward state; keep finalization pending until all required evidence is finalized and resolvable. | `SessionStore` primitives and buyer-side integration exist, but `createAgent().runSession()` does not expose durable-store wiring and there is no seller lifecycle. | #55 (seller recovery), #33 (settlement uniqueness), #81 (bundle finalization), #92 (atomic rollback/idempotency). |

## Tracker disposition

Existing trackers already cover the following delivery slices:

- #5 and #41: shared normative type/validator work and Listing signature migration.
- #54: typed Demos artifact storage, logical/native bindings, and indexing.
- #98 and #99: fixed-price terms/seller authorization and finalized agreement commitment.
- #17 and #53: transport-independent seller lifecycle and RFQ seller behavior.
- #24 and #102: x402 server mechanics and rail-specific receipt/finality evidence.
- #15 and #55: delivery evidence plus durable seller recovery.
- #81: strict two-party final bundle production.

Genuinely missing SDK trackers after this audit:

1. Normative Listing fidelity and engagement, including `seller.publicEndpoint`,
   explicit legacy reads, current-only writes, and exact Listing pins. This focused
   PR is the implementation vehicle; a tracker is still useful for any reader
   validation left after merge.
2. Transport-independent seller-side payment-intake verification shared by
   pay-DEM and x402. #24 is specifically an HTTP x402 paywall and #102 is
   rail-receipt production; neither owns the generic seller gate.
3. A funded two-agent E2E proving Listing publication, engagement, seller
   authorization, payment verification, delivery evidence, restart safety, and
   strict two-sided finalization using only public SDK APIs.

## Focused Listing PR boundary

The first PR implements only the DACS-1 artifact boundary:

- normative Listing and nested public types from DACS-1 §6.3.2–§6.3.4 and
  DACS-4 §9.3;
- structural validation of every normative field and closed action variant;
- `seller.publicEndpoint` HTTPS validation without network access or probing;
- structured Listing signatures under CORE §B.7 and DACS-1 §6.3.4;
- an explicit `LegacyMvpListing` read path; publication rejects it;
- one exact `(listingId, listingVersion, contentHash)` session pin; and
- Standard-backed positive and negative vector tests, including SIG-5
  preserve-unknown and unknown-phase refusal.

## Listing validation-disposition PR (#112)

The follow-on PR implements the reader and publisher gates deliberately left
out of the artifact-fidelity PR:

| SDK surface | Normative source | Conformance evidence |
| --- | --- | --- |
| `validateListingArtifact` / `ListingValidationDisposition` | DACS-1 §6.3.4 reader steps 1–9, LR-2/LR-3 | Ordered positive/negative tests, including LRR-indeterminate followed by signer rejection |
| `RevocationMarker`, `RevocationBinding`, `checkListingRevocation` | DACS-1 §6.3.4 RB-1..RB-6; CORE §B.7 | All 14 `revocation-binding-v0.3` Standard vectors |
| `resolveListingRails` | DACS-1 §6.3.4 LRR-1..LRR-6; DACS-4 §9.4.3 RD-1..RD-6 | All 29 `listing-rail-registry-resolution-v0.4` vectors from Standard `next` commit `c2ecd9fa658776f5511f2414d7b4c3e23b847463` |
| pay-bearing publication gate | DACS-1 §6.3.4 LP-6 | Rejects missing, rejected, and indeterminate authority before signing/anchoring |
| normative discovery/session-admission gates | DACS-1 §6.3.4 LRR-5, LR-2/LR-3 | Discovery returns only exact-hash `verified` Listings; `runSessionCore` rejects `rejected`, `revoked`, and `indeterminate` before Vet/payment |
| `assessListingReachability` | DACS-1 §6.3.4 LP-5; §6.3.6 | Separate operational evidence with private-address, DNS, redirect, timeout, size, and no-credential controls |

The registry and discovery reads remain injected and substrate-neutral. The SDK
owns their normative evaluation and precedence; no private URL, transport,
hosted catalog, or in-code fallback is assumed.

Fixed-price agreement derivation (DACS-3 §8.4.1/§8.5.2), hosting, payment,
delivery, and final bundle production remain in their focused trackers above.
