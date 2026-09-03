# Seller x402 paywall

Normative source audited: DACS Standard `next` at
`741057bf26509ca2701ee78171e6049b1bc665b4` (DACS-4 v0.6), the immutable
adopted revision pinned by the fixed-price coordinator.

`createX402Paywall` is the thin HTTP-protocol adapter for the transport-
independent seller lifecycle. It does not start a server or select a framework.
Applications provide the framework adapter and host the route themselves.

The callback sequence is deliberately:

1. verify the x402 v2 authorization;
2. require exact configured network, asset, amount, and payee terms;
3. recompute and require the DACS EIP-3009 nonce for `(jobId, phaseIndex)`;
4. authenticate the finalized commitment, exact Agreement/Listing/session,
   payer/payee, rail snapshot, resource, and configured terms before value can
   move;
5. atomically retain both that authenticated scope and the exact payer
   authorization as a versioned durable settlement intent;
6. settle only a newly claimed intent, or reconcile an existing/ambiguous one;
7. independently derive and verify the complete X402-1/X402-2 receipt before
   any successful terminal outcome is recorded;
8. durably retain the exact verified terminal settlement outcome without
   overwrite;
9. invoke the mandatory payment-authorization gate (normally #119's
   `verifySellerPaymentIntake`, including agreement, Listing, payee, finality,
   session binding, and uniqueness);
10. invoke durable fulfilment (normally #120/#121) only after that gate returns
   an opaque store-backed authorization; and
11. release the response with the protocol settlement header.

No application delivery callback runs before settlement and normative payment
authorization. The x402 server is not given a prepared deliverable body. The
`idempotencyKey` received by the final callback is transport-only; #120 derives
its canonical fulfilment identity from the exact authorization retained behind
the consumed #119 permit, and applications must not substitute the x402 key for
that identity. The callback must nevertheless be idempotent for the supplied
stable key because a payer can retry after settlement while durable delivery
reconciliation remains pending; the recommended #120/#121 composition already
provides that guarantee.

This deliberately resolves the ordering proposed by issue #24 differently from
its original app-side prototype. `verify` authenticates a payer authorization;
it does not prove that value moved. Running application work between `verify`
and `settle` would expose the seller to an unpaid irreversible effect and would
not provide a restart-safe boundary. The SDK therefore implements the
pay-then-deliver pipeline selected by the finalized Listing: authenticate and
retain the exact session, settle or reconcile to rail finality, authorize that
payment, then enter durable idempotent fulfilment. A fulfilment failure after
that point is reported as `settled: true`; it never attempts to cancel or
misrepresent the already-final payment.

DACS-4 PC-7 does not reverse this order. It separates rail finality from the
later SR-2 `SettlementEvidence` anchor: once the x402 payment is independently
known final, evidence publication catches up through its durable idempotent job
and cannot cause a second payment. That bookkeeping may remain pending while
delivery proceeds. Delivery evidence remains the gate for DACS-4 commerce
completion, and DACS-5 terminal audit publication remains later still.

`settlementStore.claim()` is a write-ahead, atomic put-if-absent operation by
`settlementKey`. A durable implementation retains the complete intent (including
the exact `PAYMENT-SIGNATURE` bearer value, parsed payer authorization, and
authenticated pre-settlement session scope) and must return `conflict` for the
same key with a different `bindingHash`.
`recordOutcome()` is atomic and no-overwrite. A process
crash, provider timeout, explicit provider failure, or response loss after
either operation leaves an intent that can only proceed through reconciliation.
The only permitted re-drive is after `authoritatively-absent`: that result means
the reconciler proved the exact authorization did not settle, atomically granted
this caller the sole recovery drive, and fenced any older invocation. The SDK
then reuses the retained payload and its same derived nonce; it never creates a
replacement authorization or phase identity. Stored authorization material is
confidential operational state.

`load()` runs before provider verification. On restart, an exact replay of the
retained `PAYMENT-SIGNATURE` resumes that verified intent directly; this matters
because a provider may reject verification after the EIP-3009 nonce has already
been consumed. A missing or different signature never resumes retained state.
Once any intent exists for a phase, a missing, differently encoded, or different
bearer is a `settlement-authorization-conflict` with `settled: "unknown"`; it is
never reported as an ordinary unpaid request, even if a terminal record exists.
Reconciliation may return terminal `failed` only after proving both that no
transfer occurred and that the retained authorization can no longer settle. A
temporary chain/facilitator `not-found` result while an original claimant may be
in flight is `pending`, which prevents a concurrent retry from racing a live
submission into a false terminal failure.

An ambiguous result uses `settled: "unknown"`, never `false`. A provider-reported
successful settlement with malformed evidence is not persisted as terminal and
uses `settlement-evidence-indeterminate` with `settled: true`: value moved, but
the record cannot authorize delivery. An exact replay can later recover through
a valid reconciled receipt. All post-settlement error responses retain a
transport-safe settlement header when the provider supplied one, so the payer
can recover the receipt; an unsafe header is never echoed.

## Traceability

| Adapter behavior | Normative source |
| --- | --- |
| x402 v2 payment and complete settlement-response receipt | DACS-4 §9.5.7 procedure; X402-1 |
| JCS/CF-1 receipt commitment, never transaction-hash substitution | DACS-4 §9.5.7 X402-2 |
| Transaction/network consistency and independently verifiable claim | DACS-4 §9.5.7 X402-3/X402-4 |
| Exact EIP-3009 nonce derived from `(jobId, phaseIndex)` | DACS-4 §9.5.8 SB-1/SB-3 |
| Durable write-ahead settlement and exact-nonce fenced recovery | DACS-4 §9.5.7 failure modes; §9.5.8 SB-3 |
| Finalized, exact commitment/session authorization before value moves | DACS-4 §9.9 PIPE-6 |
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
const sellerSpine = createX402SellerSpine({
  settlementStore: durableSettlementStore,
  reconcileSettlement: (intent) => reconcileOriginalAuthorization(intent),
  receiptStore: durableSellerReceiptStore,
  // This resolver returns `verified` only after authenticating a finalized
  // commitment and its exact job, Agreement hash, Listing ref/logical address,
  // rail registry, payer/payee, resource, and advertised x402 terms.
  resolveCommittedSession,
  paymentIntakeDeps,
  fulfilmentDeps,
  fulfilmentDurability,
  renderResponse: ({ fulfilment }) => ({
    status: 200,
    body: fulfilment,
  }),
});

const paywall = await createX402Paywall({
  route: "GET /deliver/:jobId",
  network: "eip155:84532",
  payTo: sellerAddress,
  amount: "250000",
  asset: usdcAddress,
  eip712: { name: "USDC", version: "2" },
  facilitator: { url: facilitatorUrl },
}, sellerSpine);

// A framework adapter converts its request into X402PaywallHttpAdapter and
// writes `result.response`. The SDK does not bind the application to Express,
// Fetch, WebSocket, L2PS, or a hosted deployment.
const result = await paywall.handle({ jobId, phaseIndex, request: adapter });
```

No new DACS signed field or artifact is introduced by this adapter.
