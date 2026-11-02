#!/usr/bin/env bash
set -euo pipefail
evidence=registry-container-artifacts
summary="$evidence/acceptance-summary.json"
export DACS_UNLISTED_ADVISORIES=fail
if [ "${GITHUB_EVENT_NAME-}" = pull_request ] && [ "${ENFORCE_AUDIT_DRIFT:-false}" != true ]; then
  DACS_UNLISTED_ADVISORIES=warn
fi
case "${1-}" in
  acceptance)
    # Preserve the producer's atomic output reservation, including concurrent runs.
    if test -e "$evidence"; then
      echo '::error title=Registry/container acceptance failed::Existing evidence requires a fresh checkout.'
      exit 1
    fi
    status=0
    npm run acceptance:registry-container -- --output-dir "$evidence" || status=$?
    if [ "$status" -eq 0 ] || [ "$status" -eq 4 ]; then
      disposition=0
      node scripts/registry-container-disposition.mjs "$summary" || disposition=$?
      if [ "$status" -eq 4 ] && [ "$disposition" -eq 4 ]; then
        echo '::warning title=Registry/container policy warning::Functional acceptance passed with policy findings permitted by this caller. See acceptance-summary.json.'
        exit 0
      fi
      if [ "$status" -eq 4 ]; then
        echo "::error title=Registry/container acceptance failed::Exit 4 did not independently classify as 4 (summary disposition: $disposition)."
        exit "$status"
      fi
      exit "$disposition"
    fi
    exit "$status"
    ;;
  drift)
    if ! test -f "$summary"; then
      echo '::warning title=Registry audit advisory drift::No acceptance summary; advisory-ID drift was not evaluated.'
      if [ "$DACS_UNLISTED_ADVISORIES" = fail ]; then exit 1; fi
      exit 0
    fi
    status=0
    node scripts/registry-container-disposition.mjs --audit-drift "$summary" || status=$?
    if [ "$DACS_UNLISTED_ADVISORIES" = fail ]; then exit "$status"; fi
    ;;
  summary)
    node --input-type=module - "$summary" <<'NODE'
import { appendFileSync } from "node:fs";
import { readBoundedFile } from "./scripts/acceptance-evidence-io.mjs";
const file = readBoundedFile(process.argv[2]);
if (file) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Registry-shaped consumer acceptance\n' + file.bytes.toString("utf8") + '\n');
NODE
    ;;
  *) echo 'usage: acceptance-ci.sh <acceptance|drift|summary>' >&2; exit 1 ;;
esac
