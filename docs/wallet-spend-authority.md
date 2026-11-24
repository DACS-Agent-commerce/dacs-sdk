# Wallet-wide spend authority

`createWalletSpendAuthorityV1()` is the funded-agent boundary shared by every
process and payment rail that can use one wallet on one chain. It complements
the settlement idempotency store:

- settlement idempotency prevents one DACS payment phase from being submitted
  twice;
- wallet authority prevents different phases, jobs, rails, or processes from
  collectively exceeding the operator's policy or racing one wallet lane.

An unattended coordinator must use both. A raw rail constructor remains a
low-level/manual primitive and does not grant production automation authority.

## Policy

The immutable policy binds a policy id, wallet, authenticated chain identity,
maximum concurrent effects, retained-record capacity, and one or more base-unit
asset policies. Each asset policy sets:

- per-order and network-fee ceilings;
- a minimum wallet reserve;
- rolling amount and transaction-rate limits;
- lifetime cumulative and per-counterparty limits; and
- an optional authenticated operator-approval threshold.

The wallet is a 20-byte (EVM) or 32-byte (Demos) hex address, with or without
the `0x` prefix and in any letter case. The authority stores and hashes it as
`0x` and lowercase hex, so every spelling of one wallet shares one lineage, one
budget and one policy hash, and `canonicalWalletSpendWalletV1()` returns that
form. A policy naming anything else is refused when the authority is created.
A reservation keeps the spelling it was reserved under.

Service amounts are exact: `expectedAmount` and `maximumAmount` must match.
Network fees retain both an estimate and a hard ceiling. Mixed-asset EVM
payments use one service debit for the token and one network-fee debit for the
native gas asset; unlike units are never silently converted or added together.
Every reservation also carries the exact agreement, authenticated rail
definition, and settlement-binding hashes; the combined fence rejects a permit
from a different payment phase even if its wallet and amount happen to match.

## Effect lifecycle

```text
reserve worst-case debit durably
  -> mark effect-pending
  -> assert settlement + wallet generations beside irreversible work
  -> authenticate chain finality and actual debit
  -> record actual debit durably
```

Use `combineWalletSpendEffectFenceV1()` when an existing rail already receives
a settlement-generation fence. `executeWalletSpendEffectV1()` implements the
reserve/begin/execute/account sequence for adapters whose finality result can be
projected into an authenticated debit observation.

For the x402 buyer track, `bindAuthorizationValidBefore` supplies the hold's
expiry in Unix seconds from chain time. Preparation reserves the hold before
signing and signs with that value. An authority without this hook denies the
request with `authorization-window-unsupported` before taking a hold. A refusal
raised after the hold is reported as retryable, never as operator action, so a
later attempt can release a hold whose signed input was never stored. That
release needs the hold to be unbegun with its lease expired, and the SDK's x402
recovery authenticator accepts its evidence only while the x402 settlement store
has no record for the payment. The hold uses `x402BuyerUnsignedIntentHash()` to bind the selected
terms before signing; the stored settlement intent still binds the signed bytes.
A retry with stored input and no carried permit reconciles without sending.

If a process fails after `beginEffect()`, the reservation remains charged at its
worst case. Lease expiry does not release it or authorize another effect.
`authority.reconcile()` releases it only after the injected rail authenticator
accepts an exact finalized settlement or authoritative absence proof. For an
absence it passes the authenticator the stored hold's generation and expiry, and
the release applies only while that generation is still the stored one.

## Durable stores

`createFsWalletSpendStateStoreV1()` is a host-local reference/manual store. It
is not the funded generated-agent authority and must not be treated as
rollback-resistant across actor backup/restore. It:

- serializes independent processes with crash-recoverable locks;
- publishes state through fsync and atomic rename;
- requires private, process-owned `0700` directories and `0600` files;
- authenticates state and initialization markers with a separately supplied
  HMAC key; and
- treats missing state after initialization as corruption, never a fresh
  budget.

Filesystem and custom stores that do not explicitly implement a lineage
selector use the wallet/chain/policy-id scope, with the wallet written in its
canonical form (`0x` followed by lowercase hex), so every spelling of one
wallet addresses the same journal. A journal that an earlier SDK wrote under
another spelling of the wallet (without `0x`, in uppercase, or with a label)
is not found under that scope. The PostgreSQL store explicitly
selects canonical wallet+chain lineage. Moving an existing journal to
PostgreSQL requires the authenticated operator-only legacy import described in
`wallet-budget-authority-design.md`; creating an empty lineage is not migration.

Current writers publish a fully written `0600` file at the canonical lock path
with an exclusive hard link. This is intentionally incompatible in a
fail-closed direction with the earlier directory-lock algorithm: an old writer
cannot create, inspect, or reclaim through the file, and a current writer will
not move or delete a legacy lock directory or `.lock.reclaim.*` quarantine.
Upgrading a directory that contains either legacy coordination form therefore
requires all old writers to be stopped and the abandoned coordination artifact
to be inspected and removed by the operator before current writers start. Do
not run the old and current lock algorithms concurrently.

The integrity key must be loaded from the host secret provider and must not be
stored inside the state directory. Multi-host wallets need a transactional
shared implementation of `WalletSpendStateStore`; host-local filesystem locks
must not be placed on a network filesystem.
If a custom store exposes the asynchronous authoritative `serverNow()` clock,
its `transact()` callback must also receive a timestamp sampled after acquiring
serialization. The authority fails closed when that timestamp is missing;
sampling the clock before a transaction wait can authorize an expired permit.

## Minimal integration shape

```ts
const store = await createFsWalletSpendStateStoreV1({
  dir: walletPolicyDirectory,
  integrityKey: walletPolicyIntegrityKey,
});

const authority = createWalletSpendAuthorityV1(policy, {
  store,
  readBalance: authenticatedBalanceReader,
  authenticateRecovery: railFinalityAndAbsenceVerifier,
  verifyOperatorApproval: operatorApprovalVerifier,
});

const outcome = await executeWalletSpendEffectV1({
  authority,
  reservation,
  effect: (walletFence) => fundedRail(combineWalletSpendEffectFenceV1(
    settlementFence,
    walletFence,
  )),
  settlement: authenticatedDebitFromRailResult,
});
```

Generated funded buyers instead use the remote authority client described in
`wallet-budget-authority-design.md`. They hold only an endpoint and role-scoped
token plus operator-controlled authority-id, epoch and witness-public-key pins.
They speak only remote protocol V2 and do not fall back to V1 or this filesystem
store. The production service owns PostgreSQL access, stable wallet/chain lineage,
provisioning, migration, authenticated balances/recovery and transitions; every
authorization and status read is fenced by the independently rollback-resistant
continuity witness. The testnet-only file-backed service in
`@kynesyslabs/dacs-node` is not that service: its witness and state share one
directory, it uses no PostgreSQL, and it does not detect a restored old copy.
See [Run the testnet service](#run-the-testnet-service). The included in-memory
witness is deterministic test/reference code only and is not production
topology, durability or failover evidence.

## Run the testnet service

For testnets only, `@kynesyslabs/dacs-node` includes a file-backed authority
service that a generated x402 or dual-rail buyer project runs on a loopback
address. It serves the x402 policy on Base Sepolia (`eip155:84532`) and, when
its Demos settings are set, the `pay-dem` policy on the Demos testnet
(`demos`), each lane in its own data directory and lineage. It is not the
production authority: its witness and state share one directory, it uses no
PostgreSQL, and it does not detect a restored old copy. Run each step as the
runtime user that owns the secret files:

1. Create two private files outside the project, mode 0600: a bearer token of at
   least 32 characters and a witness seed of 64 hexadecimal characters.
2. Fill in the settings below, with a new epoch, a new data directory outside
   the role data directories, and `DACS_WALLET_AUTHORITY_ALLOW_INSECURE_LOOPBACK=1`.
3. Run `npm run dacs:authority -- --print-witness-public-key` and put the
   printed key in `DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY`.
4. Run `npm run dacs:authority:policy`, which writes the buyer's own x402
   policy as canonical JSON, then `npm run dacs:authority`.
5. Start the roles and run `npm run dacs:doctor -- --phase post-start --for buy`
   (`--rail x402` in a dual-rail project). Buy only when its
   `x402.service-limit` check passes: a buyer whose pins differ from the
   service refuses the answer only after the service has recorded a hold.
6. A changed wallet limit, wallet or rail asset changes the policy: write it
   again and start a new lineage (a new data directory and epoch), whose spend
   totals start from zero. With Docker, restart the buyer too.
7. The service counts a payment only when the chain shows the purchase's
   authorization nonce used in a final transaction that moves exactly the
   agreed amount to the agreed payee. When it records a hold, it sets the
   authorization's `validBefore` from the chain's time, at most 24 hours later;
   the generated buyer asks for 120 seconds. An interrupted purchase keeps its
   hold until the chain shows the authorization cancelled, or the chain's time
   is past that `validBefore` with the authorization unused, and the 5-minute
   hold lease has ended; the buyer's next request then releases it. Never
   reuse an epoch.
8. The generated commands set up only the x402 lane. The service also runs a
   `pay-dem` lane when `DACS_PAY_DEM_WALLET_AUTHORITY_DATA_DIRECTORY` (another
   new directory, neither inside nor containing the x402 one),
   `DACS_PAY_DEM_WALLET_AUTHORITY_POLICY_FILE` (the buyer's DEM policy) and
   `DACS_DEMOS_RPC_URL` (an `https` Demos node) are set. It starts that lane only
   when the node's identity is the approved Demos testnet, and refuses with
   `wallet-spend-testnet-authority-demos-network-mismatch` otherwise. It counts a
   DEM payment only when the chain shows that transfer executed from the policy
   wallet to the agreed payee for the exact amount, with the fee the chain
   record shows, and it keeps one claim per transfer in that directory's
   `transfers/` folder, so a transfer settles one hold even across restarts. It
   never releases a DEM hold on the buyer's word or by time, so
   an interrupted DEM purchase keeps its hold.

| Setting | Meaning |
|---|---|
| `DACS_WALLET_AUTHORITY_URL` | `http://127.0.0.1:<port>/` the service listens on and the buyer calls |
| `DACS_BUYER_WALLET_AUTHORITY_TOKEN_FILE` | private file holding the buyer's bearer token |
| `DACS_WALLET_AUTHORITY_ID` | the authority id both sides pin |
| `DACS_WALLET_AUTHORITY_EPOCH` | the lineage epoch; new for every new data directory |
| `DACS_WALLET_AUTHORITY_WITNESS_PUBLIC_KEY` | the witness key printed in step 3 |
| `DACS_WALLET_AUTHORITY_WITNESS_SEED_FILE` | private file holding the witness seed |
| `DACS_WALLET_AUTHORITY_DATA_DIRECTORY` | the service's state and witness directory |
| `DACS_WALLET_AUTHORITY_POLICY_FILE` | the policy written in step 4 |
| `DACS_EVM_RPC_URL` | the Base Sepolia RPC the service reads balances and payments from |
| `DACS_X402_AUTHORIZATION_SEARCH_FROM_BLOCK` | the first block searched for this wallet's authorizations |

A start refusal exits with one named code and serves nothing. The likely ones:

- `wallet-spend-testnet-authority-setting-missing`: the named setting is empty.
- `wallet-spend-testnet-authority-network-refused`: the policy is not for
  `eip155:84532`.
- `wallet-spend-testnet-authority-witness-key-mismatch`: the seed does not
  match the pinned witness key.
- `wallet-spend-testnet-authority-listen-failed`: the port is taken.
- `wallet-spend-continuity-policy-mismatch`: the policy changed over an existing
  data directory; start a new lineage (step 6).
- `wallet-spend-file-witness-record-damaged`: a witness record is damaged.
- `wallet-spend-testnet-authority-token-invalid` or
  `wallet-spend-testnet-authority-witness-seed-invalid`: the file is missing,
  malformed or unsafe, often owned by another user (`secret-file-owner-mismatch`).

While running, the service prints a `hold-needs-operator` line on stderr, with
`wallet-spend-chain-nonce-used-unmatched`, when the chain shows a hold's nonce
used in a transaction that does not pay the agreed amount to the agreed payee.
That nonce paid for something else: the hold stays, and the wallet key should
be treated as in use elsewhere.
