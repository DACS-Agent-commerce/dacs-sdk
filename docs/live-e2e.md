# Running the funded two-agent live E2E

`test/integration/funded-two-agent.e2e.test.ts` exercises the full two-sided
DACS lifecycle (DACS-1 listing → DACS-2 vetting → DACS-3 agreement/commitment →
x402 settlement → DACS-4 evidence → DACS-5 role-owned bundles) against a live
Demos node and a real x402 USDC settlement on Base Sepolia. It is skipped unless
the full env is present, so `npm test` / CI stay offline.

Each funded attempt is permanently marked **non-rerunnable** (keyed by
`LIVE_E2E_RUN_ID`), so use a fresh run id every time.

## 1. Node version (required)

demosdk's ESM packaging + `avsc` break on Node ≥ 24 (`buffer.SlowBuffer is not a
constructor`). Run under **Node 20**:

```bash
~/.nvm/versions/node/v20.19.4/bin/node node_modules/.bin/vitest run \
  test/integration/funded-two-agent.e2e.test.ts
```

(`nvm use 20` may not take in a non-interactive shell — call the binary by path.)

## 2. Funding (all public, no captcha)

**Demos wallets (DEM)** — one buyer, one seller. Fund each:

```bash
curl -s -X POST https://faucetbackend.demos.sh/api/request \
  -H 'Content-Type: application/json' -d '{"address":"0x<demos-address>"}'
```

~2400 DEM per request. **Denomination:** `getAddressInfo().balance` is in **OS**,
`1 DEM = 1,000,000,000 OS` (raw `2398000000000` = 2398 DEM). Preflight needs
seller ≥ 3 DEM, buyer ≥ 7 DEM. Funding is async — poll the balance until non-zero
before running. The faucet is per-address rate-limited (~2400 / interval) and its
broadcast can silently fail to land; if a wallet stays at 0, mint a fresh wallet
rather than re-requesting the rate-limited one.

**Base Sepolia USDC** — fund the buyer EVM address with test USDC from
`faucet.circle.com`. **Pick the Base Sepolia network explicitly** — the faucet
defaults can land the tokens on Ethereum Sepolia, which this test cannot use.
x402 uses gasless EIP-3009, so the buyer needs USDC, not ETH; the seller EVM only
receives.

## 3. Env

```
DEMOS_RPC=https://demosnode.discus.sh/
SELLER_WALLET=<seller mnemonic>   SELLER_DID=did:demos:agent:<seller hex>
BUYER_WALLET=<buyer mnemonic>     BUYER_DID=did:demos:agent:<buyer hex>
BUYER_EVM_KEY=0x<key funded with Base-Sepolia USDC>
SELLER_EVM_KEY=0x<seller evm key>   SELLER_EVM=0x<seller receive addr>
PAY_TOKEN=0x036CbD53842c5426634e7929541eC2318f3dCF7e   # Circle Base-Sepolia USDC
PAY_NETWORK=eip155:84532
PAY_RPC=https://base-sepolia.gateway.tenderly.co        # a Base-Sepolia RPC for OUR reads
PAY_RPC_SECONDARY=https://base-sepolia.api.onfinality.io/public   # optional: different origin → cross-RPC agreement
X402_FACILITATOR=https://x402.org/facilitator
PAYWALL_URL=local          # literal — self-starts the in-test x402 paywall
LIVE_E2E_RUN_ID=<fresh unique id every run>   # the attempt is non-rerunnable
LIVE_E2E_CONFIRM=1
```

The DID is `did:demos:agent:` + the wallet address without the `0x`.
`PAYWALL_URL=local` self-starts the correctly-configured in-test paywall — do NOT
point it at a URL. `PAY_RPC_SECONDARY` must be a *different origin* from `PAY_RPC`;
supplying it proves cross-RPC (2-of-2) agreement instead of a lone `1-of-1` view.

### Base Sepolia RPCs

`PAY_RPC` is only for the test's own on-chain reads (the facilitator broadcasts
via its own RPC). Public endpoints vary in reliability:

- Working: `https://base-sepolia.gateway.tenderly.co`,
  `https://base-sepolia-rpc.publicnode.com`,
  `https://base-sepolia.api.onfinality.io/public`
- Flaky/dead at time of writing: `https://sepolia.base.org`,
  `https://base-sepolia.drpc.org`, `https://1rpc.io/base-sepolia`

## 4. Run + expected

Prefix the §1 command with the env. A clean run is ~75s to commerce-complete and
~4 min for the full audit/bundle path. Green = the full two-sided lifecycle ran
on-chain (real DEM fees + a real ~0.000001 USDC transfer buyer→seller) and both
role-owned DACS-5 bundles finalized and re-verified from cold storage.

## 5. Troubleshooting

- **`Insufficient balance …`** — Demos funding not confirmed yet, or the funded
  address ≠ the mnemonic's address. Verify the balance before running.
- **`evm-authorization-lookup-unavailable`** — the `PAY_RPC` couldn't serve a read
  mid-settlement. Switch to a more reliable RPC (see the working list) and retry
  with a fresh `LIVE_E2E_RUN_ID`.
- **`facilitator-settle-outcome:failure-invalid-exact-evm-transaction-failed`** —
  the public x402 facilitator's on-chain settlement reverted. This facilitator is
  **transiently flaky** — retrying (fresh run id) usually succeeds within a couple
  of attempts; the SDK side (DACS-1/2/3 + cold-authority) passes regardless.
- **`request to <url> failed`** — `PAYWALL_URL` was set to a URL instead of the
  literal `local`.
- USDC landed but the test can't see it — confirm it's on **Base Sepolia**
  (chain 84532), not Ethereum Sepolia.
