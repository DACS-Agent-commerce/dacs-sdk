// The freeze rule derived from the delta records. Every package file is exactly
// one of:
//   - a core path (delta-record.mjs), which needs an exact pin in HOLD.json;
//   - a record file, added once by a commit after the baseline and never
//     changed or deleted afterwards;
//   - a record-named path whose HEAD, index and working blob equal its
//     expected blob: the after-blob of its newest records by the commit graph
//     (parallel records of different blobs conflict until a later record
//     chooses one), else its blob at the anchor (records/ANCHOR.json) for
//     anchored paths, else its baseline blob. No expected blob means the path
//     must not exist. A record of an anchored path that selects a commit the
//     anchor already contains is left out of the chain; the first record that
//     selects a commit after the anchor (reachable from HEAD but not from the
//     anchor commit) must start from the anchor's blob. A branch cut before
//     the anchor's last change to an anchored file holds an older copy of it;
//     its record cannot start from the anchor, so it is refused until the
//     branch is rebased onto the anchor.
// Anything else is refused. The rule reads the history from the baseline to
// HEAD with one `git rev-list` for the commit graph and one `git log --raw`
// for the commits and their package changes, and fails closed without it.
// The checks that need each commit's own diff stay in delta-map.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble } from './delta-assemble.mjs';
import { BASELINE, blob, expectedBlob } from './delta-map.mjs';
import { isAnchored, isCorePath, isRecordFile, isRecordNamed, PACKAGE_PREFIX, readAnchor, selects } from './delta-record.mjs';
import { sourceGit } from './source-git.mjs';

const MAX_GIT_OUTPUT = 1 << 28;

// {parents, order, commits} for BASELINE..HEAD, or null when the checkout is
// shallow or HEAD does not descend from the baseline. `order` numbers every
// commit parents first; `commits` are the non-merge commits in that order as
// {sha, subject, changes: [{path, after, status}]}, with package paths only.
function readHistory(repoRoot) {
  const git = (...args) => sourceGit(['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') return null;
    git('merge-base', '--is-ancestor', BASELINE, 'HEAD');
  } catch { return null; }
  const parents = new Map(), order = new Map();
  for (const line of git('rev-list', '--parents', '--topo-order', '--reverse', `${BASELINE}..HEAD`).split('\n').filter(Boolean)) {
    const [sha, ...rest] = line.split(' ');
    order.set(sha, order.size);
    parents.set(sha, rest);
  }
  const log = git('log', '--no-merges', '--raw', '--no-renames', '--no-abbrev', '--topo-order', '--reverse', `--relative=${PACKAGE_PREFIX}`, '--format=%x00%H%x09%s', `${BASELINE}..HEAD`);
  const commits = log.split('\0').filter(Boolean).map(chunk => {
    const [head, ...rows] = chunk.split('\n');
    const tab = head.indexOf('\t');
    const changes = rows.filter(Boolean).map(row => {
      const [meta, path] = row.split('\t');
      const [, , , after, status] = meta.split(' ');
      return { path: PACKAGE_PREFIX + path, after, status };
    });
    return { sha: head.slice(0, tab), subject: head.slice(tab + 1), changes };
  });
  return { parents, order, commits };
}

// `git merge-base --independent` over the commit graph read above: the listed
// commits that no other listed commit descends from.
const independentIn = ({ parents, order }) => shas => {
  const floor = Math.min(...shas.map(sha => order.get(sha)));
  const older = new Set();
  for (const sha of shas) {
    const stack = [...parents.get(sha)];
    while (stack.length) {
      const next = stack.pop();
      if (older.has(next) || !(order.get(next) >= floor)) continue;
      older.add(next);
      stack.push(...parents.get(next));
    }
  }
  return shas.filter(sha => !older.has(sha));
};

// A test for commits after the anchor: reachable from HEAD, not from the anchor.
function afterAnchorIn({ parents, order }, anchor) {
  const contained = new Set([anchor]), stack = [anchor];
  while (stack.length) for (const parent of parents.get(stack.pop())) {
    if (order.has(parent) && !contained.has(parent)) { contained.add(parent); stack.push(parent); }
  }
  return sha => !contained.has(sha);
}

// Path -> [{sha, after}] from every resolved delta record, superseded ones
// first, then active records in file name order, as delta-map.mjs reads them.
// Ancestry determines the newest blob regardless of that order. An anchored
// path is recorded only after the anchor.
function recordedBlobs(ledger, commits, afterAnchor, failures) {
  const recorded = new Map();
  for (const change of [...(ledger.supersededChanges ?? []), ...ledger.changes]) {
    const hits = commits.filter(commit => selects(change, commit));
    if (hits.length !== 1) { failures.push(`delta commit selector must resolve once: ${change.sha == null ? change.subject : `${change.sha} ${change.subject}`}`); continue; }
    for (const file of change.files) {
      if (isAnchored(file.path.slice(PACKAGE_PREFIX.length)) && !afterAnchor(hits[0].sha)) continue;
      recorded.set(file.path, [...(recorded.get(file.path) ?? []), { sha: hits[0].sha, before: file.before, after: file.after }]);
    }
  }
  return recorded;
}

// An anchored path's first record, the one with no other record of the path
// among its ancestors, must start from the anchor's blob.
function checkAnchorStart({ parents, order }, anchor, recorded, failures) {
  const ancestorsOf = sha => {
    const seen = new Set(), stack = [...parents.get(sha)];
    while (stack.length) {
      const next = stack.pop();
      if (seen.has(next) || !order.has(next)) continue;
      seen.add(next);
      stack.push(...parents.get(next));
    }
    return seen;
  };
  for (const [path, records] of recorded) {
    if (!isAnchored(path.slice(PACKAGE_PREFIX.length))) continue;
    for (const { sha, before } of records) {
      const ancestors = ancestorsOf(sha);
      if (!records.some(other => ancestors.has(other.sha)) && before !== (anchor.files[path] ?? null)) failures.push(`${path}: delta parent is discontinuous at ${sha}`);
    }
  }
}

// Record file path -> the blob it was added with. Any later change, deletion
// or second addition is a failure.
function addedRecordFiles(commits, failures) {
  const added = new Map();
  for (const { sha, changes } of commits) for (const { path, after, status } of changes) {
    if (!isRecordFile(path.slice(PACKAGE_PREFIX.length))) continue;
    if (status === 'A' && !added.has(path)) added.set(path, after);
    else failures.push(`${path}: record file ${status === 'A' ? 'added again' : status === 'D' ? 'deleted' : 'changed'} in ${sha}; a record file is added once and never changed`);
  }
  return added;
}

/**
 * Checks the package against the derived freeze rule. `files` are the
 * package-relative paths on disk, `head` and `index` map repository paths to
 * {blob}, and `pins` is HOLD.json's step1Freeze.files. Returns the failures;
 * an empty list means every package file is where the rule puts it.
 */
export function checkDerivedFreeze({ repoRoot, packageDir, pins, files, head, index }) {
  const history = readHistory(repoRoot);
  if (!history) return [`the derived freeze rule needs the Git history from ${BASELINE} to HEAD; this checkout is shallow or does not contain it`];
  let anchor;
  try { anchor = readAnchor(packageDir); } catch (error) { return [error.message]; }
  if (!history.order.has(anchor.commit)) return [`${PACKAGE_PREFIX}records/ANCHOR.json: anchor commit ${anchor.commit} is not in the history from the baseline to HEAD`];
  const { ledger, failures } = assemble(packageDir);
  const recorded = recordedBlobs(ledger, history.commits, afterAnchorIn(history, anchor.commit), failures);
  checkAnchorStart(history, anchor, recorded, failures);
  const added = addedRecordFiles(history.commits, failures);
  const baseline = new Map(sourceGit(['-C', repoRoot, 'ls-tree', '-r', BASELINE, '--', `${PACKAGE_PREFIX}src`, `${PACKAGE_PREFIX}test`], { encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT })
    .split('\n').filter(Boolean).map(row => { const [meta, path] = row.split('\t'); return [path, meta.split(' ')[2]]; }));
  const independent = independentIn(history);
  // {blob, from} or {conflict} for a record-named path.
  const expected = (path, rel) => {
    if (recorded.has(path)) return { ...expectedBlob(recorded.get(path), independent), from: 'its newest record' };
    return isAnchored(rel) ? { blob: anchor.files[path] ?? null, from: 'the anchor' } : { blob: baseline.get(path) ?? null, from: 'the baseline' };
  };
  const paths = new Set([...[...files].map(rel => PACKAGE_PREFIX + rel), ...head.keys(), ...index.keys(), ...baseline.keys(), ...Object.keys(anchor.files), ...recorded.keys(), ...added.keys()]);
  for (const path of [...paths].sort()) {
    const rel = path.slice(PACKAGE_PREFIX.length), present = files.has(rel) || head.has(path) || index.has(path);
    let want;
    if (isCorePath(rel)) { if (present && !pins[rel]) failures.push(`${path}: core path without an exact pin`); continue; }
    if (isRecordFile(rel)) {
      if (!added.has(path)) { if (present) failures.push(`${path}: record file not added by a commit after the baseline`); continue; }
      want = { blob: added.get(path), from: 'the blob it was added with' };
    } else if (isRecordNamed(rel)) want = expected(path, rel);
    else { if (present) failures.push(`${path}: not a core path, a record file or a record-named path`); continue; }
    if (want.conflict) { failures.push(`${path}: newest records disagree (${want.conflict.join(', ')}); record the chosen blob after the merge`); continue; }
    const sides = [['HEAD', head.get(path)?.blob], ['index', index.get(path)?.blob], ['working file', files.has(rel) ? blob(readFileSync(join(packageDir, rel))) : null]];
    const differ = sides.filter(([, actual]) => (actual ?? null) !== want.blob).map(([side]) => side);
    if (differ.length) failures.push(`${path}: ${differ.join(', ')} ${differ.length === 1 ? 'differs' : 'differ'} from ${want.from} (${want.blob ?? 'no file'})`);
  }
  return failures;
}
