# `@kynesyslabs/dacs-node`

Production Node.js host contracts and adapters for `@kynesyslabs/dacs`.

The package keeps filesystem, SQLite, HTTP, process-supervision, and deployment
concerns outside the transport-neutral SDK. It publishes the stable host
interfaces, byte-exact authenticated HTTP envelope, and the local SQLite
durability foundation. The SQLite surface includes the actor-bound coordinator
and payment-evidence handshake stores plus durable authenticated HTTP inbox and
outbox records. It also provides the bounded HTTP listener and durable client
that operate those stores, authority-separated live role services, and strict
role-local secret loading. Generated deployment remains a separate stacked
implementation unit.

```ts
import {
  createDacsHttpEnvelopeV1,
  validateDacsAgentConfig,
} from "@kynesyslabs/dacs-node";
import {
  createSqliteRatingPublicationEffectStore,
  openDacsNodeSqliteDatabase,
} from "@kynesyslabs/dacs-node/sqlite";
```

SQLite is an explicit subpath so importing the offline/root host surface never
loads a native database driver. This keeps the deterministic offline quickstart
usable in installs where optional dependencies or lifecycle scripts are
disabled. Live hosts must install the package's optional SQLite dependency;
the live doctor will fail closed when that adapter is unavailable.

`@kynesyslabs/dacs-node/demos-loader` is the live host's bounded Node import
hook for `@kynesyslabs/demosdk@4.0.16`. It resolves only that release's one
published extensionless `demoswork/operations/` directory import. Generated
compiled services use this hook instead of shipping a general TypeScript/esbuild
transformer in production; all unrelated resolution failures remain unchanged.

The SQLite database is permanently bound to one mode/profile, actor role,
authority, SDK version, and Standard revision. The SDK and Standard revisions
are derived from the installed SDK and selected commerce profile; callers
cannot attach arbitrary compatibility labels. It enables WAL with `FULL`
synchronous durability, uses database-authoritative lease time, and rejects
known NFS/SMB/shared or consumer-sync locations. Before opening an existing
database, it also rejects a different POSIX owner or group/world-writable mode
on either the file or its nearest existing parent directory. It never silently
repairs unsafe pre-existing permissions. It is a local, single-host store and
must not be placed on a shared volume.

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
leases. Startup validates the application ID, exact schema and migration
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

`createDacsBuyerPaymentEvidenceRuntimeV1()` and
`createDacsSellerPaymentEvidenceRuntimeV1()` bind that store to an existing
fixed-price x402 order and the authenticated role transport. The seller
durably queues the exact SDK request, the buyer runs only the request owned by
its current coordinator fence, and both handshake outboxes advance only after
an authenticated `accepted` or `existing` acknowledgement. The buyer operation
becomes final only after its Demos anchor is verified and the completion is
acknowledged. Evidence verification, native publication and receipt
verification remain explicit SDK adapter callbacks; the host does not replace
those security boundaries.

For the standard buyer-owned Demos lane,
`createDacsBuyerDemosPaymentEvidenceRuntimeV1()` supplies the publication and
reconciliation callbacks from the role-owned Demos adapter. It requires a
separate cryptographic `SettlementEvidence` verifier, re-enters only the exact
write-once journal operation after ambiguity, verifies the finalized receipt,
and requires content-identical native-address readback before acknowledging the
seller.

`createDacsSellerSettlementPublicationTrackV1()` composes the seller side with
the SDK's normative `publishSellerSessionSettlement()` state machine. It reads
the consumed permit from the runtime-owned seller receipt store, reasserts the
outer coordinator fence before signing, and supplies the buyer-owned handshake
as the publication adapter. The seller therefore remains the evidence author
while the buyer owns the PC-7 Demos write. The track becomes final only after
the exact evidence, buyer-written receipt and independently resolved readback
have all passed the SDK publisher's checks.

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
the outbox. Action-bearing runtime transports also supply a stable semantic
idempotency key to the role service. The service durably retains the envelope
inputs before signing, so a coordinator retry or process restart reconstructs
and resumes the exact same envelope; reusing the key with a changed payload,
job, type or lifetime fails locally.

Both transport stores reject retention shorter than seven days, support a
terminal-session retention extension, use stable bounded cursors, and keep a
complete hash-chained canonical transition history. Their durable monotonic
clock prevents a backwards host clock from reviving a lease.

Before agreement, the live graph uses a four-message `session-init` →
`session-challenge` → `session-presentation` → `session-admission` exchange.
It binds fresh verifier-issued challenges to each role's signed session
identity, links every step by its canonical payload hash, reserves challenges
durably against reuse, and carries the seller-produced buyer Vet back to the
buyer with its finality receipt. This is an operational transport transcript,
not a DACS artifact or an authorization to pay. The agreement track
authenticates the receipt and exact native-address readback before using the
Vet reference; it does not wait for logical-name index visibility.

The buyer-produced Vet of the seller is created concurrently with that
exchange and is attached to the authenticated agreement proposal with its
exact reference and finality receipt. The seller transport retains those bytes,
and the one-factory assembly authenticates their receipt plus native-address
readback against the seller identity and the host's explicit complementary
requirement before exposing them to the seller agreement policy. This keeps the
two role-owned Vet writes parallel without letting an unverified proposal
define the seller's local Agreement context.

Pre-agreement Vet failure uses a separate symmetric terminal path. Configure
`terminalBundle.authenticateProduction` on both live-role factories with the
application's recursive DACS-2 verifier. A non-empty requirement also requires
the matching `vet.produce` and `vet.authenticate` host policy; the agreement
track will not mix a custom producer with the empty-requirement authenticator.
A terminal proposal carries the exact
finalized `VetProduction` as well as the derived co-signed plan; each role
independently authenticates the production, reconstructs the authority and
requires byte-equivalent canonical output before retaining or signing it.
`pass` creates no terminal authority, while `indeterminate`, verifier outage,
or a non-terminal Vet decision remains retryable and produces no blame.

When configured, the returned graph exposes `terminalBundles`.
`registerLocalTerminal(input)` durably binds locally observed failure material,
and `advanceRegisteredTerminal(jobId)` drives the SDK's generation-fenced
two-role finalizer, authenticated HTTP proposal/contribution exchange, own-role
Demos bundle publication and BB-1 binding. It is safe to call again after a
restart: acknowledgement loss, signature checkpoints, ambiguous anchor writes
and exact finalized-head recovery all retain the same job/role authority. The
runtime supports both fixed-price x402 and native DEM orders and rejects a
terminal pipeline for the other rail. The host deliberately does not replace
the recursive Vet authenticator with a sender assertion.

The fixed-price live factories also connect that runtime to the agreement
worker. The first local objective `fail` stores a durable Vet invocation,
projects the exact signed Listing pipeline and authenticated registry versions,
registers the terminal material, and stops before Agreement. The Listing must
select exactly one `vet-credentials` phase; the host never inserts an unsigned
phase after publication. Both role workers resume the
same terminal job on later coordinator attempts, including after process
restart; once their own bundle and BB-1 binding are finalized, the agreement
track records the attributed DACS-5 failure using that exact publication.
Remote `fail` bytes on the ordinary admission path never authorize local blame:
the receiver waits for the independently authenticated terminal proposal.

`createDacsBuyerSessionBootstrapAgreementTrackV1()` and its seller counterpart
drive this transcript before delegating to the existing durable agreement
tracks. The generated profile's built-in Vet producer is deliberately limited
to an empty `BundleRequirement`; non-empty claim requirements fail closed until
a requirement-specific provider is supplied. Complementary seller requirement
provenance remains a non-normative policy seam pending Standard issue #331.

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

`createDacsBuyerServiceV1()` and `createDacsSellerServiceV1()` compose the
public fixed-price x402 coordinator with one actor-bound SQLite database, one
configured peer authority, the authenticated HTTP transport, and a bounded
restart worker. They reject cross-role databases and same-authority peers,
resume pending inbox and coordinator work at startup, and never overlap worker
cycles. The host supplies the verified Demos identity resolver, typed SDK
payload validator, actor signer, coordinator operations, durable inbound
handler, and a freshness-bounded readiness provider.

Each service exposes the message endpoint plus `GET /health`, `GET /ready`, and
`GET /status`. Liveness is process-local. Readiness fails closed until the host
provider has latched all live dependencies. Status contains only role, installed
SDK/Standard versions, queue state, a bounded runnable-session count, and worker
state; it does not expose actor authorities, balances, nonces, secrets, raw
authorization, or private provider URLs. Coordinator operation callbacks still
own public-SDK validation and adapter reconciliation. The service does not turn
an unsafe irreversible-effect adapter into an exactly-once adapter.

`createDacsLiveRoleRuntimeV1()` is the higher-level actor boundary used by the
generated live services. It opens one role-bound SQLite database, Demos wallet
and write journal, v2 fenced-session store, x402 settlement store, seller
receipt store where applicable, and EVM runtime. The buyer EVM signer remains
private to the buyer process and is destroyed on shutdown; the seller runtime
retains only its derived public EVM identity. Production operation and payload
callbacks receive these already-admitted actor-local resources, so generated
projects do not reopen stores or copy host implementation code.
The admitted Demos runtime also exposes a role-bound component signer. It signs
only `ed25519` contexts naming the runtime's exact canonical authority, so
agreement, evidence, delivery and bundle builders can share the wallet without
receiving its secret or substituting another signer identity.

`createDacsFixedPriceX402OperationSetV1()` admits only the complete set of
role-owned coordinator tracks. Core coordinators continue to support partial
maps for focused recovery and tests, while the host production boundary rejects
missing or cross-role tracks. `putDacsLiveOrderInputV1()` retains the immutable
canonical public application/session facts before the first track can run;
`loadDacsLiveOrderInputForTrackV1()` then binds recovery to the coordinator's
exact role, job and local binding hash. Payment bearers and private material do
not belong in that order-input record.

`createDacsLiveRoleMessageRouterV1()` applies the same closed-set rule to
authenticated commerce messages. Buyer and seller routers must supply all
three role-owned agreement, payment-evidence and bundle-signature routes and
cannot accept the peer direction. A validator outage fails authentication
closed; a handler exception remains indeterminate so the durable inbox can
resume it rather than acknowledging work that may not have been retained.

The buyer audit track does not finish merely because both local workers have
published something. The durable buyer finalizer returns the exact data-only
seller closure it already authenticated (never a seller signer), and the host
then runs `verifyCompletedTwoSidedSession()` against fresh buyer and seller
Demos readbacks, finalized receipts, BB-1 bindings, and the complete seller
ST-11 dependency graph. Its audit reference is the authenticated native bundle
address. Native DEM and x402 use the same two-copy finish boundary.

`createDacsBuyerAgreementTrackV1()` and
`createDacsSellerAgreementTrackV1()` bind the SDK's durable agreement exchange
and responder to the role-owned fenced-session store and Demos signer. Every
proposal/contribution publication and agreement anchor callback rechecks the
outer coordinator generation immediately before invoking its adapter. A
terminal readback becomes a successful coordinator track only after the host's
independent order authorization callback accepts it; ambiguous progress stays
retry/reconciliation state, while an authenticated rejection needs an explicit
fault-classification decision before it can become a normative failure.

`createDacsX402BuyerRuntimePaymentTrackV1()` composes those retained order facts
with the buyer's role-local signer, chain-finality read client, durable x402
settlement store and paid-request transport. Challenge acquisition is a
read-only preparation step: a transient challenge failure creates no effect
intent and is retryable. Once a bearer is retained and a paid request may have
been sent, the existing payment effect fence and chain-authenticated
reconciliation path remain authoritative; an unknown result never causes a new
authorization or a blind paid-request replay.

`loadDacsSecretV1()` applies file, injected OS-secret-manager, then explicit
environment-variable precedence. Live files must be absolute, regular,
non-symlink, owned by the process user, and mode `0600`; opening uses
`O_NOFOLLOW` plus an inode/device recheck. Environment fallback is returned with
the `secret-environment-source` warning and is intended only for controlled CI.
Loaded secrets serialize only as redacted metadata, return detached byte copies,
support bounded text redaction, and can zero their retained byte buffer with
`destroy()`. JavaScript strings and copies previously returned to the caller
cannot be reliably zeroed, so callers must keep their lifetime short and never
log them.

`installDacsRoleServiceProcessHooksV1()` provides idempotent SIGINT/SIGTERM
shutdown wiring for generated entrypoints. It removes both listeners when the
first shutdown starts, awaits the service's durable stop path exactly once, and
returns only a bounded stopped/failed result. It deliberately does not call
`process.exit()` or make restart-policy decisions; Docker/systemd remains the
process supervisor.

`runDacsLiveDoctorV1()` is the live release gate used by generated deployments.
It reports the complete local, Demos, x402 and post-start service catalog as
`pass`, `fail` or `blocked`, and marks which checks gate `start`, `setup` or
`buy`. Pre-start never requires service-only probes; post-start reruns every
pre-start probe and additionally requires health, readiness, authenticated
no-effect transport, public reachability when configured, and cross-process
version agreement. Missing adapters are `blocked`, never silently successful.
Probes receive only check identity, phase, scope and an abort signal—no write or
spend capability. Reports state `readOnly: true`, `funded: false`, use stable
exit codes 0/1/5, and include a canonical integrity hash.

`createDacsNodeLocalDoctorProbesV1()` implements the package/version/config,
private data-directory, disk, SQLite, secret and actor-separation checks.
`inspectExistingDacsNodeSqliteDatabaseV1()` supplies pre-start admission for an
existing actor store through a read-only connection: it never creates or
migrates a file, and returns blocked when initialization or migration is still
required.
`createDacsRoleServiceDoctorProbesV1()` implements bounded GET-only service
checks and accepts an explicit independent public probe. The transport check
uses the reserved `diagnostic-probe-buyer` and `diagnostic-probe-seller`
messages. Role services validate those canonical 32-byte challenges and durably
acknowledge them without invoking the application message handler, coordinator,
publication, payment or fulfilment callback.

`createDacsGuardedSetupPlanV1()`, `createDacsGuardedPurchasePlanV1()` and
`createDacsFundedDoctorPlanV1()` produce immutable domain-hashed plans. Setup
caps the sum of every Demos write plus its safety margin. Purchase binds the
exact job, Listing, request hash, actors, payer/payee, x402 rail/network,
service ceiling and Base fee ceiling, and rejects mainnet in this initial
profile. Funded doctor has its own consent domain and per-asset total-debit caps,
including DEM fees; it authorizes neither setup nor purchase.

`runDacsGuardedCommandV1()` remains plan-only unless execution is explicit. An
executing setup requires fresh passing post-start/start and pre-start/setup
doctor reports; purchase requires a fresh passing post-start/buy report; funded
doctor requires post-start/start. Each also requires its command-specific
environment confirmation plus interactive confirmation, unless explicit
non-interactive mode is paired with the confirmation and complete ceilings.
The plan is retained in the actor SQLite effect journal before execution.
Ambiguous or thrown effects become reconciliation-only, a verified performed
result completes monotonically, and only an authoritative absence proof returns
the same effect identity to performable state. The executor must call the
generation fence immediately before any irreversible adapter call.
Purchase requires the fresh buy doctor even for its plan-only projection, so an
unresolved Listing, stale readiness latch or insufficient balance cannot be
presented as a purchasable plan. Setup and funded-doctor plans remain safely
inspectable before their execution-only prerequisites.

The report hash detects accidental or partial mutation; it is not a signature
or MAC. Generated commands must rerun doctor in the same invocation, as this
package supports, or store a cached report behind a separately authenticated
freshness latch. They must never trust a user-supplied report solely because its
unkeyed hash recomputes.

The transport callbacks are intentionally host-owned. The identity resolver
must dereference and verify Demos identity material; the payload validator must
use public SDK validators plus independently retained session facts. Returning
`valid` solely because an envelope is signed is not sufficient authorization.

The public v2, v3, and v4 schemas are immutable migration inputs. A v2 database
contains only the coordinator order table and its runnable index; the
integrity-checked track projection is created and backfilled by v3. Schema v4
integrity-binds the role-local SDK job pointers with `localBindingHash` in both
the canonical order and every projection row. It also keeps live DACS-5
terminal attribution (`faultedParty` or `withdrawnBy`) distinct from the
offline-only `simulated-*` outcome and error vocabulary.
Schema v5 adds payment-evidence handshake records, integrity-checked runnable
projections, and their scope-local replay reservations. Migration from v4 is
preceded by a validated, self-contained backup just like every older supported
schema transition. Schema v6 adds the HTTP inbox, outbox, monotonic clock and
their integrity-checked transition histories; migration from v5 likewise
requires a validated pre-write backup.

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

`createSqliteRatingPublicationEffectStore(database)` narrows that generic
generation-fenced effect API to the SDK's DACS-5 RatingRecord publisher. It
stores the complete public signed record as canonical effect input, rejects a
different replacement under the same `(jobId, rater)` logical address, and
retains the independently verified publication result for restart replay. The
wrapper does not authenticate signatures, identity-to-wallet authority, anchor
finality, or content readback; those remain mandatory publisher dependencies.

Each effect's kind, effect ID, optional job ID, binding hash, input hash, and
idempotency key are bound into both its row identity hash and its integrity-bound
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
