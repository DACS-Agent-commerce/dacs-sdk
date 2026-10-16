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

Negative zero (for example `-0.0`) is an admitted CORE §B.2 number that
serialises as `0`. APIs that take ownership of received or stored data treat an
admitted `-0` exactly like `0`, and their owned snapshots hold `0`. These
include `contentHash`, `stripSignature`, `canonicalSignedScope`, `signArtifact`
and `verifyArtifact`, the component-signature and Listing verifiers, and the
ordered DACS-1 §6.3.4 reader `validateListingArtifact` with its revocation,
payload-capability and reachability helpers. Such an API also normalises an
in-memory `-0` it is handed directly. Locally authored component artifacts
should use `0`: `signComponentArtifact`, `buildComponentSignature` and the
SDK's other authoring boundaries refuse an in-memory `-0` as a non-wire alias.
Wire-format reads that must keep a transport's exact JSON also refuse it,
because their owned copy is not re-parsed from canonical bytes.

This is an **explicit API**, not a current-profile switch. Existing object-based
SDK consumers, adapters, caches and restored session records do not acquire
raw-byte provenance by importing this helper. Do not use `JSON.stringify` of
an already parsed object as evidence of original CF-5 admission. Integration
must retain exact bytes or enforce authenticated byte-admission provenance at
each actual ingress. The SDK-wide Standard pin remains unchanged.

Tests vendor the byte-exact upstream `raw-json-profile-v0.1.json` corpus from
that revision. All 59 outcomes and accepted canonical bytes are checked, along
with API misuse, resource bounds, prototype-named members, view offsets and
hostile-depth cases.
