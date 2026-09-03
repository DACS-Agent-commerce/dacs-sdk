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
- permits a replacement signature only after authenticated blockhash expiry;
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

`waiting` and `indeterminate` never authorize a fresh payment. Resume the same
authority after the lease expires. A production store must atomically retain
the signed wire bytes, lease generation, authenticated expiry proof and final
settlement across process restart. The exported in-memory store is for tests
and development only.

The adapter must authenticate reconciliation from Solana ledger state. A
transport response or an unverified signature string is not settlement
evidence. A live wallet/RPC adapter and funded public-network proof remain a
separate integration deliverable.
