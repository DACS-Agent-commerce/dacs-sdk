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

## Planned public API (target)

```ts
const agent = createAgent({ identity, demosRpc, wallet });

// seller
await agent.publishListing(spec);

// buyer
const listing = await agent.discover();
const { result, bundleRef } = await agent.runSession(listing);

// anyone
await agent.verifyBundle(bundleRef);
await agent.getReputation(primaryClaim);
```

## License

MIT — matching the DACS standard.
