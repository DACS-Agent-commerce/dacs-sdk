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
authority, SDK version, and Standard revision. It enables WAL with `FULL`
synchronous durability, uses database-authoritative lease time, and rejects
known NFS/SMB/shared or consumer-sync locations. It is a local, single-host
store and must not be placed on a shared volume.

The same explicit SQLite surface provides live-x402 and offline coordinator
stores. Each store is fixed to the database actor role and commerce profile,
persists the exact SDK-validated order record with an integrity hash, and uses
transactional generation-fenced track leases. Startup makes a local backup
before a forward schema migration; newer schemas and cross-profile reuse fail
closed.

Irreversible effects are reserved under a stable idempotency key before work
starts. A process loss during a perform lease never makes the effect directly
performable again: the next worker receives a reconciliation claim. An
indeterminate reconciliation remains reconciliation-only; only an authoritative
absence proof permits another perform attempt with the original effect and
idempotency identities.

The durable effect input and retained result are canonical operational records,
not a secret vault. Adapters must store only the public binding and the
sanitized authoritative receipt required for reconciliation; raw wallet keys,
reusable payment authorization, credentials, and private provider URLs are
forbidden.

The live profile is never inferred. `offline` and `live-demos` configurations
are closed, non-interchangeable variants and must select their matching SDK
commerce profile.

The package also exposes `runDeterministicOfflineLifecycle`. It writes and then
independently verifies a complete DACS 1-5 local artifact graph. Its Standard
`pay-ap2` rail and provider receipt are explicitly marked `mocked`/`offline`;
the function performs no network request, reads no credentials, spends no
funds, and makes no live-x402 or live-substrate claim.

Until the first SDK alpha is published, the exact SDK version is declared as an
optional peer so stacked pre-merge CI does not fetch an unpublished package.
Applications must install both `@kynesyslabs/dacs` and
`@kynesyslabs/dacs-node` at the same exact version.

Envelope authentication requires two host-owned, fail-closed callbacks. The
identity resolver must use verified Demos identity material and retain its
evidence hash; the payload validator must invoke the corresponding public SDK
validator/verifier with independently resolved session facts. Neither callback
may trust the HTTP body as identity or authorization evidence.
