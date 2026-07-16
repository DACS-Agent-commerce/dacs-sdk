# Security — dependency audit & policy

## Production dependency audit (#40)

`npm audit --omit=dev` on the production tree (~1,600 packages) reports:

| Severity | Count |
| --- | --- |
| critical | 4 |
| high | 63 |
| moderate | 37 |
| low | 28 |
| **total** | **132** |

Severity alone is not exploitability — the table below records **runtime reachability**, which is what determines real exposure.

### The SDK's own direct dependencies are minimal

`@kynesyslabs/demosdk`, `@x402/core`, `@x402/evm`, `@x402/fetch`, `viem`. **All 132 findings are transitive**; none are in a package this repo authors.

### Critical advisories — reachability

All four criticals are transitive through **`@kynesyslabs/demosdk`**'s multichain dependency tree:

| Package | Path (via) | Reachable from the pure SDK surface? |
| --- | --- | --- |
| `aptos` | demosdk → Aptos chain support | **No** — only loaded if the app builds a chain adapter |
| `protobufjs` | demosdk → chain RPC codecs | **No** — same |
| `request` (deprecated) | demosdk legacy HTTP path | **No** — same |
| `form-data` | demosdk legacy HTTP path | **No** — same |

**Why "No":** the SDK deliberately **lazy-loads** the on-chain adapter. The top-level barrel (`src/index.ts`) and the pure surfaces — `canonical`, `crypto`, `artifacts`, `identity`, `negotiate`, and all of **verify** — never `import` `@kynesyslabs/demosdk`. It loads only when a consumer calls `createAgent()` (the substrate subpath). A verifier / marketplace / reputation consumer that uses the pure surface therefore **does not execute** any of the critical code paths, even though `npm install` places the packages on disk.

The vulnerable tree is only *executed* by an app that runs the Demos on-chain adapter — and such an app is already running a full chain stack with the same dependencies.

## Audit policy

- **Direct dependencies** stay minimal and are the only ones this repo can fix directly; a new direct dependency with an open critical/high advisory is not added.
- **Transitive criticals/highs** are assessed for reachability (as above), not blocked on severity alone; the assessment is recorded here.
- Re-run `npm audit --omit=dev` and refresh this file **when `@kynesyslabs/demosdk` is bumped** (the source of the entire vulnerable tree).
- CI runs an **informational** `npm audit --omit=dev` (non-blocking) so regressions surface without gating unrelated work.

## Recommended remediation (needs a packaging decision)

The structural fix is to stop shipping the multichain tree to consumers who only need the pure surface: **move `@kynesyslabs/demosdk` to `optionalDependencies` / `peerDependencies`**, so the ~1,600-package tree installs only for apps that actually build the on-chain adapter. This changes the install contract (adapter consumers must install `@kynesyslabs/demosdk` explicitly) and needs the test/build wiring updated to match — tracked as a follow-up decision rather than folded into this audit record.

## Reporting a vulnerability

Report suspected security issues in this SDK privately to the maintainers rather than opening a public issue.
