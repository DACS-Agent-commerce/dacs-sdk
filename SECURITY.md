# Security — dependency audit & policy

## Dependencies

A core install pulls six runtime dependencies. All six back the default
`ParserSpec` engine (see [docs/parser-engine.md](docs/parser-engine.md)), and
the package root loads them:

| Package | Used for |
| --- | --- |
| `@swaggerexpert/jsonpath` | JSONPath for `json` recipes |
| `@xmldom/xmldom`, `xpath` | XPath 1.0 over strictly parsed XML for `xml` recipes |
| `htmlparser2`, `css-select` | CSS selectors over a detached HTML tree for `html` recipes |
| `re2-wasm` | RE2 regular expressions for `raw` recipes |

The live Demos, x402 and EVM integrations are optional peers:
`peerDependencies: { "@kynesyslabs/demosdk": "^4.0.16" }` (plus `@x402/core`,
`@x402/evm`, `@x402/fetch` and `viem`), each marked optional in
`peerDependenciesMeta`, so npm does not install them. They are development
dependencies here for build and test coverage. Code reached from the package
root loads them lazily on first use, so a missing peer fails when that code
runs, not when the package is imported.
The `./substrate` subpath imports `@kynesyslabs/demosdk` directly, so importing
that subpath needs the peer installed. An application
that enables a live adapter installs those peers itself and should audit its
own tree under the policy below.

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
- **Transitive** criticals/highs are assessed for reachability, not blocked on
  severity alone; each assessment is added to
  `scripts/registry-container-audit-baseline.json`, whose list of assessed IDs
  is empty today.
- **Registry/container consumer acceptance** audits the generated consumer's
  current production dependencies (`npm audit --omit=dev`) by advisory ID against
  `scripts/registry-container-audit-baseline.json`. On non-enforcing pull requests,
  unlisted IDs warn and are recorded in the step summary. Scheduled drift checks,
  manual runs and callers enforcing drift fail on unlisted IDs. Direct high or
  critical advisories always block, including listed or assessed IDs; transitive
  assessments follow the reachability policy above.
  CI waives exit 4 only when this run's summary independently classifies as 4
  under the same caller policy. Missing, interrupted or inconsistent evidence,
  failed generated tests and independent policy failures remain blocking.
  Acceptance records evidence and replay fixtures after failures; it does not
  publish packages.
  The gated prerelease workflow requires acceptance. A run within the recorded
  baseline (exit 4) passes that prerequisite, so baseline-only findings do not
  stop a prerelease. A direct high or critical advisory always does, even when
  the baseline lists it.
- **Refresh cadence:** on every dependency bump **and** at least once per
  release cycle, since new findings can land against an unchanged tree, run
  registry/container consumer acceptance and, after review, add any new IDs it
  reports to `scripts/registry-container-audit-baseline.json` and `.md`.

## In-process signing keys

Session and bundle-finalization APIs do not accept raw Ed25519 seed arrays.
Callers must convert a seed to a Node `KeyObject` before constructing a session,
then immediately wipe their own seed buffer, or provide a remote/HSM-backed
signing callback. `privateKeyFromSeed()` wipes its temporary PKCS#8 encoding but
does not mutate the caller-owned array. Long-running services should prefer a
signing callback so exportable private-key material does not live in the
JavaScript heap.

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
