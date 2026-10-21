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
| `confirmed` or `failed`, but nonce, block or body does not bind | indeterminate at once |
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

Only the SDK's own read of the node makes a fresh payment's verdict final:
inside `createPayDemRail`, or through a record reader `createPayDemRecordReader`
built. A custom `DemosNativeClient` or `PayDemRail` is the integrator's own
chain access: what it returns is its statement, which the SDK cannot
authenticate, so its own verdict never becomes final. Recovery is different:
after a restart a held intent is settled by the integrator's reconciler, and
the SDK checks only that statement's shape and bindings (see the last item
below).

- The SDK decides before the effect. `payDemSettleCore` refuses a client that
  is neither the one `createPayDemRail` builds nor carries a reader
  `createPayDemRecordReader` built, before its `transfer` runs: its result
  could never be final, so it must not cost the buyer a transfer first.
- A custom `DemosNativeClient` that signs and broadcasts itself carries
  `recordReader: await createPayDemRecordReader({ rpc })`, journals its
  signed transfer once through the `journalPreparedTransfer` the SDK hands
  it, before its one broadcast, and returns the signed `nonce` with the hash.
  `payDemSettleCore` then does what `createPayDemRail` does after broadcast,
  against that node: it polls the status index for the returned hash, reads
  the record, binds it to the returned nonce and to this payer, payee and
  amount, and classifies it with the table above. A bound `confirmed` record
  is a final success that `payDemRecordVerifiedTransfer` lists; a bound
  `failed` record is a permanent failure with a proof the SDK builds. The
  client's `ok`, `state`, `execution`, `blockNumber` and `failureProof` are
  ignored. Its fee is accounting only: when the payment has a
  `maxTotalDebitOs`, the client's journal entry must carry its
  `confirmedTotalDebitOs`, at least the amount and within that ceiling, or the
  entry is refused and the client must not broadcast, as `createPayDemRail`
  refuses; the success's `networkFeeOs` is that journaled debit less the
  amount, or else the client's `totalDebitOs`, which must match the journaled
  debit when both are given. The reader holds no wallet, signs nothing and trusts its
  node exactly as `createPayDemRail` trusts its own. A reader the SDK did not
  build, or a copy of one, is refused before the transfer.
- A record shows that a transfer with these terms executed, not that this
  call made it. So before the transfer the reader reads the payer's account
  nonce (`getAddressNonce`, within `statusRequestTimeoutMs`), and the transfer
  is refused if that read times out, fails or is malformed. The SDK reads the
  record only for a transfer whose signed nonce is above that account nonce,
  and whose hash and nonce are the ones the client journaled exactly once,
  for this payer, payee and amount, before `transfer` returned. A journal
  entry for other terms, a second entry, or one after `transfer` returned is
  refused, so the client must not broadcast.
- The node's account nonce can lag inclusion, so the nonce alone could admit
  a transfer that executed just before this call, for example one that
  settled another job before a restart. The record therefore binds only when
  its signed `content.timestamp` (milliseconds, as demosdk sets it when it
  signs) is not earlier than the SDK's clock when the call began; a record
  without one, or signed earlier, confirmed or failed, is indeterminate. The
  timestamp is part of the signed transaction, so an earlier transfer cannot
  carry a later one, in any process and after any restart. The client must
  sign with a clock that does not run behind the SDK's, or its transfers are
  held. Calls that overlap can each see the same newly signed transfer: in one
  process a hash settles at most one payment, and across processes that run
  at the same time a durable session store binds a hash to one job.
- A reader-carrying client's result is held: `ok: false` with the signed hash
  and nothing else, when it has no signed nonce, when it is not bound to a
  transfer this call journaled and signed, or when its record does not bind.
  A malformed result still throws.
- `payDemSettle` treats a `PayDemRail` the same way, before it calls `settle`.
  It calls only the `settle` function `createPayDemRail` returned, or the one
  `createPayDemClientRail` returned around a reader-carrying client, also when
  a caller places either on its own object; any other rail, including a
  wrapper around one of these, is refused on a fresh attempt before its
  `settle` runs, and the settlement key is left free. The bridge is still
  built around such a rail, so an attempt it made before reconciles through
  `reconcile` without calling it.
  `isPayDemRecordVerifyingRail` answers which rails these are. The
  `createPayDemRail` settle yields success or a permanent failure. A client
  rail's success is final only when it is the exact frozen object
  `payDemSettleCore` returned from the SDK's own record read for this
  payment's payer, payee, amount, network and settlement key; its failure
  proof is held as `ok: false` with the hash: never persisted as the outcome,
  and the next call for the key needs reconciliation.
- A `PayDemSettlementReconcile` returns a `PayDemReconciledSettlement` with
  `execution: "executed"` only after reading and binding a `confirmed`
  record, or a `PayDemReconciledFailure` for a bound `failed` record. The
  reconciler is still the integrator's statement: it recovers a held intent
  after a restart, and the SDK checks its shape and bindings only. After a
  restart, a durable outcome and a reconciliation that disagree on the
  transaction, the block, success or any failure-proof field, the nonce
  included, are refused.
- A settlement request carrying `priorAttempts` (which `runSession` sends for
  a session holding a transaction-bearing outcome) is a read-only audit of
  that retained transaction. `payDemSettle` never calls the store's `once` or
  the rail for it, even when the rail log lost its record, and requires both
  `settlementStore.readOutcome` and `reconcile`. A log that keeps attempt
  records must implement `readOutcome`, which reads without a lease. Over an
  older log with neither, the `createIdempotencyStore` lookup reads through
  `claimIntent`, so it is not read-only: it returns a saved outcome, takes a
  short lease on a key it had to install and releases it at once, refuses a
  held generation, and on an expired one takes a reconcile lease that it
  leaves to lapse and refuses.
  The reconciler then receives a
  `PayDemSettlementAuditContext` with `txHash`, the retained hash in canonical
  form (64 lower-case hex digits, no `0x`). It returns the node's record for
  that hash and, whenever it can load one, the prepared-transfer journal entry
  for that hash as `preparedTransfer`. The hash counts for this payment only
  through the SDK's own record that this key signed it: the key's attempt
  record, or a result this bridge submitted and the attempt record accepted.
  Otherwise the audit is refused. Every audit reads the attempt record, and a
  record naming another hash refuses it, whatever the bridge holds in memory.
- The attempt record is written through the settlement fence's
  `recordAttempt`, which a `createIdempotencyStore` store provides when its
  `SettlementLog` implements the optional `putAttempt`/`readAttempt` pair (the
  in-memory log does). `createPayDemRail` signs the hash itself, records it
  before its one broadcast and does not broadcast when the record is refused;
  `payDemSettle` records that hash again before the store persists or returns
  it, and a refused write fails the call and leaves the hash unbound. A
  `createPayDemClientRail` client's journal entry is its own statement and can
  name another payment's transfer, so its fence carries no `recordAttempt`:
  `payDemSettle` records its hash only after the SDK's own record read made it
  this payment's success (signed after the call began, its nonce above the
  account nonce read before it, settled by no other call in this process).
  Any other hash it returns, including its own transfer the SDK has not read
  yet, is not recorded and stays unbound. Two payments in flight at once that
  a client hands one transfer cannot be told apart by the record; the SDK
  settles and records at most one of them in a process. The fence a
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
  store hands its submit records through the same `createIdempotencyStore`
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
  nonce. The entry is the reconciler's object, not the one the rail wrote
  before broadcast, so it can refuse an audit but never counts the hash on its
  own. Nor does an injected store's records, or a rail-log outcome on a log
  that keeps attempts, which a key-only restart reconciliation can have
  written. The reconciler throws
  when a loaded entry conflicts with the record and never returns `null` for
  the retained hash.
- A crash after the record and before the broadcast leaves a recorded hash
  that nothing sent. The SDK never signs or sends again for the key: when the
  reconciler finds nothing for the recorded hash, the restart is refused and
  the key stays held until the operator establishes that the transaction can
  no longer land (for example, the payer's nonce has moved past its journaled
  nonce) and clears the key in the durable log.
- A restart without history reconciles in the store. With an attempt record
  the reconciler receives its hash as `txHash`, and any other transaction is
  refused. Without one, the reconciler's answer for the key is still accepted
  and saved, so that path relies on the reconciler to look up this exact
  payment. On a log that keeps attempts the saved outcome never binds a later
  audit.
- A success that the bridge, its rail log or the session recorded is never
  reported unpaid: a reconciliation that contradicts it is refused rather than
  returned as a permanent failure (DACS-4 §9.5.1 PC-7).

Which capabilities the SDK built, and which successes its own client
returned, is kept private to the rails module, keyed by object identity. No
file in the package exports a way to add to it. The exports are three
read-only checks and two factories. The checks are: one the settlement store
uses; `isPayDemRecordVerifyingRail`; and `payDemRecordVerifiedTransfer`, which
gives the exact transfer terms (payer, payee, `amountOs`, network and recovery
settlement key) of a frozen success `payDemSettleCore` returned from the SDK's
own record read, and `undefined` for anything else, including a copy of that
success. `createPayDemRecordReader` adds a reader only by connecting to a
node; every verdict through it is still the SDK's own read of that node.
`createPayDemClientRail` builds a rail only around a client that carries such
a reader.

The settlement store records a bound permanent failure as the definitive
outcome for that key only when it comes from `payDemSettle` over the rail
`createPayDemRail` returned, whose proof the SDK built from the record it
read. A failure proof from any other source, including a custom rail, a rail
that wraps the SDK rail's `settle`, or a reconciler, leaves the intent held
(a custom or wrapping rail is refused before it runs; a client rail's proof
and a reconciler's are held):
it is never a durable verdict and never permits a second broadcast. Neither
outcome ever permits a replacement payment. The proof type is internal; a
custom reconciler can name it as `PayDemReconciledFailure["failureProof"]`.

`runSession` accepts the permanent failure only for a `pay-dem` request in
DEM, with a bound proof whose `amountOs` is the request's amount in OS, on
fresh settlement and on recovery. It treats it as a transaction-bearing
non-success: the hash is bound for anti-replay,
the outcome is recorded, and the session stops as indeterminate.

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
runtime rail or a `createPayDemClientRail` rail, keeps it. That default rail also reports success only after the
SDK's Demos adapter reconciles the wallet journal to `canonical-confirmed`.
Its operator reconciler type, `DacsPayDemBuyerChainReconciliationV1`, carries
no attestation, so an operator reconciler must return `completed` only after
reading a bound `confirmed` record.

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
