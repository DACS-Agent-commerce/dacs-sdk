# npm prerelease release runbook

Publishing is never part of ordinary CI and never occurs from a pull request.
The `Publish gated npm prerelease` workflow
(`.github/workflows/publish-prerelease-gated.yml`) accepts only a manually
selected tag whose name is exactly `v<package-version>`, whose commit is
contained in `main`, and whose version contains a prerelease identifier. Protect
its `npm-prerelease-gated` GitHub environment with a required maintainer
approval.

It replaces `publish-prerelease.yml` and the `npm-prerelease` environment. A
manual dispatch runs the workflow file at the selected ref, so an older tag
still runs that file, which publishes without the acceptance gate below. No
check in the current file can reach an older ref, so the gate holds only once
the publication credentials belong to the new file and environment alone, names
no older ref contains. Until the owner steps under "Moving publication
credentials to the gated workflow" are done, the old ungated path stays open.

Before approving the workflow:

1. require reviewed, green heads for the complete dependency stack;
2. merge through the documented parent-first order;
3. verify that core, host and generator manifests carry one exact version;
4. create the matching tag on that exact `main` commit; and
5. enter the exact version in the workflow dispatch form.

The workflow first runs the registry-shaped Linux and Docker acceptance
(`registry-container-acceptance.yml`) with advisory-ID drift enforced. The
publish job needs that job, so an advisory ID outside the #191 audit baseline,
or any other acceptance failure, stops publication before the publish job
starts; the acceptance job gets no secrets and no OIDC token. A run whose only
findings are recorded in the #191 baseline (exit 4) passes that job, as
it does on every other acceptance run, so baseline-only findings do not stop a
prerelease. The baseline waives transitive findings only: an advisory that is
high or critical on a direct dependency of the consumer fails the job even when
the baseline lists it. The publish job installs a pinned
release toolchain without a dependency cache, runs conformance, types and all
three test suites, and creates the release set twice. It uploads the three
exact tarballs, SHA-256 receipts, combined source provenance and one CycloneDX
SBOM per package before its publish step. It then publishes the reviewed
tarballs under the npm `next` tag in this order:

1. `@kynesyslabs/dacs`;
2. `@kynesyslabs/dacs-node`; and
3. `create-dacs-agent`.

The publisher reads each exact registry version first. A retry skips an already
published artifact only when its registry integrity equals the reviewed
receipt; any mismatch or registry ambiguity fails closed. This makes a partial
three-package release safely resumable without rebuilding or trying to replace
an immutable npm version.

GitHub creates a missing environment the first time a job names it, with no
reviewers and no deployment rule. So the publish job also needs a
`publish-environment` job, which names no environment and fails unless
`npm-prerelease-gated` already exists with a required reviewer, "Prevent
self-review" on, administrator bypass disabled, and deployments limited to tag patterns (owner step 1 below).
Until step 1 is done, every dispatch fails there; none publishes unapproved.
It reads the environment through the REST API with the workflow token's
`actions: read` permission. The publish step repeats this check immediately
before invoking the publisher, so a change during approval or package checks
fails closed. These are point-in-time checks: repository administrators remain
trusted to keep the environment and workflow protected during publication.

For the first release, configure the `npm-prerelease-gated` environment's
`NPM_TOKEN` secret with the minimum npm permission required to create all three
public packages. After package creation, configure each npm package's trusted
publisher for this repository, `publish-prerelease-gated.yml`, and the
`npm-prerelease-gated` environment, then remove the long-lived publish token.
Only the publish job is granted `id-token: write`; it also has `contents: read`
and `actions: read` for the protection recheck. npm
trusted publishing uses that short-lived OIDC identity and automatically
attaches provenance. See npm's official
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[provenance](https://docs.npmjs.com/generating-provenance-statements/)
documentation.

After the workflow completes, verify all three exact versions and their
provenance on npm. Generate a clean project from the registry packages and run
the clean-VPS restart, replay and capped funded acceptance before promoting a
prerelease or changing the stable `latest` tag.

## Moving publication credentials to the gated workflow

These are repository and npm settings, so a pull request cannot make them.
Complete them before the next publication. Until all of them are done, the old
ungated path stays open: dispatching `publish-prerelease.yml` from an older tag
whose three manifests carry an unpublished prerelease version still reaches
`npm publish` with whatever credentials the `npm-prerelease` environment, the
repository or the organization still give it.

1. Create the `npm-prerelease-gated` environment (Settings → Environments → New
   environment). Add the maintainers as required reviewers, turn on "Prevent
   self-review", disable "Allow administrators to bypass configured protection
   rules", and limit its deployment branches and tags to the tag pattern
   `v*`. The guard rejects a configuration whose only reviewer is the user who
   dispatched the run, because GitHub will not let that user approve the job.
   When a team is the reviewer, the API does not expose its members: make sure
   the dispatching maintainer is not the only member who could approve, or the
   deployment waits for another eligible approver.
2. If the first release still needs a token, create the `NPM_TOKEN` secret in
   the `npm-prerelease-gated` environment only, with the minimum permission from
   the previous section. Prefer a newly created token to copying the old value.
3. For each npm package that exists (`@kynesyslabs/dacs`,
   `@kynesyslabs/dacs-node`, `create-dacs-agent`), set its trusted publisher
   (package Settings → Trusted publishing → GitHub Actions) to this repository,
   workflow filename `publish-prerelease-gated.yml` and environment
   `npm-prerelease-gated`, replacing any binding to `publish-prerelease.yml` or
   `npm-prerelease`.
4. Delete the `NPM_TOKEN` secret from the `npm-prerelease` environment, and any
   `NPM_TOKEN` repository or organization secret this repository can read: the
   old workflow's `secrets.NPM_TOKEN` falls back to those.
5. Revoke on npmjs.com every token removed in step 4 that was not reused in
   step 2.
6. Disable the old `Publish npm prerelease` workflow (Actions → Publish npm
   prerelease → Disable workflow, or
   `gh workflow disable publish-prerelease.yml`). This is defence in depth;
   steps 3 to 5 are what take its credentials away.
7. Check the result: `gh secret list --env npm-prerelease` prints nothing,
   `gh secret list` and the organization's secrets show no `NPM_TOKEN` this
   repository can read, and each package's trusted publisher names only
   `publish-prerelease-gated.yml` and `npm-prerelease-gated`.

Never approve a deployment to the `npm-prerelease` environment again.
