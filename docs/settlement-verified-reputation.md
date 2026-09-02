# Settlement-verified reputation

`deriveSettlementVerifiedReputation()` implements the DACS-5 v0.4 RSV path.
It is deliberately separate from `deriveReputation()`: released
`derivationVersion: "1"` records keep their released bytes and meaning, while
the new API emits only `settlementVerifiedDerivationVersion: "1"`.

Use the replayable API when publishing an independently auditable result:

```ts
const receipt = await deriveReplayableSettlementVerifiedReputation(
  partyPrimaryClaim,
  resolvedCopies,
  window,
  authority,
);

const replay = await replaySettlementVerifiedReputation(
  receipt,
  resolvedCopies,
  authority,
);
```

Each `resolvedCopies` member carries the fetched bundle, its exact
`AttestationRef`, and a `JobBoundResolutionContextEntry`. The trusted requested
`resolvedJobId` must equal the fetched copy's `jobId`. A binding-backed context
must retain its BB-6 candidate inputs; a one-copy result must retain hash-bound
absence evidence and, on a write-input substrate, the missing side's verified
binding.

## Authority callbacks

The callbacks are verification boundaries, not data suppliers:

- `authenticateBundle` verifies the copy's exact type and signing domain,
  required signer set, anchor-address or BundleBinding role, BB-6 selection and
  EBFAB SEB-1..SEB-6 authority. It returns the independently authenticated role
  of the scored claim.
- `verifyPresentedSettlement` resolves the exact reference, checks the
  signed-scope hash and signature, then verifies the authenticated Agreement and
  session, executed phase, pinned rail/asset/network, payer, payee, amount,
  finality and SB-1 through SB-3. A successful payment also returns its canonical
  settlement identity and authenticated phase index.
- `resolveAgreement` authenticates the referenced DACS-3 AgreementArtifact.
  The deriver independently checks its signed-scope hash, job binding and
  canonical positive price before counting volume.
- `resolveRating`, when supplied, authenticates standalone DACS-5 RatingRecords.
- `verifyCancellation` is required when either non-divergent copy carries an
  ST-10 marker. Unavailable cancellation authority excludes the job.

A callback must return `indeterminate`, never `verified`, when its authority is
unavailable or not immutable/finalized enough to support the claim. The SDK
captures all callback identities before its first asynchronous boundary and
captures every returned record as data-only canonical JSON.

## Reconciliation and metrics

The implementation authenticates copies before reconciliation, applies BB-6
same-role selection, ranks EBFAB above FAB above legacy, and compares the full
canonical `settlementEvidence[]` multisets across buyer/seller copies.
Reference order is immaterial; duplicates, substitutions, anchor changes and
signer changes are significant.

Every presented reference must verify. One rejected or indeterminate member
removes the whole job from bundle count, refs, numerators, denominators, ratings
and volume without creating a new fault. An empty presented multiset is
vacuously admitted but supplies no payment-volume evidence.

Volume requires all of:

1. a reconciled `completed` job;
2. at least one verified successful SettlementEvidence whose phase is in the
   exact closed DACS-4 `PaymentPhaseType` set; and
3. an exact authenticated Agreement reference.

The Agreement price is counted once per job and summed with decimal-string
arithmetic. A phase merely beginning with `pay-` is not a payment phase. Reused
SB-1 settlement identities retain only the earliest observed job/phase claim,
so one transaction cannot inflate completion or volume across jobs.

`replaySettlementVerifiedReputation()` re-runs all supplied authority callbacks,
reconciliation, RSV admission, Agreement/rating resolution and settlement
uniqueness, then requires the canonical receipt to match. It rejects stripped,
relabelled, unknown and multiple derivation discriminators rather than falling
back to released v1 semantics.
