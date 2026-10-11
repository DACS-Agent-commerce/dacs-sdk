# Liquidity-tank settlement safety core

The SDK exposes a dependency-injected
`pay-cross-chain-liquidity-tank` producer core for DACS-4 §9.5.5. It binds the
current DACS v0.1 route—ETH Sepolia to Polygon Amoy, USDC, unidirectional—and
refuses silent substitution to HTLC or any other mechanism.

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
  deadline. `recoveryDeadline` is an exact Unix-millisecond timestamp throughout
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

Recovery expiry commits only on authenticated evidence that the release missed
the deadline, judged by the evidence's own bridge-authenticated time:

- the locked pending status matching the checkpoint, with
  `observedAt >= recoveryDeadline`;
- a failed status with history `empty -> pending -> failed` after the
  checkpoint, with `observedAt >= recoveryDeadline`, stored as
  `failed-after-lock` evidence together with the checkpoint; or
- a completion with `finalityObservedAt >= recoveryDeadline`.

`observedAt` is the time the bridge's authenticated snapshot describes, not
the time the adapter served it. When the host asked does not count: a cached or
lagging adapter can answer a post-deadline request with a pre-deadline
snapshot, and that is not evidence. The host clock must also be at or after the
deadline when expiry is written. There is no clock-skew allowance in either
direction, so when the bridge and host clocks disagree, expiry waits for both.

Past the deadline the lock stays `tank-locked-unreleased`, and never expires on
its own, while:

- the status read is unavailable, or the observation write fails;
- the bridge still serves a snapshot observed before the deadline; or
- the bridge reports a status that contradicts the checkpoint: `empty`,
  `capacity-unavailable`, a failure whose history skips `pending`, or a
  different lock hash or deadline. These are history regressions, which is
  what a lagging replica returns, so they do not show that the release will
  never land.

A timely completion can still settle from any of these. The
`settle-asymmetric` result says why the lock is still open. `pastDeadline: true`
means the host clock was at or after the deadline and no expiry evidence was
accepted. `bridgeStatus: "failed"` means the bridge reported a failure after the
lock; it expires once the bridge reports it at or after the deadline.
`bridgeStatus: "conflicting"` means the bridge contradicted the checkpoint.
Hosts should keep polling, alert when `pastDeadline` persists beyond the
bridge's normal reporting lag, and send `conflicting` to an operator at once,
because the bridge record has to be reconciled by hand.

Production stores must implement `recordRecoveryExpired` as an atomic,
authority/lease/generation-fenced compare-and-set against the exact observation
established by the acquired claim or a confirmed write. A completed observation
carries the authenticated source-lock `recoveryDeadline` even when no pending
checkpoint was previously persisted; expiry can therefore compare-and-set
directly from that exact prior state. When a durable locked-pending checkpoint
exists, the completed lock hash and deadline must match it exactly, and the
checkpoint in pending or `failed-after-lock` evidence must equal it. The store
must re-check the evidence time at the compare-and-set: its `now` and the
evidence's `observedAt` (or `finalityObservedAt`) must both be at or after
`recoveryDeadline`. Completion persistence and recovery expiry race
atomically: whichever eligible transition
commits first is terminal, and the loser must report a non-successful write. Once
expiry commits, every claim returns the same recovery-expired terminal state and
no later completion may settle.

A timely durable completed observation is also a settlement replay record. On worker
takeover the coordinator deterministically reconstructs and records its
settlement, including its exact `recoveryDeadline`, before any adapter
observation, preparation or broadcast. Stores must accept an exact replay as
`existing` and reject conflicting settlement writes.

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

Open before any live adapter is wired:

- verify bridge observations in the core or an injected verifier (a pinned
  bridge key or attestation over the canonical status, history, hashes and
  timestamps) instead of checking only the shape of `authenticationHash`;
- decode `signedSubmissionBase64` and compare it with the intent before it is
  stored, through the `demosdk`-backed adapter or an injected decoder so that
  `@kynesyslabs/dacs/rails` stays dependency-free; and
- confirm with the DACS-4 §9.5.5 owner whether a `failed` status with history
  `empty -> pending -> failed` and no stored checkpoint should be
  reputation-neutral. Today it is `permanent`.
