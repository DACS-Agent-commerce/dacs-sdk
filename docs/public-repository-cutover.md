# Public repository cutover

This checklist makes repository visibility a controlled release operation. It
does not itself authorize changing visibility, deleting branches, rewriting Git
history, publishing packages, or merging pull requests.

## Original exit criteria

- [ ] Merge the public-readiness hardening only after maintainer review.
- [ ] Confirm CI, package-artifact verification, and the secret scan are green
      on the exact candidate commit.
- [ ] Confirm the npm package remains described as unpublished until a package
      is actually released.
- [x] Delete the 72 approved merged/ancestor remote heads with SHA leases. The
      2026-08-21 cleanup retained all 24 closed-unmerged PR heads, nine
      unassociated unmerged heads, ten open-PR heads, and `main`.
- [x] Existing contributor email exposure was accepted by the repository owner
      on 2026-08-21. Do not rewrite history; recommend GitHub `noreply`
      addresses for future commits. The fresh audit found no absolute local path
      in current GitHub records or reachable source history.
- [x] Screen issue/PR bodies, issue comments, review comments, and review
      summaries for secrets and internal operational references. The 2026-08-21
      scans were clean, and no user attachment was present.
- [x] Close stale P0/P1 issues on engineering evidence: eight were closed as
      completed and #15 as architecturally superseded on 2026-08-21. Ten remain
      open because they still describe unfinished work.
- [ ] Ensure the contribution guide is merged or otherwise available before
      accepting external contributions.
- [ ] Record the accepted pre-alpha limitations and dependency posture in the
      release notes.
- [x] `info@kynesys.xyz` was confirmed as the correct private security contact
      by the repository owner on 2026-08-21.
- [x] The repository owner explicitly approved public visibility on 2026-08-21.

## Visibility status

The repository became public on 2026-08-21 so public GitHub Actions runners
could validate this hardening change. The history and GitHub-record audits,
branch cleanup, security-contact decision, and owner authorization were complete
before that change. The remaining unchecked criteria and controls are explicit
post-cutover work and must be completed promptly; public visibility does not mark
them complete.

## Protect `main` immediately

Create a branch ruleset targeting the default branch with:

- pull requests required before merge;
- at least one independent approving review;
- stale approvals dismissed when new commits are pushed;
- all review conversations resolved;
- force pushes and branch deletion blocked;
- required status checks, with branches required to be up to date:
  - `build-test (node 20.19.0)`;
  - `build-test (node 22)`;
  - `reproducible package + Bun consumer`;
  - `secret scan`;
- bypass limited to the smallest documented maintainer group, with emergency
  bypasses audited.

If a required-check name differs on the first public run, select the exact name
reported by that run rather than creating a similarly named placeholder.

## Enable repository security controls

- Set the default GitHub Actions workflow token permission to read-only.
- Require approval for workflows from first-time outside contributors.
- Keep Actions restricted to GitHub-authored actions and explicitly approved
  third-party actions, all pinned to immutable commits.
- Enable the dependency graph, Dependabot alerts, and Dependabot security
  updates.
- Enable GitHub secret scanning and push protection in addition to the Gitleaks
  workflow. Gitleaks covers reviewed history and custom mnemonic patterns;
  GitHub's scanner provides provider-backed detection and revocation signals.
- Enable GitHub private vulnerability reporting and verify that the
  **Security → Report a vulnerability** route is visible when logged out.
- Enable code scanning when an appropriate TypeScript configuration is ready;
  do not represent its absence as coverage.

## Validate after the change

- [ ] Inspect the repository while logged out and confirm only intended content
      is exposed.
- [ ] Run CI, package-artifact verification, and the secret scan on `main`.
- [ ] Re-run any pull request previously blocked by private-repository Actions
      billing and require the configured checks before merge.
- [ ] Confirm ruleset enforcement with a non-admin test pull request.
- [ ] Confirm private vulnerability reporting accepts a draft without filing a
      public issue.
- [ ] Confirm Actions logs and uploaded artifacts contain no credentials,
      mnemonic phrases, `.env` files, databases, wallet files, or live funded
      configuration.
- [ ] Check the repository's Pages, Releases, Packages, Deployments, webhooks,
      deploy keys, environments, variables, and secrets for unintended public
      surfaces.
- [ ] Record the final settings, candidate commit, approver, and validation date
      in the release/cutover record.

## Operating rules after publication

- Keep `.gitleaksignore` entries pinned to exact reviewed fingerprints. Never
  replace them with broad path, rule, regex, or commit allowlists.
- Supply live credentials only through environment variables or a managed
  secret store; never put funded configuration in examples, fixtures, issues,
  pull requests, logs, or workflow artifacts.
- Rotate any credential whose confidentiality is uncertain. Removing a secret
  from the current tree does not make a previously published secret private.
- Review dependency and secret-scanning alerts before every release.
- Publish npm packages only from a reviewed, immutable commit using a separate
  release procedure with provenance and least-privilege credentials.
