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
| Payment destination and payment evidence | DACS-3 §8.5 (`PayeeBoundAgreementDocument`, `PayoutBinding`); DACS-4 §9.5.1 (PC-1..PC-7, PB-1..PB-3); §9.5.7 (X402-1..X402-4); §9.5.8 (SB-1..SB-3); §9.5.9 (pay-DEM); §9.7 (`SettlementEvidence`) | Verify the co-signed payout destination before payment, bind settlement to `(jobId, phaseIndex)`, preserve the rail-specific transaction reference and actual finality, and anchor finalized evidence without resubmitting a rail-final payment. | Buyer rail seams exist; x402/EVM evidence is reduced. There is no transport-neutral seller payment-intake verifier. | #113 implements the transport-independent pay-DEM/x402 intake gate. #24 owns hosted x402 mechanics, #33 broader settlement identity, #94 atomic evidence impact, and #102 buyer receipt production. |
| Delivery evidence | DACS-4 §9.6.1–§9.6.3 (DV-1..DV-6, DPA-1..DPA-9); §9.7 (delivery `SettlementEvidence`); DACS-5 §10.4.3 required references | Invoke an application callback only after the required payment gate, validate the exact signed `DeliverableSpec`, anchor delivery evidence, and return its exact reference for later bundle finalization. Unsupported delivery variants fail closed. | Delivery is a caller-selected string and the bundle has no high-level fulfilment/evidence seam. | #120 implements the transport-independent fulfilment/evidence core for #17. #55 owns durable recovery; #15/#81 own strict final-bundle integration. |
| Two-sided final bundles | DACS-5 §10.4, especially §10.4.1 signatures, §10.4.2 BB-1..BB-8, and §10.4.3 production/consumption rules; DACS-5 §10.3.1 ST-11 | Produce role-specific, canonically equal buyer and seller copies, collect required signatures, verify finalized referenced artifacts, publish signed bindings where native addresses cannot be recomputed, and remain `audit-pending` until both copies are final and resolvable. | Low-level two-sided/FaultAttestationBundle support exists; `runSessionCore` emits a legacy buyer-only bundle that strict verification rejects. | #81, with #15 for delivery references and #54 for public binding/index resolution. |
| Replay, retry, and recovery | CORE §B.8 (SN-1..SN-4); DACS-4 §9.5.1 PC-7, §9.5.6 AP2-5/AP2-6, §9.5.7 X402 retry rules, §9.5.8 SB-1..SB-3; DACS-5 §10.3.1 ST-1, ST-7..ST-11; DACS-5 §10.11 | Persist exact session/listing/agreement/payment/delivery identities; enforce single-use session and settlement identifiers; reconcile ambiguous external effects before retry; never repeat payment or fulfilment after restart; resume only the recorded forward state; keep finalization pending until all required evidence is finalized and resolvable. | `SessionStore` primitives and buyer-side integration exist, but `createAgent().runSession()` does not expose durable-store wiring and there is no seller lifecycle. | #55 (seller recovery), #33 (settlement uniqueness), #81 (bundle finalization), #92 (atomic rollback/idempotency). |

DPA-1 applicability is intentionally keyed to the signed pipeline containing
`deliver-attested-payload`, exactly as DACS-4 §9.6.3 states. An
`attested-payload` DeliverableSpec paired with another delivery phase is not a
DPA-1 pass: the selected delivery handler must apply its own §9.6 type check.
The explicit `LegacyMvpListing` branch has no normative signed DeliverableSpec
or verification method and therefore never claims a DPA-1 disposition; it is a
compatibility path, not a normative supplier Listing producer or verifier.

## Tracker disposition

Existing trackers already cover the following delivery slices:

- #5 and #41: shared normative type/validator work and Listing signature migration.
- #54: typed Demos artifact storage, logical/native bindings, and indexing.
- #98 and #99: fixed-price terms/seller authorization and finalized agreement commitment.
- #17 and #53: transport-independent seller lifecycle and RFQ seller behavior.
- #24, #102, and #113: x402 server mechanics, buyer receipt/finality
  production, and transport-independent seller payment intake respectively.
- #15 and #55: delivery evidence plus durable seller recovery.
- #81: strict two-party final bundle production.

Gaps identified by this audit (subsequently tracked):

1. Normative Listing fidelity and engagement, including `seller.publicEndpoint`,
   explicit legacy reads, current-only writes, and exact Listing pins. This focused
   PR is the implementation vehicle; a tracker is still useful for any reader
   validation left after merge.
2. Transport-independent seller-side payment-intake verification shared by
   pay-DEM and x402 is now #113. #24 is specifically an HTTP x402 paywall and
   #102 is buyer rail-receipt production; neither owns the generic seller gate.
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

## Seller payment-intake PR (#113)

This focused PR adds a pure `@kynesyslabs/dacs/seller` verification surface. It
does not host a transport, submit or rebroadcast a payment, sign or anchor
evidence, or invoke application fulfilment. Its injected resolvers return
verified operational views of the actual Standard artifacts; those views are
not new signed DACS records.

| SDK surface | Normative source | Enforced behavior / evidence |
| --- | --- | --- |
| `verifySellerPaymentIntake` agreement and Listing gate | DACS-1 §6.3.4 reader steps 1–9; DACS-3 §8.5 (`PayeeBoundAgreementDocument`, exact payout coverage); §8.6 (finalized commitment); DACS-4 §9.9 PIPE-6 | Selects only `payeeBoundAgreementVersion: "1"`, recomputes the signature-omitting agreement hash, matches the finalized commitment and exact Listing tuple/hash, validates the deliverable hash, accepted rail, pay-phase index, and complete payout coverage before reading a receipt. The public Agent accepts low-level `ListingValidationDeps` and always executes `validateListingArtifact`; a caller-supplied result cannot stand in for the reader algorithm. |
| payee, payer, amount, and asset checks | DACS-4 §9.5.1 PC-1..PC-7 and PB-1..PB-3 | Requires the paying key in the committed buyer bundle; resolves the strongest-applicable x402 destination binding; derives pay-DEM destinations intrinsically; and compares the observed transfer parties and exact integer base units with the agreement and pinned rail. |
| `verifyX402ReceiptClaim` | DACS-4 §9.5.7 X402-1..X402-4; CORE §B.2 CF-1 | Selects the versioned response header, strictly decodes Base64/UTF-8/JSON, preserves all response members, recursively NFC/JCS canonicalizes, recomputes `paymentReceiptHash`, and checks receipt transaction/network consistency. All 12 Standard `x402-receipt-hash-v0.1` vectors run directly. |
| `canonicalSellerSettlementId`, `x402Eip3009Nonce`, and `SellerReceiptStore` | DACS-4 §9.5.8 SB-1..SB-3; §9.5.9; CORE §B.8 SN-4 | Uses event-level EVM and Demos settlement identities, byte-exact EIP-3009 session nonces, and one atomic durable claim. Applicable Standard `sb2-settlement-uniqueness-v0.1` cases plus concurrent and simulated-restart tests prove one fulfilment permit. pay-DEM defines no rail-native SB-3 job field and therefore relies on SB-1/SB-2 plus its intrinsic amount/payee check. Missing/unverifiable x402 SB-3 binding is disclosed and uses the same normative fallback; mismatch rejects. |
| `SellerPaymentEvidenceInput` | DACS-4 §9.7, PC-2, PC-6, X402-2 | Returns the exact unsigned success-record fields with rail-specific `ChainTxRef` and actual finality. It deliberately omits `phaseIndex` (recovered from the PC-2 anchor), raw x402 receipt/header bytes, and `signature`; later evidence production signs and anchors this input without inventing fields. |

Ambiguous or unavailable chain observations return `indeterminate` before the
receipt store is claimed. A later retry re-observes the same deterministic
transaction identity; no payment submission seam exists in this core, so an
ambiguous intake result cannot cause a rebroadcast.

## Seller fulfilment PR (#17)

This stacked PR consumes only the opaque, one-shot receipt-store permit from
#113/#119 and exposes
`runFulfilmentCore` through the root and `@kynesyslabs/dacs/seller` entrypoints.
It performs no hosting, payment submission, transport handling, or private
service call. Application delivery, method-proof verification, evidence
signing, and SR-2 anchoring remain injected capabilities.

| SDK surface | Normative source | Enforced behavior / evidence |
| --- | --- | --- |
| Payment-to-delivery gate | DACS-4 §9.5.1 PC-2/PC-7; §9.5.8 SB-1/SB-2; §9.9 PIPE-1/PIPE-3/PIPE-4/PIPE-6; DACS-5 §10.3 | This focused release implements only a pay-then-deliver subset: exactly one successful payment phase must precede exactly one bound delivery phase. Zero-pay and deliver-then-pay pipelines remain normative but unsupported here; repeated payment/delivery phases also fail closed pending #17/DACS-Standard #329. The core validates the exact finalized commitment, Listing, rail snapshot, payment identity/evidence, and contiguous prior `SessionRecord.phaseResults`, derives a phase-indexed fulfilment id, then atomically commits permit consumption with the complete validated candidate and its immutable validation-time floor. Explicitly present `undefined` agreement optionals and negative-zero unsigned times are rejected because JCS would otherwise collapse distinct JavaScript views. A consumed replay reconciles first and may resume only those exact retained bytes/hash under the same idempotency key; once valid store output proves consumption, every result carries the exact consumed authorization and no path exposes a plain pre-consumption rejection. |
| Storage delivery | DACS-4 §9.6.1, DV-1..DV-4 | Requires the normative `storage-program` `DeliverableSpec`, canonical `dacs4:deliverable:{jobId}` anchor, exact JCS cleartext hash, declared schema/size, agreement-bound buyer ACL or encryption key, and the extended-pointer pattern above 128 KB. A proved private-to-public downgrade is `indeterminate`. |
| Entitlement delivery | DACS-4 §9.6.2, DV-5/DV-6; CORE §B.7 | Resolves the canonical renewal-zero record, computes the normative signature-omitting `contentHash`, and cryptographically verifies the raw seller signature before evidence. `credentialRef` fails closed pending the normative evidence schema in DACS-Standard #330. |
| Attested-payload delivery | DACS-4 §9.6.3 DPA-1..DPA-9; CORE §B.7 SIG-5 | Requires the request admission to equal the receipt store's exact pre-commit `produce` admission, then recomputes its pinned Listing ref, method kind/hash, DeliverableSpec hash, and `admittedAt <= finalizedAt` binding. A fresh local `operation: "produce"` capability decision is taken at the last reversible boundary immediately before preparation; reader-side `verify` support is never reused as producer authority. The core prepares and verifies exact bytes and the raw signed `PayloadAttestationRecord` without effects, consumes the permit, anchors/authenticates that record, and only then submits the retained payload. It recomputes every commerce binding and signature payload, verifies method-native proof independently, and preserves/hash-binds inert later-minor signed fields. This focused profile accepts attempt zero only; later attempts fail closed until contiguous immutable attempt history is authenticated. Pre-consumption and post-delivery resolved contradictions produce permanent failure; verifier/anchor unavailability remains indeterminate. A conclusive contradiction while publishing the DPA record after consumption is deliberately withheld from delivery/evidence until #121 generation-fences and persists it as an exact terminal reconciliation fact, after which this core emits DPA-7 failure evidence on replay. |
| Delivery and evidence anchors | CORE §5.1 SR2-4..SR2-9; DACS-4 §9.6/§9.7; DACS-2 §7.5.2 | Submit acknowledgements never establish delivery. The core requires reconciliation to return one stable terminal observation time, independently reads the canonical delivery address, checks exact retained/read-back equality, and authenticates an included-or-finalized receipt whose writer is authorized as seller. SettlementEvidence is cryptographically verified under the authenticated SessionRecord orchestrator before anchoring and again on independent read-back. Evidence publication atomically deduplicates by the canonical v2 fulfilment id and signature-omitting evidence hash; response loss reuses the original signed record/ref even across valid signer-key rotation. Submitted/accepted/dropped/expired/reorged/unverified-replacement receipts remain pending rather than becoming permanent failure. |
| Recovery seam | DACS-5 §10.3.1 ST-1/ST-7/ST-11 | Every application call receives the canonical-object v2 fulfilment id, binding job, payment/delivery indices, settlement, agreement, and payment evidence without delimiter ambiguity. All callback and receipt-store methods are captured and bound synchronously before the first await, so later getter/proxy/method swaps cannot change authority. Consumption atomically retains the exact authorization, a canonical hash of the complete authenticated agreement view, its original validation-time floor, the authenticated evidence authority, and the complete candidate/failure handoff; response loss therefore cannot strand a paid job between permit use and delivery. Recovery never calls the preparer again, validates every retained binding/byte against that immutable floor, reconciles first, and permits only an exact idempotent submit. `runDurableFulfilmentCore` adds the generation-fenced durable ownership described below. |

Strict two-party bundle production is deliberately not implemented here. The
core returns a normative phase/evidence contribution; #15/#81 will consume it
after shared `AttestationRef`/bundle type fidelity is complete, avoiding another
simplified signed bundle surface in this PR.

## Durable seller fulfilment PR (#55)

`runDurableFulfilmentCore` composes the public, generation-fenced
`FencedSessionStoreV2` with the repaired seller fulfilment core. This is a
separate versioned API: the legacy `SessionStore` v1 exports and semantics remain
unchanged, and a v1 store is never accepted or implicitly upgraded as v2. The
durable layer adds operational recovery state only; it does not alter or invent
a signed DACS artifact.

| Recovery boundary | Normative source | Durable behavior / evidence |
| --- | --- | --- |
| Consumed authority admission | DACS-4 §9.5.8 SB-1/SB-2; §9.9 PIPE-5; DACS-5 §10.3.1 ST-1/ST-7 | An available permit cannot create or reserve a session. Only the receipt store's atomically consumed authorization/handoff can establish durable identity. The set-once binding contains the exact lower-case authorization, fulfilment, handoff, agreement, payment-evidence, complete authenticated agreement-view, and evidence-authority bindings; canonical settlement identity; and both phase indexes. It is read back before any effect. Global settlement uniqueness is keyed by canonical settlement identity, never by the job-containing evidence hash. The retained agreement reference and phase-indexed canonical settlement id are immutable public status receipts. |
| Fenced write-ahead effects | DACS-4 §9.9 PIPE-5; DACS-5 §10.3.1 ST-1/ST-7/ST-11 | Payload-attestation publication, delivery submission, SettlementEvidence publication, and final session-receipt handoff all use one intent/outcome primitive. Intent stores a lossless exact input (including raw `Uint8Array` bytes) before the callback. Every adapter receives the live lease owner, monotonic generation, and stable idempotency key. A stale/expired worker cannot call or commit through the SDK store, and adapters can reject its old generation at their own atomic boundary. The signed SettlementEvidence intent is the terminal-source commit point: only after that exact intent is retained may its matching failure-source checkpoint commit, and both are revalidated against consumed authority and cryptographically authenticated before publication reconciliation or invocation. |
| Response loss and restart | DACS-5 §10.3.1 ST-7/ST-11 | A surviving intent is reconciled first by its stable idempotency key. A committed effect is never repeated; an indeterminate read remains pending. Only an exact `SellerEffectAuthoritativeAbsence`—an application adapter's authoritative proof that the idempotency key never committed, returned while atomically fencing all older generations—permits the new lease generation to invoke the retained input. Exact `AnchorReceipt`, `AttestationRef`, signed evidence, delivery value, raw DPA record, and final receipt outputs are hash-bound in the WAL. Pending final receipt is resumed first, then the first signed evidence intent is reconciled/read back and reconstructed before any mutable candidate verifier can run. Later validator changes or a valid signer-key rotation therefore cannot replace an already-selected outcome. |
| DPA terminal contradiction | DACS-4 §9.6.3 DPA-7/DPA-8; DACS-5 §10.3.1 ST-1/ST-7 | A conclusive post-consumption payload signature, method-proof, record, readback, or anchor-receipt contradiction is generation-fenced as one immutable failure with one observation time. Before exposing that failure, recovery closes any payload/delivery WAL intent through its fenced reconciler, binds the exact accepted delivery id, persists terminal phase reconciliation, and obtains every definitive readback required by an already-started delivery, including a definitive rejection for an imported pre-WAL payload. Pending or contradictory history remains nonterminal and cannot reach evidence publication. The signed failure reason reserves the `DPA terminal: ` prefix; legitimate non-DPA adapter reasons that begin with it are escaped as `non-DPA terminal: DPA terminal: …`, while an unescaped prefix requires the exact DPA checkpoint. Coherent store-local rehashing therefore cannot demote DPA evidence into a generic validation failure without making ordinary adapter messages unrecoverable. |
| Terminal replay and phase isolation | DACS-4 §9.9 PIPE-5; DACS-5 §10.3.1 ST-1/ST-7 | Terminal result plus final receipt are immutable and clone-isolated. Agreement, canonical settlement, authenticated payload publication/readback, delivery submission/reconciliation/readback, SettlementEvidence publication/readback, terminal-failure source, and final fulfilment receipts are checked as one exact spine. The failure-source checkpoint hash-binds the effect history and is included in the evidence WAL identity, so deleting a DPA marker cannot reclassify signed failure evidence. Repeated payment/delivery receipts and authorization rows are phase-indexed. A completed invocation may advance only under a fresh generation scoped to a strictly later delivery phase; failed/rejected phases cannot be demoted. A `FencedSessionStoreV2` reader reports version-1 files as `unsupported` because silently upgrading them would manufacture missing fencing authority; callers that intentionally retain the legacy v1 API continue to use `SessionStore`. |
