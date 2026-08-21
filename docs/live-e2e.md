# Running the funded two-agent live E2E

`test/integration/funded-two-agent.e2e.test.ts` exercises the full two-sided
DACS lifecycle (DACS-1 listing → DACS-2 vetting → DACS-3 agreement/commitment →
x402 settlement → DACS-4 evidence → DACS-5 role-owned bundles) against a live
Demos node and a real x402 USDC settlement on Base Sepolia. It is skipped unless
the full env is present, so `npm test` / CI stay offline.

Each funded attempt is permanently marked **non-rerunnable** (keyed by
`LIVE_E2E_RUN_ID`), so use a fresh run id every time.

Use disposable, testnet-only wallets for this run. Never reuse production or
mainnet keys, commit wallet material, paste it into an issue or log, or put it
directly in shell history. Treat testnet mnemonics and private keys as secrets
even when the balances are small.

## 1. Node version (required)

demosdk's ESM packaging + `avsc` break on Node ≥ 24 (`buffer.SlowBuffer is not a
constructor`). Use **Node 20 or 22** (the versions CI runs). Select it with your
version manager, then run through the local binary:

```bash
nvm use 20            # or: nvm use 22 — anything on 20.19+/22.12+, not >=24
node --version        # confirm you are on 20 or 22 before spending funds
npx vitest run test/integration/funded-two-agent.e2e.test.ts
```

If your shell's `nvm use` doesn't stick in a non-interactive context, invoke the
matching Node binary explicitly (`"$(nvm which 20)" node_modules/.bin/vitest …`)
rather than hard-coding an absolute path.

## 2. Funding (all public, no captcha)

**Demos wallets (DEM)** — one buyer, one seller. Fund each:

```bash
curl -s -X POST https://faucetbackend.demos.sh/api/request \
  -H 'Content-Type: application/json' -d '{"address":"0x<demos-address>"}'
```

~2400 DEM per request. **Denomination:** `getAddressInfo().balance` is in **OS**,
`1 DEM = 1,000,000,000 OS` (raw `2398000000000` = 2398 DEM). Preflight needs
seller ≥ 23 DEM, buyer ≥ 15 DEM (the full two-sided lifecycle anchors several
records per side, so budget well above the old single-sided floors). Funding is
async — poll the balance until it clears the floor before running. The faucet is per-address rate-limited (~2400 / interval) and its
broadcast can silently fail to land; if a wallet stays at 0, mint a fresh wallet
rather than re-requesting the rate-limited one.

**Base Sepolia USDC** — fund the buyer EVM address with test USDC from
`faucet.circle.com`. **Pick the Base Sepolia network explicitly** — the faucet
defaults can land the tokens on Ethereum Sepolia, which this test cannot use.
x402 uses gasless EIP-3009, so the buyer needs USDC, not ETH; the seller EVM only
receives.

## 3. Env

Load these values from a protected environment file outside the repository (or
from a secret manager), rather than prefixing a shell command with literal
credentials. Ensure the file is readable only by its owner and never commit it.
The following block documents variable names and public configuration only:

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
via its own RPC). Public endpoints vary in reliability. During the August 2026
funded validation, the observed state was:

- Observed working: `https://base-sepolia.gateway.tenderly.co`,
  `https://base-sepolia-rpc.publicnode.com`,
  `https://base-sepolia.api.onfinality.io/public`
- Observed flaky/dead: `https://sepolia.base.org`,
  `https://base-sepolia.drpc.org`, `https://1rpc.io/base-sepolia`

Probe both configured endpoints before a funded attempt; this list is an
observation, not an availability guarantee.

## 4. Funded-run safety

Because a run moves real testnet value, the harness is built to fail closed
rather than pay twice or spend without bound:

- **Durable run marker, written before any irreversible work.** Each attempt is
  recorded in a persistent marker directory (created `0700`, owner-only) *before*
  it broadcasts anything. A crashed or repeated attempt is then refused instead
  of re-paying. Keep the marker directory on stable local storage — not a `/tmp`
  path that clears between runs — or the non-rerunnable guarantee is lost.
- **Maximum-total-debit cap.** Set an explicit ceiling on the whole run's spend
  and make it cover **both** the x402 USDC amount **and** the Demos anchor fees,
  not just the payment. The run aborts before broadcasting if the projected total
  debit would exceed the cap.
- **Reconcile, don't blindly rerun.** If a run ends ambiguous (see the
  `evm-authorization-lookup-unavailable` note below), reconcile the original
  attempt on-chain read-only before starting a fresh one.

## 5. Run + expected

Load the protected environment, then run the §1 command. One clean August 2026
run took approximately 75 seconds to commerce-complete and approximately four
minutes for the full audit/bundle path; public-network latency varies. Green =
the full two-sided lifecycle ran on-chain (real DEM fees + a real ~0.000001 USDC
transfer buyer→seller) and both role-owned DACS-5 bundles finalized and
re-verified from cold storage.

## 6. Troubleshooting

- **`Insufficient balance …`** — Demos funding not confirmed yet, or the funded
  address ≠ the mnemonic's address. Verify the balance before running.
- **`evm-authorization-lookup-unavailable`** — the `PAY_RPC` couldn't serve a read
  mid-settlement. The settlement authorization may already have been submitted, so
  do **not** simply retry with a fresh `LIVE_E2E_RUN_ID` — a fresh authorization
  can pay twice. First reconcile the original run read-only (confirm on-chain
  whether the transfer landed) using a more reliable RPC; only start a fresh run
  once you've established the original made no payment.
- **`facilitator-settle-outcome:failure-invalid-exact-evm-transaction-failed`** —
  the public x402 facilitator's on-chain settlement reverted. This facilitator is
  **transiently flaky**. Retry with a fresh run id only after the settlement
  observer establishes an explicit terminal revert/no transfer. Never retry an
  ambiguous timeout or unknown outcome until the original authorization and
  transaction have been reconciled, or the test may pay twice.
- **`request to <url> failed`** — `PAYWALL_URL` was set to a URL instead of the
  literal `local`.
- USDC landed but the test can't see it — confirm it's on **Base Sepolia**
  (chain 84532), not Ethereum Sepolia.
