import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicyLedger, withContextHolds, heldPolicyBudget } from '../src/devnet-demo/operator-approval.mjs';
import { JOB, NOW, buyer as buyerWallet } from './helpers/protocol-fixture.mjs';
const JOBS = [JOB, JOB.slice(0,-1) + 'B'], T0 = NOW, buyer = buyerWallet.claim;

test('L2 context holds and sign-authorized rows share the job and hourly budgets without double conversion',()=>{
 const hold={contextHold:'h',jobId:JOBS[0],writes:2,totalOs:'4',recordedAt:100,released:false,originLine:1};
 const row={decision:'approved',policy:true,outcome:null,jobId:JOBS[0],artifactKind:'CompositeVerificationRecord',totalOs:'4',recordedAt:100,originLine:2};
 assert.equal(heldPolicyBudget(withContextHolds([hold,row]),101).writes,2);
 for(const changed of [{...row,artifactKind:'Deliverable'},{...row,originLine:1},{...row,originLine:undefined},{...row,jobId:JOBS[1]}])assert.equal(heldPolicyBudget(withContextHolds([hold,changed]),101).writes,3);
});
test('L3 new context ledger lines reject malformed keys, duplicate holds, limits, and a release for another job',()=>{
 const hold={format:'dacs-node2-seller-context-admission/v1',event:'hold',holdId:'h',jobId:JOBS[0],effect:'a'.repeat(64),writes:2,totalOs:'4',recordedAt:100};
 for(const mutation of [{...hold,extra:1},{...hold,writes:0},{...hold,writes:7},{...hold,totalOs:'04'},{...hold,effect:'wrong'}])assert.throws(()=>parsePolicyLedger(JSON.stringify(mutation)));
 assert.throws(()=>parsePolicyLedger([hold,hold].map(JSON.stringify).join('\n')));
 assert.throws(()=>parsePolicyLedger([hold,{format:hold.format,event:'release',holdId:'h',jobId:JOBS[1],recordedAt:101}].map(JSON.stringify).join('\n')));
});
test('L6 one Vet converts only one slot across multiple retained holds of the same job',()=>{
 const hold={contextHold:'a',jobId:JOBS[0],writes:2,totalOs:'4',recordedAt:100,released:false,originLine:1},row={decision:'approved',policy:true,outcome:null,jobId:JOBS[0],artifactKind:'CompositeVerificationRecord',totalOs:'4',recordedAt:101,originLine:3};
 const ledger=[hold,{...hold,contextHold:'b',originLine:2},row];assert.equal(heldPolicyBudget(withContextHolds(ledger),102).writes,4);
 assert.equal(heldPolicyBudget(withContextHolds(ledger,{jobId:JOBS[0],artifactKind:'CompositeVerificationRecord'}),102).writes,3);
});
test('L8 context refusal ledger lines must retain their exact key and integer-time shape',()=>{
 const row={format:'dacs-node2-seller-context-admission/v1',event:'refused',jobId:JOBS[0],buyer,reason:'limit',recordedAt:T0};assert.equal(parsePolicyLedger(JSON.stringify(row)).rows.length,0);
 for(const change of [{extra:1},{reason:null},{recordedAt:T0+0.5}])assert.throws(()=>parsePolicyLedger(JSON.stringify({...row,...change})));
});
