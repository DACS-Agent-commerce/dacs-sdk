import test from 'node:test';
import assert from 'node:assert/strict';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { NOW } from './helpers/protocol-fixture.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const jobRow=async f=>(await f.base.entries())[0][1];
const busy=()=>Object.assign(new Error('TEST journal busy'),{code:'journal-busy'});
// The first row write whose new row matches fails before it commits.
function failRowWriteOnce(f,matches,error){
 const store=f.config.store;let armed=true;
 f.config.store={...store,update:(key,change)=>store.update(key,(old,rows)=>{
  const next=change(old,rows);if(armed&&matches(next,old)){armed=false;throw error;}return next;
 })};
}
// Records each issueChallenge request and the job row as it stood when the verifier was asked.
function recordAsks(f,answer=(input,issue)=>issue(input)){
 const asks=[],issue=f.counterparty.issueChallenge;
 f.counterparty.issueChallenge=async input=>{asks.push({key:input.idempotencyKey,row:await jobRow(f)});return answer(input,issue);};
 return asks;
}
const run=(provider,input)=>provider.jobVet(input.scope,input.buyerIdentityBundle,()=>true);

test('the issuance key is stored in the job row before the verifier is asked and sent with the request',async()=>{
 const f=productionFixture(),asks=recordAsks(f);
 assert.equal((await f.run()).sellerVet.record.overallDecision,'pass');
 assert.equal(asks.length,1);assert.match(asks[0].key,UUID);
 assert.deepEqual(asks[0].row.issuance,{key:asks[0].key,replaces:null});
 const row=await jobRow(f);assert.equal(row.issuance,undefined);assert.ok(row.presentation);
 f.base.close();
});
test('a failed issuance intent write asks the verifier nothing',async()=>{
 const f=productionFixture();failRowWriteOnce(f,(next,old)=>next?.issuance&&!old?.issuance,busy());
 const asks=recordAsks(f),p=await f.provider(),input=f.input();
 await assert.rejects(run(p,input),{code:'journal-busy'});assert.equal(asks.length,0);
 assert.equal((await run(p,input)).sellerVet.record.overallDecision,'pass');assert.equal(asks.length,1);
 f.base.close();
});
for(const provider of ['same','new'])test(`journal-busy while the presentation is saved recovers with one issuance with a ${provider} provider`,async()=>{
 const f=productionFixture();f.controls.onePerJob=true;
 failRowWriteOnce(f,(next,old)=>next?.presentation&&!old?.presentation,busy());
 const asks=recordAsks(f),p=await f.provider(),input=f.input();
 await assert.rejects(run(p,input),{code:'journal-busy'});
 const result=await run(provider==='same'?p:await f.provider(),input);
 assert.equal(result.sellerVet.record.overallDecision,'pass');
 assert.equal(f.issued.size,1,'the verifier issued one challenge');
 assert.equal(asks.length,2);assert.equal(asks[0].key,asks[1].key);assert.deepEqual(asks[1].row.issuance,{key:asks[0].key,replaces:null});
 f.base.close();
});
test('an expired presentation is replaced under a new issuance key',async()=>{
 const f=productionFixture();let at=NOW;f.config.now=()=>at;
 failRowWriteOnce(f,next=>next?.presentation?.signing?.state==='pending',new Error('TEST interrupted reservation'));
 const asks=recordAsks(f,async(input,issue)=>({...await issue(input),expiresAt:at+60000}));
 await assert.rejects(f.run(),/TEST interrupted reservation/);
 const expired=(await jobRow(f)).presentation.challenge.sessionNonce;at+=60001;
 assert.equal((await f.run()).sellerVet.record.overallDecision,'pass');
 assert.equal(asks.length,2);assert.notEqual(asks[0].key,asks[1].key);assert.deepEqual(asks[1].row.issuance,{key:asks[1].key,replaces:expired});
 f.base.close();
});
test('an answer that expired before use releases the issuance key',async()=>{
 const f=productionFixture();let lifetime=1000;
 const asks=recordAsks(f,async(input,issue)=>({...await issue(input),expiresAt:NOW+lifetime})),p=await f.provider(),input=f.input();
 await assert.rejects(run(p,input),{code:'seller_challenge_invalid'});
 assert.equal((await jobRow(f)).issuance,undefined);
 lifetime=60000;
 assert.equal((await run(p,input)).sellerVet.record.overallDecision,'pass');
 assert.equal(asks.length,2);assert.notEqual(asks[0].key,asks[1].key);
 f.base.close();
});
