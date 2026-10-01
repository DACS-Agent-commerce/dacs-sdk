# Presence conformance oracle adoption

The SDK oracle, release metadata and generated-project pin use merged Standard
#362 at `d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`.

`test/agent/presenceClaimRequirement.test.ts` replays the 47 signed fixture
outcomes through SDK shape/signature/hash checks and the pure presence
aggregator. The immutable corpus supplies test authority: its composite signer
and unique recipe-family signers. The harness checks ordered, unique committed
references and distinguishes its 16 projection entries from 15 available result
artifacts. Each compatible requirement predicate uses the authenticated result
data; historical decisions are reconstructed at the signed `generatedAt`.

This is a historical conformance diagnostic, not a live or durable producer
acceptance test. Active-use verification retains its current-time and external
authority gates. Pinning this corpus does not establish full implementation of
every feature at the newer Standard revision.

## Live shared-result boundary

The durable party Vet producer and strict composite consumer now support one
authenticated result shared across compatible verified predicates. The party
plan still retains every exact requirement path and its generation-fenced recipe
pin. Paths coalesce only when their canonical claim subject, result address,
classification, method input, authenticated recipe bytes, session registry
snapshot and authority URL-template substitutions agree. A duplicate result
address with any different authority input fails before a method effect.

The producer journals, signs, anchors and independently reads back one result
for such a group. It journals the method-specific parameter matcher outcome for
each member and applies those outcomes and each `maxAge` independently at
composite generation while retaining the result's governing validity window as
an admission gate. The record commits the shared result reference once,
preserving the Standard's ordered, unique result-reference projection. Crash
recovery replays the same group and qualification outcomes without issuing a
second authority request. It reconstructs the active aggregate before anchoring
or returning a recovered composite, so an expired pass is never accepted.

The strict consumer authenticates each unique committed reference, recipe,
signature and method-native attestation once. It derives every compatible
verified member from the complete authenticated requirement and applies each
member's parameters and `maxAge` independently. Cross-predicate projection is
limited to consensus proxy evidence, whose fixed method-input hash, exact
authenticated recipe method and authority URL-template substitutions can be
reconstructed and compared. Methods whose input is absent from the composite
wire satisfy only the explicitly committed member. The governing result
validity window remains an evidence-admission gate; a tighter member `maxAge` or
a parameter mismatch makes that member unsatisfied without changing the signed
result. A missing parameter verifier remains unresolved. Distinct or ambiguous
method families remain fail-closed.

Single-predicate plans emit the same plan and artifact shape and retain their
existing durable effect namespace. The standalone single-claim producer remains
single-predicate and continues to reject ambiguous distinct same-family
requirements. Cross-session non-pass reuse rules are unchanged: exact
authenticated originating-parameter equality or a current-predicate execution
is still required.

Coverage is offline and deterministic: producer-to-consumer replay exercises
shared predicates, independent parameter and freshness outcomes, incompatible
group rejection, response-loss recovery, and the single-predicate path. This is
not live-service evidence or a claim of complete implementation of every feature
at the newer Standard revision.

The signing registry follows the adopted 30-domain set. Registering the two
identity-bound agreement domains does not implement their artifact consumers.
Atomic Work capability remains closed. Older fixture and audit pins elsewhere
are retained as historical provenance, not silently attributed to this revision.
