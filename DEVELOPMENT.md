# Development

`dacs-sdk` implements the full five-stage DACS lifecycle (Identify → Vet →
Negotiate → Settle → Verify). For *what's implemented*, see the
**"What's implemented"** table in [`README.md`](./README.md) — that's the source
of truth for scope. This file covers how to build, test, and lay out the code.

## Setup

```bash
npm install
npm run conformance:sync   # pull DACS-Standard §14 vectors into vendor/ (pinned)
```

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src` + `test` |
| `npm run build` | emit ESM + types to `dist/` (`tsconfig.build.json`) |
| `npm test` | vitest — unit tests + the conformance harness |
| `npm run test:live` | live on-chain e2e (gated on a funded node + creds; skipped otherwise) |
| `npm run conformance:sync` | sync the §14 vectors from `DACS-Standard` at the pinned ref |

The `dacs doctor` CLI is read-only by default. Its offline and JSON modes are
unit-tested; live RPC checks are opt-in through CLI flags and must not fund,
transfer, anchor, or broadcast.

Doctor CLI rules:

- never require secret material as a direct flag value; use file/stdin/env
  indirection for wallet secrets and authenticated RPC URLs
- test the built executable through a symlinked/package-style path, not only the
  imported parser
- `blocked` required checks exit non-zero until the implementation can evaluate
  them truthfully

## Layout

```
src/
  agent/             createAgent + the 5-stage runSession / verifyBundle / reputation
  artifacts/         spine artifact types, validators, separator registry
  canonical/         JCS + sha256 content hashing, stor- addressing
  crypto/            signing seam + domain separators
  rails/             settlement rails (x402, evm-erc20)
  registry/          recipe / rail steward registries
  cli/               read-only doctor/preflight helpers
  bin/               executable entrypoints
  substrate/         the SubstrateAdapter seam + the single DemosAdapter
  errors.ts          DacsError
  index.ts           public entry — the agent API + rails/registry subpaths
test/
  agent/ artifacts/ rails/ registry/ canonical/ crypto/ substrate/   unit tests
  conformance/       §14 golden-vector harness (some areas still it.todo)
  integration/       live node smoke + on-chain e2e (gated on creds)
scripts/
  sync-vectors.mjs   clone/checkout DACS-Standard at the pinned ref into vendor/
```

## Conformance vectors

The §14 vectors are the **test oracle**; the source of truth lives in
[`DACS-Agent-commerce/DACS-Standard`](https://github.com/DACS-Agent-commerce/DACS-Standard).
They are synced (not vendored into git) at a pinned commit by
`scripts/sync-vectors.mjs`. Override the ref with `DACS_STANDARD_REF=<sha>` to
test against a newer spec build. A few §14 areas remain `it.todo` and are
tracked in the open conformance issues.
