# DACS One-Click Agent Install Specification

Status: implementation specification
Target: first public alpha after the SDK stack through PR #155 is merged
Date: 2026-08-14
Primary trackers: dacs-sdk issues #59 and #60
Revision: 2 — architecture and transport decisions resolved

> **Implementation status (2026-08-15): design target, not current capability.**
> The credential-free package currently delivered by the stacked host/generator
> work is an internal verifier simulation only. It has no SR-2 anchor authority,
> no SR-3/AP2-2 provider authority, moves no value, emits no normative or
> commercial-success claim, and does not implement independently hosted roles.
> Its wrapped fixture output MUST NOT be described as satisfying the offline or
> live acceptance requirements below. Those requirements remain release gates.

## 1. Executive decision

DACS will ship a one-command local quickstart and a guarded, one-command live
bootstrap for fixed-price agent deployments.

The first release MUST optimize for a complete, verifiable DACS lifecycle, not
for supporting every procurement or payment variant. It MUST therefore support:

- two non-interchangeable runtime profiles:
  `dacs-sdk:fixed-price-offline:v1` for deterministic local execution and
  `dacs-sdk:fixed-price-x402:v1` for authenticated live x402 execution;
- one immediate local mode: deterministic offline buyer + seller + verifier;
- one initial live mode: Demos testnet for DACS artifacts and an authenticated
  testnet x402 rail selected from the signed rail registry;
- separate buyer, seller and verifier authorities;
- durable restart recovery in live mode; and
- inspection of every DACS-1 through DACS-5 artifact and receipt.

Native pay-DEM support is a follow-on after SDK PR #154. RFQ, bidding and sealed
tender profiles are not part of the first installer and MUST NOT be simulated
under either fixed-price profile.

The two runtime profiles MAY share coordinator interfaces and lifecycle ordering,
but MUST have different binding hashes, durable namespaces and admission rules.
An offline record, effect identity, artifact reference or database MUST NOT be
resumed, imported or upgraded into a live x402 session. The live profile retains
PR #155's strict requirement for an authenticated `availability: "live"` x402
binding. The offline profile MUST never be passed to that live-profile verifier.

“One click” has two deliberately different meanings:

1. Offline quickstart: one command installs, generates and runs the complete
   lifecycle without credentials, network access or spending.
2. Live bootstrap: one command generates a production-shaped deployment and
   performs a read-only preflight. It MUST NOT publish, broadcast, fund or pay
   until the user separately supplies credentials and explicitly authorizes a
   bounded live-write budget.

## 2. Normative language

The terms MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are normative requirements
for this implementation.

## 3. Goals

The installer MUST let a new developer:

1. run a complete DACS-1 → DACS-5 transaction locally with one command;
2. inspect the Listing, identity/Vet evidence, agreement, commitment,
   settlement, delivery evidence and both role-owned terminal bundles;
3. change from offline adapters to live adapters without rewriting lifecycle
   orchestration;
4. deploy buyer, seller and verifier as independently configured processes;
5. restart any process while preserving deterministic effect identities and,
   where external adapters provide idempotency or authoritative reconciliation,
   without producing a duplicate observable irreversible effect; and
6. discover configuration, funding and infrastructure failures before any
   irreversible operation.

The generated application MUST use only documented public SDK exports. It MUST
NOT import SDK source files, `dist/` internals, test helpers, VPS code, private
repositories or unpublished Standard fixtures.

## 4. Non-goals for the first release

The first release does not include:

- mainnet payments;
- automatic faucet use or automatic funding;
- automatic domain, DNS or TLS account changes;
- RFQ, auctions, sealed-envelope procurement or negotiation over L2PS;
- pay-DEM, HTLC, Solana or arbitrary custom rails;
- managed cloud hosting;
- custody of users' production keys;
- browser-wallet support; or
- a claim that every future DACS profile can be installed from the same
  template without additional adapters.

## 5. User-facing packages

The release consists of three logical deliverables.

### 5.1 Protocol SDK

`@kynesyslabs/dacs` remains the protocol and lifecycle SDK. Before the installer
is released, the package MUST:

- be published to npm from a reviewed, tagged commit;
- contain all declared runtime, type and CLI exports;
- compile in a clean strict NodeNext TypeScript consumer without optional peers;
- carry npm provenance and a reproducible package receipt;
- support Node 20.19 and Node 22; and
- expose the exact supported Standard revision and profile identifiers as
  constants so generated applications do not duplicate them.

A post-#155, separately reviewed core-SDK change MUST add the offline public
surface:

```ts
FIXED_PRICE_OFFLINE_COMMERCE_PROFILE = "dacs-sdk:fixed-price-offline:v1";
createFixedPriceOfflineBuyerCoordinator(...);
createFixedPriceOfflineSellerCoordinator(...);
```

Those factories MUST expose operation/store shapes parallel to the live
coordinator while accepting only an explicit offline protocol binding. They
MUST use a distinct binding-hash and idempotency domain. This change MUST NOT
widen or modify PR #155's `captureFixedPriceX402ProtocolBinding` admission rule;
the live factories continue to require `availability: "live"` and `pay-x402`.

The declaration-isolation work from PR #105 and reproducible packaging work from
PR #152 are prerequisites. They are not currently included in PR #155 and MUST
be reconciled onto the final merged SDK main branch.

### 5.2 Node host kit

The Node host kit package is `@kynesyslabs/dacs-node`. It MUST provide the
production implementations that PR #155 intentionally leaves injectable:

- durable coordinator stores;
- durable payment-evidence handshake stores and outboxes;
- authenticated HTTP message transport;
- filesystem secret loading;
- process supervision hooks;
- structured event and status reporting; and
- health/readiness endpoints.

Node, SQLite, HTTP and deployment dependencies MUST remain in this companion
package and MUST NOT enter the transport-neutral `@kynesyslabs/dacs` dependency
tree. Host implementations MUST NOT be copied as mutable generated source into
every project. There must be one reviewed implementation and one upgrade path.

The package MUST initially export stable contracts for:

- offline profile creation and isolation;
- SQLite store creation and migration;
- authenticated HTTP envelope signing, verification and transport;
- role service creation;
- configuration and secret loading; and
- health, readiness and structured event projection.

### 5.3 Project generator

The public generator package is `create-dacs-agent`, invoked as:

```bash
npm create dacs-agent@latest my-agent
```

The package name MUST be reserved and its publishing permissions established
before release. The generator MUST have no install-time lifecycle script and
MUST publish with npm provenance.

## 6. Required command-line experience

### 6.1 One-command offline lifecycle

This command MUST succeed on a clean supported machine:

```bash
npm create dacs-agent@latest my-agent -- --yes --run
```

It MUST:

1. create `my-agent` without reading global credentials;
2. install from the public npm registry using a lockfile;
3. typecheck the generated application;
4. run separate logical buyer, seller and verifier components;
5. execute a deterministic `dacs-sdk:fixed-price-offline:v1` lifecycle;
6. independently verify the final artifacts; and
7. print the path to a machine-readable run report.

The run MUST make no network request after dependency installation. A
`--no-install` option MUST support air-gapped or workspace-controlled installs.

### 6.2 Interactive generation

Without `--yes`, the generator MUST ask only these bounded questions:

- project directory;
- package manager (`npm` initially required; alternatives MAY be added later);
- mode (`offline` or `live-demos`), which fixes the corresponding runtime
  profile and does not permit a conflicting profile selection;
- process role (`demo-all`, `buyer`, `seller`, or `verifier`);
- deployment (`local` or `docker`); and
- whether to run the offline smoke after generation.

The two fixed-price runtime profiles defined in section 1 are the only
first-release profiles. Offline mode MUST select only
`dacs-sdk:fixed-price-offline:v1`; live mode MUST select only
`dacs-sdk:fixed-price-x402:v1`. The CLI MUST NOT display unimplemented profiles
as selectable options.

### 6.3 Non-interactive live bootstrap

This command MUST generate the live deployment without spending:

```bash
npm create dacs-agent@latest my-agent -- \
  --yes \
  --mode live-demos \
  --profile dacs-sdk:fixed-price-x402:v1 \
  --deploy docker
```

It MUST finish by running the read-only doctor and reporting `blocked` for every
missing credential, funding source, signed registry object or endpoint. A
blocked doctor is a successful bootstrap but MUST prevent readiness and writes.

The generated application then exposes:

```bash
npm run dacs:doctor -- --phase pre-start --for start
npm run dacs:up
npm run dacs:doctor -- --phase post-start --for start
npm run dacs:setup -- --max-spend-dem 10
npm run dacs:buy -- \
  --listing-ref stor-... \
  --request-file ./request.json \
  --max-service-amount 1.00 \
  --max-network-fee-eth 0.001
npm run dacs:status
npm run dacs:down
npm run dacs:smoke:offline
```

`dacs:up` MUST run only `--phase pre-start --for start` before starting. Once the
processes are running, readiness MUST remain false until the post-start doctor
has tested service endpoints and authenticated loopback messaging. Starting
services MUST NOT publish a Listing or purchase a service.

`dacs:setup` owns bounded setup writes such as Listing and binding publication.
Without live-write confirmation it MUST print a read-only plan and exit without
writes. `dacs:buy` owns exactly one bounded purchase request and MUST require an
exact Listing reference, request input, maximum service amount and maximum
network fee. Neither command may reuse another command's consent. Both commands
are governed by section 13.

## 7. Generated project contract

The generated project MUST have a stable, documented layout equivalent to:

```text
my-agent/
  package.json
  package-lock.json
  tsconfig.json
  dacs.config.ts
  .env.example
  .gitignore
  Dockerfile
  compose.yaml
  README.md
  src/
    buyer.ts
    seller.ts
    verifier.ts
    service.ts
    config.ts
  test/
    offline-lifecycle.test.ts
  data/
    .gitkeep
  secrets/
    README.md
```

Requirements:

- `.env.example` MUST contain names and safe public defaults only.
- `.gitignore` MUST exclude `.env`, `data/`, generated artifacts, logs, wallet
  material and all secret files.
- The Docker image MUST run as a non-root user.
- Buyer and seller containers MUST mount different secret files and different
  durable volumes.
- The same image MAY execute different roles through an explicit command.
- Generated dependencies MUST include reviewed versions of
  `@kynesyslabs/dacs` and `@kynesyslabs/dacs-node`; the template MUST NOT define
  its own database or transport framework.
- Generated source MUST remain small: configuration and application callbacks,
  not copied protocol, transport or database implementations.

## 8. Configuration contract

Configuration MUST be schema-validated before any service starts. Unknown keys
MUST fail closed. Invalid URLs, identifiers, amounts, versions and file paths
MUST be rejected rather than coerced.

The public configuration model MUST cover:

```ts
type DacsAgentConfig = {
  mode: "offline" | "live-demos";
  profile:
    | "dacs-sdk:fixed-price-offline:v1"
    | "dacs-sdk:fixed-price-x402:v1";
  role: "demo-all" | "buyer" | "seller" | "verifier";
  dataDirectory: string;
  publicBaseUrl?: string;
  demos?: {
    rpcUrl: string;
    storageReadUrl?: string;
  };
  rail?: {
    registryIndexRef: string;
    requestedNetwork: string;
  };
  limits: {
    maxServiceAmount: { asset: string; amount: string };
    maxSetupSpendDem: string;
    maxDemosNetworkFeeDem: string;
    maxEvmNetworkFeeEth: string;
  };
};
```

Only these pairs are valid:

| mode | profile |
| --- | --- |
| `offline` | `dacs-sdk:fixed-price-offline:v1` |
| `live-demos` | `dacs-sdk:fixed-price-x402:v1` |

Any other pair MUST fail before stores, identities or adapters are opened.

Signed rail-definition hashes, versions, handlers and availability MUST be
resolved and verified through public SDK APIs. They MUST NOT be copied from an
example into generated configuration. Live mode MUST reject provisional,
unsigned, unavailable, wrong-network or handler-mismatched rail definitions.

The generated project MUST pin an SDK version through its lockfile. It MUST read
the Standard revision from the installed SDK and MUST refuse a configured or
stored session that binds a different unsupported revision.

### 8.1 Authority and wallet ownership model

The first live profile has four signing/payment authorities and one explicit
transport-key ownership rule:

| Authority | Owner and permitted use |
| --- | --- |
| Buyer Demos wallet | Buyer-controlled Demos identity/CCI, buyer DACS artifact signatures, buyer-owned Demos anchors and buyer HTTP envelopes under the separate section 12 domain. It MUST NOT be mounted in the seller process. |
| Buyer EVM payer | Buyer-controlled x402 payment signer. Its address MUST be bound to the buyer and exact settlement authorization/agreement. It MUST NOT sign seller or Demos artifacts. |
| Seller Demos wallet | Seller-controlled Demos identity/CCI, Listing signature, seller DACS artifacts, seller-owned Demos anchors and seller HTTP envelopes under the separate section 12 domain. It MUST NOT be mounted in the buyer process. |
| Seller EVM payee | Seller-controlled x402 destination bound by the signed Listing/agreement and verified rail. It need not be an online signing key for receipt, but ownership/binding MUST be established before publication. |
| Transport identity rule | In v1, `sender` and `keyId` both equal the actor's canonical Demos primary `ClaimRef`; the corresponding actor-owned Demos Ed25519 key signs the HTTP envelope under its separate domain. This is a capability of the actor's Demos authority, not a fifth secret. Buyer and seller keys remain distinct because their Demos authorities are distinct. |

The verifier is read-only by default and requires no wallet. If it signs or
publishes a verifier artifact, it becomes a separate fifth authority with its
own Demos identity key and secret mount.

The generated deployment MUST NOT reuse an EVM payment key as a transport key.
V1 deliberately reuses each actor's Demos key only across domain-separated Demos
and HTTP signatures. Doctor MUST report this ownership model and prove that the
configured key derives the role's Demos primary ClaimRef. No key may be inferred
as role-owned solely because it appears in local configuration. Delegated HTTP
subkeys require a future versioned, authenticated delegation format and are not
accepted by the v1 wire protocol.

## 9. Offline lifecycle requirements

Offline mode MUST bind `dacs-sdk:fixed-price-offline:v1`. It MAY reuse the same
coordinator interfaces and lifecycle ordering as live mode, but MUST use an
offline-only binding validator, store namespace and effect-identity domain.
PR #155's `dacs-sdk:fixed-price-x402:v1` verifier MUST continue to reject the
offline binding.

Offline databases and reports MUST carry `mode: "offline"` and the exact offline
profile identifier. A live service MUST refuse to open, import, resume or
convert them. Moving from offline to live creates a new session with new job,
agreement, effect and artifact identities; it is not an upgrade or continuation.

The deterministic run MUST produce:

1. DACS-1: a correctly signed, locally discoverable Listing;
2. DACS-2: identity and Vet evidence for both role authorities using a supported
   deterministic test recipe;
3. DACS-3: a Listing-bound fixed-price agreement and commitment;
4. DACS-4: deterministic offline settlement, delivery, settlement evidence and
   delivery evidence with offline references; and
5. DACS-5: buyer and seller role copies, required signatures and independent
   verification.

The offline settlement adapter MUST use a `mocked`/offline rail disposition
under a non-production verifier policy and MUST be visibly identified as
offline. It MUST NOT emit an artifact that claims an x402 phase, live rail, live
registry availability or real substrate receipt.

The final `run-report.json` MUST include:

- SDK version and Standard revision;
- profile and mode;
- per-phase start/end/duration and outcome;
- artifact type, canonical content hash and local reference;
- payment amount and explicit `offline` rail disposition;
- buyer and seller bundle verification results; and
- an overall success value that is true only when all mandatory verification
  passes.

## 10. Live lifecycle requirements

Live mode MUST preserve the actor-separated flow proven by the SDK integration
stack:

1. verify identities and wallet bindings;
2. resolve and verify a signed actionable Listing;
3. create role-owned Vet results;
4. derive and sign the fixed-price agreement;
5. obtain the required finalized/readable commitment before settlement;
6. submit x402 payment under an exact deterministic effect identity and prevent
   a duplicate observable payment through rail idempotency or authoritative
   reconciliation;
7. let the seller independently authenticate and verify payment intake;
8. invoke fulfilment through an adapter that provides idempotency or
   authoritative reconciliation, preventing a duplicate observable delivery;
9. publish settlement and delivery evidence;
10. produce and anchor both role-owned terminal bundles; and
11. independently verify the final bundle pair and referenced artifact graph.

The generated application MUST surface progress as events. It MUST NOT appear
frozen while waiting for network inclusion or background finalization.

No phase may be displayed as complete merely because its callback returned.
Completion status MUST use the SDK's verified retained result for that phase.

### 10.1 Irreversible-effect guarantee

The enforceable guarantee is:

> No duplicate observable irreversible effect, provided the external adapter
> supports the supplied deterministic idempotency key or authoritative
> reconciliation.

Generation fences and deterministic effect identities alone do not make an
arbitrary external system exactly-once. Every live irreversible adapter MUST
declare and implement at least one of:

1. `perform(effectId, input)` with durable provider-side idempotency, where an
   exact replay returns the original effect result; or
2. `reconcile(effectId, binding)` returning authenticated `performed`,
   authoritative `absent`, or `indeterminate` before any repeat is permitted.

Payment adapters MUST provide both a stable rail idempotency/authorization
identity and authoritative chain reconciliation. A fulfilment adapter MUST
provide at least one of the two mechanisms. If neither is available, doctor
MUST block live readiness for that adapter. `indeterminate` MUST never authorize
a repeat. The retained state must instead remain in reconciliation or require
operator action.

## 11. Durable storage requirements

Live mode MUST NOT use the SDK's in-memory reference stores.

The initial host kit MUST provide a SQLite implementation with:

- one database per actor authority;
- WAL journal mode and durable synchronous settings;
- atomic schema migrations;
- database-authoritative lease time;
- compare-and-swap generation fences;
- unique reservations for session, message, payment effect, logical address and
  artifact publication identities;
- transactional intent/perform/commit/reconcile state;
- cursor-ordered runnable queries;
- durable send/claim/ack outboxes; and
- an explicit supported store schema version.

SQLite support is local and single-host. Its database and WAL files MUST reside
on a local filesystem supported by SQLite locking. The host kit MUST refuse or
prominently block known network/shared mounts, including NFS, SMB/CIFS and
consumer file-synchronization directories. Both Windows UNC spellings
(`\\server\share` and `//server/share`) MUST be refused on every host platform.
Two containers on the same host MAY
share one actor database only through a single designated database owner;
buyer and seller never share a database. Multi-host deployments MUST use a
separately reviewed external transactional-store adapter and are outside the
first release.

The database authority MUST equal the role-owned party on every admitted
commerce order (`order.buyer` for a buyer store and `order.seller` for a seller
store), including after independently recomputing the order binding and record
hashes. The store MUST also recompute and persist the role-local binding over
the exact SDK job-pointer set in the canonical record and its runnable
projection. Create, load, claim, lease-current, result-recording and operator
requeue paths MUST fail closed on a different role-local binding.

Live coordinator records MUST persist only normative `success`, `failure` or
`aborted` terminal outcomes. Live failures MUST retain DACS-5 fault attribution;
`substrate` failures MUST use neutral `faultedParty: "none"`, while other
failures MUST identify a buyer or seller. Live aborts MUST retain `withdrawnBy`
and MUST NOT be accepted after a successful irreversible payment or delivery.
Offline coordinator records MUST instead persist only the explicit
`simulated-*` outcome and error vocabulary and MUST NOT carry DACS-5 party
attribution.

Effect recovery MUST authenticate the immutable tuple of effect kind, effect
ID, optional job ID, binding hash, input hash and idempotency key before
returning a claim. A pre-proof effect row MUST fail closed rather than receive a
proof during migration. Canonical lifecycle details MUST form a validated
rolling history chain so an altered intermediate transition cannot be skipped.

The store MUST survive process termination at every irreversible boundary. A
stale generation MUST NOT record an outcome after a newer worker has claimed the
work.

Schema migration MUST be forward-only during normal startup. The installer MUST
back up the database before migration and MUST refuse startup if the on-disk
schema is newer than the runtime supports.
Historical migration definitions MUST remain immutable. A legacy store whose
persisted SDK or Standard revision is not an exact supported runtime binding
MUST be refused before backup or mutation; a host MUST NOT relabel or claim to
have migrated data whose compatibility it cannot establish. A compatible
legacy offline terminal record MAY be migrated only by a deterministic mapping
to the explicit simulation vocabulary. A legacy live terminal failure or abort
that predates mandatory fault/withdrawal attribution MUST be refused during
read-only admission before backup or mutation; migration MUST NOT synthesize
the missing DACS-5 attribution.

## 12. Authenticated transport requirements

The first live transport is HTTPS request/response plus durable outboxes. It
MUST carry the SDK's payment-evidence request/completion messages and any
required agreement or finalization handoff without granting seller code access
to the buyer wallet.

Every accepted message MUST authenticate:

- sender principal;
- intended audience;
- message type and version;
- canonical message hash;
- session/job identifier;
- transport-envelope identifier and the typed SDK payload's message/effect
  identifier where one exists; and
- expiry or replay window.

Authentication MUST use an identity key bound to the corresponding DACS role.
Transport authentication results MUST be passed into the SDK's authenticated
callback seams and persisted with their hashes. CORS is not an authentication
mechanism. Wildcard origins MUST NOT be enabled on any browser-facing endpoint.

TLS is mandatory whenever a live endpoint is not loopback. Plain HTTP MAY be
used only for offline mode or an explicitly local reverse-proxy hop.

### 12.1 Endpoint and envelope

The initial protocol endpoint is:

```text
POST /dacs-transport/v1/messages
Content-Type: application/json
```

The decoded body MUST be no larger than 256 KiB. Large artifacts are carried by
authenticated references and content hashes, not inline blobs.

Every message uses this closed envelope:

```ts
type DacsHttpEnvelopeV1 = {
  version: "1";
  type:
    | "agreement-proposal"
    | "agreement-response"
    | "payment-evidence-request"
    | "payment-evidence-completion"
    | "bundle-signature-request"
    | "bundle-signature-response"
    | "acknowledgement";
  envelopeId: string;         // lowercase 64-hex transport identifier
  jobId: string;              // canonical DACS job ID
  sender: ClaimRef;             // public SDK canonical ClaimReference string
  audience: ClaimRef;
  keyId: ClaimRef;            // v1: exactly equal to sender
  algorithm: "ed25519";
  issuedAt: number;           // Unix milliseconds
  expiresAt: number;          // Unix milliseconds
  nonce: string;              // 32 random bytes, unpadded Base64URL
  payloadHash: string;        // lowercase 64-hex
  payload: unknown;
  signature: string;          // unpadded Base64URL Ed25519 signature
};
```

Unknown envelope fields, algorithms, message types or versions MUST be rejected.
The initial release supports Ed25519 transport keys only. Another algorithm may
be added only with a versioned interoperability vector and identity-resolution
rule; an EVM payment signature is not a transport signature.

The `type` field fixes the exact payload shape. The initial mappings are:

| Envelope type | Exact payload |
| --- | --- |
| `agreement-proposal` | `{ proposal: FixedPriceAgreementProposal; transportIdentity: FixedPriceAgreementTransportIdentity }`, the data-only portion of the public SDK `DurableSellerFixedPriceAgreementInput` |
| `agreement-response` | public SDK `DurableSellerFixedPriceAgreementResponse` |
| `payment-evidence-request` | public SDK `PaymentEvidenceAnchorRequest` |
| `payment-evidence-completion` | public SDK `PaymentEvidenceAnchorCompletion` |
| `bundle-signature-request` | `DacsBundleSignatureRequestV1` below, a JSON projection of public SDK `CompletedSellerBundleCounterSignatureRequest` |
| `bundle-signature-response` | public SDK `BundleSignature` for exactly one required counter-signer |
| `acknowledgement` | `DacsHttpAcknowledgementV1` from section 12.5 |

```ts
type DacsBundleSignatureRequestV1 = {
  bundleContentHash: string;
  signedScope: Record<string, unknown>;
  signedBytes: string; // unpadded Base64URL projection of the SDK Uint8Array
  requiredCounterSigners: string[];
};
```

The host kit MUST validate each payload with the corresponding public SDK
validator or verifier before invoking a coordinator. For a bundle request it
MUST Base64URL-decode `signedBytes`, reconstruct the SDK request and call
`verifyCompletedSellerBundleCounterSignatureRequest` against independently
resolved session facts before signing. A bundle response MUST contain one
canonical `BundleSignature`; its `party` MUST equal the authenticated `sender`,
must occur in `requiredCounterSigners`, and its signature MUST verify over the
exact decoded `signedBytes`. Arrays of signatures and unrequested signers are
rejected. These payload DTOs are operational transport records, not new DACS
artifact fields.

`envelopeId` belongs only to the HTTP transport and MUST NOT replace or be
confused with a typed SDK payload's `messageId`, `effectId`, `requestHash` or
`completionHash`. For the payment-evidence SDK authentication callbacks, a
successfully authenticated envelope maps to `PaymentEvidenceAuthenticatedPeer`
exactly as follows:

```ts
{
  principal: envelope.sender,
  audience: envelope.audience,
  messageId: envelope.payload.messageId,
  messageHash: envelope.type === "payment-evidence-request"
    ? envelope.payload.requestHash
    : envelope.payload.completionHash,
  authenticationHash: lowerHex(envelopeHash)
}
```

The host MUST additionally verify that the SDK payload's seller, buyer, job and
role direction equal the authenticated envelope facts. A mismatch is an
authentication failure, not a retryable application error.

### 12.2 Canonical bytes and domain separation

All canonicalization MUST use the public SDK canonical JSON implementation.
Implementations MUST calculate:

```text
payloadHash = lowerHex(SHA-256(UTF8(canonical(payload))))

envelopeId = lowerHex(SHA-256(
  UTF8("dacs-http-envelope-id:v1:") || UTF8(canonical({
    type, jobId, sender, audience, nonce, payloadHash
  }))
))

envelopeHash = SHA-256(UTF8(canonical(envelope without signature)))

signedBytes = UTF8("dacs-http-message:v1:") || envelopeHash
```

In this notation, `||` means byte concatenation, never string coercion.
`envelopeHash` is the raw 32-byte SHA-256 output in `signedBytes`, not its hex
text. `signature` is Ed25519 over exactly `signedBytes`. A receiver MUST
recompute `payloadHash` and `envelopeId` before accepting the signature result.
No DACS artifact signature domain may be reused for this operational envelope.

The repository MUST publish positive and negative byte-exact vectors for every
message type, including Unicode, key ordering, numeric edge cases, modified
payload, modified audience, wrong domain and padded-Base64URL rejection.

### 12.3 Identity-key resolution

In v1, `keyId` MUST exactly equal `sender`. The value MUST be the actor's
canonical Demos primary `ClaimRef`, and the receiver MUST obtain its exact
Ed25519 public key through the public SDK Demos identity resolver. The resolver
MUST verify the relevant DACS identity material, expiry and revocation state and
establish that `sender` holds the envelope's buyer or seller role for `jobId`.
Canonical CF-2 parameters, when present, remain in the signed and forwarded
`sender`, `audience` and `keyId` bytes. Principal ownership, local-audience and
same-party checks use the parameter-free CF-3 identity.

An unresolved, expired, revoked, ambiguous or role-incompatible key is an
authentication failure. A locally configured public key, alternate key ID or
delegated subkey is not sufficient in v1. Resolution results and their evidence
hashes MUST be retained with the inbox record.

### 12.4 Time and replay rules

The initial limits are:

- maximum envelope lifetime: 300,000 ms;
- maximum accepted future clock skew: 60,000 ms;
- nonce entropy: exactly 32 bytes; and
- maximum request body: 256 KiB.

A receiver MUST reject `expiresAt <= issuedAt`, a lifetime over five minutes, an
expired envelope or `issuedAt` more than 60 seconds in the future. Store time,
not an HTTP header or sender time, governs the decision.

Before invoking an action-bearing handler, the receiver MUST atomically reserve
`(sender, audience, envelopeId)` with `nonce`, `payloadHash`, authentication
hash and disposition. An exact replay returns the retained disposition and
creates no new action. The same identity with different nonce, payload hash or
envelope facts is a permanent conflict.

Inbox replay reservations MUST be retained until at least seven days after the
session becomes terminal and never for less than seven days after receipt.
Outbox messages and acknowledgements MUST be retained for the same period.
Deployments needing a longer dispute/recovery window MUST configure a longer
retention period; shortening below this minimum is invalid.

### 12.5 Acknowledgement and retry

An acknowledgement is itself a signed `acknowledgement` envelope whose payload
is exactly:

```ts
type DacsHttpAcknowledgementV1 = {
  acknowledgedEnvelopeId: string;
  acknowledgedPayloadHash: string;
  disposition: "accepted" | "existing" | "rejected";
  reasonCode?: string;
};
```

`reasonCode` MUST be absent for `accepted` and `existing`; it is required for
`rejected` and MUST be a documented bounded code rather than a raw exception.
An acknowledgement is returned directly as the signed response envelope and is
never itself acknowledged.

The acknowledgement envelope MUST use the original `jobId`, reverse the
original `sender` and `audience`, and bind the exact original `envelopeId` and
`payloadHash`. The sender MUST reject an acknowledgement whose signer, audience,
job, acknowledged identifiers or retained authentication evidence do not match
the claimed outbox item.

The receiver MUST durably reserve and process the inbound message before
creating the acknowledgement. The sender MUST durably authenticate and record
the acknowledgement before marking its outbox item acknowledged. An HTTP 2xx
without a valid signed acknowledgement is transport-ambiguous and MUST NOT
clear the outbox.

Retries MUST resend the exact signed envelope and envelope ID with exponential
backoff starting at one second, capped at 60 seconds, with jitter. A retry MUST
NOT replace an expired message automatically. After expiry, the owning SDK
operation must re-evaluate whether work is still valid and, if so, create a new
envelope containing the same stable effect identity in its typed payload; the
old inbox reservation remains authoritative for the old message.

### 12.6 HTTP dispositions

The transport uses:

- `200`: authenticated exact replay with signed acknowledgement;
- `202`: newly authenticated and durably accepted with signed acknowledgement;
- `400`: malformed versioned envelope;
- `401`: signature or identity authentication failure;
- `409`: message identity conflict;
- `413`: body too large;
- `429`: bounded rate limit, with `Retry-After`; and
- `503`: transient inability to durably accept.

HTTP status alone never proves DACS phase completion. Only the retained SDK
state and verified artifacts do so.

## 13. Secrets, wallets, funding and spending

Secrets MUST NOT be supplied as command-line values, written to generated
configuration, printed, committed or included in run reports.

The supported precedence is:

1. secret file mounted read-only with mode `0600`;
2. operating-system secret manager adapter; or
3. environment variable only for controlled CI, with a doctor warning.

Live mode requires distinct role-appropriate Demos identity keys and x402/EVM
wallet authority. The installer MUST verify that public addresses derived from
secret material match configured identities before any write.

No command may automatically call a faucet. Doctor MAY print official funding
instructions and the public address that needs funding.

All setup writes require both `DACS_SETUP_WRITE_CONFIRM=1` and an explicit setup
DEM ceiling. Every purchase requires both `DACS_PURCHASE_CONFIRM=1` and explicit
service-amount and network-fee ceilings. The variables are intentionally not
interchangeable; there is no generic all-purpose live-write confirmation.

Before executing, the command MUST print a sanitized plan containing action
count, rail/network, maximum asset spend, maximum network fee and whether any
payment is possible. It MUST ask for an interactive confirmation unless
`--non-interactive` is paired with the confirmation variable and budgets.

### 13.1 Guarded setup command

`npm run dacs:setup -- --max-spend-dem <decimal>` owns setup-time Demos writes.
Its default behavior is plan-only. An executing invocation MUST require a fresh
successful post-start/start doctor result and run the pre-start/setup scope. It
MUST bind the consent to the canonical setup plan hash, exact wallet identities,
Demos network,
Listing content hash, write count and DEM ceiling. A changed plan requires new
consent. Setup MUST stop before the first write if the ceiling does not cover the
whole plan plus the configured safety margin.

The command MUST be idempotent: already verified publications are reused; an
ambiguous publication is reconciled; and a conflicting existing publication
fails closed. Setup consent never authorizes a purchase.

### 13.2 Guarded purchase command

`npm run dacs:buy` owns one purchase intent. It MUST require:

- an exact signed Listing reference;
- a schema-validated request file;
- a maximum service amount in the Listing's selected asset;
- a maximum Base network fee in ETH for the initial profile; and
- a fresh purchase idempotency identity, or an explicit request to resume an
  existing retained job.

Before plan or execution it MUST run the post-start/buy doctor scope. A stale
readiness latch, failed authenticated transport probe, unresolved Listing or
insufficient balance blocks the purchase before commitment.

The command MUST resolve and display the exact Listing, seller, payee, rail,
network, service amount and fee ceilings before consent. Retry/resume MUST reuse
the retained job and effect identity. A new invocation with the same user-level
request but no explicit resume MUST NOT silently attach to or repeat an earlier
purchase.

Setup and purchase confirmations MUST be distinct domain-separated consent
records. Neither may be inferred from `dacs:up`, doctor, a previous run or a
generic environment variable alone.

The payment path MUST never rebroadcast merely because status is unknown. An
ambiguous submission must enter reconciliation using the same durable effect
identity.

## 14. `dacs doctor` release gate

The existing doctor is a foundation, not yet the complete live gate. Before the
installer can call live mode production-ready, doctor MUST report every
requested check as `pass`, `fail` or `blocked` and implement:

### 14.1 Pre-start and post-start phases

Doctor also requires an operation scope: `--for start`, `--for setup`, or
`--for buy`. Every check is still reported, but only checks required by the
selected operation gate that operation. `dacs:setup` MUST run the setup scope;
`dacs:buy` MUST run the buy scope.

`--phase pre-start` MUST check everything available before role services exist:
configuration, files, stores, secrets, identities, wallets, balances, registries,
external RPC/facilitator dependencies, ports and deployment runtime. It MUST NOT
require the generated service endpoints to be reachable. `dacs:up` runs this
phase for the `start` scope and MUST refuse startup on any start-required `fail`
or `blocked` result. A not-yet-published Listing is not start-required, but is
setup- or buy-required as applicable.

`--phase post-start` MUST repeat or consume a freshness-bounded signed result of
the pre-start checks and additionally verify:

- liveness endpoints and local readiness prerequisites for every enabled role;
- authenticated buyer-to-seller and seller-to-buyer loopback messages;
- durable inbox, outbox and acknowledgement round trips with no action-bearing
  callback;
- public endpoint reachability from an independent probe when a public endpoint
  is configured; and
- role, SDK version, Standard revision, profile and store-schema agreement
  across processes.

Post-start probes MUST use a reserved non-commerce message/payload and MUST NOT
publish, settle or invoke fulfilment. `/ready` initially returns not-ready. Once
all post-start prerequisites pass, the local supervisor sets a durable/freshness-
bounded readiness latch and doctor MUST verify that `/ready` then succeeds. A
post-start failure leaves the latch false, stops purchase/setup commands, but
need not terminate the processes needed for diagnosis.

### 14.2 Local checks

- supported Node version;
- installed package and export integrity;
- exact SDK and Standard versions;
- configuration schema;
- writable data directory and free disk threshold;
- SQLite schema and lock availability;
- secret existence, ownership and permission warnings;
- distinct buyer/seller authority and secret-mount checks;
- buyer/seller transport key resolution to the correct DACS role; and
- container/runtime availability when Docker deployment is selected.

### 14.3 Demos checks

- RPC origin and chain identity;
- StorageProgram read capability;
- authenticated logical/native binding resolution;
- current address nonce;
- Demos/OS balance and fee headroom;
- buyer Demos wallet-to-buyer identity binding;
- seller Demos wallet-to-seller identity binding;
- candidate Listing validation for setup, or exact existing Listing and required
  registry resolution for buy/resume; and
- configured Listing engagement endpoint shape before start, with actual
  endpoint reachability deferred to post-start.

### 14.4 x402 checks

- authenticated signed rail registry and definition;
- correct rail ID, version, handler, availability and network;
- non-mainnet policy for the first release;
- facilitator/resource endpoint reachability;
- buyer EVM payer-to-buyer settlement binding;
- seller EVM payee-to-seller Listing/agreement binding;
- payment asset balance;
- native gas balance;
- configured maximum service amount; and
- estimated network and service costs with safety margin.

### 14.5 Doctor safety

Default doctor execution MUST be GET/read-only and zero-spend. A funded smoke is
a separate `npm run dacs:doctor:funded` command requiring a named disposable
wallet, `DACS_DOCTOR_FUNDED_CONFIRM=1`, an explicit maximum cost and interactive
confirmation unless explicitly non-interactive. Its consent authorizes neither
setup nor purchase. Unsupported checks MUST return `blocked`; they must never
silently pass.

JSON output and exit codes MUST remain stable and documented.

## 15. Service and deployment contract

The generated deployment MUST expose:

- `GET /health`: process liveness only;
- `GET /ready`: true only while the freshness-bounded post-start readiness latch
  from section 14.1 is valid; the latch requires configuration, stores,
  dependencies, service endpoints and authenticated transport probes to pass;
- `GET /status`: sanitized role, version, queue and active-session summary;
- a versioned authenticated message endpoint; and
- an optional local-only artifact inspection endpoint.

Health endpoints MUST never disclose wallet addresses unless explicitly
configured as public identity information, and MUST never disclose balances,
nonces, secrets, raw authorization payloads or private provider URLs.

Docker Compose MUST configure:

- non-root containers;
- read-only root filesystems where feasible;
- separate buyer and seller secrets;
- separate persistent data volumes;
- `restart: unless-stopped`;
- bounded memory and log rotation;
- health checks; and
- no public database port.

The installer MUST NOT configure DNS, firewall rules, Caddy, nginx or cloud
accounts automatically. It MAY generate reviewed example reverse-proxy
configuration.

## 16. Observability and user experience

Every lifecycle run MUST emit structured events with:

- job ID;
- actor role;
- DACS stage and internal track;
- state, outcome and sanitized reason code;
- elapsed duration;
- artifact or transaction reference when public and safe; and
- whether remaining finalization is synchronous or background work.

Logs MUST be JSON-capable and redact configured secret values and sensitive URL
components. Raw callback exception strings MUST not enter durable state.

The CLI MUST distinguish:

- queued work;
- waiting for counterparty;
- waiting for chain finality;
- waiting for artifact visibility;
- reconciliation required;
- operator action required;
- terminal failure/abort; and
- fully verified completion.

## 17. Upgrade and rollback

The generated project MUST pin exact dependency versions in its lockfile.

`npm run dacs:upgrade -- --check` MUST be read-only and report:

- installed and available versions;
- supported store migration path;
- Standard revision change;
- breaking configuration changes; and
- whether active or recovering sessions prevent upgrade.

An upgrade MUST refuse to run while an irreversible session effect is active or
requires reconciliation. Before migration it MUST create a restorable database
backup and record the previous image/package version. Rollback instructions MUST
be generated, but rollback MUST refuse if it would require opening a store schema
newer than the old runtime supports.

## 18. Security requirements

The generator and generated application MUST:

- reject symlinks for secret inputs unless explicitly permitted by policy;
- reject secret files writable by group or others in live mode;
- prevent path traversal when writing project files;
- refuse to overwrite a non-empty target directory without explicit approval;
- use constant or sanitized error messages across authentication boundaries;
- apply bounded request sizes, timeouts and rate limits;
- authenticate before parsing action-bearing message bodies beyond the bounded
  envelope needed for authentication;
- use role-qualified idempotency identities;
- preserve fail-closed rail and registry verification;
- never use `*` for credentialed browser CORS; and
- produce an npm dependency audit and software bill of materials for releases.

The installer MUST be threat-modelled as code execution from npm. Releases MUST
therefore use protected publishing, mandatory review, provenance and a clean
source-to-tarball verification step.

## 19. DACS and SDK conformance

The installer MUST not define new signed artifact fields or weaken lifecycle
ordering. Operational configuration, database records, cursors, leases, HTTP
envelopes and Docker settings remain outside the DACS artifacts.

The generated lifecycle MUST retain these invariants:

- signed Listing and exact Listing/version/hash pinning;
- identity and Vet evidence before agreement commitment;
- agreement commitment before payment;
- confirmed/final rail result before delivery authorization;
- deterministic payment identities and no duplicate observable payment under
  delayed reads or process recovery when the rail supplies idempotency or
  authoritative reconciliation as required by section 10.1;
- reachable settlement and delivery evidence;
- role-owned DACS-5 copies with required signatures; and
- independent verification of the final artifact graph.

Any open Standard gap, including provenance that cannot be established
normatively, MUST be reported as unsupported or blocked. The installer MUST NOT
invent a local field and describe it as Standard-conformant.

## 20. CI and release acceptance

### 20.1 Generator CI

For every supported Node version, CI MUST:

1. build and pack the SDK from the candidate source;
2. build and pack `@kynesyslabs/dacs-node` and `create-dacs-agent` separately;
3. install the generator into a clean temporary environment;
4. generate a project using non-interactive flags;
5. verify no repository-relative or unpublished dependency is present;
6. install from the exact packed artifacts;
7. typecheck and build the generated project;
8. run the offline lifecycle;
9. validate every artifact through public SDK verifiers;
10. verify the report schema and expected phase ordering; and
11. scan the generated tree for secrets and forbidden imports.

The test MUST also run without optional live peers installed when generating the
offline template.

### 20.2 Recovery CI

CI MUST kill and recreate buyer and seller processes after each of these
boundaries:

- agreement intent;
- commitment submission;
- payment intent;
- ambiguous payment response;
- authenticated Demos confirmation before delayed read/index projection;
- payment finality before seller acknowledgement;
- buyer payment-evidence anchoring after the anchor succeeds but before the
  completion is durably recorded;
- completion outbox send after the seller receives it but before the sender
  durably records acknowledgement;
- authenticated completion receipt before the seller durably records the
  corresponding session transition;
- seller request/completion outbox send after receiver acceptance but before
  acknowledgement;
- fulfilment callback before acknowledgement;
- settlement/delivery evidence publication intent; and
- buyer and seller bundle publication intent.

Each case MUST prove that effect identifiers and resulting references are
reused, not recreated; exact outbox replays are deduplicated; and no duplicate
observable irreversible effect occurs under the adapter contract in section
10.1. Tests MUST include `indeterminate` reconciliation and MUST prove it never
authorizes a repeat.

### 20.3 Guarded live acceptance

Before stable release, a clean test VPS MUST complete one explicitly budgeted
testnet run using only the generated project and published package surfaces. The
evidence report MUST prove:

- one payment;
- one fulfilment;
- correct identity, agreement and rail bindings;
- confirmed settlement;
- both terminal bundles;
- independent verification; and
- successful recovery after one real process restart.

The report MUST record independent elapsed timings for:

- payment finality;
- buyer-received;
- commerce-complete (the live x402 SDK projection's
  `commercial-performance-complete` milestone); and
- audit-complete (the live x402 SDK projection only).

The report MUST distinguish network confirmation, Demos read/index projection,
application work and background bundle finalization rather than publishing only
one end-to-end duration.

No credential, private endpoint or reusable authorization may be retained in CI
artifacts.

## 21. Dependency-ordered implementation plan

### Work package 0 — merge and freeze the engine

- Resolve PR #153's stale review state.
- Merge the reviewed dependency stack in maintainer-approved order.
- Merge PR #155 after exact-head approval.
- Record the resulting main-branch SDK SHA as the generator development base.

No one-click branch may silently vendor pre-merge SDK code.

### Work package 1 — publishable SDK

- Port or restack PR #105's declaration isolation and clean TypeScript consumer.
- Reconcile and merge PR #152's reproducible package/provenance pipeline.
- Merge or fold the relevant live runbook from PR #146.
- Publish an alpha SDK package and verify installation from the public registry.

Exit gate: a clean consumer can install, typecheck, build and import the SDK
without repository access.

### Work package 2 — host-kit contract and package skeleton

- Add the separately reviewed core offline profile constants/factories defined
  in section 5.1 without changing PR #155's live admission semantics.
- Create `@kynesyslabs/dacs-node` with its independent dependency boundary.
- Publish the stable host interfaces for configuration, events, role services,
  stores, effect adapters and transport.
- Implement and vector-test the section 12 envelope canonicalization, signing,
  authentication and acknowledgement types.
- Implement host-side `dacs-sdk:fixed-price-offline:v1` binding construction
  against the new core factories and test hard isolation from PR #155's live
  profile.
- Add package smoke tests proving the core SDK does not acquire Node/SQLite/HTTP
  dependencies through the host kit.

Exit gate: the generator can target stable host-kit interfaces without embedding
an architecture that will be replaced by the live implementation.

### Work package 3 — offline generator

- Implement `create-dacs-agent` against the work-package-2 host contracts.
- Generate the bounded project layout.
- Implement the deterministic offline fixed-price lifecycle under
  `dacs-sdk:fixed-price-offline:v1`.
- Produce and verify the complete run report.
- Add packed-artifact clean-project CI.

This work package directly satisfies the offline portion of issue #59 and can be
developed on a draft branch stacked on #155 before merge, provided it is rebased
and retested against the final release SHA.

### Work package 4 — production host-kit implementation

- Implement the local-only SQLite coordinator and handshake stores.
- Implement the section 12 authenticated HTTP transport and durable outboxes.
- Add role-separated service entrypoints and health/status APIs.
- Add secret-file loading, authority separation and redaction.
- Add failure-injection and process-restart tests.

Exit gate: the live-shaped application survives every required crash boundary;
reuses deterministic effect identities; and produces no duplicate observable
irreversible effect under the adapter capability contract in section 10.1.

### Work package 5 — complete doctor

- Implement all checks in section 14.
- Add cost estimation and budget enforcement.
- Add stable JSON schema, exit-code and redaction tests.
- Add an explicit, separately guarded funded smoke.

This work package closes the remaining scope of issue #60.

### Work package 6 — Docker live bootstrap

- Generate Dockerfile and Compose deployment.
- Enforce role-separated secrets and volumes.
- Add pre/post-start doctor scopes, `dacs:setup`, `dacs:buy`, `dacs:up`,
  `status`, `down` and upgrade-check commands.
- Run the clean-VPS acceptance test.

Exit gate: a new user can generate the project, add secret-file paths, fund the
reported public addresses, pass doctor and start a recoverable deployment
without editing lifecycle code.

### Work package 7 — additional profiles

After the first release is stable:

- add native pay-DEM using the reviewed result of PR #154;
- add RFQ only after issue #53 supplies the supported negotiation lifecycle;
- add new templates only when their SDK public surfaces and funded recovery
  tests are complete.

## 22. Definition of done

The one-click installer is complete only when all of the following are true:

- `npm create dacs-agent@latest my-agent -- --yes --run` succeeds from a clean
  supported machine;
- no local SDK checkout is required;
- offline output contains valid inspectable DACS-1 through DACS-5 artifacts;
- offline state is bound to `dacs-sdk:fixed-price-offline:v1` and is rejected by
  every live-session admission path;
- the generated project compiles using public package declarations without
  optional live peers;
- `@kynesyslabs/dacs-node` supplies the generated project's database, transport
  and service implementation without polluting the core SDK;
- live mode uses durable stores and role-separated authorities;
- pre-start and post-start doctor scopes block every operation-specific missing
  prerequisite before writes;
- no funding or spending happens without explicit bounded consent;
- setup and purchase are separate guarded commands with separate consent;
- crash tests prove deterministic effect reuse and no duplicate observable
  irreversible effect under the required idempotency/reconciliation contract;
- authenticated HTTP byte vectors, replay handling, acknowledgements and
  retention rules pass interoperability tests;
- Docker deployment passes health/readiness and restart tests;
- a guarded generated-project testnet run completes, verifies both bundles and
  records buyer-received, commerce-complete (the live x402 projection's
  `commercial-performance-complete`) and live x402 audit-complete timings;
- package and generator releases carry provenance; and
- documentation gives accurate setup, funding, recovery, upgrade and rollback
  instructions.

Until these gates pass, the product MAY be described as an offline quickstart or
experimental live bootstrap, but MUST NOT be described as a production one-click
DACS agent deployment.
