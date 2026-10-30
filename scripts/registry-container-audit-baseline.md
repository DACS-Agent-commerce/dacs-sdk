The registry/container acceptance job classifies npm audit advisories in the
generated consumer's dependency tree by ID against
`registry-container-audit-baseline.json`. Counts are diagnostics. A run that
observes only listed IDs, or a subset of them (an advisory resolved since), is
baseline-only (exit 4). Production publication remains blocked by #191;
acceptance is not publication approval.

An advisory ID that is not listed, including a GHSA newly published against a
dependency the tree already had, is treated by where the run comes from:

- On `pull_request` it is a warning annotation and a line in the job's step
  summary, and the job passes (exit 4). A new advisory on an unchanged tree
  therefore cannot turn unrelated pull requests red, in line with SECURITY.md's
  audit policy for transitive advisories. An unlisted ID that npm reports at
  high or critical severity on a direct dependency of the consumer fails pull
  requests too (exit 3), as CI fails on any direct high/critical advisory.
- Everywhere else it fails closed (exit 3), and the error names it: the
  scheduled drift workflow, manual runs, and any release or publication path
  that runs this acceptance or its disposition. `Publish gated npm prerelease`
  runs this acceptance with drift enforced as a job its publish job needs, so
  an unlisted ID stops publication. Failing closed is the default; only the
  pull-request job sets `DACS_UNLISTED_ADVISORIES=warn`, and never when a
  caller enforces drift.

`Registry consumer advisory-ID drift` runs the same consumer audit daily and on
manual dispatch, so a newly published advisory is reported without waiting for
a PR. Its check runs whenever a summary exists, so a non-audit failure does not
mask it. A run that stopped before its audit was classified (for example an
npm audit outage, a network failure) is reported with that stage, not as a
baseline problem. Malformed baselines and non-audit policy failures fail
closed.

`assessedAdvisories` lets the gate pass under SECURITY.md's audit policy once
#191 is resolved: an observed ID recorded there, with `assessment` naming where
its reachability assessment is written, does not block. It is empty today.
An assessment cannot accept an advisory that npm reports at high or critical
severity on a direct dependency of the consumer, and neither can this baseline:
listed or assessed, such an advisory blocks (exit 3). A baseline-only exit 4
lets a prerelease publish, so the baseline only ever waives transitive
findings.

The job runs only for pull requests that change a path in its
`pull_request.paths` filter, so it must not be a required status check in
branch protection: a pull request outside the filter would wait for it forever.

`policyFindings` records the non-audit security-gate failures that the
dependency tree of `main`'s published packages already carries, by rule. They
come from `@kynesyslabs/demosdk@4.0.16` and the generator's
template, not from the acceptance tooling. The source, recorded in the JSON's
`policyFindings.source`, is the `clean registry consumer (Node 20 / Docker)` job
of run 38214792229, attempt 1, for b7b180f
(https://github.com/DACS-Agent-commerce/dacs-sdk/actions/runs/38214792229/attempts/1),
artifact `dacs-registry-container-275d856a1bbea2de6f666c069878277b23544ff1`:

- `gitDependencies`: `arbundles@0.6.23` (optional, via demosdk → rubic-sdk →
  @metaplex-foundation/js → @bundlr-network/client) depends on
  `avsc` from `https://github.com/Irys-xyz/avsc#csp-fixes`. The key holds every
  violation of the registry-only allowlist: each installed lock entry must
  resolve to a tarball under the run's registry with an integrity, and every
  dependency spec must be a version, range, tag or `npm:` alias.
- `engineViolations`: 16 non-optional packages of the sigstore 5 chain
  (demosdk → sigstore → @sigstore/sign → make-fetch-happen → ...) require
  Node `^22.22.2 || ^24.15.0 || >=26.0.0`, below the generated project's
  Node 20 floor. `--engine-strict` reports only the first. The disposition
  lists them all from the generated lock: it tests every non-optional
  package's `engines.node` and `engines.npm` against the consumer
  container's recorded Node and npm versions, as npm's EBADENGINE check does.
  (`npm ci --no-engine-strict` cannot: npm 11 fails its package.json/lock
  sync check on the nested Git `avsc`.) A range the scan cannot evaluate, or
  missing versions, leaves the scan incomplete, which blocks.
- `lockSbomProblems` / `physicalSbomProblems`: the exact `npm sbom`
  ESBOMPROBLEMS lines for that tree (the Git `avsc`, and peer ranges of
  `@ton/core`, `@solana/web3.js` and `node-fetch`).
- `productionImageDependencies`: `typescript@5.9.2` stays in the image after
  `npm prune --omit=dev`, because it is a peer of viem, abitype and ox and so
  is not marked dev in the lock. Besides `typescript` and `rubic-sdk`, which
  the policy names, the acceptance lists every entry under the final image's
  `node_modules` (`scripts/runtime-image-inventory.mjs`, run inside the image)
  and the disposition compares it with the generated lock's production
  closure (every entry not marked dev). Each image package outside that
  closure, or at another name or version than the lock records at its
  location, is a finding; an entry that cannot be read, or a required closure
  package the image lacks, blocks without a baseline. The b7b180f run predates
  the inventory; the acceptance workflow uploads regenerated fixtures with it.

Run [38706155424, attempt 1](https://github.com/DACS-Agent-commerce/dacs-sdk/actions/runs/38706155424/attempts/1),
job `clean registry consumer (Node 20 / Docker)`, at merge commit
`5c27c28fd9225cff3e7653a5a013fd5f3168398c` (`ded30d5` into `3904d70`),
adds two individually reviewed upstream dependency findings. Their source and
dispositions are in `policyFindings.additionalSources`. The original summary,
SBOM errors and reduced lock/inventory are retained in
`test/scripts/fixtures/registry-container-5c27c28/`; its README records the
artifact URL, original file hashes and the reduction. This run has no unlisted
advisory IDs, image-inventory errors or missing required image packages.

- `productionImageDependencies`: `pqcrypto` at `node_modules/pqcrypto` has
  installed manifest version `1.0.01`, while the registry lock entry is
  `1.0.1` with integrity
  `sha512-83SHdhiOYAaUK6HUKihoH36SqQ11ma+Q7o+DQUasV/IUZSrW8doQVPoTPrR0xU+tUyFnrJSC4aIp5rKnlELrqw==`.
  `@kynesyslabs/demosdk@4.0.16` already requires `pqcrypto ^1.0.1`.
  The package is in the production closure; its shipped manifest disagrees
  with the registry metadata. **Disposition:** retain this upstream package
  metadata defect under #191 until the upstream package fixes its version.
  The inventory continues to report the mismatch; no version normalization or
  package exclusion is added to the gate.
- `physicalSbomProblems`:
  `invalid: bip39@3.1.2, 3.1.0 required by @multiversx/sdk-core@13.17.2`.
  demosdk requires `bip39 ^3.1.0` and `@multiversx/sdk-core ^13.17.2`;
  MultiversX optionally requires exactly `bip39 3.1.0`. The generated lock
  contains that nested optional copy, but `--omit=optional` removes it.
  npm's physical SBOM then sees top-level `bip39@3.1.2`, which does not meet
  that exact optional constraint. **Disposition:** retain this upstream
  optional-dependency SBOM defect under #191 until the dependency constraint
  is resolved upstream. The SBOM still fails with ESBOMPROBLEMS; the
  disposition uses the existing exact package / required-range / parent rule.

These are npm dependency findings in the generated image/consumer, not OS
base-image CVEs. They receive the same #191 baseline-only disposition as the
existing upstream findings. Neither is a reachability assessment or production
publication approval. No gate predicate or exit code changes: replaying this
evidence is exit 4, `securityGate.passed` remains false, and unrecorded rules
still exit 3.

A run whose failing checks match only these entries is baseline-only (exit 4).
Each entry keeps the version and integrity its source run observed, as
evidence, but matches by rule: the lock location, the dependency field and
spec, the package name and required engine range, and the `npm sbom` line with
installed versions elided. The pqcrypto image finding additionally requires the
exact recorded manifest version `1.0.01`; another manifest version is unlisted
even at the same package name and location. The generated consumer installs
without a lockfile, so a patch release of another listed package that keeps the same rule (for example
`@npmcli/agent@5.0.3` under make-fetch-happen's `^5.0.0`) stays baseline-only
instead of failing every pull request, the drift job and prereleases. Any other
non-registry dependency, engine violation, SBOM problem or production
dependency, or a listed one at another location, spec or range, still exits 3.

Update the baseline only through a reviewed PR adding the observed IDs or
findings and citing the workflow run/job and commit that produced
`audit-policy.json` or `acceptance-summary.json`. Retain that evidence and
explain the #191 disposition; do not auto-accept drift.

CODEOWNERS names a code owner for this file, the JSON baseline, the scripts
that decide it and both workflows. That review is enforced only if branch
protection on `main` requires code-owner review, a repository setting this
change cannot make. Without it, a pull request can add its own new IDs or
findings here and pass as baseline-only. While the only code owner is also
the account that authors these changes, an independent review needs another
maintainer.

The initial advisory baseline copies all 88 advisory IDs from
`audit-policy.json` in the artifact
`dacs-registry-container-9dd394cb7d3a6db6bf767bf9c35fb24f6aae5d27` of job
114652354976 (https://github.com/DACS-Agent-commerce/dacs-sdk/runs/114652354976)
for commit 35e6ce0, recorded in the JSON's `source`. Advisory IDs determine baseline membership. Audit counts must still agree
with the advisory evidence and npm exit status before the result is admitted.

## Node 20 consumer refresh

Source: the clean registry consumer job at `90f8443`, independently checked
against a fresh lock of the packed SDK, Node host and pinned generated peers.
No package or generator dependency declarations change here. Exact package,
location, integrity and engine range identify each engine exception.

| Finding | Dependency path and reason retained |
| --- | --- |
| `@tufjs/models@5.0.1 at node_modules/@tufjs/models` | The packed consumer selects demosdk 4.0.16 -> sigstore ^5.0.0 -> @sigstore/tuf ^5.0.0 -> tuf-js ^6.0.0 -> @tufjs/models 5.0.1. Both published models 5.x versions require Node 22.22.2 or newer supported majors; pinning 5.0.0 does not restore Node 20 support. A compatible parent-major change belongs in a separate consumer dependency change. |
| `tuf-js@6.0.1 at node_modules/tuf-js` | The packed consumer selects demosdk 4.0.16 -> sigstore ^5.0.0 -> @sigstore/tuf ^5.0.0 -> tuf-js ^6.0.0. Both published tuf-js 6.x versions require Node 22.22.2 or newer supported majors; pinning 6.0.0 does not restore Node 20 support. A compatible parent-major change belongs in a separate consumer dependency change. |
| `GHSA-4qx8-w7c3-pj3p` | The transitive path is demosdk 4.0.16 -> @coral-xyz/anchor 0.32.1 -> toml ^3.0.0 (3.0.0). Many array-of-tables headers cause quadratic parsing work. The corrected toml 5.0.1 is outside the selected parent range; the parent must change before this entry can be removed. |
| `GHSA-9j65-hcg3-gc64` | The same transitive Anchor/toml 3.0.0 path permits quadratic parsing work on long dotted keys or table paths. The corrected toml 5.0.1 is outside Anchor's ^3.0.0 range; retain the notice until the parent changes. |
| `GHSA-9qmh-m7c6-f92p` | The same transitive Anchor/toml 3.0.0 path permits excessive CPU use for long integer literals. The corrected toml 5.0.1 is outside Anchor's ^3.0.0 range; retain the notice until the parent changes. |
| `GHSA-mrhx-c7xc-m3w5` | The transitive path is @x402/core 2.15.0 -> zod ^3.24.2 (3.25.76). Oversized constrained collections can exhaust memory. The corrected zod 4.6.6 is outside the selected parent range; a compatible x402 parent update is required. Direct high/critical results remain blocking. |

A major-version override would replace dependencies outside their parents'
declared contracts. That needs a separate consumer dependency change and its
runtime compatibility checks. The current allowed tuf-js/models majors have
no Node 20 release; older patch pins retain the same engine restriction.
The toml and zod corrections likewise require parent range changes.

Remove each entry after its upstream constraint is corrected and fresh consumer
acceptance confirms it. Never convert incomplete evidence or a new identity to
baseline success.
