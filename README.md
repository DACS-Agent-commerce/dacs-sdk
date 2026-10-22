# dacs-sdk

TypeScript SDK for building **DACS** (Demos Agent Commerce Standards) agents — the reusable runtime that takes an agent through the five-stage lifecycle: **Identify → Vet → Negotiate → Settle → Verify**.

> **Status: pre-alpha / in development.** This repo is being extracted from the `agent-commerce-demo` reference implementation into a reusable library. See **[IMPLEMENTATION.md](./IMPLEMENTATION.md)** for the v0.1 MVP build plan.

> **Package availability:** the SDK packages are not yet published to npm. The
> package commands in this repository build and verify release candidates; use a
> source checkout until the first release is published.

## What this is

`agent-commerce-demo` is an *app* that runs one end-to-end DACS flow on Demos. `dacs-sdk` is the *library* extracted from it — so, once the packages are published, developers can install them and build their own DACS buyer/seller agents instead of wiring the protocol by hand.

- **Optionally integrates with** [`@kynesyslabs/demosdk`](https://www.npmjs.com/package/@kynesyslabs/demosdk) for substrate primitives (anchoring, DAHR, channels, bridges) behind a thin substrate-adapter seam (Demos is the first adapter).
- **Tested against** the canonical conformance vectors in [`DACS-Agent-commerce/DACS-Standard`](https://github.com/DACS-Agent-commerce/DACS-Standard) — the normative source of truth.
- **Presence oracle update:** see [adoption scope and remaining runtime boundary](./docs/presence-conformance-adoption.md).

## Layering

```
DACS-Standard        spec + §14 conformance vectors      ← source of truth
      ▲
dacs-sdk             this library; optional live adapters; tested against the vectors
      ▲
agent-commerce-demo  the worked example (consumes dacs-sdk)
```

## MVP scope (v0.1)

Self-declared identity (+ one verified claim) · fixed-price negotiation · **x402**, **direct ERC-20**, provider-injected **AP2 safety-core**, and provider-injected **Solana SPL safety-core** settlement · one delivery type · attestation bundle + reputation. AP2 also has an optional provider-test reference integration that is never enabled implicitly. Cross-chain settlement, bundled live Solana wallet/RPC integration, and dispute execution (DACS-X) remain deferred. A complete live RFQ/L2PS phase handler remains deferred. Transport-neutral sealed-envelope and RFQ policy cores are available separately.

## What's implemented

The modern role-separated fixed-price coordinators cover all five lifecycle
stages. The older `Agent.runSession()` convenience method remains a
settlement-only compatibility API; it does not claim fulfilment or audit
completion.

The exported `SignedArtifact`, `buildSignedArtifact()` and
`verifySignedArtifact()` symbols are likewise legacy raw-hex compatibility
surfaces used by that quarantined path and historical readers. New producers
and readers must use `ComponentSignedArtifact`,
`buildComponentSignedArtifact()` and `verifyComponentSignature()`.

| Stage | API | Notes |
| --- | --- | --- |
| Identify | `createAgent({ identity })` | the agent's CCI / DID |
| **Vet** | fixed-price coordinators · legacy `runSession({ vet })` · `vetCore` · `partyVetCore` · `resolveRecipe` · `evaluateClaimRequirementQualification` | recipe-driven verified claims plus mixed presence-only claim requirements; aborts before paying on failure |
| **Negotiate** | fixed-price coordinators · legacy `runSession({ terms })` · `openRfqSession` · `advanceRfqSession` · `deriveRfqAgreement` · `commitRfqAgreement` · `prepareRfqTranscript` · `createDurableRfqLifecycleClient` | end-to-end fixed-price; transport-neutral RFQ agreement, commitment, transcript-policy and durable lifecycle core |
| **Settle** | `payDemSettle` · `x402Settle` · `evmErc20Settle` · `advanceAp2Settlement` · `advanceSolanaSplSettlement` · `settleFromRail` | registry-selected x402, ERC-20 and pay-DEM buyer rails, optional AP2 provider integration, directly invoked provider-injected safety cores, and transport-neutral seller/provider intake |
| **Verify** | `verifyBundle` · `getReputation` | per-artifact signature verification; reputation from bundles |

Agreement readers can call `validateFixedPriceAgreementBinding()` with the
authenticated commitment timestamp to re-check the complete fixed-price
agreement/listing binding. RFQ or other negotiable-pattern implementations can
use `negotiablePriceBand()` and `isNegotiablePriceWithinBand()` for DACS-3
§8.5.2's exact inclusive, half-up-rounded band arithmetic; both reject
non-canonical CD-1 amounts instead of normalising them into acceptance.

Rails and verification recipes are resolved from **steward-signed registries** (`resolveRail` / `resolveRecipe`), so adding one is config, not code.

Use `evaluateRailAvailabilitySelection` at the session selection boundary. It
authenticates and pins the complete RailDefinition before applying local
production/preflight policy; discovery and counterparty availability hints are
never authority. Use `evaluateClaimRequirementQualification` when consuming
the DACS-2 CRQ projection outside `partyVetCore`: it authenticates either the
orchestrator-owned active SessionContext plus the exact production
requirement/result/reuse closure, or the signed replay bundle/CVR/result closure,
before recipe-family qualification and four-state aggregation.

Domain ClaimReferences use a strict trust boundary. Native Demos
`web2.domain` records may be converted to the current lower-case ASCII
`domain:` producer form with `domainClaimReferenceFromNativeHostname()`. A
signed current `domain:` reference is never repaired during reading. Historical
`web2:domain:` aliases are available only through
`readAuthenticatedDomainClaims()`, which authenticates the original artifact
before deriving a separate, deduplicated semantic claim set. For persistent GCR
evidence, `verifyDemosGcrDomainClaims()` additionally checks authenticated
transaction/finality, writer, validation-profile, freshness and presentation-
control inputs; it never treats copied bundle metadata as authority.

CCI resolution covers all eight production Demos identity contexts. Live
`xm`, `web2`, `pqc`, `ud`, `nomis`, `humanpassport`, `ethos`, and TLSN-backed
Web2 records are projected into canonical `cci-*` ClaimReferences; chain,
subchain, algorithm, score, profile, expiry, and proof-commitment coordinates
are retained in typed claims. The parser owns a data-only snapshot and drops an
entry rather than inventing an identifier (for example, an old Ethos entry
without its profile id). Unknown or incomplete native data remains available
only under `record.raw`. Conflicting records for one canonical reference are
rejected rather than selected by RPC order, and fixed byte/depth/node/
collection/string ceilings bound the decoded response before it is cloned.

Reputation projection has a separate trust boundary. Use
`authenticateDemosCciRecord()` with an application/provider capability that
authenticates the exact GCR response, subject binding, and applicable Demos
current-state/finality evidence. Provider scores additionally require the
separate `authenticateProviderClaim` capability to establish provider semantics
and subject/control binding for each exact claim. A successful RPC status or
GCR inclusion alone is not either proof. The returned runtime-branded record
can be passed to `projectCciSupplementarySignals()` with explicit Nomis, Human
Passport, and Ethos freshness ceilings; stale, expired, future-dated, and
non-passing values are reported as omissions. The resulting signals are
advisory DACS-2 `supplementary` entries and never affect `overallDecision`.
`AgentConfig.demosCci` exposes the same captured capabilities through
`agent.resolveAuthenticatedIdentity()`.

Native `cci-tlsn:<proof-hash>` claims are not external TLSNotary recipes.
`classifyCciTlsnProof()` requires an authenticated CCI record, a current
presentation-authenticated IdentityBundle, the canonical active job/session
context, explicit freshness ceilings, and a native TLSN verifier over those
exact coordinates. It selects `native-cci` only when the same current
commitment appears in both sources and the native verifier authenticates it;
an unregistered session proof remains on the external `tlsnotary` path. See
[the Demos CCI integration guide](./docs/demos-cci-identities.md).

The normal durable path is `agent.partyVetWithNativeCciTlsn()`. It obtains the
evaluation instant from the trusted Party Vet clock, independently matches the
active-session nonce, journals qualification for deterministic restart/replay,
and retains compact exact provenance in an SDK-reserved signal inside the
signed CVR. The signal remains advisory under DACS-2, while failed native
qualification is a mandatory precondition that prevents all Vet effects.

The default Vet `ParserSpec` engine supports RFC 9535 JSONPath (including
filters), CSS selectors, XPath 1.0, and actual RE2 matching. It parses detached
content only and fails closed on malformed input; see the
[ParserSpec engine guide](./docs/parser-engine.md) for its exact capability and
injection contract.

The transport-neutral RFQ core performs authenticated channel admission,
durable channel-ID reservation, Listing-bound price/turn/timeout enforcement,
restart-safe state transitions, exact accepted-term agreement derivation,
role-separated replay-safe transport outboxes, detached buyer/seller
co-signatures, finalized SR-2 commitment, complete private-transcript
reverification, and fail-closed Listing disclosure policy. It does not invent
the still-undefined Demos signature or encrypted transcript wires and is not yet
a complete live Demos L2PS phase handler; see the
[RFQ negotiation core guide](./docs/rfq-negotiation-core.md) for that boundary
and the upstream signature-format dependency.

`createFsDurableRfqLifecycleStore()` provides the single-host production
restart boundary for one RFQ role: keyed record authentication, strict local
permissions, synchronized atomic writes, cross-process locking, and monotonic
compare-and-swap validation. Buyer and seller require separate directories and
separate integrity keys; the in-memory RFQ store remains test-only.

`partyVetCore` evaluates DACS-1 presence-only members directly against the
exact signed `IdentityBundle`: it creates no synthetic `VerifyResult` and does
not resolve an optional `verifiedBy` merely to prove presence. Mixed
presence/verified production must supply the durable
`sessionRecipeRegistrySnapshot` pinned at session start. A strict consumer must
provide the same bundle and snapshot hash through
`CompositeVerificationExpectations.presence`, authenticate both, and re-run
the mixed decision and exact-claim selector-control rules. A temporarily
unavailable result is retained as indeterminate evidence; an independently
conclusive failure still has the Standard's fail-first precedence.

Settlement evidence has two deliberately different public boundaries.
`validateSettlementEvidenceStructure()` checks wire shape and any supplied
comparison facts, returning `valid|invalid|incomplete|error`; `valid` is never
an authorization verdict. `verifySettlementEvidence()` is the trust-bearing
operation and requires the authenticated agreement, pinned rail, phase
orchestrator, evidence reference, phase result, PC-2 address (for payment),
expected deliverable locator (for delivery), plus key resolution and signature
verification. Missing trust inputs fail as configuration errors rather than
being silently skipped.

Every write-capable Demos agent must supply a durable write journal. The
filesystem implementation coordinates processes on one host and survives
process termination; multi-host writers need a shared journal backend with the
same exclusive lease and generation-fencing guarantees. Read-only agents may
omit it.

### Demos agent ClaimReferences

Use `demosAgentClaimRef`, `parseDemosAgentClaimReference`,
`demosAgentPublicKey`, and `isDemosAgentClaimRef` from either
`@kynesyslabs/dacs` or
`@kynesyslabs/dacs/identity` for the DACS-1 §6.3.1 / §A.1 self-certifying
profile. Writers emit only `did:demos:agent:<64-lowercase-hex>`. Readers accept
case variation in the leading `did` scheme and preserve unknown canonical
parameters for forwarding; the typed parse result exposes the parameter-free
CF-3 identity separately. Signed-artifact authorization uses exact CF-2 bytes
and never performs that read-time repair. Foreign DIDs, mixed-case
`demos:agent`, uppercase key bytes, bare keys, and `demos:0x...` substrate
address notation are never intrinsically decoded as Demos signature authority
or aliased to the registered profile. `Agent.resolveIdentity()` retains
bare/`0x` native-address lookup as an explicit convenience but returns the
canonical Demos DID, so aliases never leak into a `CciRecord` or reputation key.
Non-intrinsic writer identities require
`AgentConfig.resolveIdentitySigningPublicKey` and are bound to the connected
adapter's actual key before signing.

## Public API

`createAgent()` returns only the high-level DACS operations below. It does not
expose the connected substrate adapter, raw demosdk client, signing primitive,
or broadcast/transfer authority. Operator diagnostics and funded conformance
tests that genuinely need the low-level adapter must opt into the clearly named
`createUnsafeManualAgent()` escape hatch and must never pass that result to an
application callback, plugin, or HTTP handler. In-process narrowing prevents
accidental capability leakage; OS-level buyer/seller signer isolation remains a
deployment responsibility of the generated role services.

```ts
import {
  createAgent,
  createFsDemosWriteJournal,
  createInMemoryBindingStore,
  createX402Rail,
  x402Settle,
  resolveRecipe,
  vetCore,
  verifyCompositeVerificationRecord,
} from "@kynesyslabs/dacs";
import { join } from "node:path";

// A production deployment supplies a well-known/catalog-backed implementation.
// This in-memory store is suitable only for a same-process example or tests.
const bindings = createInMemoryBindingStore();
const sellerWriteJournal = await createFsDemosWriteJournal({
  dir: join(dacsStateDir, "seller-demos-writes"),
});
const seller = await createAgent({
  demosRpc,
  wallet,
  demosWriteJournal: sellerWriteJournal,
  identity: { agentId },
  // Required to accept bundles with normative `vetRecords`. Derive this
  // closure from trusted listing/identity/registry state, never from `record`.
  // Without this callback verifyBundle/getReputation deliberately fail closed.
  verifyCompositeRecord: (record, bundle) =>
    verifyCompositeVerificationRecord(
      record,
      expectedVetClosureForBundle(bundle),
      vetVerificationDeps,
    ),
  // Required to accept bundles with SettlementEvidence. Resolve the exact
  // phase orchestrator and authenticated pinned-rail definition from trusted
  // session/registry state, including the structured assetSpec/networkSpec
  // needed for RD-5. The SDK derives the PC-2 phase index and exact handler
  // txRefs from the authenticated bundle, binds the Agreement/AttestationRef,
  // and performs the DACS-4 semantic and cryptographic verification itself.
  resolveSettlementEvidenceContext: (input) =>
    resolveAuthenticatedSettlementContext(input),
  bindings: { index: bindings, publisher: bindings },
});

// seller — sign + anchor a normative DACS-1 §6.3.4 ListingDraft. `spec`
// carries seller.identity/displayName/publicEndpoint, offering, buyerRequirement,
// pipeline, pricing, acceptedRails, terms, and validity; see hello-world.ts.
const published = await seller.publishListing(spec);
if (
  published.status !== "published" &&
  published.status !== "already-published"
) {
  throw new Error(`listing binding was not published: ${published.status}`);
}

// A read-only Directory can omit both wallet and publisher. A session-capable
// buyer supplies its own wallet but still needs only the consumer index.
const buyer = await createAgent({
  demosRpc,
  wallet: buyerWallet,
  demosWriteJournal: await createFsDemosWriteJournal({
    dir: join(dacsStateDir, "buyer-demos-writes"),
  }),
  identity: {
    agentId: buyerId,
    // The exact authenticated DACS-1 bundle is hashed into the Agreement and
    // terminal bundle. A bare agent id is not an identity commitment.
    bundle: buyerIdentityBundle,
    // Presentation authentication is deliberately bundle-scoped so the same
    // identity bundle can be reused. Session replay resistance is separate:
    // its exact bundle hash is committed inside each signed Agreement.
    verifyPresentation: ({ bundle, signedBytes }) =>
      verifyBuyerIdentityPresentation(bundle, signedBytes),
  },
  bindings: { index: bindings },
});

// buyer — resolve the stable logical address and authenticate its binding tuple,
// signed content, seller, service, version, and Listing-domain signature.
const resolved = await buyer.readListing(published.logicalAddress);
if (
  resolved.status !== "verified" ||
  resolved.compatibility !== "normative"
) {
  throw new Error(`listing could not pass ordered admission: ${resolved.status}`);
}

// Or page the historical Listings published by one known seller. This is
// owner-scoped discovery, not global marketplace search.
const firstPage = await buyer.enumerateListings(agentId);
const rail = await createX402Rail({
  evmPrivateKey,
  rpcUrl: process.env.BUYER_EVM_RPC!, // independent trusted chain read
  // Use the exact positive value from the authenticated rail descriptor.
  finalityBlocks: 1,
});
// Passing the authenticated result (not only `resolved.ref`) pins the selected
// content hash across runSession's pre-payment re-read.
const session = await buyer.runSession(resolved, {
  terms,
  // Record the buyer-selected cross-namespace EVM destination in the
  // buyer-signed legacy Agreement extension and durable recovery state.
  // Same-namespace rails may omit this option; PB-1 payout negotiation uses a
  // PayeeBoundAgreementDocument instead.
  expectedSettlementPayee: recipientEvm,
  // Optional Vet step. The producer emits signed §7.5/§7.7 artifacts and the
  // money path independently verifies their complete, caller-expected closure.
  vet: ({ jobId, evaluatedParty }) =>
    resolveRecipe(
      recipeRegistryRef,
      { scheme: "key", method: "self-signed", recipeVersion: 1 },
      { readRegistry, stewardPublicKey, stewardSigner, verify },
    )
      .then((recipe) => vetCore(
        {
          jobId,
          subject: evaluatedParty,
          bundleHash: sellerBundleHash,
          requirement: sellerRequirement,
          recipe,
          selfSigned: sellerKeyPossessionProof,
        },
        {
          proxyFetch,
          nowMs: () => Date.now(),
          componentSigner: buyerVerifierSigner,
          // This seam is idempotent by logical address + content hash and
          // reconciles response loss until a CORE §5.1 finalized receipt.
          anchorFinalizedArtifact,
          verifyFinalizedAnchor,
          readAnchoredJson,
          // Both capabilities are durable. `runOnce` must fence concurrent
          // callers and replay the exact stored result or terminal failure;
          // the lookup reconciles an anchor response lost after finality.
          operationStore,
          resolveFinalizedArtifact,
        },
      )),
  // `expectedVetClosure` must be built from the verified identity bundle,
  // listing requirement and selected recipes—not copied from `record`.
  verifyVetRecord: (record, request) =>
    verifyCompositeVerificationRecord(
      record,
      expectedVetClosure(request),
      vetVerificationDeps,
    ),
  // Required with `vet`: resolve and cryptographically authenticate the exact
  // finalized SR-2 ref/receipt from caller-held substrate trust. On resume,
  // `claimed` is absent, so this closure must recover finality by the supplied
  // logical/native address and content hash; shape-only receipts fail closed.
  authenticateVetFinality: (request) =>
    resolveAuthenticatedVetFinality(request),
  // `asset` is the on-chain token id (ERC-20 contract) the 402 must advertise —
  // the §4.1 guard compares against it, not the Price.asset symbol.
  settle: x402Settle(rail, { url, network, recipientEvm, asset }),
});

// Legacy compatibility only: payment settlement is not commerce completion.
if (session.commerceComplete || session.profile !== "legacy-mvp-settlement-only") {
  throw new Error("unexpected legacy session result");
}

if (session.outcome === "settlement-pending") {
  // Retain the job and resume it to finish evidence publication.
  console.log(`Payment ${session.payment.txHash} is final; resume job ${session.jobId}`);
} else {
  // anyone — verify the bundle's structure, signatures, referenced artifacts,
  // and (through the configured callbacks above) every normative vet closure and
  // SettlementEvidence record
  const verdict = await buyer.verifyBundle(session.bundleRef);
  const rep = await buyer.getReputation(primaryClaim, bundleRefs);
}
```

The public RatingRecord producers own the two permitted DACS-5 directions and
do not accept a caller-selected rater or target role. They reject malformed
RT-1 input before calling the wallet and return an isolated, signed wire record:

```ts
import {
  createBuyerRatingRecord,
  createSellerRatingRecord,
  createRatingPhasePlan,
  completeRatingPhase,
  deriveReputationWithValidation,
  isRatingRecord,
  persistRatingPhaseHandoffDurably,
  publishRatingRecordDurably,
  recoverRatingPhaseHandoff,
} from "@kynesyslabs/dacs";
import { createSqliteRatingPublicationEffectStore } from "@kynesyslabs/dacs-node/sqlite";

const buyerRating = await createBuyerRatingRecord(
  {
    jobId,
    buyer: buyerPrimaryClaim,
    seller: sellerPrimaryClaim,
    value: 5,
    dimensions: { timeliness: 5 },
    ratedAt: Date.now(),
  },
  {
    algorithm: "ed25519",
    sign: signWithBuyerIdentityKey,
  },
);

if (!isRatingRecord(buyerRating)) throw new Error("invalid RatingRecord");

// The seller-owned direction uses the same session parties but necessarily
// produces seller -> buyer with targetRole "buyer".
const sellerRating = await createSellerRatingRecord(ratingInput, sellerSigner);

const publishedRating = await publishRatingRecordDurably(
  {
    record: buyerRating,
    buyer: buyerPrimaryClaim,
    seller: sellerPrimaryClaim,
    expectedOwner: buyerDemosWalletAddress,
  },
  {
    effectStore: createSqliteRatingPublicationEffectStore(buyerDatabase),
    workerId: processInstanceId,
    leaseDurationMs: 30_000,
    repository: buyerBoundArtifactRepository,
    // Must authenticate both the rating signature and the exact rater -> Demos
    // writer relationship from trusted IdentityBundle/session state.
    authenticateRatingRecord,
    // Must authenticate canonical anchor inclusion/finality and writer
    // provenance; shape-only receipts are insufficient.
    authenticateAnchor: authenticateRatingAnchor,
  },
);
if (publishedRating.disposition !== "published") {
  throw new Error(`rating publication is ${publishedRating.disposition}`);
}

// The session orchestrator authenticates a minimal projection of the retained
// rate-pending SessionRecord. It never receives either party signing key.
const ratingPlan = await createRatingPhasePlan(ratePendingAuthority, {
  authenticateAuthority: authenticateRetainedSessionProjection,
});

// Buyer and seller publish independently through their own stores and wallets,
// then send only the durable publication result (or an explicit decline).
const ratingHandoff = await completeRatingPhase(
  ratingPlan,
  [buyerRatingSubmission, sellerRatingSubmission],
  Date.now(),
  {
    authenticatePlan: authenticateRetainedRatingPlan,
    authenticatePublication: authenticateRemoteRatingPublication,
  },
);
if (ratingHandoff.disposition === "waiting") {
  // A submitted publication is authentication-indeterminate; retry the same
  // plan rather than omitting a possibly anchored rating.
  return ratingHandoff;
}

// Write the exact handoff to the existing fenced session WAL before audit work.
// The outcome checkpoint and rate-pending -> audit-pending transition commit
// atomically; neither party's signing or publication authority is present here.
const durableRatingHandoff = await persistRatingPhaseHandoffDurably(
  ratingHandoff,
  {
    store: fencedSessionStore,
    workerId: processInstanceId,
    leaseTtlMs: 30_000,
    authenticateHandoff: authenticateRatingHandoffAgainstRetainedSession,
  },
);
if (durableRatingHandoff.disposition !== "persisted") {
  return durableRatingHandoff;
}

// On process start, recover only a committed outcome. A bare WAL intent is
// pending and must be resumed through persistRatingPhaseHandoffDurably().
const recoveredRatingHandoff = await recoverRatingPhaseHandoff(jobId, {
  store: fencedSessionStore,
  authenticateHandoff: authenticateRatingHandoffAgainstRetainedSession,
});
if (recoveredRatingHandoff.disposition === "recovered") {
  // Append phaseEntry to the full SessionRecord projection and pass ratingRefs
  // as the terminal finalizer's exact rating-record inventory.
  startTerminalAudit(recoveredRatingHandoff.handoff);
}

const reputation = await deriveReputationWithValidation(
  sellerPrimaryClaim,
  candidateBundles,
  reputationWindow,
  {
    validate: authenticateCompleteBundle,
    resolvePartyRole: resolveAuthenticatedSessionRole,
    copyAbsence: resolveAuthoritativeBundleAbsence,
    // This boundary must authenticate the rating's SR-2 anchor/binding and
    // dacs-rating:v1 signature. The SDK then independently rechecks its exact
    // ref hash, wire shape, RT-1/RT-2, job, parties, direction, and target role.
    resolveAndAuthenticateRating,
  },
);
```

The durable publisher writes the exact signed record to the actor-local effect
journal before invoking SR-2. A lost response moves the effect to
reconciliation; retrying reuses the same immutable bytes, logical address, and
idempotency identity. It returns a `ratingRef` only after authenticated finality,
role-owned binding visibility, and exact independently authenticated readback.
The asynchronous validated reputation path deduplicates one authenticated
rating per `(rater, jobId, targetRole)`, selects the latest `ratedAt`, and
computes role-specific averages. Invalid and indeterminate ratings are excluded,
never clamped. Rate-phase orchestration and terminal-bundle handoff remain
authority-separated: the planner authenticates completed settlement, each actor
publishes only its own direction, and the handoff re-authenticates every remote
publication before exposing terminal fields. Explicit decline and absence are
non-fatal. A Listing rate step with required:true is reported through
requiredAdvisoryMissingRoles but, as DACS-5 ST-5 requires, never blocks terminal
bundle production or demotes completed commerce. The final handoff is stored in
the existing generation-fenced session WAL, so restart recovery returns the
same phase entry and refs and rejects any attempt to rebind them. An application
must not treat a locally signed record as an anchored rating.

`Agent.getReputation()` is the normal untrusted-input path and fully verifies
each referenced bundle before scoring it. Lower-level consumers that already
hold candidate bundle objects must use `deriveReputationWithValidation()` when
their cryptographic verifier is asynchronous. The pure `deriveReputation()`
helper accepts only a synchronous primitive-boolean predicate over copies that
were authenticated upstream; a Promise-valued predicate is rejected rather
than treated as truthy. Both helpers also require an independently authenticated
per-job `resolvePartyRole({ jobId, partyPrimaryClaim })` mapping. Bundle-local
`parties[]` labels cannot decide whether a copy is the scored party's own or its
counterparty's: trusting those labels would let a relabelled self-abort become a
false counterparty fault. Callers whose validation already authenticated the
exact party map against the pinned agreement may instead make the explicit
`trustBundlePartyRoles: true` compatibility assertion; it is not implied by
`trustBundles` or by signature validation alone.

For native DEM, sellers can supply the standard read-only observer directly to
`verifySellerPaymentIntake`:

```ts
import { createPayDemSellerObserver } from "@kynesyslabs/dacs/seller";

const observer = createPayDemSellerObserver({ rpc: demosRpc });
const deps = {
  // ...the agreement, Listing, identity, registry and durable receipt-store
  // resolvers required by verifySellerPaymentIntake
  observeDemosTransfer: observer.observeDemosTransfer,
};
```

The observer enforces DACS-4 §9.5.9 against one mutually-consistent transaction
status, native-transfer body, and confirmed block. It derives finality time from
the block rather than the transaction timestamp. The status API's `included`
state remains the finality authority; an `included`, `confirmed`, or `finalized`
transaction-body label is accepted only when that status and confirmed-block
membership agree. RPC time and decoded JSON size are bounded (15 seconds and
64 MiB by default, both configurable), including the potentially larger
confirmed-block response. The native-send payload disambiguates the denomination
fork:
post-fork string amounts are OS (including an exactly matching numeric
`content.amount` projection), while legacy numeric payload amounts are DEM and
are converted at `1 DEM = 1,000,000,000 OS`. The payer is the transaction's
ed25519 owner address (the account whose nonce and balance are mutated), not an
alternate active signing key in `content.from`. It trusts the configured Demos
RPC's confirmed-block view; applications requiring an independent
validator-quorum proof must inject a stronger `observeDemosTransfer` provider.

The funded boundary test is disabled by default. It requires two independent
Demos wallets and DIDs, an explicit `PAY_DEM_AMOUNT_OS` (capped at 1 DEM), an
explicit `PAY_DEM_MAX_TOTAL_DEBIT_OS` (transfer plus confirmed fees, capped at
3 DEM), a unique `LIVE_PAY_DEM_RUN_ID`, and `LIVE_PAY_DEM_CONFIRM=1`. The rail
checks the node-confirmed fee against that ceiling before broadcast and fails
closed if the fee is missing or ambiguous. Its
`LIVE_PAY_DEM_MARKER_DIR` must be provisioned before the run on persistent local
storage: use its canonical absolute path (no symlink components), make it owned
by the test process user, and set mode `0700`. The test will not create or repair
this safety directory and rejects operating-system temporary paths. Provision a
dedicated directory and pass the result of `realpath` as the environment value.

Immediately before settlement, the test atomically writes and syncs a permanent
intent marker and never removes it. An ambiguous or merely unobserved settlement
therefore blocks that run id from being submitted again even if its wallet or
amount is changed. The guarantee is scoped to the same marker directory on the
same host: changing hosts or directories, deleting the ledger, or using
ephemeral storage bypasses it. Preserve and back up the directory with the
funded-run records; do not use a network filesystem unless its exclusive-create
and fsync guarantees have been independently established. Use fresh dedicated
wallets and a new run id only for a separately reconciled and approved attempt.

The funded pay-DEM runner also writes and syncs a second, write-once preparation
checkpoint after confirmation, denomination, fee and debit-cap validation and
immediately before broadcast. It contains only public recovery facts: the
canonical transaction hash, nonce, payer, payee, amount, cap and network. A
crash after this checkpoint but before the broadcast call is intentionally
treated exactly like a lost response after submission: the original run stays
blocked and recovery may only observe that hash/nonce. The checkpoint does not
contain the signed validity body, so it cannot reconstruct or authorize an
exact resubmission; neither re-signing nor rebroadcasting is a permitted recovery
action.

`createPayDemRail` exposes the same boundary as the optional
`journalPreparedTransfer` hook. Ordinary non-funded callers can omit it, but the
low-level rail then provides only in-process hash-first observation. Across a
process restart, at-most-once settlement still requires `payDemSettle` with a
durable `SettlementIdempotencyStore`; useful hash/nonce reconciliation
additionally requires an application-owned durable journal or equivalent rail
record. With neither durable mechanism, the SDK cannot prove that a lost
response did not move value, so applications must not automatically retry.
When the rail is selected through `settleFromRail`, supply these dependencies
under `payDem`: `maxTotalDebitOs`, `journalPreparedTransfer`,
`settlementStore`, and `reconcile`. The bridge adds the exact
`(railId, jobId, phaseIndex)`, settlement key, network, payer, payee and OS
amount to every prepared-transfer record, allowing the journal and durable
settlement log to authenticate the same PC-7 effect. `reconcile` receives that
`PayDemSettlementRecoveryContext` and must return either an exact
`PayDemReconciledSettlement` (including the observed `amountOs`) with
`execution: "executed"` only after reading the node's transaction record for
the hash and finding it `confirmed` for this payer, payee and amount; a
`PayDemReconciledFailure` for a bound `failed` record; or `null` only when
authoritative observation proves no transfer for that tuple landed. A status
index reporting `included` is not execution, so a reconciled success without
`execution: "executed"` is refused, and a reconciled failure never becomes the
recorded outcome by itself. A non-final observation must throw. Only the SDK's
own read of the node record makes a fresh payment final, through the rail
`createPayDemRail` returns: it signs, journals, fences and broadcasts the
transfer itself, so the record it reads is this call's transfer at the fee the
node confirmed. A custom `DemosNativeClient` or `PayDemRail` is refused before
its transfer or `settle` runs, because the SDK could not bind a transfer it did
not sign and broadcast to the call; it can never debit the buyer and then leave
the payment held, and a payment one already made still reconciles, because
recovery never calls it. See
[`docs/pay-dem-execution.md`](docs/pay-dem-execution.md) for the execution gate
and the contracts for custom clients, rails and reconcilers. Even authoritative absence does not revoke a
possibly-live old process or signed transaction and therefore does not authorize
an automatic native-DEM rebroadcast. Cached durable success is reauthenticated
after every process restart before reuse; missing, absent, or contradictory
recovery fails closed and never authorizes a broadcast.

A recovery request that carries `priorAttempts` (as `runSession` sends for a
session holding a transaction-bearing outcome) is an audit of that retained
transaction that never submits: it never
calls the rail, even when the rail log lost its record. It reads only and
never claims a submit generation or writes an intent, attempt record or outcome. It requires both `settlementStore.readOutcome`
and `reconcile` and
fails closed without either, except that a bridge without `reconcile` still
returns the definitive result it bound to the key itself when the key's
attempt record names that hash and the store saved that same result. It still
re-reads the node record before returning a cached success or permanent failure,
including when the same adapter originally submitted the payment. A
`SettlementLog` that keeps attempt records must implement `readOutcome`, which
reads without a lease. The `createIdempotencyStore` lookup never claims,
leases or binds a key; over an older log without `readOutcome` it refuses. For an
audit, `reconcile` receives a `PayDemSettlementAuditContext`: the same tuple plus
`txHash`, the retained hash in canonical form (64 lower-case hex digits, no
`0x`). `getTxByHash` matches that stored form exactly and answers any other form
as not found; `getTransactionStatus` lower-cases hex but rejects a `0x` prefix,
so a reader that mixes them can see `included` with no record. The reconciler
returns a normalized reconciliation result derived from the node's record
for that hash (`PayDemReconciledSettlement` or `PayDemReconciledFailure`),
and, whenever it can load one, the
original prepared-transfer journal entry for that hash as `preparedTransfer`.
The raw node record's `content` and `status` are not this SDK result shape;
see the [normalization example](docs/pay-dem-execution.md#normalizing-a-reconciliation-result).
Recovery preserves a known network fee when the reconciler omits it and refuses
a different fee for the same finalized payment. The SDK's own node-record read
must still match the saved fee. A supplied journal's confirmed
total debit must equal the successful result's OS amount plus reported fee.

The SDK counts the retained hash for this payment only through its own record
that this key signed it, and refuses the audit otherwise. That record is the
key's attempt record, or a result this bridge submitted that the attempt record
accepted. Every audit reads the attempt record,
and a record naming another hash refuses it, whatever this bridge holds in
memory. A
`createIdempotencyStore` store hands its settlement fence a `recordAttempt`
method when its `SettlementLog` implements the optional `putAttempt` and
`readAttempt` pair (the in-memory log does). `createPayDemRail` signs the hash
itself and records it through that fence before its one broadcast, and does
not broadcast if the record is refused, and `payDemSettle` does not write it
again after the payment is final (it writes only when the SDK rail returned a
hash its own pre-broadcast write did not report, which `createPayDemRail`
never does; a refusal there fails closed and leaves the hash unbound).
An unbound audit refuses without changing the log, even when reconciliation
finds a same-party, same-amount transfer. Reconciliation cannot create the
original job/phase binding required by DACS-4 §9.5.1 PC-7.
The fence a rail receives records
the canonical form (64 lower-case hex digits, no `0x`) whichever form the rail
passes, and rejects a value that is not a Demos transaction hash, so a rail
that awaits it never broadcasts one. The record is compare-and-set
under the submit generation and never changes, so after a crash, a timeout or
an ambiguous result a restarted process can still audit the payment. Missing
or contradictory recovery fails closed rather than resubmitting or reporting
a final payment unpaid (DACS-4 §9.5.1 PC-7). A durable
log needs the attempt pair for restart audits, so `payDemSettle` starts no new
transfer through a `createIdempotencyStore` store over a log without it: the
call fails before the rail runs, nothing is signed or sent, and the intent is
released. Nor does it start one through any other store, wrapper or fence: a
new transfer runs only when the fence a store hands its submit is that store's
own fence for this key and these terms (a wrapper whose `once` hands another
key's fence starts nothing) and records through
the same `createIdempotencyStore` store whose own `readOutcome` and
`readAttempt` it carries, so pass that store, or an object carrying its own
`once`, `readOutcome` and `readAttempt`. A log
without the pair still serves the payments it holds: an audit counts the hash
that an outcome the log holds for these exact terms names, once the
reconciliation agrees with that outcome on block and result, and a key the log
holds no outcome for stays fail closed. Before adding
the pair to an existing log, backfill each outcome that names a transaction as
its attempt record (`bindingHash` and `txHash` from that outcome). A key still
held with no outcome is backfilled only from the rail's prepared-transfer
journal entry whose `recovery` tuple names that key. Once the log keeps
attempts, an outcome without a record never counts.

Upgrading: this is a breaking change for stores and logs that paid before. A
custom or class settlement store, and any log that lacks `readOutcome`,
`putAttempt` or `readAttempt` (`createIdempotencyStore` also throws for a log
that provides only one of the attempt pair, or the pair without `readOutcome`),
now starts no new pay-dem transfer: the call fails before the rail runs and
nothing is signed or sent. To migrate, add `readOutcome`, `putAttempt` and
`readAttempt` to the durable log (`putAttempt` compare-and-set under the
generation, a record never changing), backfill the records as described above,
and pass the `createIdempotencyStore` store itself, or an object carrying its
own `once`, `readOutcome` and `readAttempt`. Recovery of payments or saved
outcomes written by older SDK versions is outside the current support scope.
The restart guarantees here apply to payments made with the current SDK and
a log implementing all three methods.
The durable rail log is the idempotency authority. Back it up and restore it
together with the session store; restoring session history alone cannot
recover a lost payment binding for a request that omits that history.

A supplied entry is always checked as well. It must name the retained hash, the
same payer, payee, OS amount and network, a `recovery` tuple equal to this rail,
job and phase, and (when present) a known denomination and debit bounds no
lower than the amount; for a permanent failure its nonce must also be the
proof's nonce. The entry is the reconciler's object, not the one the rail wrote
before broadcast, so it can refuse an audit but never counts the hash on its
own. Nor does an injected store's records, or a rail-log outcome on a log that
keeps attempts: a restart reconciliation can have written that outcome from a
lookup by key alone.

So an audit never counts another job's transfer of the same amount to the same
payee for this one, even when the reconciler returns an entry naming this job.
The reconciler throws when the entry it loads conflicts with the node's record,
and never returns `null` for the retained hash.

A failure after the record and before its broadcast, including a process crash
or a fence refusal, leaves a recorded
hash that nothing sent. The SDK never signs or sends again for that key: when
the reconciler finds nothing for the recorded hash, the restart is refused and
the key stays held. The operator clears it in the durable log only after
establishing that the recorded transaction did not land and can no longer
land. This requires an executed, finalized transaction at the payer's journaled nonce
on a node that serves that block, with a hash different from the recorded
hash. Verify the replacement's hash, payer and nonce against its finalized node
record with `status: "confirmed"`: it must have executed and consumed the journaled
nonce. An included transaction with `status: "failed"` is not proof of nonce
consumption and does not authorize clearing the key. If execution or the original
payment's disposition cannot be established, retain the key.
A moved nonce alone is insufficient: it also matches the recorded
transaction having landed. If the hashes match, recover that payment's
outcome and retain the key. Missing records or a lagging node leave the key
held; they do not authorize a replacement payment.

After proving those conditions, clearing a key means removing its whole durable
record (lease, attempt and outcome), as an operator action outside the
`SettlementLog` contract. Removing only the lease leaves the immutable attempt
in place and cannot enable a replacement. If session history still names the
abandoned hash, clearing the rail log alone also cannot enable a replacement:
abandon that job and use a new `jobId`, or explicitly clear its retained session
settlement outcome together with the whole rail-log record under the same
operator procedure.

A restart without history (the lease expired and the session holds no hash)
reconciles in the store. When the key has an attempt record, the reconciler
receives its hash as `txHash` and any other transaction is refused. Without
one, a success is refused unless this same bridge already submitted and bound
that hash to the key, and a reconciled failure stays held. A key-only
reconciliation or saved outcome cannot bind another job's same-party,
same-amount transaction to this payment, even when the SDK's own read of the
node record confirms that transaction. The check runs before saving a
reconciled success and before returning a cached success. A
supplied entry is checked on this path too and never persisted. A payment that the bridge, its rail log or the
session already recorded as successful is never reported unpaid: a reconciliation that
contradicts it is refused rather than returned as a permanent failure (DACS-4
§9.5.1 PC-7). The SDK's own record is only as trustworthy as the host's
`SettlementLog`: the store checks every record's key and binding hash, but
it cannot detect a log that forges them.

Every pay-DEM settlement request must carry its exact `phaseIndex`; if `payment.phaseIndex` is also configured,
the two values must match rather than silently defaulting or dropping the
configured discriminator. The compatibility defaults remain process-local and
must not be described as restart-safe.

The inclusion wait is bounded independently of the broadcast response and never
starts a second SDK broadcast. In demosdk 4.0.18, however, the underlying Axios
requests used by broadcast, status, transaction-record and nonce reads have no
cancellation or request timeout. An open transport socket may therefore keep a Node process
alive after the rail has returned an unresolved result. Terminating that process
does not make the marked attempt retryable: retain the marker and checkpoint and
reconcile read-only from another process. demosdk may internally retry the same
signed transaction on selected transport errors inside that one SDK broadcast
invocation; every such attempt retains the same canonical hash and nonce.

Run the funded test only with the complete guarded environment described above:

```sh
npm run test:live:pay-dem
```

`session.listingPin` is the exact DACS-1 §6.3.4 LR-1
`(listingId, listingVersion, contentHash)` tuple used by the session. To resume
an interrupted session safely, pass the prior `jobId` and the same authenticated
Listing to `runSession`; anchored artifacts are reused and the Listing remains
pinned. No-repayment across a whole-process crash additionally requires a durable
`sessionStore` and a rail-idempotent `resumeSettlement` implementation—a job id
alone cannot prove whether a lost rail response moved value. The legacy native-ref
input remains available for callers with a separate trusted pin.

Native recovery follows [DACS-4 v0.8 at the SDK Standard pin `d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md), especially §9.5.1 PC-7, §9.5.8 SB-2 and §9.5.9.

A saved native DEM outcome is not reused on trust. A resume that holds one,
including a re-run of a completed session, calls `resumeSettlement` once as a
read-only audit of the retained transaction hash, except in the cases below
that are held without a rail call. When `resumeSettlement` is omitted, the
registered native DEM `settle` adapter serves as the recovery implementation.
Native recovery requests carry `recoveryOnly: true`, including intent-only
checkpoints with no saved transaction. The adapter reads the original attempt
from the rail log and never submits on these requests. If that record is
missing, recovery remains unresolved without making another payment.
Only the SDK's `payDemSettle` adapter
(directly, from `settleFromRail`, or passed through `Agent.runSession`) is
called for it, as for every native settlement (see below). With the
session's rail checkpoint in the
`SessionStore`, a success is kept only when the rail re-reads a `confirmed`
record with the same block, kind, parties, finality and any saved fee, and a
permanent failure only when it returns the identical failure proof. From the
signed evidence alone (no `SessionStore`, or one without that checkpoint), a
success is kept only when the re-read matches the evidence's block, kind and
finality, the request-bound payee, and the payer and any fee the session
signed into the evidence (`dacsSdkSettlementPayer`, `dacsSdkNetworkFeeOs`).
These two are SDK extension members inside the signed scope (a verifier that
does not know them keeps them, as SIG-5 requires). `dacsSdkNetworkFeeOs` is the
fee the node's record declares in `transaction_fee`, which can differ from the
debit the chain took; it is not the Standard's `paymentFee`. When the rail log
has lost the key's attempt record, the signed evidence does not bind the
retained hash to the job (pay-dem declares no settlement-side job binding, and
an evidence signature or anchor is not collision authority under DACS-4 SB-2),
so the audit holds as indeterminate.

For native DEM sessions, retain a durable rail `SettlementLog` with its immutable
attempt records alongside the `SessionStore`, and reopen it with a reconciler
after a process restart. The default in-memory rail log supports retries only
while its process survives. A `SessionStore` alone cannot recover a payment
whose rail records were discarded. Restore the original rail log and attempt
records from a trusted backup before retrying such a session; clearing a paid
key or forcing a completed outcome cannot reconstruct those records safely.

Evidence signed before those fields existed is audited the same way, and its
payer is the one the `payDemSettle` rail log recorded for the job's settlement
key (that log's binding names the paying wallet; the audit fails closed when
the record did not survive). A `SessionStore` then records the payer and fee
of that first re-read beside the evidence, and later resumes must repeat them;
an evidence checkpoint written before payers were bound is left as it is, and
every resume re-reads through the rail log. Held as indeterminate without a
rail call: an evidence checkpoint without the payer and fee the evidence
signed, and, on every rail, anchored failure evidence that carries a
transaction without a `SessionStore` (no proof survives the run to re-read).
Absence, an indeterminate read, another hash
or any mismatch fails closed without paying again. A failure read for a saved
success, a bound failed record included, is refused the same way: the session
neither completes nor records the payment as failed, and the saved success
stays in place until a later resume re-reads it (DACS-4 §9.5.1 PC-7).

When a retained `SessionStore` has saved a successful payment but evidence
publication is unavailable, `runSession` returns `outcome: "settlement-pending"`
with `payment.ok: true` and `pendingEvidenceAddress`. Resume that same job to
publish its evidence and bundle; the saved payment is never submitted again.
`settlementRef` and `bundleRef` are available only on terminal results.

A recovered native success, and any native permanent failure, is final only
when the SDK read the node's record for that hash itself: over the rail
`createPayDemRail` built, the adapter reads the record through that rail's own
connection, for that rail's wallet only. It takes the
record's status, block, nonce, parties, amount and fee from it. This is the
only rail the adapter lets make a fresh payment. A fresh native session requires a retained `SessionStore` as well as a
caller-supplied settlement store and reconciler on its recovery adapter, plus
a caller-supplied store on its paying adapter, before claiming or paying, so a
session paid through it can be resumed or repeated
with those dependencies restored. Use a durable rail log implementing
`readOutcome`, `putAttempt` and `readAttempt`; the SDK cannot determine whether
a caller-supplied log persists across process restarts. The adapter's default
in-memory log remains available for direct, process-local rail calls.
Every native resume, including a completed-session replay, requires a trusted
node to serve the transaction record. Set `createPayDemRail({ rpc, secret,
recoveryRpc })` to use an operator-authenticated archival RPC when the primary
record is unavailable. The archive supplies its own fork state and record; the
SDK applies the same transfer, execution, block and fee checks. It never
connects a wallet to the archive or uses it to sign or broadcast. A terminal
primary verdict cannot be overridden by the archive. Configure the settlement
reconciler to resolve the original retained hash against the same archive; its
refusal or proof of absence still stops recovery before the SDK record read. Pruning, a node reset or an unavailable
record leaves that replay unresolved; it never reverses the saved payment or
causes another submission. A fresh success reports that same record
fee as `networkFeeOs`, which the session saves and signs: the rail's own
`networkFeeOs` (the confirmation's fee) bounds
`maxTotalDebitOs` and stays on the rail's result, but the record need not carry
it, so a saved success never contradicts its own record on a restart. It reads the amount and fee in the
denomination the record's signed payload carries (DEM numbers before the
denomination fork, OS strings after it), so a payment saved before the fork
still completes after it activates. The
reconciler's answer only names the hash and can refuse, and one the
record contradicts is refused. The fork state that bounds this read (no
OS-signed record before the fork) is read from the node afresh for each
recovery, not from demosdk's `getNetworkInfo`, which in 4.0.18 caches fork
information. Over any other rail the adapter returns no recovered verdict at
all, only the hash: the session binds it and saves it as an unresolved
attempt, so a later resume through the adapter over that rail
audits that hash instead of paying again, and never ends the session as failed
on it.

A native DEM session calls only that adapter, as `settle` and as
`resumeSettlement`. Any other implementation, a wrapper around the adapter
included, is refused before it is called, so it makes no payment: nothing
could re-read its success after a restart, so a session that completed on it
once could never be resumed or repeated. A recovered failure is
final only for a hash the session already held. Requiring a `confirmed` record is
stricter than the pinned DACS-4 §9.5.9 text, which counts a terminal `included`
status as success: the node can
report `included` for a transaction whose stored record `failed`, so such a
saved success is held unresolved rather than completed or reported unpaid.

`publishListing` requires `AgentConfig.wallet` and
`AgentConfig.bindings.publisher`, and fails before anchoring when either write
authority is absent. Its top-level `ref` exists only on a `published` or
`already-published` result. On conflict or indeterminate, retain
`publication.anchor` and retry the same listing; never create a replacement
anchor. These success statuses mean the publisher acknowledged the exact binding
and the configured index read it back; they do not by themselves prove portable
anchor finality, active-listing eligibility, or complete DACS conformance.

`readListing(logicalAddress)` and `enumerateListings(sellerId)` need only
`AgentConfig.bindings.index`; the Agent wallet and publisher are optional for a
read-only consumer. A normative `verified` result has passed the SDK-owned
ordered DACS-1 reader through step 9 and carries its exact `listingPin`; an
`authenticated` result is restricted to the explicit historical legacy-read
arm. Both have passed exact binding-tuple, hash, Listing-context, and authorship
checks. The binding owner is an
index assertion; direct lookup does not by itself prove that the seller deployed
the native anchor. Keep physical provenance separate from signed-content and
ordered-admission evidence.

Enumeration pages one known seller's confirmed Demos create history. Its opaque
cursor is owner-bound and at-least-once: `historyPageSize` counts raw history
rows, a page can contain no Listings, and `nextCursor: null` means only that the
current traversal reached its end. Upsert results idempotently by
`(logicalAddress, contentHash, ref)`. Restart from a null cursor to see a binding
repaired after its history page was already consumed.

Global/category discovery uses the open DACS-1 §6.3.6 catalog surface. Catalog
summaries are untrusted candidates: use `queryListingCatalog` to search, then
give `createCatalogBindingIndex` to the Agent so `readListing` dereferences and
validates the selected anchor before engagement:

```ts
import {
  createCatalogBindingIndex,
  listingAddress,
  queryListingCatalog,
} from "@kynesyslabs/dacs";

const catalog = {
  catalogUrl: "https://directory.example/api/dacs/listings",
};
const search = await queryListingCatalog(catalog, {
  category: "data.weather",
  rail: "x402:default",
  limit: 50,
});
if (search.status !== "ok") throw new Error(search.reason);

const candidate = search.page.listings[0];
if (!candidate) throw new Error("no matching listing");
const catalogIndex = createCatalogBindingIndex(catalog);
const logicalAddress = listingAddress(
  candidate.seller.primaryClaim,
  candidate.listingId,
  candidate.version,
);
// Configure `bindings.index: catalogIndex`, then require a normative `verified`
// result from `readListing(logicalAddress)` before starting a session.
```

The catalog client rejects transport/malformed-page failures, pagination loops,
bounded-scan exhaustion, conflicting exact candidates, and unsupported anchor
kinds as `indeterminate`; it never converts those states to `absent`. HTTPS,
redirect refusal, omitted ambient credentials, response-size limits, and finite
timeouts are defaults. Plain HTTP requires explicit `allowInsecureHttp: true`
for trusted development catalogs. `reachabilityHint` and `reputationHint` remain
operational pre-filters, never validity or trust evidence.

Handle enumeration results by status. A `page` may contain permanent candidate
`diagnostics` and advances to `nextCursor`. An `indeterminate` page is atomic:
it returns no Listings or diagnostics, and the caller retries its unchanged
`retryCursor`. `invalid-seller` and `invalid-options` are caller errors;
`historyPageSize`, when supplied, must be an integer from 1 through 100.

See **[examples/hello-world.ts](./examples/hello-world.ts)** for the full lifecycle end to end.

### AP2 reference integration (optional)

`advanceAp2Settlement` implements DACS-4 AP2-1..AP2-7 without pretending that
the TypeScript SDK is itself a complete AP2 SD-JWT verifier. Supply an
`Ap2MandateVerifier` backed by the official AP2 implementation; it must verify
the separate CheckoutMandate and PaymentMandate chains, every delegation, the
merchant checkout JWS, audience, nonce, constraints, and expiry before returning
the narrow checkout and payment projections.

```ts
import {
  advanceAp2Settlement,
  createFsAp2BindingStore,
  createStripeAp2Integration,
} from "@kynesyslabs/dacs/rails";

const store = await createFsAp2BindingStore({
  dir: `${dacsStateDir}/ap2-settlements`,
});
const stripe = createStripeAp2Integration({
  createCredential: stripePaymentIntentCreateRestrictedKey,
  statusCredential: stripePaymentIntentReadRestrictedKey,
  payeeId: stripeAccountId,
  currencyMinorUnits: 2,
  substrate: agent.adapter,
});

const progress = await advanceAp2Settlement({
  jobId,
  phaseIndex,
  agreementHash,
  protocolVersion: "0.2",
  expected: { payee: stripeAccountId, amount: "0.5", currency: "USD" },
  checkoutMandate: checkoutPresentation,
  paymentMandate: paymentPresentation,
  owner: workerId,
  verifier: officialAp2Verifier,
  provider: stripe.provider,
  store,
});
```

Use two distinct Stripe **restricted** test keys: the create key may create and
confirm PaymentIntents; the status key must be read-only. Standard `sk_` keys,
shared keys, and live restricted keys without explicit `allowLive: true` are
rejected. Set `currencyMinorUnits` to Stripe's charge representation for the
settlement currency: `0` for Stripe's zero-decimal currencies and `2` for its
other supported presentment currencies. ISK and UGX use `2` but only accept
integer major-unit amounts; HUF and TWD charges use `2`. Unsupported currencies
and mismatched settings fail before a PaymentIntent request. See
[Stripe's currency rules](https://docs.stripe.com/currencies); account and
country-specific availability is still enforced by Stripe. The status key
crosses DAHR through its transient Bearer channel and is
removed from the anchored request headers. The durable store records the AP2-7
binding and provider reference before receipt lookup, so a restart reconciles the
same PaymentIntent and cannot silently create a second payment. A DAHR result is
not returned until its transaction has authenticated canonical inclusion, which
also prevents the following evidence write from racing the same Demos nonce.
When the binding exposes a native transaction, the emitted reference uses the
Standard's distinct `ap2-sr3` arm and keeps these two locations distinct:
`receiptAttestation.anchor` is the fetchable provider-status URL whose exact
response bytes match `contentHash`, while `receiptTransactionRef` is the native
`demos-web2-request` transaction authenticating that hash. The DAHR transaction
hash is never mislabeled as a Storage Program locator, and the raw Stripe body
(which can include provider secrets) is never published as public DACS content.

The opt-in live test is
`test/integration/ap2-stripe-dahr.live.test.ts`. It requires an isolated Demos
wallet, durable state directory, the official AP2 Python runtime, the two Stripe
test credentials, and `DACS_AP2_LIVE_CONFIRM=1`. `DACS_AP2_LIVE_JOB_ID` can select
a fresh canonical 26-character ULID. The committed default test suite never contacts
Stripe, DAHR, the faucet, or Demos.

### Sealed-envelope procurement

`runSealedEnvelopeCore` supports both the backwards-compatible
`negotiate-sealed-envelope` demand phase and the explicit
`negotiate-sealed-envelope-procurement` phase. Demand makes the winning bidder
the agreement buyer. Procurement requires `auctionMode: "procurement"` and
makes the listing publisher the agreement buyer and the winning bidder the
seller, so the bid price always flows from agreement buyer to agreement seller.

Existing demand callbacks may still return only `agreementRef` and
`agreementHash`. A procurement `commitAgreement` callback must verify both
agreement-party signatures, call `ctx.validateAgreementForCommit(...)` before
anchoring, and return the exact agreement plus `verifiedSignerClaims`; the core
repeats the role/signature gate before returning an `ok` result.

### Fault-aware bundle helper

`buildTwoSidedBundle(session)` is the low-level DACS-5 v0.3 producer. It emits a
`FaultAttestationBundle` copy for each signing buyer, seller, and distinct
orchestrator. Fault and abort inputs require an absolute `faultedParty`; each
copy gets the matching role-relative `outcome` and signs under
`dacs-fault-bundle:v1:`. Consumers continue to accept legacy
`AttestationBundle` records, and consistency/reputation reconciliation supports
legacy, fault-aware, and mixed pairs. The helper is not yet wired into
`runSessionCore`.

For DACS-5 v0.4 exact settlement-evidence closure, use
`verifyEvidenceBoundFaultBundle(authority, deps)`. It authenticates the distinct
EBFAB and Listing domains, derives the executed evidence phase keys from their
signed trace, binds every SettlementEvidence to independent SB-1 execution
authority and SR-2 receipts, and enforces SEB-1..SEB-6, ST-8, and lifecycle
gates. `buildEvidenceBoundTwoSidedBundle()` produces type-specific copies only
after the caller wires that complete evidence-set gate; completed publication
still remains `audit-pending` until the bundle itself is finalized and
independently resolvable under ST-11. EBFAB extended pointers require the same
verified authority token; URL shape validation is not a deployment SSRF policy.

For reputation that makes an explicit settlement-verification claim, use
`deriveSettlementVerifiedReputation()` or its replayable counterpart. These
emit the distinct DACS-5 v0.4 settlement-verified discriminators and never
reinterpret the released `derivationVersion: "1"` type. The caller must supply
independent bundle, SettlementEvidence, Agreement, role/binding, finality and
SB-1..SB-3 authority. Any rejected or unavailable presented evidence excludes
the whole job without assigning fresh fault. See the
[settlement-verified reputation guide](./docs/settlement-verified-reputation.md)
for the authority contract and replay boundary.

`prepareVetTerminalBundle(...)` is the strict bridge for modern role-separated
coordinators. It accepts a finalized DACS-2 `VetProduction`, invokes the host's
recursive production authenticator, and creates DACS-5 `vet-failed` terminal
authority only for an authenticated objective `fail`. A passing record remains
non-terminal; `indeterminate`, verifier `error`, an unresolved closure, or a
thrown authentication dependency cannot blame the counterparty. The returned
authority contains no signing capability and is intended for the existing
role-local `advanceTerminalBundleDurable(...)` path. Failed bundles remain
co-signed; single-signature suppression is available only for an honest abort.

`lookupBundleCopies(jobId, reader)` supplies the transport-neutral DACS-5
§10.4.3(a) read step for consumers. It fetches the buyer and seller logical
bundle addresses concurrently, preserves `absent` versus `indeterminate`, and
ignores content returned for another job. Lookup is discovery, not trust: pass
each present copy through `verifyBundleCopy`, then supply an `isValid` adapter
that returns its `.valid` boolean to `bundleConsistency` before using the
resulting two-sided verdict.

`verifyCompletedTwoSidedSession(input, deps)` is the production completion
boundary shared by fixed-price x402 and native DEM. It accepts no signer and
performs no publication: the seller process supplies its already-finalized
ST-11 closure, while buyer and seller retain their independently published
role copies. The gate re-authenticates the complete seller dependency graph,
both exact native readbacks, finalized receipts, mapping/BB-1 bindings, the
full signer set, the buyer/seller identities, and the unified signed scope.
Only then does it return `state: "audit-complete"` with separate buyer and
seller logical/native references. The v1 fixed-price topology is exactly two
parties with the seller acting as phase orchestrator; a distinct orchestrator
requires its own reviewed profile and role-owned publication.

### Normative artifact references

Public `AttestationRef` values use the DACS-2 §7.5.2
`{ anchor: { kind, locator }, contentHash, signer? }` shape. `ChainTxRef`
(`TxRef`) is the DACS-4 §9.3 discriminated union, and `SettlementEvidence`
contains no signed `phaseIndex` (SB-1 derives it from the evidence anchor).
`verifyBundleCore` resolves normative references through
`resolveAttestationRef(ref, jobId, parties)` so the signed locator is never
discarded.

Artifacts emitted by early SDK releases with flat `{ kind, id }` references or
`{ rail, txHash, kind }` transaction refs are exposed only through the
explicitly named `LegacyMvp*` read/resume compatibility types and validators.
Normative producers, including `buildTwoSidedBundle`, reject those legacy
shapes. The existing buyer-only `runSessionCore` producer remains explicitly
quarantined on `LegacyMvp*` until its v0.3 migration in #81.

Its deterministic historical names are available as
`legacyMvpSessionAnchorName` for old indexers and recovery tooling. The explicit
prefix is intentional: these strings must not be used as the current DACS
address grammar. New code should use the typed address helper exported by the
relevant producer, such as `compositeVerificationAddress`,
`fixedPriceAgreementLogicalAddress`, or `bundleAddress`.

## Doctor

The package ships a read-only preflight command:

```sh
dacs doctor --offline
dacs doctor --json --rpc https://node2.demos.sh
dacs doctor --json --rpc-file ./rpc.url
dacs doctor --json --wallet-secret-file ./wallet.secret --rpc https://node2.demos.sh
```

The first slice checks runtime/package state, optional RPC reachability, secret
redaction, and rail availability without funding, transferring, anchoring, or
broadcasting. StorageProgram binding resolution and read-visible anchor
completion currently report `blocked` until the resolver/completion work lands
(tracked by dacs-sdk #58 and #57).

The supported runtime range is `^20.19.0 || >=22.12.0`, matching the package
engine contract and the Vitest/Rolldown toolchain requirement.

Secrets must not be passed directly as command-line values. Direct `--rpc` only
accepts origin-only URLs such as `https://node2.demos.sh`. For RPC URLs with
credentials, path tokens, query strings, or fragments, use `--rpc-file <path>`,
`--rpc-file -`, or `--rpc-env <name>`. For wallet secrets, use
`--wallet-secret-file <path>`, `--wallet-secret-file -`, or
`--wallet-secret-env <name>` so secret material
does not appear in shell history or process listings.

Exit codes are stable:

- `0`: all required checks passed or warned. In this first slice, required
  funding/storage/cost checks are still `blocked`, so a complete preflight is
  expected to exit `5` until those follow-up checks are implemented.
- `1`: at least one non-RPC check failed.
- `2`: invalid CLI usage.
- `3`: requested RPC check failed.
- `4`: unexpected doctor internal error.
- `5`: required checks are still blocked/incomplete.

### Canonical JSON compatibility

The canonical API follows RFC 8785 plus DACS CF-1 as clarified in
DACS-Standard `4df6294b8d1cfc047af456d3d5ce84cd9b3b9983`: string values are
NFC-normalised, while object member names are preserved and sorted by their
original UTF-16 code units. Canonically equivalent NFC/NFD names are distinct
signed members; the SDK does not merge or rename them.

SDK versions before this repair incorrectly normalised member names. A
historical artifact affected by that behavior must retain its original bytes
and producer/release provenance and be handled through an explicitly selected
legacy verification/quarantine policy. Current hashing and signing never
silently rewrite, re-hash, or re-sign those bytes as a current artifact; a
signature that only verifies under the old non-conforming transformation is
rejected by the current verifier.

## Imports

The package ships ESM with subpath exports so the substrate-free surface can be
used without pulling in `demosdk`:

| Import | Needs `demosdk` | Use for |
| --- | --- | --- |
| `@kynesyslabs/dacs` | optional (`createAgent` needs `demosdk`) | pure verification, or building live agents |
| `@kynesyslabs/dacs/substrate` | yes at runtime | live Demos adapter; `raw` uses the SDK-owned `DemosRawClient` boundary |
| `@kynesyslabs/dacs/cli` | no by default | read-only doctor helpers |
| `@kynesyslabs/dacs/rails` | no | x402 buyer settlement and seller paywall, evm-erc20, provider-injected AP2 and Solana SPL safety cores, and optional AP2 admission/provider/replay adapters |
| `@kynesyslabs/dacs/registry` | no | resolve steward-signed rails/recipes; rail dispatch |
| `@kynesyslabs/dacs/commerce` | no | role-local fixed-price x402 coordination and payment-evidence handshake |
| `@kynesyslabs/dacs/canonical` | no | JCS / decimals / content hashing / CF-4 addressing |
| `@kynesyslabs/dacs/crypto` | no | Ed25519 + §7.7 domain-separated signing |
| `@kynesyslabs/dacs/artifacts` | no | spine artifact types + validators |
| `@kynesyslabs/dacs/identity` | no | CCI parsing + canonical Demos agent ClaimReference helpers |

The commerce coordinator is an explicit production x402 profile, not a generic
`pay-*` dispatcher. It binds the supported Standard revision plus the verified
registry/rail/network and seller-orchestrator topology, separates buyer and
seller operations, and uses durable cursor/claim/ack outboxes. See
[the fixed-price x402 coordinator guide](./docs/fixed-price-x402-coordinator.md)
for the store, authentication, reconciliation and terminal-failure contracts.

The optional signed `pay-alternative` Listing profile is documented in
[the alternative-payment projection guide](./docs/alternative-payment-projection.md).

Sellers use `createX402Paywall` as the framework-neutral HTTP protocol adapter
and compose it with the authenticated seller spine. It settles or reconciles
the retained payer authorization before durable fulfilment, while PC-7 payment-
evidence anchoring catches up independently. See
[the seller x402 paywall guide](./docs/x402-seller-paywall.md) for the exact
ordering, recovery, and post-settlement failure contract.

Funded unattended buyers should place every rail behind the shared
[wallet-wide spend authority](./docs/wallet-spend-authority.md). It durably
enforces balance reserve, fee, rate, rolling, cumulative, counterparty,
concurrency and approval limits across jobs, rails and processes; ambiguous
effects remain charged until rail-authenticated reconciliation.

The Demos adapter and live rail clients are optional peers: install
`@kynesyslabs/demosdk` for `createAgent`, and `@x402/core`, `@x402/evm`,
`@x402/fetch`, plus `viem` for the corresponding live rails. Pure artifact,
verifier, canonical, and injected rail-core consumers do not install those
integration trees. CI installs the packed tarball in an external strict
NodeNext TypeScript project twice: once with every optional peer omitted, and
again with the live peers present. Both passes keep `skipLibCheck` disabled.
The SDK-owned `DemosRawClient` boundary prevents demosdk's internal declaration
graph from leaking into consumers; applications can explicitly narrow the
unstable `raw` escape hatch when they intentionally depend on demosdk types.

## Package artifacts

`npm pack` runs a clean build before it creates the tarball, so a package made
from a source checkout contains every declared ESM, type, and CLI export. To
reproduce the release-candidate checks locally:

```sh
npm ci
mkdir -p package-artifacts
npm run package:verify -- --output-dir package-artifacts/core
npm run release:set:verify -- --output-dir package-artifacts/release-set
```

The verifier creates the package twice and requires byte-identical tarballs,
checks every declared export, records source/lockfile/toolchain and artifact
digests, and installs the exact tarball in a fresh Bun consumer. It then removes
the consumer's `node_modules`, performs a frozen rematerialization with an empty
cache and an unreachable loopback registry, and reruns the substrate-free
`canonical` and `artifacts` imports. CI uploads the
core tarball and `provenance.json` for the exact checkout SHA. The release-set
verifier additionally requires byte-identical core, Node host and generator
tarballs at one version with identical compatibility metadata. It emits exact
checksums, one CycloneDX SBOM per package and combined release provenance. These
are qualified package candidates, not evidence that the packages were published
to npm.

Maintainer-controlled prerelease publication and first-release credential
bootstrap are documented in
[the npm prerelease release runbook](./docs/npm-prerelease-release.md).

## License

MIT — matching the DACS standard.
