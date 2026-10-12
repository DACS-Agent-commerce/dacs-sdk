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
- accepts only authenticated `empty -> pending -> completed` history;
- returns success only when both source lock and destination release hashes are
  present;
- treats capacity exhaustion as transient on the same pinned tank rail; and
- persists locked-unreleased state as ST-8 `tank-locked-unreleased`, resolving
  forward to success or reputation-neutral `failed-substrate` at the recovery
  deadline, except for a contradicted lock, which stays locked past the
  deadline while its bridge reads contradict it. `recoveryDeadline` is an exact Unix-millisecond timestamp throughout
  pending and completed adapter observations, durable checkpoints, settlement
  replay records, progress and transaction evidence;
  seconds-scale values are not converted or heuristically reinterpreted. A
  completion is timely only when `finalityObservedAt < recoveryDeadline`;
  equality is expired. Expiry needs authenticated evidence; see below.

```ts
import {
  advanceLiquidityTankSettlement,
  type LiquidityTankAdapter,
  type LiquidityTankStore,
} from "@kynesyslabs/dacs/rails";

const result = await advanceLiquidityTankSettlement({
  authority,
  owner: workerId,
  adapter: nativeBridgeAdapter satisfies LiquidityTankAdapter,
  store: durableStore satisfies LiquidityTankStore,
});
```

`prepareSubmission` must build and sign without broadcasting—for the current
Demos programmatic API this corresponds to the manual confirmation path. The
store commits those exact signed bytes first. `broadcastRetained` may then
rebroadcast only that retained transaction, so an ambiguous response never
authorizes a new nonce or bridge operation. The core binds the intent it passes
to `prepareSubmission`; it checks the returned authority, operation hash and
bridge ID but does not decode `signedSubmissionBase64` or recompute
`substrateTxHash`. The adapter must sign exactly that intent's amount,
destination and operation.

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
completion clears retained failure evidence and blocks expiry. Whichever
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
`lock-contradicted` (above) also needs an operator. Other `indeterminate`
reasons, such as an unavailable store or an uncertain broadcast, are
transient: retry with backoff, and alert if one persists. A typed
discriminator for this is left to a later release.

## Polluted or replaced built-ins

**What the rail does.** It validates and derives the settlement key (`jobId`,
`railId`, `phaseIndex`), the amount and base units, the payee and every other
intent field from the authority's own data properties. It reads them before
any shared code runs on the authority, and the shared code gets only frozen
copies of what it hashes. Whether a store write succeeded, and the top-level
fields of a store claim or adapter observation (including whether a claim
retains a submission), are read the same way.
These reads use built-ins the SDK captures when it loads:
`Reflect.getOwnPropertyDescriptor`, `Reflect.ownKeys`, `Object.hasOwn`,
`Object.freeze`, `util.types.isProxy`, `RegExp.prototype.exec`,
`String.prototype.normalize`, `charCodeAt` and `slice`, and the one-shot
`crypto.hash`.

So a data-only prototype pollution, such as an extra property on
`Object.prototype` or `Array.prototype`, can't change the settlement key,
amount or payee, or make a store's refusal read as success. A polluted field
the authority lacks reads as absent and is refused, and an over-precise
amount is refused before any padding lookup. The shared canonical-JSON code
still uses the live built-ins. It decides whether the authority's
representation is stable canonical JSON, computes the operation and binding
hashes, and reads the contents of store and adapter results. Pollution there
can make the core refuse an authority or a result (`indeterminate`). For a
phase that already holds a binding, a changed binding hash is a binding
conflict (`indeterminate`).

**What it doesn't.** Code that replaces JavaScript built-ins or intrinsics in
the same process after the SDK loads is outside the rail's threat model.
Examples are a prototype method, a static such as `Object.entries`,
`util.types.isProxy`, or an accessor on an internal slot. Such code can call
the adapter or the signer directly, or forge what the store or adapter
returns, so no rail can stop it. The captured built-ins make accidental
interference, such as a dependency that patches a prototype, unlikely, not
impossible. Run the rail only in a process whose code you trust.

The reference store also keeps a phase's first submission and refuses a
replacement. A production store should do the same, as its own check that
does not depend on how the core reads results.

## Adapter trust boundary

Production adapters must authenticate bridge status and its history. The core
checks only the shape of `authenticationHash` and the presence of the lock and
release hashes, so it cannot detect an adapter that skips authentication; its
success, failure and expiry decisions rely on the adapter here. Demos SDK
4.0.16 exposes native-bridge submission but no public bridge-status lookup that
can satisfy this boundary, so a bundled live Demos adapter and funded proof are
explicitly blocked on that upstream capability. The pure protocol/recovery
core and its adversarial tests do not pretend a submit response is completion.

The exported in-memory store is for tests and development only. Production
stores must authenticate retained rows, enforce global bridge-ID uniqueness,
preserve locked-unreleased checkpoints across process restart, and persist the
completion-versus-expiry winner atomically.

## Open before any live adapter is wired

- verify bridge observations in the core or an injected verifier (a pinned
  bridge key or attestation over the canonical status, history, hashes and
  timestamps) instead of checking only the shape of `authenticationHash`;
- decode `signedSubmissionBase64` and compare it with the intent before it is
  stored, through the `demosdk`-backed adapter or an injected decoder so that
  `@kynesyslabs/dacs/rails` stays dependency-free;
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
