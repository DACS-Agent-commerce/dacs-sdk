# Testnet profile TP-1 (`dacs-testnet-tp1`)

> **Status: proposed; composition qualification pending.** This declaration and
> the [machine-readable register](../conformance/tp1-register.json) are
> approved only after composition checks qualify the exact composition of the moved
> seller and client packages against the base below. The library implementation
> choices are recorded in the [wire contract](dacs-seller-http-v1.md#implementation-decisions-and-release-scope);
> library merge does not qualify or release that composition. The identity binding
> below (the profile tuple inside every signed message) is approved, on
> 2026-10-15 at 21:23Z, as proposed.
>
> TP-1 is the SDK's own declaration. It describes the SDK's testnet release
> against the Standard revision below and does not change or extend the DACS
> Standard. A plain-language summary is in
> [About the DACS testnet release](about-the-testnet-release.md).

**Declaration: experimental testnet implementation; not a conformant live DACS
profile.**

TP-1 names what the SDK's seller kit and buyer plugins implement on the Demos
testnet, which Standard revision they are measured against, and every known
way they fall short of it. It is not a DACS release and makes no conformance
claim for live use. Only gaps with a user-visible label in the table below promise that label.
The machine-readable record is `TESTNET_PROFILE_TP1` in
`@kynesyslabs/dacs/wire` (compiled [profile record](../dist/wire/profile.js)).

## Profile

| Field | TP-1 |
|---|---|
| Identifier | `dacs-testnet-tp1` |
| Revision | `TP-1` (later revisions are new values, each with its own base; see [Revisions](#revisions)) |
| Base | Proposed reference revision: DACS-Standard `next` `d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`, subject to Composition qualification; tuple CORE 0.3, DACS-1 0.7, DACS-2 0.6, DACS-3 0.5, DACS-4 0.8, DACS-5 0.5 (`spec/PROFILE.md:43-50` at `d45c0a2`) |
| Network | Demos testnet only. approved identity record `dacs-demos-testnet-identity/2026-10-20`, approved by the owner on 2026-10-20: chain identity `d59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc`, pin version `dacs-demos-testnet-identity/2026-10-20`, source kind `confirmed-block-one-predecessor`. The wire refuses unapproved identities before signing, including the previous record `dacs-demos-testnet-identity/2026-10-15`; broadcast refusal in the intended composition is not checked (see "Blocked" below) |
| Capability | FP-DEM with these restrictions: `negotiate-fixed-price`, `pay-dem`, delivery through Demos storage at `dacs4:deliverable:{jobId}` (`spec/DACS-4-SETTLE.md:839` at `d45c0a2`); `fixed-text` and explicitly configured pure, deterministic, synchronous text modules only, in the bounded UTF-8 report envelope the buyer plugins produce and read today (at most 16,384 characters, synchronous only: `TP1_CAPABILITIES` in `src/wire/profile.ts`, pinned by `test/wire/wire.test.ts`; that the plugins' producer accepts only this is taken from the plugin implementation and not yet independently checked, composition checks qualify it); no buyer request input. Any other Listing is refused before approval or signing; buyers provide an authenticated, content-hash-bound `readListingEligibility` decision to `verifyEndpointProof` before approval, and the wire rechecks selected terms before each request signature |
| Wire | [`dacs-seller-http/v1`](dacs-seller-http-v1.md): buyer-initiated HTTPS, discovery at `/.well-known/dacs-seller.json` |
| Claims | `did:demos:agent:<64 lowercase hex>` for both parties |

The approved record is `TP1_APPROVED_IDENTITY_RECORD` in `src/wire/profile.ts`.
Its canonical SHA-256 is `5c234f784b8fbbb77a53886594dbdf3689fbbc336f04c2c930edfd57f225e330`,
pinned in `TP1_APPROVED_IDENTITY_RECORD_DIGESTS` in `src/wire/approval.ts`.
The SDK representation adds `format` and uses the pin version as `recordId`;
`approvedBy` is "the owner", `approvedAt` is `2026-10-20`, and
`source` is "Approved Demos testnet identity record (2026-10-20)". Provenance also
includes the source kind above and the exact fallback documentation:

> Demos testnet nodes refuse a numeric block 0 (`getBlockByNumber` with `blockNumber: 0` returns RPC result 400). The chain identity is block 1's `content.previousHash`, the genesis hash a string `blockNumber: "0"` returns, checked against the approved record `dacs-demos-testnet-identity/2026-10-20`.

Numeric `blockNumber: 0` returns RPC `result: 400` inside HTTP 200, while
string `blockNumber: "0"` returns genesis successfully; the node limitation
concerns the numeric argument only.

**Previous record, no longer approved.** The record
`dacs-demos-testnet-identity/2026-10-15` (chain identity
`83082fbb733d76475a33a9f52fe3700d667a976c2d46bef33a149f47057f7dd4`, canonical
SHA-256 `c4e63ad6a75207c57c9342ed2c4fe38619c2b7cba17610753fbad2d5b4cc3cbd`,
approved on 2026-10-15 at 16:41Z) named the chain node2 served until its
2026-10-20 rebuild. node2 now serves another chain: block 1's
`content.previousHash` and the string-zero genesis hash are both
`d59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc`. The owner
approved that identity on 2026-10-20. The SDK's approval list names only the
new record, so a binding to the previous record is refused
(`tp1_identity_unapproved`) before any signature. The register retains the previous record under `network.previousRecords`. Its fallback text said nodes
"do not serve block 0"; only the numeric argument is refused, and the new
record's text says so.

Node inspection baseline: `kynesyslabs/node` commit
`11e7c8207732e25035de5a04cab25c5346046493`, version `0.9.8`. The deployment
reports `dirty: true`, so this commit is an inspection baseline only; it does
not identify what node2 runs.
The timestamped, read-only node2 request/response fixtures and SHA-256 manifest
are in the [current observation manifest](../conformance/tp1-node-observations/manifest-2026-10-20.json).
On 2026-10-20 the deployment reported branch `stabilisation`,
`builtAt: 2026-10-20T11:09:32Z`, and **`dirty: true`**. No deployment
artifact digest or overlay was supplied. This source commit is an immutable
inspection baseline, not a pin of the deployment's executable bytes; node
composition qualification remains open until those bytes can be identified.
The 2026-10-18 captures of the previous chain are kept unchanged as history
([historical manifest](../conformance/tp1-node-observations/manifest.json)). That build
reported source commit `61b8e75aa8db5e408c49e1c3a89db4d673f45578`,
`builtAt: 2026-10-14T16:45:24Z` and `dirty: true`; a read-only
`getNetworkInfo` on 2026-10-19 reported the same commit rebuilt at
`2026-10-18T15:59:30Z`. The fixtures describe the build that ran when they
were captured, not necessarily the one running now.
Observed on 2026-10-20: genesis availability with string zero, block one's
predecessor, and numeric-zero refusal. Observed on 2026-10-18 only:
missing-transaction RPC refusal and missing status `unknown`. Inferred from
[`chainTransactions.ts` at the baseline commit](https://github.com/kynesyslabs/node/blob/11e7c8207732e25035de5a04cab25c5346046493/src/libs/blockchain/chainTransactions.ts#L96-L109),
which is byte-identical to the file at `61b8e75`:
a stored transaction is labelled `included` without checking execution.
The same handler's comment (lines 93-94) says execution failures are not
recorded and surface as `unknown`; it does not establish that failed
execution is stored as `included`. No execution-failed live transaction was
reproduced. L2/G10's node-status
explanation is this source inference, not an authenticated deployment result.

Closing node deployment qualification requires evidence from the deployment
owner for the build observed by these fixtures:

- A cryptographic digest of the exact deployed image or complete runtime
  bundle, with the artifact retained for inspection. A source archive's digest
  or the fixture hashes alone does not identify the deployed runtime.
- The complete source tree for that artifact, including the dirty overlay on
  `11e7c8207732e25035de5a04cab25c5346046493`, and its dependency lockfile and
  build inputs. The overlay must be retained under an immutable reference or
  content digest; the reported source commit alone is insufficient.
- A deployment record binding that artifact and source tree to node2 and the
  observation timestamps, including the reported version, branch, dirty flag
  and build time. A later clean deployment cannot retrospectively qualify
  these captures.

After those inputs are supplied, record their references in the observation
manifest and qualify status behaviour against the identified build. An
execution-failure claim also needs captured execution and status evidence for
that build; the missing-transaction fixtures do not establish it. Until then,
`nodeObservationEvidence.deploymentQualified` remains `false`, the deployment
digest and overlay remain unknown, and the source-inference labels remain.

The owner's decision supplies this pin independently of the endpoint being
admitted; the wire never takes it from an RPC. The 2026-10-20 reads record
what node2 reported when the decision was checked; they are evidence for it,
not an input to the gate. `endpoint` and `transportAuthority`
are per actor for each connection and are excluded from the approved record.

The pin alone does not establish what runs: the SDK's vector pin is `d45c0a2`
(dacs-sdk `3904d70` `package.json:128`), its pay-dem binding requires
`965df75` (`src/commerce/fixedPricePayDemProtocol.ts:11-12`, `:78`), and the
plugin's vendored SDK archive embeds `662be1d` (taken from the plugin
implementation; not yet independently checked). composition checks qualify the moved
composition against the base and record every difference in the register.

## What the wire binds

- **Identity binding: the profile tuple in every signed message (approved).**
  Every `dacs-seller-http/v1` request, response, seller session delegation and
  discovery document carries `profile: {id, revision, base, chainIdentity,
  pinVersion}` inside its signed bytes: the tuple (identifier
  `dacs-testnet-tp1`, revision `TP-1`, full base commit
  `d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`) and the approved record's two pins. Each
  party requires an exact match with the tuple it selected locally and with
  the tuple kept for that purchase. A missing, unknown or mismatched value is
  refused before any effect, with no fallback to admission on identifier and
  base alone. The revision is compared exactly: this SDK defines only `TP-1`,
  so a case, whitespace or type variant, or a later revision's name, is
  unknown. This binding was approved on 2026-10-15 at 21:23Z, as proposed;
  `TESTNET_PROFILE_TP1.identityBinding` records it. Current regression coverage is
  `test/wire/approvedIdentity.test.ts` in the repository. The register and
  [compatibility vectors](../vectors/dacs-seller-http-v1.json) accompany this package.
- **Signing domains.** The wire signs under new SDK wire domains
  `dacs-seller-http:v1:{request,response,delegation,discovery}:`. They are
  distinct from the Standard's artifact signature domains (CORE §B.7 at
  `d45c0a2`): a wire signature authenticates transport only and is never a
  DACS artifact signature.
- **Discovery.** The signed discovery document carries the profile and states
  the capability restrictions above; the buyer requires its signer to be the
  Listing's seller and its `publicEndpoint`, an HTTPS origin, to equal the
  Listing's byte for byte.
- **Network identity.** Nothing is signed without a binding to an approved
  identity record and the signer's own current connection. The SDK approves
  the record (`TP1_APPROVED_IDENTITY_RECORD_DIGESTS`); the caller cannot. Missing pins, the
  buyer plugins' simulated-fixture chain identity
  (`DACS_STORAGE_ANCHOR_CHAIN_IDENTITY`, the SHA-256 of a fixture string, which
  `src/wire/profile.ts` derives and refuses; `test/wire/networkIdentity.test.ts`)
  used as a live pin, and any unapproved identity, including a mainnet
  identity labelled "testnet", produce no signature. Two parties may use
  different RPC endpoints for the same approved chain; changing an actor's own
  endpoint, transport authority or connection invalidates its authorization.
  This admission policy does not establish BFT finality or current-state
  proof.

## Live-use rules TP-1 does not meet

| # | Rule | What TP-1 does | Label | Closed by |
|---|---|---|---|---|
| L1 | Live admission: the base "is not an admissible live profile until a coordinated release records an annotated tag or immutable merge commit" (`spec/PROFILE.md:52-53` at `d45c0a2`) | TP-1 is a testnet profile, not a release. Both parties authenticate the same TP-1 identifier, revision and base pin inside signed messages before any DACS action | "Testnet profile TP-1 · not a DACS live profile" | A coordinated Standard release that records a tag or immutable commit (v0.6 is the planned one) |
| L2 | Payment finality: the base's `pay-dem` rule returns success when a transfer reaches the terminal `included` state, and says that a transfer reaching terminal `failed` did not settle and is a `permanent` failure (`spec/DACS-4-SETTLE.md:814-821` at `d45c0a2`). The inspected node handler maps stored transfers to `included` without checking execution; its comment says execution failures are not recorded and surface as `unknown` (source inference; deployment qualification pending). This is not evidence that a failed transfer is reported as `included` by the deployment. `included` alone does not independently prove execution. Current `next` also requires an authenticated Demos BFT proof | **Intended, pending a separate SDK change that is not on this branch, and composition qualification:** a payment counts only on an executed record bound to the transfer, never on `included` alone. That is stricter than reading the base's `included` rule literally against the testnet's status wording, and follows the base's statement that a failed transfer did not settle. **Current behaviour:** at this branch's base, if a transfer whose execution failed is reported as `included`, it is returned as success by the buyer rail, a false success (dacs-sdk `3904d70` `src/rails/payDem.ts:979-981`); nothing on this branch prevents it. This statement covers only the buyer rail; the seller observer's treatment of failed execution is not checked and is in the composition qualification list. A change to the Standard's own `pay-dem` rule is being proposed separately through the Standard's own process; it is not a condition of TP-1 | Intended, pending the SDK's executed-payment check and composition qualification: "Payment executed on Demos testnet; BFT finality not independently proven". Until that check lands, this label would also appear on a failed payment reported as included | For the executed-record rule, the SDK's executed-payment check; for finality, Demos executed-status and BFT finality proof APIs, then the Standard's Demos payment-finality binding, then finality-bound `pay-dem` evidence in the SDK |
| L3 | Listing currency: current `next` requires authenticated current-state (RSC) proof (DACS-1 at `df7bc20`, for example `:806`; none at `d45c0a2`) | Reads the requested Listing's chain bytes and authenticates any supplied revocation marker; does not prove the latest version, marker completeness or current non-revocation | "Listing currency not proven" | Demos authenticated current-value reads, then the Standard's current Listing binding, then current Listing admission in the SDK |
| L4 | Presenter control of `did:demos:agent`: no mechanism in any revision (#419; control list `spec/DACS-1-IDENTIFY.md:311` at `d45c0a2`) | #419's proposed rule: the claim is controlled by its own presentation signature under the key in the identifier | Declaration; seller cards say "Seller key: self-certified Demos agent key" | A Standard rule for presenter control of `did:demos:agent` (#419) |

## Known gaps against the base

A seed, not an exhaustive finding: a composition review completes the register.

| # | Gap | Label where visible | Closed by |
|---|---|---|---|
| G1 | The Agreement is written as a public-ACL storage program (dacs-sdk `3904d70` `src/substrate/DemosAdapter.ts:3474-3479`); CH-2 (`spec/DACS-3-NEGOTIATE.md:39` at `d45c0a2`) and DACS-3 §8.4.1 conflict; the maintainers must rule | "Agreement terms are publicly readable on testnet" | The maintainers' ruling, then confidential Agreement publication in the SDK |
| G2 | The buyer derives its session-presentation nonce itself (taken from the plugin implementation; not yet independently checked); the base wants a verifier-issued nonce (`spec/CORE.md:606` at `d45c0a2`) | declaration only | Verifier-issued session challenges in both directions in the SDK |
| G3 | The seller writes both Vet records as orchestrator; a composition review records the authority reading at the base (VPC-2, `spec/DACS-2-VET.md:1212`, and CORE §B.8, `spec/CORE.md:606`, at `d45c0a2`; the explicit wording is DACS-2 §7.8 at `df7bc20`, `:1464-1465`) | declaration only | A composition review showing each Vet's verifier is the counterparty, or the orchestrator acting on its behalf (CORE §B.8, DACS-2 §7.8), with verifier-issued session challenges in both directions (SN-1) and an independently authenticated expected verifier. A buyer-written Vet is one way to meet it, not a requirement |
| G4 | The wire requires a verifier/orchestrator-owned `readAuthority` for the active connection and each authenticated participant's exact profile and six-module tuple, bound to the job. Retained seller/client effect adapters do not yet install this authority (the SDK side: `src/wire/profile.ts` and `test/wire/authority.test.ts`) | declaration only | Install the authenticated authority reader in retained effect adapters and qualify the composition |
| G5 | No DACS-5 bundle: a purchase ends when the Deliverable is verified | "Delivered · audit record not produced in TP-1" | Terminal completion with the DACS-5 audit record |
| G6 | Exact-bytes (CF-5) admission at the wire ingress only (`src/wire/validate.ts` and the CF-5 vectors; the plugin parsed these inputs with `JSON.parse`, taken from the plugin implementation and not yet independently checked); canonical job IDs at every address builder come later | declaration only | Exact-bytes admission at every retained ingress and canonical job IDs at every address builder |
| G7 | No refunds; no Listing amend, renew or withdraw | "Refunds are not supported in TP-1" | Voluntary refunds and the Listing lifecycle in the seller kit |
| G8 | No external security review (on hold) | "Testnet only · not security-reviewed · no real value" | An external security review and its fixes |
| G9 | Delivery SettlementEvidence, required at the base by DACS-4 §9.6.1 (`spec/DACS-4-SETTLE.md:831-839` at `d45c0a2`); the seller to be moved into the SDK defaults `deliveryEvidenceEnabled` to false (taken from the plugin implementation; not yet independently checked) | Until a composition review shows it is produced and verified: "Delivery evidence not produced in TP-1"; delivery-phase conformance is not claimed | The composition check result: enabled if produced and verified; otherwise current DeliveryEvidence support in the SDK |
| G10 | **Current behaviour:** if a failed `pay-dem` transfer is reported as `included`, it is returned as success at this branch's base (L2), so the purchase proceeds as if paid. The base says a transfer that reaches terminal `failed` did not settle and classes it `permanent` (`spec/DACS-4-SETTLE.md:816-821` at `d45c0a2`). **Intended, pending the separate SDK change (L2) and composition qualification:** once that change makes such a transfer not ok, the SDK holds it as unresolved, because `SettleResult` carries no failure class and the settlement runner refuses terminal failure evidence for any not-ok result with a transaction hash (dacs-sdk `3904d70` `src/agent/runSessionCore.ts:155-186`, `:4213-4221`): nothing is broadcast a second time and the purchase stays settling. That fails closed, but it is not the base's `permanent` classification, and TP-1 does not present it as an implemented protection until an effect-path test proves it | Intended, pending the SDK's executed-payment check and composition qualification: "Payment failed on Demos testnet · purchase held as unresolved; the payment is not sent again". Until then a failed payment reported as included is counted as paid and this label is not shown | The SDK's executed-payment check and an effect-path test of the hold; then a failure class on settlement results, so that a definitive failed transfer is recorded as `permanent` |
| G11 | The wire accepts only canonical lowercase `did:demos:agent` claims; uppercase `DID:` is refused rather than resolved, unlike the base's reader rule (`spec/DACS-1-IDENTIFY.md:170-177` at `d45c0a2`). Request, delegation and discovery receiver refusals are pinned in `test/wire/admission.test.ts` | "TP-1 wire requires lowercase DID claims" | Reader support for every DID spelling required by the base |
| G12 | The wire signing domains `dacs-seller-http:v1:{request,response,delegation,discovery}:` are not in CORE §B.7's closed registry (`spec/CORE.md:487` at `d45c0a2`) and do not take the `dacs-x-` form SIG-4 gives a kind outside it (`spec/CORE.md:590`). The wire also signs `domain ‖ canonical(payload)`, where §B.7 signs `separator ‖ artifact_hash` and forbids signing the canonical form directly (`spec/CORE.md:598`). The SDK treats them as transport-message signatures, not artifact kinds; no wire domain equals a registered signature domain or hash-domain tag, or is a prefix of one in either direction (`test/wire/wire.test.ts`). The Standard has not ruled on this | declaration only | A Standard ruling: rename to `dacs-x-seller-http:v1:{…}:`, sign `domain ‖ sha256hex(canonical(payload))`, and regenerate the vectors and the revision-adapted fixture, or register the transport domains and their signed bytes |

## Blocked

- **Retained effect-path integration and checks.** The intended TP-1
  composition refuses missing, fixture and unapproved identities, and changed
  local bindings, before signatures and broadcasts. No retained seller,
  browser or stdio effect path consumes `./wire` yet; broadcast refusal on
  those paths is not checked. Instrumented tests of each path must establish
  zero signatures and zero broadcasts before this becomes a current guarantee.
- **Composition qualification.** Until it runs on the moved seller and client packages, this
  declaration and the register stay proposed.

## Revisions

Later revisions (TP-1.1, TP-1.2, TP-1.3, and
TP-1.4, the candidate re-pinned to v0.5 once the Standard releases it (its latest release tag is v0.4) if v0.6 cannot be released
by 2026-11-19) are recorded in this declaration and the register. Each names its
base and its open L and G rows and keeps the TP-1 labels for every open row.
Each also has its own `revision` value in the signed tuple. Until an SDK
release defines one, a message naming it is refused as unknown, and a purchase
continues only under the exact tuple it was kept with.
