import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root=join(dirname(fileURLToPath(import.meta.url)),'../../..');
// Synchronous Git commands can still detach maintenance that races teardown.
const git=(repo,...args)=>execFileSync('git',['-c','gc.auto=0','-c','maintenance.auto=false','-C',repo,...args],{encoding:'utf8'});
function scratch(t){const dir=mkdtempSync(join(tmpdir(),'delta-provenance-'));t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));git(root,'clone','--quiet','--shared',root,dir);return dir;}
function check(dir){const result=spawnSync(process.execPath,[join(dir,'packages/dacs-client/scripts/check-provenance.mjs'),'--local-only'],{encoding:'utf8'});return {status:result.status,text:result.stdout+result.stderr};}
const moved='packages/dacs-client/src/dacs/buyer-chain-readback.mjs';
test('committed delta history and generated per-file table agree',t=>{const r=check(scratch(t));assert.equal(r.status,0,r.text);});
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
test('removing a delta record cannot hide its historical file changes',t=>{const dir=scratch(t),f=join(dir,'packages/dacs-client/DELTA-LEDGER.json'),data=JSON.parse(readFileSync(f,'utf8'));data.changes.pop();writeFileSync(f,JSON.stringify(data));const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/unenumerated change/);});
test('a later commit with an unlisted moved-file edit is refused',t=>{const dir=scratch(t);appendFileSync(join(dir,moved),'\n// TEST later commit\n');git(dir,'add',moved);git(dir,'-c','user.name=the SDK maintainer','-c','user.email=maintainer@example.invalid','commit','--quiet','-m','delta(client): D15 TEST unlisted change');const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/unenumerated change/);});
test('the per-file Markdown table is checked, not trusted',t=>{const dir=scratch(t);appendFileSync(join(dir,'packages/dacs-client/DELTA-MAP.md'),'TEST drift\n');const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/differs from generated Git table/);});

test('a committed deletion without a named delta is refused',t=>{
  const dir=scratch(t);
  unlinkSync(join(dir,moved));
  git(dir,'add','--',moved);
  git(dir,'-c','user.name=the SDK maintainer','-c','user.email=maintainer@example.invalid','commit','--quiet','-m','delta(client): D15 TEST unnamed deletion');
  const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/unenumerated change/);assert.match(r.text,/current blob differs/);
});

test('a staged moved-file edit with restored working bytes is refused',t=>{
 const dir=scratch(t),file=join(dir,moved),bytes=readFileSync(file);
 appendFileSync(file,'\n// staged-only probe\n');git(dir,'add','--',moved);writeFileSync(file,bytes);
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
 git(dir,'add','-A');
 git(dir,'-c','user.name=SDK tests','-c','user.email=tests@example.invalid','-c','commit.gpgsign=false','commit','-qm','docs: unrelated SDK update');
 const result=check(dir);assert.equal(result.status,0,result.text);
});
function checkMainMerge(t, { detached = false } = {}) {
 const dir=scratch(t),repoGit=(...args)=>git(dir,'-c','user.name=SDK tests','-c','user.email=tests@example.invalid','-c','commit.gpgsign=false',...args);
 repoGit('checkout','-qb','pr-review');
 if(detached)repoGit('checkout','-q','--detach','HEAD');
 assert.equal(repoGit('branch','--show-current').trim(),detached?'':'pr-review');
 // Pull-request checkouts can have a detached HEAD, with no branch name.
 const start=repoGit('rev-parse','--verify','HEAD').trim();repoGit('checkout','-qb','advanced-main');
 appendFileSync(join(dir,'src/index.ts'),'\n// SDK hotfix\n');repoGit('add','src/index.ts');repoGit('commit','-qm','fix: unrelated SDK hotfix');
 repoGit('checkout','-q','--detach',start);appendFileSync(join(dir,'README.md'),'\nPR documentation\n');repoGit('add','README.md');repoGit('commit','-qm','docs: unrelated PR update');
 repoGit('merge','--no-ff','-qm','test PR merge','advanced-main');
 const result=check(dir);assert.equal(result.status,0,result.text);
}
test('launch review: unrelated main commits and a PR merge preserve client provenance',t=>checkMainMerge(t));
test('launch review: unrelated main commits and a PR merge preserve client provenance from a detached HEAD',t=>checkMainMerge(t,{detached:true}));
