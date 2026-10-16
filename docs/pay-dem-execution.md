# pay-dem execution gate

A Demos node can report a transaction `included` in its status index while its
transaction record says the transaction `failed`, for example with
`TX_NONCE_INVALID_LOW` (#338). Inclusion alone therefore is not settlement.
After the status index reports `included`, `createPayDemRail().settle()` reads
the node's transaction record for the retained signed hash with
`Demos.getTxByHash` and returns `ok: true` only when the record:

- has status `confirmed`;
- is at the observed inclusion block;
- binds the signed hash and nonce; and
- binds the prepared payer, payee and amount.

A `failed` record that binds the same facts is a failed transfer. A
`confirmed` or `failed` record for the signed hash whose nonce, block, payer,
payee or amount does not match, or a read that stalls, is indeterminate at
once. A missing, pending, unreadable or malformed record, or a record that
carries another hash, is read again every `inclusionPollIntervalMs` until
`transactionRecordTimeoutMs` (default 30 seconds) ends, then it is
indeterminate. Every not-ok result keeps the transaction hash, so the
settlement intent stays held, and no path broadcasts again.

## Custom native clients

`payDemSettleCore` accepts any `DemosNativeClient`. It reports success only
when the client's result has `ok: true`, `state: "included"`, a block number
and `execution: "executed"`. `execution: "executed"` is the client's statement
that it read the node's transaction record and that record shows the prepared
transfer executed at that block, as described above. `createPayDemRail` sets
it only after that check. A client that observed only the status index must
leave it out. Its `included` result then returns `ok: false` with no finality,
so the intent stays held and nothing is resubmitted. This includes a client
written before #338, when `included` alone meant success.

The same rule applies to the `reconcile` capability that `payDemSettle` uses
after a restart. A `PayDemSettlementReconcile` returns a settlement only after
it reads the node's transaction record for the hash and finds it `confirmed`
at the inclusion block for the payer, payee and amount, and the settlement
must carry `execution: "executed"`. A `failed` record must throw, like any
other indeterminate observation. `payDemSettle` refuses a reconciliation
without the attestation, so a reconciler written before #338 cannot turn an
included-but-failed transfer into a settlement on recovery; the intent stays
held and nothing is rebroadcast. The attestation is not persisted with the
settlement.

The dacs-node fixed-price buyer reconciler also requires an included
`DemosTransferObservation` to carry `execution: "executed"`. The default
observer sets it only after the transaction record is `confirmed` and its
hash, block, payer, payee and amount have been checked against the confirmed
block and native send payload. Custom observers must do the same check.
Missing or other execution evidence returns `indeterminate` with
`pay-dem-chain-execution-unconfirmed`, keeping the payment held. The
reconciler consumes the attestation; its `completed` settlement omits it to
match the host payment track's storage contract.

## Node behaviour this depends on

The mapping was verified against kynesyslabs/node
`stabilisation@61b8e75aa8db5e408c49e1c3a89db4d673f45578`, the commit node2
(`0.9.9 RC`) reports at `GET /version`, and against `stabilisation@52e2e569`:

| Behaviour | Source |
|---|---|
| `getTransactionStatus` returns `pending`, `included` or `unknown`. It returns `included` for every stored transaction row, failed rows included. `failed` is reserved and never produced. | `src/libs/blockchain/chainTypes.ts` (`TxStatus`), `src/libs/blockchain/chainTransactions.ts` (`getTransactionStatus`) |
| A transaction record's `status` is `confirmed`, `failed` or `pending`. | `src/utilities/constants.ts` (`TRANSACTION_STATUS`) |
| `content.nonce` is a pg `bigint` column and is served as a decimal string. `content.amount` is served as a number up to `Number.MAX_SAFE_INTEGER` and as a decimal string above it; the rail accepts both. | `src/model/entities/Transactions.ts`, `src/libs/blockchain/transaction.ts` (`fromEntityToWireNumber`) |
| `getTxByHash` for an unknown hash returns `{result: 400, response: "error"}` at 61b8e75 and `{result: 404, response: null}` at 52e2e569. demosdk resolves the `response` member, and both are polled. | node2 read; `src/libs/network/handlers/transactionHandlers.ts` at 52e2e569 |

The default branch (`testnet`) has no `getTransactionStatus` and records every
included transaction as `confirmed`; the rail does not support it.
In the SDK source repository (these files are not in the npm package),
`test/fixtures/demos-node2-records.json` holds two records read from node2 at
61b8e75, one `confirmed` and one `failed` with `TX_NONCE_INVALID_LOW`, and
`test/rails/payDemExecutedStatus.test.ts` runs the execution observer on them.
Re-check this table when the deployed node moves to another commit.

## Deviations from DACS-4 at `d45c0a29`

- **Success state.** §9.5.9 step 5 returns success when the transaction reaches
  the terminal `included` state. Current nodes report `included` for failed
  transactions, so the SDK additionally requires a `confirmed` record at that
  block. An implementation that follows the text literally reports a failed
  payment as settled. The Standard needs a revision that defines Demos
  `included` this way, and a vector that pairs an `included` status with a
  `failed` record.
- **Failure class.** §9.5.9 classifies a terminal `failed` transaction as
  `permanent`, and PC-4 requires `ok: false` to carry an `errorClass`.
  `SettleResult` has no `errorClass` for any rail. The session runner holds
  every transaction-bearing not-ok result for reconciliation and never turns
  it into terminal failure evidence on its own; an EVM revert, which surfaces
  as an error after broadcast, is held the same way. A failed pay-dem record
  is therefore reported like an indeterminate one: the intent stays held
  until an operator resolves it. The `reconcile` capability cannot release
  it, because it must throw on a `failed` record (see "Custom native
  clients"), and that throw keeps the intent held. The verdict is one node's
  record, not an independent proof, so it is not used to close the session
  as failed.

## Liveness

Inside one status or record read, demosdk's transport retries a connection
error or an HTTP 502–504 up to four times. For these reads it backs off 250,
500, 1 000 and 2 000 ms. A retry waits up to 8 seconds only when the node
sends `Retry-After` (demosdk 4.0.16 and 4.0.18 `_doPost`). So one transient
error adds about 250 ms. Five fast failures, such as a refused connection or a
quick 502, end the read in about 3.75 seconds with an error result, and the
rail polls again. A read outlasts the 5 second `statusRequestTimeoutMs`
default only in these cases:

- all four retries, whose backoffs add 3.75 seconds, plus the requests' own
  time pass it;
- the node sends a `Retry-After` of 5 seconds or more;
- one response is slow.

The read then counts as stalled, and the settlement is indeterminate and held.
This delays settlement and never causes a second broadcast.
