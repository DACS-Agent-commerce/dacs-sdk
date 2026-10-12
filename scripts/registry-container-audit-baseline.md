The required registry/container rehearsal classifies npm audit advisories by
ID against `registry-container-audit-baseline.json`. Counts are diagnostics.
Known advisories remain the #191 baseline. New IDs appear in
`acceptance-summary.json` and a workflow warning, without failing every PR
for an upstream advisory change. Production publication remains blocked by
#191; acceptance is not publication approval.

`Registry consumer advisory-ID drift` runs daily and on manual dispatch. It
uses the same registry consumer audit and fails on any unlisted ID. Its check
runs whenever a summary exists, so a non-audit failure does not mask it. Audit
errors, malformed baselines and non-audit policy failures fail closed.

`policyFindings` records the non-audit security-gate failures that the
dependency tree of `main`'s published packages already carries, by exact
identity. They come from `@kynesyslabs/demosdk@4.0.16` and the generator's
template, not from the acceptance tooling. The source is the b7b180f run
38214792229 (clean registry consumer job) artifact:

- `gitDependencies`: `arbundles@0.6.23` (optional, via demosdk → rubic-sdk →
  @metaplex-foundation/js → @bundlr-network/client) depends on
  `avsc` from `https://github.com/Irys-xyz/avsc#csp-fixes`.
- `engineViolations`: 16 non-optional packages of the sigstore 5 chain
  (demosdk → sigstore → @sigstore/sign → make-fetch-happen → ...) require
  Node `^22.22.2 || ^24.15.0 || >=26.0.0`, below the generated project's
  Node 20 floor. `--engine-strict` reports only the first, so the run also
  lists every violation without it.
- `lockSbomProblems` / `physicalSbomProblems`: the exact `npm sbom`
  ESBOMPROBLEMS lines for that tree (the Git `avsc`, and peer ranges of
  `@ton/core`, `@solana/web3.js` and `node-fetch`).
- `productionImageDependencies`: `typescript@5.9.2` stays in the image after
  `npm prune --omit=dev`, because it is a peer of viem, abitype and ox and so
  is not marked dev in the lock.

A run whose failing checks match only these entries is baseline-only (exit 4).
Any other Git dependency, engine violation, SBOM problem or production
dependency, or a changed version, integrity or range, still exits 3.

Update the baseline only through a reviewed PR adding the observed IDs or
findings and citing the workflow run/job and commit that produced
`audit-policy.json` or `acceptance-summary.json`. Retain that evidence and
explain the #191 disposition; do not auto-accept drift. CODEOWNERS requires
review of this file, the JSON baseline and both workflows.
The initial advisory baseline copies all 88 IDs in the supplied job
114652354976 artifact for commit 35e6ce0 (the task description's 94 count
differs from the artifact). It does not use counts as policy.
