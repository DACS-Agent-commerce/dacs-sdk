import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256Hex} from '@kynesyslabs/dacs';
import {agentFixture} from './helpers/seller-agent-isolated-fixture.mjs';
import {JOBS} from './helpers/bilateral-vet-fixture.mjs';
for(const reopen of [false,true])test(`transport reconciliation awaits authenticated session restoration, reopen=${reopen}`,async()=>{
 const w=await agentFixture({lifecycle:true});try{
  const jobId=JOBS[0];await w.agent.commit({jobId});if(reopen)await w.reopen();
  const saved=w.agent.durableSessionOf(jobId),body={jobId},rawBody=Buffer.from(JSON.stringify(body));
  const request={method:'POST',path:'/dacs/v1/commitments',jobId,buyer:w.buyer.claim,seller:w.seller.claim,listingPin:w.agent.listingPin,agreementHash:saved.agreementHash,bodyHash:sha256Hex(rawBody)};
  const writes=w.anchors.writes.length,proof=await w.agent.reconcileTransport({request,body,rawBody,readOnly:true});
  assert.equal(proof.disposition,'present',JSON.stringify(proof));assert.equal(proof.value.status,'committed');assert.equal(w.anchors.writes.length,writes);
 }finally{w.close();}
});
