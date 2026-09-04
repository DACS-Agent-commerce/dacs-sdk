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

## Layering

```
DACS-Standard        spec + §14 conformance vectors      ← source of truth
      ▲
dacs-sdk             this library; optional live adapters; tested against the vectors
      ▲
agent-commerce-demo  the worked example (consumes dacs-sdk)
```

## MVP scope (v0.1)

Self-declared identity (+ one verified claim) · fixed-price negotiation · **x402** and **direct ERC-20** settlement · one delivery type · attestation bundle + reputation. Cross-chain settlement, a complete live RFQ/L2PS phase handler, AP2, and dispute (DACS-X) are deferred. Transport-neutral sealed-envelope and RFQ policy cores are available separately.

## What's implemented

All five lifecycle stages run end to end:

| Stage | API | Notes |
| --- | --- | --- |
| Identify | `createAgent({ identity })` | the agent's CCI / DID |
| **Vet** | `runSession({ vet })` · `vetCore` · `resolveRecipe` | recipe-driven (self-signed, consensus-backed-proxy via DAHR); aborts before paying on failure |
| **Negotiate** | `runSession({ terms })` · `createDurableRfqLifecycleClient` · `createDemosL2psRfqTransport` · `commitRfqAgreement` · `prepareRfqTranscript` | end-to-end fixed-price; durable buyer/seller RFQ with Demos L2PS adapter |
| **Settle** | `payDemSettle` · `x402Settle` · `evmErc20Settle` · `settleFromRail` | registry-selected buyer rails plus transport-neutral seller intake |
| **Verify** | `verifyBundle` · `getReputation` | per-artifact signature verification; reputation from bundles |

Rails and verification recipes are resolved from **steward-signed registries** (`resolveRail` / `resolveRecipe`), so adding one is config, not code.

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

The default Vet `ParserSpec` engine supports RFC 9535 JSONPath (including
filters), CSS selectors, XPath 1.0, and actual RE2 matching. It parses detached
content only and fails closed on malformed input; see the
[ParserSpec engine guide](./docs/parser-engine.md) for its exact capability and
injection contract.

The RFQ stack performs authenticated channel admission,
durable channel-ID reservation, Listing-bound price/turn/timeout enforcement,
restart-safe state transitions, exact accepted-term agreement derivation,
role-separated replay-safe transport outboxes, detached buyer/seller
co-signatures, finalized SR-2 commitment, complete private-transcript
reverification, fail-closed Listing disclosure policy, and Demos-compatible
AES-GCM L2PS packet transport with outbound and inbound history recovery. It
does not invent the still-undefined DACS signature or encrypted-transcript
publication wires, and clean construction of demosdk's messaging peer awaits a
focused public demosdk export; see the
[RFQ negotiation core guide](./docs/rfq-negotiation-core.md) for that boundary
and the upstream dependencies.

`createFsDurableRfqLifecycleStore()` provides the single-host production
restart boundary for one RFQ role: keyed record authentication, strict local
permissions, synchronized atomic writes, cross-process locking, and monotonic
compare-and-swap validation. Buyer and seller require separate directories and
separate integrity keys; the in-memory RFQ store remains test-only.

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
  identity: { agentId: buyerId },
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

// anyone — verify the bundle's structure, signatures, referenced artifacts,
// and (through the configured callbacks above) every normative vet closure and
// SettlementEvidence record
const verdict = await buyer.verifyBundle(session.bundleRef);
const rep = await buyer.getReputation(primaryClaim, bundleRefs);
```

`Agent.getReputation()` is the normal untrusted-input path and fully verifies
each referenced bundle before scoring it. Lower-level consumers that already
hold candidate bundle objects must use `deriveReputationWithValidation()` when
their cryptographic verifier is asynchronous. The pure `deriveReputation()`
helper accepts only a synchronous primitive-boolean predicate over copies that
were authenticated upstream; a Promise-valued predicate is rejected rather
than treated as truthy.

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
`PayDemReconciledSettlement` (including the observed `amountOs`) or `null` only
when authoritative observation proves no transfer for that tuple landed. A
non-final observation must throw. Even authoritative absence does not revoke a
possibly-live old process or signed transaction and therefore does not authorize
an automatic native-DEM rebroadcast. Cached durable success is reauthenticated
after every process restart before reuse; missing, absent, or contradictory
recovery fails closed and never authorizes a broadcast. Every pay-DEM settlement request
must carry its exact `phaseIndex`; if `payment.phaseIndex` is also configured,
the two values must match rather than silently defaulting or dropping the
configured discriminator. The compatibility defaults remain process-local and
must not be described as restart-safe.

The inclusion wait is bounded independently of the broadcast response and never
starts a second SDK broadcast. In demosdk 4.0.16, however, the underlying Axios
requests used by broadcast, status, and nonce reads have no cancellation or
request timeout. An open transport socket may therefore keep a Node process
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
| `@kynesyslabs/dacs/rails` | no | x402 buyer settlement and seller paywall, plus evm-erc20 settlement |
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
npm run package:verify -- --output-dir package-artifacts
```

The verifier creates the package twice and requires byte-identical tarballs,
checks every declared export, records source/lockfile/toolchain and artifact
digests, and installs the exact tarball in a fresh Bun consumer. It then removes
the consumer's `node_modules`, performs a frozen rematerialization with an empty
cache and an unreachable loopback registry, and reruns the substrate-free
`canonical` and `artifacts` imports. CI uploads the
tarball and `provenance.json` for the exact checkout SHA. This is a qualified
package candidate, not evidence that the package was published to npm.

## License

MIT — matching the DACS standard.
