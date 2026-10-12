# Liquidity-tank settlement safety core

The SDK exposes a dependency-injected
`pay-cross-chain-liquidity-tank` producer core for the DACS-4 §9.5.5 rail. It
binds the current DACS v0.1 route—ETH Sepolia to Polygon Amoy, USDC,
unidirectional—and refuses silent substitution to HTLC or any other mechanism.
It does not conform to §9.5.5 or ST-8 for a lock whose bridge reads contradict
it: such a lock does not expire while its bridge reads contradict it (see
[Contradicted locks](#contradicted-locks)).

The core:

- validates the exact stablecoin-cross-chain / cross-chain / liquidity-tank
  authority, SR-5 binding, route and distinct tank pair;
- binds both addresses, the fixed route's exact six-decimal USDC conversion,
  amount, agreement, rail, job and phase before effects;
- requires the complete signed native-bridge transaction to be prepared and
  durably stored before broadcast;
- generation-fences preparation, exact-byte broadcast and authenticated status
  reads across worker takeover;
- reconciles the same 16-character `bridgeId` and operation hash before every
  rebroadcast;
- refuses to run without the host's two checks: it uses a bridge observation
  only when the host's `authenticateObservation` returns `true`, and stores or
  broadcasts signed bytes only when `verifySignedSubmission` returns `true`
  (see [Host verifier](#host-verifier));
- accepts only `empty -> pending -> completed` history;
- returns success only when both source lock and destination release hashes are
  present;
- treats capacity exhaustion as transient on the same pinned tank rail; and
- persists locked-unreleased state as ST-8 `tank-locked-unreleased`, resolving
  forward to success or reputation-neutral `failed-substrate` at the recovery
  deadline, except for a contradicted lock, which stays locked past the
  deadline while its bridge reads contradict it. `recoveryDeadline` is an exact Unix-millisecond timestamp throughout
  pending and completed adapter observations, durable checkpoints, settlement
  replay records, progress and transaction evidence;
  seconds-scale values are not converted or heuristically reinterpreted (see
  [Timestamp units](#timestamp-units)). A completion is timely only when
  `finalityObservedAt < recoveryDeadline`; equality is expired. Expiry needs
  authenticated evidence; see below.

**Restart safety comes from the store, not the core.** Every no-double-send and
completion-versus-expiry guarantee holds only with a durable host store that
keeps every row across process restarts and commits each write atomically,
and that passes `runLiquidityTankStoreConformance` (see
[Store conformance](#store-conformance)). The SDK ships no such store. The
exported in-memory store loses everything on restart and refuses to construct
without `{ acknowledgeVolatile: true }`.

**A shared tank's balance comes from the bridge, not the core.** The core
checks one operation at a time. That the bridge never locks more than a tank's
capacity across concurrent phases is a launch requirement on the bridge, which
the SDK does not check (see [Tank balance](#tank-balance-is-the-bridges)).

```ts
import {
  advanceLiquidityTankSettlement,
  type LiquidityTankAdapter,
  type LiquidityTankStore,
  type LiquidityTankVerifier,
} from "@kynesyslabs/dacs/rails";

const result = await advanceLiquidityTankSettlement({
  authority,
  owner: workerId,
  adapter: nativeBridgeAdapter satisfies LiquidityTankAdapter,
  // Durable and atomic, and passes runLiquidityTankStoreConformance.
  store: durableStore satisfies LiquidityTankStore,
  verifier: hostVerifier satisfies LiquidityTankVerifier,
});
```

`prepareSubmission` must build and sign without broadcasting—for the current
Demos programmatic API this corresponds to the manual confirmation path. The
store commits those exact signed bytes first. `broadcastRetained` may then
rebroadcast only that retained transaction, so an ambiguous response never
authorizes a new nonce or bridge operation. The core binds the intent it passes
to `prepareSubmission` and checks the returned authority, operation hash and
bridge ID. It does not decode `signedSubmissionBase64` itself: the host's
`verifySignedSubmission` must, before the bytes are stored.

**Adapter contract for the signing window.** `prepareSubmission` must not
broadcast, log, cache for later sending or otherwise reveal the signed bytes
before `recordSubmission` commits them. If the worker stops after signing but
before that write commits, the next owner finds no retained submission and
signs a fresh one; the first bytes must never reach the bridge, or the buyer
pays twice. This is an adapter-review requirement, not a guarantee of the
core: the core can neither enforce nor detect it, and its tests show the safe
outcome only for an adapter that keeps it. Review every live adapter for it,
with a test against that adapter showing `prepareSubmission` neither
broadcasts nor keeps the bytes for later sending.

The retained submission hash and bytes are validated before any adapter effect
or store write. Corrupted retained state returns the retry-safe indeterminate
reason `liquidity-tank-retained-state-corrupt`; operators must restore the exact
authenticated row rather than preparing or broadcasting a replacement.
For acquired claims, optional retained fields are distinguished by own-property
presence: a present malformed or falsey submission/observation is corruption,
while only a genuinely absent submission authorizes fresh preparation.

Recovery expiry needs authenticated evidence bound to the exact checkpoint:

- a locked pending snapshot with `observedAt >= recoveryDeadline`;
- a terminal `failed` with either `empty -> pending -> failed` or
  `empty -> failed` history, whose authenticated `lockTxHash` and
  `recoveryDeadline` match the durable lock; or
- a completion with `finalityObservedAt >= recoveryDeadline`.

For pending snapshots, `observedAt` is the time the bridge snapshot describes,
not the time the adapter served it. A cached pre-deadline pending snapshot is
insufficient, even when requested after the deadline. There is no clock-skew
allowance: both the snapshot and the host clock must reach the deadline.

A terminal failure is different: its transition timestamp need not refresh.
The core retains the first authenticated failure immediately as
`failed-after-lock` evidence, including the exact checkpoint, bridge ID,
operation hash, lock hash, deadline and history. The failure observation must
carry the authenticated lock hash and deadline; the core does not invent these
fields from the checkpoint. Before the deadline it reports
`bridgeStatus: "failed"`. Once the host clock reaches the deadline, a progress
call or restarted worker can commit reputation-neutral `failed-substrate`
from that retained evidence, including when the next bridge read is unavailable
or contradictory. A timely completion observed before the expiry commit still
wins; a failed completion write never triggers expiry in that call.

Without retained terminal evidence, the lock remains open when the status is
unavailable, an observation write fails, or a pending snapshot is stale.

## Timestamp units

`preparedAt`, `observedAt`, `recoveryDeadline` and `finalityObservedAt` are
Unix milliseconds and are compared exactly as sent; a value in seconds is
refused, never converted. The core catches a seconds-scale value where it has
something to compare it with:

- **A fresh submission's `preparedAt`** must lie within one minute of this
  host's clock readings before and after `prepareSubmission`. Otherwise the
  core returns `liquidity-tank-preparation-time-off-host-clock` and stores and
  broadcasts nothing, so a submission stamped in seconds never starts a bridge
  operation, and the next owner signs afresh.
- **No bridge time on the operation may fall before `preparedAt`:** not a
  `recoveryDeadline` (`liquidity-tank-recovery-deadline-before-preparation`),
  a completion's `finalityObservedAt`
  (`liquidity-tank-finality-before-preparation`), or a locked pending's
  `observedAt` (`liquidity-tank-lock-observed-before-preparation`). A value the
  adapter just returned is then not used at all, not even to fall back on
  durable progress; a stored row holding one is refused before any effect. So
  a seconds-scale deadline cannot expire a fresh lock at once, and a
  seconds-scale finality cannot make a late release look timely.
- **A retained submission's `preparedAt`** must lie within one minute of its
  receipt, `submissionRecordedAt`: the host clock reading the core passed as
  `now` to the `recordSubmission` that first stored it, which the store keeps
  beside it (see [Store contract](#store-contract)). The core checks this on
  every claim that returns the submission, before it verifies, observes,
  rebroadcasts, settles or expires anything. A row without a receipt returns
  `liquidity-tank-submission-receipt-missing`; one outside the window, such as
  a `preparedAt` in seconds beside a receipt in milliseconds, returns
  `liquidity-tank-preparation-time-off-receipt`. Both are `indeterminate` and
  retryable, never terminal, so a retained seconds-scale `preparedAt` and
  deadline can no longer expire a millisecond lock early. Before storing a
  fresh submission the core applies the same check to the reading it stores,
  so a submission whose verification outlasted the window is not stored.

What the adapter must still guarantee is that every bridge time is Unix
milliseconds from the bridge's authenticated record. The core cannot catch a
value that is too large, such as one in microseconds: a deadline in
microseconds never arrives, so the lock stays open and any release reads as
timely; a finality in microseconds reads as late, so once the host clock
reaches the deadline a timely release is expired as `failed-substrate`. A
retained `preparedAt` is only as well bound as its receipt: a store that
stamps the receipt from its own clock, in its own unit, breaks the check, and
store conformance refuses one that does. A settled row carries no
`preparedAt`, so its `finalityObservedAt` is checked only against its
deadline.

## Tank balance is the bridge's

The core keeps no tank balance and does no pool accounting. It checks each
phase on its own: one bridge operation per phase, whose signed bytes the host
verifier confirms carry exactly the intent, so one operation never locks more
than its own amount. It trusts an authenticated `capacity-unavailable` from the
bridge and waits.

**Launch requirement:** the bridge must enforce `reserved + available =
capacity` atomically across concurrent phases, so a shared tank never locks
more than its capacity and never goes negative. The SDK does not check this,
and none of its tests run concurrent phases against one tank. Before a live
adapter is wired, the bridge's accounting needs its own review and evidence. A
shared reservation interface in the SDK would be a separate change.

## Host verifier

`advanceLiquidityTankSettlement` takes a required `verifier` with two methods.
The core cannot make either check itself: it holds no bridge key and stays
free of Demos transaction decoding. Each is called with frozen inputs and
counts only when it returns (or resolves to) literal `true`; `false`, any other
value, or a throw means the value is not used.

- **`authenticateObservation({ intent, submission, observation })`** checks one
  bridge observation—status, history, bridge ID, operation hash, lock and
  release hashes, timestamps and `recoveryDeadline`—against the bridge's own
  authenticated record, for example a pinned bridge key or an attestation over
  the canonical status. It runs on every observation the adapter returns
  (except `indeterminate`, which the core never acts on) and on every retained
  observation before the core acts on it: the durable checkpoint or
  completion in a claim, retained failure evidence, and committed expiry
  evidence. A refused fresh observation returns
  `liquidity-tank-observation-unauthenticated`; a refused retained one returns
  `liquidity-tank-retained-observation-unauthenticated`. Neither settles,
  expires, records anything or broadcasts.
- **`verifySignedSubmission({ intent, submission })`** decodes
  `signedSubmissionBase64` and confirms it signs exactly the intent: the source
  amount in base units, origin and destination addresses, asset, tank pair and
  the submission's `bridgeId`, and that `substrateTxHash` is recomputed from
  those bytes. It runs on a freshly prepared submission before
  `recordSubmission`, and on a retained submission before the core observes
  against it, settles from it or rebroadcasts it. A refusal returns
  `liquidity-tank-signed-submission-unverified`; nothing is stored or broadcast.

A missing verifier or method, or one that is not a stable function, is refused
before any claim with `liquidity-tank-observation-authenticator-unavailable` or
`liquidity-tank-submission-verifier-unavailable`. The core never falls back to
trusting the adapter.

**A settled row is trusted as the store wrote it.** When a claim returns
`settled`, the core checks the stored settlement's shape, its amount and route
against the intent, and that it finalized before its deadline, then returns
it without calling either hook. The core writes a settlement only after
authenticating the completion behind it, so a forged or corrupted settled row
is a failure of the store's own integrity, which the verifier does not catch.
Every other retained row listed above is checked again before use.

**Each hook needs its own bounded deadline.** The core sets no timeout on a
verifier or adapter call, so a hook that never settles hangs that
`advanceLiquidityTankSettlement` call. Another owner can take the phase over
once the lease expires, and the stalled call, if it resumes, stores and
broadcasts nothing without a current lease. A hook that runs out of time
should throw or return `false`; the core treats either as a refusal.

## Contradicted locks

Authenticated `empty` or `capacity-unavailable` after a durable lock contradict
it. A different lock/deadline or a failure missing the exact checkpoint binding
also cannot authorize expiry. Such contradictions may describe a lagging
replica while locked funds can still move: automatically expiring them could
record a release that actually landed as failed and allow the buyer to pay
twice.

Contradictions return `bridgeStatus: "conflicting"`. At or after the deadline
they return the distinct reason `lock-contradicted`, with `pastDeadline: true`,
and remain locked; a timely completion can still settle. A contradiction
latches nothing: once a later read carries the expiry evidence listed above,
such as the same lock's pending snapshot stamped at or after the deadline, the
lock expires to `failed-substrate` as usual.

**This is a known deviation from DACS-4.** §9.5.5 bounds the
`settle-asymmetric` state by `recoveryDeadline` and says the window expiring
resolves to reputation-neutral `failed-substrate`; SR-5 (§9.8) requires both
legs to succeed together or never take effect within a bounded time. This rail
does not expire a lock while its bridge reads contradict it, so it does not
conform to §9.5.5 or ST-8 for that case and must not be presented as
conforming. Hosts must treat `lock-contradicted` as a readiness failure for
this rail that needs an operator, not as ordinary waiting. The SDK has no
runtime rail-readiness surface consuming these progress results; its
conformance tests and settlement-evidence validators check artifact/evidence
shapes separately. Hosts should alert on overdue ordinary locked progress
beyond normal bridge lag, and send contradictions to an operator immediately.
No reconciliation operation is provided here; see the open list below.

## Store contract

**Leases.** An acquired claim must return a lease whose `owner` is the
caller's, whose `generation` is a positive safe integer above any earlier one
for the key, and whose `expiresAt` is exactly `now + leaseDurationMs` from the
claim input. Use the `now` the core passed, not the store's own clock: the core
refuses any other lease as `liquidity-tank-settlement-store-lease-invalid` on
every call, so a store stamping its own time never progresses. Every write
(`recordSubmission`, `recordObservation`, `recordSettlement`,
`recordRecoveryFailure` and `recordRecoveryExpired`) carries the core's `now`
and must refuse unless the identified owner and generation are current and
`expiresAt > now`. The core also checks `isCurrent` before each effect, but a
store must not rely on that: a write that lands after its lease expired may
race a new owner.

**Submission receipt.** The `recordSubmission` that first records a
submission must keep its input `now`, exactly as passed, as
`submissionRecordedAt` in the same atomic write. Every acquired, waiting or
recovery-expired claim that returns the submission returns that value beside
it, across restarts; an exact replay answered `existing` must not replace it,
and a claim with no submission has none. Do not stamp it from the store's own
clock. The core uses a retained submission only when its `preparedAt` is
within one minute of the receipt (see [Timestamp units](#timestamp-units)).

Production stores must implement the required
`recordRecoveryFailure({ settlementKey, bindingHash, owner, generation, now,
recoveryFailure })`. It retains the failure atomically, without replacing the
pending `observation`, and must CAS against `recoveryFailure.checkpoint` as
the exact durable observation and the current authority/owner/generation/
lease at the supplied `now`, rejecting any completion or expiry winner. Keep
the first failure, accept exact replay as `existing`, and reject replacement.
A success (`recorded` or `existing`) must return the failure now retained as
`recoveryFailure`. The core counts the failure as retained only when that echo
has exactly the canonical bytes it sent; anything else (`stale`, `conflict`,
`corrupt`, a missing or different echo, or a throw) leaves the lock open with
the retry-safe `liquidity-tank-failure-persistence-uncertain`, with no expiry
and no broadcast. Return the retained failure in acquired and waiting claims
across restart. A present malformed `recoveryFailure` in a claim fails closed
as retained-state corruption.

`recordRecoveryExpired` must CAS against the exact observation established by
the acquired claim or confirmed write, with a current lease and host `now` at
or after the deadline. For `failed-after-lock`, the evidence must equal the
retained failure and its checkpoint must equal the durable one; no new failure
timestamp is required. Pending expiry still re-checks snapshot freshness, and
completed expiry still re-checks late finality. A completed observation carries
its authenticated deadline even without a prior checkpoint; with a checkpoint,
its lock and deadline must match exactly.

Completion persistence and recovery expiry race atomically. Persisting a timely
completion clears retained failure evidence and blocks expiry, even before its
settlement is written: refuse any expiry once a completed observation is
durable. Whichever
eligible terminal transition commits first wins; the loser must report a
non-successful write. Once expiry commits, every claim from a host whose clock
is at or after the deadline returns the same terminal state and no later
completion may settle. A replayed `failed-after-lock` expiry carries no time of
its own, so a worker whose clock has not reached the deadline reports the
retry-safe `liquidity-tank-recovery-expiry-not-due` instead. A terminal result
is final: hosts must act on it and not re-poll, since a host clock that steps
back across the deadline would briefly report that retry-safe result again.

A timely durable completed observation is also a settlement replay record. On worker
takeover the coordinator deterministically reconstructs and records its
settlement, including its exact `recoveryDeadline`, before any adapter
observation, preparation or broadcast. Stores must accept an exact replay as
`existing` and reject conflicting settlement writes.

## Store conformance

`runLiquidityTankStoreConformance({ createStore, reopenStore })` runs the store
contract against any `LiquidityTankStore` and returns one result per case.
**A production store must pass every case before the core relies on it.**
`createStore` returns a store with no liquidity-tank rows and is called once
per case, plus once before the cases to check `reopenStore`.
`reopenStore(store)` must return a new handle on the same durable state,
opened as a restarted process or a second worker would open it (for example a
new connection to the same database), sharing no in-process state. The
restart cases use the new handle in place of the old one; the race cases keep
both open and write through them at once. A `reopenStore` that returns the
handle it was given fails every case, since a restart or a race through it
would test nothing.

**Sequential cases** check one write at a time: exact leases, generation
fencing (including a re-claim by the same owner, whose earlier generation must
stay fenced), lease expiry on every write, first-submission retention, the
submission receipt (the first write's `now`, kept through a replay, a
restart and an expiry), bridge-ID uniqueness, observation ordering, late completions, the
completion-versus-expiry election in both orders, failure retention,
settlement replay, and state that survives `reopenStore`, including the
bridge-ID index. Two more drive the core through one phase with a worker that
stops before its submission write commits, a lost broadcast response and
restarts between every step. After every step they check that no second
signed submission was broadcast, that the funds this one operation locked
never exceed its intent, and that the phase is never reported both settled
and expired; each must end in exactly one. That is a check on one operation,
not on a tank's balance (see [Tank balance](#tank-balance-is-the-bridges)).

**Race cases** start two operations through two handles before either
settles, in both start orders: two claims on a fresh phase and two takeovers
of an expired lease; two submissions for one phase; two phases submitting on
one bridge operation; a timely completion against recovery expiry; a
settlement against expiry after a durable timely completion; a takeover
against each ordinary write; and two workers starting one phase through the
core, held at preparation until both have reached it or one has returned.
After each race a fresh handle must show exactly one winner, the one the store
reported.

**What passing shows, and what it doesn't.** A store that passes keeps the
contract in these sequences and in these races, as this process could
interleave them. That is evidence, not proof, that it commits each write
atomically: a store that loses a race only under other timing, other
interleavings, several processes or production load can still pass. Build
each method on the backend's own atomic primitive (a single conditional write,
or one serializable transaction that reads and writes the row) and review that
code; the suite does not replace the review.

```ts
import { runLiquidityTankStoreConformance } from "@kynesyslabs/dacs/rails";

const results = await runLiquidityTankStoreConformance({
  createStore: () => openStore(freshDatabase()),
  reopenStore: (store) => openStore(databaseOf(store)),
});
const failed = results.filter((result) => !result.passed);
if (failed.length > 0) throw new Error(JSON.stringify(failed));
```

The in-memory reference store cannot pass: a second instance starts empty, so
it fails the restart and race cases. That failure is the reason it requires
`acknowledgeVolatile`. Handing it back as its own reopened handle
(`reopenStore: (store) => store`) is refused, as above. The SDK's own tests
run the reference store's rules behind new handle objects on one shared
instance, which stands in for a database; that shows the cases accept a store
that keeps the contract, not that the reference store is durable.

## Refusals before any claim

The core captures and validates the authority and binds every store and
adapter method before any claim, preparation, observation or broadcast. A
refusal there, like a claim conflict, is never a settlement failure: it returns
the retry-safe `indeterminate`.

The settlement key binds only `jobId`, `railId` and `phaseIndex`, so the core
cannot tell from the authority alone whether its phase already holds a lock or
has settled. A `phaseIndex` read back as the string `"2"`, a decimals field as
`"6"`, an amount as a number or an upper-cased hash all share the key of the
phase they came from. So:

- **A presented authority refused for its content** (mechanism, scope, route,
  hashes, decimals, amount, job identity or tank pair) **or its
  representation** (a frozen or otherwise read-only authority, a `Proxy`,
  accessors, an exotic prototype, or an `input` that is a `Proxy` or exposes
  `authority` through an accessor) returns `indeterminate` with the refusal
  message as its reason. Content validation reads only the authority's own
  data properties, accepts only primitive strings and numbers, and decides
  through built-ins captured when the SDK loads (see below).
- **A claim conflict**, where the store already holds a different binding for
  the phase, returns `indeterminate` with the store's reason (the reference
  store's `liquidity-tank-settlement-binding-conflict`, or the host store's
  own). That binding may be a durable lock or a settlement.

A host must present the identical authority, as a plain, writable data object,
for a phase it has started. If it cannot, an operator resolves the phase.

Host configuration is refused the same way, before any claim or effect:

- **A store without a stable `recordRecoveryFailure`**—for example one not
  upgraded with the SDK, or whose `recordRecoveryFailure` is missing,
  accessor-backed or a `Proxy`—returns reason
  `liquidity-tank-store-recovery-capability-unavailable` on every call.
- **Any other refused owner, lease, clock, store or adapter**, including a
  whole store wrapped in a `Proxy`, returns its refusal message as the reason,
  for example `pay-cross-chain-liquidity-tank: store.claim must be stable
  data`.

Both need an operator: the core has not read the store, so it cannot tell
whether a lock is durable or the phase already settled.

## Reasons that need an operator

Every refusal and conflict is `indeterminate`, so `status` alone does not say
whether polling can help. These reasons repeat identically on every retry
with the same authority, configuration and store row. Escalate them to an
operator rather than polling:

- `liquidity-tank-settlement-binding-conflict`;
- `liquidity-tank-retained-state-corrupt`;
- `liquidity-tank-store-recovery-capability-unavailable`;
- `liquidity-tank-settlement-store-lease-invalid`: the store's lease is not
  exactly `now + leaseDurationMs`, or a waiting lease is malformed (see
  [Store contract](#store-contract));
- `liquidity-tank-settlement-store-claim-invalid`: the store answered a claim
  with a malformed result;
- `liquidity-tank-clock-invalid`: the host clock returned a value that is not
  a non-negative safe integer;
- `liquidity-tank-settlement-store-intent-mismatch` and
  `liquidity-tank-settlement-store-intent-invalid`: the store's row is bound to
  another or an unreadable intent;
- `liquidity-tank-stored-settlement-mismatch`: the phase is settled, but the
  stored settlement does not match the intent, so it reports `indeterminate`
  until an operator repairs the row;
- `liquidity-tank-observation-authenticator-unavailable` and
  `liquidity-tank-submission-verifier-unavailable`: the host supplied no
  verifier method;
- `liquidity-tank-observation-unauthenticated`,
  `liquidity-tank-retained-observation-unauthenticated` and
  `liquidity-tank-signed-submission-unverified`: the host's verifier refused
  an observation or signed bytes. A verifier that throws because its own
  dependency is down lands here too: still retry-safe, but a repeat needs an
  operator, not polling;
- `liquidity-tank-recovery-deadline-before-preparation`,
  `liquidity-tank-finality-before-preparation` and
  `liquidity-tank-lock-observed-before-preparation`: the adapter or a stored
  row carries a bridge time earlier than the submission, such as one in
  seconds (see [Timestamp units](#timestamp-units));
- `liquidity-tank-preparation-time-off-host-clock`: the adapter stamped a
  fresh submission more than a minute from this host's clock, such as in
  seconds, or its verification took long enough to leave that window; nothing
  was stored or broadcast;
- `liquidity-tank-submission-receipt-missing` and
  `liquidity-tank-preparation-time-off-receipt`: a retained submission has no
  receipt, or its `preparedAt` is more than a minute from it (see
  [Timestamp units](#timestamp-units)). The core used nothing from the row:
  any lock stays open and the phase is neither settled nor failed, so do not
  authorize another payment for it. For a missing receipt, fix the store so it
  returns one; a row written before the store kept receipts may be backfilled
  only from the store's own durable record of when that submission was first
  written, in host-clock Unix milliseconds, never from `preparedAt`. For a
  receipt that is right but a `preparedAt` that is not, such as one in
  seconds, the signed submission cannot be restamped (its hash covers
  `preparedAt`): read the bridge's authenticated record for the retained
  `bridgeId` and resolve the phase by hand. Never sign or broadcast a new
  submission for the phase;
- any reason that starts with `pay-cross-chain-liquidity-tank:` (a refused
  authority, owner, lease, clock, store or adapter);
- a capture refusal: `liquidity-tank authority is not stable canonical JSON`,
  `jobId must be a canonical uppercase ULID`, or the fallbacks
  `liquidity-tank-authority-unreadable`, `liquidity-tank-authority-invalid`
  and `liquidity-tank-runtime-policy-invalid`;
- any conflict reason returned by the host's own store.

A refusal caused by a polluted or replaced built-in in the host process (see
below) also repeats until that process is fixed or restarted, so the operator
should check the process as well as the authority and the row.
`lock-contradicted` (above) also needs an operator. Only these
`indeterminate` reasons are transient—retry with backoff, and alert if one
persists: `liquidity-tank-settlement-store-unavailable`,
`liquidity-tank-status-unavailable`,
`liquidity-tank-submission-preparation-unavailable`, the
`…-persistence-uncertain` reasons, `liquidity-tank-broadcast-outcome-uncertain`,
`liquidity-tank-recovery-checkpoint-conflict`,
`liquidity-tank-recovery-expiry-not-due`,
`liquidity-tank-completion-finality-invalid` and
`liquidity-tank-status-transition-unresolved`. A typed discriminator for this
is left to a later release.

## Polluted or replaced built-ins

**What the rail does.** It validates and derives the settlement key (`jobId`,
`railId`, `phaseIndex`), the amount and base units, the payee and every other
intent field from the authority's own data properties. It reads them before
any shared code runs on the authority, and the shared code gets only frozen
copies of what it hashes. Whether a store write succeeded, and which
top-level fields a store claim or adapter observation holds (including whether
a claim retains a submission), are decided the same way.
These reads use built-ins the SDK captures when it loads:
`Reflect.getOwnPropertyDescriptor`, `Reflect.ownKeys`, `Object.hasOwn`,
`Object.freeze`, `util.types.isProxy`, `RegExp.prototype.exec`,
`String.prototype.normalize`, `charCodeAt` and `slice`, and the one-shot
`crypto.hash`.

The values of a store or adapter result's fields come from the shared
canonical-JSON snapshot (below). The core reads them from copies with no
prototype, so a field the result does not hold reads as absent. The
observations the core passes to a store are such copies: frozen, with no
prototype.

So a data-only prototype pollution, such as an extra property on
`Object.prototype` or `Array.prototype`, can't change the settlement key,
amount or payee, or make a store's refusal read as success. A polluted field
the authority lacks reads as absent and is refused, and an over-precise
amount is refused before any padding lookup. Nor can pollution supply a field
a store or adapter result lacks: an unlocked pending observation stays
unlocked, and an observation, claim, lease, submission, settlement or recovery
evidence missing a required field is refused. The shared canonical-JSON code
still uses the live built-ins. It decides whether the authority's
representation is stable canonical JSON, computes the operation and binding
hashes, and reads the contents of store and adapter results. Pollution there
can make the core refuse an authority or a result (`indeterminate`). For a
phase that already holds a binding, a changed binding hash is a binding
conflict (`indeterminate`).

**What it doesn't.** Code that replaces JavaScript built-ins or intrinsics in
the same process is outside the rail's threat model, at any time, before or
after the SDK loads. Built-ins replaced before it loads, by a `--import`
preload or a polyfill imported first, are the ones it captures, so the
captures give no protection against them. Examples are a prototype method, a
static such as `Object.entries`, `util.types.isProxy`, or an accessor on an
internal slot. Such code can call the adapter or the signer directly, or
forge what the store or adapter returns, so no rail can stop it. The captured built-ins make accidental
interference, such as a dependency that patches a prototype, unlikely, not
impossible. Run the rail only in a process whose code you trust.

The reference store also keeps a phase's first submission and refuses a
replacement. A production store should do the same, as its own check that
does not depend on how the core reads results.

## Adapter trust boundary

The core checks only the shape of `authenticationHash` and the presence of the
lock and release hashes. Whether an observation is genuine, and whether signed
bytes carry the intent, is decided by the host's `verifier` (see
[Host verifier](#host-verifier)); without it the core refuses rather than
trusting the adapter. A verifier that always answers `true` restores the
adapter's full trust, so its implementation is part of the security review of
any live integration. Demos SDK 4.0.16 exposes native-bridge submission but no
public bridge-status lookup that can back `authenticateObservation`, so a
bundled live Demos adapter and funded proof are explicitly blocked on that
upstream capability. The pure protocol/recovery core and its adversarial tests
do not pretend a submit response is completion.

`createInMemoryLiquidityTankStore({ acknowledgeVolatile: true })` is for tests
and development only. Without that option it throws a `TypeError`: it keeps
every row in process memory, so after a restart a worker finds no retained
submission, signs and broadcasts a second bridge operation, and locks the
buyer's funds twice. Production stores must authenticate retained rows,
enforce global bridge-ID uniqueness, keep each submission's receipt, preserve
locked-unreleased checkpoints across process restart, persist the completion-versus-expiry winner
atomically, and pass `runLiquidityTankStoreConformance`.

## Open before any live adapter is wired

- implement the two `verifier` methods for the live Demos adapter: a pinned
  bridge key or attestation behind `authenticateObservation`, and
  `demosdk`-backed transaction decoding behind `verifySignedSubmission`, so
  that `@kynesyslabs/dacs/rails` stays dependency-free;
- a durable production store that passes `runLiquidityTankStoreConformance`
  against a real backend, with funded restart and ambiguity evidence;
- reviewed evidence that the bridge enforces `reserved + available =
  capacity` atomically across concurrent phases (see
  [Tank balance](#tank-balance-is-the-bridges)); the SDK does not;
- a review of the live adapter's signing window, with a test that
  `prepareSubmission` neither broadcasts nor keeps the signed bytes, and
  bounded deadlines on every adapter and verifier call;
- a lock whose bridge reads contradict it (`empty`, `capacity-unavailable`, a
  failure not bound to the lock, or a different lock/deadline) does not expire
  while they do, and reports `lock-contradicted` past the deadline D. §9.5.5
  says the window expiring resolves to `failed-substrate`. This needs an
  authoritative reconciliation operation or a spec-defined indeterminate
  outcome; the question is open as
  [DACS-Standard#422](https://github.com/DACS-Agent-commerce/DACS-Standard/issues/422); and
- confirm with the DACS-4 §9.5.5 owner whether a `failed` after a committed
  lock should settle via ST-8 (neutral `failed-substrate` at D, as now) or
  immediately as `permanent` (the §9.5.5 failure-mode list), and whether a
  failure bound to the lock with no stored checkpoint should do the same.
  Today a `failed` with history `empty -> pending -> failed` and no stored
  checkpoint is `permanent`, even when it carries the lock hash and deadline.
