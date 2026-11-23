#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, readArchive } from './delta-assemble.mjs';
import { isAnchored, isCorePath, isRecordNamed, isUnrecordedRepositoryPath, readAnchor, recordName, selects } from './delta-record.mjs';
import { checkRecordFiles } from './delta-freeze.mjs';
import { publicationJson, publicationText } from './publication-text.mjs';
import { sourceGit } from './source-git.mjs';
export const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const pkg = join(root, 'packages/dacs-client');
export const prefix = 'packages/dacs-client/';
export const PUBLICATION_HEAD = 'aac03055bdbeabc7c0771642d99f0c4baf7e3de9';
export const BASELINE = '5c7d5e066eed8ebf9b9744b7a44e6cee72abe7f1';
export const HISTORY_SHA256 = '4170f296835330141c4eff81bd548468f16fd1dde0000cc83ccbe6f67d3c9a00';
const gitIn = (repo, args, options = {}) => sourceGit(['-C', repo, ...args], {encoding:'utf8', maxBuffer:1<<28, stdio:['ignore','pipe','pipe'], ...options}).trimEnd();
export const git = (...args) => gitIn(root, args);
// The checks below read many commits and blobs. Each read is one Git run for
// the whole range (or one list of lookups) with the answers kept in a Map for
// that check only; nothing is kept between runs.
/**
 * Reads the commits of `base..HEAD` of `repo` with one `git log`. Returns a Map
 * from commit to {parents, files}: `files` is what `git diff --no-renames
 * --name-only <parent> <commit>` lists (empty for a merge). With `paths`, only
 * the commits that touch those paths are returned, each with just those paths;
 * the others are left out. Throws when Git fails.
 */
export function readHistory(repo = root, base = BASELINE, paths = []) {
  const history = new Map();
  let entry = null;
  for (const line of gitIn(repo, ['log', '--no-show-signature', '--no-renames', '--name-only', '--format=%x00%H %P', `${base}..HEAD`, ...(paths.length ? ['--full-history', '--', ...paths] : [])]).split('\n')) {
    if (line.startsWith('\0')) { const [sha, ...parents] = line.slice(1).split(' '); entry = { parents: parents.filter(Boolean), files: [] }; history.set(sha, entry); }
    else if (line !== '') entry.files.push(line);
  }
  return history;
}
/** The commits `git rev-list <range>` names, as a Set. Throws when Git fails. */
export const commitsIn = (range, repo = root) => new Set(gitIn(repo, ['rev-list', range]).split('\n').filter(Boolean));
// Commits of `history` reachable from `starts`, the starts included.
function reachable(history, starts) {
  const seen = new Set(), stack = [...starts];
  while (stack.length) {
    const sha = stack.pop();
    if (seen.has(sha) || !history.has(sha)) continue;
    seen.add(sha); stack.push(...history.get(sha).parents);
  }
  return seen;
}
/** The commits `git rev-list <base>..<sha>^` names: `sha`'s first parent and everything below it, inside the range. */
export const ancestorsIn = (history, sha) => reachable(history, history.get(sha).parents.slice(0, 1));
/** What `git merge-base --independent <shas>` prints: the listed commits that no other listed commit descends from, in the given order. */
export function independentIn(history, shas) {
  // Each commit's ancestors are walked once and kept on its history entry, so many calls over the same commits stay cheap.
  const below = shas.map(sha => (history.get(sha).below ??= reachable(history, history.get(sha).parents)));
  return shas.filter(sha => !below.some(ancestors => ancestors.has(sha)));
}
/**
 * Looks up `<commit>:<path>` specs with one `git cat-file --batch-check`.
 * Returns a Map from each spec to its object id, or null where Git has no such
 * object (where `git rev-parse --verify` fails). A spec with a newline or a
 * carriage return cannot ride the line protocol (which drops a trailing `\r`)
 * and is asked on its own.
 */
export function blobIds(specs, repo = root) {
  const alone = spec => /[\r\n]/.test(spec);
  const ids = new Map(), listed = [...new Set(specs)].filter(spec => !alone(spec));
  const answers = listed.length ? gitIn(repo, ['cat-file', '--batch-check=%(objectname)'], { input: `${listed.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'] }).split('\n') : [];
  listed.forEach((spec, at) => ids.set(spec, /^[0-9a-f]{40}$/.test(answers[at]) ? answers[at] : null));
  for (const spec of specs) if (alone(spec)) ids.set(spec, (() => { try { return gitIn(repo, ['rev-parse', '--verify', spec]); } catch { return null; } })());
  return ids;
}
export const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export const localBlob = path => existsSync(join(root,path)) ? blob(readFileSync(join(root,path))) : null;
// Coordinates come from Git's baseline-to-current hunks. Metadata starts at
// line 1; deleted paths have no current coordinate. Avoid self-referential
// generated-document hunks while locating every changed source/test range.
export function locations(path) {
  if (!/^packages\/dacs-client\/(?:src|test)\//.test(path)) return `\`${path}:1\``;
  if (!existsSync(join(root, path))) return `\`${path}\` (deleted)`;
  const diff = git('diff', '--no-renames', '--unified=0', BASELINE, '--', path);
  const starts = [...new Set([...diff.matchAll(/^@@ -[0-9,]+ \+(\d+)(?:,\d+)? @@/gm)].map(m => Math.max(1, Number(m[1]))))];
  return (starts.length ? starts : [1]).map(line => `\`${path}:${line}\``).join(', ');
}
// Every reachable non-merge commit is audited, including commits reached only
// through a merge's later parents. A record with a full `sha` selects that
// commit, whose subject must still match; a record without one selects by exact
// subject, which must then resolve once. Two commits that share a subject can
// therefore only be recorded with SHA-qualified selectors.
export function commits() {
  return git('log','--no-merges','--reverse','--format=%H%x09%s',BASELINE+'..HEAD').split('\n').filter(Boolean).map(row => { const at=row.indexOf('\t'); return {sha:row.slice(0,at),subject:row.slice(at+1)}; });
}
// The archive followed by the record files: {ledger, commits, failures}.
export const view = () => assemble(pkg);
export const ledger = () => view().ledger;
export { selects };
export const recordFor = (records, commit) => records.find(r => r.sha === commit.sha && r.subject === commit.subject) ?? records.find(r => r.sha == null && r.subject === commit.subject);
export function table({ ledger: data, commits: inventory } = view()) {
  const files=JSON.parse(readFileSync(join(pkg,'PROVENANCE.json'),'utf8')).files;
  const coordinates = new Map();
  const locate = path => { if (!coordinates.has(path)) coordinates.set(path, locations(path)); return coordinates.get(path); };
  const lines=['<!-- generated by scripts/delta-map.mjs; do not edit -->', readFileSync(join(pkg,'DELTA-NOTES.md'),'utf8').trim(), '', '## Commit register', '', '| Delta | Exact commit subject | Resolved commit |', '|---|---|---|'];
  for(const change of data.changes) {
    lines.push(`| ${change.delta} | ${change.subject} | ${change.sha==null?'Git subject selector (must resolve exactly once after publication checkpoint)':`Git commit selector ${change.sha}`} |`);
    if(change.compact) lines.push(`| | ${change.files.map(f=>`${locate(f.path)}: ${f.after??'deleted'}`).join('<br>')} | |`);
    else for(const f of change.files) lines.push(`| | ${locate(f.path)} | ${f.after===null?'deleted':f.after} |`);
  }
  lines.push('', '## Complete commit and file inventory', '', 'Full hashes below bind completed commits. Unhashed record commits use unique exact subjects to avoid self-referential hashes. Source/test coordinates are generated from baseline-to-current Git hunks, so they name changed ranges at the current head; metadata starts at line 1 and deletions are explicit. The delta sections explain the reason for each group.', '', '| Commit / exact selector | Touched file:line |', '|---|---|');
  for(const c of inventory) {
    if(c.compact) lines.push(`| ${c.sha??c.subject} | ${c.files.map(locate).join('<br>')} |`);
    else for(const path of c.files) lines.push(`| ${c.sha??c.subject} | ${locate(path)} |`);
  }
  lines.push('', '## Record notes', '', ...inventory.filter(row => row.note).map(row => `- ${row.subject}: ${row.note}`));
  lines.push('', '## Original moved files', '', '| Destination | Source path | Blob at publication checkpoint | Status | Current blob |', '|---|---|---|---|---|');
  const publishedBlobs=blobIds(files.map(f=>`${BASELINE}:${f.path}`));
  for(const f of files) {
    const changes=data.changes.filter(c=>c.files.some(x=>x.path===f.path));
    const current=localBlob(f.path);
    const source=publishedBlobs.get(`${BASELINE}:${f.path}`)??'deleted before publication';
    lines.push(`| \`${f.path}\` | \`${f.sourcePath}\` | ${source} | ${changes.length?`${current?'changed':'deleted'} by ${[...new Set(changes.map(c=>c.delta))].join(', ')}`:'unchanged'} | ${current??'deleted'} |`);
  }
  return publicationText(lines.join('\n')+'\n');
}
// The blob a recorded path must hold comes from the commit graph, not ledger
// order. `records` are the path's resolved records ({sha, after}); within one
// commit the last one counts. `independent(shas)` returns the commits that no
// other listed commit descends from (git merge-base --independent). Returns
// {blob} when those newest records agree, or {conflict: shas} when parallel
// branches recorded different blobs and no later record chose one.
export function expectedBlob(records, independent) {
  const latest=new Map(records.map(r=>[r.sha,r.after]));
  const newest=latest.size>1?independent([...latest.keys()]):[...latest.keys()];
  const blobs=new Set(newest.map(sha=>latest.get(sha)));
  return blobs.size===1?{blob:[...blobs][0]}:{conflict:newest};
}
const blobAt=(rev,path)=>{try{return git('rev-parse','--verify',`${rev}:${path}`);}catch{return null;}};
const describeBlob=sha=>sha??'no file';
/**
 * The last-entry rule for a trailing record-only entry (one that changes no
 * source or test blob itself). The last entry of `ledger.changes` counts as a
 * real change only if it names a source or test path, selects one commit, and,
 * for every path it records, the recorded blob is the blob committed at that
 * commit and no earlier entry recorded it for that path. The blob at the entry's
 * own commit never changes, so a later recorded change to the path does not
 * affect the answer. `archive` is the ledger file; `combined` is the ledger the
 * gates read (the file followed by the `records/` files). Earlier entries are
 * the other entries of the ledger file, `supersededChanges` included, in any
 * order, and the entries of the `records/` files whose commit comes before the
 * trailing entry's commit; a record file committed after it never counts. When
 * no earlier entry names the path, the baseline blob counts as recorded.
 * Returns the failures, each naming its path; none means the entry counts.
 */
export function lastRecordOnlyFailures(archive=readArchive(pkg).ledger, combined=view().ledger) {
  const last=archive.changes.at(-1);
  if(!last?.files.some(file=>/^packages\/dacs-client\/(src|test)\//.test(file.path))) return [`${prefix}DELTA-LEDGER.json: last record names no source or test change`];
  const history=commits(), selected=history.filter(commit=>selects(last,commit));
  if(selected.length!==1) return [`${prefix}DELTA-LEDGER.json: the last record-only entry selects ${selected.length} commits, not one`];
  // Record files follow the ledger file's entries in the combined view; only those committed before the trailing entry count.
  const below=commitsIn(`${BASELINE}..${selected[0].sha}^`), superseded=archive.supersededChanges??[];
  const fromFiles=[...(combined.supersededChanges??[]).slice(superseded.length),...combined.changes.slice(archive.changes.length)];
  const earlier=[...superseded,...archive.changes.slice(0,-1),...fromFiles.filter(change=>history.some(commit=>selects(change,commit)&&below.has(commit.sha)))];
  const failures=[];
  for(const {path,after} of last.files) {
    const committed=blobAt(selected[0].sha,path);
    if(after!==committed) failures.push(`${path}: the last record-only entry records ${describeBlob(after)}, but its commit holds ${describeBlob(committed)}`);
    const named=earlier.flatMap(change=>change.files.filter(file=>file.path===path));
    const recorded=named.length?named.map(file=>file.after):[blobAt(BASELINE,path)];
    if(recorded.includes(after)) failures.push(`${path}: the last record-only entry restates ${describeBlob(after)}, a blob already recorded for it; it records nothing new`);
  }
  return failures;
}
export function checkDeltas(packageDir=pkg) {
  const assembled=view(); const failures=[...assembled.failures]; const active=assembled.ledger; const data={...active,changes:[...(active.supersededChanges??[]),...active.changes]}; const history=commits();
  // Record-named paths outside src/ and test/ start from the anchor, not the
  // baseline: its blob is their first expected blob, their records select
  // commits after it, and their changes are checked from it on.
  const anchor=readAnchor(pkg), anchored=path=>isAnchored(path.slice(prefix.length)), afterAnchor=new Set(git('rev-list',`${anchor.commit}..HEAD`).split('\n'));
  const core=path=>isCorePath(path.slice(prefix.length));
  // The shared repository-relative predicate exempts only the package README,
  // including when an anchor or record names it.
  const covered=(path,sha)=>!core(path)&&!isUnrecordedRepositoryPath(path)&&(/^packages\/dacs-client\/(src|test)\//.test(path)||(anchored(path)&&(sha==null||afterAnchor.has(sha))));
  // Records are checked one by one by their schema; this rule binds the archive.
  const last=readArchive(pkg).ledger.changes.at(-1);
  if(last && !last.files.some(file=>/^packages\/dacs-client\/(src|test)\//.test(file.path))) failures.push(`${prefix}DELTA-LEDGER.json: last record names no source or test change`);
  const archived=readFileSync(join(pkg,'evidence/publication-history.json'));
  if(createHash('sha256').update(archived).digest('hex')!==HISTORY_SHA256) failures.push('archived source/delta evidence digest differs');
  const evidence=JSON.parse(archived);
  // Every Git read below is planned here: one log for each commit's paths, a second limited to src/ and test/ (so
  // Git's own path matching and quoting apply), and one lookup list for every blob a record or the baseline names.
  const graph=readHistory(), sourceChanges=readHistory(root,BASELINE,[prefix+'src',prefix+'test']);
  const matched=new Map(data.changes.map(c=>[c,history.filter(h=>selects(c,h))]));
  const originals=JSON.parse(readFileSync(join(pkg,'PROVENANCE.json'),'utf8')).files.map(f=>f.path);
  const allowed=new Set([...originals,...evidence.deltas.changes.flatMap(c=>c.files.map(f=>f.path)),...data.changes.flatMap(c=>c.files.map(f=>f.path)),...Object.keys(anchor.files)]);
  const planned=[...allowed].map(path=>`${BASELINE}:${path}`);
  for(const path of Object.keys(anchor.files)) planned.push(`${anchor.commit}:${path}`);
  for(const [c,commitsSelected] of matched) if(commitsSelected.length===1) for(const f of c.files) planned.push(`${commitsSelected[0].sha}^:${f.path}`,`${commitsSelected[0].sha}:${f.path}`);
  const looked=blobIds(planned);
  const blobAt=spec=>{ if(!looked.has(spec)) throw new Error(`blob lookup was not planned: ${spec}`); return looked.get(spec); };
  for(const [name,key] of [['PROVENANCE.json','sourceManifest'],['DELTA-LEDGER.json','deltas'],['DELTA-COMMITS.json','commits']]) {
    const shipped=JSON.parse(git('show',`${BASELINE}:${prefix}${name}`));
    if(JSON.stringify(shipped)!==JSON.stringify(evidence[key])) failures.push(`${name}: archived evidence differs from immutable publication`);
  }
  const historical=new Map();
  for(const change of evidence.deltas.changes) for(const file of change.files) {
    if(historical.has(file.path)&&historical.get(file.path)!==file.before) failures.push(`${file.path}: archived delta chain is discontinuous`);
    historical.set(file.path,file.after);
  }
  for(const [path,want] of historical) {
    if(blobAt(`${BASELINE}:${path}`)!==want) failures.push(`${path}: archived delta terminal differs from immutable publication`);
  }
  if(JSON.stringify(evidence.sourceManifest)!==JSON.stringify(JSON.parse(readFileSync(join(pkg,'PROVENANCE.json'))))) failures.push('source manifest differs from archived source/delta evidence');
  if(data.schema!=='dacs-client-deltas/v2'||data.baseline!==BASELINE) failures.push('delta ledger baseline/schema changed');
  for(const [path,want] of Object.entries(anchor.files)) {
    if(!isUnrecordedRepositoryPath(path)&&blobAt(`${anchor.commit}:${path}`)!==want) failures.push(`${path}: the anchor blob differs from the file at the anchor commit`);
  }
  const selectors=new Map(), recorded=new Map(), skipped=[];
  for(const c of data.changes) {
    if(c.sha!=null&&!/^[0-9a-f]{40}$/.test(c.sha)) failures.push(`delta commit selector sha is not a full commit hash: ${c.subject}`);
    const same=selectors.get(c.subject)??[];
    if(same.some(sha=>sha==null||c.sha==null||sha===c.sha)) failures.push(`duplicate delta subject ${c.subject}`);
    selectors.set(c.subject,[...same,c.sha]);
    // A record that names its full commit hash needs no delta prefix in the subject: the hash already selects the commit.
    if(!(c.subject.startsWith(`delta(client): ${c.delta} `)||c.sha!=null||(c.delta==='D11'&&c.subject.startsWith('fix(client): D11 ')))) failures.push(`invalid delta ${c.subject}`);
    const matches=matched.get(c);
    if(matches.length!==1) failures.push(`delta commit selector must resolve once: ${c.sha==null?c.subject:`${c.sha} ${c.subject}`}`);
    if(matches.length===1) {
      const sha=matches[0].sha;
      for(const f of c.files) {
        if(core(f.path)||isUnrecordedRepositoryPath(f.path)) continue;
        // The anchor already holds the result of a commit it contains, so such a record does not enter the chain.
        if(anchored(f.path)&&!afterAnchor.has(sha)) skipped.push(`${f.path}: delta ${c.delta} ${sha} is contained in the anchor; skipped`);
        else recorded.set(f.path,[...(recorded.get(f.path)??[]),{sha,before:f.before,after:f.after}]);
        for(const [rev,want] of [[`${sha}^`,f.before],[sha,f.after]]) {
          if(blobAt(`${rev}:${f.path}`)!==want) failures.push(`${f.path}: delta ${c.delta} blob differs at ${rev}`);
        }
      }
    }
  }
  // A merge can already have discarded a reviewed blob before the next
  // record. Check every record against its ancestors, not just its actual
  // parent or the terminal blob. Resolve all records first: ledger order and
  // unrelated sibling records must not determine continuity.
  const independent=shas=>independentIn(graph,shas);
  const inSourceTree=path=>path.startsWith(prefix+'src/')||path.startsWith(prefix+'test/');
  const ancestors=new Map();
  for(const [path,records] of recorded) {
    if(core(path)) continue;
    const baseline=anchored(path)?anchor.files[path]??null:blobAt(`${BASELINE}:${path}`);
    for(const {sha,before} of records) {
      if(!ancestors.has(sha)) ancestors.set(sha,ancestorsIn(graph,sha));
      const previous=records.filter(record=>ancestors.get(sha).has(record.sha));
      // Source/test paths start from the publication baseline; anchored record-named paths start from the anchor. The package README is omitted from `recordedBlobs`, although the anchor names it.
      const parent=blobAt(`${sha}^:${path}`);
      const expected=previous.length?expectedBlob(previous,independent):{blob:inSourceTree(path)||anchored(path)?baseline:parent};
      // Divergent newest ancestors require an explicit resolution record.
      // Its actual parent/commit bytes are checked above; once recorded,
      // that resolution constrains every descendant in turn.
      if(!expected.conflict&&before!==expected.blob) failures.push(`${path}: delta parent is discontinuous at ${sha}`);
    }
  }
  const inventory=[...(data.supersededCommits??[]),...assembled.commits];
  // Each row selects at most one reachable commit, and no commit is selected by
  // two rows; a hashed row must name a reachable commit with its exact subject.
  const reachable=new Map(history.map(h=>[h.sha,h.subject])), selected=new Map();
  for(const c of inventory) {
    if(c.sha!=null&&!reachable.has(c.sha)) failures.push(`commit inventory names an unreachable commit ${c.sha}`);
    else if(c.sha!=null&&reachable.get(c.sha)!==c.subject) failures.push(`commit inventory subject differs from commit ${c.sha}: ${c.subject}`);
    const hits=c.sha==null?history.filter(h=>h.subject===c.subject):history.filter(h=>h.sha===c.sha&&h.subject===c.subject);
    if(c.sha==null&&hits.length>1) failures.push(`commit inventory selector must resolve once: ${c.subject}`);
    if(hits.length===1) { if(selected.has(hits[0].sha)) failures.push(`commit inventory selects ${hits[0].sha} more than once`); selected.set(hits[0].sha,c); }
  }
  // A commit is published when the publication head descends from it; with no such head none is.
  let publishedCommits=new Set();try{publishedCommits=commitsIn(`${BASELINE}..${PUBLICATION_HEAD}`);}catch{}
  for(const h of history) {
    const item=recordFor(inventory,h);
    if(!graph.get(h.sha).parents.length) throw new Error(`commit ${h.sha} has no parent to compare with`);
    // The exact package README is left out of both sides; a change to another README still needs an accurate row.
    const files=graph.get(h.sha).files.filter(path=>!isUnrecordedRepositoryPath(path)).sort();
    // The published inventory remains auditable. Later unrelated SDK work
    // does not require a client control update; merges are excluded above.
    const published=publishedCommits.has(h.sha);
    if(!published&&!files.some(path=>path.startsWith(prefix))&&!item)continue;
    if(!item || (item.sha!==null && item.sha!==h.sha) || JSON.stringify(item.files.filter(path=>!isUnrecordedRepositoryPath(path)).sort())!==JSON.stringify(files)) failures.push(`complete commit/file inventory differs for ${h.sha}`);
  }
  for(const h of history) {
    // Source and test changes come from the path-limited log; changes to a path the anchor names, after the anchor, from the full one.
    const changed=[...(sourceChanges.get(h.sha)?.files??[]).filter(path=>!core(path)),...graph.get(h.sha).files.filter(path=>path.startsWith(prefix)&&anchored(path)&&covered(path,h.sha))];
    const record=recordFor(data.changes,h);
    for(const path of changed) if(!record?.files.some(f=>f.path===path)) failures.push(`${path}: unenumerated change in ${h.sha}`);
  }
  // A staged edit remains a change even when its working file is restored.
  // Compare object identities directly, including deletions and mode changes.
  const indexRows=git('ls-files','--stage','--',prefix).split('\n').filter(Boolean);
  const headRows=git('ls-tree','-r','HEAD','--',prefix).split('\n').filter(Boolean);
  const staged=new Map(indexRows.map(row=>{const [meta,path]=row.split('\t');const [mode,hash,stage]=meta.split(' ');return [path,{mode,hash,stage}];}));
  const committed=new Map(headRows.map(row=>{const [meta,path]=row.split('\t');const [mode,,hash]=meta.split(' ');return [path,{mode,hash}];}));
  for(const path of new Set([...committed.keys(),...staged.keys()])){
    const a=staged.get(path),b=committed.get(path);
    if(covered(path)&&(!a||!b||a.stage!=='0'||a.mode!==b.mode||a.hash!==b.hash))failures.push(`${path}: index differs from HEAD for ${anchored(path)?'a record-named file':'moved source/test'}`);
  }
  // Merges are not record subjects, so HEAD, the index and the working bytes
  // must all hold the newest recorded blob; a merge that keeps a stale side,
  // rolls back or deletes a recorded file fails here.
  for(const path of allowed) {
    if(core(path)||isUnrecordedRepositoryPath(path)) continue;
    let expected;
    if(recorded.has(path)) {
      const result=expectedBlob(recorded.get(path),independent);
      if(result.conflict) { failures.push(`${path}: newest records disagree (${result.conflict.join(', ')}); record the chosen blob after the merge`); continue; }
      expected=result.blob;
    } else expected=anchored(path)?anchor.files[path]??null:blobAt(`${BASELINE}:${path}`);
    const rel=path.slice(prefix.length); const local=join(packageDir,rel);
    const actual=existsSync(local)?blob(readFileSync(local)):null;
    const head=committed.get(path)?.hash??null, index=staged.get(path)?.hash??null;
    if(actual!==expected||head!==expected||index!==expected) failures.push(`${path}: current blob differs from enumerated deltas`);
  }
  failures.push(...checkRecordFiles(root, packageDir));
  return {failures,allowed,skipped};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='--record') {
    const [delta,...words]=process.argv.slice(3), subject=words.join(' ');
    const changed=git('diff','--cached','--no-renames','--name-only').split('\n').filter(Boolean);
    const files=changed.filter(path=>path.startsWith(prefix)&&isRecordNamed(path.slice(prefix.length))&&!isUnrecordedRepositoryPath(path)).map(path=>{
      let before=null;try{before=git('rev-parse','--verify',`HEAD:${path}`);}catch{}
      const entry=git('ls-files','--stage','--',path);
      return {path,before,after:entry?entry.split(' ')[1]:null};
    });
    const record={schema:'dacs-client-delta-record/v1',delta,subject,kind:files.length?'change':'commit-only',...(files.length?{files}:{}),commitFiles:[]};
    const name=`records/${recordName(record)}`;
    if(existsSync(join(pkg,name)))throw new Error(`${name}: record already exists`);
    record.commitFiles=[...new Set([...changed,prefix+name])].sort();
    mkdirSync(join(pkg,'records'),{recursive:true});
    writeFileSync(join(pkg,name),publicationJson(record));
  } else if(process.argv.length===2) process.stdout.write(table());
  else throw new Error('usage: delta-map.mjs [--record <id> <exact subject>]');
}
