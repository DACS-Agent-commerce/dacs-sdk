# AP2 settlement safety core

The SDK exposes a provider-neutral `pay-ap2` settlement core. It implements the
DACS-4 §9.5.6 boundaries that must be identical for every provider:

- exact AP2-6 provider idempotency-key derivation;
- exact-compact-JWS `transaction_id` derivation;
- separate CheckoutMandate and PaymentMandate admission;
- the stricter non-deterministic merchant-checkout signature profile;
- atomic AP2-7 transaction/session/phase binding;
- generation-fenced recovery after process or transport failure;
- provider metadata and split-credential registration gates; and
- authenticated status/amount/currency/session checks before success.

It does not contain card-network credentials or pretend that a generic HTTP
response is an authenticated AP2 receipt. Applications inject two explicit
boundaries:

1. `Ap2MandateVerifier`, which cryptographically verifies both mandate
   artifacts and the merchant signature; and
2. `Ap2ProviderAdapter`, whose privileged `submit` operation remains local and
   whose `readAttestedStatus` operation uses a distinct status-only credential
   through the selected SR-3 binding.

`Ap2BindingStore` is the required durable atomic store contract. The exported
in-memory implementation is for tests and development only. A production store
must persist its transaction binding, lease generation, provider reference and
terminal result across restart. Its first claim must also atomically bind the
phase (the AP2-6 key of `(jobId, phaseIndex)`) to that `transaction_id`. A
different checkout for an occupied phase is refused as `conflict` with
`ap2-phase-bound-to-another-transaction`, whatever state the first binding is
in, and gets no record or replay deadline of its own.

```ts
import {
  advanceAp2Settlement,
  type Ap2BindingStore,
  type Ap2MandateVerifier,
  type Ap2ProviderAdapter,
} from "@kynesyslabs/dacs/rails";

const result = await advanceAp2Settlement({
  jobId,
  phaseIndex,
  peerIdentity,
  profileAdmission, // issued by the handler's authenticated handshake
  agreementHash,
  protocolVersion: "0.2",
  expected: { payee, amount, currency },
  checkoutMandate,
  paymentMandate,
  owner: workerId,
  verifier: mandateVerifier satisfies Ap2MandateVerifier,
  provider: providerAdapter satisfies Ap2ProviderAdapter,
  store: durableStore satisfies Ap2BindingStore,
});
```

An `indeterminate` result is not permission to create a new payment. Resume the
same input after the current lease expires. The core derives the same AP2-6 key,
and an eligible provider returns or continues the original operation rather
than charging again.

The package does not claim a particular AP2 provider is supported merely
because this core exists. A provider adapter is eligible only when all
`Ap2RegistrationCapabilities` are explicitly true: writable/readable DACS
metadata, provider idempotency keys, a privileged local create credential, and
a distinct relayed status-only credential.

## Stripe test-mode + Demos reference adapter

`createStripeAp2Integration` is an optional reference implementation for
Stripe PaymentIntents. It requires two distinct restricted keys: a local
PaymentIntent create key and a read-only status key. Only the read key crosses
DAHR, through the Demos adapter's transient authorization channel. The exact
provider response is hash-bound by DAHR but is not published as DACS content.

Use `createFsAp2BindingStore` for restart-safe AP2-7 state. The store persists
the transaction binding, lease generation, provider reference and terminal
settlement before later calls can resume. Its generation fence prevents an
expired worker from submitting or recording a provider effect. It binds each
phase to its first `transaction_id` before writing that record.

Opening a store accounts for every record before it accepts a claim:

- A current record, or one the previous release wrote (`intentVersion "1"`,
  checked strictly with that release's rules), binds its phase. Any other
  `transaction_id` for that phase is then refused with
  `ap2-phase-bound-to-another-transaction`.
- If two such records share a phase, that phase fails closed for both, as
  `ap2-phase-binding-conflict`.
- A record that cannot be decoded counts only when a phase binding already
  lists its `transaction_id`. Otherwise the store creates no record for any
  new `transaction_id` and refuses each one with `ap2-store-has-unbound-records`.
  Bound transactions still resume. Reconcile the record, move it out of
  `records/`, and reopen the store.

Stop every worker running an earlier release before opening the store with
this one. The scan runs only when the store is opened.

When the binding exposes a native transaction, the resulting settlement uses
the Standard's distinct `ap2-sr3` arm and separates two references:

- `receiptAttestation.anchor` is the HTTPS provider-status resource whose raw
  response bytes match `contentHash`;
- `receiptTransactionRef` is the native SR-3 transaction authenticating that
  observation (`demos-web2-request` for the Demos binding).

The adapter rejects standard Stripe keys, shared keys, and live keys unless
`allowLive: true` is explicit. `currencyMinorUnits` must match
[Stripe's charge-currency representation](https://docs.stripe.com/currencies)
for each settlement: zero-decimal currencies use `0`; other supported
presentment currencies use `2`; and ISK/UGX use `2` while forbidding fractional
major-unit charges. HUF and TWD charges use `2` (their zero-decimal rule applies
to payouts). Unsupported currencies and mismatched settings are rejected before
submission; Stripe still applies account and country-specific availability. The
opt-in live test additionally requires an
isolated funded Demos wallet, the official AP2 Python verifier, durable state,
and `DACS_AP2_LIVE_CONFIRM=1`.

## Authenticated profile and retained operation

Before invoking either mandate admission or settlement, the enclosing handler
must call `authenticateAp2ProfileAdmission` with its local exact release pin (a
40-hex commit; tags are not accepted) and complete module tuple, the session and
expected peer identity, and a trusted handshake resolver. The module tuple must
equal `AP2_IMPLEMENTED_MODULE_VERSIONS`, the tuple this SDK implements;
any other tuple is refused. The resolver must authenticate each returned participant's
identity, session and profile. Checkout fields, signature verification and
copied capability objects do not confer this authority. Pass the returned
`profileAdmission` and `peerIdentity` to the settlement input. Reauthenticate
after a process restart; the capability is deliberately process-local.

Provider adapters must declare `operation`: a stable destination, the provider's
account/idempotency namespace, and every effect-bearing adapter parameter.
Do not put credentials in this descriptor. The Stripe reference adapter binds
its endpoint, create-credential fingerprint and adapter/currency policy, so
credential rotation conservatively refuses recovery until reconciled by an
operator.

Intent version `2` retains sorted-key wire JSON for both complete mandate
artifacts and this operation descriptor, together with its byte hash. String
bytes are kept exactly, with no Unicode normalization; object key order is not
part of the operation. Adapters must accept JSON wire artifacts (compact signed
strings remain exact strings). Every retry compares the complete retained
request before provider status or submission and submits the retained
artifacts. If a retry presents the same `transaction_id`, job and phase with a
different operation, it is refused as `ap2-retained-operation-conflict`. A
different job or phase is refused as `ap2-transaction-id-replay`.

Version `1` records cannot safely establish this binding. They still reserve
their phase, but their own claims are refused with
`ap2-legacy-record-requires-reconciliation`. Reconcile them through the
original provider before migration. The filesystem store does not silently
upgrade them.

Immutable AP2, EIP, x402, SDK and ULID reference revisions are recorded in
[`protocol-source-pins.json`](./protocol-source-pins.json). The separate node2
observation reports a dirty deployment. It does not establish a supported clean
node revision or reproducible node source conformance.

The pure `evaluateAp2TransactionBinding` helper consumes the current complete
retained-binding shape, including its key, operation payload/fingerprint,
recovery reference and captured result. Earlier tuple-only snapshots are refused
rather than treated as resumable operations.

Every provider must declare a positive safe-integer `noReferenceReplayWindowMs`,
using its guaranteed idempotency retention reduced by a clock/network safety
margin. The core includes this policy in the immutable operation bytes and hash;
omitting it refuses admission, and changing it conflicts with an existing binding.
On the first claim, the binding store durably records `createdAt` and
`replayDeadline = createdAt + noReferenceReplayWindowMs` before any submission.
Retries and lease takeovers must preserve both values. Every create checks the
retained deadline. Create adapters call
`fence.assertSubmissionAllowed()` immediately before dispatch; status reads use
`fence.assertCurrent()`.

Stripe allows automatic recovery without a provider reference only before the
original deadline, using a 24-hour retention window reduced by five minutes for
clock skew and dispatch delay. Expiry, a clock value before the original claim,
or an otherwise matching binding with no retained deadline returns `indeterminate`
with `ap2-provider-replay-window-expired`. An operator must reconcile the original
payment before any further create attempt. A retained provider reference still
permits authenticated status-only recovery after the deadline.

Bindings created before the replay policy was included in the operation cannot
be resumed automatically with the new operation shape. Reconcile those payments
with the provider before attempting another create; do not delete or rebind the
retained transaction to upgrade it.
