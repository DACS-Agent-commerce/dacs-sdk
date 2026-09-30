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

## Remaining runtime boundary

The current durable party Vet producer rejects multiple attempts that derive
the same result address. The standalone producer rejects ambiguous distinct
same-family requirements, and the strict composite consumer binds each expected
result to one requirement. Accordingly, this update does not claim end-to-end
production of one authenticated result shared across distinct requirement
predicates. No fallback to a first matching predicate is introduced.

Completing that capability requires a separate bounded runtime change:

- derive all compatible members from the complete authenticated requirement;
- authenticate a referenced result once and evaluate each member's parameters
  and freshness independently;
- coalesce compatible party-plan paths into one durable method attempt/result;
- retain exact method-input, authority, nonce and recovery bindings; and
- test real producer-to-consumer replay, mismatches, crash recovery and the
  unchanged single-predicate path.

The signing registry follows the adopted 30-domain set. Registering the two
identity-bound agreement domains does not implement their artifact consumers.
Atomic Work capability remains closed. Older fixture and audit pins elsewhere
are retained as historical provenance, not silently attributed to this revision.
