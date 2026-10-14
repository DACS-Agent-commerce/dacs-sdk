import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openSellerIssuanceJournals } from '../src/devnet-demo/operator.mjs';
import { acquireSellerStateLock, currentSellerStateHolder, SELLER_STATE_LOCK_FILE, SELLER_STATE_LOCK_REFUSALS, sellerStateHolderState } from '../src/devnet-demo/seller-state-lock.mjs';

// Daybreak r6 P1-b: one process owns a seller state directory for its whole
// lifetime, taken before enrolment, the header write or reconciliation.
const operatorModule=resolve(fileURLToPath(new URL('../src/devnet-demo/operator.mjs',import.meta.url)));
const sha=(value)=>createHash('sha256').update(value).digest('hex');
async function directory(t){const path=await mkdtemp(join(tmpdir(),'seller-state-lock-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
// Every file under the state directory with its bytes' hash and mtime.
async function fingerprint(root){
  const out={};
  const walk=async(dir)=>{for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(dir,entry.name);
    if(entry.isDirectory())await walk(path);else out[path.slice(root.length)]=`${sha(await readFile(path))}:${(await stat(path)).mtimeMs}`;
  }};
  await walk(root);return out;
}
// Another operator process: it opens the seller state and holds it until its
// stdin closes, or kills itself once it holds it ('crash').
function otherProcess(t,dir,mode='hold'){
  const code=`import { openSellerIssuanceJournals } from ${JSON.stringify(operatorModule)};
const opened=[];
try{await openSellerIssuanceJournals({directory:process.argv[1],sellerRecords:true,opened});}
catch(error){process.stdout.write('refused:'+error.message+'\\n');process.exit(3);}
if(process.argv[2]==='crash')process.kill(process.pid,'SIGKILL');
process.stdout.write('ready\\n');
process.stdin.resume();process.stdin.on('end',()=>{for(const close of opened.reverse())close();process.exit(0);});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,dir,mode],{stdio:['pipe','pipe','inherit']});
  let output='';child.stdout.on('data',(d)=>{output+=d;});
  const exited=new Promise((done)=>child.on('exit',(code,signal)=>done({code,signal,output})));
  const ready=new Promise((done)=>{const check=()=>{if(output.includes('\n'))done(output);};child.stdout.on('data',check);child.on('exit',()=>done(output));});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  return{child,ready,exited,stop:()=>{child.stdin.end();return exited;}};
}

test('two processes against one seller state: the second refuses before it reads or writes the ledger, binding or journals',async t=>{
  const dir=await directory(t);
  const first=otherProcess(t,dir);assert.equal(await first.ready,'ready\n');
  const holder=JSON.parse(await readFile(join(dir,SELLER_STATE_LOCK_FILE),'utf8'));
  assert.equal(holder.pid,first.child.pid);
  const before=await fingerprint(dir);
  assert.ok(Object.keys(before).some(name=>name.endsWith('seller-approvals.jsonl')),'the first process bound its ledger');
  // This test process is a second operator.
  const opened=[];
  await assert.rejects(openSellerIssuanceJournals({directory:dir,sellerRecords:true,opened}),{code:'seller_state_locked',message:SELLER_STATE_LOCK_REFUSALS.held});
  assert.deepEqual(opened.length,0,'it opened nothing');
  // And a third, separate process.
  const third=otherProcess(t,dir);
  const refused=await third.exited;
  assert.equal(refused.code,3);assert.equal(refused.output,`refused:${SELLER_STATE_LOCK_REFUSALS.held}\n`);
  assert.deepEqual(await fingerprint(dir),before,'nothing in the state directory was written');
  // Once the first stops, its lock is gone and the state opens again.
  assert.equal((await first.stop()).code,0);
  assert.equal(existsSync(join(dir,SELLER_STATE_LOCK_FILE)),false);
  const journals=await openSellerIssuanceJournals({directory:dir,sellerRecords:true,opened});
  assert.equal(journals.length,3);journals.stateLock.release();for(const close of opened.reverse())close();
});

test('a stale lock left by a process that died is taken over',async t=>{
  const dir=await directory(t);
  const crashed=otherProcess(t,dir,'crash'),result=await crashed.exited;
  assert.equal(result.signal,'SIGKILL');
  const stale=JSON.parse(await readFile(join(dir,SELLER_STATE_LOCK_FILE),'utf8'));
  assert.equal(stale.pid,crashed.child.pid);
  assert.equal(sellerStateHolderState(stale),'gone');
  const opened=[];t.after(()=>{for(const close of opened.reverse())close();});
  const journals=await openSellerIssuanceJournals({directory:dir,sellerRecords:true,opened});
  const now=JSON.parse(await readFile(join(dir,SELLER_STATE_LOCK_FILE),'utf8'));
  assert.equal(now.pid,process.pid);assert.equal(existsSync(join(dir,`${SELLER_STATE_LOCK_FILE}.takeover`)),false);
  journals.stateLock.release();assert.equal(existsSync(join(dir,SELLER_STATE_LOCK_FILE)),false);
});

test('a lock held by a live process is never taken over, this process included',async t=>{
  const dir=await directory(t),opened=[];t.after(()=>{for(const close of opened.reverse())close();});
  const journals=await openSellerIssuanceJournals({directory:dir,sellerRecords:true,opened});
  const lock=await readFile(join(dir,SELLER_STATE_LOCK_FILE),'utf8');
  assert.equal(sellerStateHolderState(JSON.parse(lock)),'live');
  await assert.rejects(openSellerIssuanceJournals({directory:dir,sellerRecords:true,opened:[]}),{message:SELLER_STATE_LOCK_REFUSALS.held});
  assert.equal(await readFile(join(dir,SELLER_STATE_LOCK_FILE),'utf8'),lock);
  journals.stateLock.release();
});

test('any doubt about the holder refuses: another machine or pid namespace, an unreadable lock, an unreadable start time, or an interrupted takeover',async t=>{
  const self=currentSellerStateHolder();
  const at=(fields)=>({...self,pid:424242,...fields});
  const start=(value)=>()=>value,missing=()=>{throw Object.assign(new Error('TEST'),{code:'ENOENT'});},denied=()=>{throw Object.assign(new Error('TEST'),{code:'EACCES'});};
  assert.equal(sellerStateHolderState(at({}),self,{readStart:missing}),'gone','the pid is gone');
  assert.equal(sellerStateHolderState(at({}),self,{readStart:start('1')}),'gone','the pid now names a later process');
  assert.equal(sellerStateHolderState(at({}),self,{readStart:start(self.processStart)}),'live');
  assert.equal(sellerStateHolderState(at({}),self,{readStart:denied}),'doubt');
  // Taken before this machine booted (round 7: acquiredAt 0 here), under another boot id.
  assert.equal(sellerStateHolderState(at({bootId:'TEST-earlier-boot',acquiredAt:0}),self,{readStart:start(self.processStart)}),'gone','the machine restarted since');
  for(const fields of [{machineId:'TEST-other-machine'},{host:'TEST-other-host'},{machineId:null},{pidNamespace:'pid:[1]'},{pidNamespace:null},{processStart:null},{bootId:null},{pid:0},{format:'TEST'},{extra:true}])
    assert.equal(sellerStateHolderState(at(fields),self,{readStart:missing}),'doubt',JSON.stringify(fields));
  assert.equal(sellerStateHolderState(null,self,{readStart:missing}),'doubt');
  // On disk: each refuses and leaves the lock as it was.
  const dir=await directory(t),path=join(dir,SELLER_STATE_LOCK_FILE);
  for(const text of [`${JSON.stringify(at({machineId:'TEST-other-machine'}))}\n`,'','{"format":']){
    await writeFile(path,text);
    await assert.rejects(acquireSellerStateLock(dir),{message:SELLER_STATE_LOCK_REFUSALS.doubt});
    assert.equal(await readFile(path,'utf8'),text);
  }
  // A gone holder, but a takeover file left by an interrupted takeover.
  const gone=`${JSON.stringify(at({bootId:'TEST-earlier-boot',acquiredAt:0}))}\n`;
  await writeFile(path,gone);await writeFile(`${path}.takeover`,'TEST');
  await assert.rejects(acquireSellerStateLock(dir),{message:SELLER_STATE_LOCK_REFUSALS.takeover});
  assert.equal(await readFile(path,'utf8'),gone);
  await rm(`${path}.takeover`);
  const lock=await acquireSellerStateLock(dir);
  assert.equal(JSON.parse(await readFile(path,'utf8')).pid,process.pid);lock.release();
});

test('the lock is taken only with seller records: app mode keeps main\'s journal opening and writes no lock',async t=>{
  const dir=await directory(t),opened=[];t.after(()=>{for(const close of opened.reverse())close();});
  assert.equal((await openSellerIssuanceJournals({directory:dir,opened})).length,3);
  assert.equal(existsSync(join(dir,SELLER_STATE_LOCK_FILE)),false);
});

test('code review r6 P3-1: a lock under another boot id that was taken after this machine booted (a cloned machine with the same identity) refuses as doubt, and so does an unreadable boot time',async t=>{
  const self=currentSellerStateHolder(),booted=1_700_000_000_000,boot=()=>booted;
  const other=(acquiredAt)=>({...self,pid:424242,bootId:'TEST-other-boot',acquiredAt});
  assert.equal(sellerStateHolderState(other(booted-1),self,{readBootTime:boot}),'gone','taken before this boot');
  for(const acquiredAt of [booted,booted+1,Date.now()])assert.equal(sellerStateHolderState(other(acquiredAt),self,{readBootTime:boot}),'doubt',`taken at ${acquiredAt}, since this boot`);
  for(const readBootTime of [()=>{throw Object.assign(new Error('TEST no /proc/stat'),{code:'ENOENT'});},()=>NaN,()=>0])
    assert.equal(sellerStateHolderState(other(0),self,{readBootTime}),'doubt','no boot time, no proof');
  // On disk, with this machine's own boot time: a lock of another boot taken just now refuses and stays.
  const dir=await directory(t),path=join(dir,SELLER_STATE_LOCK_FILE),clone=`${JSON.stringify(other(Date.now()))}\n`;
  await writeFile(path,clone);
  await assert.rejects(acquireSellerStateLock(dir),{message:SELLER_STATE_LOCK_REFUSALS.doubt});
  assert.equal(await readFile(path,'utf8'),clone);
});

test('a takeover re-checks the lock it judged gone, and a release never removes a lock that is no longer this one',async t=>{
  const dir=await directory(t),path=join(dir,SELLER_STATE_LOCK_FILE);
  const gone=`${JSON.stringify({...currentSellerStateHolder(),pid:424242,bootId:'TEST-earlier-boot',acquiredAt:0})}\n`,winner='TEST another process took the lock over meanwhile\n';
  await writeFile(path,gone);
  // Between this process's judgment and its takeover, another one replaced the lock.
  await assert.rejects(acquireSellerStateLock(dir,{holderState:(holder)=>{writeFileSync(path,winner);return sellerStateHolderState(holder);}}),{message:SELLER_STATE_LOCK_REFUSALS.held});
  assert.equal(await readFile(path,'utf8'),winner);assert.equal(existsSync(`${path}.takeover`),false);
  await rm(path);
  const lock=await acquireSellerStateLock(dir);
  await writeFile(path,winner);lock.release();
  assert.equal(await readFile(path,'utf8'),winner,'not this process\'s lock: kept');
});
