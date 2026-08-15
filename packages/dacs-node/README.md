# `@kynesyslabs/dacs-node`

Production Node.js host contracts and adapters for `@kynesyslabs/dacs`.

The package keeps filesystem, SQLite, HTTP, process-supervision, and deployment
concerns outside the transport-neutral SDK. The first package unit publishes
the stable host interfaces and the byte-exact authenticated HTTP envelope. It
does not yet claim the SQLite or HTTP server implementations described by the
one-click install specification.

```ts
import {
  createDacsHttpEnvelopeV1,
  validateDacsAgentConfig,
} from "@kynesyslabs/dacs-node";
```

The live profile is never inferred. `offline` and `live-demos` configurations
are closed, non-interchangeable variants and must select their matching SDK
commerce profile.

The package also exposes `runOfflineVerifierSimulation`. It constructs a local
fixture graph and exercises the SDK's signing, dereferencing and recursive
verification paths. It is not a conformant DACS transaction and never claims
commercial success. Its substrate finality and provider receipt authorities
are mocked; in particular, its self-signed provider fixture is not the SR-3
attestation required by DACS-4 AP2-2. Every persisted fixture is wrapped in a
machine-readable `normativeConformance: false` simulation envelope, so it is
not a portable SR-2 `AttestationRef` target. The function performs no network
request, reads no credentials and moves no value.

Each run uses a fresh CSPRNG-backed ULID and fresh 128-bit presentation nonces.
That prevents fixture reuse, but the simulation does not implement the durable
challenge issuance/consumption ledger required by CORE §B.8 SN-1..SN-4. Its
local rail dependency is likewise not the signed, anchored authority required
by DACS-4 §9.4.4 RAV-R5. Both limitations are explicit in the run report.

Callers must provide a fresh, non-existent output directory. The runner writes
into a private CSPRNG-named sibling staging directory and atomically publishes
the completed tree; existing files, directories, and symbolic links are
rejected, and concurrent writers cannot expose a partial report.

`@kynesyslabs/dacs` is a required runtime peer at the same exact version as
`@kynesyslabs/dacs-node`. Applications must install both packages; the host kit
imports the core SDK at runtime and cannot operate without it.

Envelope authentication requires two host-owned, fail-closed callbacks. The
identity resolver must use verified Demos identity material and retain its
evidence hash; the payload validator must invoke the corresponding public SDK
validator/verifier with independently resolved session facts. Neither callback
may trust the HTTP body as identity or authorization evidence.
