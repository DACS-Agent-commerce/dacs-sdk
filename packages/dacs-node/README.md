# `@kynesyslabs/dacs-node`

Production Node.js host contracts and adapters for `@kynesyslabs/dacs`.

The package keeps filesystem, SQLite, HTTP, process-supervision, and deployment
concerns outside the transport-neutral SDK. It publishes the stable host
interfaces, byte-exact authenticated HTTP envelope, and the local SQLite
durability foundation. Payment-handshake adapters, the HTTP server, role
services, and live deployment remain separate stacked implementation units.

```ts
import {
  createDacsHttpEnvelopeV1,
  validateDacsAgentConfig,
} from "@kynesyslabs/dacs-node";
import { openDacsNodeSqliteDatabase } from "@kynesyslabs/dacs-node/sqlite";
```

SQLite is an explicit subpath so importing the offline/root host surface never
loads a native database driver. This keeps the deterministic offline quickstart
usable in installs where optional dependencies or lifecycle scripts are
disabled. Live hosts must install the package's optional SQLite dependency;
the live doctor will fail closed when that adapter is unavailable.

The SQLite database is permanently bound to one mode/profile, actor role,
authority, SDK version, and Standard revision. The SDK and Standard revisions
are derived from the installed SDK and selected commerce profile; callers
cannot attach arbitrary compatibility labels. It enables WAL with `FULL`
synchronous durability, uses database-authoritative lease time, and rejects
known NFS/SMB/shared or consumer-sync locations. It is a local, single-host
store and must not be placed on a shared volume.

Filesystem-type inspection is implemented for Linux and macOS and additionally
rejects Windows UNC paths and known network-filesystem magic values. This is a
denylist safety check, not proof that an unfamiliar mount is local: operators on
Windows or another platform must place the database on an explicitly verified
local disk. `checkpoint()` requires a complete `FULL` WAL checkpoint and reports
`database-checkpoint-busy` when a retained reader prevents completion.

The same explicit SQLite surface provides live-x402 and offline coordinator
stores. Each store is fixed to the database actor role and commerce profile,
persists the exact SDK-validated order record with an integrity hash plus a
validated query projection, and uses transactional generation-fenced track
leases. Startup authenticates the application ID, exact schema and migration
history, actor binding, and logical records before it creates a local backup or
runs a forward migration; newer, foreign, corrupt, and cross-profile databases
fail closed without being modified.

Irreversible effects are reserved under a stable idempotency key before work
starts. A process loss during a perform lease never makes the effect directly
performable again: the next worker receives a reconciliation claim. An
indeterminate reconciliation remains reconciliation-only; only an authoritative
absence proof permits another perform attempt with the original effect and
idempotency identities.

Each effect's kind, effect ID, optional job ID, binding hash, input hash, and
idempotency key are bound into both its row identity hash and its authenticated
origin event. Every canonical history detail is retained behind a rolling entry
hash, and the complete chain is checked on startup and again before load, claim,
or recovery. A legacy or altered row without that proof fails closed; the host
never synthesizes an idempotency proof during admission.

The durable effect input and retained result are canonical operational records,
not a secret vault. Adapters must store only the public binding and the
sanitized authoritative receipt required for reconciliation; raw wallet keys,
reusable payment authorization, credentials, and private provider URLs are
forbidden.

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
