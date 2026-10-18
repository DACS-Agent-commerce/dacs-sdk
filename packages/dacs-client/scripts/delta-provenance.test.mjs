import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root=join(dirname(fileURLToPath(import.meta.url)),'../../..');
function scratch(t){const dir=mkdtempSync(join(tmpdir(),'delta-provenance-'));execFileSync('git',['clone','--quiet','--shared',root,dir]);t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function check(dir){const result=spawnSync(process.execPath,[join(dir,'packages/dacs-client/scripts/check-provenance.mjs'),'--local-only'],{encoding:'utf8'});return {status:result.status,text:result.stdout+result.stderr};}
const moved='packages/dacs-client/src/dacs/buyer-chain-readback.mjs';
test('committed delta history and generated per-file table agree',t=>{const r=check(scratch(t));assert.equal(r.status,0,r.text);});
test('an unenumerated working-tree edit is refused',t=>{const dir=scratch(t);appendFileSync(join(dir,moved),'\n// TEST edit\n');const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/current blob differs/);});
test('a deletion needs a named delta',t=>{const dir=scratch(t);unlinkSync(join(dir,moved));const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/current blob differs/);});
test('removing a delta record cannot hide its historical file changes',t=>{const dir=scratch(t),f=join(dir,'packages/dacs-client/DELTA-LEDGER.json'),data=JSON.parse(readFileSync(f,'utf8'));data.changes.pop();writeFileSync(f,JSON.stringify(data));const r=check(dir);assert.equal(r.status,1,r.text);assert.match(r.text,/unenumerated change/);});
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
