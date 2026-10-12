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
- `failed`: nothing under this settlement key can land **now**. The store
  shows no retained attempt, or every retained attempt with complete, durably
  acknowledged expiry evidence, and no new transfer was signed.

`failed` is not terminal in the store. The record stays open, so a later call
with the same authority (another worker, or a scheduled resume after the
balance is topped up) can still sign and settle the phase. A caller must stop
advancing this settlement key before it pays the phase by any other route.

| Status | Reason codes |
|---|---|
| `failed` / `permanent` | `solana-spl-insufficient-token-balance`, `solana-spl-insufficient-network-fee-balance`, `solana-spl-insufficient-ata-rent-and-fee-balance`, `solana-spl-preflight-invalid` |
| `failed` / `counterparty` | `solana-spl-payee-ata-missing`, `solana-spl-payee-ata-binding-mismatch` |
| `waiting` | `solana-spl-settlement-held`, `solana-spl-reconciliation-pending`, `solana-spl-broadcast-not-yet-visible` |
| `indeterminate`, before the store is read | `solana-spl-authority-invalid`, `solana-spl-runtime-policy-invalid`, `solana-spl-dependencies-invalid`, `solana-spl-settlement-store-unavailable` |
| `indeterminate`, store claim | `solana-spl-settlement-store-claim-invalid`, `solana-spl-settlement-store-conflict`, `solana-spl-settlement-store-corrupt`, `solana-spl-settlement-store-intent-mismatch`, `solana-spl-settlement-store-intent-invalid`, `solana-spl-settlement-store-lease-invalid`, `solana-spl-stored-settlement-mismatch`, `solana-spl-retained-state-corrupt` |
| `indeterminate`, reconciliation | `solana-spl-reconciliation-unavailable`, `solana-spl-reconciliation-invalid`, `solana-spl-reconciliation-indeterminate`, `solana-spl-absence-proof-invalid`, `solana-spl-expiry-proof-invalid`, `solana-spl-expiry-persistence-uncertain`, `solana-spl-expiry-transition-raced`, `solana-spl-rebroadcast-unavailable` |
| `indeterminate`, a transfer landed | `solana-spl-settled-instruction-mismatch`, `solana-spl-settled-different`, `solana-spl-settlement-persistence-uncertain` |
| `indeterminate`, new attempt | `solana-spl-preflight-unavailable`, `solana-spl-preparation-unavailable`, `solana-spl-prepared-transaction-invalid`, `solana-spl-retained-attempt-persistence-uncertain`, `solana-spl-broadcast-unavailable`, `solana-spl-new-attempt-expired-before-observation` |

A store `conflict` (another binding already holds the same job, rail and
phase) or `corrupt` claim is `indeterminate`, not `failed`: that record may
hold a broadcast this call cannot inspect, so it must be resolved out of band.

## Store and adapter contract

`waiting` and `indeterminate` never authorize a fresh payment. Resume the same
authority after the lease expires. A production store must atomically retain
the signed wire bytes, lease generation, complete `SolanaSplExpiryEvidence` and
final settlement across process restart. The evidence binds the retained
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
A claim's `attempts` must be a dense array: attempt n is an own data property
at index n − 1, and the array has no other own keys. A hole, an inherited index
or a length that disagrees with the array's own keys could hide the live latest
attempt, so it is `solana-spl-retained-state-corrupt` before anything is
reconciled, signed or broadcast.
The exported in-memory store is for tests and development only.

The adapter must authenticate reconciliation from Solana ledger state. For
`absent-expired`, absence and height must come from one coherent authenticated
confirmed ledger view. Its `authenticationHash` must bind the cluster,
signature, retained last-valid bound, observed height and commitment; hash
format alone is not authentication. Adapters that omit the optional expiry
fields remain source-compatible but produce an `indeterminate` result at
runtime. The durable store is part of the trusted implementation boundary and
must return exactly the evidence it accepted. A transport response or an
unverified signature string is not settlement evidence. A live wallet/RPC
adapter and funded public-network proof remain a separate integration
deliverable.
