The required registry/container rehearsal classifies npm audit advisories by
ID against `registry-container-audit-baseline.json`. Counts are diagnostics.
Known advisories remain the #191 baseline. New IDs appear in
`acceptance-summary.json` and a workflow warning, without failing every PR
for an upstream advisory change. Production publication remains blocked by
#191; acceptance is not publication approval.

`Registry consumer advisory-ID drift` runs daily and on manual dispatch. It
uses the same registry consumer audit and fails on any unlisted ID. Audit
errors, malformed baselines and non-audit policy failures fail closed.

Update the baseline only through a reviewed PR adding the observed IDs and
citing the workflow run/job and commit that produced `audit-policy.json`.
Retain that evidence and explain the #191 disposition; do not auto-accept drift.
The initial baseline copies all 88 IDs in the supplied job 114652354976
artifact for commit 35e6ce0 (the task description's 94 count differs from the
artifact). It does not use counts as policy.
