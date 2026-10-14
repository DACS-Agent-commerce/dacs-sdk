#!/usr/bin/env bash
# Scans the current repository's history with Gitleaks, as both secret-scan workflows do:
#
#   LOG_OPTS="<git log options>" scripts/secret-scan.sh <gitleaks> [gitleaks option...]
#
# Gitleaks scans the lines that the patches of `git log -p -U0 $LOG_OPTS` add. It logs a git
# error but still passes, having scanned only what came before it, so this fails before
# Gitleaks runs if that log would not show everything, and after it if git failed anyway.
set -euo pipefail

gitleaks=$1
shift
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT

# Git must first run the same log with no error and nothing on stderr. LOG_OPTS is split at
# each space, as Gitleaks splits it.
# shellcheck disable=SC2086
if ! git log -p -U0 $LOG_OPTS > /dev/null 2> "$temp/git-log.err" || [ -s "$temp/git-log.err" ]; then
  cat "$temp/git-log.err" >&2
  echo "Nothing was scanned: git log failed or wrote to stderr." >&2
  exit 1
fi

# --remerge-diff shows no patch for a merge with more than two parents, only a warning on
# stdout, so nothing that an octopus merge itself changes would be scanned.
# shellcheck disable=SC2086
octopus=$(git log --min-parents=3 --format=%H $LOG_OPTS --diff-merges=off)
if [ -n "$octopus" ]; then
  echo "Nothing was scanned: Gitleaks can't read what an octopus merge itself changes. Merge one branch at a time instead of:" >&2
  echo "$octopus" >&2
  exit 1
fi

status=0
"$gitleaks" git . --log-opts="$LOG_OPTS" "$@" 2> "$temp/gitleaks.log" || status=$?
cat "$temp/gitleaks.log" >&2
# Gitleaks logs this when git writes to stderr during its own run, then stops and passes.
if grep -qF "stderr is not empty" "$temp/gitleaks.log"; then
  echo "The scan is partial: git failed during Gitleaks' run." >&2
  exit 1
fi
exit "$status"
