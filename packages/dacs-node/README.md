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
implementation unit. Built-in live completion supports empty Vet requirements
only. Non-empty passing requirements require a provenance-backed completion
audit implementation beyond the built-in live profile.

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

The native DEM commerce profile uses Standard commit
`d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`, the same pin and full module
tuple required by its completed-session admission. At that pin PROFILE.md lists
the tuple as the unreleased JID-1 corrective candidate, which is not an
admissible live profile until the Standard records a coordinated release. Until
then every session profile admission is refused, whatever the deployment
authority returns (`DACS_STANDARD_PROFILE_STATUS` is `"unreleased-candidate"`).
The four live factories refuse to build without an admission authority, and
every live action they build is admitted first. BundleBinding resolution, Demos
publication and `verifyFixedPricePayDemAuditCompletion` require admission too.
The admitted factories and generated commerce graphs therefore take no live
effect at this pin. The lower-level exported `createDacs{Buyer,Seller}LiveCommerceAssemblyV1`
and `createDacs{Buyer,Seller}PayDemLiveCommerceAssemblyV1` do not perform profile
admission themselves; direct callers must admit the session before invoking
their agreement or payment operations. The exported
`verifyCompletedTwoSidedSession` and `verifyFixedPriceX402AuditCompletion` gates
require `authenticateSessionProfile` and refuse completion without independently
authenticated admission. The unreleased profile at this pin therefore prevents
these gates from returning `audit-complete` as well.

The BundleBinding well-known index uses `sha256-` followed by SHA-256 of the
RFC 8785 canonical JSON index document for `indexHash`. The pinned Standard
does not define that computation; deployments must agree on this SDK convention
until the Standard specifies an interoperable index digest.
The index may be hosted on another HTTPS origin. Discovery uses the bounded,
DNS-pinned public JSON reader by default, with a 5-second deadline per read and
a limit of 4,096 binding records per index. Custom `readJson` implementations
must bound response bytes before decoding. A timeout or oversized index leaves
the surface unanswered; it never proves absence.

`createDacsSessionProfileGatedCommerceGraphV1` builds a live graph only when
`dacsLiveSessionProfileAvailabilityV1` reports admission is possible. Otherwise
the role service starts with `commerce: blocked` and names the reason:
`session-profile-unreleased`, `session-profile-admission-unconfigured`, or
`session-profile-admission-unavailable` when the operator file cannot be read,
or `session-profile-admission-invalid` when its content is malformed.
Generated projects use it with `createDacsFileSessionProfileAdmissionV1`, which
re-reads the operator's statement in `DACS_SESSION_PROFILE_ADMISSION_FILE`
(`releasePin`, `profileStatus`, `moduleVersions`) for configuration diagnostics.
This local statement cannot authenticate the peer's pin or bind evidence to an
exact session, so this source admits no session even after release. A readable
file reports `session-profile-peer-evidence-unconfigured`. Configure a
verifier-owned `authenticateSessionProfile` provider with authenticated evidence
for every participant and exact session before enabling commerce, then restart.
Docker projects mount
`DACS_SESSION_PROFILE_ADMISSION_DIRECTORY` read-only and read its `admission.json`
at `/run/dacs/session-profile/admission.json`. Local projects use the file path
directly. Restoring a missing file updates its diagnostic but does not enable
commerce. The blocked graph returns operator action until a verifier is
configured and the service restarts.
When the release is cut, the
pin and that status move to it together. Orders and
databases bound to the historical
`965df755aba4ff392f1fb37a93d287242b177ba4` revision are refused;
there is no automatic migration or relabelling of signed evidence. Retain the
original database and use its matching SDK release to recover historical work.
Start current-profile work in a new database.

Coordinator tracks now retain `pausedSince` while using SQLite schema version 8.
An older SDK may reject those track records as corrupt; rollback with an existing
database is unsupported. Retain a matching SDK and read-only database snapshot
for recovery instead of opening the current database with an older SDK.

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
is invoked. Exact and payload-equivalent fresh-nonce replay are distinguished
from a still-pending crash window without allocating an unbounded alias row.
Semantic replay returns the original retained record plus the newly received
envelope ID, because any acknowledgement must bind the newly received ID;
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
An expired, unacknowledged outbox message may be renewed with a new signed
validity window, while the receiving inbox still collapses that renewal to the
same semantic action and binds its acknowledgement to the newly received ID.

Both transport stores reject retention shorter than seven days, support a
terminal-session retention extension, use stable bounded cursors, and keep a
complete hash-chained canonical transition history. Their durable monotonic
clock prevents a backwards host clock from reviving a lease.
A database-wide, durably bound policy places finite row and canonical-byte
quotas on global, peer, job, and message-type usage and caps revisions per
message. Equivalent acknowledgements are O(1): a new transport nonce or later
receipt cannot extend retention or append history. The explicit job retention
transition is required for that change. Admission charges explicit row and byte
headroom for the largest valid terminal transition, and active updates preserve
the last revision for an acknowledgement, disposition, or operator-action
transition. Quota pressure therefore cannot wedge active work in an
unpurgeable state.

`diagnostics()` reports durable pressure, rejection, oldest-item,
operator-action, expiry-cursor, and purge progress. `purge()` deletes only a
bounded page of disposed inbox or acknowledged outbox records after their
retention deadline; pending, sending, and operator-action records are never
eligible. Projection, history, usage accounting, and cursor advancement share
one transaction, so a crash either commits the whole page or none of it. These
scans advance over a bounded physical index page even when nothing is expired
or purgeable, avoiding an unbounded sparse-table scan under the write lock.

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
application's recursive DACS-2 verifier. This is the only check that the peer's
Vet production is authentic: the SDK checks only the shape of its result, so
a stub that returns `{ status: "valid" }` lets any well-formed production
through. Never configure a stub or a sender assertion in production. A result
other than `valid`, a thrown error or a malformed result fails closed, with
nothing retained or signed. Live bootstrap supports empty requirements only
and refuses non-empty requirements before any session effect, including with
custom `vet.produce` and `vet.authenticate` host policy. Custom non-pass
productions for supported requirements can use the terminal path. A custom Vet
alone does not add requirement support to the built-in completion audits.
A terminal proposal carries the exact
finalized `VetProduction` as well as the derived co-signed plan; each role
independently authenticates the production, reconstructs the authority and
requires byte-equivalent canonical output before retaining or signing it.
`pass` creates no terminal authority. Unavailable production authentication
remains retryable and produces no blame. Every authenticated non-pass decision ends the Vet phase
at `vet-failed` (DACS-2 VPC-4, VP-R4): `fail` is the evaluated party's
`counterparty` fault. An authenticated `indeterminate` or `error` defaults to
permanent verifier fault under VPC-4. Independently authenticated `cause` evidence
binding the job, record hash and both identity hashes can establish a sole
counterparty-presentation parse cause, which maps to `counterparty`. A supplied
cause bound to another production remains indeterminate and produces no terminal
blame, as does unavailable production authentication.

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

A role selects one terminal plan per job: the first plan written, from its own
Vet failure or from the peer's proposal. Local registration and inbound
proposals share one insert-once selection row, written before the phase claim
and the plan's binding, so two processes racing on one database agree on it,
and a crash after it is completed on the next tick instead of stranding the
phase. A peer's plan selected just before another process commits the job to
the agreement is refused like one that arrives after it, and the agreement
decides the job.

The two roles exchange their exact finalized Vet productions before selecting a
terminal plan. The existing role-specific terminal proposal messages also carry
`{ vetEvidenceVersion: "1", terminalInput }` during this exchange. Each recipient
independently authenticates the CVR, its role/session joins and finalized receipt.
The productions are retained in insert-once rows. Both CVR references, in buyer
then seller evaluation order, enter `vetRecords`; the same ordered references and
receipts determine the dependency hash. A plan missing either record is refused.
A failure waits for the other production, and restart resumes from the retained
bytes. `registerLocalVetPass(order, input)` retains the full passing production;
a legacy marker without it cannot authorize a signature.

No role signs a plan before its own Vet result is durable and agrees with it:
its own failure is that plan, or its own Vet of the peer passed and the plan is
the peer's failure of this role. A peer's plan that arrives earlier is selected
but not accepted: `handleMessage` throws `vet-terminal-local-vet-pending`, so
the inbox keeps the message pending and decides it again on a later cycle, and
`advanceRegisteredTerminal` neither binds nor signs it. The peer signs its own
plan only once this role accepts it, so until then neither role has signed.
The session bootstrap records this role's pass with `registerLocalVetPass`, or
its failure with `registerLocalTerminal`, before it advances the terminal
again. Both claim one insert-once local-Vet result row, a failure before its
plan is selected or bound, so a pass and a failure racing in two processes
record only the first: the other is refused with
`vet-terminal-local-vet-conflict` and its track stops at operator action. A
pass found beside this role's own plan, as earlier versions could leave them,
stops the terminal at operator action instead of signing either. If this
role's own Vet never decides (it never receives what it must Vet, or a host
that drives the runtime itself never records the pass), the peer's plan waits
pending with nothing signed. `registerLocalVetPass` is optional on
`DacsVetTerminalBundleTransportRuntimeV1`, so existing implementations still
conform; the bootstrap skips it when absent.

A plan that differs from the selected one is classified:

- This role's own Vet failure and the peer's first plan, in either arrival
  order: both Vets failed, with different plans. DACS-2 defers mutual-Vet
  composition and DACS-5 §10.4.3(d) leaves which party failed to adjudication,
  so neither plan is signed, by either role. The job stops at operator action
  (`vet-terminal-plan-disagreement`) once this role has sent its own plan to the
  peer, which then stops the same way; until the peer acknowledges it, the track
  is pending (`vet-terminal-plan-disagreement-notice-pending`).
  `loadPlanDisagreementEvidence(jobId)` returns both plan hashes and the losing
  plan, with `operatorAlert: true`.
- A second plan from the peer after one this role retained from it:
  equivocation. The message is refused (`vet-terminal-proposal-equivocation`),
  never sealed and never signed, and the job continues with the retained plan,
  because the role only signs that plan. `loadPeerEquivocationEvidence(jobId)`
  returns the first refused plan from before this role committed (sent,
  accepted or signed its plan) and the first from after it; the latter has
  `operatorAlert: true`, and while the job continues its track reports
  `vet-terminal-peer-equivocation-alert`. The inbox keeps the authenticated
  envelope.
- A second local plan over this role's own retained material is still sealed
  for an operator, as below.

Both evidence loaders are optional members of
`DacsVetTerminalBundleTransportRuntimeV1`, so existing implementations of the
interface still conform.

Native DEM and x402 live factories require a verifier-owned
`context.authenticateSessionProfile(jobId)` callback, also configurable on the
role runtime. It must authenticate the exact session's buyer and seller, the
pinned Standard commit, its PROFILE.md release status and every module version
from deployment authority independent of caller input and artifacts. It returns
`{ status: "valid", releasePin, profileStatus, moduleVersions, roles }`, with
`profileStatus` equal to `DACS_STANDARD_PROFILE_STATUS` and exactly one
`{ jobId, role, participant }` entry for each role. Admission is refused before
the callback is asked while `DACS_STANDARD_PROFILE_STATUS` is not `"released"`
(see above). Every live operation and inbound entry point rechecks this
authority before effects; missing or conflicting admission refuses the action. The public BundleBinding resolver requires the same
independent callback before deriving an address, and the Demos publication adapter
checks it before discovery. Configure this authority for both roles before use.
The x402 seller also rechecks the matched HTTP session before payment handling
or retained-response delivery. Supply the callback again when reopening a paid
session; a previously successful admission is never persisted as authority.
An unanswered admission read keeps inbound validation `unavailable` (HTTP 503),
so the durable sender can retry after the authority provider recovers.

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
A Vet terminal is only admitted before agreement. Once a role's agreement track
has succeeded, or its retained agreement facts record the evaluated party's Vet
as passed, that role rejects the proposal (`vet-terminal-not-pre-agreement`),
never signs it, and its agreement and audit tracks continue normally.

For each role, agreement signing and the Vet terminal are mutually exclusive.
Before signing or handing off to agreement signing, or retaining terminal
material, the role records a durable first-writer phase decision. The other
path fails closed with `agreement-vet-terminal-phase-conflict`. A seller that
retained or co-signed a Vet failure refuses a later proposal and never signs an
agreement response.

Proposal admission is not agreement signing. It separately records the
buyer's authenticated seller-pass evidence before retaining the proposal and
starting the coordinator order. This excludes seller-failure terminals even
if admission crashes before proposal retention. It still permits the seller's
own Vet to fail the buyer: that buyer-failure terminal wins the signing phase,
is co-signed, and the admitted proposal is refused without an agreement signature.

An operator must never clear or overwrite a valid first-writer phase or
seller-Vet outcome decision, including when a repair/requeue hits the same
conflict. Abandon a conflicted or corrupt job out of band and restart under a
new job ID. Preserve a read-only database snapshot, both decision rows and
material/proposal/response bindings, the local binding hashes, authenticated
transport envelopes and acknowledgements, Vet records and anchor receipts,
and track/error logs with the affected job ID and SDK version. Keep this
evidence in private operator storage for diagnosis. A read-only phase
diagnostic is a follow-up; repairTrack does not resolve a phase conflict.

`createDacsBuyerSessionBootstrapAgreementTrackV1()` and its seller counterpart
drive this transcript before delegating to the existing durable agreement
tracks. The generated profile's built-in Vet producer is deliberately limited
to an empty `BundleRequirement`. The bootstrap refuses all non-empty requirements
before transport or Vet effects, including with a custom Vet provider.
Complementary seller requirement
provenance remains a non-normative policy seam pending Standard issue #331.

`startDacsHttpMessageServerV1()` serves only
`POST /dacs-transport/v1/messages`. It bounds decoded JSON bodies to 256 KiB,
rate-limits a bounded set of peers, authenticates the envelope and independently
validates its typed payload before inbox admission, and emits only a signed
acknowledgement after the handler disposition is durable. Temporary Vet production
verification failures and pending terminal prerequisites return HTTP 503; the
sender retains the same signed envelope for automatic retry. A thrown or malformed
handler result leaves the reservation pending; call `resumeDacsHttpInboxV1()`
during startup to resume those items with the same idempotent handler before
accepting traffic. Each call resumes one page; pass its `nextCursor` to the
next call and start again without one when it is absent, so messages that
stay pending never keep later ones from being resumed.
`createDacsHttpInboxResumerV1()` does this across calls, and the live service
uses it every cycle. Plain HTTP is restricted to loopback bindings. Non-loopback
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
address. Native DEM and x402 use the same two-copy finish boundary. A Demos
read that cannot be answered leaves the track `indeterminate`
(`buyer-audit-completion-indeterminate`) and it is retried. The seller's copy
is never looked up by its storage-program name: the buyer discovers the
seller's signed BundleBindings (its Demos binding program plus any configured
`bundleBindingDiscovery` surfaces: a DACS-1 §6.3.5 well-known index or §6.3.6
catalog), resolves them as a DACS-5 BB-6 candidate set (at most 8 fetches per
signer, collapse, fully-signed precedence) and reads the copy at the bound
native address. Parties match by CORE B.1 CF-3 identity (scheme and
identifier), so advisory ClaimReference parameters on the admitted holder, the
binding signer or the copy never make the same key another party. A binding's
optional `anchorTx` must equal the raw Demos transaction hash of the copy's
anchor receipt (`transactionRef.value`), not a `demos-testnet:`-prefixed form;
a binding with another spelling is inert. A side that no surface binds yet, whose candidates all fail
validation, or that equivocates is `indeterminate` (BB-7, BB-8), never absent.
Non-observation alone never gates completion; unresolved BB-6 candidate sets
remain indeterminate. A completion that was read and failed authentication needs
operator action. A track that stays `indeterminate` for the coordinator's
`maximumSubstratePauseMs` (default 3600 s) reports `substrate-pause-exceeded`
and continues reconciliation, including after restart. This operational alert
does not implement ST-7's failed-substrate terminal publication. Demos's answer against one copy goes to operator
action even when a read of the other copy went unanswered in the same check,
whichever arrives first: both copies settle before the check decides. A read
that never settles is cut off at one deadline for the whole check (the seller
closure, both copies and the final pair check): Demos's answer already seen
still goes to operator action, otherwise the track stays `indeterminate` and is
retried, and an answer that arrives later changes nothing. The coordinator
records the audit's result only while the audit track's lease is current, and
nothing renews that lease during the check. So the deadline is 5 seconds before
that lease expires, on the role database's clock, or `completionDeadline.timeoutMs`
on the buyer audit options (60 seconds by default) if that is sooner. With 5
seconds or less of the lease left, the check stays `indeterminate` without
reading. The service's coordinator lease (`coordinatorLeaseDurationMs`) is 300
seconds by default; the core coordinator's own default is 30 seconds. A lease
too short for the audit's Demos reads keeps it `indeterminate` on every retry.
Receipt reads are classified by method-specific response bodies and independently
verified transaction, block and storage records. HTTP status alone does not prove
an invalid receipt: failed POSTs, including 400/404/410/422, transport failures and
SDK result-500 wrappers remain indeterminate. Unknown transaction/block RPC
responses such as `{result:400,response:"error"}` do not establish finality or
permanent invalidity. Storage-program reads separately recognize the adapter's
genuine not-found response as absence; missing receipt observations remain
retryable. A readable authenticated record contradicting the claimed receipt is
a definitive rejection.

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
intent and is retryable. The track independently checks the authenticated
preparation amount against `maximumServiceAmount` in rail base units before it
creates a challenge client or effect intent; the fixed-price live composition
accepts that ceiling in canonical major units and performs the asset-decimal
conversion. Once a bearer is retained and a paid request may have been sent,
the existing payment effect fence and chain-authenticated reconciliation path
remain authoritative; an unknown result never causes a new authorization or a
blind paid-request replay.

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
requires a validated pre-write backup. Schema v7 adds semantic idempotency,
durable quota accounting and bounded lifecycle cursors without modifying the
released v6 migration. A v6 database is backed up and every existing envelope,
history, semantic identity, and usage total is validated before v7 is committed;
ambiguous duplicate semantics fail closed. Schema v8 adds the separate
native-DEM coordinator namespace without changing the released v7 HTTP lifecycle
migration. Existing x402 and offline coordinator records retain their exact
profile and authenticated bytes while the constrained coordinator schema is
rebuilt after a validated pre-write backup.

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
may trust the HTTP body as identity or authorization evidence. A validator that
cannot read its own state now returns `unavailable`, which decides nothing: the
endpoint answers 503 with `Retry-After`, the sender retries, and a handler
leaves the message pending. The Vet terminal runtime answers so when its SQLite
store stays locked (`SQLITE_BUSY` or `SQLITE_LOCKED`) during validation, and
its track reports such a read as `indeterminate` with a `-busy` reason, never
as operator action.


Upgrade note: `DacsBuyerAuditAuthorizationV1` callbacks may now return
`"indeterminate"` as well as a boolean. Existing boolean callbacks still work;
callers consuming the result must handle `"indeterminate"` as pending verification
and must check `result === true` before treating it as authorization.


Before upgrading the native Vet reference format, drain all in-flight testnet
jobs on both peers. Retained Vet records and audit references from older builds
must not be carried into an upgraded session; restart new jobs after the upgrade.
