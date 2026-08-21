# `@kynesyslabs/dacs-node`

Production Node.js host contracts and adapters for `@kynesyslabs/dacs`.

The package keeps filesystem, SQLite, HTTP, process-supervision, and deployment
concerns outside the transport-neutral SDK. It publishes the stable host
interfaces, byte-exact authenticated HTTP envelope, and the local SQLite
durability foundation. The SQLite surface includes the actor-bound coordinator
and payment-evidence handshake stores plus durable authenticated HTTP inbox and
outbox records. It also provides the bounded HTTP listener and durable client
that operate those stores. Role services and live deployment remain separate
stacked implementation units.

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
rejects both Windows UNC spellings (`\\server\share` and `//server/share`) on
every platform, plus known network-filesystem magic values. This is a denylist
safety check, not proof that an unfamiliar mount is local: operators on Windows
or another platform must place the database on an explicitly verified local
disk. `checkpoint()` requires a complete `FULL` WAL checkpoint and reports
`database-checkpoint-busy` when a retained reader prevents completion.

The same explicit SQLite surface provides live-x402 and offline coordinator
stores. Each store is fixed to the database actor role and commerce profile,
persists the exact SDK-validated order record with an integrity hash plus a
validated query projection, and uses transactional generation-fenced track
leases. Startup authenticates the application ID, exact schema and migration
history, actor binding, and logical records before it creates a local backup or
runs a forward migration; newer, foreign, corrupt, and cross-profile databases
fail closed without being modified.

Live buyer and seller databases expose
`createPaymentEvidenceHandshakeStore()`. It atomically reserves each request's
message, effect, and logical-address identities within the exact actor-pair and
rail scope; retains canonical request/completion hashes; and persists buyer
work plus both role-owned outboxes behind generation-fenced leases. Runnable
and outbox scans use stable message-ID cursors and reject pages above
`DACS_NODE_SQLITE_MAX_PAGE_SIZE`. Offline and verifier databases cannot create
this store, and every admitted request must name the database's canonical actor
authority in its role. This is the durable store only: it does not provide an
HTTP transport, wallet, secret loader, or role service.

Live buyer and seller databases also expose `createHttpInboxStore()` and
`createHttpOutboxStore()`. The inbox atomically retains the complete canonical
signed envelope, authentication and identity-evidence hashes before an action
is invoked. An exact replay is distinguished from a still-pending crash window;
only a durably recorded disposition may be projected into an acknowledgement.
The outbox retains the exact signed envelope across retries, claims work with a
generation-fenced lease, applies one-second exponential backoff capped at sixty
seconds, and never manufactures a replacement after envelope expiry. A valid
authenticated and exactly bound late acknowledgement is monotonic and may
complete an item after its send lease expires. HTTP status alone never clears
the outbox.

Both transport stores reject retention shorter than seven days, support a
terminal-session retention extension, use stable bounded cursors, and keep a
complete hash-chained canonical transition history. Their durable monotonic
clock prevents a backwards host clock from reviving a lease.

`startDacsHttpMessageServerV1()` serves only
`POST /dacs-transport/v1/messages`. It bounds decoded JSON bodies to 256 KiB,
rate-limits a bounded set of peers, authenticates the envelope and independently
validates its typed payload before inbox admission, and emits only a signed
acknowledgement after the handler disposition is durable. A thrown or malformed
handler result leaves the reservation pending; call `resumeDacsHttpInboxV1()`
during startup to resume those items with the same idempotent handler before
accepting traffic. Plain HTTP is restricted to loopback bindings. Non-loopback
listeners require TLS key and certificate material.

`createDacsHttpMessageClientV1()` retains the exact self-signed envelope before
the first request. Network failures, timeouts and 2xx responses without an
authenticated, exactly bound acknowledgement schedule the retained envelope
for replay rather than clearing it. `runRunnable()` processes due work after a
restart using the outbox's generation-fenced leases and bounded exponential
backoff. A signed `rejected` acknowledgement is a terminal transport result;
the owning SDK operation must inspect its disposition and decide the protocol
outcome.

```ts
import {
  createDacsHttpMessageClientV1,
  resumeDacsHttpInboxV1,
  startDacsHttpMessageServerV1,
} from "@kynesyslabs/dacs-node/transport";
import { openDacsNodeSqliteDatabase } from "@kynesyslabs/dacs-node/sqlite";

const database = await openDacsNodeSqliteDatabase(actorBoundDatabaseOptions);
const endpointOptions = {
  authority: configuredActorClaimRef,
  inbox: database.createHttpInboxStore(),
  resolveIdentity: verifiedDemosIdentityResolver,
  validatePayload: publicSdkPayloadValidator,
  handleMessage: idempotentDurableRoleHandler,
  signAcknowledgement: actorIdentitySigner,
};

await resumeDacsHttpInboxV1(endpointOptions);
const server = await startDacsHttpMessageServerV1(endpointOptions);

const client = createDacsHttpMessageClientV1({
  endpoint: configuredPeerEndpoint,
  authority: configuredActorClaimRef,
  outbox: database.createHttpOutboxStore(),
  resolveIdentity: verifiedDemosIdentityResolver,
  workerId: processWorkerId,
});
```

The transport callbacks are intentionally host-owned. The identity resolver
must dereference and verify Demos identity material; the payload validator must
use public SDK validators plus independently retained session facts. Returning
`valid` solely because an envelope is signed is not sufficient authorization.

The public v2, v3, and v4 schemas are immutable migration inputs. A v2 database
contains only the coordinator order table and its runnable index; the
authenticated track projection is created and backfilled by v3. Schema v4
authenticates the role-local SDK job pointers with `localBindingHash` in both
the canonical order and every projection row. It also keeps live DACS-5
terminal attribution (`faultedParty` or `withdrawnBy`) distinct from the
offline-only `simulated-*` outcome and error vocabulary.
Schema v5 adds payment-evidence handshake records, authenticated runnable
projections, and their scope-local replay reservations. Migration from v4 is
preceded by a validated, self-contained backup just like every older supported
schema transition. Schema v6 adds the HTTP inbox, outbox, monotonic clock and
their authenticated transition histories; migration from v5 likewise requires
a validated pre-write backup.

A legacy database is migrated only when its persisted SDK and Standard
revision exactly equal the supported runtime bindings. Compatible v3 offline
terminal records are translated to the explicit simulation vocabulary. Live
v3 success and non-terminal records can be upgraded, but live v3 failure or
abort records are refused because they cannot prove the now-mandatory DACS-5
party attribution; the migration never invents it. This refusal happens during
read-only admission, before a backup or schema write. Arbitrary historical
compatibility labels are likewise refused as
`database-legacy-metadata-unsupported` before a backup or schema write; the
runtime does not claim that unsupported data was safely upgraded.

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

These hashes detect partial/inconsistent corruption and enforce immutability at
the store API boundary. They are not a MAC or an external transparency proof:
an attacker with arbitrary write access to the database and runtime can rewrite
an entire internally consistent history. Hosts must protect the database and
its parent directory as actor-authority state; adversarial local storage needs a
separately reviewed keyed or externally anchored adapter.

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
