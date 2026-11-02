import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {proposalAdmissionFixture} from './helpers/proposal-admission-fixture.mjs';
import {exchange} from './helpers/d5-http-fixture.mjs';
import {buyer,seller,NOW} from './helpers/protocol-fixture.mjs';
import {createSellerTransportStore,createSellerTransportClientAuth,createSellerTransportServerAuth} from '../src/dacs/seller-transport-auth.mjs';
import {createSellerHttpHandler} from '../src/dacs/seller-http.mjs';
const path='/dacs/v1/agreements/proposals';
for(const terminal of [null,'finalised','vet-failed','negotiate-failed','commit-failed','settle-failed','aborted-by-self','aborted-by-other','failed-substrate'])test('original proposal fence rechecks context '+terminal,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);let state=null,fencedError;
 const store=createSellerTransportStore({path:join(f.dir,'transport.sqlite'),now:()=>NOW,contextSessionState:()=>state});t.after(()=>store.close());
 const client=createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:agent.listingPin,agreementHash:body.transportIdentity.agreementHash}),now:()=>NOW});
 const server=createSellerTransportServerAuth({sellerSigner:{claim:seller.claim,sign:seller.signBytes},listingPin:agent.listingPin,store,now:()=>NOW});
 // The signed reservation is live; terminate only when HTTP hands it to the agent.
 const handler=createSellerHttpHandler({...agent,receiveProposal:(input,options)=>{state=terminal;return agent.receiveProposal(input,options).catch(error=>{fencedError=error;throw error;});}},{authentication:server});
 const text=JSON.stringify(body),signed=await client.request(path,body,Buffer.from(text)),before=f.signed.length;
 const result=await exchange(handler,{text,header:signed.header,url:path});
 if(terminal){assert.equal(result.status,503);assert.equal(JSON.parse(result.text).error,'operation_uncertain');assert.equal(fencedError.code,'context_session_terminal');assert.equal(f.signed.length,before);assert.equal(agent.durableSessions().length,0);}
 else{assert.equal(result.status,200);assert.equal(JSON.parse(result.text).disposition,'complete');assert.ok(f.signed.length>before);}
});

for(const terminal of ['aborted-by-other','vet-failed'])for(const boundary of ['resolveVetRecord','readVetAnchorReceipt','verifyVetAnchorReceipt','context'])test(`proposal signing rechecks ${terminal} after ${boundary}`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);let state=null,once=true;
 const terminate=()=>{if(once){once=false;state=terminal;}};
 if(boundary==='context'){
  const {createDemDeliveryContext}=await import('../src/dacs/dem-delivery-context-consumer.mjs');
  agent.close();f.config.demDeliveryContext=createDemDeliveryContext({authority:'TEST-terminal-context',resolveBuyer:async()=>null,resolveSeller:async({jobId})=>{terminate();return{disposition:'present',value:structuredClone(f.contexts.get(jobId))};}});
 }else{const read=f.admission.sessionAdmission[boundary];f.admission.sessionAdmission[boundary]=async(...args)=>{const value=await read(...args);terminate();return value;};}
 const use=boundary==='context'?await f.open():agent,store=createSellerTransportStore({path:join(f.dir,'late-terminal.sqlite'),now:()=>NOW,contextSessionState:()=>state});t.after(()=>store.close());
 const client=createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:use.listingPin,agreementHash:body.transportIdentity.agreementHash}),now:()=>NOW});
 const server=createSellerTransportServerAuth({sellerSigner:{claim:seller.claim,sign:seller.signBytes},listingPin:use.listingPin,store,now:()=>NOW});
 const text=JSON.stringify(body),signed=await client.request(path,body,Buffer.from(text)),result=await exchange(createSellerHttpHandler(use,{authentication:server}),{text,header:signed.header,url:path});
 assert.equal(result.status,503);assert.equal(JSON.parse(result.text).error,'operation_uncertain');
 assert.equal(f.signed.filter(value=>value.startsWith('dacs-payee-bound-agreement:v1:')).length,0);
 assert.equal(use.durableSessionOf(body.transportIdentity.jobId)?.sellerContribution,undefined);
});
test('terminal context after signing retains the signature checkpoint without publishing a contribution',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true});let state=null;const sign=f.config.signer.sign;
 f.config.signer.sign=bytes=>{const signature=sign(bytes);if(Buffer.from(bytes).toString().startsWith('dacs-payee-bound-agreement:v1:'))state='aborted-by-self';return signature;};
 const agent=await f.open(),body=await f.proposal(agent),store=createSellerTransportStore({path:join(f.dir,'signed-terminal.sqlite'),now:()=>NOW,contextSessionState:()=>state});t.after(()=>store.close());
 const client=createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:agent.listingPin,agreementHash:body.transportIdentity.agreementHash}),now:()=>NOW}),server=createSellerTransportServerAuth({sellerSigner:{claim:seller.claim,sign:seller.signBytes},listingPin:agent.listingPin,store,now:()=>NOW});
 const text=JSON.stringify(body),signed=await client.request(path,body,Buffer.from(text)),result=await exchange(createSellerHttpHandler(agent,{authentication:server}),{text,header:signed.header,url:path});
 assert.equal(result.status,503);assert.equal(JSON.parse(result.text).error,'operation_uncertain');
 assert.equal(f.signed.filter(value=>value.startsWith('dacs-payee-bound-agreement:v1:')).length,1);
 const kept=agent.durableSessionOf(body.transportIdentity.jobId);assert.equal(kept?.sellerContribution,undefined);
 agent.close();const {createSellerDurableState}=await import('../src/dacs/seller-durable-state.mjs'),stateStore=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:agent.listingPin});
 try{assert.equal(stateStore.signature(kept.agreementSignatureKey).disposition,'present');}finally{stateStore.close();}
});
