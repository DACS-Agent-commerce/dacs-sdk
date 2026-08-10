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
  createInMemoryBindingStore,
  createX402Rail,
  x402Settle,
  resolveRecipe,
  vetCore,
} from "@kynesyslabs/dacs";

// A production deployment supplies a well-known/catalog-backed implementation.
// This in-memory store is suitable only for a same-process example or tests.
const bindings = createInMemoryBindingStore();
const seller = await createAgent({
  demosRpc,
  wallet,
  identity: { agentId },
  bindings: { index: bindings, publisher: bindings },
});

// seller — sign + anchor + publish the logical→native binding
const published = await seller.publishListing(spec);
if (
  published.status !== "published" &&
  published.status !== "already-published"
) {
  throw new Error(`listing binding was not published: ${published.status}`);
}

// A read-only Directory can omit both wallet and publisher. A session-capable
// buyer supplies its own wallet but still needs only the consumer index.
const buyer = await createAgent({
  demosRpc,
  wallet: buyerWallet,
  identity: { agentId: buyerId },
  bindings: { index: bindings },
});

// buyer — resolve the stable logical address and authenticate its binding tuple,
// signed content, seller, service, version, and Listing-domain signature.
const resolved = await buyer.readListing(published.logicalAddress);
if (resolved.status !== "authenticated") {
  throw new Error(`listing could not be authenticated: ${resolved.status}`);
}

// Or page the historical Listings published by one known seller. This is
// owner-scoped discovery, not global marketplace search.
const firstPage = await buyer.enumerateListings(agentId);

const rail = await createX402Rail({ evmPrivateKey });
// Passing the authenticated result (not only `resolved.ref`) pins the selected
// content hash across runSession's pre-payment re-read.
const session = await buyer.runSession(resolved, {
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
const verdict = await buyer.verifyBundle(session.bundleRef);
const rep = await buyer.getReputation(primaryClaim, bundleRefs);
```

To resume an interrupted session safely, pass the prior `jobId` and the same
authenticated Listing to `runSession` — anchored artifacts are reused, the
Listing content remains pinned, and settlement is never repeated. The legacy
native-ref input remains available for callers with a separate trusted pin.

`publishListing` requires `AgentConfig.wallet` and
`AgentConfig.bindings.publisher`, and fails before anchoring when either write
authority is absent. Its top-level `ref` exists only on a `published` or
`already-published` result. On conflict or indeterminate, retain
`publication.anchor` and retry the same listing; never create a replacement
anchor. These success statuses mean the publisher acknowledged the exact binding
and the configured index read it back; they do not by themselves prove portable
anchor finality, active-listing eligibility, or complete DACS conformance.

`readListing(logicalAddress)` and `enumerateListings(sellerId)` need only
`AgentConfig.bindings.index`; the Agent wallet and publisher are optional for a
read-only consumer. An `authenticated` result has
`compatibility: "legacy-mvp"` and has passed the SDK's exact binding-tuple,
hash, Listing context, and seller-authorship checks. The binding owner is an
index assertion; direct lookup does not prove that the seller deployed the
native anchor. It is also not yet a normative DACS-1 `active`/unrevoked
eligibility decision. Keep both physical provenance and eligibility separate
from signed-content authentication.

Enumeration pages one known seller's confirmed Demos create history. Its opaque
cursor is owner-bound and at-least-once: `historyPageSize` counts raw history
rows, a page can contain no Listings, and `nextCursor: null` means only that the
current traversal reached its end. Upsert results idempotently by
`(logicalAddress, contentHash, ref)`. Restart from a null cursor to see a binding
repaired after its history page was already consumed. Global/category discovery
still requires a production catalog.

Handle enumeration results by status. A `page` may contain permanent candidate
`diagnostics` and advances to `nextCursor`. An `indeterminate` page is atomic:
it returns no Listings or diagnostics, and the caller retries its unchanged
`retryCursor`. `invalid-seller` and `invalid-options` are caller errors;
`historyPageSize`, when supplied, must be an integer from 1 through 100.

See **[examples/hello-world.ts](./examples/hello-world.ts)** for the full lifecycle end to end.

### Fault-aware bundle helper

`buildTwoSidedBundle(session)` is the low-level DACS-5 v0.3 producer. It emits a
`FaultAttestationBundle` copy for each signing buyer, seller, and distinct
orchestrator. Fault and abort inputs require an absolute `faultedParty`; each
copy gets the matching role-relative `outcome` and signs under
`dacs-fault-bundle:v1:`. Consumers continue to accept legacy
`AttestationBundle` records, and consistency/reputation reconciliation supports
legacy, fault-aware, and mixed pairs. The helper is not yet wired into
`runSessionCore`.

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
