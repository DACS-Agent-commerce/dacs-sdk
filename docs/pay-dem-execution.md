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
indeterminate. Every not-ok result keeps the transaction hash. A bound failed
record carries `errorClass: "permanent"` and a `failureProof` containing its
hash, signed nonce, block, payer, payee and OS amount. Rail and session stores
persist this terminal outcome and return it on resume without another debit.
Unproven or conflicting results keep the intent held. Neither path broadcasts
again; terminal failure does not authorize a replacement payment. This also
applies after failure evidence was anchored, including when the anchor's
acknowledgment was lost. Reuse requires the anchored transaction and block to
match the retained permanent proof. Configured network labels such as
`demos:testnet` are bound by the rail's recovery context and durable outcome.

When the rail authenticates the payer's total debit, a successful result may
include `networkFeeOs`, a canonical non-negative integer OS string. Session
checkpoints retain this fee across restart; the evidence's payment amount
continues to describe the agreed transfer amount.

Session recovery also reauthenticates every saved native-payment success through
`resumeSettlement`, including older inclusion-only checkpoints and previously
anchored success evidence. Wire that seam to the durable `payDemSettle` recovery
path and retain the original signed-transfer journal. A bound failed record
replaces an old successful rail checkpoint with permanent failure for the same
transaction. Already signed success evidence that contradicts execution is
refused; the SDK does not rewrite it or complete the session. Absent,
indeterminate or conflicting observations withhold success and never authorize
a replacement debit. The original fee metadata is retained after a successful
audit, and every subsequent restart authenticates execution again.

## Custom native clients

Custom `PayDemRail` implementations return `PayDemRailResult`. A successful
fresh result must carry `execution: "executed"`, attesting that the rail read
the transaction record and checked literal `confirmed` status, signed hash,
nonce, inclusion block, payer, payee and amount. Status-index inclusion alone
must return a not-ok result retaining the hash. Both `payDemSettle` and the
dacs-node buyer payment track refuse a fresh success without this literal
attestation before completing settlement, recording wallet debits or publishing
a payment notice. The intent remains held for reconciliation. The attestation
is removed before durable settlement storage and notice publication; the rail
bridge and buyer payment track require fresh execution authentication when
recovering stored results.

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
must carry `execution: "executed"`. A bound `failed` record may instead return
`ok: false`, `errorClass: "permanent"`, the exact requested `amountOs`, and the
same `failureProof` described above. An indeterminate observation must throw.
`payDemSettle` refuses a successful reconciliation without the execution
attestation, so a reconciler written before #338 cannot turn an
included-but-failed transfer into a settlement on recovery; the intent stays
held and nothing is rebroadcast. The attestation is not persisted with the
settlement.

The dacs-node fixed-price buyer reconciler also requires an included
`DemosTransferObservation` to carry `execution: "executed"`. The default
observer sets it only after the transaction record is `confirmed` and its
hash, nonce, block, payer, payee and amount have been checked against the
confirmed block and native send payload. It carries the validated record nonce
as a safe non-negative integer `nonce`. The buyer reconciler requires that value
to equal the retained prepared transfer's signed nonce before returning
`completed`; missing or conflicting nonces require operator recovery. Custom
observers must supply the same checked nonce.
Missing or other execution evidence returns `indeterminate` with
`pay-dem-chain-execution-unconfirmed`, keeping the payment held. The
reconciler forwards the attestation with its `completed` settlement. The host
payment track checks it and removes it before settlement storage and notice
publication. Seller intake and wallet recovery authentication also require
literal `execution: "executed"` before delivery or settlement accounting.
Wallet recovery independently requires the observed nonce to be a safe
non-negative integer equal to the prepared nonce; missing, malformed,
negative-zero or conflicting values retain the wallet hold and leave both
service and fee accounting unchanged.

## Node behaviour this depends on

The mapping was verified against kynesyslabs/node
`stabilisation@61b8e75aa8db5e408c49e1c3a89db4d673f45578`, the commit node2
(`0.9.9 RC`) reports at `GET /version`, and against `stabilisation@52e2e569`:

| Behaviour | Source |
|---|---|
| `getTransactionStatus` returns `pending`, `included` or `unknown`. It checks the mempool first (`pending`), then returns `included` for a stored transaction row not found there, failed rows included. `failed` is reserved and never produced. | `src/libs/blockchain/chainTypes.ts` (`TxStatus`), `src/libs/blockchain/chainTransactions.ts` (`getTransactionStatus`) |
| A transaction record's `status` is `confirmed`, `failed` or `pending`. | `src/utilities/constants.ts` (`TRANSACTION_STATUS`) |
| `content.nonce` is a pg `bigint` column and is served as a decimal string. `content.amount` is served as a number up to `Number.MAX_SAFE_INTEGER` and as a decimal string above it; the rail accepts both. | `src/model/entities/Transactions.ts`, `src/libs/blockchain/transaction.ts` (`fromEntityToWireNumber`) |
| `getTxByHash` for an unknown hash returns `{result: 400, response: "error"}` at 61b8e75 and `{result: 404, response: null}` at 52e2e569. demosdk resolves the `response` member, and both are polled. | node2 read; `src/libs/network/handlers/transactionHandlers.ts` at 52e2e569 |

The `testnet` snapshot at `ac8f45f02fc9c25082ce9b83595c2e3916b49c5a` has no
`getTransactionStatus` and records every
included transaction as `confirmed`; the rail does not support it.
In the SDK source repository (these files are not in the npm package),
`test/fixtures/demos-node2-records.json` holds two records read from node2 at
61b8e75, one `confirmed` and one `failed` with `TX_NONCE_INVALID_LOW`, and
`test/rails/payDemExecutedStatus.test.ts` runs the execution observer on them.
The saved 2026-10-18 build metadata also reports `nodeVersion.dirty: true`.
The reported commit identifies a reference for the observed schemas; it does
not reproduce the deployed source tree's unspecified local changes. The fixture
retains the complete observed version and network-info envelopes. Exact source
reproducibility requires a clean deployment commit or a source-tree digest.
Re-check this table and the read-only response shapes before treating another
deployment as compatible.

## Deviations from DACS-4 at `d45c0a29`

- **Success state.** §9.5.9 step 5 returns success when the transaction reaches
  the terminal `included` state. Current nodes report `included` for failed
  transactions, so the SDK additionally requires a `confirmed` record at that
  block. An implementation that follows the text literally reports a failed
  payment as settled. The Standard needs a revision that defines Demos
  `included` this way, and a vector that pairs an `included` status with a
  `failed` record. The proposed cross-repository change is in
  [standard-next/pay-dem-execution.patch](standard-next/pay-dem-execution.patch);
  it must be published by the Standard repository before the SDK pin can move.
- **Failure class.** A bound terminal failed record now preserves `permanent`
  through the rail result, durable outcome and session resume. The proof is
  an authenticated node observation under the rail's existing trust model;
  malformed or mismatched proof cannot close a session. Failure evidence omits
  settlement finality. This does not release wallet reservations automatically:
  a failed transaction can have fee effects that require separate accounting.

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
