# Experimental DACS + UCP + x402 MVP

> Claude's commerce blueprint makes agentic checkout accessible. DACS makes
> that checkout negotiable, identity-bound, and independently verifiable—from
> agreement through x402 payment to delivery evidence.

Anthropic's September 2026 commerce-agent announcement provides shopping and
merchant blueprints, with UCP integration for catalog and checkout, while
leaving payment to the merchant's checkout or chosen payment provider. This MVP
fills a complementary trust layer: UCP remains the merchant-facing commerce
interface; DACS establishes who the parties are, what they negotiated, which
payment coordinates were authorised, and what evidence exists after payment.

This module is **experimental application-profile code**, not a claim that UCP,
x402, or the DACS Standard has adopted a new normative payment handler. It pins
UCP release `2026-08-25` and uses the DACS-owned namespace
`io.github.dacs-agent-commerce.payment.x402`. Its artifacts use the CORE §B.7
`dacs-x-...` extension convention. A future standards PR should publish the
handler schema and vectors before production interoperability is claimed.

## What the MVP proves

The SDK now composes these existing boundaries:

1. Discover a merchant's UCP profile and exact REST Checkout capability.
2. Authenticate the complete profile hash and its public key IDs against the
   merchant's DACS ClaimReference.
3. Derive a bilateral DACS RFQ agreement from a verified negotiable Listing.
4. Check that the agreed price remains inside the Listing's inclusive price
   band and that buyer and seller signatures verify.
5. Require the merchant's rail, token, network, resource base, and finality
   claims to match a steward-authenticated definition returned by `resolveRail()`.
6. Create a UCP checkout using a deterministic DACS idempotency key.
7. Have the merchant sign the exact ready checkout, agreement hash, x402
   destination, UCP presentment amount/currency, settlement asset amount,
   network, resource, and DACS phase index.
8. Require a trusted-UI approval or AP2 mandate before value can move. A DACS
   agreement does not silently override UCP's completion-authorisation rule.
9. Settle through the existing DACS x402 rail, requiring independently observed
   block-depth finality and a matching `x402-event` transaction reference.
10. Complete the UCP checkout and fetch its order without paying again if UCP
   bookkeeping must be retried.
11. Produce phase-orchestrator-signed normative DACS-4 `SettlementEvidence` and
    separate merchant-signed, hash-only order evidence.

The flow deliberately does **not** treat UCP `completed` as proof that the DACS
deliverable is complete. Order and fulfillment data still need the normal DACS
delivery-verification and DACS-5 bundle path.

## Merchant effort

The merchant keeps its existing UCP checkout and order system. The minimum
integration is narrow:

- advertise one experimental x402 handler in `/.well-known/ucp` and in eligible
  Checkout responses;
- supply rail ID, CAIP-2 network, token contract, symbol/decimals, payee address,
  paywall resource, finality depth, ISO 4217 presentment currency/minor-unit
  exponent, and the MVP's explicit 1:1 stable-asset conversion policy;
- publish a DACS-signed identity binding for the UCP profile hash and key IDs;
- run `createUcpDacsMerchantAttestor()` inside the merchant trust boundary (or
  implement its two-method interface behind a remote extension transport);
- persist the existing UCP and x402 idempotency keys durably in production;
- return normal UCP Checkout and Order documents. Customer/order PII is hashed,
  not copied into DACS evidence.

No catalog migration, replacement checkout, custody service, or change of
merchant-of-record is required. The example namespace and artifact transport
are the pieces that still need standards review.

## Trust boundaries

| Input | Authority | What the client enforces |
| --- | --- | --- |
| UCP profile | Merchant endpoint + DACS identity signature | Exact release, HTTPS, complete hash, public keys, handler coordinates |
| RFQ result | Buyer and seller DACS signatures | Listing pin, price band, channel hash, rail, deadline |
| UCP Checkout | Merchant DACS signature | Items, ISO 4217 total, expiry, agreement hash, x402 coordinates and settlement amount |
| Completion approval | Trusted UI or AP2 | Approval occurs before x402 settlement |
| x402 settlement | Steward-authenticated rail plus independent chain observation | Token, payee, network, resource, receipt hash, tx identity, block depth, and an evidence signer verified as the authenticated phase orchestrator before checkout creation or funds movement |
| UCP Order | Merchant DACS signature | Checkout/order link and complete hashes; no PII copied |
| DACS completion | DACS-4/5 verification | Payment evidence is not confused with delivery completion |

## SDK surface

The public entry points are:

```ts
import {
  createUcpRestClient,
  createUcpMerchantIdentityBinding,
  createUcpDacsMerchantAttestor,
  deriveUcpRfqAgreement,
  runUcpX402Mvp,
} from "@kynesyslabs/dacs/commerce";
```

`runUcpX402Mvp()` accepts a rail returned by `resolveRail()` and the SDK's
existing `settle(SettleRequest)` seam. The injected executor must be constructed
from that same authenticated definition, normally through `settleFromRail()`;
the workflow rejects UCP coordinates that disagree with it before checkout. The
reference workflow's in-memory store is suitable only for tests; crash-safe
production at-most-once payment requires durable storage and reconciliation.

Merchant attestations are intentionally injected through
`UcpDacsMerchantAttestor`. The buyer never receives the merchant's DACS signing
key. A networked implementation should convey those signed artifacts through a
published UCP extension schema or an authenticated companion endpoint.

## Current limitations

- The handler and three signed extension artifacts are not yet normative.
- Only one RFQ, one `commit-agreement`, and one `pay-x402` phase are supported.
- UCP ISO 4217 minor units and token base units remain distinct. The MVP supports
  two-decimal ISO 4217 currencies and only an explicitly advertised 1:1
  presentment-to-stable-asset rate. Multi-currency conversion, tax changes,
  shipping changes, and split payments fail closed rather than being
  renegotiated automatically.
- The MVP requires `x402-event` plus block-depth finality; provider receipt alone
  is insufficient.
- AP2 can satisfy the completion-authorisation seam, but automated extraction
  and validation of a UCP AP2 mandate is follow-up work.
- Full DACS-5 bundle production and a live merchant extension transport remain
  follow-up work. The MVP returns the exact evidence inputs needed for them.

## Security properties exercised by tests

The test suite covers price inflation, injected checkout items, cross-domain
signatures, merchant/authenticated-rail token mismatch, incorrect payment
destination/finality, phase-orchestrator authority, refusal of completion
approval, exact RFQ price bounds, retry after post-payment UCP failure, and
at-most-once settlement for the same DACS job/phase.

## Funded live gate

`test/integration/ucp-x402.live.test.ts` starts a local UCP merchant and x402
paywall, then performs a real, independently verified EVM settlement. It is
opt-in and capped at `0.01` USDC:

```sh
LIVE_UCP_X402_CONFIRM=1 npx vitest run \
  test/integration/ucp-x402.live.test.ts --reporter=verbose
```

The gate requires `BUYER_EVM_KEY`, `SELLER_EVM`, `PAY_NETWORK`, `PAY_TOKEN`,
and either `PAY_RPC` or the built-in Base Sepolia RPC default. It refuses Base
mainnet unless `LIVE_E2E_ALLOW_MAINNET=1` is also explicitly supplied.

Relevant upstream material:

- Anthropic, [Building Commerce Agents with Claude](https://claude.com/blog/claude-for-commerce-agents)
- UCP, [Checkout Capability](https://ucp.dev/specification/shopping/checkout/)
- UCP, [Protocol Overview and Payment Handlers](https://ucp.dev/specification/overview/)
