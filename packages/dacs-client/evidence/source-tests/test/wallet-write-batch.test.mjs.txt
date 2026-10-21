import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

const {createWalletWriteBatch,checkWalletWriteNonce,reserveWalletWriteNonce}=await import(process.env.DACS_BATCH_TEST_MODULE?pathToFileURL(process.env.DACS_BATCH_TEST_MODULE).href:new URL('../src/wallet/write-batch.mjs',import.meta.url).href);
const wallet=`0x${'51'.repeat(32)}`,network='offline-batch',chainIdentity='fake-chain';
const lane=JSON.stringify([network,chainIdentity,wallet]);
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const dispositions=(value)=>value.writes.map((write)=>write.disposition);
const batch=(batchId='first',start=11)=>({batchId,step:'delivery',writes:Array.from({length:3},(_,index)=>({content:{from:wallet,nonce:start+index,data:['storageProgram',{artifact:index}]}}))});
const rejected=(promise,code)=>assert.rejects(promise,(error)=>{assert.equal(error.code,code);return true;});

function setup(t,{journalOptions={},options={}}={}) {
  const directory=mkdtempSync(join(tmpdir(),'wallet-batch-'));
  const path=join(directory,'journal.sqlite');
  const journal=openDurableWalletJournal({path,mode:'create',lockTimeoutMs:25,...journalOptions});
  t.after(()=>{journal.close();rmSync(directory,{recursive:true,force:true});});
  const events=[],signed=[],sent=[],reads=[];
  const chain={nonce:10,observations:new Map()};
  const callbacks={journal,network,chainIdentity,wallet,
    readNonce:async()=>{events.push('nonce');return chain.nonce;},
    sign:async(transaction,{nonce})=>{events.push(`sign:${nonce}`);signed.push(nonce);return {content:transaction.content,hash:hash(JSON.stringify(transaction.content)),signature:{type:'fake-public-test-signature',data:'offline'}};},
    verifySigned:async({transaction,signedBytes})=>JSON.stringify(JSON.parse(signedBytes).content)===JSON.stringify(transaction.content),
    broadcast:async(request)=>{events.push(`broadcast:${request.nonce}`);sent.push(structuredClone(request));return {disposition:'submitted',hash:request.hash};},
    readback:async(request)=>{reads.push(structuredClone(request));return {wallet,hash:request.hash,nonce:request.nonce,...(chain.observations.get(request.nonce) ?? {disposition:'included',proof:'fake-inclusion'})};},
    verifyIncluded:async({observation})=>observation.proof==='fake-inclusion',
    ...options};
  const wrapped={...journal,put:async(key,value)=>{await journal.put(key,value);if(key===lane)events.push(`journal:${value.writes.map((write)=>write.disposition).join(',')}`);}};
  callbacks.journal=wrapped;
  const api=createWalletWriteBatch(callbacks);
  return {journal,path,directory,events,signed,sent,reads,chain,callbacks,api,recreate:(changes={})=>createWalletWriteBatch({...callbacks,...changes})};
}

test('clean three-write batch reserves once, signs in order, journals before sending, and resolves by inclusion',async t=>{
  const f=setup(t);
  const out=await f.api.submit(batch());
  assert.equal(f.events.filter((event)=>event==='nonce').length,1);
  assert.deepEqual(f.signed,[11,12,13]);
  assert.deepEqual(f.events.slice(0,5),['nonce','sign:11','sign:12','sign:13','journal:indeterminate,indeterminate,indeterminate']);
  assert.equal(f.sent.length,3);
  assert.deepEqual(dispositions(out),['submitted','submitted','submitted']);
  for(const [index,request] of f.sent.entries()){
    assert.equal(request.signedBytes,out.writes[index].signedBytes);
    assert.equal(request.hash,out.writes[index].hash);
    assert.equal(request.nonce,11+index);
    assert.equal(JSON.parse(request.signedBytes).content.nonce,request.nonce);
  }
  assert.equal(out.stage,'batch-unresolved','HTTP acceptance alone never releases the wallet');
  assert.equal((await f.journal.get(lane)).writes.length,3);
  f.chain.nonce=13;
  await rejected(f.api.submit(batch('premature',14)),'batch-blocked');
  assert.equal(f.signed.length,3);
  const resolved=await f.api.reconcile({batchId:'first'});
  assert.deepEqual(dispositions(resolved),['included','included','included']);
  assert.equal(resolved.stage,'broadcast-accepted');
  assert.equal((await f.journal.get(lane)).stage,'broadcast-accepted');
  assert.equal(resolved.noResend,true);
  assert.equal(f.signed.length,3);assert.equal(f.sent.length,3);
  f.chain.nonce=10;
  await rejected(f.api.submit(batch('lagging-chain')),'batch-nonce-clash');
  assert.equal(f.signed.length,3);
  f.chain.nonce=13;
  await f.api.submit(batch('second',14));
  f.chain.nonce=16;
  await rejected(f.api.submit(batch('first',17)),'batch-replay');
  assert.equal(f.signed.length,6);assert.equal(f.sent.length,6);
});

test('timeout at write two fences it and the suffix, refuses new signing and never replays a batch',async t=>{
  const f=setup(t),broadcast=f.callbacks.broadcast;
  const api=f.recreate({broadcast:async(request)=>{if(request.nonce===12){f.sent.push(request);throw new Error('timeout');}return broadcast(request);}});
  const out=await api.submit(batch());
  assert.deepEqual(dispositions(out),['submitted','indeterminate','indeterminate']);
  assert.deepEqual(f.sent.map((request)=>request.nonce),[11,12]);
  f.chain.nonce=13;
  await rejected(api.submit(batch('other',14)),'batch-blocked');
  await rejected(api.submit(batch('first',14)),'batch-replay');
  assert.equal(f.signed.length,3);assert.equal(f.sent.length,2);
  assert.deepEqual(dispositions(await f.journal.get(lane)),dispositions(out));
});

test('unknown first write fences the entire signed batch without attempting the suffix',async t=>{
  const f=setup(t);
  const api=f.recreate({broadcast:async(request)=>{f.sent.push(request);throw new Error('timeout');}});
  assert.deepEqual(dispositions(await api.submit(batch())),['indeterminate','indeterminate','indeterminate']);
  assert.deepEqual(f.signed,[11,12,13]);assert.deepEqual(f.sent.map((request)=>request.nonce),[11]);
  f.chain.nonce=13;
  await rejected(api.submit(batch('other',14)),'batch-blocked');
  await rejected(api.submit(batch('first',14)),'batch-replay');
  assert.equal(f.signed.length,3);assert.equal(f.sent.length,1);
});

test('dropped connection, malformed reply and wrong hash stop every later broadcast',async t=>{
  for(const mode of ['dropped','unparseable','wrong-hash'])await t.test(mode,async s=>{
    const f=setup(s),broadcast=f.callbacks.broadcast;
    const api=f.recreate({broadcast:async(request)=>{if(request.nonce!==12)return broadcast(request);f.sent.push(request);
      if(mode==='dropped')throw new Error('ECONNRESET');
      return mode==='unparseable'?'<bad gateway>':{disposition:'submitted',hash:'00'.repeat(32)};}});
    assert.deepEqual(dispositions(await api.submit(batch())),['submitted','indeterminate','indeterminate']);
    assert.equal(f.sent.length,2);
    f.chain.nonce=13;
    await rejected(api.submit(batch('other',14)),'batch-blocked');
    assert.equal(f.signed.length,3);
  });
});

test('absence needs an explicit verified policy and a finalized nonce strictly past the write',async t=>{
  const f=setup(t),broadcast=f.callbacks.broadcast;
  const policy={id:'fake-finalized-nonce-and-absence/v1',verify:async({observation})=>observation.proof==='fake-finalized-absence'};
  const api=f.recreate({absencePolicy:policy,broadcast:async(request)=>{if(request.nonce===12){f.sent.push(request);throw new Error('timeout');}return broadcast(request);}});
  await api.submit(batch());
  f.chain.observations.set(13,{disposition:'absent',chainNonce:12,proof:'fake-finalized-absence'});
  let out=await api.reconcile({batchId:'first'});
  assert.deepEqual(dispositions(out),['included','included','indeterminate']);
  f.chain.nonce=13;
  await rejected(api.submit(batch('other',14)),'batch-blocked');
  f.chain.observations.set(13,{disposition:'absent',chainNonce:13,proof:'fake-finalized-absence'});
  out=await api.reconcile({batchId:'first'});
  assert.equal(out.stage,'batch-unresolved','equal nonce is deliberately insufficient in this slice');
  f.chain.observations.set(13,{disposition:'absent',chainNonce:14.5,proof:'fake-finalized-absence'});
  assert.equal((await api.reconcile({batchId:'first'})).stage,'batch-unresolved','fractional chain nonces are invalid');
  f.chain.observations.set(13,{disposition:'absent',chainNonce:14,proof:'fake-finalized-absence'});
  const withoutPolicy=f.recreate();
  assert.equal((await withoutPolicy.reconcile({batchId:'first'})).stage,'batch-unresolved');
  f.chain.observations.set(13,{disposition:'absent',chainNonce:14,proof:'unverified-not-found'});
  assert.equal((await api.reconcile({batchId:'first'})).stage,'batch-unresolved');
  f.chain.observations.set(13,{disposition:'absent',chainNonce:14,proof:'fake-finalized-absence'});
  out=await api.reconcile({batchId:'first'});
  assert.deepEqual(dispositions(out),['included','included','not-landed']);
  assert.equal(out.stage,'broadcast-accepted');
  f.chain.nonce=14;
  await rejected(api.submit(batch('first',15)),'batch-replay');
  assert.equal(f.signed.length,3);assert.equal(f.sent.length,2);
  f.chain.nonce=14;
  await api.submit(batch('next',15));
  assert.deepEqual(f.signed,[11,12,13,15,16,17]);
});

test('stale nonce, skipped nonce and overflow refuse a reserved clash before any signing',async t=>{
  for(const mode of ['stale','skipped','overflow','unavailable'])await t.test(mode,async s=>{
    const f=setup(s),input=batch();
    if(mode==='stale')f.chain.nonce=11;
    if(mode==='skipped')input.writes[1].content.nonce=14;
    if(mode==='overflow')f.chain.nonce=Number.MAX_SAFE_INTEGER;
    if(mode==='unavailable')f.chain.nonce=null;
    await rejected(f.api.submit(input),'batch-nonce-clash');
    assert.equal(f.signed.length,0);assert.equal(f.sent.length,0);
    assert.equal(await f.journal.get(lane),undefined);
  });
});

test('shared wallet lock excludes another writer before signing and retained single writes fence batches',async t=>{
  const f=setup(t),other=openDurableWalletJournal({path:f.path,mode:'open',lockTimeoutMs:0});t.after(()=>other.close());
  const competing=f.recreate({journal:other});
  await f.journal.withWalletLock(lane,async()=>{
    await rejected(competing.submit(batch()),'journal-busy');
    assert.equal(f.signed.length,0);assert.equal(f.sent.length,0);
  });
  await f.journal.put(lane,{stage:'broadcast-started',nonce:11});
  await rejected(f.api.submit(batch()),'batch-blocked');
  await f.journal.put(lane,{stage:'broadcast-accepted',nonce:11});
  await rejected(f.api.submit(batch()),'batch-nonce-clash');
  assert.equal(f.signed.length,0);assert.equal(f.sent.length,0);
});

test('journal write failure or inexact readback prevents every broadcast',async t=>{
  for(const mode of ['capacity','mismatch'])await t.test(mode,async s=>{
    const f=setup(s,{journalOptions:mode==='capacity'?{maxValueBytes:64}:{}});
    const api=mode==='capacity'?f.api:f.recreate({journal:{...f.journal,get:async(key)=>{const value=await f.journal.get(key);return key===lane&&value?.format?{...value,step:'wrong'}:value;}}});
    await rejected(api.submit(batch()),mode==='capacity'?'journal-capacity':'batch-journal-error');
    assert.equal(f.signed.length,3);assert.equal(f.sent.length,0);
  });
});

test('failure recording a broadcast answer stops the suffix and leaves restart readback only',async t=>{
  const f=setup(t);let puts=0;
  const api=f.recreate({journal:{...f.journal,put:async(key,value)=>{if(key===lane&&++puts===2)throw Object.assign(new Error('disk failure'),{code:'test-disk-failure'});return f.journal.put(key,value);}}});
  await rejected(api.submit(batch()),'test-disk-failure');
  assert.equal(f.sent.length,1);
  assert.deepEqual(dispositions(await f.journal.get(lane)),['indeterminate','indeterminate','indeterminate']);
  f.chain.nonce=13;
  await rejected(f.api.submit(batch('other',14)),'batch-blocked');
  assert.equal((await f.api.reconcile({batchId:'first'})).stage,'broadcast-accepted');
  assert.equal(f.sent.length,1);assert.equal(f.signed.length,3);
});

test('wrong signed bytes, hash or approved scope fail before journaling or broadcast',async t=>{
  for(const mode of ['nonce','wallet','hash','scope'])await t.test(mode,async s=>{
    const f=setup(s),original=f.callbacks.sign;
    const api=f.recreate({sign:async(...args)=>{const signed=await original(...args);if(mode==='nonce')signed.content.nonce+=1;
      if(mode==='wallet')signed.content.from=`0x${'52'.repeat(32)}`;if(mode==='hash')signed.hash='garbage';return signed;},
    verifySigned:mode==='scope'?async()=>false:async()=>true});
    await rejected(api.submit(batch()),'batch-signed-mismatch');
    assert.equal(f.sent.length,0);assert.equal(await f.journal.get(lane),undefined);
  });
});

test('unverified inclusion, mismatched identity and failed readback never release the whole wallet',async t=>{
  for(const mode of ['proof','hash','wallet','nonce','throw'])await t.test(mode,async s=>{
    const f=setup(s);await f.api.submit(batch());
    const readback=f.callbacks.readback;
    const api=f.recreate({readback:async(request)=>{if(request.nonce!==12)return readback(request);if(mode==='throw')throw new Error('offline');
      return {...await readback(request),...(mode==='proof'?{proof:'unverified'}:mode==='hash'?{hash:'00'.repeat(32)}:mode==='wallet'?{wallet:`0x${'52'.repeat(32)}`}:{nonce:13})};}});
    assert.deepEqual(dispositions(await api.reconcile({batchId:'first'})),['included','indeterminate','included']);
    f.chain.nonce=13;
    await rejected(api.submit(batch('other',14)),'batch-blocked');
    assert.equal(f.signed.length,3);assert.equal(f.sent.length,3);
  });
});

test('reopened journals preserve unresolved fences and exact bytes; malformed records fail closed',async t=>{
  const f=setup(t);await f.api.submit(batch());
  const reopened=openDurableWalletJournal({path:f.path,mode:'open',expectedJournalId:f.journal.journalId});t.after(()=>reopened.close());
  const api=f.recreate({journal:reopened});
  f.chain.nonce=13;
  await rejected(api.submit(batch('other',14)),'batch-blocked');
  const retained=await reopened.get(lane);
  await reopened.put(lane,{...retained,writes:retained.writes.map((write,index)=>index===1?{...write,signedBytes:write.signedBytes+' '}:write)});
  await rejected(api.reconcile({batchId:'first'}),'batch-journal-invalid');
  assert.equal(f.reads.length,0);
  await reopened.put(lane,{...retained,stage:'broadcast-accepted'});
  await rejected(api.submit(batch('other',14)),'batch-journal-invalid');
  await reopened.put(lane,retained);
  const out=await api.reconcile({batchId:'first'});
  assert.equal(out.stage,'broadcast-accepted');
  assert.deepEqual(f.reads.map((request)=>request.signedBytes),retained.writes.map((write)=>write.signedBytes));
  assert.equal(f.signed.length,3);assert.equal(f.sent.length,3);
});

test('process crash after durable journal and before broadcast stays blocked on restart, then uses readback only',{timeout:15000},async t=>{
  const f=setup(t);
  const child=fork(new URL('./helpers/wallet-write-batch-child.mjs',import.meta.url),[f.path],{execArgv:['--disable-warning=ExperimentalWarning'],stdio:['ignore','ignore','pipe','ipc']});
  const exited=new Promise((resolve)=>child.once('exit',resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  const checkpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('child checkpoint timeout')),5000);
    child.once('message',(message)=>{clearTimeout(timer);resolve(message);});child.once('error',(error)=>{clearTimeout(timer);reject(error);});});
  assert.equal(checkpoint.event,'journaled');assert.equal(checkpoint.writes,3);
  child.kill('SIGKILL');await exited;
  assert.deepEqual(dispositions(await f.journal.get(lane)),['indeterminate','indeterminate','indeterminate']);
  await rejected(f.api.submit(batch('other')),'journal-busy');
  const [lock]=f.journal.inspectLocks();
  assert.equal(lock.key,lane);
  assert.deepEqual(f.journal.releaseAbandonedLock({key:lock.key,instance:lock.instance,fence:lock.fence}),{released:true,recordsChanged:0});
  const reopened=openDurableWalletJournal({path:f.path,mode:'open',expectedJournalId:f.journal.journalId});t.after(()=>reopened.close());
  const api=f.recreate({journal:reopened,absencePolicy:{id:'fake-finalized-nonce-and-absence/v1',verify:async({observation})=>observation.proof==='fake-finalized-absence'}});
  f.chain.nonce=13;
  await rejected(api.submit(batch('other',14)),'batch-blocked');
  for(const nonce of [11,12,13])f.chain.observations.set(nonce,{disposition:'absent',chainNonce:10,proof:'fake-finalized-absence'});
  assert.deepEqual(dispositions(await api.reconcile({batchId:'first'})),['indeterminate','indeterminate','indeterminate']);
  await rejected(api.submit(batch('other',14)),'batch-blocked');
  for(const nonce of [11,12,13])f.chain.observations.set(nonce,{disposition:'absent',chainNonce:14,proof:'fake-finalized-absence'});
  const resolved=await api.reconcile({batchId:'first'});
  assert.equal(resolved.stage,'broadcast-accepted');
  assert.deepEqual(dispositions(resolved),['not-landed','not-landed','not-landed']);
  assert.equal(f.signed.length,0);assert.equal(f.sent.length,0);
});

test('resolved history survives an intervening single-write lane and cannot be replayed',async t=>{
  const f=setup(t);await f.api.submit(batch());await f.api.reconcile({batchId:'first'});
  await f.journal.put(lane,{stage:'broadcast-accepted',nonce:14});
  f.chain.nonce=14;
  await rejected(f.api.submit(batch('first',15)),'batch-replay');
  assert.equal((await f.api.reconcile({batchId:'first'})).stage,'broadcast-accepted');
  assert.deepEqual(await f.journal.get(lane),{stage:'broadcast-accepted',nonce:14});
  assert.equal(f.signed.length,3);assert.equal(f.sent.length,3);
});

test('durable nonce floor survives a lagging single-write replacement and restart',async t=>{
  const f=setup(t);f.chain.nonce=0;
  await f.api.submit(batch('first',1));await f.api.reconcile({batchId:'first'});
  // The unchanged single-write adapter can overwrite a released lane on a lagging node.
  await f.journal.withWalletLock(lane,()=>f.journal.put(lane,{stage:'broadcast-accepted',nonce:1}));
  const reopened=openDurableWalletJournal({path:f.path,mode:'open',expectedJournalId:f.journal.journalId});t.after(()=>reopened.close());
  const api=f.recreate({journal:reopened});f.chain.nonce=1;
  await rejected(api.submit(batch('different',2)),'batch-nonce-clash');
  assert.deepEqual(f.signed,[1,2,3]);assert.equal(f.sent.length,3);
  f.chain.nonce=3;
  await api.submit(batch('fresh',4));
  assert.deepEqual(f.signed,[1,2,3,4,5,6]);
});

test('highest authenticated absence nonce survives resolution and restart',async t=>{
  const f=setup(t);await f.api.submit(batch());
  const absencePolicy={id:'fake-finalized-absence/v1',verify:async({observation})=>observation.proof==='fake-finalized-absence'};
  for(const [nonce,chainNonce] of [[11,14],[12,20],[13,15]])f.chain.observations.set(nonce,{disposition:'absent',chainNonce,proof:'fake-finalized-absence'});
  assert.deepEqual(dispositions(await f.recreate({absencePolicy}).reconcile({batchId:'first'})),['not-landed','not-landed','not-landed']);
  const reopened=openDurableWalletJournal({path:f.path,mode:'open',expectedJournalId:f.journal.journalId});t.after(()=>reopened.close());
  const api=f.recreate({journal:reopened});
  for(const stale of [13,19]){
    f.chain.nonce=stale;
    await rejected(api.submit(batch(`stale-${stale}`,stale+1)),'batch-nonce-clash');
  }
  assert.equal(f.signed.length,3);assert.equal(f.sent.length,3);
  f.chain.nonce=20;await api.submit(batch('fresh',21));
  assert.deepEqual(f.signed,[11,12,13,21,22,23]);
});

test('committed resolved archive repairs the lane after a failed final lane commit without readback',async t=>{
  const f=setup(t);await f.api.submit(batch());
  const api=f.recreate({journal:{...f.journal,put:async(key,value)=>{
    if(key===lane&&value.stage==='broadcast-accepted')throw Object.assign(new Error('crash between commits'),{code:'test-disk-failure'});
    return f.journal.put(key,value);
  }}});
  await rejected(api.reconcile({batchId:'first'}),'test-disk-failure');
  assert.equal((await f.journal.get(lane)).stage,'batch-unresolved');
  assert.equal((await f.journal.entries()).filter(([key,value])=>key.startsWith('wallet-batch/')&&value.stage==='broadcast-accepted').length,1);
  const reopened=openDurableWalletJournal({path:f.path,mode:'open',expectedJournalId:f.journal.journalId});t.after(()=>reopened.close());
  const reads=f.reads.length;
  const recovered=f.recreate({journal:reopened,readback:async()=>{throw new Error('readback unavailable');}});
  assert.equal((await recovered.reconcile({batchId:'first'})).stage,'broadcast-accepted');
  assert.equal((await reopened.get(lane)).stage,'broadcast-accepted');
  assert.equal(f.reads.length,reads);assert.equal(f.signed.length,3);assert.equal(f.sent.length,3);
});

test('single-write nonce check enforces both durable floors under the existing lock without mutations',async t=>{
  const f=setup(t);await f.api.submit(batch());
  const check=(baseNonce,nonce=baseNonce+1)=>f.journal.withWalletLock(lane,()=>checkWalletWriteNonce({journal:f.journal,network,chainIdentity,wallet,baseNonce,nonce}));
  const before=await f.journal.entries();
  await rejected(check(10),'batch-nonce-clash');
  assert.equal(await check(13),true);
  await rejected(check(13,13),'batch-nonce-clash');
  await rejected(check(null,14),'batch-nonce-clash');
  assert.deepEqual(await f.journal.entries(),before);
  for(const nonce of [11,12,13])f.chain.observations.set(nonce,{disposition:'absent',chainNonce:20,proof:'fake-finalized-absence'});
  await f.recreate({absencePolicy:{id:'fake-finalized-absence/v1',verify:async({observation})=>observation.proof==='fake-finalized-absence'}}).reconcile({batchId:'first'});
  await rejected(check(19),'batch-nonce-clash');assert.equal(await check(20),true);
  assert.equal(f.signed.length,3);assert.equal(f.sent.length,3);
});

test('authenticated nonce evidence persists for a partially resolved batch and ignores untrusted advances',async t=>{
  const f=setup(t);await f.api.submit(batch());
  f.chain.observations.set(11,{disposition:'absent',chainNonce:20,proof:'fake-finalized-absence'});
  f.chain.observations.set(12,{disposition:'absent',chainNonce:100,proof:'untrusted'});
  f.chain.observations.set(13,{disposition:'absent',chainNonce:200,proof:'untrusted'});
  const api=f.recreate({absencePolicy:{id:'fake-finalized-absence/v1',verify:async({observation})=>observation.proof==='fake-finalized-absence'}});
  assert.deepEqual(dispositions(await api.reconcile({batchId:'first'})),['not-landed','indeterminate','indeterminate']);
  const reopened=openDurableWalletJournal({path:f.path,mode:'open',expectedJournalId:f.journal.journalId});t.after(()=>reopened.close());
  const check=baseNonce=>reopened.withWalletLock(lane,()=>checkWalletWriteNonce({journal:reopened,network,chainIdentity,wallet,baseNonce,nonce:baseNonce+1}));
  await rejected(check(19),'batch-nonce-clash');assert.equal(await check(20),true);
  f.chain.observations.set(12,{disposition:'included',proof:'fake-inclusion'});
  f.chain.observations.set(13,{disposition:'included',proof:'fake-inclusion'});
  await api.reconcile({batchId:'first'});
  await rejected(check(19),'batch-nonce-clash');assert.equal(await check(20),true);
  assert.equal(f.signed.length,3);assert.equal(f.sent.length,3);
});

test('archive recovery requires exactly matching identity and bytes and preserves terminal dispositions',async t=>{
  for(const mismatch of ['step','baseNonce','bytes','terminal'])await t.test(mismatch,async s=>{
    const f=setup(s);await f.api.submit(batch());
    const original=await f.journal.get(lane);
    const resolved=await f.api.reconcile({batchId:'first'});
    const {noResend,...archived}=resolved;
    const archiveKey=(await f.journal.entries()).find(([key])=>key.startsWith('wallet-batch/'))[0];
    if(mismatch==='step')archived.step='other-step';
    if(mismatch==='baseNonce'){
      archived.baseNonce=20;
      archived.writes=archived.writes.map((write,index)=>{
        const signed=JSON.parse(write.signedBytes);signed.content.nonce=21+index;
        const signedBytes=JSON.stringify(signed);return {...write,nonce:21+index,signedBytes,bytesHash:hash(signedBytes)};
      });
    }
    if(mismatch==='bytes')archived.writes[0]={...archived.writes[0],signedBytes:archived.writes[0].signedBytes+' ',bytesHash:hash(archived.writes[0].signedBytes+' ')};
    const retained=mismatch==='terminal'?{...original,writes:original.writes.map((write,index)=>index===0?{...write,disposition:'not-landed'}:write)}:original;
    await f.journal.put(lane,retained);await f.journal.put(archiveKey,archived);
    const reads=f.reads.length;
    await rejected(f.api.reconcile({batchId:'first'}),'batch-journal-invalid');
    assert.deepEqual(await f.journal.get(lane),retained);assert.equal(f.reads.length,reads);
    assert.equal(f.signed.length,3);assert.equal(f.sent.length,3);
  });
});

test('nonce floor persistence failure or corrupt floor stops before any broadcast or new signing',async t=>{
  for(const mode of ['write','readback','corrupt'])await t.test(mode,async s=>{
    const f=setup(s);
    if(mode==='corrupt'){
      await f.api.submit(batch());await f.api.reconcile({batchId:'first'});
      const [key,floor]=(await f.journal.entries()).find(([key])=>key.startsWith('wallet-batch-nonce/'));
      await f.journal.put(key,{...floor,chainNonce:-1});f.chain.nonce=13;
      await rejected(f.api.submit(batch('fresh',14)),'batch-journal-invalid');
      assert.equal(f.signed.length,3);assert.equal(f.sent.length,3);return;
    }
    const api=f.recreate({journal:{...f.journal,
      put:async(key,value)=>{if(mode==='write'&&key.startsWith('wallet-batch-nonce/'))throw Object.assign(new Error('floor write failed'),{code:'test-disk-failure'});return f.journal.put(key,value);},
      get:async(key)=>{const value=await f.journal.get(key);return mode==='readback'&&key.startsWith('wallet-batch-nonce/')&&value?{...value,reservedNonce:0}:value;}}});
    await rejected(api.submit(batch()),mode==='write'?'test-disk-failure':'batch-journal-error');
    assert.equal(f.signed.length,3);assert.equal(f.sent.length,0);
    assert.deepEqual(dispositions(await f.journal.get(lane)),['indeterminate','indeterminate','indeterminate']);
    f.chain.nonce=13;
    await rejected(f.api.submit(batch('other',14)),'batch-blocked');
  });
});

test('prefix adapter contract documents and forwards durable identity and logical entries',async t=>{
  const f=setup(t),prefix='demo/wallet/';
  const legacy={get:key=>f.journal.get(prefix+key),put:(key,value)=>f.journal.put(prefix+key,value),withWalletLock:(key,work)=>f.journal.withWalletLock(prefix+key,work)};
  assert.throws(()=>f.recreate({journal:legacy}),/explicit durable wallet journal/);
  const doc=readFileSync(new URL('../docs/WALLET-WRITE-BATCH.md',import.meta.url),'utf8');
  assert.match(doc,/journalId/,'the documented prefix adapter must forward journalId');
  assert.match(doc,/entries\(\)/,'the documented prefix adapter must enumerate logical entries');
  const journal={...legacy,journalId:f.journal.journalId,entries:async()=>
    (await f.journal.entries()).filter(([key])=>key.startsWith(prefix)).map(([key,value])=>[key.slice(prefix.length),value])};
  const api=f.recreate({journal});await api.submit(batch());await api.reconcile({batchId:'first'});
  assert.equal(await f.journal.get(lane),undefined);
  assert.equal((await f.journal.get(prefix+lane)).stage,'broadcast-accepted');
  assert.equal((await journal.entries()).some(([key])=>key.startsWith(prefix)),false);
});

test('process crash checkpoints cover before journal, after journal, sends, acknowledgements and archive',{timeout:60000},async t=>{
  for(const checkpoint of ['before-journal','after-journal','before-first-broadcast','after-send-1','after-ack-1','mid-batch','after-archive'])await t.test(checkpoint,async s=>{
    const f=setup(s);
    const child=fork(new URL('./helpers/wallet-write-batch-child.mjs',import.meta.url),[f.path,checkpoint],{execArgv:['--disable-warning=ExperimentalWarning'],stdio:['ignore','ignore','pipe','ipc']});
    const exited=new Promise(resolve=>child.once('exit',resolve));
    s.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
    const message=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('child checkpoint timeout')),5000);
      child.once('message',value=>{clearTimeout(timer);resolve(value);});child.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    assert.equal(message.event,checkpoint);
    child.kill('SIGKILL');await exited;
    const retained=await f.journal.get(lane);
    assert.deepEqual(message.sent,checkpoint==='after-archive'?[11,12,13]:checkpoint==='mid-batch'?[11,12]:['after-send-1','after-ack-1'].includes(checkpoint)?[11]:[]);
    if(checkpoint==='before-journal')assert.equal(retained,undefined);
    else assert.deepEqual(dispositions(retained),checkpoint==='after-archive'?['submitted','submitted','submitted']:checkpoint==='mid-batch'?['submitted','submitted','indeterminate']:checkpoint==='after-ack-1'?['submitted','indeterminate','indeterminate']:['indeterminate','indeterminate','indeterminate']);
    const [lock]=f.journal.inspectLocks();assert.equal(lock.key,lane);
    f.journal.releaseAbandonedLock({key:lock.key,instance:lock.instance,fence:lock.fence});
    const reopened=openDurableWalletJournal({path:f.path,mode:'open',expectedJournalId:f.journal.journalId});s.after(()=>reopened.close());
    const api=f.recreate({journal:reopened,readback:checkpoint==='after-archive'?async()=>{throw new Error('unavailable');}:f.callbacks.readback});
    f.chain.nonce=13;
    if(checkpoint==='before-journal')await rejected(api.reconcile({batchId:'first'}),'batch-not-found');
    else {
      if(checkpoint!=='after-archive')await rejected(api.submit(batch('other',14)),'batch-blocked');
      const resolved=await api.reconcile({batchId:'first'});
      assert.equal(resolved.stage,'broadcast-accepted');assert.deepEqual(dispositions(resolved),['included','included','included']);
      assert.equal((await reopened.get(lane)).stage,'broadcast-accepted');
      await rejected(api.submit(batch('first',14)),'batch-replay');
    }
    assert.equal(f.signed.length,0);assert.equal(f.sent.length,0);
  });
});

// Real packaged SDK signing and unchanged wallet session, with every RPC
// method replaced in-process. No sockets, live node, funds or retry transport.
async function singleReservationFixture(t) {
  globalThis.window ??= globalThis;
  globalThis.document ??= {baseURI:'http://127.0.0.1/portal/assets/embedded-wallet/',currentScript:null};
  globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
  const {Demos,validateMnemonic}=await import('../public/portal/embedded-wallet/demos-runtime.mjs');
  const shipped=await import('../public/portal/embedded-wallet/sdk-provider.mjs');
  const {anchorRequest}=await import('./helpers/dacs-storage-anchor-wallet-fixture.mjs');
  const directory=mkdtempSync(join(tmpdir(),'wallet-single-reservation-'));
  const path=join(directory,'journal.sqlite');
  let journal=openDurableWalletJournal({path,mode:'create',lockTimeoutMs:0});
  t.after(()=>{journal.close();rmSync(directory,{recursive:true,force:true});});
  const chainIdentity=shipped.DACS_STORAGE_ANCHOR_CHAIN_IDENTITY;
  const state={nonce:0,signed:[],sent:[],batchSigned:[],batchSent:[],guardErrors:[]};
  let address,lane;
  class OfflineDemos extends Demos {
    async connect(url) {this.rpc_url=url;return true;}
    async nodeCall(message) {
      if(message==='getAddressNonce')return state.nonce;
      if(message==='getNetworkInfo')return {simulated:true,chainIdentity,forks:{osDenomination:{activated:true}}};
      if(message==='getNetworkParameters')return {networkFee:2,rpcFee:3};
      throw new Error(`unexpected offline RPC: ${message}`);
    }
    async sign(transaction,options) {
      // The SDK session owns the same SQLite wallet lock here. This hook is
      // test-only wallet integration integration, after nonce validation and before signing.
      try {await reserveWalletWriteNonce({journal,network,chainIdentity,wallet:address,baseNonce:state.nonce,nonce:options.nonce});}
      catch(error){state.guardErrors.push(error.code);throw error;}
      const signed=await super.sign(transaction,options);
      state.signed.push(signed.content.nonce);return signed;
    }
    async confirm(transaction) {return {result:200,response:{data:{valid:true,transaction:structuredClone(transaction)}}};}
    async broadcast(validity) {state.sent.push(structuredClone(validity.response.data.transaction));return {result:200};}
  }
  const makeSession=()=>shipped.createSdkWalletSession({DemosCtor:OfflineDemos,validateMnemonic,anchorJournal:journal,
    transactionTransport:{profile:'simulated-loopback',network,rpcUrl:'http://127.0.0.1:9/portal/api/wallet-rpc'},approve:async()=>true});
  let session=makeSession();address=(await session.create()).address;
  lane=JSON.stringify([network,chainIdentity,address]);
  const mnemonic=session.exportMnemonicForUser();
  t.after(()=>session.lock());
  const callbacks={network,chainIdentity,wallet:address,readNonce:async()=>state.nonce,
    sign:async tx=>{state.batchSigned.push(tx.content.nonce);return {content:tx.content,hash:hash(JSON.stringify(tx.content))};},verifySigned:async()=>true,
    broadcast:async({hash,nonce})=>{state.batchSent.push(nonce);return {disposition:'submitted',hash};},
    readback:async({hash,nonce})=>({disposition:'included',wallet:address,hash,nonce}),verifyIncluded:async()=>true};
  const api=()=>createWalletWriteBatch({...callbacks,journal});
  const plan=(id,start)=>({...batch(id,start),writes:batch(id,start).writes.map(tx=>({content:{...tx.content,from:address}}))});
  await api().submit(plan('first',1));await api().reconcile({batchId:'first'});
  const send=async(nonce,id)=>{
    const result=await session.request({method:'sendTransaction',params:[anchorRequest(address,network,{nonce,logicalAddress:`dacs3:agreement:${id}`})]});
    if(!result.success)throw Object.assign(new Error(result.error.message),{code:result.error.code});
    return result;
  };
  return {state,send,api,plan,lane,journal:()=>journal,
    floor:async()=>(await journal.entries()).find(([key])=>key.startsWith('wallet-batch-nonce/'))[1],
    reopen:async()=>{session.lock();const journalId=journal.journalId;journal.close();
      journal=openDurableWalletJournal({path,mode:'open',expectedJournalId:journalId,lockTimeoutMs:0});
      session=makeSession();await session.importMnemonic(mnemonic);}};
}

test('single reservations reject a lagging replacement after singles 4 and 5 and prevent batch nonce reuse on restart',async t=>{
  const f=await singleReservationFixture(t);
  f.state.nonce=3;await f.send(4,'single-four');
  f.state.nonce=4;await f.send(5,'single-five');
  f.state.nonce=3;
  let staleError;
  try {await f.send(4,'stale-four');}catch(error){staleError=error;}
  const floorBeforeRestart=(await f.floor()).reservedNonce;
  await f.reopen();f.state.nonce=4;
  let batchError;
  try {await f.api().submit(f.plan('different',5));}catch(error){batchError=error;}
  t.diagnostic(JSON.stringify({singleNonces:f.state.signed,singleBroadcasts:f.state.sent.map(tx=>tx.content.nonce),
    floorBeforeRestart,batchSigned:f.state.batchSigned,batchBroadcasts:f.state.batchSent,staleRejected:!!staleError,batchRejected:!!batchError}));
  assert.equal(staleError?.code,'sdk_error','lagging single must fail in the reservation hook before signing');
  assert.equal(batchError?.code,'batch-nonce-clash');
  assert.deepEqual(f.state.signed,[4,5]);assert.equal(f.state.sent.length,2);
  assert.deepEqual(f.state.guardErrors,['batch-nonce-clash']);
  assert.equal((await f.floor()).reservedNonce,5);
  f.state.nonce=5;await f.api().submit(f.plan('fresh',6));
  assert.deepEqual(f.state.batchSigned,[1,2,3,6,7,8]);
  assert.deepEqual(f.state.batchSent,[1,2,3,6,7,8]);
});

test('single reservations reject a second payload and exact signed replay at nonce 4 after restart',async t=>{
  const f=await singleReservationFixture(t);
  f.state.nonce=3;await f.send(4,'single-four');
  assert.equal((await f.journal().get(f.lane)).stage,'broadcast-accepted');
  const original=f.state.sent[0];await f.reopen();
  for(const id of ['second-payload','single-four']){
    await assert.rejects(async()=>{
      const result=await f.send(4,id);
      t.diagnostic(JSON.stringify({acceptedAfterRestart:true,duplicateNonce:result.data.nonce,reservedNonce:(await f.floor()).reservedNonce}));
    },error=>{assert.equal(error.code,'sdk_error');return true;});
  }
  // The same nonce guard must also refuse replay of the exact retained bytes.
  await rejected(f.journal().withWalletLock(f.lane,async()=>{
    await reserveWalletWriteNonce({journal:f.journal(),network,chainIdentity:JSON.parse(f.lane)[1],
      wallet:original.content.from,baseNonce:3,nonce:original.content.nonce});
    f.state.sent.push(original);
  }),'batch-nonce-clash');
  assert.deepEqual(f.state.signed,[4]);assert.equal(f.state.sent.length,1);
  assert.deepEqual(f.state.guardErrors,['batch-nonce-clash','batch-nonce-clash']);
  assert.equal((await f.floor()).reservedNonce,4);
});

test('single reservation validates the successor and consumes it durably even without signing',async t=>{
  const f=setup(t);
  const reserve=(baseNonce,nonce=baseNonce+1,journal=f.journal)=>journal.withWalletLock(lane,()=>
    reserveWalletWriteNonce({journal,network,chainIdentity,wallet,baseNonce,nonce}));
  for(const [baseNonce,nonce] of [[null,1],[-1,0],[0,0],[0,2],[0,1.5],[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1]]){
    await rejected(reserve(baseNonce,nonce),'batch-nonce-clash');
    assert.deepEqual(await f.journal.entries(),[]);
  }
  const other=openDurableWalletJournal({path:f.path,mode:'open',lockTimeoutMs:0});t.after(()=>other.close());
  await f.journal.withWalletLock(lane,async()=>{
    await rejected(reserve(0,1,other),'journal-busy');
    assert.deepEqual(await f.journal.entries(),[]);
  });
  assert.equal(await reserve(0),true);
  const [key,first]=(await f.journal.entries())[0];
  assert.equal(first.reservedNonce,1);assert.equal(first.chainNonce,0);
  await rejected(reserve(0),'batch-nonce-clash');
  assert.equal(await reserve(1),true);
  assert.equal((await f.journal.get(key)).reservedNonce,2);
  const reopened=openDurableWalletJournal({path:f.path,mode:'open',expectedJournalId:f.journal.journalId});t.after(()=>reopened.close());
  await rejected(reserve(1,2,reopened),'batch-nonce-clash');
  await rejected(reserve(0,1,reopened),'batch-nonce-clash');
  // No lane record exists: the independent floor alone refuses batch reuse.
  assert.equal(await reopened.get(lane),undefined);f.chain.nonce=1;
  await rejected(f.recreate({journal:reopened}).submit(batch('stale',2)),'batch-nonce-clash');
  assert.equal(f.signed.length,0);assert.equal(f.sent.length,0);
  f.chain.nonce=2;await f.recreate({journal:reopened}).submit(batch('fresh',3));
  assert.deepEqual(f.signed,[3,4,5]);assert.equal((await reopened.get(key)).reservedNonce,5);
});

test('single reservation refuses stale authenticated chain evidence and preserves its maximum',async t=>{
  const f=setup(t);await f.api.submit(batch());
  for(const nonce of [11,12,13])f.chain.observations.set(nonce,{disposition:'absent',chainNonce:20,proof:'fake-finalized-absence'});
  await f.recreate({absencePolicy:{id:'fake-finalized-absence/v1',verify:async({observation})=>observation.proof==='fake-finalized-absence'}}).reconcile({batchId:'first'});
  const [key]=(await f.journal.entries()).find(([key])=>key.startsWith('wallet-batch-nonce/'));
  const reserve=baseNonce=>f.journal.withWalletLock(lane,()=>reserveWalletWriteNonce({journal:f.journal,network,chainIdentity,wallet,baseNonce,nonce:baseNonce+1}));
  await rejected(reserve(19),'batch-nonce-clash');assert.equal(await reserve(20),true);
  assert.deepEqual(await f.journal.get(key),{format:'dacs-wallet-write-batch-nonce/v1',lane,reservedNonce:21,chainNonce:20});
  await rejected(reserve(20),'batch-nonce-clash');
});

test('single reservation persistence errors prevent signing and broadcast and consume a committed floor',async t=>{
  for(const mode of ['write','readback','corrupt'])await t.test(mode,async s=>{
    const f=setup(s);let stored=false,signs=0,broadcasts=0;
    if(mode==='corrupt')await f.journal.put(`wallet-batch-nonce/${hash(lane)}`,{format:'dacs-wallet-write-batch-nonce/v1',lane,reservedNonce:0,chainNonce:-1});
    const journal={...f.journal,
      put:async(key,value)=>{if(mode==='write')throw Object.assign(new Error('floor write failed'),{code:'test-disk-failure'});
        await f.journal.put(key,value);stored=true;},
      get:async key=>{const value=await f.journal.get(key);return mode==='readback'&&stored?{...value,reservedNonce:0}:value;}};
    await rejected(journal.withWalletLock(lane,async()=>{
      await reserveWalletWriteNonce({journal,network,chainIdentity,wallet,baseNonce:0,nonce:1});
      signs+=1;broadcasts+=1;
    }),mode==='write'?'test-disk-failure':mode==='corrupt'?'batch-journal-invalid':'batch-journal-error');
    assert.equal(signs,0);assert.equal(broadcasts,0);
    if(mode==='readback'){
      // The actual SQLite commit succeeded even though the adapter reread did
      // not match. A fresh adapter after reopen must still refuse that nonce.
      const reopened=openDurableWalletJournal({path:f.path,mode:'open',expectedJournalId:f.journal.journalId});s.after(()=>reopened.close());
      await rejected(reopened.withWalletLock(lane,()=>reserveWalletWriteNonce({journal:reopened,network,chainIdentity,wallet,baseNonce:0,nonce:1})),'batch-nonce-clash');
    }
  });
});
