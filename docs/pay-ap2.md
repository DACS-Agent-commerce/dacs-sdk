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
