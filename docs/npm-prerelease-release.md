# npm prerelease release runbook

Publishing is never part of ordinary CI and never occurs from a pull request.
The `Publish npm prerelease` workflow accepts only a manually selected tag whose
name is exactly `v<package-version>`, whose commit is contained in `main`, and
whose version contains a prerelease identifier. Protect its
`npm-prerelease` GitHub environment with a required maintainer approval.

Before approving the workflow:

1. require reviewed, green heads for the complete dependency stack;
2. merge through the documented parent-first order;
3. verify that core, host and generator manifests carry one exact version;
4. create the matching tag on that exact `main` commit; and
5. enter the exact version in the workflow dispatch form.

The workflow installs a pinned release toolchain without a dependency cache,
runs conformance, types and all three test suites, and creates the release set
twice. It uploads the three exact tarballs, SHA-256 receipts, combined source
provenance and one CycloneDX SBOM per package before its publish step. It then
publishes the reviewed tarballs under the npm `next` tag in this order:

1. `@kynesyslabs/dacs`;
2. `@kynesyslabs/dacs-node`; and
3. `create-dacs-agent`.

The publisher reads each exact registry version first. A retry skips an already
published artifact only when its registry integrity equals the reviewed
receipt; any mismatch or registry ambiguity fails closed. This makes a partial
three-package release safely resumable without rebuilding or trying to replace
an immutable npm version.

For the first release, configure the protected environment's `NPM_TOKEN` secret
with the minimum npm permission required to create all three public packages.
After package creation, configure each npm package's trusted publisher for this
repository, `publish-prerelease.yml`, and the `npm-prerelease` environment, then
remove the long-lived publish token. The workflow grants only `contents: read`
and `id-token: write`; npm trusted publishing uses that short-lived OIDC identity
and automatically attaches provenance. See npm's official
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[provenance](https://docs.npmjs.com/generating-provenance-statements/)
documentation.

After the workflow completes, verify all three exact versions and their
provenance on npm. Generate a clean project from the registry packages and run
the clean-VPS restart, replay and capped funded acceptance before promoting a
prerelease or changing the stable `latest` tag.
