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
4. atomically retain the exact authorization as a durable settlement intent;
5. settle only a newly claimed intent, or reconcile an existing/ambiguous one;
6. durably retain the exact terminal settlement outcome without overwrite;
7. independently derive and verify the complete X402-1/X402-2 receipt;
8. invoke the mandatory payment-authorization gate (normally #119's
   `verifySellerPaymentIntake`, including agreement, Listing, payee, finality,
   session binding, and uniqueness);
9. invoke durable fulfilment (normally #120/#121) only after that gate returns
   an opaque store-backed authorization; and
10. release the response with the protocol settlement header.

No application delivery callback runs before settlement and normative payment
authorization. The x402 server is not given a prepared deliverable body. The
`idempotencyKey` received by the final callback is transport-only; #120 derives
its canonical fulfilment identity from the exact authorization retained behind
the consumed #119 permit, and applications must not substitute the x402 key for
that identity.

`settlementStore.claim()` is a write-ahead, atomic put-if-absent operation by
`settlementKey`. A durable implementation retains the complete intent (including
the exact `PAYMENT-SIGNATURE` bearer value and parsed payer authorization) and
must return `conflict` for the same key with a different `bindingHash`.
`recordOutcome()` is atomic and no-overwrite. A process
crash, provider timeout, explicit provider failure, or response loss after
either operation leaves an intent that can only be reconciled; the SDK never
submits it again. Stored authorization material is confidential operational
state.

`load()` runs before provider verification. On restart, an exact replay of the
retained `PAYMENT-SIGNATURE` resumes that verified intent directly; this matters
because a provider may reject verification after the EIP-3009 nonce has already
been consumed. A missing or different signature never resumes retained state.
Reconciliation may return terminal `failed` only after proving both that no
transfer occurred and that the retained authorization can no longer settle. A
temporary chain/facilitator `not-found` result while an original claimant may be
in flight is `pending`, which prevents a concurrent retry from racing a live
submission into a false terminal failure.

An ambiguous result uses `settled: "unknown"`, never `false`. An explicit
successful settlement with malformed evidence uses
`settlement-evidence-indeterminate` with `settled: true`: value moved, but the
record cannot authorize delivery. All post-settlement error responses retain a
transport-safe settlement header when the provider supplied one, so the payer
can recover the receipt; an unsafe header is never echoed.

## Traceability

| Adapter behavior | Normative source |
| --- | --- |
| x402 v2 payment and complete settlement-response receipt | DACS-4 §9.5.7 procedure; X402-1 |
| JCS/CF-1 receipt commitment, never transaction-hash substitution | DACS-4 §9.5.7 X402-2 |
| Transaction/network consistency and independently verifiable claim | DACS-4 §9.5.7 X402-3/X402-4 |
| Exact EIP-3009 nonce derived from `(jobId, phaseIndex)` | DACS-4 §9.5.8 SB-1/SB-3 |
| Durable write-ahead settlement and reconcile-only ambiguous recovery | DACS-4 §9.5.7 failure modes; §9.5.8 SB-3 |
| Fulfilment only after agreement, payee, rail, finality, and uniqueness authorization | DACS-3 CA-1; DACS-4 §9.5.1 PC-1..PC-7, PB-1..PB-3, PIPE-3/PIPE-6; §9.5.8 SB-1/SB-2 |

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
  {
    settlementStore: durableSettlementStore,
    reconcileSettlement: (intent) => reconcileOriginalAuthorization(intent),
    authorizePayment: async ({ jobId, phaseIndex, paymentClaim }) => {
      const intake = await authorizeFinalizedX402Payment({
        jobId,
        phaseIndex,
        receipt: paymentClaim,
      });
      return intake.disposition === "verified" && intake.fulfilment !== "none"
        ? { disposition: "authorized", authorization: { permitId: intake.permitId } }
        : { disposition: "indeterminate", reason: intake.reason };
    },
    fulfil: async ({ authorization }) => {
      const result = await resumeDurableSellerFulfilment(authorization.permitId);
      return result.decision === "completed"
        ? { disposition: "fulfilled", body: result.bundleContribution }
        : { disposition: "indeterminate", reason: result.code };
    },
  },
);

// A framework adapter converts its request into X402PaywallHttpAdapter and
// writes `result.response`. The SDK does not bind the application to Express,
// Fetch, WebSocket, L2PS, or a hosted deployment.
const result = await paywall.handle({ jobId, phaseIndex, request: adapter });
```

No new DACS signed field or artifact is introduced by this adapter.
