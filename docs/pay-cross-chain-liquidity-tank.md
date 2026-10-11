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
Authenticated `empty` or `capacity-unavailable` after a durable lock contradict
it. A different lock/deadline or a failure missing the exact checkpoint binding
also cannot authorize expiry. Such contradictions may describe a lagging
replica while locked funds can still move: automatically expiring them could
allow the buyer to pay twice.

Contradictions return `bridgeStatus: "conflicting"`. At or after the deadline
they return the distinct reason `lock-contradicted`, with `pastDeadline: true`,
and remain locked. Hosts must treat this as requiring intervention and as a
failure of readiness/conformance for this rail, rather than ordinary waiting.
The SDK has no runtime rail-readiness/conformance surface consuming these
progress results; its conformance tests and settlement-evidence validators
check artifact/evidence shapes separately. A timely completion can still
settle. Hosts should alert on overdue ordinary locked progress beyond normal
bridge lag, and send contradictions to an operator immediately. No
reconciliation operation is provided here; authoritative resolution tied to the
exact lock and deadline remains a follow-up with the DACS-4 §9.5.5 owner.

Production stores must retain `recordObservation`'s optional `recoveryFailure`
atomically, without replacing its pending `observation`. This write must CAS
against the exact durable checkpoint and current authority/owner/generation/
lease at the supplied `now`, rejecting any completion or expiry winner. Keep
the first failure, accept exact replay as `existing`, and reject replacement.
Return it in acquired and waiting claims across restart. A present malformed
`recoveryFailure` fails closed as retained-state corruption.

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
non-successful write. Once expiry commits, every claim returns the same terminal
state and no later completion may settle. Hosts must upgrade custom stores to
this retention/CAS contract before using the new core.

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
