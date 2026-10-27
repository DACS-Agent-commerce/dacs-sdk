import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { appendApprovalLedgerLine } from '../src/devnet-demo/approval-ledger-append.mjs';
const fixture=async(t)=>{const dir=await mkdtemp(join(tmpdir(),'TEST-ledger-append-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
const recordSyncs=(work)=>{
 const original=fs.fsyncSync,synced=[];
 try{fs.fsyncSync=fd=>{synced.push(fs.realpathSync(`/proc/self/fd/${fd}`));return original(fd);};syncBuiltinESMExports();work();}
 finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 return synced;
};

test('ledger appends preserve an unterminated last record',async t=>{
 const path=join(await fixture(t),'ledger');await writeFile(path,JSON.stringify({record:'first'}));
 appendApprovalLedgerLine(path,{record:'second'});
 assert.deepEqual((await readFile(path,'utf8')).trimEnd().split('\n').map(JSON.parse),[{record:'first'},{record:'second'}]);
});

test('ledger publication creates one private leaf and syncs the file, the leaf and its entry in the parent',async t=>{
 const dir=await fixture(t),path=join(dir,'leaf','ledger');
 const synced=recordSyncs(()=>appendApprovalLedgerLine(path,{record:'first'}));
 for(const expected of [path,dirname(path),dir])assert(synced.includes(expected),expected);
 assert.equal(fs.statSync(dirname(path)).mode&0o777,0o700);
});

test('a ledger two missing levels deep is refused before any directory is created',async t=>{
 const dir=await fixture(t),path=join(dir,'missing','leaf','ledger');
 assert.throws(()=>appendApprovalLedgerLine(path,{record:'first'}),error=>error.code==='ENOENT');
 assert.equal(fs.existsSync(join(dir,'missing')),false);
});

test('a retry in a fresh process syncs the leaf entry a crash left unsynced',async t=>{
 const dir=await fixture(t),path=join(dir,'leaf','ledger');
 await mkdir(dirname(path),{mode:0o700});await writeFile(path,`${JSON.stringify({record:'first'})}\n`);
 const fresh=await import('../src/devnet-demo/approval-ledger-append.mjs?fresh-process');
 const synced=recordSyncs(()=>fresh.syncApprovalLedger(path));
 for(const expected of [path,dirname(path),dir])assert(synced.includes(expected),expected);
});

for(const stage of ['file','directory'])test(`ledger ${stage} sync failure is reported and a retry syncs retained publication`,async t=>{
 const dir=await fixture(t),path=join(dir,'leaf','ledger'),original=fs.fsyncSync,cause=new Error(`TEST ${stage} sync failure`);
 try{
  fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory()===(stage==='directory'))throw cause;return original(fd);};syncBuiltinESMExports();
  assert.throws(()=>appendApprovalLedgerLine(path,{record:'first'}),error=>error===cause);
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 const synced=recordSyncs(()=>appendApprovalLedgerLine(path,{record:'retry'}));
 assert(synced.includes(dir));
 assert.equal((await readFile(path,'utf8')).trim().split('\n').length,2);
});
