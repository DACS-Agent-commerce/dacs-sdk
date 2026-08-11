# Running the live on-chain E2E

`test/integration/live.e2e.test.ts` exercises the real DACS lifecycle
(publish → anchor → x402 settle → verify) against a live Demos node and an
x402 USDC settlement on Base Sepolia. It is skipped unless the full env is set,
so `npm test` / CI stay offline.

## 1. Node version (important)

demosdk's ESM packaging + `avsc` break on Node ≥ 24 (`buffer.SlowBuffer is not
a constructor`). Run the live test (and anything that imports `demosdk`) under
**Node 20**:

```bash
~/.nvm/versions/node/v20.19.4/bin/node node_modules/.bin/vitest run \
  test/integration/live.e2e.test.ts
```

(`nvm use 20` may not take in a non-interactive shell — call the binary by path.)

## 2. Funding (all public, no captcha)

**Demos wallets (DEM)** — two funded wallets, buyer + seller. Generate a
mnemonic, connect it, take `demos.getAddress()`, then fund it:

```bash
curl -s -X POST https://faucetbackend.demos.sh/api/request \
  -H 'Content-Type: application/json' -d '{"address":"0x<demos-address>"}'
```

~2400 DEM per request. Note **denomination**: `getAddressInfo().balance` is in
**OS**, and `1 DEM = 1,000,000,000 OS` — a raw `2398000000000` is 2398 DEM, but
a raw `2400` is only 0.0000024 DEM. The E2E preflight needs **seller ≥ 3 DEM,
buyer ≥ 7 DEM**. Funding is async — wait for it to confirm (query the balance
until non-zero) before running.

**Base Sepolia** — fund the buyer EVM key with **test USDC** from
`faucet.circle.com` (select Base Sepolia). x402 uses gasless EIP-3009, so the
payer needs USDC, not ETH.

## 3. Env

```
DEMOS_RPC=https://demosnode.discus.sh/
SELLER_WALLET=<seller mnemonic>   SELLER_DID=did:demos:agent:<seller hex>
BUYER_WALLET=<buyer mnemonic>     BUYER_DID=did:demos:agent:<buyer hex>
BUYER_EVM_KEY=0x<key funded with Base-Sepolia USDC>
SELLER_EVM=0x<seller receive addr>
PAY_TOKEN=0x036CbD53842c5426634e7929541eC2318f3dCF7e   # Circle Base-Sepolia USDC
PAY_NETWORK=eip155:84532
PAYWALL_URL=local      # the literal string — self-starts the in-test x402 paywall
LIVE_E2E_CONFIRM=1
```

`PAYWALL_URL=local` makes the test start its own correctly-configured x402
paywall (`test/integration/live-x402-paywall.ts`, @x402/express + the public
`https://x402.org/facilitator`) — do NOT point it at a URL. The DID is
`did:demos:agent:` + the wallet address without the `0x`.

## 4. Run + expected

Prefix the command in §1 with the env. Runs ~80–260s (node speed varies; a slow
run sits near the timeouts). Green = the full lifecycle worked on-chain (real DEM
fees + real test-USDC moved). The assertion checks the buyer-only bundle is
correctly `ok:false` with the seller's DID as the missing required co-signature
(the two-sided co-signature exchange is separate — issue #81 / seller-side work).

## 5. Troubleshooting

- **`Insufficient balance: required 2, available 0`** — funding not confirmed
  yet, or the wallet you funded ≠ the one the mnemonic derives. Verify
  `getAddressInfo(getAddress())` shows the balance before running.
- **`anchor timed out during immutable completion`** — usually node slowness /
  transient consensus; rerun. (A shared-deadline bug that masked the real inner
  failure was fixed under #97.)
- **`request to <url> failed`** — you set `PAYWALL_URL` to a URL instead of the
  literal `local`.
