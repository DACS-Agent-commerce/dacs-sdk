import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isCorePath, recordName } from './delta-record.mjs';
import { assemble } from './delta-assemble.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'../../..');
function scratch(t){const dir=mkdtempSync(join(tmpdir(),'delta-provenance-'));execFileSync('git',['clone','--quiet','--shared',root,dir]);t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function check(dir){const result=spawnSync(process.execPath,[join(dir,'packages/dacs-client/scripts/check-provenance.mjs'),'--local-only'],{encoding:'utf8'});return {status:result.status,text:result.stdout+result.stderr};}
// The archive is a core pin: check-hold refuses any edit of the ledger.
function refusedByArchivePin(dir){const result=spawnSync(process.execPath,[join(dir,'packages/dacs-client/scripts/check-hold.mjs')],{encoding:'utf8'});assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/^FAIL packages\/dacs-client\/DELTA-LEDGER\.json: changed bytes; package is frozen$/m);}
const moved='packages/dacs-client/src/dacs/buyer-chain-readback.mjs';
test('committed delta history and immutable record files agree',t=>{const r=check(scratch(t));assert.equal(r.status,0,r.text);});
function checkCallbackHistory(dir) {
  const pkg = join(dir, 'packages/dacs-client');
  const notes = readFileSync(join(pkg, 'DELTA-NOTES.md'), 'utf8');
  const { changes } = assemble(pkg).ledger;
  const replacement = 'fix(client): D11 enforce the write lease in SQLite instead of patching statements';
  const retired = [
    'fix(client): D11 refuse SQL callbacks under the statement guard',
    'fix(client): D11 refuse overrides that share a bundled SQLite function name under a guard',
  ];
  for (const subject of retired) {
    assert.ok(notes.includes(`- \`${subject}\`: superseded by \`${replacement}\`.`),
      `the provenance explanation must identify the replacement for ${subject}`);
  }
  assert.match(notes, /SQL callbacks remain allowed inside a leased transaction/);
  const lease = changes.find(change => change.subject === replacement);
  assert.ok(lease, 'the write-lease implementation must retain its own delta record');
  // The committed tree keeps the write-lease source and test blobs; the two
  // retired commits contribute historical evidence, not runtime code.
  for (const file of lease.files) {
    const committed = execFileSync('git', ['-C', dir, 'rev-parse', `HEAD:${file.path}`], { encoding: 'utf8' }).trim();
    assert.equal(committed, file.after, `${file.path} must retain the write-lease implementation`);
    for (const subject of retired) {
      const record = changes.find(change => change.subject === subject);
      assert.ok(record, `the superseded commit must remain recorded: ${subject}`);
      const retiredFile = record.files.find(entry => entry.path === file.path);
      assert.ok(retiredFile, `${subject} must record ${file.path}`);
      assert.notEqual(retiredFile.after, committed);
    }
  }
}
test('callback history explains the superseded guard and preserves the write-lease tree', () => checkCallbackHistory(root));
test('callback history check needs no ancestry beyond the checked-out commit', t => {
  const dir = mkdtempSync(join(tmpdir(), 'delta-provenance-shallow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${root}`, dir]);
  checkCallbackHistory(dir);
});
test('SQLite split history distinguishes the lease from the later transaction adapter', () => {
  const notes = readFileSync(join(root, 'packages/dacs-client/DELTA-NOTES.md'), 'utf8');
  assert.match(notes, /^PR 03 title: `feat\(client\): extract the SQLite transaction-liveness lease`\.$/m);
  assert.match(notes, /^PR 03 plan row:.*Supply the internal connection-local transaction-liveness lease only\./m);
  assert.match(notes, /^PR 03 acceptance: `test\/sqlite-write-lease.test.mjs`/m);
  assert.match(notes, /PR 03 supplies only the connection-local transaction-liveness lease/);
  assert.match(notes, /PR 03b supplies the statement boundary; PR 03c supplies the concrete transaction adapter/);
  assert.match(notes, /Historical adapter and store-test blobs record earlier commits, not the net tree of PR 03/);
});
test('the publication inventory cannot omit an outside-only commit or name an absent hash', t => {
  for (const edit of [
    rows => rows.filter(row => !row.files.includes('.gitleaksignore')),
    rows => rows.map(row => row.subject === 'ci: retain publication ancestry for client verification' ? { ...row, sha: '0'.repeat(40) } : row),
  ]) {
    const dir = scratch(t), file = join(dir, 'packages/dacs-client/DELTA-COMMITS.json');
    writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, 'utf8')))));
    const result = check(dir);
    assert.equal(result.status, 1, result.text);
    assert.match(result.text, /complete commit\/file inventory differs/);
  }
});
test('an unenumerated working-tree edit is refused',t=>{const dir=scratch(t);appendFileSync(join(dir,moved),'\n// TEST edit\n');const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/current blob differs/);});
test('a deletion needs a named delta',t=>{const dir=scratch(t);unlinkSync(join(dir,moved));const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/current blob differs/);});
test('removing a delta record cannot hide its historical file changes', t => {
  const dir = scratch(t), file = join(dir, 'packages/dacs-client/DELTA-LEDGER.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const index = data.changes.findLastIndex(record => record.files.some(file => file.before !== file.after && !isCorePath(file.path.slice('packages/dacs-client/'.length))));
  assert.ok(index >= 0, 'the ledger must contain a historical source change');
  data.changes.splice(index, 1);
  writeFileSync(file, JSON.stringify(data));
  const result = check(dir);
  assert.equal(result.status, 1, result.text);
  assert.match(result.text, /unenumerated change/);
});
test('removing a bookkeeping checkpoint is also refused', t => {
  const dir = scratch(t), file = join(dir, 'packages/dacs-client/DELTA-LEDGER.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const index = data.changes.findLastIndex(record => record.files.every(file => file.before === file.after));
  assert.ok(index >= 0, 'the ledger must contain a bookkeeping checkpoint');
  data.changes.splice(index, 1);
  writeFileSync(file, JSON.stringify(data));
  const result = check(dir);
  assert.equal(result.status, 1, result.text);
  assert.match(result.text, /DELTA-LEDGER\.json: archive differs from its core pin/);
  refusedByArchivePin(dir);
});
test('a later commit with an unlisted moved-file edit is refused',t=>{const dir=scratch(t);appendFileSync(join(dir,moved),'\n// TEST later commit\n');execFileSync('git',['-C',dir,'add',moved]);execFileSync('git',['-C',dir,'-c','user.name=the SDK maintainer','-c','user.email=maintainer@example.invalid','commit','--quiet','-m','delta(client): D15 TEST unlisted change']);const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/unenumerated change/);});
test('a stored per-file Markdown table is refused by the closed freeze', t => {
 const dir=scratch(t);writeFileSync(join(dir,'packages/dacs-client/DELTA-MAP.md'),'stale generated output\n');
 const result=spawnSync(process.execPath,[join(dir,'packages/dacs-client/scripts/check-hold.mjs')],{encoding:'utf8'});
 assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/DELTA-MAP\.md: not a core path, a record file or a record-named path/);
});

test('a committed deletion without a named delta is refused',t=>{
  const dir=scratch(t);
  unlinkSync(join(dir,moved));
  execFileSync('git',['-C',dir,'add','--',moved]);
  execFileSync('git',['-C',dir,'-c','user.name=the SDK maintainer','-c','user.email=maintainer@example.invalid','commit','--quiet','-m','delta(client): D15 TEST unnamed deletion']);
  const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/unenumerated change/);assert.match(r.text,/current blob differs/);
});

test('a staged moved-file edit with restored working bytes is refused',t=>{
 const dir=scratch(t),file=join(dir,moved),bytes=readFileSync(file);
 appendFileSync(file,'\n// staged-only probe\n');execFileSync('git',['-C',dir,'add','--',moved]);writeFileSync(file,bytes);
 const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/index differs from HEAD for moved source\/test/);
});

test('archived source and pre-publication delta evidence cannot be rewritten',t=>{
 const dir=scratch(t);appendFileSync(join(dir,'packages/dacs-client/evidence/publication-history.json'),'\n');
 const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/archived source\/delta evidence digest differs/);
});

test('launch review: unrelated future SDK commits do not need a client re-pin',t=>{
 const dir=scratch(t),path=join(dir,'README.md');appendFileSync(path,'\nSDK documentation update\n');
 unlinkSync(join(dir,'src/index.ts'));
 writeFileSync(join(dir,'new-sdk-doc.md'),'Unrelated SDK documentation\n');
 execFileSync('git',['-C',dir,'add','-A']);
 execFileSync('git',['-C',dir,'-c','user.name=SDK tests','-c','user.email=tests@example.invalid','-c','commit.gpgsign=false','commit','-qm','docs: unrelated SDK update']);
 const result=check(dir);assert.equal(result.status,0,result.text);
});
function checkMainMerge(t, { detached = false } = {}) {
 const dir=scratch(t),git=(...args)=>execFileSync('git',['-C',dir,'-c','user.name=SDK tests','-c','user.email=tests@example.invalid','-c','commit.gpgsign=false',...args],{encoding:'utf8'});
 git('checkout','-qb','pr-review');
 if(detached)git('checkout','-q','--detach','HEAD');
 assert.equal(git('branch','--show-current').trim(),detached?'':'pr-review');
 // Pull-request checkouts can have a detached HEAD, with no branch name.
 const start=git('rev-parse','--verify','HEAD').trim();git('checkout','-qb','advanced-main');
 appendFileSync(join(dir,'src/index.ts'),'\n// SDK hotfix\n');git('add','src/index.ts');git('commit','-qm','fix: unrelated SDK hotfix');
 git('checkout','-q','--detach',start);appendFileSync(join(dir,'README.md'),'\nPR documentation\n');git('add','README.md');git('commit','-qm','docs: unrelated PR update');
 git('merge','--no-ff','-qm','test PR merge','advanced-main');
 const result=check(dir);assert.equal(result.status,0,result.text);
}
test('launch review: unrelated main commits and a PR merge preserve client provenance',t=>checkMainMerge(t));
test('launch review: unrelated main commits and a PR merge preserve client provenance from a detached HEAD',t=>checkMainMerge(t,{detached:true}));

for (const subject of ['delta(client): D11 TEST accepted source repair', 'fix(client): D11 TEST accepted source repair']) {
 test(`D11 source history accepts ${subject.split(':')[0]} records`, t => {
  const dir=scratch(t),git=(...args)=>execFileSync('git',['-C',dir,'-c','user.name=SDK tests','-c','user.email=tests@example.invalid','-c','commit.gpgsign=false',...args]);
  // Exercise this checkout's checker even before its test commit is published.
  useThisChecker(dir);
  appendFileSync(join(dir,moved),'\n// TEST D11 source repair\n');git('add','--',moved);
  const node=(...args)=>execFileSync(process.execPath,args,{cwd:dir});
  node('packages/dacs-client/scripts/delta-map.mjs','--record','D11',subject);
  const file='packages/dacs-client/records/'+recordName({delta:'D11',subject});
  git('add','--',file);git('commit','-qm',subject);
  let result=check(dir);assert.equal(result.status,0,result.text);
  unlinkSync(join(dir,'packages/dacs-client/records/ids/D11.json'));
  result=check(dir);assert.equal(result.status,1,result.text);assert.match(result.text,/invalid delta/);
 });
}

function scratchGit(dir){return (...args)=>execFileSync('git',['-C',dir,'-c','user.name=SDK tests','-c','user.email=tests@example.invalid','-c','commit.gpgsign=false',...args],{encoding:'utf8'}).trim();}
const control=['packages/dacs-client/DELTA-COMMITS.json','packages/dacs-client/DELTA-LEDGER.json'];
// Commits one recorded change to the moved file. The inventory row stays
// unhashed, as for any record commit, unless a later edit qualifies it.
function recordedCommit(dir,subject,line,delta='D11'){
 const git=scratchGit(dir),node=(...args)=>execFileSync(process.execPath,args,{cwd:dir,stdio:'pipe'});
 appendFileSync(join(dir,moved),`\n// ${line}\n`);git('add','--',moved);
 node('packages/dacs-client/scripts/delta-map.mjs','--record',delta,subject);
 git('add','--','packages/dacs-client/records/'+recordName({delta,subject}));git('commit','-qm',subject);
 return git('rev-parse','HEAD');
}
function savedRecord(dir, value) {
 const file='packages/dacs-client/records/'+recordName(value);
 writeFileSync(join(dir,file),JSON.stringify({schema:'dacs-client-delta-record/v1',...value})+'\n');return file;
}
function commitRecords(dir, subject, files, delta='WF') {
 const git=scratchGit(dir),value={delta,subject,kind:'commit-only',commitFiles:[]},name='packages/dacs-client/records/'+recordName(value);
 value.commitFiles=[...files,name].sort();savedRecord(dir,value);git('add','--',...value.commitFiles);git('commit','-qm',subject);
}
function sourceCommit(dir, subject, line) {
 const git=scratchGit(dir);appendFileSync(join(dir,moved),`\n// ${line}\n`);git('add','--',moved);git('commit','-qm',subject);return git('rev-parse','HEAD');
}
function sourceRecord(dir, sha, delta='WF') {
 const git=scratchGit(dir);return {delta,subject:git('log','-1','--format=%s',sha),sha,kind:'change',files:[{path:moved,before:git('rev-parse',`${sha}^:${moved}`),after:git('rev-parse',`${sha}:${moved}`)}],commitFiles:[moved]};
}
test('two commits sharing a subject need SHA-qualified selectors',t=>{
 const dir=scratch(t),subject='fix(client): D11 TEST repeated subject';
 const first=sourceCommit(dir,subject,'TEST first'),second=sourceCommit(dir,subject,'TEST second');
 const left=sourceRecord(dir,first,'D11'),right=sourceRecord(dir,second,'WF');
 const unqualified=[left,right].map(row=>{const value={...row};delete value.sha;return savedRecord(dir,value);});
 let r=check(dir);assert.equal(r.status,1,r.text);
 assert.match(r.text,/duplicate delta subject fix\(client\): D11 TEST repeated subject/);
 assert.match(r.text,/delta commit selector must resolve once: fix\(client\): D11 TEST repeated subject/);
 assert.match(r.text,/commit inventory selector must resolve once: fix\(client\): D11 TEST repeated subject/);
 for(const file of unqualified)unlinkSync(join(dir,file));
 const files=[savedRecord(dir,left),savedRecord(dir,right)];
 commitRecords(dir,'delta(client): WF qualify repeated commit selectors',files);
 r=check(dir);assert.equal(r.status,0,r.text);
 for(const sha of [second.replace(/^./,c=>c==='0'?'1':'0'),'f'.repeat(40)]){
  const old=files[1];unlinkSync(join(dir,old));const changed=savedRecord(dir,{...right,sha});
  r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/delta commit selector must resolve once: \S+ fix\(client\): D11 TEST repeated subject/);assert.match(r.text,/unenumerated change in /);
  unlinkSync(join(dir,changed));savedRecord(dir,right);
 }
});
test('a commit reached only through a content-free merge is still audited',t=>{
 const dir=scratch(t),git=scratchGit(dir),start=git('rev-parse','HEAD');
 git('checkout','-qb','earlier-history');appendFileSync(join(dir,moved),'\n// TEST earlier published edit\n');git('add','--',moved);git('commit','-qm','fix(client): D11 TEST earlier published edit');
 const side=git('rev-parse','HEAD');git('checkout','-q','--detach',start);git('merge','-q','-s','ours','-m','merge: keep earlier history','earlier-history');
 assert.equal(git('rev-parse','HEAD^{tree}'),git('rev-parse',`${start}^{tree}`));
 const r=check(dir);assert.equal(r.status,1,r.text);
 assert.match(r.text,new RegExp(`complete commit/file inventory differs for ${side}`));
 assert.match(r.text,new RegExp(`unenumerated change in ${side}`));
});
test('the inventory cannot name an unreachable commit',t=>{
 const dir=scratch(t),file=join(dir,control[0]),rows=JSON.parse(readFileSync(file,'utf8'));
 rows.push({sha:'0'.repeat(40),subject:'fix(client): D11 TEST absent commit',files:[moved]});writeFileSync(file,JSON.stringify(rows));
 const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/commit inventory names an unreachable commit 0{40}/);
});
test('a hashed inventory row must carry its commit subject, and one commit has one row',t=>{
 const dir=scratch(t),file=join(dir,control[0]),rows=JSON.parse(readFileSync(file,'utf8'));
 const head=execFileSync('git',['-C',dir,'log','-1','--no-merges','--format=%H%x09%s','--','packages/dacs-client'],{encoding:'utf8'}).trim().split('\t');
 for(const [extra,message] of [
  [{sha:head[0],subject:'fix(client): D11 TEST wrong subject',files:['fake']},new RegExp(`commit inventory subject differs from commit ${head[0]}`)],
  [{sha:head[0],subject:head[1],files:['fake']},new RegExp(`commit inventory selects ${head[0]} more than once`)],
 ]){
  writeFileSync(file,JSON.stringify([...rows,extra]));
  const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,message);
 }
});
test('a record that names its full commit hash needs no delta prefix in the subject, an unqualified one does',t=>{
 const dir=scratch(t),subject='fix(client): TEST source repair without a delta prefix';
 const sha=sourceCommit(dir,subject,'TEST unprefixed source repair'),value=sourceRecord(dir,sha,'D11'),file=savedRecord(dir,value);
 commitRecords(dir,'delta(client): WF record the unprefixed source repair',[file]);
 let r=check(dir);assert.equal(r.status,0,r.text);
 unlinkSync(join(dir,file));const changed={...value};delete changed.sha;savedRecord(dir,changed);
 r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/invalid delta fix\(client\): TEST source repair without a delta prefix/);
});

const checkerFiles=['delta-map.mjs','delta-assemble.mjs','delta-record.mjs','delta-freeze.mjs'].map(name=>`packages/dacs-client/scripts/${name}`);
function useThisChecker(dir){for(const path of checkerFiles)copyFileSync(join(root,path),join(dir,path));}
test('a WF delta record is accepted and an unlisted delta id is still refused',t=>{
 const dir=scratch(t);useThisChecker(dir);
 recordedCommit(dir,'delta(client): WF TEST accepted record','TEST WF record','WF');
 let r=check(dir);assert.equal(r.status,0,r.text);
 recordedCommit(dir,'delta(client): D99 TEST unlisted id','TEST unlisted id','D99');
 r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/invalid delta/);
});

for(const subject of ['fix(client): TEST published fix without a delta id','TEST published fix with a plain subject'])
test(`a WF record selected by its full commit hash may carry the subject "${subject}"; the same subject without the hash is refused`,t=>{
 const dir=scratch(t),sha=sourceCommit(dir,subject,'TEST published fix'),value=sourceRecord(dir,sha),file=savedRecord(dir,value);
 commitRecords(dir,'delta(client): WF record the published fix',[file]);
 let r=check(dir);assert.equal(r.status,0,r.text);
 unlinkSync(join(dir,file));const changed={...value};delete changed.sha;savedRecord(dir,changed);
 r=check(dir);assert.equal(r.status,1,r.text);assert.ok(r.text.includes(`invalid delta ${subject}`),r.text);
});

// Each fault edits only the PR's own records, in a scratch clone of the checked head.
const LEDGER_FAULTS=[
 {name:'(a) the last record holding a real source or test change is removed',message:/unenumerated change/,
  edit:data=>{data.changes.splice(data.changes.findLastIndex(record=>record.files.some(file=>file.before!==file.after&&!isCorePath(file.path.slice('packages/dacs-client/'.length)))),1);}},
 {name:'(a) the same record is removed and an empty-files record is appended last',message:/unenumerated change/,
  edit:data=>{data.changes.splice(data.changes.findLastIndex(record=>record.files.some(file=>file.before!==file.after&&!isCorePath(file.path.slice('packages/dacs-client/'.length)))),1);
   data.changes.push({delta:'WF',subject:'delta(client): WF TEST empty record',files:[]});}},
 {name:'(b) a no-op checkpoint record is removed',message:/DELTA-LEDGER\.json: archive differs from its core pin/,
  edit:data=>{data.changes.splice(data.changes.findLastIndex(record=>record.files.length>0&&record.files.every(file=>file.before===file.after)),1);}},
 {name:'(c) a record\'s last recorded blob for a path is replaced by an earlier one',message:/current blob differs/,
  edit:data=>{
   const history=new Map();
   for(const record of data.changes)for(const file of record.files){const entries=history.get(file.path)??[];entries.push({record,file});history.set(file.path,entries);}
   const [,entries]=[...history].filter(([,all])=>all.length>1&&all.at(-2).file.after!==all.at(-1).file.after).at(-1);
   entries.at(-1).file.after=entries.at(-2).file.after;}},
];
test('the committed head passes and each archived record fault is refused',t=>{
 const head=check(scratch(t));assert.equal(head.status,0,head.text);
 const {changes}=assemble(join(root,'packages/dacs-client')).ledger;
 const wfRecords=changes.filter(record=>record.delta==='WF');
 assert.ok(wfRecords.length>0,'this PR records its changes under WF');
 for(const record of wfRecords)for(const file of record.files){
  if(isCorePath(file.path.slice('packages/dacs-client/'.length)))continue;
  const newest=changes.findLast(other=>other.files.some(entry=>entry.path===file.path)).files.find(entry=>entry.path===file.path).after;
  const committed=spawnSync('git',['-C',root,'rev-parse','--verify','--quiet',`HEAD:${file.path}`],{encoding:'utf8'});
  assert.equal(committed.status===0?committed.stdout.trim():null,newest,`${file.path} is recorded at its committed blob (null: deleted)`);
 }
 for(const fault of LEDGER_FAULTS){
  const dir=scratch(t),file=join(dir,control[1]),data=JSON.parse(readFileSync(file,'utf8'));
  fault.edit(data);writeFileSync(file,JSON.stringify(data));
  const r=check(dir);assert.equal(r.status,1,`${fault.name}: ${r.text}`);assert.match(r.text,fault.message,fault.name);
  refusedByArchivePin(dir);
 }
});


const RECORD_FAULTS = [
 { name: 'an omitted inventory path', edit: value => { value.commitFiles = value.commitFiles.filter(path => path !== moved); } },
 { name: 'a removed source-change record', remove: true },
 { name: 'a removed checkpoint', remove: true, checkpoint: true },
 { name: 'a renamed record', rename: true },
 { name: 'an unreachable commit selector', edit: value => { value.sha = '0'.repeat(40); } },
 { name: 'a changed subject on a hashed selector', edit: (value, sha) => { value.sha = sha; value.subject = 'delta(client): WF a different commit subject'; } },
 { name: 'a repeated commit selector', duplicate: true, qualified: true },
 { name: 'an unqualified subject without a delta prefix', edit: value => { delete value.sha; value.subject = 'a source repair without a delta prefix'; } },
 { name: 'a changed terminal blob', edit: value => { value.files[0].after = '0'.repeat(40); } },
 { name: 'a changed parent blob', edit: value => { value.files[0].before = '0'.repeat(40); } },
 { name: 'an ordinary record with no changed blob', edit: value => { value.files[0].after = value.files[0].before; } },
 { name: 'an empty file list', edit: value => { value.files = []; } },
 { name: 'an inventory row naming another file', edit: value => { value.commitFiles = ['packages/dacs-client/README.md']; } },
 { name: 'an unqualified repeated subject', duplicate: true },
];
for (const fault of RECORD_FAULTS) test(`immutable record files refuse ${fault.name}`, t => {
 const dir = scratch(t), git = scratchGit(dir), subject = 'delta(client): WF record a source change for integrity checks';
 let sha, value;
 if (fault.checkpoint) {
  const chosen = git('rev-parse', `HEAD:${moved}`);
  value = { delta: 'WF', subject, kind: 'checkpoint', files: [{ path: moved, before: chosen, after: chosen }], commitFiles: [] };
  const name = 'packages/dacs-client/records/' + recordName(value); value.commitFiles = [name];
  savedRecord(dir, value); git('add', '--', name); git('commit', '-qm', subject); sha = git('rev-parse', 'HEAD');
 } else {
  sha = recordedCommit(dir, subject, 'Recorded source integrity check.', 'WF');
  value = JSON.parse(readFileSync(join(dir, 'packages/dacs-client/records', recordName({ delta: 'WF', subject })), 'utf8'));
 }
 const file = 'packages/dacs-client/records/' + recordName(value);
 if (fault.remove || fault.rename) unlinkSync(join(dir, file));
 if (fault.rename) writeFileSync(join(dir, 'packages/dacs-client/records/renamed.json'), JSON.stringify(value));
 if (fault.duplicate) {
  unlinkSync(join(dir, file));
  if (fault.qualified) value = { ...value, sha };
  savedRecord(dir, value);
  savedRecord(dir, { ...value, delta: 'D11' });
 } else if (fault.edit) {
  fault.edit(value, sha); unlinkSync(join(dir, file)); savedRecord(dir, value);
 }
 const result = check(dir); assert.equal(result.status, 1, result.text);
 assert.match(result.text, /record file (?:differs from the blob it was added with|not added by a commit after the baseline)/);
 if (fault.duplicate) {
  assert.match(result.text, /duplicate delta subject delta\(client\): WF record a source change for integrity checks/);
  assert.match(result.text, new RegExp(`commit inventory selects ${sha} more than once`));
  assert.doesNotMatch(result.text, /file name must be/);
 }
 // The same archived edit is refused by the reciprocal core pin.
 const archive = join(dir, 'packages/dacs-client/DELTA-LEDGER.json'), data = JSON.parse(readFileSync(archive, 'utf8'));
 if (fault.remove || fault.rename) data.changes.pop();
 else data.changes.push({ delta: value.delta, subject: value.subject, ...(value.sha ? { sha: value.sha } : {}), files: value.files });
 writeFileSync(archive, JSON.stringify(data)); refusedByArchivePin(dir);
});
