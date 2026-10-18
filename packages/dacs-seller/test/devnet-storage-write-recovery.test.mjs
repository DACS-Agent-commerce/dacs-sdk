// Rehosted native recovery assertions; no portal/browser or live wallet needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {anchorFixture} from './helpers/anchor-isolated-fixture.mjs';
import {assertQualifiedDeployment} from '../src/devnet-demo/deployment-qualification.mjs';
import {classifyStorageWriteSubmission,storageWriteAbsent} from '../src/devnet-demo/storage-write-recovery.mjs';
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX'];
test('an observed source nonce fences stale RPC preparation, including a restarted anchor',async()=>{
 const w=await anchorFixture();await w.sourceJournal.put('included',{stage:'observed',hash:'a'.repeat(64),signedTransaction:{content:{from:w.owner,nonce:1,type:'storageProgram'}}});
 for(const anchor of [w.open(),w.open()])await assert.rejects(w.publish(anchor,JOBS[0]),/nonce RPC has not caught up/);
 assert.equal(w.captured.length,0);assert.equal(w.journal.rows.size,0);
});
test('different artifacts serialize nonce reservations and retain the floor across restart',async()=>{
 const w=await anchorFixture(),anchor=w.open();const results=await Promise.allSettled(JOBS.map(id=>w.publish(anchor,id)));
 assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(w.captured.length,1);assert.equal(w.captured[0].transaction.content.nonce,1);
 await assert.rejects(w.publish(w.open(),JOBS[1]),/nonce RPC has not caught up/);assert.equal(w.captured.length,1);
 w.controls.nonce=1;assert.equal((await w.publish(w.open(),JOBS[1])).status,'indeterminate');assert.equal(w.captured[1].transaction.content.nonce,2);
});
test('dirty, unidentified, unverified or partially qualified deployments authorize no wallet request',async()=>{
 const w=await anchorFixture();
 for(const pin of [null,{...w.source.pins.deployment,dirty:true},{...w.source.pins.deployment,artifactSha256:null},{...w.source.pins.deployment,qualifiedOperations:['nonce']}]){
  const source={...w.source,pins:{...w.source.pins,deployment:pin}};await assert.rejects(assertQualifiedDeployment(source),{code:'deployment_unqualified'});
 }
 w.source.verifyDeployment=async()=>false;await assert.rejects(w.publish(w.open(),JOBS[0]),{code:'deployment_unqualified'});assert.equal(w.captured.length,0);
});
test('relay acknowledgement is not transaction inclusion and unknown status does not prove absence',()=>{
 const hash='a'.repeat(64),relay={result:200,response:{message:'Transaction relayed to validators'},require_reply:false,extra:null};
 const result=classifyStorageWriteSubmission(relay,hash);assert.notEqual(result?.disposition,'included');
 assert.equal(storageWriteAbsent({result:200,response:{state:'unknown'},require_reply:false,extra:''}),false);
});
