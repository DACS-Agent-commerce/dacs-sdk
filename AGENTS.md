# AGENTS.md

Guide for coding agents working in this repository.

## What this repo is

An open standard and SDK that lets AI agents find, vet, agree terms with and pay sellers of services and data, with signed delivery evidence. Testnet only for now.

DACS here means Demos Agent Commerce Standards. It is not related to other software or packages called DACS. The agent lifecycle is Identify → Vet → Negotiate → Settle → Verify. The normative spec and conformance vectors live in the separate `DACS-Agent-commerce/DACS-Standard` repository; when code and the Standard disagree, the Standard wins (see `CONTRIBUTING.md`).

## Layout

| Path | What it is for |
| --- | --- |
| `src/` | The core TypeScript SDK, package name `@kynesyslabs/dacs`. Subpath exports declared in `package.json` "exports": `canonical`, `crypto`, `artifacts`, `identity`, `discovery`, `negotiate`, `rails`, `seller`, `commerce`, `registry`, `cli`, `substrate`, `wire`. Everything else, including `createAgent` (`src/agent/Agent.ts`), comes from the package root. `src/bin/dacs.ts` is the `dacs` command. |
| `packages/dacs-node/` | `@kynesyslabs/dacs-node`: Node.js host contracts and adapters (filesystem, SQLite, HTTP envelope). |
| `packages/create-dacs-agent/` | `create-dacs-agent`: project generator for the quickstart. |
| `packages/dacs-seller/` | `@kynesyslabs/dacs-seller`: self-hosted seller kit (plain ESM JavaScript, `private: true`, loopback). |
| `packages/dacs-client/` | `@kynesyslabs/dacs-client`: buyer purchase services and read-only diagnostics (plain ESM JavaScript, `private: true`). |
| `test/` | Root vitest suite and the `node --test` script and seller/client tests. |
| `conformance/`, `vectors/` | Declared conformance register (`conformance/`) and the seller HTTP vector (`vectors/`). `npm run conformance:sync` clones the Standard's vectors into `vendor/DACS-Standard`. |
| `docs/` | Design and operation notes. Start with `docs/about-the-testnet-release.md` and `docs/testnet-profile-tp1.md`. |
| `tools/lint/` | Separate lint tool (own `package.json`, never shipped). |
| `scripts/` | Build, release-check and test-runner scripts used by the npm scripts, and `fixed-price-x402-walkthrough.mjs`, a testnet walkthrough script run by hand. |

The packages are not yet published to npm, so install from source.

## Install and run the checks from source

Node `^22.22.2 || ^24.15.0` (avoid Node 25 or newer; see `CONTRIBUTING.md`). Use npm and the committed lockfile.

```bash
npm ci
npm run conformance:sync   # fetch the pinned conformance vectors; run before npm test
npm run typecheck
npm run build
npm test
```

Other checks, as CI runs them:

```bash
npm ci --prefix tools/lint --ignore-scripts
npm run lint --prefix tools/lint
node tools/lint/layers.mjs
node tools/lint/file-size.mjs
node tools/lint/shared-helpers.mjs
node tools/lint/error-codes.mjs
```

Workspace packages: `npm run host:build`, `npm run host:typecheck`, `npm run host:test` (dacs-node); `npm run generator:build`, `npm run generator:typecheck`, `npm run generator:test` (create-dacs-agent).

Seller kit tests need a prepared consumer directory that does not exist yet:

```bash
npm run build
npm run host:build
export DACS_SELLER_SMOKE_DIR=/tmp/dacs-seller-consumer
npm run seller:prepare -- "$DACS_SELLER_SMOKE_DIR"
npm run conformance:sync
npm run seller:test
```

`packages/dacs-client` has no root script. Its own `test` script (package.json) runs `check-hold.mjs` and then every test file in the package:

```bash
npm test --workspace @kynesyslabs/dacs-client
```

Other scripts in the root `package.json`: `client-keys:test`, `kit-client:test`, `release:check`, `package:verify`. Tests that need a funded node (`test:live`, `test:live:pay-dem`) are skipped unless their environment is set; do not run them without the setup in `docs/live-e2e.md`.

## Entry points

Seller:

- `packages/dacs-seller/bin/dacs-seller.mjs`: the seller command. It calls `packages/dacs-seller/src/cli/main.mjs`.
- `packages/dacs-seller/src/index.mjs`: package exports, including `startSellerHost` (from `src/host.mjs`) and `createSellerHttpHandler`.
- `src/seller/index.ts`: seller-side building blocks of the core SDK (agreement responder, payment intake, bundle finalization).
- `docs/dacs-seller-http-v1.md` and `docs/x402-seller-paywall.md`: the seller transport and paywall.

Buyer:

- `src/agent/Agent.ts`: `createAgent` (re-exported from `src/index.ts`).
- `src/commerce/index.ts`: the fixed-price coordinators; `src/commerce/fixedPriceX402Coordinator.ts` is the x402 buyer path.
- `packages/dacs-client/src/index.mjs`: buyer purchase services and guidance helpers (`purchaseNext`, `protocolView`).
- `docs/fixed-price-x402-coordinator.md` and `docs/fixed-price-offline-coordinator.md`: how the buyer and seller coordinators run.
- `examples/hello-world.ts`: a small example.
- `docs/fixed-price-x402-walkthrough.md`: walks through a generated live project on testnet. The run stops at Listing setup today; the steps after it, including the buy's doctor and its two blocked checks, are described from the code and not run.

## Rules

- **Testnet only.** Do not point anything at a real-value network or use real funds. Testnet DEM has no value.
- **Never commit keys or secrets.** No private keys, mnemonics, tokens or `.env` contents, in code, tests, fixtures, logs or docs. Only `.env*` files are gitignored, which does not cover other key material. The repo runs a secret scan (`.gitleaks.toml`).
- **Run the checks before a PR.** At least `npm run typecheck && npm run build && npm test`, plus the lint commands above and the checks for any workspace package you touched.
- Keep changes small and focused. Add or update tests; prefer tests that show a bad input is rejected.
- If you change `src/artifacts/types.ts`, re-run `npm run conformance:sync`.
- Do not commit internal reports or scratch files.
- Branch names use `feat/`, `fix/`, `docs/` or `perf/`; open the PR against `main` (see `CONTRIBUTING.md`).
