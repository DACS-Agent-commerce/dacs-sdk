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
`["native", {nativeOperation: "send", args: [payee, amount]}]`. Other fields, such as `signature`, `gcr_edits` or `attrs`, are not
read.

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

## Contracts for custom clients, rails and reconcilers

- A `DemosNativeClient` resolves `ok: true, state: "included",
  execution: "executed"` only after it has read and bound a `confirmed`
  record. Without `execution: "executed"`, `payDemSettleCore` reports not-ok
  and mints no finality. A `failed` result is permanent only with a
  `failureProof` whose hash, block, payer, payee and amount match the
  payment. Its `nonce` is checked against the transfer the client journaled
  when the caller passes a per-settlement `journalPreparedTransfer`; without
  one, the nonce is the client's statement, as `execution` is.
  `createPayDemRail` fills it from the signed transaction.
- A `PayDemRail` returns `PayDemRailResult`: success carries
  `execution: "executed"`, and a failure never carries `execution`.
  `payDemSettle` refuses a success without the attestation and a failure proof
  that does not bind the payment, and holds the intent in both cases. It has
  no signed nonce of its own, so a rail's proof nonce is the rail's statement.
- A `PayDemSettlementReconcile` returns a `PayDemReconciledSettlement` with
  `execution: "executed"` only after the same record read, or a
  `PayDemReconciledFailure` for a bound `failed` record. After a restart, a
  durable outcome and a reconciliation that disagree on the transaction, the
  block, success or any failure-proof field, the nonce included, are refused.

The settlement store persists a bound permanent failure as the definitive
outcome for that key. It never permits a replacement payment.

`runSession` accepts the permanent failure only for a `pay-dem` request in
DEM, with a bound proof whose `amountOs` is the request's amount in OS, on
fresh settlement and on recovery. It treats it as a transaction-bearing
non-success: the hash is bound for anti-replay,
the outcome is recorded, and the session stops as indeterminate.

The dacs-node buyer track requires `execution: "executed"` on fresh rail
results before it settles the wallet authority or publishes a payment notice.
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
`stabilisation@52e2e569`:

- `getTransactionStatus` reports `included` for every stored row, failed ones
  too, and never reports `failed`;
- the record `status` is `confirmed`, `failed` or `pending`;
- `content.nonce` is served as a decimal string, and `content.amount` as a
  number up to `Number.MAX_SAFE_INTEGER` and a decimal string above it;
- not-found is `{result: 400, response: "error"}` at 61b8e75 and
  `{result: 404, response: null}` at 52e2e569.

The default `testnet` branch has no `getTransactionStatus`, so against such a
node the rail never observes inclusion and stays indeterminate.

node2 reports 61b8e75, but its `getNetworkInfo` marks the build `dirty`, so its
deployed bytes are not pinned to that commit, and its build time has changed
between reads. The fixture is a set of envelopes node2 served on the dates it
records, not a pin of a deployment. The rail does not depend on that build:
a record without the fields listed above, or with any of them different,
is indeterminate.
