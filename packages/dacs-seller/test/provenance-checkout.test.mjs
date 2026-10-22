import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync,mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
test('every executable seller test runs through both supported entry points',()=>{
 const actual=readdirSync(join(root,'packages/dacs-seller/test')).filter(name=>name.endsWith('.test.mjs')).sort();
 const script=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).scripts['seller:test'];
 const cli=[...script.matchAll(/packages\/dacs-seller\/test\/([^ ]+\.test\.mjs)/g)].map(match=>match[1]).sort();
 const wrapper=readFileSync(join(root,'test/seller/standalone.test.ts'),'utf8');
 const list=/const files\s*=\s*\[([\s\S]*?)\];/.exec(wrapper)?.[1];
 assert.ok(list,'the CI wrapper must declare its executable file list');
 const ci=[...list.matchAll(/'([^']+\.test\.mjs)'/g)].map(match=>match[1]).sort();
 assert.deepEqual(cli,actual,'seller:test must execute every test file exactly once');
 assert.deepEqual(ci,actual,'the core CI wrapper must execute the same complete set');
});
test('provenance checks need only published history in a fresh local clone',()=>{
 const dir=mkdtempSync(join(tmpdir(),'seller-provenance-'));
 try{
  execFileSync('git',['clone','--quiet','--no-hardlinks',root,dir]);
  // Include uncommitted changes and deletions; an overlay would retain tests
  // that moved to port-sources in the working tree. No network is needed.
  rmSync(join(dir,'packages/dacs-seller'),{recursive:true,force:true});
  cpSync(join(root,'packages/dacs-seller'),join(dir,'packages/dacs-seller'),{recursive:true});
  // Also verify an exported source checkout with no historical Git objects.
  rmSync(join(dir,'.git'),{recursive:true,force:true});execFileSync('git',['init','--quiet',dir]);
  // Every run-time port matches its pin: an edit is recorded as a named replacement (RUNTIME-PORTS.json).
  for(const args of [['check-provenance.mjs'],['publication-provenance.mjs','--check'],['runtime-ports.mjs']])assert.match(execFileSync(process.execPath,[join(dir,'packages/dacs-seller/scripts',args[0]),...args.slice(1)],{encoding:'utf8',maxBuffer:8*1024*1024}),/verified|ok|match their pins/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
