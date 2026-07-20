# Security — dependency audit & policy

## Audit snapshot (reproducibility)

This record is a point-in-time **baseline**, not a post-remediation result. It
addresses (does not close) #40.

| Field | Value |
| --- | --- |
| Date | 2026-07-20 |
| Repo commit | `f6e53d5` |
| `package-lock.json` object hash | `0a56ac8d582d2f269cf5e74745569257949f33b6` |
| npm | 11.7.0 |
| node | v25.2.1 |
| Command | `npm audit --omit=dev` (production tree, ~1,600 packages) |

Advisories can change without a `@kynesyslabs/demosdk` bump (a new advisory can be
published against an already-installed version), so refresh this snapshot on the
schedule in [Audit policy](#audit-policy), not only on dependency updates.

## Result

`npm audit --omit=dev` reports:

| Severity | Count |
| --- | --- |
| critical | 4 |
| high | 63 |
| moderate | 37 |
| low | 28 |
| **total** | **132** |

All findings are **transitive through `@kynesyslabs/demosdk`**. The SDK's own
direct dependencies are `@kynesyslabs/demosdk`, `@x402/core`, `@x402/evm`,
`@x402/fetch`, `viem`; none carry an open advisory, and `npm audit fix` cannot
rewrite a dependency's own subtree.

### The "4 critical" are 2 advisories, not 4

`npm audit` labels a package node `critical` when it **inherits** that severity
through a `via` edge. Deriving the real advisories from the tree:

| Node (`npm audit`) | Independent critical advisory? |
| --- | --- |
| `form-data` | **Yes** — GHSA-fjxv-7rqg-78g4 |
| `protobufjs` | **Yes** — GHSA-xq3m-2v4x-88gg |
| `aptos` | No — inherits critical only `via form-data`; `aptos` itself has no critical advisory |
| `request` | No — its own advisory is GHSA-p8p7-x288-28g6 (**moderate** SSRF); its critical is inherited `via form-data` |

So there are **two** underlying critical advisories. Their per-advisory
reachability:

#### GHSA-fjxv-7rqg-78g4 — `form-data` predictable multipart boundary (critical)

- **Affected range:** `<2.5.4` and `>=4.0.0 <4.0.4`.
- **Installed vulnerable copies (from the lock/tree):**
  - `form-data@4.0.0` — `demosdk → @metaplex-foundation/js@0.20.1 → @irys/sdk@0.0.2 → form-data`
  - `form-data@2.3.3` — legacy `@metaplex-foundation/js` HTTP path
  - (The `form-data@4.0.5` copies elsewhere in the tree are **not** in range.)
- **Affected behavior:** the multipart boundary is chosen with `Math.random()`; an
  attacker who can inject bytes into a multipart field value can predict the
  boundary and break out of it (parameter/part injection).
- **Reachable from a DACS SDK path?** **No.** `form-data` here backs the
  Metaplex/Irys **asset-upload** HTTP clients. No settlement, verify, canonical,
  or identity path constructs a multipart request. It executes only if an app
  drives the Metaplex/Irys upload feature through the Demos adapter.
- **Preconditions to exploit:** the process builds `multipart/form-data` requests
  with attacker-influenced field content — not a code path this SDK invokes.

#### GHSA-xq3m-2v4x-88gg — `protobufjs` arbitrary code execution (critical)

- **Affected range:** `<7.5.5`.
- **Installed vulnerable copy:** `protobufjs@6.11.6` —
  `demosdk → @cosmjs/stargate@0.32.4 → @confio/ics23@0.6.8 → protobufjs`.
  **Note:** the other installed copy, `protobufjs@7.6.3` (direct under demosdk),
  is **> 7.5.5 and NOT vulnerable to this critical** (it carries only lower-severity
  advisories). The critical is confined to the CosmJS/ICS23 `6.11.6` copy.
- **Affected behavior:** prototype-pollution while populating message objects from
  untrusted input via reflection, escalating to code execution.
- **Reachable from a DACS SDK path?** **No.** `@confio/ics23` decodes Cosmos
  IAVL / ICS-23 membership proofs under `@cosmjs/stargate`; it runs only if an app
  performs **Cosmos/IBC** chain operations through the Demos adapter. The SDK's own
  surfaces never import CosmJS.
- **Preconditions to exploit:** decoding attacker-controlled protobuf/Cosmos proof
  bytes with the vulnerable reflection path.

### Why the pure surface is unaffected

`@kynesyslabs/demosdk` is imported by exactly one module — `src/substrate/DemosAdapter.ts`
(verified: it is the only non-type `@kynesyslabs/demosdk` import in `src/`). The
top-level barrel and the pure surfaces — `canonical`, `crypto`, `artifacts`,
`identity`, `negotiate`, and all of **verify** — never load it. A verifier /
marketplace / reputation consumer using the pure surface does not execute any of
the vulnerable code, even though `npm install` places the packages on disk. The
vulnerable subtrees run only for an app that builds the Demos on-chain adapter and
exercises the specific chain feature above — an app already running a full chain
stack with these same dependencies.

## Audit policy

- **Direct dependencies** are the only ones this repo can fix directly; a new
  direct dependency with an open critical/high advisory is not added. CI **fails**
  on any direct high/critical advisory (see below).
- **Transitive** criticals/highs are assessed for reachability (as above), not
  blocked on severity alone; the assessment is recorded here.
- **Refresh cadence:** re-run the snapshot command and update this file on a
  `@kynesyslabs/demosdk` bump **and** at least once per release cycle, since new
  advisories can land against an unchanged tree.

## Recommended remediation (needs a packaging decision)

The structural fix is to stop shipping the multichain tree to consumers who only
need the pure surface. Note that `optionalDependencies` does **not** achieve this —
npm installs optional deps by default — and ordinary `peerDependencies` are also
auto-installed by npm 7+. The two mechanisms that actually keep the tree out of a
pure-surface install are:

1. **Split package** — move `DemosAdapter` and its `@kynesyslabs/demosdk` dependency
   into a separate package (e.g. `@kynesyslabs/dacs-substrate`). The core package
   then has zero chain dependencies; adapter consumers install the substrate package
   explicitly.
2. **Optional peer** — declare demosdk as
   `peerDependencies: { "@kynesyslabs/demosdk": "^4" }` **plus**
   `peerDependenciesMeta: { "@kynesyslabs/demosdk": { "optional": true } }` (npm does
   NOT auto-install an optional peer), guard the substrate subpath's runtime
   `import()` to throw a clear "install @kynesyslabs/demosdk" error when absent, and
   update + test the build/runtime contract.

Either changes the install contract and needs the test/build wiring updated to
match, so it is a deliberate packaging decision tracked as follow-up, not folded
into this audit record.

## Reporting a vulnerability

Report suspected security issues **privately**, not via a public issue:

- **Preferred:** GitHub **private vulnerability reporting** — the repository's
  **Security → Report a vulnerability** tab (maintainers enable it in
  *Settings → Code security → Private vulnerability reporting*).
- If that is unavailable, email the maintainers at the security contact listed on
  the repository/organization profile.

Please include the affected version/commit, a reproduction, and the impact. We
acknowledge reports and coordinate a fix and disclosure timeline privately.
