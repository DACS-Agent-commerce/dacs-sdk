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

# git quotes a path containing a newline everywhere but in its `remerge ...` lines, where the
# path's text after the newline becomes a line of its own (after a stray byte), and can pass for
# any line Gitleaks reads, a commit header included. Gitleaks would then report a finding under
# another commit or file, and such a path's fingerprint can't be one .gitleaksignore line. So
# the scan refuses any history in which a commit adds, changes or deletes such a path, a merge
# compared with each parent: every path of every scanned commit's tree is then checked. The
# counts are compared as numbers, as BSD and macOS `wc` pad them with spaces, and anything but a
# number refuses.
# shellcheck disable=SC2086
if ! newlines=$(git log --format=%H $LOG_OPTS --diff-merges=off |
  git diff-tree --stdin -r -z --name-only --root -m --no-commit-id | tr -cd '\n' | wc -c); then
  echo "Nothing was scanned: git failed to list the history's paths." >&2
  exit 1
fi
if ! [ "$newlines" -eq 0 ]; then
  echo "Nothing was scanned: after a path containing a newline, Gitleaks can report a finding under another commit or file. Rewrite the history without it; these commits add, change or delete one:" >&2
  # shellcheck disable=SC2086
  git log --format=%H $LOG_OPTS --diff-merges=off | while read -r commit; do
    if ! [ "$(git diff-tree -r -z --name-only --root -m --no-commit-id "$commit" | tr -cd '\n' | wc -c)" -eq 0 ]; then
      echo "$commit"
    fi
  done >&2
  exit 1
fi

# Gitleaks 8.30.1 normalizes every backslash to a slash when loading ignore entries,
# so even an interior backslash cannot be pinned exactly and may suppress another path.
# Its patch parser also skips trailing backslashes. Check raw, NUL-delimited paths,
# including deleted paths and each merge parent, rather than quoted patch headers.
count_backslashes() {
  local path count=0
  while IFS= read -r -d '' path; do
    case "$path" in *\\*) count=$((count + 1));; esac
  done
  echo "$count"
}
# shellcheck disable=SC2086
if ! backslashes=$(git log --format=%H $LOG_OPTS --diff-merges=off |
  git diff-tree --stdin -r -z --name-only --root -m --no-commit-id | count_backslashes); then
  echo "Nothing was scanned: git failed to list the history's paths." >&2
  exit 1
fi
if ! [ "$backslashes" -eq 0 ]; then
  echo "Nothing was scanned: Gitleaks can't preserve a backslash path in an exact ignore entry. Rewrite the history without it; these commits add, change or delete one:" >&2
  # shellcheck disable=SC2086
  git log --format=%H $LOG_OPTS --diff-merges=off | while read -r commit; do
    if ! [ "$(git diff-tree -r -z --name-only --root -m --no-commit-id "$commit" | count_backslashes)" -eq 0 ]; then
      echo "$commit"
    fi
  done >&2
  exit 1
fi

# Go's JSON encoding replaces invalid UTF-8 bytes with U+FFFD, collapsing distinct
# filenames and producing fingerprints that cannot match their original ignore entries.
# Validate the raw path bytes (NUL separators are valid UTF-8), with no locale-dependent
# decoding or replacement. No filename is printed, only the commits that touch it.
if ! command -v iconv > /dev/null; then
  echo "Nothing was scanned: iconv is required to validate UTF-8 paths." >&2
  exit 1
fi
# shellcheck disable=SC2086
if ! git log --format=%H $LOG_OPTS --diff-merges=off |
  git diff-tree --stdin -r -z --name-only --root -m --no-commit-id |
  iconv -f UTF-8 -t UTF-8 > /dev/null 2> /dev/null; then
  echo "Nothing was scanned: Gitleaks can't preserve an invalid UTF-8 path in JSON. Rewrite the history without it; these commits add, change or delete one:" >&2
  # shellcheck disable=SC2086
  git log --format=%H $LOG_OPTS --diff-merges=off | while read -r commit; do
    if ! git diff-tree -r -z --name-only --root -m --no-commit-id "$commit" |
      iconv -f UTF-8 -t UTF-8 > /dev/null 2> /dev/null; then
      echo "$commit"
    fi
  done >&2
  exit 1
fi

# Gitleaks runs the first git on its PATH, so it gets this one, which runs the real git and
# records stderr and the exit status of Gitleaks' `git -C . log`: Gitleaks accepts some git
# warnings, and passes even if git dies without a word on stderr. It also drops git's
# `remerge ...` lines, which describe a merge's
# conflicts. Gitleaks 8.30.1 reads such a line as the start of a new commit if it contains the
# text `commit`, and then drops the merge's commit from that file's fingerprint and every later
# file's. git can continue a `remerge` line on lines of its own: for a path containing a
# newline, which the check above refuses, and for a conflicted submodule that is checked out,
# which the workflows' checkouts never do. So, from each `diff --git` line to
# the file's first hunk (`@@`), binary patch, next commit or blank line, only lines that start
# as git's own header lines do are kept; none of git's holds file content. Elsewhere only
# `remerge ` lines are dropped: patch lines start with `+`, `-`, ` ` or `\`, and commit
# messages are indented.
export SECRET_SCAN_GIT SECRET_SCAN_GIT_STATUS="$temp/git-log.status" SECRET_SCAN_GIT_STDERR="$temp/git-log.stderr"
SECRET_SCAN_GIT=$(command -v git)
mkdir "$temp/bin"
cat > "$temp/bin/git" <<'EOF'
#!/usr/bin/env bash
if [ "${1-} ${3-}" != "-C log" ]; then exec "$SECRET_SCAN_GIT" "$@"; fi
set -o pipefail
status=0
"$SECRET_SCAN_GIT" "$@" 2> "$SECRET_SCAN_GIT_STDERR" | LC_ALL=C sed -E '
/^diff --git /,/^(@@|Binary files |GIT binary patch|commit |$)/{
/^(diff --git |old mode |new mode |deleted file mode |new file mode |copy from |copy to |rename from |rename to |similarity index |dissimilarity index |index |--- |\+\+\+ |@@|Binary files |GIT binary patch|commit |$)/!d
}
/^remerge /d
' || status=$?
cat "$SECRET_SCAN_GIT_STDERR" >&2
echo "$status" > "$SECRET_SCAN_GIT_STATUS"
exit "$status"
EOF
chmod +x "$temp/bin/git"

status=0
PATH="$temp/bin:$PATH" "$gitleaks" git . --log-opts="$LOG_OPTS" "$@" 2> "$temp/gitleaks.log" || status=$?
# The pinned ignore loader warns about colon-containing filenames and prints the
# complete fingerprint even with --redact=100, although it still honors the pin.
# Hide that entire diagnostic. Keep the raw log private for the partial-scan check.
sed '/Invalid \.gitleaksignore entry/c\
Gitleaks: ignore-entry diagnostic hidden (filename may be sensitive).
' "$temp/gitleaks.log" >&2
# Check git's own stderr, including warnings Gitleaks accepts without reporting an error.
if [ -s "$SECRET_SCAN_GIT_STDERR" ] || grep -qF "stderr is not empty" "$temp/gitleaks.log"; then
  echo "The scan is partial: git failed during Gitleaks' run or wrote to stderr." >&2
  exit 1
fi
if [ "$(cat "$SECRET_SCAN_GIT_STATUS" 2> /dev/null)" != 0 ]; then
  echo "The scan is partial: Gitleaks' git log did not run, or did not finish." >&2
  exit 1
fi
exit "$status"
