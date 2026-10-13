# Solana SPL settlement safety core

The SDK exposes a dependency-free `pay-solana-spl` settlement core for the
DACS-4 §9.5.3 safety boundary. It does not bundle a Solana wallet or RPC
client. Applications inject those capabilities behind `SolanaSplAdapter` and
persist state through `SolanaSplSettlementStore`.

The core:

- binds the agreement, selected rail, payer, payee, mint, amount, decimals,
  cluster, commitment and phase into one immutable intent;
- converts the canonical DACS amount into exact integer token base units;
- requires `TransferChecked` and records its exact instruction index;
- refuses to create a missing associated token account unless the selected
  authority explicitly permits it, and charges its rent to the payer;
- checks token, network-fee and optional rent balances before signing;
- persists the complete signed transaction before any broadcast;
- reconciles the retained signature before rebroadcast or replacement;
- permits a replacement signature only after authenticated, confirmed
  blockhash-expiry evidence is durably recorded;
- checks the durable generation fence before and after each wallet/RPC call,
  while requiring adapters to recheck the supplied fence immediately before
  each authority-bearing side effect; and
- emits `solana-instruction` coordinates only after the exact transfer reaches
  the selected commitment level.

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

- `settled`: the exact transfer reached the intent's commitment level and the
  store recorded it.
- `waiting`: resume the same authority later.
- `indeterminate`: the phase may be paid, or a retained transfer may still
  land. Resume the same authority, or resolve the store or adapter problem out
  of band. A transfer that landed but does not match the intent
  (`solana-spl-settled-instruction-mismatch`, `solana-spl-settled-different`)
  is reported here, because funds may have moved.
- `failed`: nothing under this settlement key can land, and nothing ever
  will. The store shows no retained attempt, or every retained attempt with
  complete, durably acknowledged expiry evidence, no new transfer was signed,
  and the store has closed the key.

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
| `failed` / `permanent` | `solana-spl-insufficient-token-balance`, `solana-spl-insufficient-network-fee-balance`, `solana-spl-insufficient-ata-rent-and-fee-balance` |
| `failed` / `counterparty` | `solana-spl-payee-ata-missing`, `solana-spl-payee-ata-binding-mismatch` |
| `waiting` | `solana-spl-settlement-held`, `solana-spl-reconciliation-pending`, `solana-spl-broadcast-not-yet-visible` |
| `indeterminate`, before the store is read | `solana-spl-authority-invalid`, `solana-spl-runtime-policy-invalid`, `solana-spl-dependencies-invalid`, `solana-spl-settlement-store-unavailable` |
| `indeterminate`, store claim | `solana-spl-settlement-store-claim-invalid`, `solana-spl-settlement-store-conflict`, `solana-spl-settlement-store-corrupt`, `solana-spl-settlement-store-intent-mismatch`, `solana-spl-settlement-store-intent-invalid`, `solana-spl-settlement-store-lease-invalid`, `solana-spl-stored-settlement-mismatch`, `solana-spl-retained-state-corrupt` |
| `indeterminate`, reconciliation | `solana-spl-reconciliation-unavailable`, `solana-spl-reconciliation-invalid`, `solana-spl-reconciliation-indeterminate`, `solana-spl-absence-proof-invalid`, `solana-spl-expiry-proof-invalid`, `solana-spl-expiry-persistence-uncertain`, `solana-spl-expiry-transition-raced`, `solana-spl-rebroadcast-unavailable` |
| `indeterminate`, a transfer landed | `solana-spl-settled-instruction-mismatch`, `solana-spl-settled-different`, `solana-spl-settlement-persistence-uncertain` |
| `indeterminate`, new attempt | `solana-spl-preflight-unavailable`, `solana-spl-preflight-invalid`, `solana-spl-failure-persistence-uncertain`, `solana-spl-preparation-unavailable`, `solana-spl-prepared-transaction-invalid`, `solana-spl-retained-attempt-persistence-uncertain`, `solana-spl-broadcast-unavailable`, `solana-spl-new-attempt-expired-before-observation` |

A store `conflict` (another binding already holds the same job, rail and
phase) or `corrupt` claim is `indeterminate`, not `failed`: that record may
hold a broadcast this call cannot inspect, so it must be resolved out of band.

## Store and adapter contract

`waiting` and `indeterminate` never authorize a fresh payment. Resume the same
authority after the lease expires. A production store must atomically retain
the signed wire bytes, lease generation, complete `SolanaSplExpiryEvidence` and
final settlement or failure across process restart. The evidence binds the retained
signature to a non-negative safe-integer `observedBlockHeight` strictly greater
than its `lastValidBlockHeight`, the literal `confirmed` commitment and an
authentication hash. `expiredSignatures` remains in the store claim for source
compatibility, but a hash-only legacy marker is never replacement authority: it
causes the retained attempt to be reconciled again. A store must allow a later
authenticated `settled-same` observation to supersede such an expiry marker.
A successful `markAttemptExpired` write must acknowledge the exact complete
record through `expiryEvidence`; a status-only legacy acknowledgement refuses
replacement. Every predecessor of a retained attempt must also have complete
expiry evidence. If historical state lacks that evidence, recovery returns
`indeterminate` and requires store migration/reconciliation before continuing.
`recordFailure` must close the key only for the current lease generation and
only while no retained attempt lacks expiry evidence. Once it has, `claim`
returns `{ status: "failed", intent, failure }`, `isCurrent` is false, and
every other write for the key is refused. `failure` is exactly
`{ errorClass, reason }`, with a reason from the `failed` rows above and its
class; any other failure is `solana-spl-settlement-store-claim-invalid`.
Every store object the core relies on must be plain data, and plain data has
one meaning, enforced the same way for each of them. These objects are the
claim and its `intent`, `lease` and `failure`, each retained attempt and expiry-evidence
row, each write result and the `expiryEvidence` it acknowledges, and a stored
settlement with its `txRef`, `paymentAmount` and `settlementFinality`. Each
must meet three conditions:

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

The adapter must authenticate reconciliation from Solana ledger state. For
`absent-expired`, absence and height must come from one coherent authenticated
confirmed ledger view. Its `authenticationHash` must bind the cluster,
signature, retained last-valid bound, observed height and commitment; hash
format alone is not authentication. Adapters that omit the optional expiry
fields remain source-compatible but produce an `indeterminate` result at
runtime. Preflight amounts must be canonical decimal strings and
`payeeAtaExists` a boolean; anything else, including an object that converts
to a decimal string, is `indeterminate` with `solana-spl-preflight-invalid`:
nothing is signed, and the key stays open. A malformed answer is an adapter
or RPC fault, never a chain refusal, so it is never `failed`.
The durable store is part of the trusted implementation boundary and
must return exactly the evidence it accepted. A transport response or an
unverified signature string is not settlement evidence. A live wallet/RPC
adapter and funded public-network proof remain a separate integration
deliverable.
