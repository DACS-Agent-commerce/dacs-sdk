# Native DEM execution gate

The `pay-dem` rail reports a native DEM payment as settled only after the
node's transaction record shows that the signed transfer executed. Inclusion
alone is not enough: a Demos node can include a transaction and record it
`failed`, for example after a stale nonce. node2 serves exactly that case, a
`failed` record whose `getTransactionStatus` is `included` (recorded in
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
demosdk's transport retries a connection error or a 502 to 504 up to four
times inside one read, so one read can take several seconds before the SDK
sees its result.

## Custom clients, rails and reconcilers

The SDK reads the node itself only inside `createPayDemRail`, so only that
rail's verdicts are final. A custom `DemosNativeClient` or `PayDemRail` is the
integrator's own chain access: what it returns is its statement, which the SDK
cannot authenticate, so a fresh result from it never becomes a final verdict.

- `payDemSettleCore` with a custom `DemosNativeClient` reports
  `ok: true`, `bft-final` finality, or a permanent failure only for the client
  `createPayDemRail` builds. Any other client's result, including
  `ok: true, state: "included", execution: "executed"` and a bound
  `failureProof`, is held: `ok: false` with the signed hash and nothing else.
  A malformed result still throws.
- `payDemSettle` treats a `PayDemRail` the same way. Only the `settle`
  function `createPayDemRail` returned (also when a caller places it on its
  own object) yields success or a permanent failure. Any other rail's success
  or failure proof, including a wrapper that relays the SDK rail's genuine
  result, is held as `ok: false` with the hash: never persisted as the
  outcome, and the next call for the key needs reconciliation. A success
  without `execution: "executed"`, a failure that carries `execution`, and a
  failure proof that does not bind the payment are refused, and the intent is
  held in each case.
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
  that retained transaction. `payDemSettle` never claims a submit generation
  for it, even when the rail log lost its record, and requires both
  `settlementStore.readOutcome` and `reconcile`. The reconciler then receives a
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
  in-memory log does). The rail records the signed hash before its one
  broadcast and does not broadcast when the record is refused; `payDemSettle`
  also records any hash a rail returns before the store persists or returns
  it, and a refused write fails the call and leaves the hash unbound. A custom
  rail must record the exact hash it will return before it broadcasts: the
  bridge's write after the return cannot cover a crash in between. The write is
  compare-and-set under the submit generation and the record never changes. A
  crash after broadcast, a timeout or an ambiguous result therefore still lets
  a restarted process audit the payment. A durable log needs the pair: over a
  log without it, audits after a restart fail closed.

  A supplied entry is always checked: it must name that hash, the same payer,
  payee, OS amount and network, a `recovery` tuple equal to this rail, job and
  phase, and (when present) a known denomination and debit bounds no lower
  than the amount; a permanent failure's proof must also carry the journaled
  nonce. The entry is the reconciler's object, not the one the rail wrote
  before broadcast, so it can refuse an audit but never counts the hash on its
  own. Nor does an injected store's records, or any rail-log outcome, which a
  key-only restart reconciliation can have written. The reconciler throws
  when a loaded entry conflicts with the record and never returns `null` for
  the retained hash.
- A restart without history reconciles in the store. With an attempt record
  the reconciler receives its hash as `txHash`, and any other transaction is
  refused. Without one, the reconciler's answer for the key is still accepted
  and saved, so that path relies on the reconciler to look up this exact
  payment, but the saved outcome never binds a later audit.
- A success that the bridge, its rail log or the session recorded is never
  reported unpaid: a reconciliation that contradicts it is refused rather than
  returned as a permanent failure (DACS-4 §9.5.1 PC-7).

Which capabilities the SDK built is kept private to the rails module, keyed
by object identity. No file in the package exports a way to add to it; the
only export is a read-only check the settlement store uses.

The settlement store records a bound permanent failure as the definitive
outcome for that key only when it comes from `payDemSettle` over the rail
`createPayDemRail` returned, whose proof the SDK built from the record it
read. A failure proof from any other source, including a custom rail, a rail
that wraps the SDK rail's `settle`, or a reconciler, leaves the intent held:
it is never a durable verdict and never permits a second broadcast. Neither
outcome ever permits a replacement payment. The proof type is internal; a
custom reconciler can name it as `PayDemReconciledFailure["failureProof"]`.

`runSession` accepts the permanent failure only for a `pay-dem` request in
DEM, with a bound proof whose `amountOs` is the request's amount in OS, on
fresh settlement and on recovery. It treats it as a transaction-bearing
non-success: the hash is bound for anti-replay,
the outcome is recorded, and the session stops as indeterminate.

The dacs-node buyer track requires `execution: "executed"` on fresh rail
results before it settles the wallet authority or publishes a payment notice.
Its default runtime rail also reports success only after the SDK's Demos
adapter reconciles the wallet journal to `canonical-confirmed`, which needs a
`confirmed` record it read; a rail injected into the buyer track directly is
the host's statement.
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
  `{result: 404, response: null}` at 52e2e569.
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
