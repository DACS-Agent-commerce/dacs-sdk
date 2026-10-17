#!/usr/bin/env bash
# Checks that this machine's git and the given Gitleaks still find what the secret-scan
# workflows rely on, with the job's own options:
#
#   LOG_OPTS="<git log options>" scripts/secret-scan-self-test.sh <gitleaks>
#
# It builds a repository with one marker for each case, scans it with scripts/secret-scan.sh
# and a rule that matches only the markers, and fails unless Gitleaks reports exactly the
# expected fingerprints. A git or Gitleaks update that changes what the scans see, or the
# fingerprints to pin, fails here before the real scan runs.
set -euo pipefail
# git's messages in English, which the checks below read.
export LC_ALL=C

gitleaks=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
scan=$(cd "$(dirname "$0")" && pwd)/secret-scan.sh
case "$LOG_OPTS" in
  *" HEAD") pull_requests=false ;;
  *" --all") pull_requests=true ;;
  *) echo "self-test: LOG_OPTS must end with HEAD or --all" >&2; exit 1 ;;
esac
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

cat > "$temp/markers.toml" <<'EOF'
title = "secret scan self-test"

[[rules]]
id = "marker"
description = "self-test marker"
regex = '''marker-[a-z-]+'''
EOF
printf '{{ range . }}{{ .Fingerprint }}\n{{ end }}' > "$temp/fingerprints.tmpl"

commit_file() { # file text message
  printf '%s\n' "$2" > "$1"
  git add --all
  git commit -q -m "$3"
}

# The fingerprints Gitleaks reports for the repository in the working directory, one per line.
fingerprints() { # report
  bash "$scan" "$gitleaks" --config="$temp/markers.toml" --exit-code=0 --no-banner \
    --report-format=template --report-template="$temp/fingerprints.tmpl" --report-path="$1"
  LC_ALL=C sort "$1"
}

mkdir "$temp/repo"
cd "$temp/repo"
git init -q -b main
printf 'base\n' > conflict.txt
printf 'base\n' > commitment.txt
ln -s README link.cfg
commit_file README fixture base
commit_file control.txt marker-control control
control=$(git rev-parse HEAD)
# A symlink turned into a regular file: a type change.
rm link.cfg
commit_file link.cfg marker-typechange "type change"
typechange=$(git rev-parse HEAD)
# A path that .gitattributes marks as binary.
printf 'notes.cfg -diff\n' > .gitattributes
commit_file notes.cfg marker-attributes attributes
attributes=$(git rev-parse HEAD)
# A conflict whose resolution adds a line neither parent has.
git checkout -q -b side
commit_file conflict.txt side side
git checkout -q main
commit_file conflict.txt main main
! git merge -q side > /dev/null 2>&1
commit_file conflict.txt marker-conflict "resolve conflict"
conflict=$(git rev-parse HEAD)
# A merge without conflicts that also adds a file.
git checkout -q -b side2
commit_file side2.txt side2 side2
git checkout -q main
commit_file main2.txt main2 main2
git merge -q --no-ff --no-commit side2 > /dev/null 2>&1
commit_file merged.txt marker-merge "merge side2"
merge=$(git rev-parse HEAD)
# A conflict in a path containing "commit". Without secret-scan.sh's git, Gitleaks 8.30.1 reads
# git's `remerge CONFLICT` line for it as a new commit, and drops the merge's commit from that
# file's fingerprint and from every later file of the merge.
git checkout -q -b side3
commit_file commitment.txt side3 side3
git checkout -q main
commit_file commitment.txt main3 main3
! git merge -q side3 > /dev/null 2>&1
printf 'marker-later\n' > later.txt
commit_file commitment.txt marker-no-commit "resolve commitment"
commitment=$(git rev-parse HEAD)
# shellcheck disable=SC2086
git log -p -U0 $LOG_OPTS > "$temp/log"
if ! grep -q '^remerge CONFLICT .*commitment\.txt' "$temp/log"; then
  echo "self-test: git no longer shows the remerge CONFLICT line this case needs" >&2
  exit 1
fi
# git orders a patch's files by path, so later.txt follows the conflicted file in the merge's.
if ! sed -n '/^remerge CONFLICT .*commitment\.txt/,/^commit /p' "$temp/log" | grep -q '^diff --git a/later\.txt '; then
  echo "self-test: git no longer shows later.txt after the conflicted file in the merge's patch" >&2
  exit 1
fi
# Every case but the control is one that Gitleaks' default options would miss.
git log -p -U0 --full-history --all --diff-filter=tuxdb > "$temp/default.log"
if [ "$(grep -o '^+marker-[a-z-]*' "$temp/default.log" | LC_ALL=C sort -u | tr '\n' ' ')" != "+marker-control " ]; then
  echo "self-test: Gitleaks' default options see more than the control case" >&2
  exit 1
fi
# A commit that only a pull request ref reaches, as GitHub serves refs/pull/<number>/head.
git checkout -q -b pull
commit_file pull.txt marker-pull-request "pull request"
pull=$(git rev-parse HEAD)
git update-ref refs/pull/7/head HEAD
git checkout -q main
git branch -q -D pull side side2 side3

{
  echo "$control:control.txt:marker:1"
  echo "$typechange:link.cfg:marker:1"
  echo "$attributes:notes.cfg:marker:1"
  echo "$conflict:conflict.txt:marker:1"
  echo "$merge:merged.txt:marker:1"
  echo "$commitment:commitment.txt:marker:1"
  echo "$commitment:later.txt:marker:1"
  if [ "$pull_requests" = true ]; then echo "$pull:pull.txt:marker:1"; fi
} | LC_ALL=C sort > "$temp/expected"
fingerprints "$temp/found" > "$temp/found.sorted"
if ! diff -u "$temp/expected" "$temp/found.sorted"; then
  echo "self-test: Gitleaks did not report exactly the expected fingerprints (- expected, + found)" >&2
  exit 1
fi

# An octopus merge that adds a file: the scan must refuse it, since Gitleaks can't see the file.
mkdir "$temp/octopus"
cd "$temp/octopus"
git init -q -b main
commit_file README fixture base
for branch in o1 o2 o3; do
  git checkout -q -b "$branch" main
  commit_file "$branch.txt" "$branch" "$branch"
done
git checkout -q main
git merge -q --no-commit o1 o2 o3 > /dev/null 2>&1
commit_file octopus.txt marker-octopus octopus
if fingerprints "$temp/octopus-found" > /dev/null 2>&1 || [ -e "$temp/octopus-found" ]; then
  echo "self-test: the scan did not refuse an octopus merge before running Gitleaks" >&2
  exit 1
fi

# A conflict in a path containing a newline, and a later file: the scan must refuse it, and name
# the merge, since git's remerge line for that path can pass for a header line Gitleaks reads.
mkdir "$temp/newline"
cd "$temp/newline"
git init -q -b main
newline_path=$'nl\ncommit.txt'
printf 'base\n' > "$newline_path"
commit_file README fixture base
git checkout -q -b side
commit_file "$newline_path" side side
git checkout -q main
commit_file "$newline_path" main main
! git merge -q side > /dev/null 2>&1
printf 'marker-newline\n' > z-later.txt
commit_file "$newline_path" resolved "resolve newline"
newline=$(git rev-parse HEAD)
if fingerprints "$temp/newline-found" > /dev/null 2> "$temp/newline.err" || [ -e "$temp/newline-found" ] ||
  ! grep -qx "$newline" "$temp/newline.err"; then
  echo "self-test: the scan did not refuse a path containing a newline before running Gitleaks" >&2
  exit 1
fi

# Backslashes cannot round-trip through the pinned ignore loader. Refuse both an
# interior and a trailing backslash, even when the slash counterpart also exists.
for control_path in 'ordinary\name.txt' 'hidden\'; do
  mkdir "$temp/backslash-${#control_path}"
  cd "$temp/backslash-${#control_path}"
  git init -q -b main
  mkdir ordinary
  printf 'marker-unreviewed\n' > ordinary/name.txt
  commit_file "$control_path" marker-backslash backslash
  backslash=$(git rev-parse HEAD)
  printf '%s\n' "$backslash:$control_path:marker:1" > .gitleaksignore
  rm -f "$temp/backslash-found"
  if fingerprints "$temp/backslash-found" > /dev/null 2> "$temp/backslash.err" || [ -e "$temp/backslash-found" ] ||
    ! grep -qx "$backslash" "$temp/backslash.err"; then
    echo "self-test: the scan did not refuse a path containing a backslash before running Gitleaks" >&2
    exit 1
  fi
done

# Distinct invalid filename bytes would collapse to the same JSON fingerprint.
mkdir "$temp/invalid-utf8"
cd "$temp/invalid-utf8"
git init -q -b main
printf 'marker-invalid\n' > $'bad-\xff.txt'
commit_file $'bad-\xfe.txt' marker-invalid "invalid UTF-8"
invalid=$(git rev-parse HEAD)
if fingerprints "$temp/invalid-found" > /dev/null 2> "$temp/invalid.err" || [ -e "$temp/invalid-found" ] ||
  ! grep -qx "$invalid" "$temp/invalid.err"; then
  echo "self-test: the scan did not refuse an invalid UTF-8 path before running Gitleaks" >&2
  exit 1
fi

echo "Secret scan self-test passed: $(grep -c '' "$temp/expected") fingerprints as expected; an octopus merge, paths containing a newline or a backslash and invalid UTF-8 paths are refused."
