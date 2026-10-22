# Native DEM execution gate

The `pay-dem` rail reports a native DEM payment as settled only after the
node's transaction record shows that the signed transfer executed. Inclusion
alone is not enough: a Demos node can include a transaction and record it
`failed`, for example after a stale nonce. node2 served exactly that case
until its chain reset on 2026-10-20: a `failed` record whose
`getTransactionStatus` is `included` (recorded in
`test/fixtures/demos-node2-records.json`).

## What the rail does

`createPayDemRail` signs the transfer, confirms it, journals the prepared
transfer, broadcasts it once, and then:

1. polls `getTransactionStatus` for the signed hash until the status index
   reports `included` at a block;
2. reads the transaction record for the same hash with `getTxByHash`;
3. binds the record to the prepared transfer: hash, nonce, inclusion block,
   payer, payee, amount and the native `send` body must all match;
4. classifies the bound record by its literal `status`:

| Record | Result |
| --- | --- |
| `confirmed`, bound | `ok: true`, `execution: "executed"`, `bft-final` finality and a `demos` txRef at the inclusion block |
| `failed`, bound | `ok: false`, `errorClass: "permanent"` and a `demos-failed-record` failure proof |
| `confirmed` or `failed`, but nonce, block or body does not bind, or a present fee is malformed | indeterminate at once |
| missing, `pending`, any other status (`included`, `finalized`, `Confirmed`, ...), malformed, another hash, a rejected read | read again until the budget ends, then indeterminate |
| a read still pending at its bound, `statusRequestTimeoutMs` or the end of `transactionRecordTimeoutMs`, whichever comes first | indeterminate at once (`transaction record read timed out`); reads never stack |

The first record read starts as soon as the status index reports `included`.
A record binds when its `hash` is the signed hash, its `status` is literal
`confirmed` or `failed`, its `blockNumber` is the inclusion block, and its
`content` is a `native` body with the signed `nonce`, no `custom_charges`,
the payer in `from` or `from_ed25519_address` (every one present must match),
`to` and `amount` for this payee and amount, and `data` of
`["native", {nativeOperation: "send", args: [payee, amount]}]`. Other fields,
such as `signature`, `gcr_edits` or `attrs`, are not compared, but the whole
record must still be canonical JSON: a record with, for example, an integer
above `Number.MAX_SAFE_INTEGER` anywhere in it is malformed and read again.

Indeterminate is `ok: false` with the signed hash retained, so the settlement
intent stays held. No outcome ever causes a second broadcast.

## Budgets

| Option | Default | Bounds |
| --- | --- | --- |
| `inclusionTimeoutMs` | 60 s | waiting for the status index to report `included` |
| `inclusionPollIntervalMs` | 500 ms | the pause between repeated status reads, and between repeated record reads |
| `statusRequestTimeoutMs` | 5 s | each single status or record read (a record read also ends at the record budget) |
| `transactionRecordTimeoutMs` | 30 s | all record reads after inclusion |
| `nonceVisibilityTimeoutMs` | 60 s | the post-execution account-nonce projection |

Each must be a positive safe integer. The registry forwards
`payDem.transactionRecordTimeoutMs` from `RailDispatchOptions` to the rail.
The transport of demosdk 4.0.16 and 4.0.18 retries a connection error or a
502 to 504 up to four times inside one read, so one read can take several
seconds before the SDK sees its result.

## Custom clients, rails and reconcilers

Only the SDK's own read of the node makes a fresh payment's verdict final,
inside `createPayDemRail`. That rail signs the transfer with a fresh nonce and
signing time, takes the fee from the node's confirmation, journals the
prepared transfer, asserts the effect fence and broadcasts once, and then
reads and binds the record. A record the SDK reads after someone else's
broadcast shows only that a transfer with these terms executed: not that this
call made it, that it came after the journal and the fence, or what fee it
paid. So a custom `DemosNativeClient` or `PayDemRail` is the integrator's own
chain access, and its result could never be final. Recovery is different:
after a restart a held intent is named by the integrator's reconciler, and
the rail's own read of the node's record decides it (see the reconciler item
below).

- The SDK decides before the effect. `payDemSettleCore` refuses any client
  except the one `createPayDemRail` builds, before its `transfer` runs: its
  result could never be final, so it must not cost the buyer a transfer first.
- `payDemSettle` treats a `PayDemRail` the same way, before it calls `settle`.
  It calls only the `settle` function `createPayDemRail` returned, also when a
  caller places it on its own object; any other rail, including a wrapper
  around it, is refused on a fresh attempt before its `settle` runs, and the
  settlement key is left free. The bridge is still built around such a rail,
  so an attempt it made before reconciles through `reconcile` without calling
  it. `isPayDemRecordVerifyingRail` answers which rails these are. The
  `createPayDemRail` settle yields success or a permanent failure.
- A `PayDemSettlementReconcile` returns a `PayDemReconciledSettlement` with
  `execution: "executed"` only after reading and binding a `confirmed`
  record, or a `PayDemReconciledFailure` for a bound `failed` record. That
  answer is the integrator's statement: it names a hash and claims an
  outcome. Every recovered verdict (a retained-hash audit, the store's lookup
  by key, the restart re-check of a cached outcome) is then decided by the
  rail's own read of the node's record for that hash, through the connection
  `createPayDemRail` opened: one bounded `getTxByHash`
  that must carry the hash, a terminal `confirmed` or `failed` status, an
  inclusion block, and a native body whose payer (the rail's wallet), payee,
  amount and nonce bind the payment. Only a rail with such a read may make a
  fresh payment, so every payment the adapter made can be read again on a
  resume or a repeat. The block, nonce and fee come from that record; a claim it
  contradicts is refused, including a `networkFeeOs` the record does not
  carry (a reconciler may omit the fee), and a missing, pending, timed-out or
  malformed record leaves the payment unresolved with that reason. Over any other rail
  there is no such read, so a recovered result is held as `ok: false` with
  the hash. A failure found by a lookup by key is never final: the hash may be
  another job's transfer of the same parties and amount. After a restart, a
  durable outcome and a reconciliation that disagree on the transaction, the
  block, success or any failure-proof field, the nonce included, are refused.
- A settlement request carrying `priorAttempts` (which `runSession` sends for
  a session holding a transaction-bearing outcome) is an audit of that
  retained transaction that never submits. It reads only and never claims a
  submit generation or writes an intent, attempt record or outcome.
  `payDemSettle` never calls the rail for it, even
  when the rail log lost its record, and requires both
  `settlementStore.readOutcome` and `reconcile` (a bridge without `reconcile`
  returns only the definitive result it bound to the key itself, when the
  attempt record and the saved outcome agree). It still re-reads the node
  record before returning a cached success or permanent failure, including
  when the same adapter originally submitted the payment. A log that keeps attempt
  records must implement `readOutcome`, which reads without a lease. The
  `createIdempotencyStore` lookup never claims, leases or binds a key; over
  an older log without `readOutcome` it refuses.
  The reconciler then receives a
  `PayDemSettlementAuditContext` with `txHash`, the retained hash in canonical
  form (64 lower-case hex digits, no `0x`). It returns a normalized reconciliation
  result derived from the node's record for that hash, not the raw record's
  `content`/`status` shape (see the example below), and, whenever it can load one, the prepared-transfer journal entry
  for that hash as `preparedTransfer`. The hash counts for this payment only
  through the SDK's own record that this key signed it: the key's attempt
  record, or a result this bridge submitted and the attempt record accepted.
  An unbound audit refuses without changing the log, even when reconciliation
  finds a same-party, same-amount transfer. Reconciliation cannot create the
  original job/phase binding required by DACS-4 §9.5.1 PC-7. Every audit reads
  the attempt record, and a record naming another hash refuses it, whatever
  the bridge holds in memory.
  Nothing else binds the hash. SettlementEvidence the buyer signed and anchored
  names a hash, but DACS-4 §9.5.9 declares no settlement-side job binding
  for pay-dem and SB-2 gives an outer evidence signature or an anchor no
  collision authority, so it cannot bind the hash to this job: another job
  could cite the same transfer. When the rail log has lost the key's attempt
  record, the audit is held as indeterminate (never repaid, never counted)
  until the attempt record is restored or the payment is resolved by hand
  against the node's record (the SDK has no operator path for it).
- Checkpoint and evidence members the SDK now writes (`errorClass`,
  `failureProofJson`, `networkFeeOs`, the evidence `payer`) carry no schema
  version. An older SDK reads such a record as invalid, so there is no
  downgrade after a native session has run on this version.
- The attempt record is written through the settlement fence's
  `recordAttempt`, which a `createIdempotencyStore` store provides when its
  `SettlementLog` implements the optional `putAttempt`/`readAttempt` pair (the
  in-memory log does). `createPayDemRail` signs the hash itself, records it
  before its one broadcast and does not broadcast when the record is refused;
  `payDemSettle` does not write it again after the payment is final (it
  writes only when the SDK rail returned a hash its own pre-broadcast write
  did not report, which `createPayDemRail` never does; a refusal there fails
  closed and leaves the hash unbound). The fence a
  rail receives records the canonical form (64 lower-case hex digits, no `0x`)
  whichever form the rail passes, and rejects a value that is not a Demos
  transaction hash before the rail can broadcast it. The write is
  compare-and-set under the submit generation and the record never changes. A
  crash after broadcast, a timeout or an ambiguous result therefore still lets
  a restarted process audit the payment. A durable log needs the pair, so
  `payDemSettle` starts no new transfer through a `createIdempotencyStore`
  store over a log without it: the call fails before the rail runs, nothing is
  signed or sent, and the intent is released. Nor does it start one through
  any other store, wrapper or fence: a new transfer runs only when the fence a
  store hands its submit is that store's own fence for this key and these
  terms (a wrapper whose `once` hands another key's fence starts nothing) and
  records through the same `createIdempotencyStore`
  store whose own `readOutcome` and `readAttempt` it carries. A log without
  the pair still
  serves the payments it holds. An audit counts the hash that an outcome the
  log holds for these exact terms names, once the reconciliation agrees with
  it on block and result; a key with no saved outcome stays fail closed. Before adding the pair to an existing log,
  backfill each outcome that names a transaction as its attempt record
  (`bindingHash` and `txHash` from that outcome), and a key still held with no
  outcome only from the rail's prepared-transfer journal entry whose
  `recovery` tuple names that key. Once the log keeps attempts, an outcome
  without a record never counts.

  A supplied entry is always checked: it must name that hash, the same payer,
  payee, OS amount and network, a `recovery` tuple equal to this rail, job and
  phase, and (when present) a known denomination and debit bounds no lower
  than the amount; a permanent failure's proof must also carry the journaled
  nonce. A supplied confirmation debit must be at least the OS amount and
  no greater than the declared debit ceiling. The confirmation debit and
  the record's fee are independent quantities and may differ. A missing fee with
  no authenticated value to preserve does not prevent recovery or authenticate
  a fee from the supplied journal. Recovery preserves a
  previously authenticated network fee if the reader omits it, and refuses a
  conflicting fee without changing the recorded success. The SDK's own node-record
  read must still match the saved fee. The entry is the reconciler's object, not the one the rail wrote
  before broadcast, so it can refuse an audit but never counts the hash on its
  own. Nor does an injected store's records, or a rail-log outcome on a log
  that keeps attempts, which a key-only restart reconciliation can have
  written. The reconciler throws
  when a loaded entry conflicts with the record and never returns `null` for
  the retained hash.

  A recovered success carries the fee of the record the SDK read (the sum of
  its `transaction_fee` components in OS) as `networkFeeOs`, and so does a
  fresh success `payDemSettle` returns. A rail's own `networkFeeOs` is its
  debit accounting: the confirmation's fee (`gas_operation.fees` when the node
  reports one). That debit bounds `maxTotalDebitOs` and stays on the rail's result, but the signed record need
  not carry it, so the adapter reports the fee of the record it read; a saved
  success then re-reads the same fee on every restart. After the
  denomination fork the transaction query serves each component as an OS
  number up to `Number.MAX_SAFE_INTEGER` and as a decimal string above it, as
  it serves `content.amount`; node2's recorded envelopes carry
  `network_fee: 1000000000`. Both forms are read. A record without
  `transaction_fee` binds no fee; one with a fee in any other form (`null`,
  `{}`, an array, a fraction, a negative) leaves the read indeterminate.
  The node keeps each transaction as it was signed: its denomination fork
  migrates balances, not transaction rows. So the SDK reads a record in the
  denomination its signed payload carries, not the node's current one: a
  numeric `args[1]` (how demosdk signs before the fork) is DEM, and its amount
  and fee components are converted at 1 DEM = 1,000,000,000 OS. A decimal
  string is OS. A payment saved before the fork therefore still completes
  after it activates. An OS-signed record on a node that reports the fork
  inactive is indeterminate. The SDK reads that fork state from the node for
  each recovery (`nodeCall("getNetworkInfo")`), not from demosdk's
  `getNetworkInfo`, which in 4.0.18 caches fork information, so a rail
  that saw the fork inactive still reads a payment signed after it activated.
  A reconciler may omit the fee, and one that
  reports another fee is refused. `runSession` re-asserts a saved fee, so a
  record with another fee, or none, leaves the saved success unresolved (not
  completed, never reported unpaid).
- Any failure after the record and before the broadcast, including a crash or
  fence refusal, leaves a recorded hash
  that nothing sent. The SDK never signs or sends again for the key: when the
  reconciler finds nothing for the recorded hash, the restart is refused and
  the key stays held until the operator establishes that the transaction
  did not land and can no longer land before clearing the key in the durable
  log. This requires an executed, finalized transaction at the payer's journaled nonce
  on a node that serves that block, with a hash different from the recorded
  hash. Verify the replacement's hash, payer and nonce against its finalized node
  record with `status: "confirmed"`: it must have executed and consumed the journaled
  nonce. An included transaction with `status: "failed"` is not proof of nonce
  consumption and does not authorize clearing the key. If execution or the original
  payment's disposition cannot be established, retain the key.
  A moved nonce alone is insufficient: it also matches the recorded
  transaction having landed. If the hashes match, recover that payment's
  outcome and retain the key. Missing records or a lagging node leave the key
  held; they do not authorize a replacement payment.
  Once those conditions are proved, clearing the key is an
  operator action outside the `SettlementLog` contract: remove its whole durable record
  (lease, attempt and outcome). Removing only the lease leaves the immutable
  attempt in place. If the session still retains that hash, clearing the rail
  log alone cannot permit replacement: abandon the job and use a new `jobId`,
  or explicitly clear the session's retained settlement outcome together with
  the whole rail-log record under the same operator procedure.
- A restart without history reconciles in the store. With an attempt record
  the reconciler receives its hash as `txHash`, and any other transaction is
  refused. The store records no reconciled failure as the definitive
  outcome, so a failure the SDK read there leaves the intent held
  (`reconciliation was not definitive`) and nothing is resubmitted. A failure
  is final only on the retained-hash audit or the restart re-check of the
  rail's own durable failure. Without an attempt record, the SDK's read of
  the reconciler's answer for the key cannot tell this payment from another
  job's transfer of the same payer, payee and amount, so a success is refused
  unless this same bridge already submitted and bound the hash to the key,
  and a failure found that way is held. The same check runs before saving a
  reconciled success and before returning a cached success: another job's
  same-party, same-amount payment cannot complete this job through a key-only
  reconciliation or saved outcome.
- A native DEM session (`runSession` with a `pay-dem` price in DEM) calls
  only this `payDemSettle` adapter (directly, from `settleFromRail`, or
  through `Agent.runSession`), as `settle` and as `resumeSettlement`,
  recognised by identity; a wrapper or a `.bind()` copy is a different
  function. When `resumeSettlement` is omitted, the registered native DEM
  `settle` adapter serves as the recovery implementation.
  Native recovery requests carry `recoveryOnly: true`, even when a crash left
  only the session intent. Without an attempt record, it refuses recovery.
  An SDK-confirmed pre-attempt failure instead records a single-use retry
  checkpoint, consumed durably before retrying the original rail key. The
  rail's atomic claim still refuses an unresolved earlier generation.
  Deterministic recipient checks run before the session claims settlement.
  If the process died without recording its refusal, operators may configure
  `payDemSettle`'s `retryUnattempted` with `originalLogRetained: true` and an
  independent absence reconciler. It fences the old worker, verifies the intact
  original log has no attempt, and reopens the exact key for one fresh payment.
  Live, completed, tx-bearing, conflicting, and independently observed payments
  refuse. `reopenUnattempted` exposes the same fenced operation on the store.
  Before claiming or paying, a fresh native session requires a
  caller-supplied settlement store and reconciler on its recovery adapter,
  plus a caller-supplied store on its paying adapter. A supplied
  `resumeSettlement` must itself be the SDK adapter; a callback, wrapper or
  bound copy is refused before the initial payment.
  Any other implementation is refused before it is called, so it
  makes no payment and reports no outcome: nothing could re-read a native
  success it reported after a restart. The adapter over a rail
  `createPayDemRail` did not build reports only a hash for any outcome it did
  not read: the session binds the hash and saves it as an unresolved attempt,
  so a later audit through the adapter over the SDK rail reads that hash
  instead of paying again.
- A success that the bridge, its rail log or the session recorded is never
  reported unpaid: a reconciliation that contradicts it is refused rather than
  returned as a permanent failure (DACS-4 §9.5.1 PC-7).
- Upgrading: this is a breaking change for stores and logs that paid before.
  A custom or class settlement store, and any log that lacks `readOutcome`,
  `putAttempt` or `readAttempt` (`createIdempotencyStore` also throws for a
  log that provides only one of the attempt pair, or the pair without
  `readOutcome`), now starts no new pay-dem transfer: the call fails before
  the rail runs and nothing is signed or sent. To migrate, add `readOutcome`,
  `putAttempt` and `readAttempt` to the durable log (`putAttempt`
  compare-and-set under the generation, a record never changing), backfill
  the records as described above, and pass the `createIdempotencyStore` store
  itself, or an object carrying its own `once`, `readOutcome` and
  `readAttempt`. Recovery of payments or saved outcomes written by older SDK
  versions is outside the current support scope. The restart guarantees here
  apply to payments made with the current SDK and a log implementing all
  three methods.

For native DEM sessions, retain a durable rail `SettlementLog` with its immutable
attempt records alongside the `SessionStore`, and reopen it with a reconciler
after a process restart. The default in-memory rail log supports retries only
while its process survives in direct rail calls; a native session refuses that
default configuration before payment. A fresh native session also requires a retained `SessionStore`: its existing
intent prevents a lost rail log from authorizing another payment. The SDK
checks that both stores were supplied and support the required operations;
callers must ensure their stores are durable.
Every native resume, including a completed-session replay, requires a trusted
node to serve the transaction record. Set `createPayDemRail({ rpc, secret,
recoveryRpc })` to use an operator-authenticated archival RPC when the primary
record is unavailable. The SDK compares fresh `chainId` and `forkScheduleDigest`
values from both nodes and requires the archive's confirmed inclusion block to
match the primary's confirmed block, with the retained hash in both transaction
lists. Both nodes must have reached that height. Missing or contradictory chain
history keeps recovery unresolved, including after a reset. Archive and history
RPC reads cancel at `statusRequestTimeoutMs`, admit at most 1 MiB before JSON
decoding, and accept at most 16,384 transaction hashes per block. The SDK also
applies the same transfer, execution, denomination and fee checks. It never
connects a wallet to the archive or uses it to sign or broadcast. A terminal
primary verdict cannot be overridden by the archive. Configure the settlement
reconciler to resolve the original retained hash against the same archive; its
refusal or proof of absence still stops recovery before the SDK record read. Without verifiable archival history, a pruned record, node reset or outage
keeps replay unresolved without changing the saved payment or submitting again.
A `SessionStore` alone cannot recover a payment
whose rail records were discarded. Restore the original rail log and attempt
records from a trusted backup before retrying such a session; clearing a paid
key or forcing a completed outcome cannot reconstruct those records safely.

Which capabilities the SDK built (its client, its rail's `settle` and
recovery read, `payDemSettle`'s submissions and the adapters it returned), and
which successes its own client returned, is kept private to the rails module,
keyed by object identity. No file in the package exports a way to add to it.
The exports are five read-only checks: the ones the settlement store and
`runSession` use; `isPayDemRecordVerifyingRail`; and
`payDemRecordVerifiedTransfer`, which gives the exact transfer terms (payer,
payee, `amountOs`, network and recovery settlement key) of a frozen success
`payDemSettleCore` returned from the SDK's own record read, and `undefined`
for anything else, including a copy of that success.

The settlement store records a bound permanent failure as the definitive
outcome for that key only when it comes from `payDemSettle` over the rail
`createPayDemRail` returned, whose proof the SDK built from the record it
read. A failure proof from any other source, including a custom rail, a rail
that wraps the SDK rail's `settle`, or a reconciler, leaves the intent held
(a custom or wrapping rail is refused before it runs; a reconciler's proof is
held): it is never a durable verdict and never permits a second broadcast. Neither
outcome ever permits a replacement payment. The proof type is internal; a
custom reconciler can name it as `PayDemReconciledFailure["failureProof"]`.

`runSession` accepts the permanent failure only for a `pay-dem` request in
DEM, with a bound proof whose `amountOs` is the request's amount in OS, on
fresh settlement and on recovery, from the `payDemSettle` adapter, and on
recovery only for a hash the session already held. It binds the hash for
anti-replay and records the proof as the terminal failed outcome; a later
resume reuses it only after the adapter re-reads the identical proof. Without a `SessionStore` no
proof survives the run, so a resume holds the anchored failure as
indeterminate instead of reporting it again. A failure read for a saved
success, a bound permanent one included, is refused instead: the session
stops and the saved success stays in place (PC-7).

The dacs-node buyer track runs a fresh payment only on a rail whose success
the SDK can make final: the default runtime rail, a rail
`isPayDemRecordVerifyingRail` accepts, or the runtime's wrapper around such a
rail. With any other rail a fresh payment stops for operator action
(`pay-dem-rail-not-record-verifying`) before any wallet reservation. The track
is still built around such a rail, so a payment it made before reconciles
through the operator reconciler without calling it. The track settles the
wallet authority and publishes a payment notice for a fresh rail result only
when `payDemRecordVerifiedTransfer` lists it with this payment's payer, payee,
amount, network and settlement key, and its hash is the one this invocation
journaled. Any other success,
including an injected rail's `execution: "executed"`, a copy of the SDK
rail's result, or the SDK rail's result for another transfer or settlement
key, leaves the payment indeterminate with the wallet reservation retained. A
rail that relays the SDK's own result object unchanged, such as the default
runtime rail, keeps it. That default rail also reports success only after the
SDK's Demos adapter reconciles the wallet journal to `canonical-confirmed`.
Its operator reconciler type, `DacsPayDemBuyerChainReconciliationV1`, carries
no attestation, so an operator reconciler must return `completed` only after
reading a bound `confirmed` record.

Direct `createPayDemRail().settle()` use without a fence that implements
`recordAttempt` is supported at the low level, but records no durable payment
binding in the SDK settlement log and cannot provide the bridge's restart-audit
guarantees. A host's prepared-transfer journal is a separate recovery mechanism.

### Normalizing a reconciliation result

The callback returns `PayDemReconciledSettlement` or `PayDemReconciledFailure`,
not a raw `getTxByHash` reply. For success, first validate the record's hash,
native-send payer, payee, amount and nonce against the requested payment and
prepared journal, and check both inclusion and `record.status === "confirmed"`.
Decode the amount and fees into integer OS using the record's denomination.
After those checks, the success mapping looks like this:

```ts
const result: PayDemReconciledSettlement = {
  ok: true,
  execution: "executed",
  txHash: record.hash,
  chainId: context.network,
  payer: record.content.from,
  payee: record.content.to,
  amountOs: verifiedAmountOs,
  blockNumber: record.blockNumber,
  txRefKind: "demos",
  finality: { model: "bft-final" },
  ...(verifiedFeeOs === undefined ? {} : { networkFeeOs: verifiedFeeOs }),
  ...(preparedTransfer === undefined ? {} : { preparedTransfer }),
};
```

`verifiedAmountOs` and `verifiedFeeOs` come from those validated chain facts,
not the requested amount or an estimated fee. A bound `failed` record instead
maps to the permanent failure shape with its exact `failureProof` and no
`execution` assertion. Throw for an indeterminate read; a missing record for a
retained hash must never return `null` as permission to pay again. See the
exported result types for the full shapes. The SDK checks the callback's
normalized statement and bindings; the integrator is responsible for its
chain reads.

## Standard revision

Native recovery follows [DACS-4 v0.8 at `d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md), the revision in `package.json` and the conformance sync. PC-7, SB-2 and §9.5.9 references in this document use that revision.

## Finality

DACS-4 §9.5.9 treats Demos inclusion as BFT-final, and the rail stamps
`bft-final` at the inclusion block of the confirmed record. It does not watch
for reorganisation afterwards.

The pinned Standard (`d45c0a29`) says to return success when the transaction
reaches the terminal `included` state. The rail is stricter: it also requires
the bound `confirmed` record, because the status index reports `included` for
failed records. No Standard conformance vector covers an included but failed
transaction yet.

## Node semantics

These were read from kynesyslabs/node `stabilisation@61b8e75` and
`stabilisation@52e2e5698bd9785ddd709de33e4709d5dd7bc308`:

- `getTransactionStatus` reports `included` for every stored row, failed ones
  too, and never reports `failed`;
- the record `status` is `confirmed`, `failed` or `pending`;
- `content.nonce` is served as a decimal string, and `content.amount` as a
  number up to `Number.MAX_SAFE_INTEGER` and a decimal string above it;
- not-found is `{result: 400, response: "error"}` at 61b8e75 and
  `{result: 404, response: null, extra: {reason: "not_found", checkedThroughBlock}}`
  at 52e2e569 and at `11e7c8207732e25035de5a04cab25c5346046493`, which serves
  the same record shape and status handler.
- `getTxByHash` matches the stored lower-case hash exactly and answers any
  other spelling as not found; `getTransactionStatus` lower-cases hex but
  rejects a `0x` prefix as an invalid request. The rail always passes the
  canonical form.

The default `testnet` branch had no `getTransactionStatus` when read on
2026-10-20, so against such a node the rail never observes inclusion and stays
indeterminate.

From 2026-10-15 until early on 2026-10-20 node2 reported 61b8e75, and its
`getNetworkInfo` marks the build `dirty`, so its deployed bytes were not pinned
to that commit, and its build time changed between reads. Later on 2026-10-20
node2 reported `11e7c8207732e25035de5a04cab25c5346046493` at `GET /version`,
again from a dirty build, after a chain reset: it no longer serves the
recorded hashes. The
fixture is therefore a historical set of envelopes node2 served on the dates it
records, not a pin of a deployment, and cannot be re-read today. The rail does
not depend on that build: a record without the fields listed above, or with
any of them different, is indeterminate.

## Closing an unattempted native intent

An operator may close an unpaid phase with:

```ts
await store.abandonUnattempted(key, originalBinding, {
  originalLogRetained: true,
  // Resolve this exact key and binding using an independent, complete
  // prepared-transfer journal or authoritative reconciliation service.
  // Return null only when it proves no transfer was prepared or submitted;
  // return a found payment, and throw on unavailable or incomplete history.
  reconcile: (key, binding) => reconcileOriginalPayment(key, binding),
});
```

The store must be opened over the intact original rail log. The confirmation
and independent absence check are required on every call, including expired
intents and crashes before an intent was written. The key and complete
`SettlementBinding` must be the original values. Never confirm a replaced,
lost or incompletely restored log. A trusted backup may recover a known hash,
but local absence in a lagging backup cannot prove a payment was never made.
The reconciler must consult evidence independent of that log; a missing or
pruned node record alone is not proof of absence.

The method fences the old worker, refuses live, completed, changed-binding or
tx-bearing intents, and writes an immutable empty-hash unpaid outcome only
when the independent check returns null. A found payment, unavailable journal
or failed reconciliation leaves the outcome unresolved under its recovery lease.
`payDemSettle` returns an established unpaid outcome on the next recovery-only
resume so the original session can end failed. This operation never submits or
authorizes a replacement payment.
A malformed record fee also stays indeterminate; an archive must provide a
well-formed record rather than treating an unparseable fee as zero.

## Rail-final payment while evidence publication is unavailable

With a retained `SessionStore`, an evidence-anchor outage after a successful
payment returns `outcome: "settlement-pending"`, `payment.ok: true`, the confirmed
transaction metadata, and `pendingEvidenceAddress`. There is no `settlementRef`
or `bundleRef` yet. The session stays non-terminal. Its immutable `settle:0`
outcome is the durable retry item: an operator or worker resumes the same job,
which audits the original payment and retries that same write-once evidence
address before publishing the bundle, while the Listing remains valid. The
existing expired-Listing admission gate can still prevent catch-up after expiry.
An unavailable native record re-read returns the saved `payment.ok: true` in
`settlement-pending`, without publishing unchecked evidence; contradictions
still refuse. Never start a new payment from this result.
Failed payments and failures before the paid checkpoint is durable retain their
existing error behavior. Direct sessions without a durable store cannot offer
durable evidence catch-up; fresh native sessions require that store.
