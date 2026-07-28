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

Self-declared identity (+ one verified claim) · fixed-price negotiation · **x402** and **direct ERC-20** settlement · one delivery type · attestation bundle + reputation. Cross-chain settlement, sealed-bid auctions, RFQ, private channels, AP2, and dispute (DACS-X) are deferred.

## What's implemented

All five lifecycle stages run end to end:

| Stage | API | Notes |
| --- | --- | --- |
| Identify | `createAgent({ identity })` | the agent's CCI / DID |
| **Vet** | `runSession({ vet })` · `vetCore` · `resolveRecipe` | recipe-driven (self-signed, consensus-backed-proxy via DAHR); aborts before paying on failure |
| **Negotiate** | `runSession({ terms })` | fixed-price |
| **Settle** | `x402Settle` · `evmErc20Settle` · `settleFromRail` | two rails, switchable by rail id; idempotent (no double-pay on resume) |
| **Verify** | `verifyBundle` · `getReputation` | per-artifact signature verification; reputation from bundles |

Rails and verification recipes are resolved from **steward-signed registries** (`resolveRail` / `resolveRecipe`), so adding one is config, not code.

## Public API

```ts
import {
  createAgent,
  createX402Rail,
  x402Settle,
  resolveRecipe,
  vetCore,
} from "@kynesyslabs/dacs";

const agent = createAgent({ demosRpc, wallet, identity: { agentId } });

// seller — sign + anchor a fixed-price listing
const { ref } = await agent.publishListing(spec);

// buyer — discover, then vet → negotiate → settle → verify (anchoring the bundle)
const [{ ref: listingRef }] = await agent.discover([ref]);
const rail = await createX402Rail({ evmPrivateKey });
const session = await agent.runSession(listingRef, {
  terms,
  // optional Vet step: resolve a steward recipe + verify the seller before paying
  vet: (subject) =>
    resolveRecipe(recipeRegistryRef, "self-signed", { readRegistry, stewardPublicKey, verify })
      .then((recipe) => vetCore({ subject, recipe }, { proxyFetch, now })),
  // `asset` is the on-chain token id (ERC-20 contract) the 402 must advertise —
  // the §4.1 guard compares against it, not the Price.asset symbol.
  settle: x402Settle(rail, { url, network, recipientEvm, asset }),
});

// anyone — verify the bundle's structure + every artifact signature
const verdict = await agent.verifyBundle(session.bundleRef);
const rep = await agent.getReputation(primaryClaim, bundleRefs);
```

To resume an interrupted session safely, pass the prior `jobId` to `runSession` — anchored artifacts are reused and settlement is never repeated.

See **[examples/hello-world.ts](./examples/hello-world.ts)** for the full lifecycle end to end.

## Doctor

The package ships a read-only preflight command:

```sh
dacs doctor --offline
dacs doctor --json --rpc https://node2.demos.sh
dacs doctor --json --rpc-file ./rpc.url
dacs doctor --json --wallet-secret-file ./wallet.secret --rpc https://node2.demos.sh
```

The first slice checks runtime/package state, optional RPC reachability, secret
redaction, and rail availability without funding, transferring, anchoring, or
broadcasting. StorageProgram binding resolution and read-visible anchor
completion currently report `blocked` until the resolver/completion work lands
(tracked by dacs-sdk #58 and #57).

The supported runtime range is `^20.19.0 || >=22.12.0`, matching the package
engine contract and the Vitest/Rolldown toolchain requirement.

Secrets must not be passed directly as command-line values. Direct `--rpc` only
accepts origin-only URLs such as `https://node2.demos.sh`. For RPC URLs with
credentials, path tokens, query strings, or fragments, use `--rpc-file <path>`,
`--rpc-file -`, or `--rpc-env <name>`. For wallet secrets, use
`--wallet-secret-file <path>`, `--wallet-secret-file -`, or
`--wallet-secret-env <name>` so secret material
does not appear in shell history or process listings.

Exit codes are stable:

- `0`: all required checks passed or warned. In this first slice, required
  funding/storage/cost checks are still `blocked`, so a complete preflight is
  expected to exit `5` until those follow-up checks are implemented.
- `1`: at least one non-RPC check failed.
- `2`: invalid CLI usage.
- `3`: requested RPC check failed.
- `4`: unexpected doctor internal error.
- `5`: required checks are still blocked/incomplete.

## Imports

The package ships ESM with subpath exports so the substrate-free surface can be
used without pulling in `demosdk`:

| Import | Needs `demosdk` | Use for |
| --- | --- | --- |
| `@kynesyslabs/dacs` | yes (`createAgent` / `DemosAdapter`) | building live agents |
| `@kynesyslabs/dacs/cli` | no by default | read-only doctor helpers |
| `@kynesyslabs/dacs/rails` | no | x402 + evm-erc20 settlement (`x402SettleCore`, `termsMatch`) |
| `@kynesyslabs/dacs/registry` | no | resolve steward-signed rails/recipes; rail dispatch |
| `@kynesyslabs/dacs/canonical` | no | JCS / decimals / content hashing / CF-4 addressing |
| `@kynesyslabs/dacs/crypto` | no | Ed25519 + §7.7 domain-separated signing |
| `@kynesyslabs/dacs/artifacts` | no | spine artifact types + validators |

> **Note:** the root export transitively imports `demosdk`, whose build uses
> directory imports that Node's strict ESM resolver rejects at runtime. Use a
> bundler (Vite/webpack/tsx) for the root API, or import the substrate-free
> subpaths above (verifier / rail consumers) to load under raw Node ESM. The
> fix belongs upstream in `demosdk`.

## License

MIT — matching the DACS standard.
