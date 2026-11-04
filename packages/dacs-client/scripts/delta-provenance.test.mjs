import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root=join(dirname(fileURLToPath(import.meta.url)),'../../..');
function scratch(t){const dir=mkdtempSync(join(tmpdir(),'delta-provenance-'));execFileSync('git',['clone','--quiet','--shared',root,dir]);t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function check(dir){const result=spawnSync(process.execPath,[join(dir,'packages/dacs-client/scripts/check-provenance.mjs'),'--local-only'],{encoding:'utf8'});return {status:result.status,text:result.stdout+result.stderr};}
const moved='packages/dacs-client/src/dacs/buyer-chain-readback.mjs';
test('committed delta history and generated per-file table agree',t=>{const r=check(scratch(t));assert.equal(r.status,0,r.text);});
function checkCallbackHistory(dir) {
  const pkg = join(dir, 'packages/dacs-client');
  const notes = readFileSync(join(pkg, 'DELTA-NOTES.md'), 'utf8');
  const { changes } = JSON.parse(readFileSync(join(pkg, 'DELTA-LEDGER.json'), 'utf8'));
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
  const index = data.changes.findLastIndex(record => record.files.some(file => file.before !== file.after));
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
  assert.match(result.text, /differs from generated Git table/);
});
test('a later commit with an unlisted moved-file edit is refused',t=>{const dir=scratch(t);appendFileSync(join(dir,moved),'\n// TEST later commit\n');execFileSync('git',['-C',dir,'add',moved]);execFileSync('git',['-C',dir,'-c','user.name=the SDK maintainer','-c','user.email=maintainer@example.invalid','commit','--quiet','-m','delta(client): D15 TEST unlisted change']);const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/unenumerated change/);});
test('the per-file Markdown table is checked, not trusted',t=>{const dir=scratch(t);appendFileSync(join(dir,'packages/dacs-client/DELTA-MAP.md'),'TEST drift\n');const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/differs from generated Git table/);});

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
  copyFileSync(join(root,'packages/dacs-client/scripts/delta-map.mjs'),join(dir,'packages/dacs-client/scripts/delta-map.mjs'));
  appendFileSync(join(dir,moved),'\n// TEST D11 source repair\n');git('add','--',moved);
  const node=(...args)=>execFileSync(process.execPath,args,{cwd:dir});
  node('packages/dacs-client/scripts/delta-map.mjs','--record','D11',subject);
  const files=[moved,'packages/dacs-client/DELTA-COMMITS.json','packages/dacs-client/DELTA-LEDGER.json','packages/dacs-client/DELTA-MAP.md'];
  if(git('diff','--name-only','HEAD','--','packages/dacs-client/scripts/delta-map.mjs').length)files.push('packages/dacs-client/scripts/delta-map.mjs');files.sort();
  const inventory=join(dir,'packages/dacs-client/DELTA-COMMITS.json'),rows=JSON.parse(readFileSync(inventory,'utf8'));
  rows.push({sha:null,subject,files});writeFileSync(inventory,JSON.stringify(rows,null,2)+'\n');
  node('packages/dacs-client/scripts/delta-map.mjs');git('add','--',...files);git('commit','-qm',subject);
  let result=check(dir);assert.equal(result.status,0,result.text);
  const checker=join(dir,'packages/dacs-client/scripts/delta-map.mjs');
  writeFileSync(checker,readFileSync(checker,'utf8').replace("'D1','D11','D15'","'D1','D15'"));
  result=check(dir);assert.equal(result.status,1,result.text);assert.match(result.text,/invalid delta/);
 });
}
