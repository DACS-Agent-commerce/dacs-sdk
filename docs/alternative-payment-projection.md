# Alternative-payment projection

The optional DACS-4 APR profile lets one signed Listing offer one payment slot
with two or more rails. It does not make `pay-alternative` executable and it
does not define a fallback order. One complete `PaymentRailRef` is selected
before Agreement signature, then its authenticated concrete handler replaces
the placeholder at the same pipeline index.

Use separately signed sibling Listings when either counterparty does not
support APR-1 through APR-8.

## Safe flow

1. Call `validateAlternativePaymentListing` with Listing authentication and one
   authenticated registry snapshot. Every `acceptedRails` member is resolved,
   including alternatives that will not be selected.
2. Call `deriveAlternativeFixedPriceAgreement` with one complete selected ref,
   trusted local production mode, and a fresh authoritative session-start
   definition pin. The producer returns an unsigned payee-bound Agreement and
   its effective-pipeline projection.
3. Sign the Agreement normally, then call
   `projectAlternativePaymentPipeline` again in `signed` mode. This verifies
   the exact Listing pin, signed selection, current definition, availability,
   original phase index, and payout binding.
4. Call `verifyPriorPaymentReplacement`. An Agreement without
   `priorPaymentDispositionRef` is an independent purchase. A claimed
   replacement passes only with a finalized, authenticated disposition proving
   `closed-before-authorization` or `closed-cannot-settle`.
5. Pass the exact projection/replacement outputs to
   `commitFixedPriceAgreement` as `alternativePayment`, and later to
   `authorizeAlternativePayment`. They are paired capabilities: forged,
   copied, or cross-job combinations cannot authorize a wallet.
6. Call `verifyAlternativePaymentAudit` before admitting DACS-5 phase summaries
   and evidence. The raw placeholder is never valid executed evidence.

```ts
const admitted = await validateAlternativePaymentListing(listing, listingDeps);
if (admitted.verdict !== "pass") return admitted;

const draft = await deriveAlternativeFixedPriceAgreement(
  admitted,
  {
    jobId,
    verifiedListing,
    buyer,
    seller,
    selectedRail,
    payoutBindings,
    generatedAt: Date.now(),
  },
  {
    productionMode: true,
    pinSelectedDefinition,
    operatorPreflight,
  },
);
if (draft.verdict !== "pass") return draft;

const agreement = await signFixedPriceAgreement(
  draft.agreement,
  buyerSigner,
  sellerSigner,
);
const projection = await projectAlternativePaymentPipeline(
  admitted,
  agreement,
  {
    agreementState: "signed",
    productionMode: true,
    pinSelectedDefinition,
    authenticateAgreement,
    operatorPreflight,
  },
);
if (projection.verdict !== "pass") return projection;

const replacement = await verifyPriorPaymentReplacement(
  projection,
  replacementDeps,
);
if (replacement.verdict !== "pass") return replacement;

await commitFixedPriceAgreement(
  {
    ...commitmentInput,
    alternativePayment: { projection, replacement },
  },
  commitmentProvider,
  verifyCommitmentSignature,
);
```

## Replacement safety

`buildPriorPaymentDisposition` does not sign a closure assertion on trust. For
`closed-before-authorization`, its issuance dependency must atomically and
durably close the exact `(priorJobId, railRefHash, priorPhaseIndex)` key before
the signer runs. For `closed-cannot-settle`, the selected handler's terminal
reconciliation proof must verify first. Pending, ambiguous, unavailable, or
unfinalized state permits no replacement authorization.

After authorization or ambiguity, use `validateAlternativePaymentRetry` only
for reconciliation of the selected rail and original tuple. Choosing another
alternative always requires a fresh job and the replacement gate above.
