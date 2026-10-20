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
| a read that outlasts `statusRequestTimeoutMs` | indeterminate at once; reads never stack |

Indeterminate is `ok: false` with the signed hash retained, so the settlement
intent stays held. No outcome ever causes a second broadcast.

## Budgets

| Option | Default | Bounds |
| --- | --- | --- |
| `inclusionTimeoutMs` | 60 s | waiting for the status index to report `included` |
| `inclusionPollIntervalMs` | 500 ms | the pause between status and record reads |
| `statusRequestTimeoutMs` | 5 s | each single status or record read |
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
  `failureProof` that binds the hash, nonce, block, payer, payee and amount.
- A `PayDemRail` returns `PayDemRailResult`: success carries
  `execution: "executed"`, and a failure never carries `execution`.
  `payDemSettle` refuses a success without the attestation and a failure proof
  that does not bind the payment, and holds the intent in both cases.
- A `PayDemSettlementReconcile` returns a `PayDemReconciledSettlement` with
  `execution: "executed"` only after the same record read, or a
  `PayDemReconciledFailure` for a bound `failed` record. After a restart, a
  durable outcome and a reconciliation that disagree on the transaction, the
  block, success or the failure proof are refused.
- A settlement request carrying `priorAttempts` (which `runSession` sends for
  a session holding a transaction-bearing outcome) is a read-only audit of
  that retained transaction. `payDemSettle` never claims a submit generation
  for it, even when the rail log lost its record, and requires both
  `settlementStore.readOutcome` and `reconcile`. The reconciler then receives a
  `PayDemSettlementAuditContext` with `txHash`, the retained hash in canonical
  form (64 lower-case hex digits, no `0x`). It returns the node's record for
  that hash and, whenever it can load one, the prepared-transfer journal entry
  for that hash as `preparedTransfer`. The hash counts for this payment only
  through one of:
  - that entry, which must name that hash, the same payer, payee, OS amount
    and network, a `recovery` tuple equal to this rail, job and phase, and
    (when present) a known denomination and debit bounds no lower than the
    amount; a permanent failure's proof must also carry the journaled nonce.
    A supplied entry is always checked;
  - the SDK's own record of that hash for the key: the outcome a
    `createIdempotencyStore` rail log recorded under these exact terms, or a
    result this bridge submitted or already bound through an entry or an
    audit. An injected store's `readOutcome` and a reconciler's answer to a
    lookup by key alone never stand in for the entry.

  Otherwise the audit is refused. The reconciler throws when a loaded entry
  conflicts with the record and never returns `null` for the retained hash.
  A journal-less rail's payment fails closed once the SDK record is lost. The
  rail log keeps definitive outcomes only, so its ambiguous result (a signed
  hash with no finalized record) is bound only by the bridge that saw it, and
  after a restart its audit fails closed until the entry is supplied.
  Configure `journalPreparedTransfer` wherever audits must survive a restart.
- A success that the bridge, its rail log or the session recorded is never
  reported unpaid: a reconciliation that contradicts it is refused rather than
  returned as a permanent failure (DACS-4 §9.5.1 PC-7).

The settlement store persists a bound permanent failure as the definitive
outcome for that key. It never permits a replacement payment.

`runSession` accepts the permanent failure only with a bound proof. It treats
it as a transaction-bearing non-success: the hash is bound for anti-replay,
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
failed records.

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
- `getTxByHash` matches the stored lower-case hash exactly and answers any
  other spelling as not found; `getTransactionStatus` lower-cases hex but
  rejects a `0x` prefix as an invalid request. The rail always passes the
  canonical form.

The default `testnet` branch has no `getTransactionStatus`, so against such a
node the rail never observes inclusion and stays indeterminate.

node2 reports 61b8e75, but its `getNetworkInfo` marks the build `dirty`, so its
deployed bytes are not pinned to that commit. The fixture records the
envelopes node2 served; the rail treats any other shape as indeterminate.
