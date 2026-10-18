# Raw-byte JSON admission

`admitRawJson(bytes)` implements the CORE §B.2 CF-5 admission boundary from
DACS-Standard `b80919cd7b114499ffc3d9b5c2f3f91ca7fab3f6`.

```ts
import { admitRawJson, canonicalize } from "@kynesyslabs/dacs/canonical";

// bytes must be the exact received UTF-8 bytes, before text decoding or parsing.
const value = admitRawJson(bytes);
const canonical = canonicalize(value);
```

The SDK admits at most 1 MiB (1,048,576 bytes) by default. Callers may choose a
smaller or larger finite positive integer with `{ maxBytes }`, capped at 2 MiB
(2,097,152 bytes):

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

`admitArtifactJson(exactReceivedBytes)` admits an external JSON object and
retains runtime provenance for the discovery and authenticated payment APIs.
Its optional second argument selects an object member from a fully admitted
transport envelope. `DemosAdapter.readAnchor` uses this at the public storage
transport boundary, with a 1 MiB response bound and a 30-second timeout.
Custom adapters must retain exact bytes and use the same API before returning
a record. CF-5-valid negative zero is projected to zero only after raw-token
validation; object keys and string values retain their decoded text.
`resolveAndRead`, Listing discovery and `verifySettlementEvidence`
refuse unproven parsed objects before hashing or verifying. Owned discovery
snapshots retain provenance; `cloneWithArtifactAdmission` and
`inheritArtifactAdmission` preserve it through equivalent owned JSON snapshots,
including admitted members of authenticated HTTP envelopes and payment requests.
Neither helper grants provenance to unproven parsed data. Arbitrary clones,
restored cache objects and objects changed since admission do not retain it.

`verifyFinalizedSessionSettlement` requires admission on its nested `evidence`
before schema, hash or provider checks, in both initial and recovery modes.
Seller publication and durable buyer snapshots preserve existing admission.
After a restart, retain the original received bytes or re-read exact evidence
through an admitted transport; serializing a parsed cache entry cannot restore
that proof.

Do not use `JSON.stringify` of an already parsed external object as evidence of
original CF-5 admission. Locally constructed structural inspection remains
explicitly separate through `validateSettlementEvidenceStructure`.
`verifyConstructedSettlementEvidence` is an explicit authoring path for evidence
created by the local signer; it enforces current JID-1 and the complete
cryptographic context, and must not be used for external transport values. Historical
signature inspection uses `verifyLegacySettlementEvidence` and does not establish
current-profile conformance. Other object-based APIs do not acquire provenance
by importing a helper; their ingestion boundary remains the caller's duty.
The SDK-wide Standard pin remains unchanged.

Tests vendor the byte-exact upstream `raw-json-profile-v0.1.json` corpus from
that revision. All 59 outcomes and accepted canonical bytes are checked, along
with API misuse, resource bounds, prototype-named members, view offsets and
hostile-depth cases.

## Current profile admission

The exact `DACS_STANDARD_PIN` currently identifies an unreleased corrective
candidate. Its `PROFILE.md` records no admissible coordinated release. Therefore
`verifySettlementEvidence`, `verifyConstructedSettlementEvidence`,
`verifyFinalizedSessionSettlement` (including recovery), and
`publishSellerSessionSettlement` refuse current settlement authority. Valid
signatures, raw-byte admission, a canonical job ID, and caller-provided profile
objects cannot supply the missing release authority. Publication refuses before
permit inspection, signing, or anchoring.

Historical inspection must explicitly select `verifyLegacySettlementEvidence`
or `verifyLegacyFinalizedSessionSettlement`. Historical publication, when
explicitly intended, uses `publishLegacySellerSessionSettlement`. These retain
the existing signature, anchor, native-proof and recovery checks; their results
do not establish current-profile admission. Re-enabling current authority will
require a new immutable Standard pin that records an admissible coordinated
release and verifier-owned admission bound to the exact session, authenticated
participant identities and complete module tuple.

Current payment verification additionally requires the authenticated pinned
`assetSpec` and `networkSpec` decision fields; omitting either cannot grant
authority.

Authenticated HTLC inspection requires `htlcExpiry` with `source` and `dest`
as non-negative safe integer Unix seconds and `unit: "unix-seconds"`. Pinned
`sourceFinalitySec` and `safetyWindowSec` use integer seconds. Equality at the
required margin fails; missing, partial or ambiguous-unit observations fail.
