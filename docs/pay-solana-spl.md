# Solana SPL settlement safety core

The SDK exposes a dependency-free `pay-solana-spl` settlement core for the
DACS-4 §9.5.3 safety boundary. It does not bundle a Solana wallet or RPC
client. Applications inject those capabilities behind `SolanaSplAdapter` and
persist state through `SolanaSplSettlementStore`.

The core:

- binds the agreement, selected rail, payer, payee, mint, amount, decimals,
  cluster, commitment and phase into one immutable intent, keyed by a
  canonical CORE JID-1 `jobId`;
- converts the canonical DACS amount into exact integer token base units,
  within the SPL `u64` range;
- requires SPL Token `TransferChecked` and records its exact instruction
  index; Token-2022 mints are not supported;
- pays only the payee's associated token account, which it derives itself;
- refuses a signed durable-nonce transaction before it is retained;
- refuses to create a missing associated token account unless the selected
  authority explicitly permits it, and charges its rent to the payer;
- checks token, network-fee and optional rent balances before signing, and
  that the payer ends at zero lamports or at least its rent-exempt minimum;
- persists the complete signed transaction before any broadcast;
- reconciles the retained signature before rebroadcast or replacement;
- permits a replacement signature only after authenticated, `finalized`
  blockhash-expiry evidence is durably recorded;
- closes the key as `failed` when the chain refused the retained transfer at
  `finalized` commitment;
- reports a preflight RPC failure, before anything is signed, as
  `transient`, and keeps the key open for the retry;
- checks the durable generation fence before and after each wallet/RPC call,
  while requiring adapters to recheck the supplied fence immediately before
  each authority-bearing side effect; and
- emits `solana-instruction` coordinates only after the exact transfer reaches
  at least the selected commitment level.

```ts
import {
  advanceSolanaSplSettlement,
  type SolanaSplAdapter,
  type SolanaSplSettlementStore,
} from "@kynesyslabs/dacs/rails";

const result = await advanceSolanaSplSettlement({
  authority: {
    jobId,
    phaseIndex: 2,
    railId,
    railDescriptorHash,
    agreementHash,
    assetKind: "spl",
    cluster: "devnet",
    commitmentLevel: "confirmed",
    payer,
    payee,
    mint,
    assetSymbol: "USDC",
    currency: "USDC",
    amount: "1.25",
    tokenDecimals: 6,
    createPayeeAtaIfMissing: false,
  },
  owner: workerId,
  adapter: solanaAdapter satisfies SolanaSplAdapter,
  store: durableStore satisfies SolanaSplSettlementStore,
});
```

## Results

`advanceSolanaSplSettlement` never rejects. Every refusal, store or adapter
failure and out-of-contract value (an unknown status or disposition, a
missing field, a throwing getter) is classified, and `reason` is always one of
the fixed codes below. Adapter, RPC, store and caller text never appears in a
result.

- `settled`: the exact transfer reached at least the intent's commitment
  level and the store recorded it. Commitment only strengthens
  (`processed` < `confirmed` < `finalized`), so a transfer first observed at
  `finalized` settles a `confirmed` intent. `finalityCommitmentLevel` is
  always the intent's level, the rail parameter the Standard sources it
  from; one observed below that level is `waiting`.
- `waiting`: resume the same authority later.
- `indeterminate`: the phase may be paid, or a retained transfer may still
  land. Resume the same authority, or resolve the store or adapter problem out
  of band. A transfer that landed but does not match the intent
  (`solana-spl-settled-instruction-mismatch`, `solana-spl-settled-different`)
  is reported here, because funds may have moved.
- `transient`: a preflight read failed, or authenticated no-submission
  evidence proves a preparation RPC failure, congestion or timeout. The call
  left no transaction able to land, and every retained attempt had durable
  `finalized` expiry evidence, so nothing under the key can land. The key stays open:
  retry the same authority. It never authorizes paying the phase another way.
- `failed`: nothing under this settlement key moved tokens or can land. The
  store shows no retained attempt, or every retained attempt with complete,
  durably acknowledged `finalized` expiry evidence, except that the latest
  may instead have landed and been refused by the chain at `finalized`
  commitment (`solana-spl-transfer-failed-on-chain`). The store has closed
  the key.

`failed` is terminal, and the phase may be paid by another route. The core
reports it only after the store has acknowledged `recordFailure`, one atomic
write under the current lease generation that closes the key. Every later
call for the same key, from any worker, returns the same `failed` result from
the store's `failed` claim without calling the adapter, signing or
broadcasting. A payer that tops up its balance or a payee that creates its
token account cannot resume the closed key: paying the phase again needs a
new phase, and so a new settlement key. If the close is not acknowledged, the
result is `indeterminate` (`solana-spl-failure-persistence-uncertain`), never
`failed`.

| Status | Reason codes |
|---|---|
| `failed` / `permanent` | `solana-spl-insufficient-token-balance`, `solana-spl-insufficient-network-fee-balance`, `solana-spl-insufficient-ata-rent-and-fee-balance`, `solana-spl-transfer-failed-on-chain`, `solana-spl-invalid-signature` |
| `failed` / `counterparty` | `solana-spl-payee-ata-missing`, `solana-spl-payee-ata-binding-mismatch` |
| `transient` | `solana-spl-preflight-unavailable`, `solana-spl-preparation-rpc-failure`, `solana-spl-preparation-congestion`, `solana-spl-preparation-timeout` |
| `waiting` | `solana-spl-settlement-held`, `solana-spl-reconciliation-pending`, `solana-spl-broadcast-not-yet-visible` |
| `indeterminate`, before the store is read | `solana-spl-authority-invalid`, `solana-spl-runtime-policy-invalid`, `solana-spl-dependencies-invalid`, `solana-spl-settlement-store-unavailable` |
| `indeterminate`, store claim | `solana-spl-settlement-store-claim-invalid`, `solana-spl-settlement-store-conflict`, `solana-spl-settlement-store-corrupt`, `solana-spl-settlement-store-intent-mismatch`, `solana-spl-settlement-store-intent-invalid`, `solana-spl-settlement-store-lease-invalid`, `solana-spl-stored-settlement-mismatch`, `solana-spl-retained-state-corrupt` |
| `indeterminate`, reconciliation | `solana-spl-reconciliation-unavailable`, `solana-spl-reconciliation-invalid`, `solana-spl-reconciliation-indeterminate`, `solana-spl-absence-proof-invalid`, `solana-spl-expiry-proof-invalid`, `solana-spl-landed-failure-proof-invalid`, `solana-spl-expiry-persistence-uncertain`, `solana-spl-expiry-transition-raced`, `solana-spl-rebroadcast-unavailable`, `solana-spl-predecessor-landed-failed`, `solana-spl-other-attempt-unresolved` |
| `indeterminate`, a transfer landed | `solana-spl-settled-instruction-mismatch`, `solana-spl-settled-different`, `solana-spl-settlement-persistence-uncertain`, `solana-spl-multiple-settlements` |
| `indeterminate`, new attempt | `solana-spl-preflight-unavailable`, `solana-spl-preflight-invalid`, `solana-spl-payee-ata-not-associated`, `solana-spl-payer-rent-state-unknown`, `solana-spl-failure-persistence-uncertain`, `solana-spl-preparation-unavailable`, `solana-spl-prepared-transaction-invalid`, `solana-spl-retained-attempt-persistence-uncertain`, `solana-spl-broadcast-unavailable`, `solana-spl-new-attempt-expired-before-observation` |

A store `conflict` (another binding already holds the same job, rail and
phase) or `corrupt` claim is `indeterminate`, not `failed`: that record may
hold a broadcast this call cannot inspect, so it must be resolved out of band.
`solana-spl-failure-persistence-uncertain` also covers a close after an
on-chain refusal that the store did not acknowledge.
`solana-spl-preflight-unavailable` is `transient` when the preflight read
itself failed, and `indeterminate` when the lease was lost around it, whether
the read then returned or failed, because another worker may then be signing.
`solana-spl-predecessor-landed-failed` is a predecessor with `confirmed`
expiry evidence from an earlier version that the chain has since refused at
`finalized`, with no matching settlement found among its successors. Recovery
checks every successor without broadcasting or signing. A matching settlement
may close the key only after all other attempts have finalized expiry or
finalized refusal evidence. If every attempt was conclusively refused or expired
and none paid, this legacy recovery path still leaves the key open. Reconcile
and close the key manually through the durable store, under its current lease,
retaining finalized refusal or expiry evidence for every attempt before
authorizing another payment route. Repeating the same call alone cannot
resolve this case. `solana-spl-other-attempt-unresolved` means another
attempt may still land after either a payment or a refusal;
`solana-spl-multiple-settlements` means at least two
matching payments were observed. Both keep the key open for reconciliation
or out-of-band resolution, with no new payment authorized.

### Reporting to the phase handler

DACS-4 PC-4 classifies a payment phase as `ok: true`, or `ok: false` with an
`errorClass`. Map each result as follows:

| Result | `PhaseHandlerResult` |
|---|---|
| `settled` | `ok: true`, with `txRefs: [settlement.txRef]` and `settlementFinality`. Anchoring then follows PC-7. |
| `failed` | `ok: false` with the result's `errorClass`: `permanent` or `counterparty`. The phase may be paid another way. |
| `transient` | `ok: false` with `errorClass: "transient"` (PC-4: RPC failure). Retry the same authority; never pay the phase another way. |
| `waiting` | Not a phase outcome. Keep the session non-terminal and resume the same authority. |
| `indeterminate` | Not a phase outcome. Keep the session non-terminal: PC-7 reconciliation of the original binding, by resuming or out of band. |

`transient` is the one result that may count against a retry budget. The
core returns it only when the call left no transaction able to land and every
retained attempt already has durable `finalized` expiry evidence, so a retry
of the same key cannot pay twice. The key is not closed, so the retry
continues it. If the budget runs out and the session ends `failed-perm`
(DACS-5), nothing under the key has landed, but the key is still open: do not
resume it after the session is terminal.

PC-4's invalid-signature, RPC-failure and §9.5.3 congestion/timeout outcomes
are available after an unsuccessful preparation through the optional
`adapter.proveNoSubmission(plan, attempt, fence)` method. It must authenticate
a wallet audit proving that the preparation left no transaction submitted or
able to land, including any work done before an exception or malformed reply.
It returns `null` when that cannot be proved. A broadcast rejection, missing
RPC result, local parser refusal or wallet exception alone is insufficient.
The proof binds `authorityHash`, `attempt`, lease `owner` and `generation`,
the `failure` and `authenticationHash`. The hash commits to those fields and
the authenticated audit. The core checks plain-data shape and these bindings,
not audit authenticity; the adapter is the authentication boundary. It checks
the fence again after the proof returns. Existing adapters may omit the
method, in which case uncertain preparation remains `indeterminate`.

A proven `invalid-signature` closes the key through `recordFailure` as
`failed` / `permanent` (`solana-spl-invalid-signature`), retaining the proof.
Proven `rpc-failure`, `congestion` and `timeout` return `transient`, leaving
the key open for the same authority. These paths are reached only after every
retained attempt has durable finalized expiry evidence. The proof method is
never used after broadcast. A production adapter must implement authenticated
no-submission auditing to provide these preparation classifications.

After broadcast, `waiting` and `indeterminate` are reconciliation states,
with no phase outcome yet. Keep the phase non-terminal and resume the same
binding under PC-7. Do not manufacture a transient phase failure from an
uncertain broadcast: exhausting a retry budget while that payment can still
land would permit another route to pay twice. A wallet decline alone also
remains uncertain; §9.5.2's EVM `counterparty` rule does not apply here.

The core is the rail step of a payment phase, not a whole PC-7 handler. After
`settled`, the caller still owns the rest of PC-7: build and sign the
`SettlementEvidence`, durably queue its idempotent anchor write, and keep the
session non-terminal until a finalized, independently resolvable receipt
exists. The core never resubmits a settled payment, so retrying the anchor
cannot pay twice. Likewise, CORE profile admission (the exact Standard
release and module tuple both parties accepted) is the session's job, and must
pass before the caller builds an authority for this core.

Build the authority only from the authenticated agreement and the rail
descriptor it pins: `agreementHash` and `railDescriptorHash` are their hashes,
and every other field must match what they carry. The core binds both hashes
into the settlement key, but it cannot authenticate them or check that the
other fields came from them.

PC-5 requires `amount.currency` to resolve to the rail's asset symbol. The
caller checks this before calling, from the pinned agreement and rail, and
reports a mismatch itself as `ok: false` / `permanent` with nothing paid. The
core cannot build an intent for such an authority, so it never reads the
store and reports `solana-spl-authority-invalid`.

## Store and adapter contract

`waiting` and `indeterminate` never authorize a fresh payment. Resume the same
authority after the lease expires. A production store must atomically retain
the signed wire bytes, lease generation, complete `SolanaSplExpiryEvidence` and
final settlement or failure across process restart. The evidence binds the
retained signature to a non-negative safe-integer `observedBlockHeight`
strictly greater than its `lastValidBlockHeight`, the literal `finalized`
commitment and an authentication hash. A record an earlier version wrote may
hold `confirmed` evidence for any attempt: the core loads it, but reconciles
that attempt again before it signs, reports `transient` or closes the key,
and the store must then let the new `finalized` evidence for that signature
replace the `confirmed` record. A predecessor is never rebroadcast: one not
yet expired at `finalized` is `waiting`. When one lands at the intent's
commitment or is refused at `finalized`, recovery reconciles every successor
read-only before recording
settlement. A refused predecessor does not close the key as `failed`, unlike
a refused latest attempt: a successor may already have paid or may still land.
`expiredSignatures` remains in the store claim for source
compatibility, but a hash-only legacy marker is never replacement authority: it
causes the retained attempt to be reconciled again. A store must allow a later
authenticated `settled-same` observation to supersede such an expiry marker.
A successful `markAttemptExpired` write must acknowledge the exact complete
record through `expiryEvidence`; a status-only legacy acknowledgement refuses
replacement. Every predecessor of a retained attempt must also have complete
expiry evidence. If historical state lacks that evidence, recovery returns
`indeterminate` and requires store migration/reconciliation before continuing.
`recordFailure` must close the key only for the current lease generation and
only while every retained attempt has `finalized` expiry evidence or is the
attempt that the finalized `landedFailure` names. A store must refuse a `landedFailure` that does not
name a retained attempt or is not `finalized`, and must retain the one it
accepts with the failure. Once it has, `claim`
returns `{ status: "failed", intent, failure }`, `isCurrent` is false, and
every other write for the key is refused. `failure` is exactly
`{ errorClass, reason }`, with a reason from the `failed` rows above and its
class; any other failure is `solana-spl-settlement-store-claim-invalid`.
`recordSettlement` must atomically refuse settlement while any other retained
attempt can still land. Each other attempt must have durable finalized expiry
evidence or be named in the optional `landedFailures` array of finalized
refusal proofs. The store must validate these proofs against distinct retained
signatures other than the settling signature and retain them with settlement.
This allows a refused predecessor and paid successor to resolve without hiding
a live payment. A store supporting historical confirmed records must enforce
this stronger close rule when upgrading.

Every store object the core relies on must be plain data, and plain data has
one meaning, enforced the same way for each of them. These objects are the
claim and its `intent`, `lease` and `failure`, each retained attempt and
expiry-evidence row, each write result and the `expiryEvidence` it
acknowledges, and a stored settlement with its `txRef`, `paymentAmount` and
`settlementFinality`. Each must meet three conditions:

- it is not a proxy (checked with `util.types.isProxy`);
- its prototype is `Object.prototype` or `null`, so `JSON.parse` output and
  `Object.create(null)` records qualify but class instances do not;
- its own keys are exactly the keys of its variant in the exported types.
  Optional keys may be absent. There are no symbol keys and no extra or
  missing keys. Each key is an own, enumerable data property, never an
  accessor.

A write result is `{ status, expiryEvidence? }` when it succeeds and
`{ status, reason }` otherwise.

Before using any of these objects, the core reads each value once from its
property descriptor into a fresh object. It validates, hashes and uses only
that snapshot, never the store's object. So no getter runs, and no trap of a
proxy runs (a host object can still run native code; see the second limit
below). A retained attempt therefore cannot pass its integrity check as one row
and then be used as another.

Every field that the contract types as a string, number or boolean is checked
with `typeof` or `===` before anything else reads it. A nested object in such
a field is therefore refused without running any of its code.

An object that breaks the rule is refused with nothing reconciled, signed or
broadcast after it:

- the claim, its `intent`, its `lease` or its `failure`:
  `solana-spl-settlement-store-claim-invalid`;
- a retained attempt or expiry-evidence row:
  `solana-spl-retained-state-corrupt`;
- a write result, or the evidence it acknowledges:
  `solana-spl-retained-attempt-persistence-uncertain`,
  `solana-spl-expiry-persistence-uncertain`,
  `solana-spl-settlement-persistence-uncertain` or
  `solana-spl-failure-persistence-uncertain`, for `recordAttempt`,
  `markAttemptExpired`, `recordSettlement` and `recordFailure` respectively;
- a stored settlement or any object nested in it:
  `solana-spl-stored-settlement-mismatch`.

The rule has two limits, and neither changes a decision:

- Awaiting a store method's result reads its `then` property. That read is
  part of promise resolution, and it happens before the core receives the
  value, so a `then` getter or proxy trap on the result can still run.
- A host object that is not a proxy can answer reads from native
  interceptors, and the core does not detect such objects. The global of a
  `vm` context is one example: when its sandbox is a proxy, listing the
  global's own keys may run that proxy's `ownKeys` trap and its
  `getOwnPropertyDescriptor` trap (Node 22 runs only `ownKeys`; Node 20 runs
  both). Their answers are never used: the global is refused, because it
  always keeps `undefined`, `NaN` and `Infinity` as own keys, even when its
  prototype is set to `Object.prototype`.

Every attempt the core signs is retained with exactly its nine
`SolanaSplSignedAttempt` keys. Fields that an adapter adds to a prepared
attempt are dropped. They are not hashed or retained, and they are not passed
back to `broadcastRetained` or `reconcile`.

The first signature in `signedTransactionBase64` (after its compact-u16
signature count) must be the attempt's `signature`, so the bytes broadcast are
always the transaction tracked and proven expired. Otherwise a prepared
attempt is `solana-spl-prepared-transaction-invalid`, with nothing recorded or
broadcast, and a retained one is `solana-spl-retained-state-corrupt`.

Every compact-u16 length the core reads (the signature, account key,
instruction, instruction account and instruction data counts) must be
encoded as `solana-short-vec` decodes it: at most three bytes, no zero byte
after the first, and a value of at most 65535. The runtime refuses any other
encoding, so a message that uses one is malformed, with the same results.

A claim's `attempts`, `expiredSignatures` and `expiryEvidence` must be real,
dense arrays. Element n is an own, enumerable data property at index n, so
attempt n is at index n − 1, and the array has no other own keys. A proxy is
refused before any of its traps runs, because its answers to separate reads
(`length`, its own keys, each index) need not agree. Each of the following
could hide the live latest attempt or its expiry record, so each is
`solana-spl-retained-state-corrupt` before anything is reconciled, signed or
broadcast:

- a proxy array;
- a hole;
- an inherited index;
- an accessor;
- a `length` that disagrees with the array's own keys.

The core cannot detect plain data that leaves out a retained attempt, so the
store must return every attempt it retained.

A `settled` result returns a fresh frozen copy of the stored settlement,
checked against the intent. It never returns the store's object, so store
text, extra fields and `toJSON` hooks never reach the caller.
The exported in-memory store is for tests and development only.

The adapter must authenticate reconciliation from Solana ledger state. The
core checks the shape of every proof, never its authenticity: for
`absent-valid`, `absent-expired`, `landed-failed` and `settled-same`, the
`authenticationHash` only has to be 64 lower-case hex characters. Solana RPC
answers carry nothing the core could verify (no signature or state proof over
`getSignatureStatuses`, `getBlockHeight` or `getTransaction`), so the adapter
and the store are the trust boundary, and their contracts below are what make
a proof strong.

For `absent-expired`, absence and height must come from one coherent
authenticated ledger view, and `commitmentLevel` must be that view's level.
The core acts only on `finalized`. Below it the result is `waiting`
(`solana-spl-reconciliation-pending`), because if the observed block were
rolled back, the attempt could still land on another fork before its last
valid block height. Its `authenticationHash` must bind the cluster,
signature, retained last-valid bound, observed height and commitment; hash
format alone is not authentication. Adapters that omit the optional expiry
fields remain source-compatible but produce an `indeterminate` result at
runtime.

`settled-same` and `landed-failed` report the commitment level actually
observed, as `getSignatureStatuses` returns it: never the intent's level in
its place. For a transaction that landed with a non-null error status, the
adapter returns `landed-failed` with the slot, the observed commitment and an
`authenticationHash` that binds the cluster, signature, slot, error and
commitment. Below `finalized` the core waits, because a fork could still roll
the refusal back. At `finalized`, nothing in the transaction took effect and
its signature can never land again, so the core closes the key as
`solana-spl-transfer-failed-on-chain` (PC-4: refused by chain). The core
never acts on `broadcastRetained`'s answer, including `rejected`: a
synchronous RPC answer is not ledger state. A malformed `landed-failed` is
`solana-spl-landed-failure-proof-invalid`.

`prepareSignedTransfer` must sign a recent-blockhash transaction, never a
durable-nonce one. A nonce transaction stays valid past its blockhash's last
valid block height, so expiry evidence would prove nothing about it. The core
decodes the signed message (legacy or v0) as far as its first instruction and
refuses a system-program `AdvanceNonceAccount` there as
`solana-spl-prepared-transaction-invalid`: nothing is retained or broadcast.
agave also requires that instruction's first account to be writable. The core
does not check the accounts, so it refuses every transaction agave treats as
a nonce transaction, and a few more. Bytes that are not such a message are
refused the same way, and so is a v1 message (SIMD-0385). The same check
applies to every retained attempt a store returns.

`settled-same` reports the instruction it decoded at `instructionIndex`:
`standard: "spl-transfer-checked"` means that instruction is an SPL Token
`TransferChecked`. This is not the DACS ledger-event `standard`.
The Standard's authenticated Solana event names either SPL instruction
`spl-transfer` and carries the DACS amount and asset. An adapter that
authenticates such an event translates it losslessly: `mint` from the asset,
`amountBaseUnits` from the amount and the decimals, and
`spl-transfer-checked` only after decoding `TransferChecked` at that index.
The core refuses an untranslated event as
`solana-spl-settled-instruction-mismatch`. The result's `txRef` is the
Standard's `solana-instruction` reference, which carries no `standard`.

Preflight amounts must be canonical decimal strings within the `u64` range,
`payeeAtaExists` a boolean, and `payerTokenAccount` and `payeeAta` Base58
public keys. `payeeAta` must be the payee's associated token account for the
mint under SPL Token. The core derives that address and refuses any other
destination as `solana-spl-payee-ata-not-associated`. That covers any other
token account the payee owns for the mint, because the address is derived,
not observed, so another one is the adapter's fault. Nothing is signed and
the key stays open.

Preflight balances and the payee account's existence, owner and mint decide
`failed` results that close the key. The core checks only their form and
arithmetic, never their authenticity, so it cannot tell a stale or forged
read from a true one. The adapter must therefore read them from one coherent
view at the intent's commitment level or stronger: a lagging RPC that reports
a zero balance or a missing account would close the key with the wrong
reason. Nothing has been signed in that case, so the cost is a wrong failure,
never a double payment.

Token-2022 is not supported, and its associated token account is refused in
the same way. A Token-2022 mint with a transfer fee credits the payee less
than the `TransferChecked` amount, so the amount the core checks would not be
the amount paid. Because the address is derived under SPL Token, the
transfer the adapter builds is an SPL Token transfer, and an SPL Token
account can only hold an SPL Token mint.

`payerRentExemptMinimumLamports` is the rent-exempt minimum of the payer's
system account, `getMinimumBalanceForRentExemption(0)`. A payer that starts
at or above that minimum must end with zero lamports or at least the minimum
after the network fee and any ATA rent. The runtime refuses a rent-exempt
fee payer left in between, at the fee check or after execution, so such a
transfer could never succeed. The core reports it as the matching `permanent`
balance failure. A payer that already starts below the minimum may stay
there under agave's older rent-state rules, but not once SIMD-0392
(`relax_post_exec_min_balance_check`) is active. The core cannot see which
applies, so it reports `indeterminate` with
`solana-spl-payer-rent-state-unknown`: nothing is signed and the key stays
open. A top-up to at least the minimum plus the network fee and any ATA rent
lets the same key proceed. A top-up to exactly the minimum does not: the fee
would then leave the payer between zero and the minimum, which is `failed`.

When `payeeAtaExists` is true, `payeeAtaOwner` and `payeeAtaMint` must be
Base58 public keys too: strings, so pass `toBase58()` rather than a
`PublicKey` object. Anything else, including an object that converts to a
decimal string or prints as a key, is `indeterminate` with
`solana-spl-preflight-invalid`: nothing is signed, and the key stays open. A
malformed answer is an adapter or RPC fault, never a chain refusal, so it is
never `failed`. Only a well-formed owner or mint that is not the intent's
payee or mint is `failed` with `solana-spl-payee-ata-binding-mismatch`.
The durable store is part of the trusted implementation boundary and
must return exactly the evidence it accepted. A transport response or an
unverified signature string is not settlement evidence. A live wallet/RPC
adapter and funded public-network proof remain a separate integration
deliverable.

The guarantees behind `failed`, `transient` and a replacement are as strong as
their evidence, so the core acts on chain evidence only at `finalized`, where
Solana gives full rollback safety. Expiry or a refusal seen at `processed`
or `confirmed` is `waiting`. A replacement or close after an expiry
therefore waits for the block that passed the last valid block height to be
finalized, typically a few seconds to tens of seconds later.

## Solana references

The core imports no Solana package, but its checks follow these definitions,
read at these revisions:

| Behaviour | Source |
|---|---|
| Commitment levels, `getSignatureStatuses` and its `err`, blockhash expiry, durable nonces, fee-payer rent | agave `v4.3.0` (`825efd18292aff6ffcf9daa0f7612f21b3531a72`): `rpc/src/rpc.rs`, `runtime/src/bank/check_transactions.rs`, `svm/src/account_loader.rs`, `svm/src/rent_calculator.rs` |
| Wire format: compact-u16 signature count, then the signatures, then a legacy or v0 message; compact-u16 aliases and values above 65535 are refused | `solana-short-vec` 3.3.0, the version agave `v4.3.0` locks |
| Durable-nonce detection: the first instruction is the system program's `AdvanceNonceAccount` (the core skips agave's writable-account check, so it refuses a superset) | agave `v4.3.0` `runtime/src/bank/check_transactions.rs`, which calls `SVMMessage::get_durable_nonce` from `solana-svm-transaction` 5.0.0, the version agave locks |
| Message versions: legacy and v0 are decoded; v1, gated behind SIMD-0385, is refused | `solana-message` 4.5.0, the version agave `v4.3.0` locks |
| `TransferChecked` (`u64` amount, `u8` decimals), token-account owner, mint and state, on-chain refusals | SPL Token `program@v9.0.0` (`dfb260231c761be7d9c8b63728e770a102b86495`) |
| Associated token account address: seeds owner, token program and mint under `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, with SPL Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; bumps 255 down to 1 | `@solana/spl-token` 0.3.11 `getAssociatedTokenAddressSync` and `@solana/web3.js` 1.98.0 `findProgramAddressSync`, as `package-lock.json` resolves them; the tests pin their answers |
| Base58 | `bs58` 5.0.0; the tests pin its answers |
| DACS-4 §9.5.3, PC-4 to PC-7, SB-1 and the settlement-event vectors | DACS-Standard `d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`, `package.json` `dacs.standardRevision` |

The `@solana/*` packages and `bs58` are transitive development dependencies
only, used here as references. Recheck these definitions before moving to a
new revision of any of them.

## Upgrading

- **Stores** must implement `recordFailure` and the `failed` claim. A store
  without `recordFailure` is refused as `solana-spl-dependencies-invalid`
  before its claim is read, so nothing is signed.
- **Keys that returned `failed` before this version are still open.**
  Earlier versions did not close a key on `failed`, so resuming such a key,
  for example after a top-up, can still sign and settle a phase that was
  already paid another way. For each such key, write its failure in the
  store, so that `claim` returns the `failed` claim, or make sure nothing
  resumes it.
- **Records with extra attempt fields.** Earlier versions retained, and
  hashed, every field an adapter returned for a prepared attempt. A record
  whose attempts carry keys beyond the nine `SolanaSplSignedAttempt` keys is
  refused as `solana-spl-retained-state-corrupt`. The extra fields cannot be
  stripped, because that breaks the attempt's integrity hash, so there is no
  automatic migration. Refusing fails closed: nothing is reconciled, signed
  or broadcast for that key. An attempt that was in flight at the upgrade can
  still land, but the core will never record it `settled`. Reconcile such a
  record by hand from its retained signature before the phase is paid any
  other way.
- **Records whose bytes do not carry their signature**, which a correct
  adapter never produces, are refused as `solana-spl-retained-state-corrupt`
  in the same way.
- **Adapters** must return `payerRentExemptMinimumLamports` from `preflight`.
  A preflight without it is `solana-spl-preflight-invalid`: nothing is
  signed, and the key stays open. They must return the payee's associated
  token account as `payeeAta`, and report the commitment level they observed.
  They should return `landed-failed` for a retained transaction whose status
  carries an error; until they do, such a transaction stays `indeterminate`,
  as before.
- **Stores** must accept `recordFailure` with `landedFailure` and retain it.
  A store that refuses it leaves the key open as
  `solana-spl-failure-persistence-uncertain`, so nothing is paid twice.
- **Expiry evidence is `finalized`.** `markAttemptExpired` now carries
  `commitmentLevel: "finalized"`, and adapters must report `absent-expired`
  at the level they observed: expiry seen at `confirmed` is `waiting` until
  it is finalized. A record an earlier version wrote with `confirmed`
  evidence still loads, but the core reconciles each such attempt again,
  predecessors first, and the store must let the new `finalized` evidence
  replace the `confirmed` record; a store that refuses leaves the key
  `indeterminate` (`solana-spl-expiry-persistence-uncertain`), so nothing is
  paid twice.
- **Callers** get a new `transient` status. Map it to `ok: false` /
  `transient` and retry the same authority. An exhaustive `switch` on
  `status` needs a case for it.
- **`jobId` must be a canonical CORE JID-1 ULID.** Any other value is
  `solana-spl-authority-invalid` before the store is read. A canonical
  `jobId` is ASCII, so earlier versions' NFC normalization never changed it:
  its settlement key and binding are unchanged. A key created for any other
  `jobId` can no longer be resumed: reconcile any attempt retained under it
  by hand before the phase is paid another way.
- **Token-2022 mints** are no longer paid: their associated token account is
  `solana-spl-payee-ata-not-associated` before anything is signed.
- **Durable-nonce and malformed signed messages** are
  `solana-spl-prepared-transaction-invalid` before they are retained. A
  retained attempt of either kind from an earlier version is
  `solana-spl-retained-state-corrupt`; reconcile it by hand from its retained
  signature before the phase is paid any other way.
- **Amounts above the SPL `u64` range** are `solana-spl-authority-invalid`.
  `TransferChecked` cannot carry them, so no such transfer was ever valid.
