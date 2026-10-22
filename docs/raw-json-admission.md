# Explicit raw-byte JSON admission (local candidate)

`admitRawJson(bytes)` implements the CORE §B.2 CF-5 admission boundary from
DACS-Standard `b80919cd7b114499ffc3d9b5c2f3f91ca7fab3f6`.

```ts
import { admitRawJson, canonicalize } from "@kynesyslabs/dacs/canonical";

// bytes must be the exact received UTF-8 bytes, before text decoding or parsing.
const value = admitRawJson(bytes);
const canonical = canonicalize(value);
```

The SDK admits at most 1 MiB (1,048,576 bytes) by default. Callers may choose a
smaller or larger finite positive integer with `{ maxBytes }`, capped at
10,000,000 bytes. Bounded Demos RPC block reads use 4 MiB (4,194,304 bytes);
Directory search can use its configured budget up to 10,000,000 bytes:

```ts
const value = admitRawJson(bytes, { maxBytes: 256 * 1024 });
```

This byte cap is an SDK resource policy, **not** a universal CF-5 byte limit or
a DACS conformance outcome. An over-budget view fails with parse-stage
`BYTE-LIMIT-EXCEEDED`; CF-5 profile failures remain separately identified as
profile-stage errors. The bound charges the supplied `Uint8Array`/`Buffer` view,
not its backing allocation. Applications remain responsible for limiting
concurrent admissions and for applying tighter ingress-specific limits where
their memory and latency budgets require them.

It rejects invalid UTF-8 and BOMs, non-JSON syntax, duplicate decoded object
names, unpaired surrogates, out-of-profile raw numeric values, and nesting over
128 containers. The exact decimal magnitude check occurs before binary64
rounding can erase a fraction above the safe bound. Object member names remain
unchanged; NFC value normalization belongs to the later canonicalizer.

`RawJsonAdmissionError` extends `DacsError` and carries `stage` (`parse` or
`profile`) and `code`. Invalid options or bounds throw `TypeError`. These
failures are not failed cryptographic signatures.
Canonicalization, schema checks, signed-scope selection, and signature and
protocol verification remain subsequent operations.

The held `packages/dacs-client` snapshot preserves these diagnostics for both
Directory and storage Listing reads. Its HTTP wrapper retains the admission
error's `code`, `stage`, and `cause`, and the Listing verifier propagates that
error before subsequent reader and profile checks. JSON admission alone grants
no purchase eligibility; the SDK profile gate still applies.
The client package remains private with empty exports.

Negative zero (for example `-0.0`) is an admitted CORE §B.2 number that
serialises as `0`. The following APIs treat an admitted `-0` exactly like `0`,
and their owned snapshots hold `0`: `contentHash`, `stripSignature`,
`canonicalSignedScope`, `signArtifact` and `verifyArtifact`, the
component-signature verifier, the Listing verifiers `discoverListings`,
`verifyReadableListingArtifact` and `authenticateReadableListingArtifact`, the
ordered DACS-1 §6.3.4 reader
`validateListingArtifact` with its revocation, payload-capability and
reachability helpers, the rail resolver `resolveListingRails`, anchored
discovery through `readListingByLogicalAddress`, the result binder
`isVerifiedListingAdmission` used by seller payment intake, and the received
message of DACS-3 channel admission (`admitChannelMessage`). The object-oriented
helpers normalize an in-memory `-0`. Listing verification and ordered admission
require original bytes and admit negative-zero number tokens before normalizing
the owned value. The structural guards `isExactJsonRecord`, `isListing` and
`readListingArtifact` accept the received number domain, including `-0`, without
mutating caller data. Bundle dependency reads normalize their owned snapshots.
Locally authored artifacts and local state should use `0`: `signComponentArtifact`,
`buildComponentSignature`, `prepareChannelMessageSigningInput` and the
admission context of `admitChannelMessage` refuse an in-memory `-0` as a
non-wire alias. Other helpers may own their input the way the read
boundaries above do and hold `0`; neither spelling changes a hash or a
comparison.
Wire-format reads that must keep a transport's exact JSON also refuse it,
because their owned copy is not re-parsed from canonical bytes.

This is an **explicit API**, not a current-profile switch. Existing object-based
SDK consumers, adapters, caches and restored session records do not acquire
raw-byte provenance by importing this helper. Do not use `JSON.stringify` of
an already parsed object as evidence of original CF-5 admission. Integration
must retain exact bytes or enforce authenticated byte-admission provenance at
each actual ingress. The SDK-wide Standard pin remains unchanged.

The generic `stripSignature`, `canonicalSignedScope` and `contentHash` helpers
omit only the singular `signature` member by default. For a normative Agreement,
select its plural field explicitly, for example `contentHash(agreement, "signatures")`.
All other top-level members remain in the hash, including an unknown `signatures`
extension on a Listing or RailDefinition. Bundle callers should use
`attestationBundleHash`, which also omits the defined `anchoredByRole` field.
The generic `signArtifact` / `verifyArtifact` helpers select plural `signatures`
for Agreements and ChannelTranscripts, and singular `signature` for ordinary
single-signature artifacts. They refuse the IdentityBundle presentation and
three terminal bundle domains: use `identityBundleHash` or `attestationBundleHash`
and the corresponding artifact-specific signing and verification paths.

`createBoundArtifactRepository` requires a trusted `contentHashOf` dependency,
used for both publication and binding reads. Select it from the expected
artifact contract in application context, independently of the record's fields:

```ts
const repository = createBoundArtifactRepository({
  adapter, index, publisher,
  contentHashOf: (record) => contentHash(record, "signatures"), // Agreement
});
```

Use `contentHash` for singular-signature artifacts such as Listings and ratings,
`(record) => contentHash(record, "signatures")` for all four Agreement types and
ChannelTranscripts, `attestationBundleHash` for terminal bundles, and
`identityBundleHash` for IdentityBundles. Configure separate repositories for
different contracts, or supply a resolver bound to trusted application context.
A record may satisfy several additive schemas; its fields never select or
change the repository's contract. Existing repository callers must supply this
dependency explicitly. Schema/version validation and signer authorization still
require the reader's artifact-specific verifier. Hash support alone does not
enable execution of identity-bound phases.

Opposite-named extensions remain in the content hash. Anchor metadata also
retains a full-envelope hash, including all signature and per-copy fields.
These hashes bind the stored record; readers still need the artifact's signature
verifier to authenticate it.

Verified Listing admission results carry `executionMode: "simulation"`. Public
Listing result binding requires that literal marker as well as the admitted
bytes and matching Listing hash.

On Demos, `DemosAdapter.readAnchor` returns a storage program's `data` already
parsed by `@kynesyslabs/demosdk`. The SDK writes Listings with the `json`
encoding, and the node stores that member as `jsonb` and serves it through
`JSON.stringify` in source revision
`kynesyslabs/node@ac8f45f02fc9c25082ce9b83595c2e3916b49c5a`. That source reference
does not pin the deployed build. The publisher's exact bytes are gone before
any reader receives them. These parsed Listing reads carry no CF-5 provenance and cannot admit a new
normative session. `validateListingArtifact` requires a `Uint8Array` or `Buffer`
of the original artifact JSON, and refuses parsed objects before verification.
The public `verifyReadableListingArtifact` and `authenticateReadableListingArtifact`
helpers, session and discovery boundaries also refuse parsed-only normative Listings
before hashing them. A substrate may implement `readAnchorBytes` to supply exact
original bytes; it must not reconstruct them from JSONB or an already parsed
response. This adapter does not currently provide that capability for its JSON-encoded Listings.
The cited node source also supports binary storage with base64 data; a compatible
binary publisher and reader could retain exact bytes. The running node revision
and build digest must be established separately before enabling any future live profile.

Seller historical admission requires the original result object returned by
`validateListingArtifact`. The SDK retains non-serializable provenance and binds
it to the exact result snapshot before consuming the resolver response. A restored
checkpoint must re-admit retained original bytes with trusted validation dependencies
for the historical admission time. Copying result fields or rendering parsed JSON
as base64 does not retain provenance. The host's native DEM and x402 seller
checkpoints retain the original admitted bytes alongside the historical admission
time. Restored authorities rerun the ordered reader using cryptographic checks,
the authenticated rail, and the actor-local record of historical revocation
absence, then return its original result object. Older checkpoints lacking those
bytes require fresh admission before they can authorize payment intake.

Tests vendor the byte-exact upstream `raw-json-profile-v0.1.json` corpus from
that revision. All 59 outcomes and accepted canonical bytes are checked, along
with API misuse, resource bounds, prototype-named members, view offsets and
hostile-depth cases.

The SDK-wide pin `d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20` also declares an
**unreleased corrective candidate**, not an admissible live profile. Its complete
tuple is CORE 0.3, DACS-1 0.7, DACS-2 0.6, DACS-3 0.5, DACS-4 0.8, DACS-5 0.5.
Agent construction and the Listing, session, seller payment and live coordinator
entry points default to refusing live protocol action before dependency calls.
The public `x402Settle`, `payDemSettle`, `evmErc20Settle`, and `payD402Settle`
bridges likewise require explicit local simulation policy in their options before
reading payment coordinates or accessing a settlement store. Connected wallet
rail and seller paywall factories, registry `settleFromRail` dispatch, and the
host's connected buyer payment track refuse even a simulation label before
constructing wallets. The connected DACS EVM challenge client and Stripe AP2
integration likewise remain unavailable. The injected payment cores, durable
AP2/SPL/x402 engines, retained paid HTTP transport and recovery, x402 preparation
and paywall core, and alternative payment authorization helper
require separate local execution policy (their final argument). The host's
injected x402 buyer payment track captures policy from its construction options.
All of these boundaries default to refusing live execution.
Copying this pin or tuple into an artifact or caller-supplied profile record does
not grant admission. `executionMode: "simulation"` is explicit trusted local
policy for non-live conformance fixtures with injected local dependencies; it is
not live profile evidence. The connected Demos `createAgent` and
`createUnsafeManualAgent` factories and live host service, role runtime and purchase
queue remain unavailable even with a simulation label. Simulations use injected
local dependencies. Successful reader/session results identify this mode.
The retained x402 paid HTTP and disclosure recovery factories require either
an injected `fetchImpl` with `transportPolicy.mode: "insecure-test"` or complete
injected `publicHttpsDependencies` (`resolveHost` and `request`). Missing transport
dependencies are refused at construction, before DNS or paid HTTP access.
A future live release needs both a coordinated release pin and verifier- or
orchestrator-owned, authenticated evidence binding the exact session and every
expected participant identity to that exact pin and complete tuple. The current
SDK has no switch that admits such a live release.

`readListingByLogicalAddress` retains the SDK-owned validation result. Pass its
`validation` directly to historical seller intake; cloning or serializing that
result loses runtime provenance. Restored checkpoints must re-admit the original
received bytes through the ordered reader.
