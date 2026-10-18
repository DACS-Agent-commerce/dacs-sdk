import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
test('provenance checks need only published history in a fresh local clone',()=>{
 const dir=mkdtempSync(join(tmpdir(),'seller-provenance-'));
 try{
  execFileSync('git',['clone','--quiet','--no-hardlinks',root,dir]);
  // Include uncommitted reviewed changes too; no preparation commits or network.
  cpSync(join(root,'packages/dacs-seller'),join(dir,'packages/dacs-seller'),{recursive:true});
  // Also verify an exported source checkout with no historical Git objects.
  rmSync(join(dir,'.git'),{recursive:true,force:true});execFileSync('git',['init','--quiet',dir]);
  for(const args of [['check-provenance.mjs'],['publication-provenance.mjs','--check']])assert.match(execFileSync(process.execPath,[join(dir,'packages/dacs-seller/scripts',args[0]),...args.slice(1)],{encoding:'utf8',maxBuffer:8*1024*1024}),/verified|ok/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
