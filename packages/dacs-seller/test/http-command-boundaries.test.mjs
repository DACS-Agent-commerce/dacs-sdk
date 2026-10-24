import test from 'node:test';
import assert from 'node:assert/strict';
import {createSellerHttpHandler,createSellerAgentClient} from '../src/dacs/seller-http.mjs';
import {SELLER_CONTEXT_PATH,SELLER_CONTEXT_CHALLENGE_PATH} from '../src/dacs/seller-transport-auth.mjs';
import {exchange,JOBS} from './helpers/d5-http-fixture.mjs';
function fixture({uncertain=false,contextMode=false}={}){
 const finishes=[],agent={claim:'TEST-seller',listingPin:{TEST:'pin'},submitPayment:async()=>({status:'rejected'})};
 const request={jobId:JOBS[0]},reservation={disposition:uncertain?'uncertain':'perform'};
 const store={classify(){},reserve:()=>reservation,finish:(_reservation,_status,_text,options)=>finishes.push(options),reconcile(){}};
 const authentication={seller:agent.claim,listingPin:agent.listingPin,store,readRequest:()=>request,validate(){},responseHeader:async()=> 'TEST-header'};
 const context={path:SELLER_CONTEXT_PATH,challengePath:SELLER_CONTEXT_CHALLENGE_PATH,challenge(){},reserve:()=>reservation,perform:async()=>({disposition:'present'}),settled:async()=>{},reconcile:async()=>null};
 return{agent,context,finishes,handler:()=>createSellerHttpHandler(agent,{authentication,...contextMode?{context}:{}})};
}
for(const contextMode of [false,true])test(`${contextMode?'context':'agent'} reconciliation keeps its method receiver`,async()=>{
 const f=fixture({uncertain:true,contextMode}),owner=contextMode?f.context:f.agent;
 owner.keptAnswer={disposition:'present',value:{status:'TEST-recovered'}};
 owner[contextMode?'reconcile':'reconcileTransport']=function(){return this.keptAnswer;};
 const res=await exchange(f.handler(),{url:contextMode?SELLER_CONTEXT_PATH:'/dacs/v1/payments'});assert.equal(res.status,200);assert.deepEqual(JSON.parse(res.text),{status:'TEST-recovered'});
});
test('persistent context cleanup failure still ends a bounded uncertain HTTP response',async()=>{
 const f=fixture({contextMode:true});f.context.settled=async()=>{throw new Error('TEST retained hold');};
 const res=await exchange(f.handler());assert.equal(res.status,503);assert.equal(res.writableEnded,true);assert.equal(JSON.parse(res.text).error,'operation_uncertain');
});
for(const retained of [undefined,true,false])test(`rejected payment releases its effect only with explicit unretained proof: ${retained}`,async()=>{
 const f=fixture();if(retained!==undefined)f.agent.retainsPaymentClaim=()=>retained;
 const res=await exchange(f.handler(),{url:'/dacs/v1/payments'});assert.equal(res.status,200);assert.equal(f.finishes[0].noEffect,retained===false);assert.equal(f.finishes[0].retry,retained!==false);
});
for(const method of ['propose','submitPayment','agreementContext'])test(`${method} rejects oversized nested decoded collections`,async()=>{
 const client=createSellerAgentClient({url:'http://127.0.0.1:1',fetchImpl:async()=>new Response(JSON.stringify({nested:{items:Array(100000).fill(0)}}),{headers:{'content-type':'application/json'}})});
 await assert.rejects(client[method]({}),e=>e.name==='SellerUnavailableError');
});
