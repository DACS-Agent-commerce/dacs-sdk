# Development

`dacs-sdk` is being built per [`IMPLEMENTATION.md`](./IMPLEMENTATION.md). This is
the T1 scaffold: package skeleton, the substrate-adapter seam, and the
conformance harness wired to the spec's §14 vectors.

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
| `npm run conformance:sync` | sync the §14 vectors from `DACS-Standard` at the pinned ref |

## Layout

```
src/
  substrate/         the SubstrateAdapter seam + the single DemosAdapter
  errors.ts          DacsError / NotImplementedError
  version.ts         package + spec version
  index.ts           public entry (seam only for now; agent API lands in T4)
test/
  substrate/         adapter unit tests
  conformance/       §14 vector harness (areas are `it.todo` until implemented)
scripts/
  sync-vectors.mjs   clone/checkout DACS-Standard at the pinned ref into vendor/
```

## Conformance vectors

The §14 vectors are the **test oracle** and the source of truth lives in
[`DACS-Agent-commerce/DACS-Standard`](https://github.com/DACS-Agent-commerce/DACS-Standard).
They are synced (not vendored into git) at a pinned commit by
`scripts/sync-vectors.mjs`. Override the ref with `DACS_STANDARD_REF=<sha>` to
test against a newer spec build. As each builder/validator lands (T2 onward),
its area flips from `it.todo` to a real conformance assertion.

## Status (T1)

`connect` / `getAddress` are wired to the real Demos SDK. Every other seam
method throws `NotImplementedError` with the task ref that lands it. The agent
public API (`createAgent`, `publishListing`, `discover`, `runSession`,
`verifyBundle`, `getReputation`) is designed in T4.
