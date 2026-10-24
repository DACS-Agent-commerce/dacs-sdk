# pay-dem execution gate

A Demos node can report a transaction `included` in its status index while its
transaction record says the transaction `failed`, for example with
`TX_NONCE_INVALID_LOW` (#338). Inclusion alone therefore is not settlement.
After the status index reports `included`, `createPayDemRail().settle()` reads
the node's transaction record for the retained signed hash using one bounded
read-only `getTxByHash` RPC request per poll (64 KiB limit and a request
deadline). It returns `ok: true` only when the record:

- has status `confirmed`;
- is at the observed inclusion block;
- binds the signed hash and nonce; and
- binds the prepared payer, payee and amount.

A `confirmed` record says only that the node applied the transaction's own
`content.gcr_edits`. The node applies a native transaction whose `gcr_edits` are
absent or empty as a successful no-op and still records it `confirmed`, so a
matching status and send body do not by themselves show that value moved. The
rail does not parse the record's `gcr_edits`. It relies on the transaction it
signed: demosdk's `sign` derives the edits (payer debit, payee credit, fee and
nonce) from the send body and hashes them into the signed hash, so a `confirmed`
record for that hash is the node's statement that it applied those edits. A
client that does not sign this way must check the edits itself; see [Custom
native clients](#custom-native-clients).

A `failed` record that binds the same facts is a failed transfer. A `confirmed`
or `failed` record for the signed hash whose nonce, block, payer, payee or
amount does not match, or a read that stalls, is indeterminate at once. Decoded
records exceeding depth, node or collection limits are indeterminate at once. A
missing, pending, unreadable or malformed record, or a record that carries
another hash, is read again every `inclusionPollIntervalMs` until
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
path and retain the original signed-transfer journal. A bound failed record may
replace an old successful rail checkpoint lacking execution authentication with
permanent failure for the same transaction. Fresh native success and a
successful audit durably mark execution authentication; a later contradictory
failure is refused. A renewable session lease spans native recheck and evidence
publication, and a lost lease or changed revision aborts completion. Already
signed success evidence that contradicts execution is refused; the SDK does not
rewrite it or complete the session. Absent, indeterminate or conflicting
observations withhold success and never authorize a replacement debit. The
original fee metadata is retained after a successful audit, and every subsequent
restart authenticates execution again.

For a request carrying `priorAttempts`, `payDemSettle` performs only this audit;
it never calls the submit-capable idempotency claim, even if the rail log has
lost its record. The complete history must contain 1–256 entries for the same
native hash and network. The reconciler receives the canonical retained hash in
`context.txHash` and must bind it to the original journal's signed nonce and
payment tuple before reading execution. Missing or conflicting journals must
throw. An executed result or bound permanent failure must name that same hash.
Repeated calls audit again without relying on an in-memory success cache. Once
this bridge has retained an audit identity, later calls for the same key remain
read-only even if they omit history; conflicting terms or hashes are refused. A
bridge retains at most 1,024 audit identities and never evicts them to restore
submission authority. At capacity it refuses new keys, including requests that
omit history; existing keys remain auditable.

Native retained recovery requires `SettlementIdempotencyStore.readOutcome(key,
binding)`; `createIdempotencyStore` implements it using the backing log's
`readOutcome(key)`. The log returns an immutable `SettlementOutcomeRecord`, a
binding-only `{ bindingHash }` for a pending or released intent, or `null` for
an absent key, without acquiring or renewing a lease, changing a generation or
writing an outcome. Legacy custom stores/logs may still use `once`, but must
provide this lookup before retained recovery can proceed. Missing capability or
malformed lookup data throws. The store validates the binding hash, parties and
finality; the native bridge compares the retained hash against its in-process
identity and the recorded outcome, then reads the log again after auditing
execution. Different hashes, blocks or permanent proofs throw without returning
a terminal failure or overwriting the rail log. An authenticated success cannot
become a permanent failure for that same transaction. Same-key bridge calls are
serialized so a slow submission cannot be overtaken by a conflicting audit;
different keys remain independent. An empty log never grants another submission
during audit.

## Custom native clients

`payDemSettle` accepts only frozen rails returned by `createPayDemRail`. Custom
rails are refused before a submission claim or native effect. The custom
integration contract below describes independent native integrations and the
dacs-node buyer payment track.

Custom `PayDemRail` implementations return `PayDemRailResult`. A successful
fresh result must carry `execution: "executed"`, attesting that the rail read
the transaction record and checked literal `confirmed` status, signed hash,
nonce, inclusion block, payer, payee and amount, and that the record's
`content.gcr_edits` move that amount: a `balance` `remove` of the amount from
the payer and a `balance` `add` of the amount to the payee. The record may carry
other edits as well, such as the fee and nonce edits demosdk derives. A
`confirmed` record whose edits lack that `remove` or that `add`, including
absent or empty edits, moved no value, and the rail must leave `execution` out.
Status-index inclusion alone must return a not-ok result retaining the hash.
Both `payDemSettle` and the dacs-node buyer payment track refuse a fresh success
without this literal attestation before completing settlement, recording wallet
debits or publishing a payment notice. The intent remains held for
reconciliation. The attestation is removed before durable settlement storage and
notice publication; the rail bridge and buyer payment track require fresh
execution authentication when recovering stored results.

`payDemSettleCore` accepts only the SDK factory's private native client and
refuses custom clients before calling `transfer`. Success requires the SDK's own
verified transaction-record verdict as well as `ok: true`, `state: "included"`,
a block number and `execution: "executed"`. `createPayDemRail` produces that
verdict only after the record checks at the top of this guide, for a transaction
it signed with demosdk. A literal flag, an invented failure proof or a copied
capability cannot issue that verdict. The private verdict is not serialized with
durable settlement results.

The same rule applies to the `reconcile` capability that `payDemSettle` uses
after a restart. A `PayDemSettlementReconcile` returns a settlement only after
it reads the node's transaction record for the hash and finds it `confirmed` at
the inclusion block for the payer, payee and amount, with `gcr_edits` that debit
the payer and credit the payee that amount, and the settlement must carry
`execution: "executed"`. A bound `failed` record may instead return `ok: false`,
`errorClass: "permanent"`, the exact requested `amountOs`, and the same
`failureProof` described above. An indeterminate observation must throw.
`payDemSettle` refuses a successful reconciliation without the execution
attestation, so a reconciler written before #338 cannot turn an
included-but-failed transfer into a settlement on recovery; the intent stays
held and nothing is rebroadcast. The attestation is not persisted with the
settlement.

The dacs-node fixed-price buyer reconciler also requires an included
`DemosTransferObservation` to carry `execution: "executed"`. The default
observer sets it only after the transaction record is `confirmed` and its hash,
nonce, block, payer, payee and amount have been checked against the confirmed
block and native send payload. Like the rail, it does not parse the record's
`gcr_edits`. It carries the validated record nonce as a safe non-negative
integer `nonce`. The buyer reconciler requires that value to equal the retained
prepared transfer's signed nonce before returning `completed`; missing or
conflicting nonces require operator recovery. Custom observers must supply the
same checked nonce, and must check the record's `gcr_edits` as described for
custom clients. An included observation that matches the retained payment but
whose `execution` is missing or is not `"executed"` returns `indeterminate` with
`pay-dem-chain-execution-unconfirmed`, keeping the payment held. The reconciler
forwards the attestation with its `completed` settlement. The host payment track
checks it and removes it before settlement storage and notice publication.
Seller intake and wallet recovery authentication also require literal
`execution: "executed"` before delivery or settlement accounting.

The default observer does not check `gcr_edits`. On seller intake, the seller
did not sign the buyer's transaction, so the attestation relies on the node's
mempool admission re-deriving the edits from the body and refusing a mismatch
(see the table below). This is a dependency on node admission, rather than an
independent seller-side edit check.

Wallet recovery independently requires the observed nonce to be a safe
non-negative integer equal to the prepared nonce; missing, malformed,
negative-zero or conflicting values retain the wallet hold and leave both
service and fee accounting unchanged.

## Node behaviour this depends on

The mapping was verified against kynesyslabs/node
`stabilisation@61b8e75aa8db5e408c49e1c3a89db4d673f45578`, the commit node2
(`0.9.9 RC`) reports at `GET /version`, and against
`stabilisation@52e2e5698bd9785ddd709de33e4709d5dd7bc308`:

| Behaviour | Source |
|---|---|
| `getTransactionStatus` returns `pending`, `included` or `unknown`. It checks the mempool first (`pending`), then returns `included` for a stored transaction row not found there, failed rows included. `failed` is reserved and never produced. | `src/libs/blockchain/chainTypes.ts` (`TxStatus`), `src/libs/blockchain/chainTransactions.ts` (`getTransactionStatus`) |
| A transaction record's `status` is `confirmed`, `failed` or `pending`. | `src/utilities/constants.ts` (`TRANSACTION_STATUS`) |
| `content.nonce` is a pg `bigint` column and is served as a decimal string. `content.amount` is served as a number up to `Number.MAX_SAFE_INTEGER` and as a decimal string above it; the rail accepts both. | `src/model/entities/Transactions.ts`, `src/libs/blockchain/transaction.ts` (`fromEntityToWireNumber`) |
| `getTxByHash` for an unknown hash returns `{result: 400, response: "error"}` at 61b8e75 and `{result: 404, response: null}` at 52e2e569. The bounded record reader refuses either non-200 result as a failed read; the rail polls again. | node2 read; `src/libs/network/handlers/transactionHandlers.ts` at 52e2e569 |
| A transaction whose `content.gcr_edits` are absent or empty is applied as a successful no-op, and a successfully applied transaction is recorded `confirmed`. Mempool admission of a received native transaction re-derives its edits from the body and refuses a mismatch; apply repeats that check only for a non-empty edit list. | `src/libs/blockchain/gcr/handleGCR.ts` (`applyTransaction`), `src/libs/consensus/v2/PoRBFT.ts`, `src/libs/blockchain/mempool.ts` (`receive`) at 61b8e75 |

The `testnet` snapshot at `ac8f45f02fc9c25082ce9b83595c2e3916b49c5a` has no
`getTransactionStatus` and records every included transaction as `confirmed`;
the rail does not support it. In the SDK source repository (these files are not
in the npm package), `test/fixtures/demos-node2-records.json` holds two records
read from node2 at 61b8e75, one `confirmed` and one `failed` with
`TX_NONCE_INVALID_LOW`, and `test/rails/payDemExecutedStatus.test.ts` runs the
execution observer on them. The saved 2026-10-18 build metadata also reports
`nodeVersion.dirty: true`. The reported commit identifies a reference for the
observed schemas; it does not reproduce the deployed source tree's unspecified
local changes. The fixture retains the complete observed version and
network-info envelopes. Exact source reproducibility requires a clean deployment
commit or a source-tree digest. Re-check this table and the read-only response
shapes before treating another deployment as compatible.

## Deviations from DACS-4 at `d45c0a29`

- **Success state.** §9.5.9 step 5 returns success when the transaction reaches
  the terminal `included` state. Current nodes report `included` for failed
  transactions, so the SDK additionally requires a `confirmed` record at that
  block. An implementation that follows the text literally reports a failed
  payment as settled. The Standard needs a revision that defines Demos
  `included` this way, and a vector that pairs an `included` status with a
  `failed` record. Standard PR #432 must merge before the SDK pin can move. The
  superseded 10-vector draft and its candidate runner are deferred. The
  alignment change must pin the merged revision and run every vector of the
  `pay-dem-execution-v0.1` and `settlement-finality-verification` sets at that
  revision, each identified by its `count` and `hash` there; it must not assume
  a count from an unmerged revision.
- **Indeterminate result class.** PC-4 requires every not-ok outcome to carry
  an `errorClass`, and §9.5.9 maps node or RPC unavailability to `substrate`.
  An indeterminate pay-dem result is `ok: false` with no `errorClass`. The
  session saves it as unresolved recovery history, throws, and keeps the
  intent held. It records no terminal failure and authorizes no replacement
  payment.

A bound terminal failed record maps to `permanent`, as §9.5.9's failure modes
require for a transaction that reaches terminal `failed` on-chain. The SDK takes
`failed` from the transaction record, because the status index never reports it,
and preserves `permanent` through the rail result, durable outcome and session
resume. The proof is an authenticated node observation under the rail's existing
trust model; malformed or mismatched proof cannot close a session. Failure
evidence omits settlement finality. This does not release wallet reservations
automatically: a failed transaction can have fee effects that require separate
accounting.

## Liveness

Inside one status read, demosdk's transport retries a connection error
(`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT` or `ENOTFOUND`) or an HTTP 502–504 up
to four times; other errors are not retried. Before retry *n* it waits
250·2^(n−1) ms (250, 500, 1 000 and 2 000 ms), or, when the node sends
`Retry-After`, that wait capped at 8 seconds instead (demosdk 4.0.16 and 4.0.18
`_doPost`). So one transient error adds about 250 ms, and five fast failures,
such as a refused connection or a quick 502, end the read in about 3.75 seconds
with an error result, and the rail polls again. A read outlasts the 5 second
`statusRequestTimeoutMs` default when its waits and the requests' own time add
up to 5 seconds or more: for example all four backoffs plus slow requests, one
`Retry-After` of 5 seconds, two of 3 seconds, or one slow response. The read
then counts as stalled, and the settlement is indeterminate and held. This
delays settlement and never causes a second broadcast.

Record requests have no transport retries: one connection error or HTTP 503
fails that read immediately. The rail can poll again after
`inclusionPollIntervalMs` within the remaining `transactionRecordTimeoutMs`
budget. The bounded reader caps each response at 64 KiB and aborts at its
request deadline.
