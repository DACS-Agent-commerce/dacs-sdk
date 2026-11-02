import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod,mkdir,mkdtemp,readFile,rm,appendFile } from 'node:fs/promises';
import { existsSync,readFileSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { address,seller,buyer,pin,sourceBinding,artifactAuthority,T0,JOBS,PAYMENT_TX_REF,deliveredHashFor,requestFor,confirmationFor } from './helpers/d5-policy-fixtures.mjs';
const { composeSellerApproval,createExactOperatorApproval,parsePolicyLedger,heldPolicyBudget }=await import('../src/devnet-demo/operator-approval.mjs');

// The real approval ledger over a private temporary directory, a scripted purchase source and scripted manual
// approvers. Nothing here touches a wallet, a journal or the network.
const MAX_TOTAL_OS='50000000000',LOCK_FILE='seller-state.lock',OPERATION_TIMEOUT_MS=30_000;
const purchase=()=>({seller,buyer,listingPin:pin,sourceBinding,agreementHash:'e'.repeat(64),amountOs:'1000000000',paymentObserved:true,paymentTxRef:{...PAYMENT_TX_REF},prePaymentOpen:false});
const unpaid=()=>({...purchase(),paymentObserved:false,paymentTxRef:null,prePaymentOpen:true});
const evidence=(options={})=>requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem',...options});
const secondEvidence=()=>evidence({job:JOBS[1],nonce:2});
const artifactWrite=()=>requestFor({artifactKind:'Deliverable',job:JOBS[2],nonce:3});
const sessionWrite=()=>requestFor({artifactKind:'Deliverable',job:JOBS[3],nonce:4});
const executed=(request)=>confirmationFor(request,{executed:true});
async function ledgerFixture(t,{limits={},maxTotalOs=MAX_TOTAL_OS}={}){
 const directory=await mkdtemp(join(tmpdir(),'p21b1-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const evidencePath=join(directory,'approvals.jsonl'),state={purchase:purchase(),resolved:0,hook:()=>{}};
 const resolvePurchase=async(jobId)=>{state.resolved++;await state.hook();return state.purchase&&{jobId,...state.purchase};};
 const policyInputs={address,seller,sourceBinding,artifactAuthority,listingPin:()=>pin,resolvePurchase,paymentPhaseIndex:()=>2,deliveryPhaseIndex:()=>3,deliveredPayloadHash:deliveredHashFor};
 // A restart is a new approval over the same file.
 const restart=()=>{const approval=createExactOperatorApproval({maxTotalOs,evidencePath,now:()=>T0,sellerApproval:{mode:'policy',...limits},policy:policyInputs});t.after(()=>approval.stop());return approval;};
 const compose=(policy,manual=()=>assert.fail('the operator was asked'))=>composeSellerApproval({mode:'policy',policy,manual});
 return {evidencePath,directory,state,restart,compose,maxTotalOs,policyInputs};
}
const text=(path)=>readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
const lines=async(path)=>(await text(path)).split('\n').filter(Boolean).map(line=>JSON.parse(line));
const parsed=async(path)=>parsePolicyLedger(await text(path));
const rowOf=async(path,id)=>(await parsed(path)).rows.find(row=>row.reservationId===id);
const linkedLines=async(path,id)=>(await lines(path)).filter(line=>line.reservationId===id&&line.confirmation);
const completions=async(path,id)=>(await lines(path)).filter(line=>line.reservationId===id&&line.outcome);
const signLines=async(path)=>(await lines(path)).filter(line=>line.format==='dacs-node2-seller-policy-sign-authorization/v1');
const openSigns=async(path)=>(await parsed(path)).rows.filter(row=>row.signAuthorized&&row.outcome===null);
const budget=async(path)=>heldPolicyBudget((await parsed(path)).rows,T0);
const bindingOf=(prepared)=>({ledgerId:prepared.ledgerId,requestText:prepared.requestText});
const withinTimeout=(work)=>Promise.race([work,new Promise((_,fail)=>setTimeout(()=>fail(new Error('operation did not complete: lock or flight not released')),OPERATION_TIMEOUT_MS).unref())]);
const rejectsWith=(work,code)=>assert.rejects(work,error=>error.code===code);
// The policy lock's identity while it is held: its file text and inode, read from inside a purchase read.
const lockToken=(directory)=>{const path=join(directory,'approvals.jsonl.policy-lock',LOCK_FILE);assert.ok(existsSync(path),'the policy lock is held while the operation runs');const stat=statSync(path,{bigint:true});return `${readFileSync(path,'utf8')}${stat.ino}:${stat.ctimeNs}`;};
const manualApprover=(fixture,{authorize=async()=>true,signal=null,now=()=>T0}={})=>createExactOperatorApproval({maxTotalOs:fixture.maxTotalOs,evidencePath:fixture.evidencePath,authorize,signal,now});

test('in policy mode retained.prepare writes one sign-authorized line and returns its ledgerId and exact requestText; manual mode returns ledgerId null and writes no reservation',async t=>{
 const fixture=await ledgerFixture(t),request=evidence(),approval=fixture.compose(fixture.restart());
 const prepared=await approval.retained.prepare(request);
 const signed=await signLines(fixture.evidencePath);
 assert.equal(signed.length,1);assert.equal(prepared.ledgerId,signed[0].reservationId);
 assert.equal(prepared.requestText,JSON.stringify(request));assert.equal(prepared.requestText,signed[0].requestBytes);
 const manualFixture=await ledgerFixture(t),manual=composeSellerApproval({mode:'manual',policy:manualFixture.restart(),manual:async()=>true});
 assert.deepEqual(await manual.retained.prepare(evidence()),{ledgerId:null,requestText:JSON.stringify(evidence())});
 assert.deepEqual(await signLines(manualFixture.evidencePath),[]);
});

test('while an evidence authorization is held, another write\'s approve, a mismatched confirmation, a policy refusal and a throwing policy each leave it open; the ledger is read and checked at every barrier',async t=>{
 const fixture=await ledgerFixture(t),approval=fixture.compose(fixture.restart()),{ledgerId}=await approval.retained.prepare(evidence());
 const stillOpen=async(barrier)=>{
  const row=await rowOf(fixture.evidencePath,ledgerId);
  assert.equal(row?.outcome,null,`${barrier}: the authorization is open`);assert.deepEqual(await completions(fixture.evidencePath,ledgerId),[],`${barrier}: no completion line`);
 };
 await stillOpen('after prepare');
 assert.equal(await approval(artifactWrite()),true);await stillOpen('after another write\'s approve');
 assert.equal(await approval.confirm(confirmationFor(evidence())),false);await stillOpen('after a mismatched confirmation');
 fixture.state.purchase=unpaid();
 assert.equal(await approval(secondEvidence()),false);await stillOpen('after a policy refusal');
 fixture.state.hook=()=>{throw new Error('purchase source down');};
 await assert.rejects(approval(artifactWrite()),/purchase source down/);await stillOpen('after a throwing policy');
});

test('a refused first confirmation of a retained authorization appends an unlinked decision line and no completion; a later confirmation links once, and the ledger still parses',async t=>{
 const fixture=await ledgerFixture(t),request=evidence(),approval=fixture.compose(fixture.restart()),prepared=await approval.retained.prepare(request);
 const before=(await lines(fixture.evidencePath)).length;
 fixture.state.purchase=false;
 assert.equal(await approval.retained.confirm(bindingOf(prepared),executed(request)),false);
 const added=(await lines(fixture.evidencePath)).slice(before);
 assert.equal(added.length,1);assert.equal(added[0].decision,'rejected');assert.equal(Object.hasOwn(added[0],'reservationId'),false);
 assert.deepEqual(await completions(fixture.evidencePath,prepared.ledgerId),[]);assert.equal((await rowOf(fixture.evidencePath,prepared.ledgerId)).confirmed,null);
 fixture.state.purchase=purchase();
 assert.equal(await approval.retained.confirm(bindingOf(prepared),executed(request)),true);
 assert.equal(await approval.retained.confirm(bindingOf(prepared),executed(request)),true);
 assert.equal((await linkedLines(fixture.evidencePath,prepared.ledgerId)).length,1);assert.equal((await rowOf(fixture.evidencePath,prepared.ledgerId)).confirmed,'approved');
});

test('a repeated confirmation of an already confirmed retained authorization reruns current purchase/policy and exact-content/debit checks, reuses the counted hold and appends no duplicate linked decision',async t=>{
 const fixture=await ledgerFixture(t),request=evidence(),approval=fixture.compose(fixture.restart()),prepared=await approval.retained.prepare(request);
 assert.equal(await approval.retained.confirm(bindingOf(prepared),executed(request)),true);
 const confirmedText=await text(fixture.evidencePath),resolvedBefore=fixture.state.resolved;
 assert.equal(await approval.retained.confirm(bindingOf(prepared),executed(request)),true);
 assert.ok(fixture.state.resolved>resolvedBefore,'the purchase was read again');assert.equal(await text(fixture.evidencePath),confirmedText,'no line was appended');
 const otherContent=executed(secondEvidence());
 assert.equal(await approval.retained.confirm(bindingOf(prepared),otherContent),false,'content must equal the exact request');
 fixture.state.purchase={...purchase(),amountOs:'2000000000'};
 assert.equal(await approval.retained.confirm(bindingOf(prepared),executed(request)),false,'a changed purchase refuses a replay');
 assert.equal((await linkedLines(fixture.evidencePath,prepared.ledgerId)).length,1);assert.equal((await budget(fixture.evidencePath)).writes,1);
});

test('after a restart, reopen(ledgerId) rebuilds the exact request with no new line, and confirm and settle by id work without the original object',async t=>{
 const fixture=await ledgerFixture(t),request=evidence(),prepared=await fixture.compose(fixture.restart()).retained.prepare(request);
 const restarted=fixture.compose(fixture.restart()),before=await text(fixture.evidencePath);
 const reopened=await restarted.retained.reopen(prepared.ledgerId);
 assert.equal(await text(fixture.evidencePath),before,'reopen wrote nothing');
 assert.equal(reopened.ledgerId,prepared.ledgerId);assert.equal(reopened.requestText,prepared.requestText);assert.deepEqual(reopened.request,request);assert.ok(Object.isFrozen(reopened.request));
 assert.equal(await restarted.retained.confirm(bindingOf(reopened),executed(request)),true);
 await restarted.retained.settle(bindingOf(reopened),'spent');
 assert.equal((await completions(fixture.evidencePath,prepared.ledgerId)).length,1);assert.equal((await rowOf(fixture.evidencePath,prepared.ledgerId)).outcome,'spent');
});

test('with maxWritesPerHour 1: prepare, restart, then prepare of the exact request returns the open authorization; reopened and reconfirmed across two restarts, heldPolicyBudget counts one write throughout',async t=>{
 const fixture=await ledgerFixture(t,{limits:{maxWritesPerHour:1}}),request=evidence();
 const prepared=await fixture.compose(fixture.restart()).retained.prepare(request);
 assert.equal((await budget(fixture.evidencePath)).writes,1);
 const second=fixture.compose(fixture.restart()),again=await second.retained.prepare(evidence());
 assert.equal(again.ledgerId,prepared.ledgerId);assert.equal((await signLines(fixture.evidencePath)).length,1);
 await second.retained.reopen(again.ledgerId);assert.equal(await second.retained.confirm(bindingOf(again),executed(request)),true);assert.equal((await budget(fixture.evidencePath)).writes,1);
 const third=fixture.compose(fixture.restart());await third.retained.reopen(prepared.ledgerId);
 assert.equal(await third.retained.confirm(bindingOf(prepared),executed(request)),true);
 assert.equal((await budget(fixture.evidencePath)).writes,1);assert.equal((await linkedLines(fixture.evidencePath,prepared.ledgerId)).length,1);
});

test('settle(ledgerId, spent) twice appends one completion; settle released after spent refuses approval_settlement_conflict',async t=>{
 const fixture=await ledgerFixture(t),approval=fixture.compose(fixture.restart()),prepared=await approval.retained.prepare(evidence());
 await approval.retained.settle(bindingOf(prepared),'spent');await approval.retained.settle(bindingOf(prepared),'spent');
 assert.equal((await completions(fixture.evidencePath,prepared.ledgerId)).length,1);
 const settledText=await text(fixture.evidencePath);
 await rejectsWith(approval.retained.settle(bindingOf(prepared),'released'),'approval_settlement_conflict');
 assert.equal(await text(fixture.evidencePath),settledText);
});

test('an authorization the operator released: prepare of the exact request opens a new one; after a crash before the caller links it, open(requestText) returns it, so no second open authorization exists',async t=>{
 const fixture=await ledgerFixture(t),approval=fixture.compose(fixture.restart()),first=await approval.retained.prepare(evidence());
 await approval.retained.settle(bindingOf(first),'released');
 const second=await approval.retained.prepare(evidence());
 assert.notEqual(second.ledgerId,first.ledgerId);assert.equal((await openSigns(fixture.evidencePath)).length,1);
 // The caller crashed before it kept the id: the restart finds the authorization by its exact bytes.
 const restarted=fixture.compose(fixture.restart());
 assert.deepEqual(await restarted.retained.open(second.requestText),{ledgerId:second.ledgerId,requestText:second.requestText});
 assert.equal(await restarted.retained.open(JSON.stringify(secondEvidence())),null);
 assert.equal((await restarted.retained.prepare(evidence())).ledgerId,second.ledgerId);assert.equal((await openSigns(fixture.evidencePath)).length,1);
});

test('a session write through the shared slot keeps its positive release: replacement and confirmation mismatch release it',async t=>{
 const fixture=await ledgerFixture(t),approval=fixture.compose(fixture.restart()),first=artifactWrite(),second=sessionWrite();
 assert.equal(await approval(first),true);assert.equal(await approval(second),true);
 assert.equal((await lines(fixture.evidencePath)).filter(line=>line.outcome==='released'&&line.reason==='replaced').length,1);
 assert.equal(await approval.confirm(confirmationFor(first)),false);
 assert.equal((await lines(fixture.evidencePath)).filter(line=>line.outcome==='released'&&line.reason==='confirmation-mismatch').length,1);
 assert.equal((await openSigns(fixture.evidencePath)).length,0);
});

test('an evidence authorization held while an artifact write is prepared, confirmed and settled: the evidence row is untouched and both totals match the ledger',async t=>{
 const fixture=await ledgerFixture(t),approval=fixture.compose(fixture.restart()),prepared=await approval.retained.prepare(evidence()),write=artifactWrite();
 assert.equal(await approval(write),true);assert.equal(await approval.confirm(confirmationFor(write)),true);await approval.settle(write,'spent');
 const row=await rowOf(fixture.evidencePath,prepared.ledgerId);
 assert.equal(row.outcome,null);assert.equal(row.confirmed,null);
 const counted=await budget(fixture.evidencePath);
 assert.equal(counted.writes,2);assert.equal(counted.totalOs,2n*BigInt(write.content.debit.totalOs));
 assert.equal((await completions(fixture.evidencePath,prepared.ledgerId)).length,0);
});

test('retained.prepare refuses a request kind other than SettlementEvidence, and reopen refuses an unknown or already settled ledgerId',async t=>{
 const fixture=await ledgerFixture(t),approval=fixture.compose(fixture.restart());
 await rejectsWith(approval.retained.prepare(artifactWrite()),'invalid_params');
 assert.equal(await text(fixture.evidencePath),'');
 await rejectsWith(approval.retained.reopen(randomUUID()),'approval_reservation_unavailable');
 const prepared=await approval.retained.prepare(evidence());await approval.retained.settle(bindingOf(prepared),'spent');
 await rejectsWith(approval.retained.reopen(prepared.ledgerId),'approval_reservation_unavailable');
});

test('two processes settling the same ledgerId through the policy lock produce one completion line',async t=>{
 const fixture=await ledgerFixture(t),first=fixture.compose(fixture.restart()),second=fixture.compose(fixture.restart()),prepared=await first.retained.prepare(evidence());
 await Promise.all([first.retained.settle(bindingOf(prepared),'spent'),second.retained.settle(bindingOf(prepared),'spent')]);
 assert.equal((await completions(fixture.evidencePath,prepared.ledgerId)).length,1);
});

test('first retained.prepare through real composeSellerApproval and the real ledger completes with exactly one policy-lock acquisition; an independent ledger operation then completes',async t=>{
 const fixture=await ledgerFixture(t),policy=fixture.restart(),approval=fixture.compose(policy),tokens=new Set();
 fixture.state.hook=()=>{tokens.add(lockToken(fixture.directory));};
 const prepared=await withinTimeout(approval.retained.prepare(evidence()));
 assert.equal(tokens.size,1,'every read inside the operation ran under one acquisition');
 assert.equal(existsSync(join(fixture.directory,'approvals.jsonl.policy-lock',LOCK_FILE)),false,'the lock is released');
 assert.deepEqual(await withinTimeout(approval.retained.open(prepared.requestText)),bindingOf(prepared));
 await withinTimeout(policy.stop());
});

test('first retained.confirm through the real ledger completes with exactly one policy-lock acquisition and one linked confirmation; an independent ledger operation then completes',async t=>{
 const fixture=await ledgerFixture(t),policy=fixture.restart(),approval=fixture.compose(policy),request=evidence(),prepared=await approval.retained.prepare(request),tokens=new Set();
 fixture.state.hook=()=>{tokens.add(lockToken(fixture.directory));};
 assert.equal(await withinTimeout(approval.retained.confirm(bindingOf(prepared),executed(request))),true);
 assert.equal(tokens.size,1);assert.equal((await linkedLines(fixture.evidencePath,prepared.ledgerId)).length,1);
 assert.equal(existsSync(join(fixture.directory,'approvals.jsonl.policy-lock',LOCK_FILE)),false);
 await withinTimeout(approval.retained.settle(bindingOf(prepared),'spent'));await withinTimeout(policy.stop());
});

test('at deterministic barriers a retained preparation or confirmation refusal or throw releases its single policy lock and tracked flight; the next independent operation completes, with no nested public call',async t=>{
 const fixture=await ledgerFixture(t),policy=fixture.restart(),approval=fixture.compose(policy),request=evidence();
 const independent=async()=>{assert.equal(await withinTimeout(approval.retained.open(JSON.stringify(secondEvidence()))),null);};
 fixture.state.purchase=false;await rejectsWith(withinTimeout(approval.retained.prepare(request)),'approval_refused');await independent();
 fixture.state.purchase=purchase();fixture.state.hook=()=>{throw new Error('purchase source down');};
 await assert.rejects(withinTimeout(approval.retained.prepare(request)),/purchase source down/);await independent();
 fixture.state.hook=()=>{};const prepared=await approval.retained.prepare(request);
 fixture.state.purchase=false;assert.equal(await withinTimeout(approval.retained.confirm(bindingOf(prepared),executed(request))),false);await independent();
 fixture.state.purchase=purchase();fixture.state.hook=()=>{throw new Error('purchase source down');};
 await assert.rejects(withinTimeout(approval.retained.confirm(bindingOf(prepared),executed(request))),/purchase source down/);await independent();
 fixture.state.hook=()=>{};assert.equal(await withinTimeout(approval.retained.confirm(bindingOf(prepared),executed(request))),true);
 await withinTimeout(policy.stop());
});

test('confirm successfully, lose the broadcast answer and restart; unavailable purchase resolution, paymentObserved false or changed bound purchase data each makes reconfirmation false with the same hold; restore valid evidence and exact-byte replay succeeds with no second linked confirmation or budgeted write',async t=>{
 const fixture=await ledgerFixture(t),request=evidence(),first=fixture.compose(fixture.restart()),prepared=await first.retained.prepare(request);
 assert.equal(await first.retained.confirm(bindingOf(prepared),executed(request)),true);
 const restarted=fixture.compose(fixture.restart());await restarted.retained.reopen(prepared.ledgerId);
 const changes={'unavailable purchase resolution':null,'paymentObserved false':unpaid(),'changed bound purchase data':{...purchase(),paymentTxRef:{...PAYMENT_TX_REF,blockNumber:10}}};
 for(const [name,changed] of Object.entries(changes)){
  fixture.state.purchase=changed;const before=await text(fixture.evidencePath);
  assert.equal(await restarted.retained.confirm(bindingOf(prepared),executed(request)),false,name);
  assert.equal((await rowOf(fixture.evidencePath,prepared.ledgerId)).outcome,null,`${name}: same hold`);assert.equal((await budget(fixture.evidencePath)).writes,1,name);
  assert.equal((await linkedLines(fixture.evidencePath,prepared.ledgerId)).length,1,name);assert.ok((await text(fixture.evidencePath)).startsWith(before));
 }
 fixture.state.purchase=purchase();
 assert.equal(await restarted.retained.confirm(bindingOf(prepared),executed(request)),true);
 assert.equal((await linkedLines(fixture.evidencePath,prepared.ledgerId)).length,1);assert.equal((await budget(fixture.evidencePath)).writes,1);
});

test('an unreadable ledger refuses prepare, reopen, confirm and settle with its cause kept; nothing is released',async t=>{
 const fixture=await ledgerFixture(t),request=evidence(),approval=fixture.compose(fixture.restart()),prepared=await approval.retained.prepare(request);
 await appendFile(fixture.evidencePath,'{"not":"a ledger line"\n');const corrupt=await text(fixture.evidencePath);
 const keepsCause=(error)=>error instanceof Error&&Number.isSafeInteger(error.ledgerLine);
 await assert.rejects(approval.retained.prepare(secondEvidence()),keepsCause);
 await assert.rejects(approval.retained.reopen(prepared.ledgerId),keepsCause);
 await assert.rejects(approval.retained.confirm(bindingOf(prepared),executed(request)),keepsCause);
 await assert.rejects(approval.retained.settle(bindingOf(prepared),'released'),keepsCause);
 assert.equal(await text(fixture.evidencePath),corrupt,'nothing was appended or released');
});

test('retained.prepare refuses with no ledger line, as approve.prepare does for the same request, each mutation in the table: kind swapped to the artifact-create kind, agreement binding empty, null or other, CREATE address not derived from sender, program name and nonce, extra or missing metadata key, duplicate member in the exact bytes, resolved purchase price changed (and each other bound purchase field one at a time); the ledger is byte-identical before and after, and the unmutated request still opens one authorization',async t=>{
 const fixture=await ledgerFixture(t),approval=fixture.compose(fixture.restart(),()=>assert.fail('a final refusal never falls back to the operator'));
 const requestMutations={
  'kind swapped to the artifact-create kind':(r)=>{r.content.kind='devnet-demo-artifact-storage-create';},
  'storage address not derived':(r)=>{r.content.storageAddress=`stor-${'0'.repeat(40)}`;},
  'program name not derived':(r)=>{r.content.programName='other-name';},
  'extra metadata key':(r)=>{const create=JSON.parse(r.content.exactCreate);create.metadata.extra='x';r.content.exactCreate=JSON.stringify(create);},
  'missing metadata key':(r)=>{const create=JSON.parse(r.content.exactCreate);delete create.metadata.contentHash;r.content.exactCreate=JSON.stringify(create);},
  'duplicate member in the exact storage bytes':(r)=>{r.content.exactStorageBytes=r.content.exactStorageBytes.replace('{','{"jobId":"duplicate",');},
  'duplicate member in the exact CREATE':(r)=>{r.content.exactCreate=r.content.exactCreate.replace('{','{"operation":"duplicate",');},
 };
 const purchaseMutations={
  'agreement binding empty':{agreementHash:''},'agreement binding null':{agreementHash:null},'agreement binding other':{agreementHash:'not-a-hash'},
  'resolved purchase price':{amountOs:'2000000000'},'payment transaction':{paymentTxRef:{...PAYMENT_TX_REF,txHash:'6'.repeat(64)}},'listing pin':{listingPin:{...pin,version:2}},
  'source binding':{sourceBinding:{...sourceBinding,bindingId:'f'.repeat(64)}},'seller':{seller:`did:demos:agent:${'3'.repeat(64)}`},'job':{jobId:JOBS[4]},
 };
 const refuse=async(name,request)=>{
  const before=await text(fixture.evidencePath),outcome=await approval.retained.prepare(request).then(()=>'not refused',error=>error.code);
  assert.equal(outcome,'approval_refused',name);assert.equal(await text(fixture.evidencePath),before,name);
 };
 for(const [name,mutate] of Object.entries(requestMutations)){const request=evidence();mutate(request);await refuse(name,request);}
 for(const [name,change] of Object.entries(purchaseMutations)){fixture.state.purchase={...purchase(),...change};await refuse(name,evidence());}
 fixture.state.purchase=purchase();
 const prepared=await approval.retained.prepare(evidence());
 assert.equal((await openSigns(fixture.evidencePath)).length,1);assert.equal(prepared.requestText,JSON.stringify(evidence()));
});

test('manual approval runs the same checks as policy approval, table {purchase closed, purchase unpaid, fee cap manually overridden, debit mismatch} × {retained.prepare, retained.confirm}: retained.prepare after a definite policy refusal falls back to manual approval with ledgerId null; the manual confirm is true only with the exact-debit and fresh purchase checks passing, false when the purchase closes or becomes unpaid during the manual callback or the debit does not match, and not refused by the policy fee cap that was manually overridden while the debit is within K9\'s 50 DEM ceiling (above it the confirm stays false); the hold is unchanged on false and no second write is counted',async t=>{
 // The policy's fee cap (3 DEM) is below the request's 4 DEM debit: a definite refusal the operator may waive.
 const fixture=await ledgerFixture(t,{limits:{maxWriteTotalOs:'3000000000'}});let asked=0,during=()=>{};
 const manual=manualApprover(fixture,{authorize:async()=>{asked++;during();return true;}}),approval=fixture.compose(fixture.restart(),manual);
 const request=evidence(),zeroWrites=async()=>assert.equal((await budget(fixture.evidencePath)).writes,0,'a manual decision counts no policy write');
 const prepared=await approval.retained.prepare(request);
 assert.equal(prepared.ledgerId,null);assert.equal(asked,1);assert.equal((await signLines(fixture.evidencePath)).length,0);
 assert.equal(await approval.retained.confirm(bindingOf(prepared),executed(request)),true,'the overridden fee cap does not refuse the confirm');
 const mismatched=executed(request);mismatched.response.data.transaction.content.transaction_fee.network_fee='2000000000';
 assert.equal(await approval.retained.confirm(bindingOf(prepared),mismatched),false,'debit mismatch');
 for(const [index,[name,changed]] of [['purchase closes during the manual callback',false],['purchase becomes unpaid during the manual callback',unpaid()]].entries()){
  const other=evidence({job:JOBS[1],nonce:2+index});during=()=>{fixture.state.purchase=changed;};
  const decision=await approval.retained.prepare(other);during=()=>{};
  assert.equal(await approval.retained.confirm(bindingOf(decision),executed(other)),false,name);
  fixture.state.purchase=purchase();assert.equal(await approval.retained.confirm(bindingOf(decision),executed(other)),true,`${name}: the decision was kept`);
  await approval.retained.settle(bindingOf(decision),'spent');
 }
 await zeroWrites();
 // Definite policy refusals that no manual answer may waive never reach the operator.
 const before=asked;fixture.state.purchase=false;await rejectsWith(approval.retained.prepare(request),'approval_refused');
 fixture.state.purchase=unpaid();await rejectsWith(approval.retained.prepare(request),'approval_refused');
 fixture.state.purchase=purchase();const inconsistent=evidence();inconsistent.content.debit.totalOs='4000000001';
 await rejectsWith(approval.retained.prepare(inconsistent),'approval_refused');assert.equal(asked,before);
 // The 50 DEM ceiling: a debit of exactly 50 DEM is confirmed, one OS more is never approved.
 const atCeiling=evidence({rpcFeeDem:'47',nonce:5}),atCeilingDecision=await approval.retained.prepare(atCeiling);
 assert.equal(await approval.retained.confirm(bindingOf(atCeilingDecision),executed(atCeiling)),true);
 const aboveCeiling=evidence({rpcFeeDem:'47.000000001',nonce:6});
 await rejectsWith(approval.retained.prepare(aboveCeiling),'approval_refused');
 await rejectsWith(approval.retained.confirm({ledgerId:null,requestText:JSON.stringify(aboveCeiling)},executed(aboveCeiling)),'approval_reservation_unavailable');
 await zeroWrites();
});

test('confirmRetained refuses an otherwise valid executed confirmation whose fee members disagree with the declared debit, and one carrying a 2 MB unrelated member; it returns false and the ledger grows by 0 bytes',async t=>{
 const fixture=await ledgerFixture(t),request=evidence(),approval=fixture.compose(fixture.restart()),prepared=await approval.retained.prepare(request),before=await text(fixture.evidencePath);
 const disagreeing=executed(request);disagreeing.response.data.transaction.content.transaction_fee.rpc_fee='2000000000';
 assert.equal(await approval.retained.confirm(bindingOf(prepared),disagreeing),false);
 const oversized=executed(request);oversized.response.data.unrelated='x'.repeat(2*1024*1024);
 assert.equal(await approval.retained.confirm(bindingOf(prepared),oversized),false);
 assert.equal(await text(fixture.evidencePath),before);assert.equal(Buffer.byteLength(await text(fixture.evidencePath)),Buffer.byteLength(before));
 assert.equal(await approval.retained.confirm(bindingOf(prepared),executed(request)),true);
});

test('two retained.prepare calls for the same wallet, nonce and exact CREATE that differ only in display-only purpose: the second returns the open row or refuses, and one open sign authority exists afterwards',async t=>{
 const fixture=await ledgerFixture(t),approval=fixture.compose(fixture.restart()),first=evidence(),renamed=evidence();renamed.purpose='A different display-only purpose';
 const prepared=await approval.retained.prepare(first),before=await text(fixture.evidencePath);
 const second=await approval.retained.prepare(renamed);
 assert.equal(second.ledgerId,prepared.ledgerId);assert.equal(second.requestText,prepared.requestText);assert.equal(await text(fixture.evidencePath),before);
 assert.equal((await openSigns(fixture.evidencePath)).length,1);
 // The same wallet and nonce with a different CREATE is refused outright.
 const different=evidence({job:JOBS[1]});await rejectsWith(approval.retained.prepare(different),'approval_refused');assert.equal((await openSigns(fixture.evidencePath)).length,1);
});

test('a manual approval whose authorize double aborts the supplied signal and then returns true, table {abort fired inside authorize, signal already aborted before the call, abort fired after authorize resolved true and before the decision is recorded (held at a barrier)} × {retained.prepare in manual mode, shared-slot approve in manual mode}: each refuses operator_closing, no approved line is appended or kept in the in-process map, the ledger is byte-identical to before, the already-aborted case never calls authorize, and the next independent approval completes',async t=>{
 const cases={
  'abort fired inside authorize':{arm:(c)=>({authorize:async()=>{c.abort();return true;}})},
  'signal already aborted before the call':{arm:(c)=>{c.abort();return {authorize:async()=>{throw new Error('authorize was called');}};}},
  'abort fired after authorize resolved and before the decision is recorded':{arm:(c,fire)=>({authorize:async()=>{fire.armed=true;return true;},now:()=>{if(fire.armed)c.abort();return T0;}})},
 };
 for(const [name,{arm}] of Object.entries(cases))for(const route of ['retained.prepare','shared-slot approve']){
  const fixture=await ledgerFixture(t),controller=new AbortController(),request=evidence(),before=await text(fixture.evidencePath);
  const manual=manualApprover(fixture,{...arm(controller,{armed:false}),signal:controller.signal}),approval=composeSellerApproval({mode:'manual',policy:fixture.restart(),manual});
  await rejectsWith(route==='retained.prepare'?approval.retained.prepare(request):approval(request),'operator_closing');
  assert.equal(await text(fixture.evidencePath),before,`${name} / ${route}: the ledger is byte-identical`);
  if(route==='retained.prepare')assert.equal(await approval.retained.open(JSON.stringify(request)),null,`${name}: nothing kept in the in-process map`);
  const next=composeSellerApproval({mode:'manual',policy:fixture.restart(),manual:manualApprover(fixture)});
  assert.equal(route==='retained.prepare'?(await next.retained.prepare(request)).ledgerId:await next(request),route==='retained.prepare'?null:true,`${name} / ${route}: the next approval completes`);
 }
});

test('confirmRetained(ledgerId, c) with c in {null, false, 0, \'\'} on an open sign-authorized reservation returns false and the reservation is still open; no appended line carries its reservationId, parsePolicyLedger still reads the evidence file, another request\'s prepare and approval complete without waiting, and a later exact confirmation links once; the shared-slot approve(request, null) keeps today\'s confirmation-mismatch release and the ledger still parses',async t=>{
 const fixture=await ledgerFixture(t),request=evidence(),approval=fixture.compose(fixture.restart()),prepared=await approval.retained.prepare(request);
 for(const falsy of [null,false,0,'']){
  const before=await text(fixture.evidencePath);
  assert.equal(await approval.retained.confirm(bindingOf(prepared),falsy),false,`${String(falsy)||'empty string'}`);
  assert.equal(await text(fixture.evidencePath),before);assert.equal((await rowOf(fixture.evidencePath,prepared.ledgerId)).outcome,null);
 }
 assert.equal((await lines(fixture.evidencePath)).filter(line=>line.reservationId===prepared.ledgerId).length,1,'only the sign line carries the reservationId');
 const other=secondEvidence();assert.ok((await withinTimeout(approval.retained.prepare(other))).ledgerId);assert.equal(await withinTimeout(approval(artifactWrite())),true);
 assert.equal(await approval.retained.confirm(bindingOf(prepared),executed(request)),true);assert.equal((await linkedLines(fixture.evidencePath,prepared.ledgerId)).length,1);
 const session=fixture.compose(fixture.restart()),write=sessionWrite();
 assert.equal(await session(write),true);assert.equal(await session.confirm(null),false);
 assert.equal((await lines(fixture.evidencePath)).filter(line=>line.outcome==='released'&&line.reason==='confirmation-mismatch').length,1);
 assert.ok((await parsed(fixture.evidencePath)).rows.length>0);
});

const ROOT_IGNORES_PERMISSIONS=process.getuid?.()===0;
test('a sign line whose sync fails after it was written rejects with that error and leaves no open authorization; once the directory syncs, prepare opens one authorization and counts one write',{skip:ROOT_IGNORES_PERMISSIONS},async t=>{
 const fixture=await ledgerFixture(t),outer=join(fixture.directory,'outer'),inner=join(outer,'inner');
 await mkdir(inner,{recursive:true});
 const evidencePath=join(inner,'approvals.jsonl'),request=evidence();
 const approval=fixture.compose(createExactOperatorApproval({maxTotalOs:fixture.maxTotalOs,evidencePath,now:()=>T0,sellerApproval:{mode:'policy'},policy:fixture.policyInputs}));
 // The ledger directory's entry in its parent cannot be synced: the line is written whole, then the append throws.
 await chmod(outer,0o300);
 try{
  await assert.rejects(approval.retained.prepare(request),error=>error.code==='EACCES');
  assert.deepEqual(await openSigns(evidencePath),[]);
 }finally{await chmod(outer,0o700);}
 const prepared=await approval.retained.prepare(request);
 assert.equal((await openSigns(evidencePath)).length,1);assert.equal(prepared.requestText,JSON.stringify(request));assert.equal((await budget(evidencePath)).writes,1);
});

test('a manual authorization lives only in its process: after a restart open(requestText) returns null and prepare asks the operator again',async t=>{
 const fixture=await ledgerFixture(t);let asked=0;
 const manual=async()=>{asked++;return true;},first=composeSellerApproval({mode:'manual',policy:fixture.restart(),manual});
 const prepared=await first.retained.prepare(evidence());
 assert.deepEqual(await first.retained.open(prepared.requestText),{ledgerId:null,requestText:prepared.requestText});
 const restarted=composeSellerApproval({mode:'manual',policy:fixture.restart(),manual});
 assert.equal(await restarted.retained.open(prepared.requestText),null);
 assert.equal((await restarted.retained.prepare(evidence())).ledgerId,null);assert.equal(asked,2);
 assert.equal(await text(fixture.evidencePath),'');
});

test('settle by id still completes after the approval is stopped, and a second settle of the same outcome is a no-op',async t=>{
 const fixture=await ledgerFixture(t),policy=fixture.restart(),approval=fixture.compose(policy),request=evidence(),prepared=await approval.retained.prepare(request);
 assert.equal(await approval.retained.confirm(bindingOf(prepared),executed(request)),true);
 await policy.stop();
 await approval.retained.settle(bindingOf(prepared),'spent');await approval.retained.settle(bindingOf(prepared),'spent');
 assert.equal((await completions(fixture.evidencePath,prepared.ledgerId)).length,1);assert.equal((await rowOf(fixture.evidencePath,prepared.ledgerId)).outcome,'spent');
});

const SIGN_FORMAT='dacs-node2-seller-policy-sign-authorization/v1';
const signLineFor=(requestBytes)=>JSON.stringify({format:SIGN_FORMAT,reservationId:randomUUID(),approvalHash:createHash('sha256').update(requestBytes).digest('hex'),requestBytes,totalOs:JSON.parse(requestBytes).content.debit.totalOs,recordedAt:T0})+'\n';

test('open(requestText) refuses with approval_ambiguous when two open authorizations hold the same exact bytes, instead of reporting none',async t=>{
 const fixture=await ledgerFixture(t),approval=fixture.compose(fixture.restart()),prepared=await approval.retained.prepare(evidence());
 await appendFile(fixture.evidencePath,signLineFor(prepared.requestText));
 await rejectsWith(approval.retained.open(prepared.requestText),'approval_ambiguous');
});

test('a retained row whose stored bytes are not the canonical JSON of their request is refused by open and reopen with approval_ledger_mismatch',async t=>{
 const fixture=await ledgerFixture(t),approval=fixture.compose(fixture.restart()),spaced=JSON.stringify(evidence(),null,1),line=signLineFor(spaced);
 await appendFile(fixture.evidencePath,line);
 await rejectsWith(approval.retained.open(spaced),'approval_ledger_mismatch');
 await rejectsWith(approval.retained.reopen(JSON.parse(line).reservationId),'approval_ledger_mismatch');
});

// Every by-id operation and the exact-request lookup refuse a sign row that a session write owns: it is not a retained authorization.
const assertNotRetainable=async(fixture,request,ledgerId)=>{
 const approval=fixture.compose(fixture.restart()),before=await text(fixture.evidencePath),binding={ledgerId,requestText:JSON.stringify(request)};
 await assert.rejects(approval.retained.prepare(request),error=>error.code==='approval_refused'&&error.reason==='sign-authorization-open');
 assert.equal(await approval.retained.open(binding.requestText),null);
 await rejectsWith(approval.retained.reopen(ledgerId),'approval_reservation_unavailable');
 await rejectsWith(approval.retained.confirm(binding,executed(request)),'approval_reservation_unavailable');
 await rejectsWith(approval.retained.settle(binding,'released'),'approval_reservation_unavailable');
 assert.equal(await text(fixture.evidencePath),before,'the ledger is byte-identical');await parsed(fixture.evidencePath);
};

test('the sign row of a manually held session write (it carries an attemptId) is no retained authorization: prepare refuses sign-authorization-open, open returns null, reopen, confirm and settle by id reject, and the ledger is unchanged and still parses',async t=>{
 // The policy fee cap (3 DEM) is below the request's 4 DEM debit: the write is held, and the operator's yes signs it with an attemptId.
 const fixture=await ledgerFixture(t,{limits:{maxWriteTotalOs:'3000000000'}}),request=evidence();
 assert.equal(await fixture.compose(fixture.restart(),manualApprover(fixture))(request),true);
 const [signed]=await signLines(fixture.evidencePath);assert.ok(signed.attemptId,'the sign line carries the held attempt');
 await assertNotRetainable(fixture,request,signed.reservationId);
});

test('the sign row a live session write of this process holds in the shared slot is no retained authorization; after a restart it has no session owner and prepare returns it',async t=>{
 const fixture=await ledgerFixture(t),session=fixture.compose(fixture.restart()),request=evidence();
 assert.equal(await session(request),true);
 const [signed]=await signLines(fixture.evidencePath);
 // The same approval that owns the shared slot refuses it by every retained operation.
 const before=await text(fixture.evidencePath);
 await assert.rejects(session.retained.prepare(request),error=>error.reason==='sign-authorization-open');
 assert.equal(await session.retained.open(JSON.stringify(request)),null);
 await rejectsWith(session.retained.settle({ledgerId:signed.reservationId,requestText:JSON.stringify(request)},'released'),'approval_reservation_unavailable');
 assert.equal(await text(fixture.evidencePath),before);
 assert.equal((await fixture.compose(fixture.restart()).retained.prepare(request)).ledgerId,signed.reservationId);
});

test('a manual authorization is not prepared again after it was settled, so a repeated settlement of the first binding cannot cancel a later one',async t=>{
 const fixture=await ledgerFixture(t);let asked=0;
 const approval=composeSellerApproval({mode:'manual',policy:fixture.restart(),manual:async()=>{asked++;return true;}}),request=evidence();
 const first=await approval.retained.prepare(request);
 await approval.retained.settle(first,'released');
 await rejectsWith(approval.retained.prepare(request),'approval_refused');assert.equal(asked,1,'the operator is not asked again for settled bytes');
 await approval.retained.settle(first,'released');
 assert.equal(await approval.retained.open(first.requestText),null);
 await rejectsWith(approval.retained.confirm(first,executed(request)),'approval_reservation_unavailable');
 // A settlement that leaves the outcome open, or one for bytes never prepared, settles nothing.
 const other=secondEvidence(),decision=await approval.retained.prepare(other);
 await approval.retained.settle(decision,'unknown');await approval.retained.settle({ledgerId:null,requestText:JSON.stringify(evidence({nonce:7}))},'released');
 assert.equal(await approval.retained.confirm(decision,executed(other)),true);
 assert.equal((await approval.retained.prepare(evidence({nonce:7}))).ledgerId,null);
});
