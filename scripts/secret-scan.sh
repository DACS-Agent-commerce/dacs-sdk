#!/usr/bin/env bash
# Scans the current repository's history with Gitleaks, as both secret-scan workflows do:
#
#   LOG_OPTS="<git log options>" scripts/secret-scan.sh <gitleaks> [gitleaks option...]
#
# Gitleaks scans the lines that the patches of `git log -p -U0 $LOG_OPTS` add. It logs a git
# error but still passes, having scanned only what came before it, so this fails before
# Gitleaks runs if that log would not show everything, and after it if git failed anyway.
set -euo pipefail
# git's messages in English, as the self-test expects them.
export LC_ALL=C

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

# Gitleaks runs the first git on its PATH, so it gets this one, which runs the real git and
# records the exit status of Gitleaks' `git -C . log`: Gitleaks passes even if git dies without
# a word on stderr. It also drops git's `remerge ...` lines, which describe a merge's
# conflicts, and the lines that continue one (git splits a message about a path containing a
# newline). Gitleaks 8.30.1 reads such a line as the start of a new commit if it contains the
# text `commit`, and then drops the merge's commit from that file's fingerprint and every later
# file's. So, from each `diff --git` line to the file's first hunk (`@@`), binary patch, next
# commit or blank line, only git's own header lines are kept; none of them holds file content.
# Elsewhere only `remerge ` lines are dropped: patch lines start with `+`, `-`, ` ` or `\`, and
# commit messages are indented.
export SECRET_SCAN_GIT SECRET_SCAN_GIT_STATUS="$temp/git-log.status"
SECRET_SCAN_GIT=$(command -v git)
mkdir "$temp/bin"
cat > "$temp/bin/git" <<'EOF'
#!/usr/bin/env bash
if [ "${1-} ${3-}" != "-C log" ]; then exec "$SECRET_SCAN_GIT" "$@"; fi
set -o pipefail
status=0
"$SECRET_SCAN_GIT" "$@" | LC_ALL=C sed -E '
/^diff --git /,/^(@@|Binary files |GIT binary patch|commit |$)/{
/^(diff --git |old mode |new mode |deleted file mode |new file mode |copy from |copy to |rename from |rename to |similarity index |dissimilarity index |index |--- |\+\+\+ |@@|Binary files |GIT binary patch|commit |$)/!d
}
/^remerge /d
' || status=$?
echo "$status" > "$SECRET_SCAN_GIT_STATUS"
exit "$status"
EOF
chmod +x "$temp/bin/git"

status=0
PATH="$temp/bin:$PATH" "$gitleaks" git . --log-opts="$LOG_OPTS" "$@" 2> "$temp/gitleaks.log" || status=$?
cat "$temp/gitleaks.log" >&2
# Gitleaks logs this when git writes to stderr during its own run, then stops and passes.
if grep -qF "stderr is not empty" "$temp/gitleaks.log"; then
  echo "The scan is partial: git failed during Gitleaks' run." >&2
  exit 1
fi
if [ "$(cat "$SECRET_SCAN_GIT_STATUS" 2> /dev/null)" != 0 ]; then
  echo "The scan is partial: Gitleaks' git log did not run, or did not finish." >&2
  exit 1
fi
exit "$status"
