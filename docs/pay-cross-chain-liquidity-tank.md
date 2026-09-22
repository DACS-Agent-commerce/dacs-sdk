# Liquidity-tank settlement safety core

The SDK exposes a dependency-injected
`pay-cross-chain-liquidity-tank` producer core for DACS-4 §9.5.5. It binds the
current DACS v0.1 route—ETH Sepolia to Polygon Amoy, USDC, unidirectional—and
refuses silent substitution to HTLC or any other mechanism.

The core:

- validates the exact stablecoin-cross-chain / cross-chain / liquidity-tank
  authority, SR-5 binding, route and distinct tank pair;
- binds both addresses, per-chain decimal conversion, amount, agreement, rail,
  job and phase before effects;
- requires the complete signed native-bridge transaction to be prepared and
  durably stored before broadcast;
- generation-fences preparation, exact-byte broadcast and authenticated status
  reads across worker takeover;
- reconciles the same 16-character `bridgeId` and operation hash before every
  rebroadcast;
- accepts only authenticated `empty -> pending -> completed` history;
- returns success only when both source lock and destination release hashes are
  present;
- treats capacity exhaustion as transient on the same pinned tank rail; and
- persists locked-unreleased state as ST-8 `tank-locked-unreleased`, resolving
  forward to success or reputation-neutral `failed-substrate` at the recovery
  deadline.

```ts
import {
  advanceLiquidityTankSettlement,
  type LiquidityTankAdapter,
  type LiquidityTankStore,
} from "@kynesyslabs/dacs/rails";

const result = await advanceLiquidityTankSettlement({
  authority,
  owner: workerId,
  adapter: nativeBridgeAdapter satisfies LiquidityTankAdapter,
  store: durableStore satisfies LiquidityTankStore,
});
```

`prepareSubmission` must build and sign without broadcasting—for the current
Demos programmatic API this corresponds to the manual confirmation path. The
store commits those exact signed bytes first. `broadcastRetained` may then
rebroadcast only that retained transaction, so an ambiguous response never
authorizes a new nonce or bridge operation.

Production adapters must authenticate bridge status and its history. Demos SDK
4.0.16 exposes native-bridge submission but no public bridge-status lookup that
can satisfy this boundary, so a bundled live Demos adapter and funded proof are
explicitly blocked on that upstream capability. The pure protocol/recovery
core and its adversarial tests do not pretend a submit response is completion.

The exported in-memory store is for tests and development only. Production
stores must authenticate retained rows, enforce global bridge-ID uniqueness,
and preserve locked-unreleased checkpoints across process restart.
