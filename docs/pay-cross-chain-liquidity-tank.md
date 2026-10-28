# Liquidity-tank settlement safety core

The SDK exposes a dependency-injected
`pay-cross-chain-liquidity-tank` producer core for the DACS-4 §9.5.5 rail. It
binds the current DACS v0.1 route—ETH Sepolia to Polygon Amoy, USDC,
unidirectional—and refuses silent substitution to HTLC or any other mechanism.
A lock whose bridge reads contradict it expires at its deadline like any other,
once the bridge reports the contradiction after the deadline, and is
reported apart; it does not conform to §9.5.5 or ST-8 only while the bridge
reports the operation still live, pending without a lock or under another lock
inside its own window, or while every contradicting read is stamped at or
before the deadline or no later than the lock's checkpoint (see
[Contradicted locks](#contradicted-locks)).

**It is a core, not a phase handler.** It drives one phase's bridge operation
to a progress result. It does not build, anchor or supersede
`SettlementEvidence`, return a `PhaseHandlerResult`, or retry an anchor (DACS-4
PC-2, PC-3 and PC-7, and the interim and `:resolved` records of ST-8). A host
phase handler does that around it (see [Host duties](#host-duties) and
[Mapping progress to DACS results](#mapping-progress-to-dacs-results)); until
one exists, the core alone does not conform to §9.5.5.

**Execution is currently limited to explicit development/test mode.** Outside
`NODE_ENV=development` or `NODE_ENV=test`, even the bundled durable store,
source-finality wrapper and authority resolver cannot enable execution. The
core returns `indeterminate / liquidity-tank-production-integration-unavailable`
before claiming a phase or invoking preparation. No reviewed local-only Demos
signer, signed-intent decoder or authenticated destination-release verifier is
shipped. Host callbacks and a finalized source receipt alone do not establish
those guarantees. The examples below are development/test integration contracts.

The core:

- validates the exact stablecoin-cross-chain / cross-chain / liquidity-tank
  authority, the fixed route and a distinct tank pair, and checks that the
  SR-5 binding, rail descriptor and agreement hashes are 32-byte hex. It does
  not resolve or compare those hashes, or check the tank pair against the
  pinned rail's `liquidityTankIds`: the host must (see
  [Host duties](#host-duties));
- binds both addresses, the fixed route's exact six-decimal USDC conversion,
  amount, agreement, rail, job and phase before effects;
- requires the complete signed native-bridge transaction to be prepared and
  durably stored before broadcast;
- generation-fences preparation, exact-byte broadcast and authenticated status
  reads across worker takeover;
- reconciles the same `bridgeId` and operation hash before every
  rebroadcast. A bridge ID is 1 to 128 characters from `[A-Za-z0-9_-]`:
  §9.5.5's prose calls it a 16-character hash, but the pinned Standard's
  `txref-liquidity-tank` vector uses `"tank-308"` and the Demos native-bridge
  branches derive `bridge_` plus 16 or 64 hex characters, so the core accepts
  all of them and only ever compares the ID exactly;
- refuses to run without the host's two checks: it uses a bridge observation
  only when the host's `authenticateObservation` returns `true`, and
  broadcasts signed bytes only when `verifySignedSubmission` returns `true`;
  during a verifier outage it acts on nothing it could not check (see
  [Host verifier](#host-verifier));
- accepts only `empty -> pending -> completed` history;
- returns success only when both source lock and destination release hashes are
  present;
- treats capacity exhaustion as transient on the same pinned tank rail; and
- persists locked-unreleased state as ST-8 `tank-locked-unreleased`, resolving
  forward to success or reputation-neutral `failed-substrate` at the recovery
  deadline, a contradicted lock included (see
  [Contradicted locks](#contradicted-locks)). `recoveryDeadline` is an exact Unix-millisecond timestamp throughout
  pending and completed adapter observations, durable checkpoints, settlement
  replay records, progress and transaction evidence;
  seconds-scale values are not converted or heuristically reinterpreted (see
  [Timestamp units](#timestamp-units)). A completion is timely when
  `finalityObservedAt <= recoveryDeadline`: a release final at the deadline
  millisecond is "within" it (DACS-4 §9.5.5), and the window "passes" (DACS-5
  ST-8) only after it. So every expiry check below, on a bridge time or on the
  host clock, needs a time strictly after `recoveryDeadline`. Expiry needs
  authenticated evidence; see below.

**Durable restart tests use the bundled filesystem store.** Every no-double-send and completion-versus-expiry guarantee
holds only with a store that keeps every row across process restarts, commits
each write atomically and passes `runLiquidityTankStoreConformance` (see
[Store conformance](#store-conformance)). The core cannot tell a lost row from
a fresh phase, so it refuses, before any claim, preparation or signature, a
store that does not declare `restartSafety` (see
[Declaring restart safety](#declaring-restart-safety)). The SDK ships one
durable store, `createFsLiquidityTankStore` for a single host (see
[Durable filesystem store](#durable-filesystem-store)); it passes conformance
in the SDK's tests and declares `"conformance-tested"`. The exported in-memory
store loses everything on restart, refuses to construct without
`{ acknowledgeVolatile: true }`, and declares itself `"volatile-acknowledged"`.
It is for tests and development only: the core permits it only with an explicit
`NODE_ENV=development` or `NODE_ENV=test`. An unset, empty, unknown or unreadable
environment is refused before any claim. Outside explicit development/test mode,
the core additionally requires the exact frozen handle created by
`createFsLiquidityTankStore`. A custom store, copied handle or self-declared
`"conformance-tested"` string cannot grant production execution. The same modes
require the exact `createLiquidityTankEvmFinalityVerifier` wrapper and a trusted
`resolveAuthority` callback, then refuse execution because no reviewed production
integration is shipped. Test/development mode permits injected stores and
verifiers for contract tests; setting that mode is not a production deployment
procedure.

**A shared tank's balance comes from the bridge, not the core.** The core
checks one operation at a time. That the bridge never locks more than a tank's
capacity across concurrent phases is a launch requirement on the bridge, which
the SDK does not check (see [Tank balance](#tank-balance-is-the-bridges)).

```ts
import {
  advanceLiquidityTankSettlement,
  createLiquidityTankEvmFinalityVerifier,
  type LiquidityTankAdapter,
  type LiquidityTankStore,
  type LiquidityTankVerifier,
} from "@kynesyslabs/dacs/rails";

const result = await advanceLiquidityTankSettlement({
  authority,
  owner: workerId,
  adapter: nativeBridgeAdapter satisfies LiquidityTankAdapter,
  // The exact handle returned by createFsLiquidityTankStore({ dir }).
  store: durableStore satisfies LiquidityTankStore,
  // Independently resolve/authenticate the pinned artifacts; never echo input.
  resolveAuthority: async (intent) => ({
    authority: await resolveAuthorizedPayment(intent),
    rail: await resolveAuthenticatedRail(intent.railDescriptorHash),
  }),
  verifier: createLiquidityTankEvmFinalityVerifier({
    verifier: hostVerifier satisfies LiquidityTankVerifier,
    sourceRpcUrl: trustedSepoliaRpcUrl,
  }),
});
```

`prepareSubmission` must build and sign the bridge transaction locally and
send no signed bytes. Reads it needs to sign, such as the nonce, fee and
network parameters, are allowed. **It must not use the Demos SDK's `"manual"`
confirmation path**: in demosdk 4.0.16, `"manual"` means build, sign *and
confirm*, and `confirm` sends the full signed transaction to the node as
`confirmTx` (`build/websdk/DemosTransactions.js:231`) before anything is
stored. **demosdk 4.0.16 has no signing path for this route that works.**
`NativeBridgeMethods.generateOperationTx` sets `to` to the EVM
`originAddress` and `from_ed25519_address` to the Demos address
(`build/bridge/nativeBridge.js:68-69`), and then calls `demos.sign`. But
`sign` refuses a `nativeBridge` transaction unless those two addresses are
equal (`build/websdk/demosclass.js:657`), and unless `to` is `0x` plus 64 hex
characters (`:683`). So signing fails for every EVM origin address. It fails
closed, before any bytes exist, but no adapter can be built on it until the
SDK's address handling and this route are aligned (see
[Open before any live adapter is wired](#open-before-any-live-adapter-is-wired)).
Whatever signer is used, `prepareSubmission` returns the signed bytes, and the
store commits those exact bytes first. `broadcastRetained`
then does every network step for that retained transaction, `confirm` and
`broadcast` included, and may repeat only those steps for those bytes, so an
ambiguous response never authorizes a new nonce or bridge operation. Whether
the node accepts a later `confirm` of the same signed bytes, and for how long
(see [Open before any live adapter is wired](#open-before-any-live-adapter-is-wired)),
is unverified. The core binds the intent it passes
to `prepareSubmission` and checks the returned authority, operation hash and
bridge ID. It does not decode `signedSubmissionBase64` itself: the host's
`verifySignedSubmission` must, before the bytes are stored or broadcast.

**Adapter contract for the signing window.** `prepareSubmission` must not
broadcast, log, cache for later sending or otherwise reveal the signed bytes
before `recordSubmission` commits them. If the worker stops after signing but
before that write commits, the next owner finds no retained submission and
signs a fresh one; the first bytes must never reach the bridge, or the buyer
pays twice. This is an adapter-review requirement, not a guarantee of the
core: the core can neither enforce nor detect it, and its tests show the safe
outcome only for an adapter that keeps it. Review every live adapter for it,
with a test against that adapter showing `prepareSubmission` neither
broadcasts nor keeps the bytes for later sending. Until such an integration is
reviewed and shipped, the production execution gate refuses every adapter.

The retained submission hash and bytes are validated before any adapter effect
or store write. Corrupted retained state returns the retry-safe indeterminate
reason `liquidity-tank-retained-state-corrupt`; operators must restore the exact
authenticated row rather than preparing or broadcasting a replacement.
For acquired claims, optional retained fields are distinguished by own-property
presence: a present malformed or falsey submission/observation is corruption,
while only a genuinely absent submission authorizes fresh preparation.

An expiry replay that observes an authenticated completion for another lock or
deadline atomically retains it as `completion` beside the original expiry. It
preserves the original lock and failure classification and returns the release
evidence separately. A failed or uncertain write returns `indeterminate`; a
later restart reauthenticates both snapshots before returning the retained
release, even if the bridge read is unavailable. EVM transaction hashes compare
by their 32-byte identity while the authenticated snapshots retain their exact
spelling.

Recovery expiry needs authenticated evidence bound to the exact checkpoint:

- a locked pending snapshot with `observedAt > recoveryDeadline`;
- a terminal `failed` with either `empty -> pending -> failed` or
  `empty -> failed` history, whose authenticated `lockTxHash` and
  `recoveryDeadline` match the durable lock, or which carries them itself
  when no checkpoint was stored, and whose snapshot has
  `observedAt > recoveryDeadline`;
- a read that contradicts the durable checkpoint, observed strictly after it
  (its `observedAt` later than the checkpoint's) and after the deadline
  (its `observedAt > recoveryDeadline`): an `empty`, a
  `capacity-unavailable`, a `failed` not bound to the lock, a completion of
  another lock, or a `pending` of another lock observed after that lock's own
  deadline; never a `pending` that leaves the operation live (see
  [Contradicted locks](#contradicted-locks)); or
- a completion with `finalityObservedAt > recoveryDeadline`.

For pending snapshots, failures and contradictions alike, `observedAt` is the time the
bridge snapshot describes, not the time the adapter served it. A cached
pre-deadline snapshot is insufficient, even when requested after the deadline.
There is no clock-skew allowance: both the snapshot and the host clock must
pass the deadline, so a host clock running ahead of the bridge's never
expires a lock early on either. A contradiction's `observedAt` must also be
later than the checkpoint's, so a cached read from before the lock never
counts (see [Contradicted locks](#contradicted-locks)).

The core retains the first authenticated failure immediately as
`failed-after-lock` evidence, including the exact checkpoint, bridge ID,
operation hash, lock hash, deadline and history. Before the deadline it reports
`bridgeStatus: "failed"`. Expiry additionally needs a failure snapshot that the
bridge authenticated strictly after the deadline and a host clock past it.
Retained pre-deadline failure evidence, an outage or a fast host clock alone
keeps the lock open. A fresh post-deadline failure may reconcile the same lock
without overwriting the first retained failure. A timely completion wins; a
failed completion write never triggers expiry in that call.

**A failure that carries its lock is never `permanent`.** If no checkpoint was
stored, for example because the worker stopped or its checkpoint write failed
after the bridge reported the lock, a `failed` observation that itself carries
`lockTxHash` and `recoveryDeadline` is handled the same way: it is stored as
the durable observation, reports the lock's `settle-asymmetric` progress with
`bridgeStatus: "failed"` (also through a bridge-read or verifier outage), and
expires to reputation-neutral `failed-substrate` only when both a bridge
snapshot and the host clock pass the deadline. A timely completion of the same lock settles,
and a late one commits the late release. So crash timing no longer changes
the class of a post-lock failure. Only a failure without a lock (`empty ->
failed`, or `empty -> pending -> failed` without `lockTxHash`) is `permanent`.

DACS-4 §9.5.5 lists a `failed` status after a committed lock under two
overlapping bullets: as `permanent`, and as the asymmetric source lock. The
SDK reads them through DACS-5 ST-8, which says a committed tank lock whose
recovery path is still open "is not a terminal failure" and is watched until
`recoveryDeadline`. Reporting `permanent` while the lock can still release
would let a host pay the phase a second time. A vector pins this reading; the
Standard-side clarification is
[DACS-Standard#422](https://github.com/DACS-Agent-commerce/DACS-Standard/issues/422).

Without retained terminal evidence, the lock remains open when the status is
unavailable, an observation write fails, or a pending snapshot is stale.

**A late release is reported apart.** When the expiry evidence is a
completion with `finalityObservedAt > recoveryDeadline`, the core still
commits reputation-neutral `failed-substrate`, as §9.5.5 requires, but returns
the reason `tank-released-after-recovery-deadline` instead of
`tank-locked-unreleased-recovery-expired`. That result carries `txRef`
(bridge ID, chains, `lockTxHash`, `releaseTxHash`, `recoveryDeadline`) and
`finalityObservedAt` from the authenticated completion, and every later claim
on the committed expiry returns the same. The release reached the payee, so
the buyer has paid: do not authorize another payment for the phase, and
reconcile from that evidence. Expiries committed from other evidence are
reconciled with a read-only bridge observation on replay. A subsequently proven
timely completion of the exact same lock corrects the exact retained expiry
atomically through `reconcileRecoveryExpired`; it never prepares or broadcasts
another submission. A late completion of that lock enriches the expiry with
the release evidence in the same atomic operation, preserving
`failed-substrate` across restarts. A failed reconciliation returns indeterminate. Existing expiry
is preserved if no correcting completion is proven. Never pay the phase again
on an expiry result without reconciling its bridge record.

**A pending operation without a lock is bounded too.** An authenticated
`pending` with no `lockTxHash` returns `waiting` `liquidity-tank-pending` with
`pendingDeadline`: the submission's receipt (`submissionRecordedAt`, the host
clock reading kept with the retained submission) plus `pendingLockDeadlineMs`,
an optional input that defaults to 10 minutes. `pastDeadline` is `true` once
this call's host clock reaches it. The core does not expire such an operation,
since the bridge may still lock it, but a bridge that accepts an operation and
never locks it now shows up as overdue instead of parking the phase
silently. Once that pending is durable, a later read the store refuses (such
as an authenticated `empty`, a regression it does not commit) or a failed
observation write returns the same `waiting` `liquidity-tank-pending` with its
`pendingDeadline` and `pastDeadline`, not a transient reason.
Bridge-read and verifier outages retain their retryable reason and also carry
the durable unlocked pending's `pendingDeadline` and `pastDeadline`.

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
- **No bridge time on the operation may fall more than one minute before
  `preparedAt`,** the same allowance for clock skew between the adapter and
  the bridge: not a `recoveryDeadline` (`liquidity-tank-recovery-deadline-before-preparation`),
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
passes the deadline a timely release is expired as `failed-substrate`. A
retained `preparedAt` is only as well bound as its receipt: a store that
stamps the receipt from its own clock, in its own unit, breaks the check, and
store conformance refuses one that does. A bundled filesystem settled claim
retains the submission and receipt time. Replay checks its `preparedAt`,
verifies the signed submission, and authenticates a fresh completion before
returning the stored settlement.

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
returns (or resolves to) a `LiquidityTankVerifierAnswer`:

- **`true`** accepts: the core may use the value.
- **`"unavailable"`** says the hook could not decide now, for example because
  its pinned key, attestation service or decoder is down or timed out. **A
  throw counts as `"unavailable"`.** This is an outage, not a refusal (see
  [Verifier outage](#verifier-outage)).
- **Anything else**, `false` included, refuses: the value is not used.

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
  expires, records anything or broadcasts. **It is also the ST-8 finality
  gate:** the core enters `settle-asymmetric` on any accepted observation
  that carries `lockTxHash`, and cannot tell whether that source lock is
  final. The production entry point requires the SDK finality wrapper;
  the underlying hook remains responsible for bridge authentication. ST-8 forbids entering the asymmetric state before then.
- **`verifySignedSubmission({ intent, submission })`** decodes
  `signedSubmissionBase64` and confirms it signs exactly the intent: the source
  amount in base units, origin and destination addresses, asset, tank pair and
  the submission's `bridgeId`, and that `substrateTxHash` is recomputed from
  those bytes. It runs on a freshly prepared submission before
  `recordSubmission`, and on a retained submission before the core observes
  against it, settles from it or rebroadcasts it. A refusal returns
  `liquidity-tank-signed-submission-unverified`; refused fresh bytes are
  neither stored nor broadcast, and refused retained bytes are never
  broadcast.

A missing verifier or method, or one that is not a stable function, is refused
before any claim with `liquidity-tank-observation-authenticator-unavailable` or
`liquidity-tank-submission-verifier-unavailable`. The core never falls back to
trusting the adapter.

### Ethereum source-finality verifier

`createLiquidityTankEvmFinalityVerifier` supplies the source-lock finality gate
for the supported Sepolia route. Its contract version is
`LIQUIDITY_TANK_EVM_FINALITY_VERSION = "ethereum-finalized-receipt-v1"`, using
JSON-RPC 2.0 and the Ethereum Execution APIs
[**v1.0.0-beta.7** at `5aebdfdd45cadeb723be4bd45b4611b71c8b1c85`](https://github.com/ethereum/execution-apis/tree/5aebdfdd45cadeb723be4bd45b4611b71c8b1c85)
methods
[`eth_getTransactionReceipt`](https://ethereum.github.io/execution-apis/api/methods/eth_getTransactionReceipt/)
and [`eth_getBlockByNumber`](https://ethereum.github.io/execution-apis/api/methods/eth_getBlockByNumber/).
The receipt's `status` must be `0x1`, its transaction hash must equal the
authenticated observation's `lockTxHash`, and its block must be canonical,
contain that transaction and be at or below the node's `finalized` head.
`latest`, `safe`, inclusion and a count of confirmations never substitute for
the `finalized` tag. `eth_chainId` must return Sepolia's `0xaa36a7`.

The host pins `sourceRpcUrl` to a **trusted execution RPC using HTTPS**. Native
fetch validates TLS; redirects, URL userinfo and fragments are refused. The
optional `fetch` is a trusted transport override. This uses the configured
node's authenticated chain view, not an independently verified light-client
proof. A dishonest node can lie about finality. The host must select and review
that trust dependency along with the bridge's trust model.

The wrapper first calls the supplied bridge authenticator, which still must
bind the exact operation, source lock, amount, asset and tank pair. It then
checks source finality for **every lock-bearing observation**, including
failures, completions and retained recovery evidence. A receipt above the
finalized head returns `"pending-finality"`: core progress is `waiting`, reason
`liquidity-tank-source-finality-pending`, with the submission's existing
`pendingDeadline` and `pastDeadline`. Unsupported finality tags, wrong networks,
missing or inconsistent block data, RPC errors and outages return `"unavailable"`. A reverted transaction
or receipt for another transaction refuses the bridge claim. A malformed
bridge lock hash is also refused before any RPC request. No observation,
expiry or settlement write is authorized by unavailable proof. A retained
lock continues to be reported during an outage without authorizing effects.
The four read requests share a `timeoutMs` deadline (default 10 seconds;
allowed 1–30,000 ms), including header and body reads when a transport ignores
abort. Responses are limited to 2 MiB before JSON decoding, and canonical block
transaction lists to 20,000 entries. The exported finality version is
informational metadata; it does not alter the intent or settlement hash.
Signed-submission decoding is delegated unchanged to the
supplied verifier. The RPC receives no signed bytes and submits no transaction.

This adapter supplies source finality independently of the Demos bridge DTO.
It does **not** supply the bridge's authenticated status record, local signing,
release finality or funded integration. Those live-adapter requirements below
still apply; an authenticator that simply returns `true` cannot establish them.

**Production success replay is rechecked.** A settled claim carries the
retained submission and its original receipt. The core validates their exact
bytes and binding, reads the current authenticated bridge completion and checks
source finality through the mandatory wrapper before returning stored success.
The fresh completion must reproduce the saved transaction references, payment
amount and decisive finality time. Its snapshot time and authentication hash
may change; the stored settlement and its original authentication hash remain
unchanged. An outage or mismatch
returns indeterminate and never prepares or broadcasts a replacement. Explicit
test/development mode checks stored settlement shape and bindings without a
network read, so deterministic store tests can inject their own evidence.

**Each hook needs its own bounded deadline.** The core sets no timeout on a
verifier or adapter call, so a hook that never settles hangs that
`advanceLiquidityTankSettlement` call. Another owner can take the phase over
once the lease expires, and the stalled call, if it resumes, stores and
broadcasts nothing without a current lease. A hook that runs out of time
should return `"unavailable"` or throw; the core treats either as an outage.
Return `false` only for a value the hook checked and refused. A value the hook
cannot decode is such a refusal: return `false` for it rather than throwing,
or the phase stays parked under `liquidity-tank-verifier-unavailable`. Keep each
deadline well under a minute: fresh bytes whose check outlasts the one-minute
preparation window are not stored (see [Timestamp units](#timestamp-units)).

### Verifier outage

An outage (`"unavailable"` or a throw) never authorizes anything: the core does
not observe against, store an observation from, broadcast, settle or expire on
a value it could not check. What it returns instead:

- **A retained row it could not check** (the retained bytes, the durable
  observation or retained failure evidence): it still checks every retained
  row, and a refusal of any of them wins (`…-unverified` or
  `…-unauthenticated`). Otherwise, if the row holds a durable lock, it reports
  that lock's `settle-asymmetric` progress from the stored checkpoint, with
  `pastDeadline` against this call's clock reading, so an overdue lock keeps
  alerting through the outage. Without a lock it returns the retryable
  `liquidity-tank-verifier-unavailable`, retaining an unlocked pending's
  `pendingDeadline` and `pastDeadline` when present. It does not read the bridge.
- **A fresh observation it could not check**: as for an unavailable bridge
  read, the durable lock's progress (or expiry from retained terminal
  evidence that was checked), or else `liquidity-tank-verifier-unavailable`.
- **A committed expiry whose evidence it could not check**:
  `liquidity-tank-verifier-unavailable`, until the evidence is checked.
- **Freshly signed bytes it could not check**: the core stores them with
  `recordSubmission`, does not broadcast them, and returns
  `liquidity-tank-verifier-unavailable`. Each retry claims the phase, finds
  those bytes retained and checks them again, so no retry signs a new
  transaction. They are broadcast only after a later check accepts them. If a
  later check refuses them, the phase keeps them unbroadcast and returns
  `liquidity-tank-signed-submission-unverified` on every call (an operator
  resolves it). This cannot broadcast twice: the store keeps one submission
  per phase and refuses another, only those retained bytes are ever
  broadcast, and nothing is broadcast before a check accepts them.

## Contradicted locks

An authenticated `empty`, `capacity-unavailable`, a `pending` without the
lock or with another lock or deadline, a `failed` not bound to the exact lock,
or a completion of another lock contradicts a durable lock. Such a read may
come from a lagging replica while locked funds can still move, so it never
settles the phase or replaces the checkpoint. Before the deadline it returns
the lock's progress with `bridgeStatus: "conflicting"`.

**A contradiction the bridge reports after the deadline expires the lock,
reported apart.** Once this host's clock has passed `recoveryDeadline`, a
contradiction whose `observedAt` is later than the checkpoint's and later
than `recoveryDeadline` commits reputation-neutral `failed-substrate`, as
§9.5.5 and ST-8 require, with the reason
`tank-lock-contradicted-recovery-expired`. That is a terminal `failed`
(`errorClass: "failed-substrate"`, `reputationNeutral: true`) that every later
claim replays; its evidence (the checkpoint and the contradicting read) is
authenticated again, and both the host clock and the read's time checked
again, on every replay. Retained failure evidence for the lock outranks a
contradiction and expires the lock as `tank-locked-unreleased-recovery-expired`.

**A read at or before the deadline, or no later than the checkpoint, never
expires the lock.** A contradiction whose `observedAt` is at or before
`recoveryDeadline` describes the bridge inside the window, and the lock may
still be released between that read and the deadline: for example an `empty`
stamped two minutes
before it, read by a host whose clock runs two minutes ahead of the bridge's,
while the release lands thirty seconds before the deadline. One whose
`observedAt` is at or before the checkpoint's (the last locked `pending` of
the same lock and deadline that the store recorded) may describe the bridge
before the lock (a cached snapshot, for example an `empty` from before the
lock was taken). Neither says whether the lock was released in time, and this
host's clock does not stand in for the bridge's. However far the host clock is
past the deadline, such a read keeps the lock open with `lock-contradicted`,
`bridgeStatus: "conflicting"` and `pastDeadline: true`, writes nothing, and
never starts a new payment or broadcast; each later call reads the bridge
again, so the lock's timely completion still settles the phase, and a
contradiction stamped after the deadline still expires it. The core's check,
the store's `recordRecoveryExpired` and the claim replay all apply this rule,
so a replayed expiry whose contradiction is not after the deadline or not
later than its checkpoint is refused as `liquidity-tank-retained-state-corrupt`.

**A live pending never expires the lock.** The one exception is a `pending`
that leaves the operation live: one without a lock, since the bridge may
still lock it, or one under another lock whose authenticated `observedAt` is
at or before that lock's own `recoveryDeadline`, since that lock can still be
released. Past the deadline it keeps the lock open with the distinct reason
`lock-contradicted`, `bridgeStatus: "conflicting"` and `pastDeadline: true`.
A `pending` of another lock observed after that lock's own deadline is no
longer live, and expires the lock like any other contradiction stamped after
the deadline. A contradiction latches nothing: a later read that
carries expiry evidence, or a timely completion of the lock, resolves the
phase as usual.

`lock-contradicted` is `settle-asymmetric`, not a failure: the checkpoint's
lock may still hold the buyer's funds or release them to the payee, so do not
authorize another payment for the phase while it is reported. The core
returns no terminal result for such a lock until the bridge's own reads
decide it.

The bridge contradicted its own record, so a release may still have landed.
Do not authorize another payment for the phase on
`tank-lock-contradicted-recovery-expired` either: read the bridge's record for
the retained `bridgeId` first, and send it to an operator. When the
contradicting read was a completion of another lock, the result also carries
that completion's `txRef` (bridge ID, chains, its `lockTxHash`,
`releaseTxHash` and `recoveryDeadline`) and `finalityObservedAt`. The bridge
reports that this release reached the payee: treat it like
`tank-released-after-recovery-deadline` and reconcile from it. A lock whose
release landed before the deadline can still expire this way only if the
bridge, in a read stamped after the deadline and after the checkpoint,
reports a status that contradicts that release: a bridge fault, a reorg of
the lock transaction, or an adapter that stamps the time it served a cached
snapshot instead of the time the snapshot describes. A host clock running
ahead of the bridge's cannot cause it. Replay reads the bridge again and a
proven timely completion of the original lock can correct the expiry atomically.

**What still deviates from DACS-4.** §9.5.5 bounds the `settle-asymmetric`
state by `recoveryDeadline`; SR-5 (§9.8) requires both legs to succeed
together or never take effect within a bounded time. While the bridge keeps
reporting the operation live, pending without a lock or under another lock
that no read has yet shown past its own deadline, or keeps serving only
contradictions stamped at or before the deadline or no later than the
checkpoint, this rail keeps the lock open past its deadline, so for those
cases it does not conform to §9.5.5 or ST-8. A bridge or replica that never
serves a read stamped after the deadline therefore keeps the phase open until an
operator resolves it from the bridge's record. Hosts must treat
`lock-contradicted` as a readiness failure that needs an operator, not as
ordinary waiting. The SDK has no runtime rail-readiness
surface consuming these progress results; its conformance tests and
settlement-evidence validators check artifact/evidence shapes separately.
Hosts should alert on any progress with `pastDeadline: true` that persists
beyond normal bridge lag: ordinary locked progress past its
`recoveryDeadline`, and `waiting` `liquidity-tank-pending` past its
`pendingDeadline` (an operation the bridge accepted but has not locked). Send
contradictions to an operator immediately.

## Mapping progress to DACS results

The progress vocabulary is the core's, not DACS's. `errorClass:
"failed-substrate"` is not a DACS-4 PC-4 `errorClass`, and the three expiry
reasons are not evidence reasons: DACS-5 SEB-3 admits an expired tank record
only with `errorClass: "substrate"` and the interim reason
`tank-locked-unreleased`, and ST-8(b) records the bundle cause
`failed-substrate`. Do not copy `errorClass` or `reason` into a phase result
or evidence. `liquidityTankPhaseOutcome(progress)` returns the mapping, and
the SDK's tests pin it:

| Progress | Phase handler records |
|---|---|
| `settled` | `ok: true`; success evidence with the settlement's `txRef` (both hashes), `paymentAmount` and `settlementFinality`, superseding any interim record at the `:resolved` address |
| `settle-asymmetric` (`tank-locked-unreleased` or `lock-contradicted`) | the interim failure evidence, reason `tank-locked-unreleased`, with the progress `txRef` (`lockTxHash` and `recoveryDeadline`, no `releaseTxHash`) as `interimTxRef`; the session is `settle-asymmetric` |
| `failed`, `errorClass: "failed-substrate"` (any of its three reasons) | `ok: false`, `errorClass: "substrate"`; bundle cause `failed-substrate`. The interim record, reason `tank-locked-unreleased`, must stand at the PC-2 address with the progress `lockTxRef` as `interimTxRef`. An expiry can be the first result a host sees (a first read past the deadline, or a lost `settle-asymmetric` result), so anchor the interim record from `interimTxRef` if the phase has not anchored it yet; it is write-once. Keep the core's reason only as host metadata |
| `failed`, `errorClass: "failed-substrate"` with `txRef` (a release reached the payee after the deadline) | as above, and the outcome's `release` carries the release `txRef` (both hashes) and `finalityObservedAt`: the buyer has paid, so never authorize another payment for the phase, and reconcile from `release` |
| `failed`, `errorClass: "permanent"` | `ok: false`, `errorClass: "permanent"`. Its `reason` is the bridge's own failure text, passed through unprefixed: host metadata only, never a core reason |
| `waiting`, `indeterminate` | no phase result yet: retry, or escalate by reason (see [Reasons that need an operator](#reasons-that-need-an-operator)). A host that gives up on `liquidity-tank-capacity-unavailable` fails the phase `transient` on the same rail, never another mechanism |

`liquidityTankPhaseOutcome` throws a `DacsError` for a `failed-substrate`
progress without `lockTxRef`, or with `txRef` but no `finalityObservedAt`:
the core never returns one, and no admissible interim record can be built
from it.

## Host duties

The core cannot do these, and §9.5.5 needs each of them. Each is part of
reviewing the host phase handler:

- **Evidence and anchoring** (PC-2, PC-3, PC-7, ST-8): build, anchor and
  supersede `SettlementEvidence` as mapped above, return the
  `PhaseHandlerResult`, and keep a durable, idempotent anchor retry. A retry
  calls the core again, which never signs a second submission. Before
  recording an expiry, make sure the interim record is anchored, from the
  expiry's `lockTxRef` when no earlier `settle-asymmetric` result anchored it.
- **Authenticated authority resolution** (§9.5.5 steps 1–2, §9.13): supply
  `resolveAuthority(intent)`, which independently resolves and authenticates the
  pinned descriptor, agreement and SR-5 binding, returning `{ authority, rail }`
  or `"unavailable"`. The core compares the complete authorized intent, including
  hashes, amount and destination; it checks the descriptor's rail ID/type,
  handler, asset/network/mechanism, canonical currency and fixed route, and
  requires both distinct selected tank IDs in that route's authorized IDs.
  Numeric and decimal-string chain IDs are supported; additional authorized
  tank IDs are allowed. Return authenticated resolved data, never an echo of
  unverified input. This callback is mandatory outside development/test mode
  and must honor the same bounded-deadline contract as host adapter/verifier hooks.
- **Destination semantics** (PB-1/PB-2): for a payee-bound agreement, the
  resolver must select the exact `(railId, phaseIndex)` payout binding and
  verify its destination identity using the strongest applicable tier. Legacy
  and identity-bound agreements retain their Standard-defined destination
  semantics; do not impose payee-bound requirements on them.
- **`railId` grammar** (§9.4.1): reconcile the lowercase-ASCII prose with the
  pinned registry's `cross-chain-liquidity-tank:USDC` ID. The core retains the
  authenticated ID exactly apart from its existing NFC handling.
- **Source-lock finality** (ST-8): production requires the exact immutable
  `createLiquidityTankEvmFinalityVerifier` wrapper and a trusted Sepolia RPC.
- **Trust model** (§9.5.5): evaluate recipes that use this rail against the
  substrate's security profile.

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
the acquired claim or confirmed write, with a current lease and host `now`
after the deadline. For `failed-after-lock`, the checkpoint must equal the
durable one and failure evidence must bind the same lock and operation, with
`observedAt > recoveryDeadline`. It can be a fresh authenticated snapshot
postdating the first retained failure; the original retained failure stays
unchanged. A `failed` that carries its own lock and deadline is
evidence only when it is exactly the durable observation and no failure is
retained beside a checkpoint. `contradicted-after-lock` evidence
(`{ checkpoint, contradiction }`) needs its checkpoint to equal the durable
one, no retained failure, and a contradiction that neither preserves nor fails
the lock (a completion of another lock is one), whose `observedAt` is
strictly later than the checkpoint's and after the deadline, and which is
not a `pending` that leaves the operation live: without a lock, or with
another lock and an `observedAt` at or before that lock's own deadline. Both
the contradiction's own `observedAt` and the host `now` must be after the
deadline.
Pending expiry still re-checks snapshot freshness, and completed expiry still
re-checks late finality. A completed
observation carries its authenticated deadline even without a prior
checkpoint; with a checkpoint, or a durable failure that carries a lock, its
lock and deadline must match exactly.

Completion persistence and recovery expiry race atomically. Persisting a timely
completion clears retained failure evidence and blocks expiry, even before its
settlement is written: refuse any expiry once a completed observation is
durable. `recordObservation` must accept a timely completion of the same lock
and deadline in place of a durable `failed` that carries them, and refuse any
other observation after it. Whichever
eligible terminal transition commits first wins; the loser must report a
non-successful write. Once expiry commits, claims return `recovery-expired`.
Continue read-only reconciliation through the core before treating this as a
final unpaid disposition or considering another payment. An authenticated
completion of the same lock and deadline that was final within the window
atomically corrects the expiry to `settled`, even when discovered later. A late
completion keeps the reputation-neutral `failed-substrate` classification and
durably adds its release transaction and finality time to the expiry result.
Neither path prepares or broadcasts another submission. A replayed `failed-after-lock` expiry carries no time of
its own, so a worker whose clock has not passed the deadline reports the
retry-safe `liquidity-tank-recovery-expiry-not-due` instead. A host clock that
steps back across the deadline can briefly report that retry-safe result again;
keep reconciling the retained operation rather than submitting a replacement.

A timely durable completed observation is also a settlement replay record. On worker
takeover the coordinator deterministically reconstructs and records its
settlement, including its exact `recoveryDeadline`, before any adapter
observation, preparation or broadcast. Stores must accept an exact replay as
`existing` and reject conflicting settlement writes.

## Store conformance

`runLiquidityTankStoreConformance({ createStore, reopenStore })` runs the store
contract against any `LiquidityTankStore` and returns one result per case.
Run it in a dedicated process with `NODE_ENV=test` (or `development`), for
example `NODE_ENV=test node conformance.mjs`. Its model bridge and wrapped
stores are test fixtures; they do not carry production capabilities. Other
environments are rejected before any store is opened, with an actionable
`TypeError`. The helper never changes the process environment or production
execution policy.
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
completion-versus-expiry election in both orders, failure retention, a
timely completion replacing a durable failure that carries its lock, a
failure that carries its lock as expiry evidence only when it is the durable
observation, a late completion as expiry evidence only for the durable
checkpoint's or failure's lock and deadline, the contradiction-expiry
compare-and-set (refused at or before the
deadline, at or before the checkpoint, on a live pending or beside retained
failure evidence), settlement replay, and state that survives `reopenStore`, including the
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

The two cases that drive the core hand it the store under test with
`restartSafety: "conformance-tested"` added, so a host can run the suite
before its store declares anything.

### Declaring restart safety

`LiquidityTankStore.restartSafety` is the store's declaration of how it
survives a restart. `advanceLiquidityTankSettlement` reads it as a data
property (own or inherited, never a getter) right after binding the store's
methods. Unless it is exactly one of these two strings, the core returns
`indeterminate` `liquidity-tank-store-restart-safety-undeclared` before any
claim, preparation, signature, observation or broadcast:

- **`"conformance-tested"`**: the store is durable and atomic and passes every
  `runLiquidityTankStoreConformance` case against its real backend. The SDK
  filesystem store declares this; custom declarations only run in development/test.
- **`"volatile-acknowledged"`**: the store loses every row on restart, and its
  caller has said so. `createInMemoryLiquidityTankStore({ acknowledgeVolatile:
  true })` sets it. For tests and development only, never production: the
  core runs end to end on it, and after a restart signs a second bridge
  operation. Unless `process.env.NODE_ENV` is exactly `"development"` or
  `"test"`, the core refuses it before any claim with
  `indeterminate` `liquidity-tank-store-volatile-in-production`. That is a
  backstop for a mis-wired production process, not a check of the store: the
  core cannot tell production from development any other way.

The field is optional in the TypeScript type so a store under development
can run conformance, but the core refuses a store without it. Outside explicit
`development`/`test` mode, only the exact immutable SDK-created filesystem store
is registered for production use. Other handles return
`liquidity-tank-store-untrusted` before any claim. Running conformance does not
register an arbitrary host store for production; database registration requires
a separate reviewed integration. Even the bundled handle currently returns
`liquidity-tank-production-integration-unavailable` after the configuration
checks: execution requires explicit development/test mode.

### Durable filesystem store

`await createFsLiquidityTankStore({ dir })` keeps each phase as one JSON row
under `dir`, for workers on one host. It applies the same row transitions as
the in-memory reference store, so its compare-and-set checks read exactly the
same fields, and runs each one under a per-phase filesystem lock:

- **Atomic writes.** Every row write goes to a new `O_EXCL` temporary, which
  is fsynced and renamed over the row; then the directory is fsynced. All of
  this happens before the write reports success. A reader sees the old row or
  the new one, never half of one.
- **Restart.** A new store on the same directory, in the same process or
  another, reads every committed row, including each submission's receipt and
  the bridge-ID reservations.
- **Bridge IDs.** A bridge ID is reserved for one phase by a file published
  with a hard link, which never replaces an existing reservation, and before
  the row that holds the submission. A crash in between leaves the ID reserved
  for that phase and its row unchanged. Every reservation of one bridge ID is
  read and published under that bridge ID's own lock. A process killed right
  after the link leaves the reservation with a second link, its staging name;
  the next reader under that lock removes it, fsyncs the directory and accepts
  the reservation. It does so only when the second link is the store's own
  staging name for that reservation, on the same inode, and the file has
  exactly two links. Any other extra link is refused and left in place. A
  staging file that was never linked is removed. The SDK's tests kill a child
  process with SIGKILL at each step of the reservation and of the row write
  after it, then finish `recordSubmission` with the same signed bytes from a
  reopened store.
- **Locks.** Each lock records the owner's PID, its OS thread ID, the boot
  and PID namespace those belong to, a random token for its thread, a token
  of its own and its creation time on the monotonic clock. Every copy of the
  SDK on one thread shares that thread's token and its list of held locks (they
  are kept on the thread's `process` object), so module copies never take each
  other's live locks. A lock older than `lockStaleMs` is reclaimed when its
  owner cannot still hold it:
  - another PID that no longer exists;
  - one of this thread's own locks that it no longer holds;
  - this process's PID on a lock made before this process started, or after
    now (an earlier boot), such as a restarted worker that got its old PID
    back (PID 1 in a container);
  - a lock another thread of this process made, once the OS no longer lists
    that thread (`/proc/self/task/<tid>`): a worker thread that was
    terminated, or exited, while it held the lock or the reclaim gate.

  Any other lock counts as held: one whose thread is still listed (it may be
  the owner, or a later thread that reused its ID), one with this process's
  PID made during this process's lifetime but in another boot or PID
  namespace, and one whose thread could not be told, as off Linux. No wall
  clock decides liveness; it only sets the stale age. These rules hold only
  inside one host and one PID namespace (see below). A lock made by a live
  process on another host or in another PID namespace is judged by its PID
  here: once stale, it is taken when no process here has that PID, or when it
  carries this process's PID and a creation time outside this process's
  lifetime. A step that fails after a lock or the store-wide reclaim gate is
  published removes it before the call fails. A release retries a failed step
  until `lockTimeoutMs` passes; a release that still fails fails the call
  instead of returning its result. A read error on an owner file is never
  taken for a missing owner.
- **Directory admission.** The SDK's private-store checks (see
  [Durable filesystem safety](filesystem-store-safety.md)) refuse a directory
  that is group- or world-writable, owned by another user, reached through a
  symbolic link, or on a network or sync filesystem. They never `chmod` an
  unsafe directory into acceptance.
- **Corruption.** A row that is not exactly what the store writes (another
  JSON spelling, an unknown field or version, a submission whose hash does not
  recompute, an observation that fails the core's checks) reads as `corrupt`
  with `liquidity-tank-fs-record-corrupt`, and no write replaces it.

The SDK's tests run every `runLiquidityTankStoreConformance` case against it,
reopening a new store on the same directory for each restart and race, and it
declares `restartSafety: "conformance-tested"`. Its lock serializes writers on
one host only; workers on several hosts need a shared database store that
passes the suite. Every process sharing one directory must also share a PID
namespace (the same container, or all on the host): owners are told apart by
PID.

**Clearing a stuck lock.** A lock that no rule above can reclaim shows as
`liquidity-tank-settlement-store-unavailable` on every call for its phase, or
for every phase if it is the reclaim gate. This can happen when a lock's PID
now belongs to an unrelated live process, when a live worker's release kept
failing, when an exited thread's ID was reused by a live one, or off Linux,
where an exited worker thread cannot be told from a live one. To clear it:

1. Stop every process that uses the directory, so nothing holds a lock.
2. Look under `dir/locks`. A phase lock is the directory
   `<sha256 of the settlement key>.lock`; a bridge ID's lock is
   `bridge.<sha256 of the bridge ID>.lock`; the store-wide gate is the file
   `.reclaim`, with `.reclaim.*.quarantine` files beside it. Each holds or is
   an `owner.json` with the owner's `pid` and `tid`.
3. Remove what is left there, with `rm -r` on the lock directories and `rm` on
   the gate files. With every process stopped, no lock is held, and the rows
   under `dir/records` and reservations under `dir/bridges` are unaffected.

Never remove a lock while a process that uses the directory runs: the lock is
what keeps two writers from interleaving a phase's compare-and-set.

Passing does not show that a store is durable; `reopenStore` has to open it
the way a restarted process would. The suite refuses only a `reopenStore`
that returns the very handle it was given (`(store) => store`). It cannot
tell whether a new handle reaches durable state: the in-memory reference store
fails the restart and race cases when reopened as a second instance, which
starts empty (the reason it requires `acknowledgeVolatile`), but passes every
case behind a new object sharing its memory, such as
`(store) => ({ ...store })`. The SDK's own tests do that on purpose, standing
in for a database; it shows the cases accept a store that keeps the contract,
not that the reference store survives a restart.

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
- **A store that does not declare `restartSafety`** (see
  [Declaring restart safety](#declaring-restart-safety)) returns
  `liquidity-tank-store-restart-safety-undeclared` on every call.
- **A store that declares `"volatile-acknowledged"`, without explicit
  `NODE_ENV=development` or `NODE_ENV=test`**, returns
  `liquidity-tank-store-volatile-in-production` on every call.
- **A custom/copied store in production** returns `liquidity-tank-store-untrusted`.
- **A plain production bridge verifier** returns `liquidity-tank-source-finality-required`.
- **Missing or unavailable production authority resolution** returns
  `liquidity-tank-authority-resolver-unavailable`; a resolved mismatch returns
  `liquidity-tank-resolved-authority-mismatch`.
- **Otherwise valid production configuration** returns
  `liquidity-tank-production-integration-unavailable` before any phase claim.
- **Any other refused owner, lease, clock, store or adapter**, including a
  whole store wrapped in a `Proxy`, returns its refusal message as the reason,
  for example `pay-cross-chain-liquidity-tank: store.claim must be stable
  data`.

These configuration refusals need an operator: the core has not read the store, so it cannot tell
whether a lock is durable or the phase already settled.

## Reasons that need an operator

Every refusal and conflict is `indeterminate`, so `status` alone does not say
whether polling can help. These reasons repeat identically on every retry
with the same authority, configuration and store row. Escalate them to an
operator rather than polling:

- `liquidity-tank-settlement-binding-conflict`;
- `liquidity-tank-retained-state-corrupt`;
- `liquidity-tank-store-recovery-capability-unavailable`;
- `liquidity-tank-store-restart-safety-undeclared`: the store does not declare
  how it survives a restart;
- `liquidity-tank-store-volatile-in-production`: a process outside explicit
  development/test mode was given a store that declares
  `"volatile-acknowledged"`;
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
  an observation or signed bytes (it answered `false` or another value that
  is neither `true` nor `"unavailable"`). An outage is not reported here (see
  [Verifier outage](#verifier-outage));
- `liquidity-tank-recovery-deadline-before-preparation`,
  `liquidity-tank-finality-before-preparation` and
  `liquidity-tank-lock-observed-before-preparation`: the adapter or a stored
  row carries a bridge time more than a minute earlier than the submission,
  such as one in seconds (see [Timestamp units](#timestamp-units));
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
`lock-contradicted` (above) also needs an operator, and so does the terminal
`tank-lock-contradicted-recovery-expired` before any further payment for the
phase. Only these
`indeterminate` reasons are transient—retry with backoff, and alert if one
persists: `liquidity-tank-settlement-store-unavailable`,
`liquidity-tank-status-unavailable`,
`liquidity-tank-verifier-unavailable`,
`liquidity-tank-submission-preparation-unavailable`, the
`…-persistence-uncertain` reasons, `liquidity-tank-broadcast-outcome-uncertain`,
`liquidity-tank-recovery-checkpoint-conflict`,
`liquidity-tank-recovery-expiry-not-due`,
`liquidity-tank-completion-finality-invalid`,
`liquidity-tank-status-transition-unresolved`, and any reason that starts with
`liquidity-tank-adapter-indeterminate: ` (the adapter's own `indeterminate`
reason after the prefix, which keeps it from ever reading as one of the
core's reasons). A typed discriminator for this is left to a later release.

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

**The bridge this core models is not yet the one upstream ships.** Checked
read-only on 2026-10-14 against these revisions, none of which the SDK pins:

- `@kynesyslabs/demosdk` 4.0.16 (this repository's lockfile; consumers get
  `^4.0.16`) and `kynesyslabs/sdks` `ff543a9` (4.0.18): `BridgeOperation` has
  `status: "empty" | "pending" | "completed" | "failed"`, one `txHash`, one
  `amount` and `token`, chain types and names. It has none of `lockTxHash`,
  `releaseTxHash`, `recoveryDeadline`, `finalityObservedAt`, `history`,
  `authenticationHash` or `capacity-unavailable`, nor the operation fields
  the core hashes (`originAmount`, `destinationAmount`, `originAsset`,
  `destinationAsset` and both tank IDs). §9.5.5 names
  `demos.bridge.submitBridgeOperation`, which no fetched SDK source has.
- `kynesyslabs/sdks` `9eca7e6` (`native-bridges`) and `kynesyslabs/node`
  `02bac17` (`native_bridges`): bridge IDs are `bridge_` plus 64 or 16 hex
  characters; a signed operation is refused once `validUntil` (about five
  minutes) passes; and the payer's EVM deposit happens first, with the Demos
  transaction carrying its hash.
- `kynesyslabs/node` `61b8e75a`, which `node2.demos.sh` reported running (as a
  historical observation on 2026-10-15, reported with `dirty: true`; this is
  not a statement of the currently deployed revision): the native-bridge handlers are stubs, and no
  bridge-status call exists.

`createInMemoryLiquidityTankStore({ acknowledgeVolatile: true })` is for tests
and development only, and declares `restartSafety: "volatile-acknowledged"`.
Without that option it throws a `TypeError`: it keeps
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
- funded restart and ambiguity evidence with the durable store the deployment
  uses: `createFsLiquidityTankStore` on one host, or a database store that
  passes `runLiquidityTankStoreConformance` against its real backend for
  workers on several hosts;
- reviewed evidence that the bridge enforces `reserved + available =
  capacity` atomically across concurrent phases (see
  [Tank balance](#tank-balance-is-the-bridges)); the SDK does not;
- a signer that can sign this route: demosdk 4.0.16's `generateOperationTx`
  and `demos.sign` refuse every EVM origin address (see the signing note
  above), and its `POLYGON` USDC address is marked as Mumbai's, not Amoy's
  (`build/bridge/nativeBridgeTypes.js:19`);
- a review of the live adapter's signing window, with a test against the
  real SDK transport that `prepareSubmission` sends no signed bytes (no
  `confirm` or `broadcast`; reads such as the nonce are allowed) and keeps no
  copy of them, and bounded deadlines on every adapter and verifier call;
- one versioned bridge API and DTO, agreed between the Standard and the Demos
  SDK and node, carrying what the core and the verifier need (see
  [Adapter trust boundary](#adapter-trust-boundary)), with its SDK and node
  revisions pinned here and a contract test against a real adapter;
- a model of the operation's validity window: retained bytes past
  `validUntil` can never land, so the core's rebroadcast-only rule then parks
  the phase. Re-signing is safe only once the bridge shows the retained
  operation absent after its window, and that needs its own no-double-pay
  argument;
- the no-double-pay argument for a deposit-first flow, where the value-moving
  EVM deposit is outside the signed Demos bytes the core retains;
- the Standard's decisions on: the bridge-ID grammar (§9.5.5's "16-char hash"
  against its own `"tank-308"` vector); and a mechanism mismatch, which
  §9.5.5 and PC-5 make `permanent` but
  the core returns as `indeterminate`, because the settlement key binds only
  `jobId`, `railId` and `phaseIndex` and the phase may already hold a lock
  (see [Refusals before any claim](#refusals-before-any-claim));
- a contradicted lock now expires past D only on a contradiction the bridge
  stamped after its checkpoint and after D, and not a live `pending`, as
  `tank-lock-contradicted-recovery-expired` (with its `txRef` when it is a
  completion of another lock). One whose only reads past D are live pendings
  (without a lock, or under another lock inside its own window) or
  contradictions stamped at or before D or no later than the checkpoint still
  reports `lock-contradicted` and stays open, so a bridge or replica that
  never serves a read stamped after D keeps the phase open until an
  operator resolves it. An authoritative reconciliation operation that could
  decide such a lock without a fresh bridge read, or the spec's decision on a
  terminal "payment disposition unknown" outcome for it, is open as
  [DACS-Standard#422](https://github.com/DACS-Agent-commerce/DACS-Standard/issues/422); and
- the Standard-side wording for a `failed` after a committed lock, which
  §9.5.5 lists both as `permanent` and as the asymmetric source lock. The SDK
  follows ST-8 ("not a terminal failure" while the recovery path is open):
  every failure that carries a lock hash and deadline, with or without a
  stored checkpoint, resolves through D to `failed-substrate`, and only a
  failure without a lock is `permanent`. The clarification goes through
  [DACS-Standard#422](https://github.com/DACS-Agent-commerce/DACS-Standard/issues/422).


### Reconciling an expiry

`reconcileRecoveryExpired({ settlementKey, bindingHash, expectedEvidence,
completion })` is an atomic comparison against the exact saved expiry. The
completion must carry the same bridge operation, lock and recovery deadline.
With `finalityObservedAt <= recoveryDeadline`, it replaces expiry and retained
failure with the authenticated completion and its settlement in one write.
A later finality time preserves the expired state and its original checkpoint
and failure, and replaces the expiry evidence with the authenticated completion,
so subsequent replays report the paid disposition. A replay of the same payment
facts returns `existing`, including a refreshed authentication hash. A different
lock, conflicting completion, changed binding or stale evidence is refused. Both bundled
stores implement it; the filesystem store commits it under the phase lock.
It is optional for development-only custom stores; without it a proven release
returns indeterminate until it can be persisted, never the old unpaid disposition.
