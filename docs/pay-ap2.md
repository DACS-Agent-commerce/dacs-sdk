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
terminal result across restart.

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
expired worker from submitting or recording a provider effect.

When the binding exposes a native transaction, the resulting settlement uses
the Standard's distinct `ap2-sr3` arm and separates two references:

- `receiptAttestation.anchor` is the HTTPS provider-status resource whose raw
  response bytes match `contentHash`;
- `receiptTransactionRef` is the native SR-3 transaction authenticating that
  observation (`demos-web2-request` for the Demos binding).

The adapter rejects standard Stripe keys, shared keys, and live keys unless
`allowLive: true` is explicit. The opt-in live test additionally requires an
isolated funded Demos wallet, the official AP2 Python verifier, durable state,
and `DACS_AP2_LIVE_CONFIRM=1`.
