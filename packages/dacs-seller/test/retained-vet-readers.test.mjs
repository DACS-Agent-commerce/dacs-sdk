import test from 'node:test';
import assert from 'node:assert/strict';
import {proposalAdmissionFixture} from './helpers/proposal-admission-fixture.mjs';
import {JOB} from './helpers/protocol-fixture.mjs';
const signatures=f=>f.signed.filter(text=>text.startsWith('dacs-agreement:')).length;
async function completed(t){
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);
 const answer=await agent.receiveProposal(body);assert.equal(answer.disposition,'complete');
 return {...f,agent,body,answer};
}
for(const method of ['resolveVetRecord','readVetAnchorReceipt','verifyVetAnchorReceipt'])for(const role of ['buyer','seller'])test(`retained ${role} ${method} accepts authenticated raw JSON after restart`,async t=>{
 const f=await completed(t);f.agent.close();const read=f.config.sessionAdmission[method];
 f.config.sessionAdmission[method]=async(query,options)=>{const answer=await read(query,options);return query.role===role?Buffer.from(JSON.stringify(answer)):answer;};
 const count=signatures(f),fresh=await f.open();assert.equal(fresh.durableSessionOf(JOB).agreementHash,f.body.transportIdentity.agreementHash);
 assert.deepEqual((await fresh.receiveProposal(f.body)).contribution,f.answer.contribution);assert.equal(signatures(f),count);
});
for(const method of ['resolveVetRecord','readVetAnchorReceipt','verifyVetAnchorReceipt'])test(`retained ${method} has an exact deadline, cancellation and preserved timeout cause`,async t=>{
 const f=await completed(t);f.agent.close();const read=f.config.sessionAdmission[method];
 let entered,release,limits,settled=false,reads=0;const started=new Promise(r=>entered=r);
 f.config.sessionAdmission[method]=async(query,options)=>{if(++reads===1){limits=options;entered();await new Promise(r=>release=r);}return read(query,options);};
 t.mock.timers.enable({apis:['setTimeout']});
 const opening=f.open();opening.then(()=>settled=true,()=>settled=true);await started;
 if(!limits?.signal){release();(await opening).close();assert.fail('retained read omitted its limits and cancellation');}
 assert.equal(limits.maxBytes,65536);assert.equal(limits.timeoutMs,10000);
 t.mock.timers.tick(9999);await Promise.resolve();assert.equal(settled,false);
 const rejected=assert.rejects(opening,error=>error.code==='seller_state_unverified'&&error.cause?.name==='TimeoutError');
 t.mock.timers.tick(1);await rejected;assert.equal(limits.signal.aborted,true);release();
});
test('running retained restoration normalizes raw receipts before replay',async t=>{
 const f=await completed(t),read=f.config.sessionAdmission.readVetAnchorReceipt,count=signatures(f);
 f.config.sessionAdmission.readVetAnchorReceipt=async(...args)=>Buffer.from(JSON.stringify(await read(...args)));
 assert.deepEqual((await f.agent.receiveProposal(f.body)).contribution,f.answer.contribution);assert.equal(signatures(f),count);
});
for(const size of [65536,65537])test(`retained raw receipt enforces its ${size}-byte boundary and preserves the size cause`,async t=>{
 const f=await completed(t);f.agent.close();const read=f.config.sessionAdmission.readVetAnchorReceipt;
 f.config.sessionAdmission.readVetAnchorReceipt=async(...args)=>{const text=JSON.stringify(await read(...args));return Buffer.from(text+' '.repeat(size-Buffer.byteLength(text)));};
 if(size===65536){const fresh=await f.open();assert.equal(fresh.durableSessionOf(JOB).agreementHash,f.body.transportIdentity.agreementHash);}
 else await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&(error.cause instanceof RangeError||error.cause?.code==='BYTE-LIMIT-EXCEEDED')&&/BYTE-LIMIT|byte/i.test(error.cause.message));
});
test('oversized decoded authentic receipt is held with its original size cause',async t=>{
 const f=await completed(t);f.agent.close();const read=f.config.sessionAdmission.readVetAnchorReceipt;
 f.config.sessionAdmission.readVetAnchorReceipt=async(...args)=>{const receipt=await read(...args);return {...receipt,evidence:{...receipt.evidence,value:'x'.repeat(65537)}};};
 await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&error.cause instanceof RangeError);
});
