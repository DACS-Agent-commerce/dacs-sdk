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
  workflows. Gitleaks covers reviewed history and custom mnemonic patterns;
  GitHub's scanner provides provider-backed detection and revocation signals.
- Keep the **Secret scan (all branches)** workflow
  (`.github/workflows/secret-scan-all-branches.yml`). The required
  `secret scan` covers only the history of the commit under test (for a pull
  request, its merge commit with both parents), so this audit is the only
  Gitleaks scan of unmerged branches, tags and pull request heads. GitHub keeps
  serving every pull request's commits, closed and fork ones included, under
  `refs/pull/<number>/head`, and the audit fetches them. Both scans read what
  each commit's patch adds, including paths marked `-diff` in `.gitattributes`
  and a two-parent merge's own changes: its remerge diff, which is what the
  merge changed from git's automatic merge of its parents. Both run
  `scripts/secret-scan.sh`. Their limits:
  - they scan file contents only. Commit messages, author and committer names
    and emails, branch and tag names, and annotated tag messages are not
    scanned; review them in the pull request;
  - git shows no remerge diff for an octopus merge (one with more than two
    parents), so nothing it changes itself would be scanned. Each scan fails
    without running Gitleaks if the history it scans has one, and lists it;
    merge one branch at a time instead;
  - git prints a path containing a newline unquoted in a merge's `remerge`
    lines (see below), where it can pass for a line Gitleaks reads, and such a
    path's fingerprint can't be one `.gitleaksignore` line. Each scan fails
    without running Gitleaks if a commit in the history it scans adds, changes
    or deletes such a path, and lists those commits; rewrite that history
    without the path. As with an octopus merge, a pull request head that has
    one keeps the audit red until the pull request's branch is rewritten, or
    GitHub Support removes its `refs/pull` ref once the pull request is closed;
  - a pull request's `secret scan` runs the workflow, scripts, `.gitleaks.toml`
    and `.gitleaksignore` of that pull request's merge commit, as GitHub runs
    every `pull_request` workflow, so a pull request can change what checks
    it. Review a change to any of them as a change to the check itself. To
    bind the check to `main`'s version instead, require it through an
    organization ruleset's required workflow pinned to a reviewed commit, which
    must then fetch the merge commit only as data to scan and run nothing from
    it;
  - git comes from the `ubuntu-24.04` runner image, which GitHub updates. The
    merge scan needs git 2.36 or later. Gitleaks 8.30.1 logs a git error but
    still passes, so each scan first runs the same `git log` and fails if git
    exits with an error or writes anything to stderr. It then gives Gitleaks a
    `git` that records whether Gitleaks' own `git log` finished, and fails if
    it didn't or if Gitleaks logged a git error. If git warns that it
    skipped rename detection, add `-l<n>`, with the limit git suggests, to
    both workflows' `LOG_OPTS`;
  - before scanning, each scan runs `scripts/secret-scan-self-test.sh`: it
    builds a repository with one case of each kind above, scans it with the
    job's git, Gitleaks and options, and fails unless Gitleaks reports exactly
    the expected fingerprints. A git or Gitleaks update that changes what the
    scans see, or the fingerprints to pin, turns the scans red;
  - the audit runs once a day (04:17 UTC) and when dispatched from **Actions**.
    GitHub can delay a scheduled run, or drop it when Actions is busy, so a
    secret pushed to a branch can go unreported for a day or more. A branch
    deleted or force-pushed before the next run is never scanned, although its
    commits can stay readable on GitHub; rely on push protection (above) for
    that window;
  - GitHub notifies one user of a failed scheduled run: whoever created the
    workflow, then whoever last changed its `cron` line, or whoever last
    re-enabled it, and only as that user's notification settings allow.
    Nothing else alerts anyone. GitHub also disables scheduled workflows in a
    public repository after 60 days without activity;
  - it is not a required check, so a red run blocks nothing. Don't add it to
    the ruleset: it never runs on pull requests, so the check would never
    report.

  Each run's summary and log list its findings: one line per distinct Gitleaks
  fingerprint (`commit:file:rule:line`), with an ID and the number of findings.
  A file name can itself hold a secret, so they never show a fingerprint's file
  segment: besides the ID and the count, they show only the commit SHA, rule ID
  and line number, as Gitleaks wrote them in the fingerprint. A field that
  fails its check shows as `(invalid)`, and the commit of a finding that
  Gitleaks reported without one (see below) as `no-commit`. Gitleaks writes the report in the same
  job, from the checked-out history and with `--redact=100`. A report replaced
  by someone who controls the job is outside what this step can protect: they
  could print anything anyway.

  The ID is the first 16 hex digits of the fingerprint's SHA-256, a short
  digest that hides the file name from casual reading. It is not a secret:
  given the commit, rule and line beside it, anyone can confirm a guessed file
  name against the ID. That confirms only what the commit already shows, since
  GitHub serves a commit, file names included, by its SHA. Rotating any
  credential found is the control that protects it (see the operating rules
  below).

  Fingerprints already in `.gitleaksignore` are not reported. The list stops at
  900 KiB, but the run still gives the number of findings, of IDs and of IDs
  omitted from the list. A report that can't be read, including one over
  64 MiB, gives no counts and fails the run; review it with the local
  reproduction.

  To spot a new finding while the audit is red, first check the scan step's
  log: if it says `Nothing was scanned` or `The scan is partial`,
  `scripts/secret-scan.sh` failed the step because git failed, or the history
  has an octopus merge or a path containing a newline, and findings may be
  missing. Compare the run with the last
  run whose findings were all reviewed, not just with the previous run. An ID
  that wasn't among that run's findings, or a higher count for an ID, is new.
  Findings at the same commit, file, rule and line share one ID, so only its
  count tells them apart. If the run omitted any IDs, review them with a local
  reproduction.

  The local reproduction also gives the exact fingerprint for
  `.gitleaksignore`. Run it in a fresh clone, which checks out `main` and has
  every branch and tag, after fetching the pull request heads, as the audit
  does. It needs Gitleaks 8.30.1 and git 2.36 or later; an older git can't
  show merges, and the self-test fails on it. Ignore your own git
  configuration: settings such as `log.abbrevCommit` or `color.ui` change what
  Gitleaks reads.

  ```sh
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  export LOG_OPTS="--full-history --text --remerge-diff --all"
  git clone https://github.com/DACS-Agent-commerce/dacs-sdk.git dacs-sdk-audit
  cd dacs-sdk-audit
  git fetch --no-tags origin '+refs/pull/*/head:refs/pull/*/head'
  test "$(gitleaks version)" = 8.30.1
  bash scripts/secret-scan-self-test.sh "$(command -v gitleaks)"
  bash scripts/secret-scan.sh "$(command -v gitleaks)" --redact=100 --no-banner \
    --report-format=json --report-path=../gitleaks-report.json
  node scripts/gitleaks-fingerprint-summary.mjs \
    --report ../gitleaks-report.json --local
  ```

  Stop if any command before the scan fails. The scan exits 1 for findings
  too, but if it printed `Nothing was scanned` or `The scan is partial`, its
  report is missing or incomplete. The last command prints each fingerprint
  after its ID, and refuses to run in GitHub Actions. Unlike the run, it reads
  a report over 64 MiB, up to about 512 MiB, Node's limit on a string; a
  larger report fails closed. A fingerprint can contain a secret, so keep the
  output and the report private, and delete them afterwards. An ID from the
  run that the reproduction doesn't list belongs to a branch that has changed
  since, or to a finding that has since been pinned in `main`'s
  `.gitleaksignore` or dropped by a change to its `.gitleaks.toml`, unless
  your local scan failed; look up its commit on GitHub, and dispatch a new
  run to compare.

  In a merge's patch, git prints a `remerge CONFLICT` line for each
  conflicted file. Gitleaks 8.30.1 reads the file's path after such a line as
  `b/<path>`, and if the line contains the text `commit` (as for a path such
  as `src/negotiate/commitment.ts`, or a parent whose subject mentions a
  commit), it also drops the merge's commit from that file's fingerprint and
  from every later file of the merge. So `scripts/secret-scan.sh` gives
  Gitleaks the log without git's `remerge` lines. git continues such a line on
  lines of its own for a path containing a newline, which a crafted path can
  make look like any header line, a commit's included; that is why the scans
  refuse those paths (above). Between each `diff --git` line and the file's
  first hunk, the scan also drops any line that doesn't start as one of git's
  header lines. The self-test checks that the fingerprints of a conflict in
  `commitment.txt` and of a later file keep their commit and the file's own
  path, and that a path containing a newline is refused. Pin every finding as
  `commit:file:rule:line`; the
  `.gitleaksignore` test rejects any other entry. An entry without a commit
  would hide that file, rule and line in every commit, so don't pin a finding
  shown as `no-commit`: it means git printed a header line the scan doesn't
  know. Find the merge that adds the finding's line with
  `git log -p --remerge-diff --all -- <file>` in the local reproduction,
  review it as any other finding, and report the git version and the header
  line so the scan can be fixed; the run stays red until then.
- Enable GitHub private vulnerability reporting and verify that the
  **Security → Report a vulnerability** route is visible when logged out.
- Enable code scanning when an appropriate TypeScript configuration is ready;
  do not represent its absence as coverage.

## Validate after the change

- [ ] Inspect the repository while logged out and confirm only intended content
      is exposed.
- [ ] Run CI, package-artifact verification, and the secret scan on `main`.
- [x] #346, which pins the reviewed fingerprints of the known #336 and #268
      findings in `.gitleaksignore`, merged before #345, which adds the
      all-branch audit. Without those four entries the audit would be red for
      them from its first run.
- [ ] Before #345 merges, get the entries that open pull requests pin in
      their own `.gitleaksignore` reviewed onto `main`, as #346 did, or merge
      those pull requests first. The audit scans every pull request head with
      `main`'s `.gitleaksignore`, so it reports their findings until then.
      #332 is one: its head reaches findings that only its own branch pins.
      #268 is another: a commit pushed to it after #346 reaches a finding
      that no branch pins yet. Closed pull requests count too: #353, closed
      without merging, has a head that reaches findings no branch pins.
- [ ] Before #345 merges, decide which git the scans run. They use the
      `ubuntu-24.04` image's git, which GitHub updates, and the per-run
      self-test is what catches a git that changes what the scans see. Either
      install a checksum-pinned git build in both workflows, as they install
      Gitleaks, or record that the image's git is accepted, with the
      approver, in the cutover record.
- [ ] After #345 merges, dispatch **Actions → Secret scan (all branches)** on
      `main`. Its first run is also the first Gitleaks scan of every pull
      request head. Review every finding it lists, rotate any real credential,
      pin only reviewed fingerprints in `.gitleaksignore`, and dispatch again
      until a run is green. That run is the clean baseline for later runs.
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

- Keep `.gitleaksignore` entries pinned to exact reviewed fingerprints that
  include the commit (`commit:file:rule:line`). An entry without the commit
  (`file:rule:line`) would match that file, rule and line in every commit,
  including a later leak. Never replace them with broad path, rule, regex, or
  commit allowlists.
- A pin in a pull request's own `.gitleaksignore` keeps that pull request's
  `secret scan` green, but the audit reads only `main`'s. Get every reviewed
  pin onto `main` before relying on a green audit, including the pins of a
  pull request closed without merging: its head stays on GitHub, and the
  audit keeps scanning it.
- Supply live credentials only through environment variables or a managed
  secret store; never put funded configuration in examples, fixtures, issues,
  pull requests, logs, or workflow artifacts.
- Rotate any credential whose confidentiality is uncertain. Removing a secret
  from the current tree does not make a previously published secret private.
- Review dependency and secret-scanning alerts before every release.
- Before every release, open **Actions → Secret scan (all branches)** and
  confirm a green run on `main` that started after the last push to any branch,
  tag or pull request. A run dispatched from another branch uses that branch's workflow,
  script, `.gitleaksignore` and Gitleaks config, so it doesn't count. If there
  is none, dispatch the workflow on `main` and wait for it. A red run blocks the
  release until every finding has been reviewed, including any IDs its summary
  omitted: reproduce the scan locally (see the audit above), rotate any real
  credential, and pin only reviewed fingerprints, exactly, in
  `.gitleaksignore`.
- Publish npm packages only from a reviewed, immutable commit using a separate
  release procedure with provenance and least-privilege credentials.
