# `@kynesyslabs/dacs-node`

Production Node.js host contracts and adapters for `@kynesyslabs/dacs`.

The package keeps filesystem, SQLite, HTTP, process-supervision, and deployment
concerns outside the transport-neutral SDK. The first package unit publishes
the stable host interfaces and the byte-exact authenticated HTTP envelope. It
does not yet claim the SQLite or HTTP server implementations described by the
one-click install specification.

```ts
import {
  createDacsHttpEnvelopeV1,
  validateDacsAgentConfig,
} from "@kynesyslabs/dacs-node";
```

The live profile is never inferred. `offline` and `live-demos` configurations
are closed, non-interchangeable variants and must select their matching SDK
commerce profile.

The package also exposes `runDeterministicOfflineLifecycle`. It writes and then
independently verifies a complete DACS 1-5 local artifact graph. Its Standard
`pay-ap2` rail and provider receipt are explicitly marked `mocked`/`offline`;
the function performs no network request, reads no credentials, spends no
funds, and makes no live-x402 or live-substrate claim.

Until the first SDK alpha is published, the exact SDK version is declared as an
optional peer so stacked pre-merge CI does not fetch an unpublished package.
Applications must install both `@kynesyslabs/dacs` and
`@kynesyslabs/dacs-node` at the same exact version.

Envelope authentication requires two host-owned, fail-closed callbacks. The
identity resolver must use verified Demos identity material and retain its
evidence hash; the payload validator must invoke the corresponding public SDK
validator/verifier with independently resolved session facts. Neither callback
may trust the HTTP body as identity or authorization evidence.
