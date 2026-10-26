import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { appendApprovalLedgerLine } from '../src/devnet-demo/approval-ledger-append.mjs';
const fixture=async(t)=>{const dir=await mkdtemp(join(tmpdir(),'TEST-ledger-append-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};

test('ledger appends preserve an unterminated last record',async t=>{
 const path=join(await fixture(t),'ledger');await writeFile(path,JSON.stringify({record:'first'}));
 appendApprovalLedgerLine(path,{record:'second'});
 assert.deepEqual((await readFile(path,'utf8')).trimEnd().split('\n').map(JSON.parse),[{record:'first'},{record:'second'}]);
});

test('ledger publication syncs the file and every newly created parent entry',async t=>{
 const dir=await fixture(t),path=join(dir,'nested','deeper','ledger'),original=fs.fsyncSync,synced=[];
 try{
  fs.fsyncSync=fd=>{synced.push(fs.realpathSync(`/proc/self/fd/${fd}`));return original(fd);};syncBuiltinESMExports();
  appendApprovalLedgerLine(path,{record:'first'});
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 for(const expected of [path,dirname(path),dirname(dirname(path)),dir])assert(synced.includes(expected),expected);
});

for(const stage of ['file','directory'])test(`ledger ${stage} sync failure is reported and a retry syncs retained publication`,async t=>{
 const path=join(await fixture(t),'nested','deeper','ledger'),original=fs.fsyncSync,cause=new Error(`TEST ${stage} sync failure`),synced=[];
 try{
  fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory()===(stage==='directory'))throw cause;return original(fd);};syncBuiltinESMExports();
  assert.throws(()=>appendApprovalLedgerLine(path,{record:'first'}),error=>error===cause);
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 try{
  fs.fsyncSync=fd=>{synced.push(fs.realpathSync(`/proc/self/fd/${fd}`));return original(fd);};syncBuiltinESMExports();
  appendApprovalLedgerLine(path,{record:'retry'});
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 assert(synced.includes(dirname(dirname(dirname(path)))));
 assert.equal((await readFile(path,'utf8')).trim().split('\n').length,2);
});
