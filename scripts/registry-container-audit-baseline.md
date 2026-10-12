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
  audit policy for transitive advisories.
- Everywhere else it fails closed (exit 3), and the error names it: the
  scheduled drift workflow, manual runs, and any release or publication path
  that runs this acceptance or its disposition. Failing closed is the default;
  only the pull-request job sets `DACS_UNLISTED_ADVISORIES=warn`.

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
severity on a direct dependency of the consumer; that blocks (exit 3).

The job runs only for pull requests that change a path in its
`pull_request.paths` filter, so it must not be a required status check in
branch protection: a pull request outside the filter would wait for it forever.

`policyFindings` records the non-audit security-gate failures that the
dependency tree of `main`'s published packages already carries, by exact
identity. They come from `@kynesyslabs/demosdk@4.0.16` and the generator's
template, not from the acceptance tooling. The source is the b7b180f run
38214792229 (clean registry consumer job) artifact:

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
  is not marked dev in the lock.

A run whose failing checks match only these entries is baseline-only (exit 4).
Any other non-registry dependency, engine violation, SBOM problem or production
dependency, or a changed version, integrity or range, still exits 3.

Update the baseline only through a reviewed PR adding the observed IDs or
findings and citing the workflow run/job and commit that produced
`audit-policy.json` or `acceptance-summary.json`. Retain that evidence and
explain the #191 disposition; do not auto-accept drift. CODEOWNERS requires
review of this file, the JSON baseline and both workflows.
The initial advisory baseline copies all 88 IDs in the supplied job
114652354976 artifact for commit 35e6ce0 (the task description's 94 count
differs from the artifact). It does not use counts as policy.
