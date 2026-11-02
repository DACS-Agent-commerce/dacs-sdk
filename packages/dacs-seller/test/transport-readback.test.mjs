import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import {agentFixture} from './helpers/seller-agent-isolated-fixture.mjs';
import {commitmentFixture} from './helpers/commitment-fixture.mjs';
import {JOB} from './helpers/protocol-fixture.mjs';
import {JOBS} from './helpers/bilateral-vet-fixture.mjs';
const jobId=JOBS[0],HASH='a'.repeat(64);
function command(w,path,body){const rawBody=Buffer.from(JSON.stringify(body));return{body,rawBody,request:{method:'POST',path,jobId,buyer:w.buyer.claim,seller:w.seller.claim,listingPin:w.pin,agreementHash:w.agent.durableSessionOf(jobId).agreementHash,bodyHash:core.sha256Hex(rawBody)}};}
const payment=w=>({jobId,txHash:HASH,payerPayingKey:w.buyer.claim});

// review rvc C-1 / rvd D-1 / cold-d0e148d F2 / cold2-d0e148d F1 (P2).
test('read-only recovery authenticates a delivered fixture payment without signing, claiming or writing',async()=>{
 const w=await agentFixture({lifecycle:true});
 try{
  await w.agent.commit({jobId});const delivered=await w.agent.submitPayment(payment(w));assert.equal(delivered.status,'delivered');
  for(const reopen of [false,true]){
   if(reopen)await w.reopen();
   const writes=w.anchors.writes.length,out=await w.agent.reconcileTransport({...command(w,'/dacs/v1/payments',payment(w)),readOnly:true});
   assert.equal(out.disposition,'present',JSON.stringify(out));assert.deepEqual(out.value,delivered);assert.equal(w.anchors.writes.length,writes);
  }
  const address=w.protocol.deliveryEvidenceAddress(jobId),writes=w.anchors.writes.length;
  w.anchors.controls.read=(row,at)=>at===address?{...row,artifact:{...row.artifact,deliverableContentHash:'f'.repeat(64)}}:row;
  assert.equal((await w.agent.reconcileTransport({...command(w,'/dacs/v1/payments',payment(w)),readOnly:true})).disposition,'indeterminate');
  w.anchors.controls.read=row=>row;w.controls.observation={status:'failed'};
  assert.equal((await w.agent.reconcileTransport({...command(w,'/dacs/v1/payments',payment(w)),readOnly:true})).disposition,'indeterminate','a failed fresh transfer establishes nothing');
  assert.equal(w.anchors.writes.length,writes);
 }finally{w.close();}
});
test('read-only recovery of interrupted fixture payment work completes nothing; a live run then finishes it once',async()=>{
 const w=await agentFixture({lifecycle:true});
 try{
  await w.agent.commit({jobId});const address=core.paymentEvidenceAddress(jobId,'demos-native:DEM',2);w.anchors.controls.failAfterWrite=address;
  await assert.rejects(w.agent.submitPayment(payment(w)));await w.reopen();
  const writes=w.anchors.writes.length,read=await w.agent.reconcileTransport({...command(w,'/dacs/v1/payments',payment(w)),readOnly:true});
  assert.equal(read.disposition,'indeterminate');assert.equal(w.anchors.writes.length,writes);assert.equal(w.agent.durableSessionOf(jobId).payment,undefined);
  assert.equal((await w.agent.reconcileTransport(command(w,'/dacs/v1/payments',payment(w)))).value.status,'delivered');
  assert.equal(w.anchors.writes.filter(a=>a===address).length,1);
 }finally{w.close();}
});
// rvd D-1/D-2, cold2-d0e148d F2 (P2): coded reasons that keep the reader's cause.
for(const failure of ['reader','timeout'])test(`read-only commitment recovery keeps a ${failure} Agreement readback cause`,async()=>{
 const w=await agentFixture({lifecycle:true});
 try{
  await w.agent.commit({jobId});const address=core.fixedPriceAgreementLogicalAddress(jobId),cause=failure==='timeout'?new DOMException('TEST read timed out','TimeoutError'):new Error('TEST reader down');
  w.anchors.controls.read=(row,at)=>{if(at===address)throw cause;return row;};
  const out=await w.agent.reconcileTransport({...command(w,'/dacs/v1/commitments',{jobId}),readOnly:true});
  assert.deepEqual([out.disposition,out.reason,out.causeCode],['indeterminate','substrate_unavailable',failure]);
  assert.equal(typeof out.reason,'string');assert.ok([out.cause?.cause,out.cause?.cause?.cause].includes(cause),'the original cause is kept');
 }finally{w.close();}
});
for(const status of ['absent','indeterminate','rejected'])test(`native Agreement reconciliation preserves ${status} classification and actual cause`,async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare(),cause=new Error('TEST authenticated reader '+status);f.controls.read=()=>({disposition:status,cause});
 const body={jobId:JOB},rawBody=Buffer.from(JSON.stringify(body)),request={method:'POST',path:'/dacs/v1/commitments',jobId:JOB,buyer:agent.durableSessionOf(JOB).buyerBundle.presentedBy,seller:agent.claim,listingPin:agent.listingPin,agreementHash:agent.durableSessionOf(JOB).agreementHash,bodyHash:core.sha256Hex(rawBody)};
 const out=await agent.reconcileTransport({request,body,rawBody,readOnly:true});assert.equal(out.disposition,'indeterminate');
 assert.equal(out.reason,status==='absent'?'agreement_not_anchored':status==='rejected'?'agreement_anchor_invalid':'substrate_unavailable');if(status!=='absent')assert.equal(out.cause?.cause,cause);assert.equal(f.local.writes.length,0);
});
for(const malformed of ['member','prototype'])test(`native Agreement readback still rejects a non-JSON ${malformed} beside its cause`,async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare(),cause=new Error('TEST retained diagnostic');
 f.controls.read=()=>malformed==='member'?{disposition:'rejected',cause,extra:()=>{}}:Object.assign(Object.create({unexpected:true}),{disposition:'rejected',cause});
 const body={jobId:JOB},rawBody=Buffer.from(JSON.stringify(body)),session=agent.durableSessionOf(JOB),request={method:'POST',path:'/dacs/v1/commitments',jobId:JOB,buyer:session.buyerBundle.presentedBy,seller:agent.claim,listingPin:agent.listingPin,agreementHash:session.agreementHash,bodyHash:core.sha256Hex(rawBody)};
 const out=await agent.reconcileTransport({request,body,rawBody,readOnly:true});
 assert.equal(out.disposition,'indeterminate');assert.equal(out.reason,'substrate_unavailable');assert.ok(out.cause.cause instanceof TypeError);assert.notEqual(out.cause.cause,cause);assert.equal(f.local.writes.length,0);
});

// Agreed plan step 4: commitment adoption is validated on a copy and saved once.
test('a commitment adoption is saved whole or not at all',async()=>{
 const w=await agentFixture({lifecycle:true});
 try{
  const sign=w.config.signer.sign;let saves=0;
  w.config.signer={...w.config.signer,sign:bytes=>{const text=Buffer.from(bytes).toString();if(text.includes('"kind":"session"')&&text.includes('"commitment":{')&&++saves===2)throw new Error('TEST lost second commitment save');return sign(bytes);}};
  await w.reopen();
  try{await w.agent.commit({jobId});}catch{/* the old shape loses its second save */}
  const saved=w.agent.durableSessionOf(jobId);
  if(saved.commitment)assert.equal(saved.phaseResults.length,2,'a saved commitment carries both phases');
  w.config.signer={...w.config.signer,sign};await w.reopen();
  assert.equal((await w.agent.commit({jobId})).status,'committed');assert.equal(w.agent.durableSessionOf(jobId).phaseResults.length,2);
 }finally{w.close();}
});
