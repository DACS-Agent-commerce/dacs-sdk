# Seller x402 paywall

Normative source audited: DACS Standard `next` at
`c2ecd9fa658776f5511f2414d7b4c3e23b847463` (DACS-4 v0.5).

`createX402Paywall` is the thin HTTP-protocol adapter for the transport-
independent seller lifecycle. It does not start a server or select a framework.
Applications provide the framework adapter and host the route themselves.

The callback sequence is deliberately:

1. verify the x402 v2 authorization;
2. require exact configured network, asset, amount, and payee terms;
3. recompute and require the DACS EIP-3009 nonce for `(jobId, phaseIndex)`;
4. prepare the application response;
5. settle the verified authorization;
6. independently derive and verify the complete X402-1/X402-2 receipt;
7. release the prepared response with the protocol settlement header.

The prepared body is withheld if verification, fulfilment, settlement, or
receipt verification fails. A callback should use a durable, idempotent work
identity because an HTTP or facilitator failure can occur after it returns. The
callback receives `idempotencyKey`, the stable result of
`x402PaywallFulfilmentKey({ jobId, phaseIndex })`, for that operational record. An
`indeterminate` result never authorizes the caller to repeat an irreversible
effect without reconciliation. A successful result includes the exact
`SellerPaymentClaim` accepted by `verifySellerPaymentIntake`; finality and
on-chain transfer observation remain that core's responsibility.

## Traceability

| Adapter behavior | Normative source |
| --- | --- |
| x402 v2 payment and complete settlement-response receipt | DACS-4 §9.5.7 procedure; X402-1 |
| JCS/CF-1 receipt commitment, never transaction-hash substitution | DACS-4 §9.5.7 X402-2 |
| Transaction/network consistency and independently verifiable claim | DACS-4 §9.5.7 X402-3/X402-4 |
| Exact EIP-3009 nonce derived from `(jobId, phaseIndex)` | DACS-4 §9.5.8 SB-1/SB-3 |
| Retry after an ambiguous provider result requires reconciliation | DACS-4 §9.5.7 failure modes; §9.5.8 SB-3 |
| Seller payment claim still passes agreement, payee, rail, finality, and uniqueness gates | DACS-4 §9.5.1 PC-1..PC-7, PB-1..PB-3; §9.5.8 SB-1/SB-2 |

## Configuration boundaries

- `network` is a positive CAIP-2 `eip155:{chainId}` value. Legacy network names
  and bare integers are rejected.
- `amount` is already integer token base units.
- `payTo` and `asset` are exact EVM addresses.
- `eip712.name` and `eip712.version` are required and advertised in the route's
  x402 `extra` object so EIP-712 authorization signing is reproducible.
- A URL-configured facilitator must use credential-free HTTPS. Auth headers can
  be produced by the injected callback; credentials do not belong in SDK state.
- `@x402/core` and `@x402/evm` are optional peers loaded only by the live factory.

## Framework-neutral sketch

```ts
const paywall = await createX402Paywall(
  {
    route: "GET /deliver/:jobId",
    network: "eip155:84532",
    payTo: sellerAddress,
    amount: "250000",
    asset: usdcAddress,
    eip712: { name: "USDC", version: "2" },
    facilitator: { url: facilitatorUrl },
  },
  async ({ jobId, phaseIndex, payer, request }) => {
    return prepareIdempotentDelivery({ jobId, phaseIndex, payer, request });
  },
);

// A framework adapter converts its request into X402PaywallHttpAdapter and
// writes `result.response`. The SDK does not bind the application to Express,
// Fetch, WebSocket, L2PS, or a hosted deployment.
const result = await paywall.handle({ jobId, phaseIndex, request: adapter });
```

No new DACS signed field or artifact is introduced by this adapter.
