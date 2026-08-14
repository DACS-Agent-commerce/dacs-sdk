# Fixed-price x402 coordinator

The coordinator is a role-local, transport-neutral job manager for the existing
fixed-price x402 SDK operations. It does not own wallets, start background
workers, create DACS artifacts, or replace the durable session and Demos write
journals used by those operations.

Buyer and seller authorities remain in separate processes:

```text
buyer process                         seller process
-------------                         --------------
agreement/payment jobs                agreement/payment-intake jobs
buyer Demos wallet                    seller Demos wallet
payment-evidence inbox     <------     signed-evidence request outbox
buyer audit job             ------>    finalized anchor receipt inbox
                                      delivery/finalisation/audit jobs
```

The operational request and completion messages are not new normative DACS
artifacts and are not anchored. Applications carry them over an authenticated
transport and provide callbacks that authenticate the counterparty and verify
the finalized anchor receipt. Message hashes, stable identifiers, durable
outboxes, exact request binding, and replay handling are provided here.

## Host-controlled work

Create one coordinator per local authority and inject adapters around the
existing durable SDK operations. Each adapter receives a stable idempotency key
and a generation fence. It must assert that fence immediately before any
irreversible effect and use the existing SDK job pointer to reconcile an
ambiguous earlier result.

```ts
import {
  createFixedPriceX402SellerCoordinator,
  createSellerPaymentEvidenceHandshake,
} from "@kynesyslabs/dacs/commerce";

const paymentEvidence = createSellerPaymentEvidenceHandshake({
  store: durableSellerHandshakeStore,
  seller: sellerClaim,
  buyer: buyerClaim,
  authenticateCompletion,
  verifyAnchorReceipt,
});

const seller = createFixedPriceX402SellerCoordinator({
  store: durableSellerCoordinatorStore,
  workerId: processInstanceId,
  operations: {
    payment: resumeSellerPaymentIntake,
    "payment-evidence": resumeSellerPaymentEvidencePublication,
    delivery: resumeDurableDelivery,
    "delivery-evidence": resumeDeliveryFinalisation,
    audit: resumeSellerBundleFinalisation,
  },
});

await seller.startOrder(order);
await seller.runPending({ limit: 10, signal });
```

`runPending` and `resumePendingOrders` are bounded aliases. They never create a
timer or an unobserved promise. A service supervisor, queue consumer, HTTP
handler, or CLI owns scheduling and graceful shutdown. Buyer and seller loops
can run concurrently because they retain independent stores and wallet nonce
lanes.

The included in-memory stores are process-local references for tests. A
production host must inject durable stores whose `create`/`putRequest`, `claim`,
and `record` operations are atomic and no-overwrite. Multi-process or multi-host
deployments need shared compare-and-swap semantics; writing independent JSON
files without locking does not satisfy these contracts.

## Payment-evidence handshake

The seller handshake's `anchorEvidence` method is the adapter supplied to
`publishSellerSessionSettlement`. On the first call it durably records the exact
seller-signed evidence request and returns `indeterminate`. The host transfers
the request to the buyer without giving the seller buyer-wallet authority.

The buyer then:

1. validates the message and its local buyer destination;
2. authenticates the seller transport identity;
3. cryptographically and semantically verifies the seller-signed evidence;
4. claims the stable request under a generation lease;
5. anchors with the buyer wallet through an idempotent Demos write journal;
6. independently verifies finality, native readback, writer, address, and hash;
7. records a replayable completion.

After authenticating and independently verifying that completion, the seller
records it. A resumed `publishSellerSessionSettlement` call then receives the
same finalized evidence reference and receipt. Lost requests and completions
are replayed; altered messages conflict or fail validation.

## Status semantics

Tracks are independent and retain `not-started`, `running`, `pending-retry`,
`indeterminate`, `final`, `failed`, or `operator-action`, plus attempts,
timestamps, references, retry information, and any authenticated receipt hash.

`combineFixedPriceX402OrderStatus` combines clone-isolated buyer and seller
read models without joining their capabilities. Its milestones mean:

| Milestone | Required observation |
| --- | --- |
| `delivery-ready` | Seller deliverable is verified and the durable finalisation handoff exists. |
| `buyer-received` | Buyer has recorded its local transport observation. |
| `commercial-performance-complete` | Seller delivery evidence is finalized; PC-7 payment evidence may still catch up. |
| `audit-complete` | Both buyer- and seller-owned audit tracks are final. |

`audit-complete` is deliberately not inferred from one actor's local bundle.
The returned SDK job pointers remain the route to the authoritative DACS
session records and write journals; the coordinator stores only scheduling and
status projections.

## External fulfilment boundary

A generation lease cannot make an arbitrary external callback exactly-once.
The delivery adapter must use its stable idempotency key with a durable
intent/perform/commit/reconcile protocol, or call a pure deterministic
deliverable producer. After an ambiguous response it may retry only when the
external system proves authoritative absence. This coordinator never treats a
timeout as proof that delivery did not happen.
