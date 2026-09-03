# Security — dependency audit & policy

## Current production install

The live Demos and EVM/x402 integrations are optional peers. A core SDK install
therefore contains no production dependency tree, and
`npm audit --omit=dev` reports zero vulnerabilities. Consumers
that enable a live adapter must install its peers explicitly and should audit
that application-level tree under the reachability guidance below.

## Historical pre-remediation audit snapshot (reproducibility)

This record is a point-in-time **baseline**, not a post-remediation result. It
addresses (does not close) #40.

| Field | Value |
| --- | --- |
| Date | 2026-07-27 |
| Repo commit | `b405797` |
| `package-lock.json` object hash | `0a56ac8d582d2f269cf5e74745569257949f33b6` |
| npm | 11.7.0 |
| node | v25.2.1 |
| Command | `npm audit --omit=dev` (production tree, ~1,600 packages) |

Advisories can change without a `@kynesyslabs/demosdk` bump (a new advisory can be
published against an already-installed version), so refresh this snapshot on the
schedule in [Audit policy](#audit-policy), not only on dependency updates. This
refresh is itself an example: with the **same** `package-lock.json` object hash as
the 2026-07-20 baseline, the count moved from 132 → 134 (a new transitive `tar`
critical and a new `form-data` high advisory landed against unchanged installed
versions). Both are transitive; the direct-dependency gate stays green.

## Historical result

`npm audit --omit=dev` reports:

| Severity | Count |
| --- | --- |
| critical | 5 |
| high | 63 |
| moderate | 37 |
| low | 29 |
| **total** | **134** |

The SDK's own direct dependencies are `@kynesyslabs/demosdk`, `@x402/core`,
`@x402/evm`, `@x402/fetch`, `viem`. None carry an advisory *in the package
itself*, and `npm audit fix` cannot rewrite a dependency's own subtree. But the
findings are **not** all under one root: the **critical** advisories route
through `@kynesyslabs/demosdk`'s multichain tree, while a set of **high** DoS
advisories route through **`viem`** (a direct dependency) — see below. An earlier
version of this file claimed "all findings are transitive through demosdk"; that
was inaccurate and is corrected here.

#### High-severity `ws` DoS — via `viem` (direct dependency), not demosdk-only

- **Advisories:** GHSA-3h5v-q93c-6h6q and GHSA-96hv-2xvq-fx4p (`ws` DoS — many
  HTTP headers / memory exhaustion from tiny fragments), both **high**.
- **Path:** `viem@2.37.13 → ws` (and `ws` is *also* pulled under demosdk; it is
  deduped). `viem` is used by the **evm-erc20 settlement rail**, so this is a
  direct-dependency subtree finding, not isolable to the demosdk lazy-load.
- **Reachable from a DACS SDK path?** **No, on the shipped rail path.** `ws` is
  viem's **WebSocket** transport; the evm-erc20 rail builds its viem clients with
  the **HTTP** transport (`http(rpcUrl)`), which never instantiates `ws`. The DoS
  also targets a `ws` **server** accepting attacker connections — the SDK is a
  client, so even if the WS transport were selected, the server-side DoS surface
  isn't the SDK's. It would matter only if a consumer wired a viem WebSocket
  transport against an untrusted endpoint.
- **`npm audit fix`:** viem's pinned `ws` range is not user-overridable here; the
  fix is a viem bump (tracked against the upstream dependency).

### The 5 critical nodes are 3 advisories

`npm audit` labels a package node `critical` when it **inherits** that severity
through a `via` edge. Deriving the real advisories from the tree:

| Node (`npm audit`) | Independent critical advisory? |
| --- | --- |
| `form-data` | **Yes** — GHSA-fjxv-7rqg-78g4 |
| `protobufjs` | **Yes** — GHSA-xq3m-2v4x-88gg |
| `tar` | **Yes** — GHSA-23hp-3jrh-7fpw (node-tar decompression/parse DoS; new since the 2026-07-20 baseline) |
| `aptos` | No — inherits critical only `via form-data`; `aptos` itself has no critical advisory |
| `request` | No — its own advisory is GHSA-p8p7-x288-28g6 (**moderate** SSRF); its critical is inherited `via form-data` |

So there are **three** underlying critical advisories. Their per-advisory
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
- **Affected behavior:** generated JavaScript is derived from protobuf schema
  metadata. If an attacker controls a `.proto` definition or JSON descriptor
  loaded through protobufjs reflection APIs, crafted type names or references can
  reach runtime code generation and execute arbitrary JavaScript.
- **Reachable from a DACS SDK path?** **No, on this installed path.**
  `@confio/ics23` ships a pre-generated static codec that imports
  `protobufjs/minimal`; it does not load protobuf definitions or JSON descriptors
  at runtime. Cosmos proof bytes are decoded against that package-defined schema,
  and the SDK's own surfaces never import CosmJS.
- **Preconditions to exploit:** the application must load an attacker-controlled
  protobuf definition or JSON descriptor through reflection and then exercise the
  generated-code path. Supplying attacker-controlled Cosmos proof bytes to this
  static codec does not meet those preconditions.

#### GHSA-23hp-3jrh-7fpw — `tar` decompression/parse DoS (critical)

- **Installed vulnerable copy:** `tar@4.4.19` —
  `@kynesyslabs/demosdk → rubic-sdk → web3@1.10.4 → web3-bzz@1.10.4 → swarm-js@0.1.42 → tar`.
- **Affected behavior:** unbounded input during decompression/parse lets a crafted
  archive exhaust disk/CPU resources (denial of service). This advisory is new
  since the baseline and applies to the unchanged installed version.
- **Reachable from a DACS SDK path?** **No, on the shipped SDK paths.** `tar` is a
  runtime dependency of `swarm-js` in legacy Web3's Bzz subtree, not merely a
  build/packaging dependency. The SDK does not invoke Bzz/Swarm archive handling
  or call `tar` extraction/parse from its anchor, settle, verify, or identity paths.
- **Preconditions to exploit:** an application must pass an attacker-controlled
  compressed archive into the Bzz/Swarm archive path so that `tar` extracts or
  parses it; the SDK does not expose or invoke that operation.

### Why the pure surface is unaffected

`@kynesyslabs/demosdk` is loaded from two places: `src/substrate/DemosAdapter.ts`
(the only static, non-type import in `src/`), and `src/rails/payD402.ts`, which
performs LAZY dynamic imports (`@kynesyslabs/demosdk/websdk`, `…/d402/client`)
inside `createPayD402Rail` — behind the `acknowledgeExperimental: true` gate, so
neither executes at module load. `viem` is loaded only by the settlement rails
(`src/rails/evmErc20.ts` and `src/rails/x402.ts` via `viem/accounts`, both
lazily; the `x402` use touches no `ws` code path).
The top-level barrel and the pure surfaces — `canonical`, `crypto`, `artifacts`,
`identity`, `negotiate`, and all of **verify** — never load either. A verifier /
marketplace / reputation consumer using the pure surface does not execute any of
the vulnerable code, even though `npm install` places the packages on disk. The
demosdk subtrees run only for an app that builds the Demos on-chain adapter and
exercises the specific chain feature above; the `viem`/`ws` subtree runs only for
an app settling via the evm-erc20 rail, and even then only if it selects viem's
WebSocket transport — an app already running a full chain stack with these deps.

## Audit policy

- **Direct dependencies** are the only ones this repo can fix directly; a new
  direct dependency with an open critical/high advisory is not added. CI **fails**
  on any direct high/critical advisory (see below). The blocking gate submits
  exact installed versions to npm's bulk advisory endpoint, validates and bounds
  the response, retries transient failures, and fails closed if no authenticated
  result can be obtained. If npm's bulk service is unavailable, CI queries OSV
  with the same exact npm package/version pairs and conservatively blocks every
  match regardless of severity; both services must fail before the gate fails
  closed as unavailable. It never falls back to the retired quick audit endpoint.
- **Transitive** criticals/highs are assessed for reachability (as above), not
  blocked on severity alone; the assessment is recorded here.
- **Refresh cadence:** re-run the snapshot command and update this file on a
  `@kynesyslabs/demosdk` bump **and** at least once per release cycle, since new
  advisories can land against an unchanged tree.

## In-process signing keys

Session and bundle-finalization APIs do not accept raw Ed25519 seed arrays.
Callers must convert a seed to a Node `KeyObject` before constructing a session,
then immediately wipe their own seed buffer, or provide a remote/HSM-backed
signing callback. `privateKeyFromSeed()` wipes its temporary PKCS#8 encoding but
does not mutate the caller-owned array. Long-running services should prefer a
signing callback so exportable private-key material does not live in the
JavaScript heap.

## Remediation implemented

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

This SDK implements option 2: Demos, x402, and viem are optional peers, retained
as development dependencies for build/test coverage, and their live constructors
emit an explicit install message when a peer is absent. Package smoke tests cover
the dependency-free root import and production audit contract.

## Reporting a vulnerability

Report suspected security issues **privately**, not via a public issue:

- **Preferred:** GitHub **private vulnerability reporting** — the repository's
  **Security → Report a vulnerability** tab. Private reporting is enabled for
  this repository.
- If you cannot use the GitHub reporting form, email `info@kynesys.xyz` with the
  subject prefix
  `[dacs-sdk security]` to request a private reporting channel. Do not include
  sensitive vulnerability details until the maintainers confirm that channel,
  and do not include them in a public issue.

Please include the affected version/commit, a reproduction, and the impact. We
acknowledge reports and coordinate a fix and disclosure timeline privately.
