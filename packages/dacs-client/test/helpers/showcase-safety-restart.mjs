import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fixture } from './showcase-safety-fixture.mjs';

async function killedAt(path,stage,directoryIdentity) {
  const child=fork(new URL('./showcase-safety-child.mjs',import.meta.url),[path,stage,JSON.stringify(directoryIdentity)],{stdio:['ignore','ignore','inherit','ipc']});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  try{
    const boundary=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('TEST child did not reach kill boundary')),10000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('message',message=>{clearTimeout(timer);message.error?reject(new Error(message.error)):resolve(message);});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('TEST child exited before kill boundary'));});
    });
    assert.equal(boundary.stage,stage);child.kill('SIGKILL');
    assert.equal((await exited).signal,'SIGKILL');
    return boundary;
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
}

// afterKill lets a test alter the journal directory between the kill and reopen.
export async function restartScenario(path,stage='broadcast',directoryIdentity,{afterKill}={}) {
  const original=await killedAt(path,stage,directoryIdentity);await afterKill?.(original);
  // Defense in depth: reopen only the journal the killed child reported.
  const h=fixture({path,directoryIdentity,mode:'open',expectedJournalId:original.journalId});
  try{
    const expected=stage==='journal'?0:1;
    const record=await h.journal.get(`devnet/native-transfer/${original.hash}`);
    assert.equal(record.hash,original.hash);assert.equal(record.signedTransaction.hash,original.hash);assert.equal(record.stage,'broadcast-started');
    assert.equal(await h.broadcastCount(),expected);
    await assert.rejects(h.capability.binding({phase:'signature',address:original.address,binding:record.networkBinding}),{code:'outcome_unknown'});
    await assert.rejects(h.capability.binding({phase:'readback',address:original.address,hash:original.hash}),{code:'journal-busy'});
    const locks=h.journal.inspectLocks();assert.equal(locks.length,1);
    // The parent waited for SIGKILL exit above. Only this dead holder's exact
    // lock is released; the issued record is never removed or rewritten.
    assert.deepEqual(h.journal.releaseAbandonedLock(locks[0]),{released:true,recordsChanged:0});
    const answer=await h.capability.binding({phase:'readback',address:original.address,hash:original.hash});
    assert.equal(answer.disposition,stage==='journal'?'pending':'included');
    assert.equal(answer.receipt?.hash ?? answer.hash,original.hash);assert.equal(answer.noResend,true);
    assert.equal(await h.broadcastCount(),expected);
    assert.equal(h.requests.every(request=>request.method==='nodeCall'),true,'restart is readback-only');
    const current=await h.journal.get(`devnet/native-transfer/${original.hash}`);
    assert.deepEqual(current.signedTransaction,record.signedTransaction);
    assert.equal(current.stage,stage==='journal'?'broadcast-started':'observed');
    return {hash:original.hash,recoveredHash:answer.receipt?.hash ?? answer.hash,disposition:answer.disposition,broadcasts:expected,
      lines:[`SIGKILL after journal retention${stage==='broadcast'?', inside the fake broadcast callback':', before transport handoff'}. Original hash: ${original.hash}.`,
        'Restart refuses signing. Dead process lock released explicitly; issued bytes retained.',
        `Same hash read back: ${answer.disposition}. Broadcasts before/after restart: ${expected}/${expected}. No resend.`]};
  }finally{await h.close();}
}
