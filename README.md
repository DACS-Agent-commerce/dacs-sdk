# dacs-sdk

TypeScript SDK for building **DACS** (Demos Agent Commerce Standards) agents — the reusable runtime that takes an agent through the five-stage lifecycle: **Identify → Vet → Negotiate → Settle → Verify**.

> **Status: pre-alpha / in development.** This repo is being extracted from the `agent-commerce-demo` reference implementation into a reusable library. See **[IMPLEMENTATION.md](./IMPLEMENTATION.md)** for the v0.1 MVP build plan.

## What this is

`agent-commerce-demo` is an *app* that runs one end-to-end DACS flow on Demos. `dacs-sdk` is the *library* extracted from it — so any developer can `npm install` it and build their own DACS buyer/seller agents instead of wiring the protocol by hand.

- **Depends on** [`@kynesyslabs/demosdk`](https://www.npmjs.com/package/@kynesyslabs/demosdk) for substrate primitives (anchoring, DAHR, channels, bridges) behind a thin substrate-adapter seam (Demos is the first adapter).
- **Tested against** the canonical conformance vectors in [`DACS-Agent-commerce/DACS-Standard`](https://github.com/DACS-Agent-commerce/DACS-Standard) — the normative source of truth.

## Layering

```
DACS-Standard        spec + §14 conformance vectors      ← source of truth
      ▲
dacs-sdk             this library; depends on demosdk; tested against the vectors
      ▲
agent-commerce-demo  the worked example (consumes dacs-sdk)
```

## MVP scope (v0.1)

Self-declared identity (+ one verified claim) · fixed-price negotiation · **x402** settlement · one delivery type · attestation bundle + reputation. Cross-chain settlement, sealed-bid auctions, RFQ, private channels, AP2, and dispute (DACS-X) are deferred — most become config once the registries carry them.

## Public API

```ts
import { createAgent, createX402Rail, x402Settle } from "@kynesyslabs/dacs";

const agent = createAgent({ demosRpc, wallet, identity: { agentId } });

// seller — sign + anchor a fixed-price listing
const { ref } = await agent.publishListing(spec);

// buyer — negotiate → settle on x402 → verify, anchoring the bundle
const rail = await createX402Rail({ evmPrivateKey });
const session = await agent.runSession(ref, {
  terms,
  settle: x402Settle(rail, { url, network, recipientEvm }),
});

// anyone — verify the bundle's structure + every artifact signature
const verdict = await agent.verifyBundle(session.bundleRef);
const rep = await agent.getReputation(primaryClaim, bundleRefs);
```

See **[examples/hello-world.ts](./examples/hello-world.ts)** for the full lifecycle end to end.

## Imports

The package ships ESM with subpath exports so the substrate-free surface can be
used without pulling in `demosdk`:

| Import | Needs `demosdk` | Use for |
| --- | --- | --- |
| `@kynesyslabs/dacs` | yes (`createAgent` / `DemosAdapter`) | building live agents |
| `@kynesyslabs/dacs/rails` | no | x402 settlement (`x402SettleCore`, `termsMatch`) |
| `@kynesyslabs/dacs/canonical` | no | JCS / decimals / content hashing |
| `@kynesyslabs/dacs/crypto` | no | Ed25519 + §7.7 domain-separated signing |
| `@kynesyslabs/dacs/artifacts` | no | spine artifact types + validators |

> **Note:** the root export transitively imports `demosdk`, whose build uses
> directory imports that Node's strict ESM resolver rejects at runtime. Use a
> bundler (Vite/webpack/tsx) for the root API, or import the substrate-free
> subpaths above (verifier / rail consumers) to load under raw Node ESM. The
> fix belongs upstream in `demosdk`.

## License

MIT — matching the DACS standard.
