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

If a process fails after `beginEffect()`, the reservation remains charged at its
worst case. Lease expiry does not release it or authorize another effect.
`authority.reconcile()` releases it only after the injected rail authenticator
accepts an exact finalized settlement or authoritative absence proof.

## Durable store

`createFsWalletSpendStateStoreV1()` is the host-local reference store. It:

- serializes independent processes with crash-recoverable locks;
- publishes state through fsync and atomic rename;
- requires private, process-owned `0700` directories and `0600` files;
- authenticates state and initialization markers with a separately supplied
  HMAC key; and
- treats missing state after initialization as corruption, never a fresh
  budget.

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

The one-click host must build reservations from authenticated agreement and rail
definition hashes, use one state directory per wallet/chain policy, expose
`authority.inspect()` through `dacs doctor`, and keep any ambiguous reservation
operator-gated until reconciliation completes.
