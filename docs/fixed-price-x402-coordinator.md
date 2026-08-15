# Fixed-price x402 coordinator

This module is a role-separated, transport-neutral scheduler around the SDK's
existing durable fixed-price x402 operations. It does not own wallets, host an
HTTP service, invent DACS artifacts, or replace the authoritative session and
write journals used by those operations.

The supported artifact/conformance revision is
`965df755aba4ff392f1fb37a93d287242b177ba4`, the immutable revision pinned by
`scripts/sync-vectors.mjs`. The implementation was also checked against DACS
Standard `next` at `81ded2b49851d8fa17399e3fdade9e36e33a4ff7` on 15 August
2026. A later Standard revision is not accepted merely because a peer supplies
its hash: supporting it requires an explicit SDK update and conformance run.

## Trust and authority boundaries

Buyer and seller authorities remain in separate processes and retain different
SDK job pointers:

```text
buyer process                         seller process
-------------                         --------------
buyer agreement/payment jobs          seller agreement/payment-intake jobs
buyer Demos wallet                    seller Demos wallet
payment-evidence inbox     <------     signed-evidence request outbox
buyer receipt/audit jobs    ------>    completion inbox
                                      fulfilment/evidence/audit jobs
```

The request and completion envelopes are SDK transport messages, not normative
DACS artifacts and not SR-2 records. Applications carry them over JWT, mTLS, a
signed envelope, or another authenticated transport. The host authenticator
returns a verified principal, audience, message ID, message hash and
authentication hash. The SDK compares all five values with the exact request or
completion before retaining it; an arbitrary bearer-auth hash is insufficient.

This first production profile explicitly pins
`seller-as-phase-orchestrator-v1`. The evidence signer is the DACS phase
orchestrator (DACS-4 §9.7), not intrinsically “the seller.” The profile chooses
the seller as that orchestrator and binds the exact claim. Supporting a buyer
or third-party orchestrator requires another reviewed profile rather than a
relaxed equality check.

## Exact protocol binding

Every order and payment-evidence request binds:

- `commerceProfile = dacs-sdk:fixed-price-x402:v1`;
- the exact supported DACS Standard revision;
- phase `pay-x402` and rail type `x402`;
- the authenticated registry index reference and content hash;
- the authenticated rail-definition reference, hash, ID and version;
- the exact EIP-155 network and `pay-x402` handler;
- authoritative rail availability `live`; and
- the seller-orchestrator claim and topology.

The production slice refuses `pay-dem`, other `pay-*` phases, a non-live rail,
an unpinned Standard revision, a wrong network, and success evidence without one
signed `x402-event` coordinate. It does not treat a discovery/catalog
availability hint as DACS-4 RAV authority.

```ts
import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  type FixedPriceX402ProtocolBinding,
} from "@kynesyslabs/dacs/commerce";

const protocol: FixedPriceX402ProtocolBinding = {
  commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
  phase: "pay-x402",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: sellerClaim,
  rail: {
    registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
    registryIndexHash: verifiedRegistryIndexHash,
    railDefinitionRef: verifiedRailDefinitionRef,
    railDefinitionHash: verifiedRailDefinitionHash,
    railId: "x402:default",
    railVersion: 2,
    railType: "x402",
    phaseHandler: "pay-x402",
    network: "eip155:8453",
    availability: "live",
  },
};
```

## Host-controlled coordinator work

Factories admit only role-owned operations. A buyer cannot register `delivery`
or `delivery-evidence`; a seller cannot register `buyer-received`. The v3 store
record has two deliberately different integrity domains: `bindingHash` covers
the shared job, canonical actor identities, and protocol; `localBindingHash`
covers that shared hash plus the exact role and role-local `sdkJobs`. Private
job pointers therefore never cross the actor boundary, but a store cannot
silently substitute them inside one actor's retained order.

Every effect receives a generation fence and an idempotency key derived from
the role-local binding, role, track and exact role-local job identity. The adapter
must assert the fence immediately before an irreversible action and use the key
in its own intent/perform/commit/reconcile journal.

Each operation also receives the scheduler's optional `AbortSignal`. This is
cooperative cancellation: an adapter should stop before an irreversible action
when the signal is aborted. Once submission may have occurred, it must retain
the attempt as ambiguous and reconcile it; the coordinator deliberately does
not race and forget an irreversible promise.

```ts
import {
  createFixedPriceX402SellerCoordinator,
} from "@kynesyslabs/dacs/commerce";

const seller = createFixedPriceX402SellerCoordinator({
  store: durableSellerCoordinatorStore,
  workerId: processInstanceId,
  operations: {
    // Agreement is required by the dependency DAG before payment intake.
    agreement: resumeSellerAgreement,
    payment: resumeSellerPaymentIntake,
    "payment-evidence": resumeSellerPaymentEvidencePublication,
    delivery: resumeDurableDelivery,
    "delivery-evidence": resumeDeliveryFinalisation,
    audit: resumeSellerBundleFinalisation,
  },
});

await seller.startOrder({
  jobId,
  buyer: buyerClaim,
  seller: sellerClaim,
  protocol,
  sdkJobs: {
    role: "seller",
    agreement: sellerAgreementJob,
    payment: sellerPaymentJob,
    paymentEvidence: sellerPaymentEvidenceJob,
    fulfilment: sellerFulfilmentJob,
    deliveryEvidence: sellerDeliveryEvidenceJob,
    audit: sellerAuditJob,
  },
});

const page = await seller.runPending({ limit: 10, signal });
if (page.nextCursor) {
  await seller.runPending({ cursor: page.nextCursor, limit: 10, signal });
}
```

`runPending` and `resumePendingOrders` are bounded aliases. They create no timer
or hidden promise. The injected store performs a cursor-based query over only
runnable orders rather than returning all historical records. A supervisor,
queue, request handler or CLI owns scheduling.

## Worker status versus DACS outcome

Operational worker state and normative outcome are separate:

- `pending-retry`, `indeterminate`, and `operator-action` describe scheduling;
- `final + success`, `final + failure(errorClass)`, and `final + aborted`
  describe the retained DACS result.

A failed payment therefore does not unlock delivery. Its `payment-evidence`
track can still finalize failure evidence, after which `audit` can publish the
mandatory failed DACS-5 bundle. An abort follows the analogous terminal-bundle
path. Evidence tracks themselves must finish successfully; returning a
failure-shaped evidence result cannot be used to bypass the dependency graph.
Every failure retains its absolute `faultedParty`; every abort retains its
absolute `withdrawnBy`. A role-local audit callback must reproduce that exact
originating classification. Once payment has reached rail finality—or delivery
has become irreversible—an operation cannot relabel the result as an abort
(DACS-5 §10.3.1 ST-3).

`combineFixedPriceX402OrderStatus` is an operational projection only. Even when
both opaque audit callbacks have returned, it reports `actor-audit-final` and
can never assert normative `audit-complete`. Only the asynchronous
`verifyFixedPriceX402AuditCompletion` gate can make that upgrade. It requires
both exact v0.3 `FaultAttestationBundle` copies, full signer sets, independently
readable recursive reference graphs, authenticated finalized CORE §5.1 receipts
for the bundles and every dependency, a hash-matched artifact read at each
receipt's exact native address, applicable BB-1 publication, and a unified
§10.4.3 pair verdict. That preserves role-relative bundle outcomes, absolute
hashed `faultedParty`, exact type/version, and `phaseSummary`; none is inferred
from the scheduler's coarse outcome tokens. A one-sided failed or aborted phase
blocks any combined success projection while its terminal audit is pending.
Contradictory actor phase terminals are rejected rather than hidden behind a
later audit.

An operator can explicitly requeue a non-final track:

```ts
await seller.repairTrack({
  jobId,
  track: "delivery-evidence",
  operatorReasonCode: "proof-provider-restored",
});
```

Final normative results are immutable through this repair API.

## Payment-evidence handshake

The seller handshake is the `anchorEvidence` adapter supplied to seller
settlement publication. Its outbox atomically reserves the message ID, effect
ID and canonical DACS-4 payment address. On the buyer, the same reservations
ensure that two differently hashed requests cannot reach the wallet for one
logical payment effect or slot.

```ts
import {
  createSellerPaymentEvidenceHandshake,
} from "@kynesyslabs/dacs/commerce";

const paymentEvidence = createSellerPaymentEvidenceHandshake({
  store: durableSellerHandshakeStore,
  seller: sellerClaim,
  buyer: buyerClaim,
  workerId: processInstanceId,
  protocol,
  authenticateCompletion: async (completion, transportContext) => {
    const verified = await verifyCompletionTransport(completion, transportContext);
    return {
      disposition: "authenticated",
      peer: {
        principal: verified.claim,
        audience: verified.audience,
        messageId: completion.messageId,
        messageHash: completion.completionHash,
        authenticationHash: verified.authenticationHash,
      },
    };
  },
  verifyAnchorReceipt,
});
```

Transport delivery uses durable claim/send/ack rather than repeatedly listing
the first ten records:

```ts
let cursor: string | undefined;
do {
  const page = await paymentEvidence.claimOutboundRequests({ cursor, limit: 10 });
  for (const claim of page.items) {
    try {
      await sendToBuyer(claim.request);
      await paymentEvidence.acknowledgeOutboundRequest(claim);
    } catch {
      const now = await durableSellerHandshakeStore.readTime();
      await paymentEvidence.releaseOutboundRequest(claim, {
        reasonCode: "transport-ambiguous",
        retryAt: now + 1_000,
      });
    }
  }
  cursor = page.nextCursor;
} while (cursor);
```

The buyer applies the symmetric completion outbox API:
`claimOutboundCompletions`, `acknowledgeOutboundCompletion`, and
`releaseOutboundCompletion`.

Both buyer and seller handshake factories are fixed to one canonical actor pair
and one exact protocol/rail binding. Every store query, claim, mutation,
reservation, and outbox transition carries the resulting non-normative
`scopeHash`; every record or claim returned by a store is independently checked
against it before an authenticator, wallet, anchor, or transport callback can
run. CORE §B.1 CF-2 governs accepted ClaimReference bytes and CF-3 governs actor
matching, so advisory parameters cannot create a second tenant for the same
party. This pair-scoped record contract is handshake-store v3, and the
completion envelope's explicit seller binding is completion-envelope v3;
retained v2 state requires an explicit host migration and is otherwise rejected
as unsupported.

### Ambiguous wallet effects

Every exception, indeterminate anchor response, and indeterminate receipt read
is durably classified and releases its lease immediately. It never waits for
the default 30-second lease merely because a callback returned badly. A
permanent contradiction moves to `operator-action` and cannot loop forever.

The buyer `anchorEvidence` adapter must use `fence.idempotencyKey` in a durable
intent/perform/commit/reconcile journal, monotonically fence generations, and
call `fence.assertCurrent()` immediately before atomically acquiring permission
to perform the irreversible effect. `reconcileAnchor` may report authenticated
absence only after that same journal has fenced or quiesced every older
performer; substrate non-observation alone is not enough while an old callback
can still submit. These adapter obligations close the slow-callback race that a
lease and a pre-callback fence check cannot close by themselves.

Before invoking `anchorEvidence`, the buyer store's atomic `claimBuyer` write
makes the leased work `reconciliation-required` with the same fence while
returning `mode: "anchor"` for that one worker. If the worker disappears while
the wallet callback is in flight, an expired lease can therefore be reclaimed
only in reconciliation mode; it cannot silently repeat the irreversible call.

An ambiguous effect moves to `reconciliation-required`. The next worker must
invoke `reconcileAnchor`; it may:

- return the already-final anchor and complete it;
- return authenticated absence with an `absenceProofHash`; or
- remain indeterminate / declare an invalid contradiction.

Authenticated absence is committed before another wallet call is permitted.
The retry occurs in a later claimed generation and is itself durably marked
`reconciliation-required` before the callback begins, closing both crash
windows around “absence observed” and “effect repeated.” `repairRequest` is
the explicit operator requeue path and conservatively returns work to
reconciliation, not directly to the wallet.

Buyer `anchorEvidence`, `reconcileAnchor`, and `verifyAnchorReceipt` callback
inputs receive the same optional cooperative `AbortSignal` passed to
`runPending`. As with coordinator operations, adapters must not treat an abort
as proof that a submitted wallet effect did not occur.

## Durable store requirements

The included stores are process-local references. Store conformance is
structural: plain object stores and class instances with prototype methods are
both supported. Production implementations must provide one shared atomic
authority with:

- database/server-authoritative time for lease decisions;
- monotonic logical `revision` increments;
- atomic message/effect/address reservations;
- compare-and-swap claims and fenced outcome writes;
- durable attempt classifications and retry times;
- cursor-based runnable and outbox queries; and
- durable claim/send/ack outbox state.

Raw callback exceptions are never persisted. Records retain bounded reason
codes such as `anchor-threw` or `operation-threw`; sensitive provider messages,
headers, credentials and stack traces stay outside the SDK journal.

## Normative traceability

| Coordinator invariant | DACS Standard source |
| --- | --- |
| Canonical actor bytes and identity matching | CORE §B.1 CF-2/CF-3 |
| Authenticated registry index/definition, exact version and handler pin | DACS-1 §6.3.4 LRR-1..LRR-6; DACS-4 §9.4.3 RD-1..RD-6 |
| Production-live authoritative availability only | DACS-4 §9.4.4 RAV-R1..RAV-R5 (including current `mocked` production refusal) |
| x402 receipt/event/network binding | DACS-4 §9.5.7 X402-1..X402-4 |
| Exact job/rail/phase-index payment address and event uniqueness | DACS-4 §9.5.1 PC-2; §9.5.8 SB-1..SB-3 |
| Rail-final payment is never repeated because SR-2 evidence is catching up | DACS-4 §9.5.1 PC-7 |
| SettlementEvidence signer is the phase orchestrator | DACS-4 §9.7 `SettlementEvidence.signature` |
| Abort forbidden after irreversible value; failed/aborted session produces a terminal bundle | DACS-5 §10.3.1 ST-3/ST-6; §10.4.1 |
| Completed status requires recursive finalized bundle/dependency audit | DACS-5 §10.3.1 ST-11; §10.4.1–§10.4.3 |
| Delivery cannot follow a failed payment; failure evidence remains reachable | DACS-5 §10.3.1 state transition table and state→bundle outcome mapping |

The SDK operational envelopes, leases, cursors and commerce-profile name are
not normative DACS fields and are never added to signed DACS artifacts.
