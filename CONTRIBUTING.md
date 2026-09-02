# Contributing to dacs-sdk

Thanks for helping build the DACS SDK. This library takes an agent through the
five-stage DACS lifecycle (Identify → Vet → Negotiate → Settle → Verify) and is
tested against the canonical conformance vectors in
[`DACS-Agent-commerce/DACS-Standard`](https://github.com/DACS-Agent-commerce/DACS-Standard),
which is the normative source of truth. When code and the Standard disagree, the
Standard wins — open an issue rather than diverging.

## Prerequisites

- **Node 20.19 or 22.12** (the two versions CI gates).
- npm (the repo ships a `package-lock.json`; use `npm ci`).

## Setup

```bash
npm ci
npm run conformance:sync   # pull the pinned DACS-Standard §14 vectors
npm run typecheck
npm run build
npm test
```

`conformance:sync` fetches the DACS-Standard conformance vectors pinned in
`scripts/sync-vectors.mjs`. **Run it before `npm test`** — several suites are
manifest-driven and will fail against stale/missing vectors.

## Making a change

1. Branch off `main` (`feat/…`, `fix/…`, `docs/…`, `perf/…`).
2. Keep changes focused; match the surrounding code's style, naming, and comment
   density. TypeScript is strict — no `any` escape hatches without a scoped,
   justified reason.
3. If you touch `src/artifacts/types.ts` (or anything the conformance harness
   snapshots), re-run `npm run conformance:sync`.
4. Add or update tests. Prefer proving fail-closed behavior on bad input, not
   just the happy path — that's the bar in this codebase.
5. Before pushing: `npm run typecheck && npm run build && npm test` all green.
   If your change touches a workspace package, also run its checks — the
   `dacs-node` package (build + tests) and the `create-dacs-agent` generator
   (its packed-project acceptance) — since CI gates on those too.

## Tests

- `npm test` — the full offline suite (unit + conformance harness). This is what
  CI gates on, across Node 20 and 22.
- Live on-chain tests are **skipped unless their env is set**, so they never run
  in `npm test`/CI. To run the funded two-sided lifecycle against a real Demos
  node + Base Sepolia, follow the runbook at `docs/live-e2e.md` (added in #179).

## Pull requests

- Open the PR against `main`. Branch protection requires an approving review and
  **green CI on both Node 20 and Node 22**, so keep the merge state CLEAN.
- Stacked PRs merge parent-first; rebase each onto its reviewed base before merge.
- Every PR gets a review. Reviews are done at the exact current head — if you
  rewrite a head after approval, request a fresh review rather than relying on the
  stale one.
- Never commit secrets. Only `.env*` files are gitignored — that does **not**
  cover arbitrary key material, so never add wallet mnemonics, private keys, or
  other credentials to the repo. Keep them in your ignored env file or a secret
  manager; live tests read all credentials from the environment (see the runbook).

## Reporting issues

Bugs and spec-conformance gaps are welcome as GitHub issues. For anything
touching signing, settlement, or verification, please note the relevant
DACS-Standard section so it can be traced back to the spec.

**Do not report suspected security vulnerabilities in public issues.** Report
them privately — use GitHub's private vulnerability reporting on this repo (see
[`SECURITY.md`](./SECURITY.md)) — so a fix can land before the details are public.
