import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonicalize, compositeVerificationAddress, contentHash, finalityCommitmentAddress, paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { createSellerAgent } from '../src/dacs/seller-agent.mjs';
import * as operatorCustody from '../src/devnet-demo/operator-custody.mjs';
import { composeSellerApproval, createExactOperatorApproval, SELLER_POLICY_DEFAULTS, SELLER_POLICY_MAX_WRITES, SELLER_POLICY_WINDOW_MS, sellerApprovalSettings } from '../src/devnet-demo/operator-approval.mjs';
import { createLoopbackTestTlsMaterial } from './helpers/loopback-test-tls.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { createAdmittedNode2DemoTransport, createNode2TransportOwner } from '../src/devnet-demo/operator-network.mjs';
import { layoutAdmission, layoutChain, memoryJournal, node2Stub } from './helpers/review-node2-current-coverage-fixture.mjs';

const sha=(value)=>createHash('sha256').update(value).digest('hex');
const jobId='01ARZ3NDEKTSV4RRFFQ69G5FAV',address=`0x${'a'.repeat(64)}`,seller=`did:demos:agent:${'a'.repeat(64)}`;
const pin={listingId:'policy-listing',version:1,contentHash:'b'.repeat(64)};
const sourceBinding={source:'devnet-agreement-transport/v1',bindingVersion:'dacs-demos-network-binding/v1',bindingId:'c'.repeat(64),network:'demos-devnet',chainIdentity:'d'.repeat(64),endpoint:'https://node2.test.invalid/',pinVersion:'TEST-pin',transportAuthority:'TEST-owner'};
const buyer=`did:demos:agent:${'1'.repeat(64)}`;
const purchase={jobId,seller,buyer,listingPin:pin,sourceBinding,agreementHash:'e'.repeat(64),amountOs:'1000000000',paymentObserved:true,prePaymentOpen:false};
const demString=(os)=>{const whole=os/1_000_000_000n,fraction=(os%1_000_000_000n).toString().padStart(9,'0').replace(/0+$/,'');return fraction?`${whole}.${fraction}`:`${whole}`;};
// One exact seller CREATE approval request, as the embedded wallet shows it,
// for any policy kind. Fees are storage 1 + SDK gas 1 + network + rpc DEM.
function requestFor({artifactKind='Deliverable',job=jobId,party=buyer,phase='deliver-storage-program',artifact:override={},logicalAddress:addressOverride,storageFeeDem='1',sdkGasDem='1',networkFeeDem='1',rpcFeeDem='1'}={}){
  const settlementKind=artifactKind==='SettlementEvidence'&&phase==='pay-dem';
  const artifact={...(artifactKind==='Deliverable'?{reportVersion:'1',kind:'dacs-chatgpt-plugin/devnet-purchased-report',jobId:job,agreementHash:purchase.agreementHash,listing:pin,title:'Policy report',settlementId:'demos:TEST',producer:seller,content:{mediaType:'text/plain; charset=utf-8',text:'Purchased bytes'}}
    :artifactKind==='CompositeVerificationRecord'?{recordVersion:'1',jobId:job,evaluatedParty:party,verifier:seller}
    :artifactKind==='FinalityCommitmentRecord'?{finalityCommitmentVersion:'1',jobId:job,pattern:'fixed-price',agreementHash:purchase.agreementHash}
    :{evidenceVersion:'1',jobId:job,phase,outcome:'success',...(settlementKind?{paymentAmount:{amount:'1',currency:'DEM'}}:{})}),...override};
  const logicalAddress=addressOverride??(artifactKind==='Deliverable'?`dacs4:deliverable:${job}`:artifactKind==='CompositeVerificationRecord'?compositeVerificationAddress(job,party)
    :artifactKind==='FinalityCommitmentRecord'?finalityCommitmentAddress(job):settlementKind?paymentEvidenceAddress(job,'demos-native:DEM',2):`dacs4:evidence:${job}`);
  const programName=logicalAddress.replace(/:/g,'%3A'),storageAddress=deriveStorageAddress(address,programName,1);
  const tx=buildStorageProgramCreatePayload({from:address,storageAddress,programName,logicalAddress,signedListing:artifact,nonce:1,timestamp:7});
  const deliveryBinding=artifactKind==='Deliverable'?{version:'1',profile:'dacs-native-delivery-publication/v1',jobId:job,phase:'deliver-storage-program',phaseIndex:3,listing:pin,agreementHash:purchase.agreementHash,fulfilmentId:'TEST-fulfilment',purchaseAmount:{amount:'1',currency:'DEM'},payloadHash:contentHash(artifact)}:null;
  if(deliveryBinding)tx.content.data[1].metadata.deliveryBinding=deliveryBinding;
  Object.assign(tx.content.data[1].metadata,{contentHash:contentHash(artifact),envelopeHash:sha(canonicalize(artifact)),artifactKind,networkBinding:sourceBinding});
  const totalOs=[storageFeeDem,sdkGasDem,networkFeeDem,rpcFeeDem].reduce((sum,dem)=>sum+BigInt(dem.split('.')[0])*1_000_000_000n+BigInt((dem.split('.')[1]??'').padEnd(9,'0')),0n);
  return{method:'sendTransaction',address,purpose:`Create immutable ${artifactKind} for this exact job`,content:{kind:settlementKind?'devnet-settlement-evidence-storage-create':'devnet-demo-artifact-storage-create',action:'immutable DACS storage anchor CREATE',artifactKind,jobId:job,owner:seller,wallet:address,logicalAddress,storageAddress,programName,contentHash:contentHash(artifact),contentHashProfile:'SDK CF-1 signed scope (top-level signature/signatures omitted)',envelopeHash:sha(canonicalize(artifact)),...(deliveryBinding?{deliveryBinding}:{}),storageBytes:Buffer.byteLength(JSON.stringify(artifact)),exactStorageBytes:JSON.stringify(artifact),exactCreate:JSON.stringify(tx.content.data[1]),nonce:1,timestamp:7,debit:{storageFeeDem,sellerAmountDem:'0',sdkGasDem,networkFeeDem,rpcFeeDem,additionalFeeDem:'0',totalDem:demString(totalOs),totalOs:totalOs.toString(),note:'Complete debit'},network:sourceBinding.network,chainIdentity:sourceBinding.chainIdentity,networkBinding:sourceBinding,evidence:'TEST source',sending:'Send once'}};
}
const request=()=>requestFor();
async function approval(t,{resolvePurchase=()=>purchase,mode='policy',limits={},maxTotalOs='10000000000',clock=null,authorize=()=>{throw new Error('policy invoked human authority');}}={}){
  const root=await mkdtemp(join(tmpdir(),'seller-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const evidencePath=join(root,'approvals.jsonl'),options={maxTotalOs,evidencePath,authorize,now:clock?()=>clock.now:()=>7,sellerApproval:{mode,...limits},policy:{address,seller,sourceBinding,listingPin:()=>pin,resolvePurchase}};
  return{evidencePath,options,approve:createExactOperatorApproval(options)};
}
const evidenceRows=async(path)=>{try{return(await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}};
// Decides one request and returns the decision and the single new evidence
// line (earlier lines may be deliberately malformed, so only it is parsed).
const rawLines=async(path)=>{try{return(await readFile(path,'utf8')).split('\n').filter(Boolean);}catch(error){if(error.code==='ENOENT')return[];throw error;}};
async function decideOnce(h,r){
  const before=(await rawLines(h.evidencePath)).length,decision=await h.approve(r),lines=await rawLines(h.evidencePath);
  assert.equal(lines.length,before+1);return{decision,row:JSON.parse(lines.at(-1))};
}
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX','01ARZ3NDEKTSV4RRFFQ69G5FAY','01ARZ3NDEKTSV4RRFFQ69G5FAZ'];
const byJob=(paid=true)=>(job)=>({...purchase,jobId:job,paymentObserved:paid,prePaymentOpen:!paid});

test('seller policy holds concurrent full debits across approval instances sharing a ledger',async t=>{
  const h=await approval(t,{resolvePurchase:byJob(false),limits:{maxTotalOsPerHour:'4000000000'}}),other=createExactOperatorApproval(h.options);
  const results=await Promise.all([h.approve(requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]})),other(requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]}))]);
  assert.equal(results.filter(Boolean).length,1);
});

test('seller policy holds outstanding ceilings across hours and recreation, then charges the settlement hour',async t=>{
  const clock={now:7},h=await approval(t,{resolvePurchase:byJob(false),clock,limits:{maxTotalOsPerHour:'4000000000'}});
  const first=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]}),next=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]});
  assert.equal(await h.approve(first),true);
  clock.now+=SELLER_POLICY_WINDOW_MS;
  const again=createExactOperatorApproval(h.options);
  assert.equal(await again(next),false,'an outstanding reservation never ages out');
  await h.approve.settle(first,'spent');
  assert.equal(await again(next),false,'spend is charged when the attempt finishes');
  clock.now+=SELLER_POLICY_WINDOW_MS;
  assert.equal(await again(next),true);
});

test('seller policy releases a provably unsent attempt, including its single-use job quota',async t=>{
  const h=await approval(t,{resolvePurchase:byJob(false),limits:{maxWritesPerHour:1}});
  for(let i=0;i<SELLER_POLICY_MAX_WRITES+1;i++){
    const r=requestFor({artifactKind:'FinalityCommitmentRecord'});
    assert.equal(await h.approve(r),true);
    await h.approve.settle(r,'released');
  }
});

test('seller policy failed and unknown sent attempts retain their fee allowance',async t=>{
  for(const outcome of ['spent','unknown']){
    const clock={now:7},h=await approval(t,{resolvePurchase:byJob(false),clock,limits:{maxWritesPerHour:1}});
    const r=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]});assert.equal(await h.approve(r),true);
    await h.approve.settle(r,outcome);
    assert.equal(await h.approve(requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]})),false);
    if(outcome==='unknown'){clock.now+=SELLER_POLICY_WINDOW_MS;assert.equal(await createExactOperatorApproval(h.options)(requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]})),false);}
  }
});

test('seller policy budget caps paid attempts too; a refusal uses the existing manual fallback',async t=>{
  const h=await approval(t,{resolvePurchase:byJob(),limits:{maxTotalOsPerHour:'4000000000'}});
  assert.equal(await h.approve(requestFor({job:JOBS[0]})),true);
  let manual=0;
  const composed=composeSellerApproval({mode:'policy',policy:h.approve,manual:async()=>{manual++;return true;}});
  assert.equal(await composed(requestFor({job:JOBS[1]})),true);
  assert.equal(manual,1);
  assert.equal((await evidenceRows(h.evidencePath)).at(-1).policyReason,'hourly-dem-limit');
});

test('operator wallet read-only rejection releases budget before another attempt and consumes no job quota',async t=>{
  const h=await approval(t,{resolvePurchase:byJob(false),limits:{maxWritesPerHour:1}}),attempt=operatorCustody.createOperatorApprovalAttempt(h.approve);
  for(let i=0;i<SELLER_POLICY_MAX_WRITES+1;i++){
    const r=requestFor({artifactKind:'FinalityCommitmentRecord'});
    const result=await attempt.run(async()=>{
      assert.equal(await attempt.approve(r),true);
      // The packaged wallet rechecks nonce/network after approval, before signing.
      return{success:false,error:{code:'stale_plan'}};
    });
    assert.equal(result.error.code,'stale_plan');
  }
  assert.equal((await evidenceRows(h.evidencePath)).filter(row=>row.outcome==='released').length,SELLER_POLICY_MAX_WRITES+1);
});

test('operator wallet charges fees for included and refused sends; unknown or pending sends stay held across hours',async t=>{
  for(const result of [{success:true,data:{writeProof:{disposition:'included'}}},{success:false,error:{code:'broadcast_rejected'}},{success:false,error:{code:'outcome_unknown'}},{success:true,data:{hash:'f'.repeat(64)}}]){
    const clock={now:7},h=await approval(t,{resolvePurchase:byJob(false),clock,limits:{maxWritesPerHour:1}}),attempt=operatorCustody.createOperatorApprovalAttempt(h.approve);
    await attempt.run(async()=>{
      assert.equal(await attempt.approve(requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]})),true);
      attempt.issuing({stage:'broadcast-started'});clock.now+=SELLER_POLICY_WINDOW_MS;return result;
    });
    const next=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]}),again=createExactOperatorApproval(h.options);
    assert.equal(await again(next),false);
    clock.now+=SELLER_POLICY_WINDOW_MS;
    assert.equal(await again(next),Boolean(result.data?.writeProof)||result.error?.code==='broadcast_rejected');
  }
});

function failCompletionRead(t,h){
  const settle=h.approve.settle,logs=[];
  t.mock.method(h.approve,'settle',async(request,outcome)=>{
    const retained=`${h.evidencePath}.retained`;
    await rename(h.evidencePath,retained);await mkdir(h.evidencePath);
    try{return await settle(request,outcome);}finally{await rm(h.evidencePath,{recursive:true});await rename(retained,h.evidencePath);}
  });
  t.mock.method(process.stderr,'write',line=>{logs.push(String(line));return true;});
  return logs;
}

test('operator wallet keeps an included result when completion evidence fails and replay retains its full hold',async t=>{
  const clock={now:7},h=await approval(t,{resolvePurchase:byJob(false),clock,limits:{maxTotalOsPerHour:'4000000000'}}),logs=failCompletionRead(t,h);
  const attempt=operatorCustody.createOperatorApprovalAttempt(h.approve),result={success:true,data:{hash:'f'.repeat(64),writeProof:{disposition:'included'}}};
  assert.equal(await attempt.run(async()=>{
    assert.equal(await attempt.approve(requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]})),true);
    attempt.issuing({stage:'broadcast-started'});return result;
  }),result);
  assert.equal(logs.length,1);assert.match(logs[0],/^devnet-operator-approval-error:EISDIR:/);
  assert.equal((await evidenceRows(h.evidencePath)).length,1);
  clock.now+=2*SELLER_POLICY_WINDOW_MS;
  const {decision,row}=await decideOnce({...h,approve:createExactOperatorApproval(h.options)},requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]}));
  assert.equal(decision,false);assert.equal(row.policyReason,'hourly-dem-limit');
});

test('operator wallet keeps an unsent refusal when completion evidence fails and replay conservatively holds it',async t=>{
  const clock={now:7},h=await approval(t,{resolvePurchase:byJob(false),clock,limits:{maxWritesPerHour:1}}),logs=failCompletionRead(t,h);
  const attempt=operatorCustody.createOperatorApprovalAttempt(h.approve),result={success:false,error:{code:'stale_plan'}};
  assert.equal(await attempt.run(async()=>{
    assert.equal(await attempt.approve(requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]})),true);return result;
  }),result);
  assert.equal(logs.length,1);assert.match(logs[0],/^devnet-operator-approval-error:EISDIR:/);
  assert.equal((await evidenceRows(h.evidencePath)).length,1);
  clock.now+=2*SELLER_POLICY_WINDOW_MS;
  const {decision,row}=await decideOnce({...h,approve:createExactOperatorApproval(h.options)},requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]}));
  assert.equal(decision,false);assert.equal(row.policyReason,'hourly-write-limit');
});

test('operator wallet error wins when completion evidence also fails',async t=>{
  const h=await approval(t,{resolvePurchase:byJob(false)}),logs=failCompletionRead(t,h),attempt=operatorCustody.createOperatorApprovalAttempt(h.approve),walletError=new Error('TEST wallet failed');
  await assert.rejects(attempt.run(async()=>{
    assert.equal(await attempt.approve(requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]})),true);throw walletError;
  }),error=>error===walletError);
  assert.equal(logs.length,1);assert.match(logs[0],/^devnet-operator-approval-error:EISDIR:/);
  assert.equal((await evidenceRows(h.evidencePath)).length,1);
});
// A line from before request bytes were retained (pre-L4 manual approvals).
let legacyCount=0;
const legacyLine=(decision='approved')=>JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',approvalHash:sha(`legacy-${legacyCount++}`),method:'sendTransaction',address,totalOs:'4000000000',decision,recordedAt:7});
// A manual line as written since request bytes are retained.
const manualLine=(r,decision='approved')=>{const requestBytes=JSON.stringify(r);return JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',approvalHash:sha(requestBytes),requestBytes,method:'sendTransaction',address,totalOs:r.content.debit.totalOs,decision,recordedAt:7});};

const evidenceAddress=(job)=>`dacs4:evidence:${job}`;
// Test-only seam: the seller artifact journal refuses the first delivery
// evidence intent write. That failure happens before the wallet is asked, so
// nothing is signed or sent and no intent is journaled.
function failEvidenceIntentOnce(){
  const state={fired:0};
  state.wrap=(journal)=>new Proxy(journal,{get(target,key){
    if(key==='put')return async(k,v)=>{
      if(!state.fired&&v?.stage==='intent'&&v.input?.artifactKind==='SettlementEvidence'&&String(v.input?.logicalAddress).startsWith('dacs4:evidence:')){state.fired++;throw Object.assign(new Error('TEST seller journal write failed before the delivery evidence CREATE was sent'),{code:'TEST-journal-unavailable'});}
      return target.put(k,v);
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  return state;
}
const accountOf=(h,operationId)=>h.application.db.prepare('SELECT account_id FROM operations WHERE id = ?').get(operationId).account_id;
const statusOf=(h,operationId)=>h.application.services.purchases.status(accountOf(h,operationId),operationId).protocol;
const evidenceCreates=(h,job)=>h.node2.chain.wire.record.accepted.filter(tx=>tx.content.data[1].metadata.logicalAddress===evidenceAddress(job));
// Stands in for the operator's 5-minute evidence resume interval: tick() runs
// the registered pass the way the interval would and returns its promise.
const manualTimer=()=>{
  const registrations=[];
  return{registrations,every:(run,ms)=>{const handle={run,ms,cancelled:false};registrations.push(handle);return handle;},cancel:(handle)=>{handle.cancelled=true;},
    tick(){const live=registrations.filter(r=>!r.cancelled);assert.equal(live.length,1,'exactly one evidence resume interval is registered');assert.equal(live[0].ms,5*60*1000);return live[0].run();}};
};
const until=async(check,what,ms=60000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error(`timed out waiting for ${what}`);await new Promise(r=>setTimeout(r,100));}};

test('seller policy approves exact bounded purchase CREATEs and retains exact bytes and hash for every decision',async t=>{
  const h=await approval(t),r=request();assert.equal(await h.approve(r),true);
  r.content.debit.totalOs='4000000001';assert.equal(await h.approve(r),false);
  const rows=(await readFile(h.evidencePath,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row=>row.decision),['approved','rejected']);
  for(const row of rows){assert.equal(row.approvalHash,sha(row.requestBytes));assert.equal(row.requestBytes,JSON.stringify(JSON.parse(row.requestBytes)));}
});

test('seller policy refuses kind, amount, debit, Listing, job, owner, source and exact-byte mismatches',async t=>{
  const h=await approval(t);
  for(const mutate of [r=>r.content.artifactKind='Listing',r=>r.content.action='UPDATE',r=>r.content.debit.sellerAmountDem='1',r=>r.content.debit.totalDem='3',r=>r.content.debit.sdkGasDem='0',r=>r.content.jobId='unknown',r=>r.content.owner=`did:demos:agent:${'f'.repeat(64)}`,r=>r.content.chainIdentity='f'.repeat(64),r=>r.content.networkBinding={...sourceBinding,endpoint:'https://other.invalid/'},r=>r.content.exactStorageBytes='{}',r=>r.content.extra=true,r=>r.content.deliveryBinding={...r.content.deliveryBinding,listing:{...pin,version:2}}]){
    const r=request();mutate(r);assert.equal(await h.approve(r),false);
  }
  for(const altered of [null,{...purchase,listingPin:{...pin,contentHash:'f'.repeat(64)}},{...purchase,sourceBinding:{...sourceBinding,chainIdentity:'f'.repeat(64)}},{...purchase,agreementHash:'f'.repeat(64)},{...purchase,amountOs:'999000000000'},{...purchase,amountOs:null},{...purchase,prePaymentOpen:'yes'}])assert.equal(await (await approval(t,{resolvePurchase:()=>altered})).approve(request()),false);
  assert.equal((await readFile(h.evidencePath,'utf8')).trim().split('\n').length,12);
  // The delivery amount must equal the purchase price, even when the request's metadata agrees with itself.
  const changed=request();changed.content.deliveryBinding.purchaseAmount.amount='999';
  const op=JSON.parse(changed.content.exactCreate);op.metadata.deliveryBinding=changed.content.deliveryBinding;changed.content.exactCreate=JSON.stringify(op);
  assert.equal(await (await approval(t)).approve(changed),false);
});

test('seller policy count is fixed, serialized, survives recreation and fails closed on malformed evidence',async t=>{
  const h=await approval(t);
  const results=await Promise.all(Array.from({length:SELLER_POLICY_MAX_WRITES+1},()=>h.approve(request())));
  assert.equal(results.filter(Boolean).length,SELLER_POLICY_MAX_WRITES);
  assert.equal(await createExactOperatorApproval(h.options)(request()),false);
  await writeFile(h.evidencePath,'not-json\n');assert.equal(await h.approve(request()),false);
});

test('seller manual approval remains default, preserves callback decisions and requires a TTY without a callback',async t=>{
  const h=await approval(t,{mode:'manual',authorize:()=>false});assert.equal(await h.approve(request()),false);
  const {sellerApproval,policy,...options}=h.options;
  assert.equal(await createExactOperatorApproval({...options,authorize:()=>true})(request()),true);
  let calls=0,release;const held=new Promise(resolve=>{release=resolve;});
  const manual=createExactOperatorApproval({...options,authorize:async()=>{calls++;await held;return false;}}),first=manual(request()),second=manual(request());
  assert.equal(calls,2);release();assert.deepEqual(await Promise.all([first,second]),[false,false]);
  if(!process.stdin.isTTY||!process.stdout.isTTY)await assert.rejects(createExactOperatorApproval({...options,authorize:undefined})(request()),/interactive TTY/);
  assert.throws(()=>createExactOperatorApproval({...options,sellerApproval:{mode:'automatic'}}),/exact manual or policy/);
});

test('seller policy stage: vet records and the commitment only before payment; payment and delivery evidence and the Deliverable only after',async t=>{
  const state={paid:false},h=await approval(t,{resolvePurchase:(job)=>({...purchase,jobId:job,paymentObserved:state.paid,prePaymentOpen:!state.paid})});
  const cases=[
    ['CompositeVerificationRecord',{},false,null],['FinalityCommitmentRecord',{},false,null],
    ['SettlementEvidence',{phase:'pay-dem'},false,'payment-not-observed'],['SettlementEvidence',{},false,'payment-not-observed'],['Deliverable',{},false,'payment-not-observed'],
    ['CompositeVerificationRecord',{party:seller},true,'payment-already-observed'],['FinalityCommitmentRecord',{},true,'payment-already-observed'],
    ['SettlementEvidence',{phase:'pay-dem'},true,null],['SettlementEvidence',{},true,null],['Deliverable',{},true,null]];
  for(const[artifactKind,options,paid,reason]of cases){
    state.paid=paid;const r=requestFor({artifactKind,...options}),{decision,row}=await decideOnce(h,r);
    assert.equal(decision,reason===null,`${artifactKind} paid=${paid}`);assert.equal(row.policyReason,reason,`${artifactKind} paid=${paid}`);
    assert.equal(row.requestBytes,JSON.stringify(r));assert.equal(row.approvalHash,sha(row.requestBytes));
  }
});

test('seller policy vet records only evaluate the purchase buyer or the seller itself',async t=>{
  const h=await approval(t,{resolvePurchase:byJob(false)});
  for(const[party,reason]of[[buyer,null],[seller,null],[`did:demos:agent:${'9'.repeat(64)}`,'evaluated-party']]){
    const{decision,row}=await decideOnce(h,requestFor({artifactKind:'CompositeVerificationRecord',party}));
    assert.equal(decision,reason===null);assert.equal(row.policyReason,reason);
  }
});

test('seller policy per-write fee cap defaults to 4 DEM and is configurable, with boundaries at the cap and one OS over',async t=>{
  const h=await approval(t,{resolvePurchase:byJob()});
  assert.equal(SELLER_POLICY_DEFAULTS.maxWriteTotalOs,'4000000000');
  let out=await decideOnce(h,requestFor({job:JOBS[0]}));assert.equal(out.decision,true);assert.equal(out.row.totalOs,'4000000000');
  out=await decideOnce(h,requestFor({job:JOBS[1],rpcFeeDem:'1.000000001'}));assert.equal(out.decision,false);assert.equal(out.row.totalOs,'4000000001');assert.equal(out.row.policyReason,'write-fee-cap');
  const raised=await approval(t,{resolvePurchase:byJob(),limits:{maxWriteTotalOs:'5000000000'}});
  for(const[job,rpcFeeDem,reason]of[[JOBS[0],'1.000000001',null],[JOBS[1],'2',null],[JOBS[2],'2.000000001','write-fee-cap']]){
    out=await decideOnce(raised,requestFor({job,rpcFeeDem}));assert.equal(out.decision,reason===null,rpcFeeDem);assert.equal(out.row.policyReason,reason);
  }
});

function confirmationFor(r,{gas='2000000000',legacy=false}={}){
  const amount=(value)=>legacy?Number(BigInt(value)/1_000_000_000n):value;
  return{result:200,response:{data:{valid:true,gas_operation:null,transaction:{content:{type:'storageProgram',amount:legacy?0:'0',from:r.address,nonce:r.content.nonce,timestamp:r.content.timestamp,data:['storageProgram',JSON.parse(r.content.exactCreate)],
    transaction_fee:{network_fee:amount('1000000000'),rpc_fee:amount('1000000000'),additional_fee:amount('0')},
    gcr_edits:[{type:'balance',operation:'remove',account:r.address,amount:amount((BigInt(r.content.debit.storageFeeDem)*1_000_000_000n).toString())},{type:'balance',operation:'remove',account:r.address,amount:amount(gas)}]}}}}};
}

test('seller policy provisional hold protects a paid preparation from another instance confirming first',async t=>{
  for(const limits of [{maxTotalOsPerHour:'4000000000'},{maxWritesPerHour:1}]){
    const h=await approval(t,{resolvePurchase:byJob(),limits}),other=createExactOperatorApproval(h.options);
    const a=requestFor({job:JOBS[0]}),b=requestFor({job:JOBS[1]});
    const composed=composeSellerApproval({mode:'policy',policy:h.approve,manual:async()=>{throw new Error('unexpected manual approval');}});
    assert.equal(await composed(a),true);assert.deepEqual(await evidenceRows(h.evidencePath),[]);
    const preparedB=await other.prepare(b);
    if(preparedB)assert.equal(await other(b,confirmationFor(b)),true);
    assert.equal(await composed.confirm(confirmationFor(a)),true,'A must not lose its prepared budget');
    assert.equal(preparedB,false,'B must be refused before signing');
    const rows=await evidenceRows(h.evidencePath);
    assert.equal(rows.filter(row=>row.decision==='approved').length,1);
    await composed.settle(a,'spent');
    assert.equal((await evidenceRows(h.evidencePath)).at(-1).outcome,'spent');
  }
});

test('seller policy provisional holds serialize concurrent paid preparations and direct decisions',async t=>{
  const h=await approval(t,{resolvePurchase:byJob(),limits:{maxTotalOsPerHour:'4000000000'}}),other=createExactOperatorApproval(h.options);
  const requests=[requestFor({job:JOBS[0]}),requestFor({job:JOBS[1]})];
  const decisions=await Promise.all([h.approve.prepare(requests[0]),other.prepare(requests[1])]);
  assert.equal(decisions.filter(Boolean).length,1);
  assert.equal(await createExactOperatorApproval(h.options)(requestFor({job:JOBS[2]})),false);
});

test('seller policy provisional hold is released by an unsent wallet abort without using budget or job slots',async t=>{
  const h=await approval(t,{limits:{maxWritesPerHour:1}});
  const composed=composeSellerApproval({mode:'policy',policy:h.approve,manual:async()=>{throw new Error('unexpected manual approval');}});
  const attempt=operatorCustody.createOperatorApprovalAttempt(composed),other=createExactOperatorApproval(h.options);
  for(let i=0;i<SELLER_POLICY_MAX_WRITES+1;i++){
    const r=requestFor();
    const result=await attempt.run(async()=>{
      assert.equal(await attempt.approve(r),true);
      assert.equal(await other.prepare(requestFor()),false,'provisional hold occupies the only slot');
      return{success:false,error:{code:'stale_plan'}};
    });
    assert.equal(result.error.code,'stale_plan');
    assert.equal(await composed.confirm(confirmationFor(r)),false,'aborted preparation is consumed');
  }
  assert.equal((await evidenceRows(h.evidencePath)).filter(row=>row.decision==='approved').length,0);
  assert.equal(await other.prepare(requestFor()),true);
});

test('seller policy provisional holds reserve the last job slot and survive the hourly boundary',async t=>{
  const clock={now:7},h=await approval(t,{clock}),other=createExactOperatorApproval(h.options),r=requestFor();
  for(let i=0;i<SELLER_POLICY_MAX_WRITES-1;i++)assert.equal(await h.approve(requestFor()),true);
  assert.equal(await h.approve.prepare(r),true);
  clock.now+=2*SELLER_POLICY_WINDOW_MS;
  assert.equal(await other.prepare(requestFor()),false);
  assert.equal((await evidenceRows(h.evidencePath)).at(-1).policyReason,'job-write-limit');
  assert.equal(await h.approve(r,confirmationFor(r)),true);
});

test('seller policy provisional hold is dropped on replacement and refused or mismatched confirmation',async t=>{
  const h=await approval(t,{resolvePurchase:byJob(),limits:{maxWritesPerHour:1}}),other=createExactOperatorApproval(h.options);
  const composed=composeSellerApproval({mode:'policy',policy:h.approve,manual:async()=>{throw new Error('unexpected manual approval');}});
  const a=requestFor({job:JOBS[0]}),b=requestFor({job:JOBS[1]});
  assert.equal(await composed(a),true);
  assert.equal(await other.prepare(b),false,'hold occupies the slot before replacement');
  assert.equal(await composed(b),true,'replacement frees the previous preparation');
  assert.equal(await composed.confirm(confirmationFor(b,{gas:'3000000001'})),false,'fee refusal has no manual override');
  assert.equal(await other.prepare(a),true,'fee refusal frees the hold');await other.settle(a,'released');
  assert.equal(await composed(a),true);const mismatched=confirmationFor(a);mismatched.response.data.transaction.content.nonce++;
  assert.equal(await composed.confirm(mismatched),false);
  assert.equal(await other.prepare(b),true,'mismatched confirmation frees the hold');await other.settle(b,'released');
});

test('seller policy accepts SDK gas other than 1 DEM within its existing cap',async t=>{
  const h=await approval(t);
  const{decision,row}=await decideOnce(h,requestFor({sdkGasDem:'0.5'}));
  assert.equal(decision,true);assert.equal(row.totalOs,'3500000000');
  const over=await decideOnce(h,requestFor({sdkGasDem:'2'}));
  assert.equal(over.decision,false);assert.equal(over.row.policyReason,'write-fee-cap');
});

test('seller policy single cap uses confirmed storage/gas debits in OS and legacy DEM, with no duplicate transaction-fee debit',async t=>{
  for(const legacy of [false,true]){
    const h=await approval(t),r=requestFor();
    assert.equal(await h.approve(r,confirmationFor(r,{legacy})),true);
    const[row]=await evidenceRows(h.evidencePath);assert.equal(row.totalOs,'4000000000');assert.equal(row.confirmedRemovalsOs,'3000000000');assert.ok(row.confirmation);
  }
});

test('seller policy refuses one OS over the cap and missing, malformed or ambiguous confirmed fees',async t=>{
  const cases=[
    ['over-cap',v=>v.response.data.transaction.content.gcr_edits[1].amount='3000000001','write-fee-cap'],
    ['missing fees',v=>delete v.response.data.transaction.content.transaction_fee,'debit'],
    ['missing component',v=>delete v.response.data.transaction.content.transaction_fee.rpc_fee,'debit'],
    ['fractional fees',v=>v.response.data.transaction.content.transaction_fee.rpc_fee=0.5,'debit'],
    ['unsafe fees',v=>v.response.data.transaction.content.transaction_fee.rpc_fee=Number.MAX_SAFE_INTEGER+1,'debit'],
    ['noncanonical fees',v=>v.response.data.transaction.content.transaction_fee.rpc_fee='01','debit'],
    ['negative fees',v=>v.response.data.transaction.content.transaction_fee.rpc_fee=-1,'debit'],
    ['missing gas',v=>v.response.data.transaction.content.gcr_edits.pop(),'debit'],
    ['malformed gas',v=>v.response.data.transaction.content.gcr_edits[1].amount='1.5','debit'],
    ['unexpected gas view',v=>v.response.data.gas_operation={fees:{}},'debit'],
    ['numeric post-fork gas',v=>v.response.data.transaction.content.gcr_edits[1].amount=2000000000,'debit'],
    ['numeric post-fork fee',v=>v.response.data.transaction.content.transaction_fee.rpc_fee=1,'debit'],
    ['OS strings with legacy root amount',v=>v.response.data.transaction.content.amount=0,'debit']];
  for(const[name,mutate,reason]of cases){
    await t.test(name,async t=>{const h=await approval(t),r=requestFor(),v=confirmationFor(r);mutate(v);
      assert.equal(await h.approve(r,v),false);assert.equal((await evidenceRows(h.evidencePath)).at(-1).policyReason,reason);});
  }
});

test('confirmed seller fee cap is inclusive, configurable and exact above the safe numeric range',async t=>{
  const r=requestFor(),h=await approval(t);
  assert.equal(await h.approve(r,confirmationFor(r,{gas:'3000000000'})),true);
  const raised=await approval(t,{limits:{maxWriteTotalOs:'5000000000'}});
  assert.equal(await raised.approve(requestFor({sdkGasDem:'2'}),confirmationFor(requestFor({sdkGasDem:'2'}),{gas:'4000000000'})),true);
  const cap='9007199254740993',large=await approval(t,{maxTotalOs:cap,limits:{maxWriteTotalOs:cap,maxTotalOsPerHour:cap}});
  const largeRequest=requestFor({sdkGasDem:demString(BigInt(cap)-3_000_000_000n)});
  assert.equal(await large.approve(largeRequest,confirmationFor(largeRequest,{gas:'9007198254740993'})),true);
  assert.equal((await evidenceRows(large.evidencePath)).at(-1).totalOs,cap);
  const under=await approval(t,{maxTotalOs:cap,limits:{maxWriteTotalOs:'9007199254740992',maxTotalOsPerHour:cap}});
  assert.equal(await under.approve(largeRequest,confirmationFor(largeRequest,{gas:'9007198254740993'})),false);
  assert.equal((await evidenceRows(under.evidencePath)).at(-1).policyReason,'write-fee-cap');
});

test('seller policy prepares within the declared cap and completes it once from the matching confirmation',async t=>{
  const h=await approval(t),r=requestFor({sdkGasDem:'0.5'});
  let manual=0;
  const composed=composeSellerApproval({mode:'policy',policy:h.approve,manual:async()=>{manual++;return true;}});
  assert.equal(await composed(r),true);assert.deepEqual(await evidenceRows(h.evidencePath),[]);
  const v=confirmationFor(r,{gas:'3000000001'});
  assert.equal(await composed.confirm(v),false);assert.equal(manual,0);
  assert.equal((await evidenceRows(h.evidencePath)).at(-1).policyReason,'write-fee-cap');
  assert.equal(await composed.confirm(v),false,'a decision is consumed even when refused');
  assert.equal(await composed(r),true);assert.equal(await composed.confirm(confirmationFor(r)),true);
  assert.equal((await evidenceRows(h.evidencePath)).at(-1).totalOs,'3500000000');
  assert.equal(await composed(r),true);const altered=confirmationFor(r);altered.response.data.transaction.content.nonce++;
  assert.equal(await composed.confirm(altered),false,'different CREATE coordinates cannot use a prepared approval');
});

test('revision 3 counts declared 4 DEM despite confirmed 2 DEM in the hourly budget and evidence',async t=>{
  const h=await approval(t,{resolvePurchase:byJob(false),limits:{maxTotalOsPerHour:'7000000000'}});
  const r=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]});
  const composed=composeSellerApproval({mode:'policy',policy:h.approve,manual:async()=>{throw new Error('unexpected manual approval');}});
  assert.equal(await composed(r),true);assert.equal(await composed.confirm(confirmationFor(r,{gas:'1000000000'})),true);
  const[row]=await evidenceRows(h.evidencePath);
  assert.equal(row.totalOs,'4000000000');assert.equal(row.declaredTotalOs,'4000000000');assert.equal(row.confirmedRemovalsOs,'2000000000');assert.equal(row.countedTotalOs,'4000000000');
  assert.equal(await composed(requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]})),false);
  assert.equal((await evidenceRows(h.evidencePath)).at(-1).policyReason,'hourly-dem-limit');
});

for(const accepted of [true,false])test(`revision 3 paid 5 DEM Deliverable reaches manual approval before signing: ${accepted?'approved broadcasts':'declined refuses'}`,async t=>{
  const h=await approval(t),r=requestFor({storageFeeDem:'2',artifact:{content:{mediaType:'text/plain; charset=utf-8',text:'x'.repeat(11000)}}});
  let manualCalls=0,signs=0,broadcasts=0;
  const manual=createExactOperatorApproval({...h.options,sellerApproval:{mode:'manual'},authorize:({request})=>{manualCalls++;assert.equal(request.content.debit.totalOs,'5000000000');return accepted;}});
  const composed=composeSellerApproval({mode:'policy',policy:h.approve,manual});
  const prepared=await composed(r);assert.equal(manualCalls,1);assert.equal(prepared,accepted);
  if(prepared){signs++;assert.equal(await composed.confirm(confirmationFor(r,{gas:'3000000000'})),true);broadcasts++;}
  assert.equal(signs,accepted?1:0);assert.equal(broadcasts,accepted?1:0);
  if(accepted){
    const row=(await evidenceRows(h.evidencePath)).at(-1);assert.equal(row.declaredTotalOs,'5000000000');assert.equal(row.confirmedRemovalsOs,'5000000000');assert.equal(row.totalOs,'5000000000');
    assert.equal(await composed.confirm(confirmationFor(r)),false,'one approved request is consumed once');
    assert.equal(await composed(r),true);assert.equal(await composed.confirm(confirmationFor(r,{gas:'3000000001'})),false,'manual approval never permits an unexpected debit');
  }
});

test('revision 3 confirmed debit above the declaration is refused before broadcast even below the configured cap',async t=>{
  const h=await approval(t,{limits:{maxWriteTotalOs:'5000000000'}}),r=requestFor();
  const composed=composeSellerApproval({mode:'policy',policy:h.approve,manual:async()=>{throw new Error('unexpected manual override');}});
  assert.equal(await composed(r),true);
  let broadcasts=0;if(await composed.confirm(confirmationFor(r,{gas:'3000000001'})))broadcasts++;
  assert.equal(broadcasts,0);assert.equal((await evidenceRows(h.evidencePath)).at(-1).policyReason,'write-fee-cap');
});

test('revision 3 before-payment over-cap declaration is refused in prepare without signing',async t=>{
  const h=await approval(t,{resolvePurchase:byJob(false)}),r=requestFor({artifactKind:'FinalityCommitmentRecord',rpcFeeDem:'2'});
  let signs=0,manualCalls=0;
  const composed=composeSellerApproval({mode:'policy',policy:h.approve,manual:async()=>{manualCalls++;return true;}});
  if(await composed(r))signs++;
  assert.equal(signs,0);assert.equal(manualCalls,0);assert.equal((await evidenceRows(h.evidencePath)).at(-1).policyReason,'write-fee-cap');
});

test('a write refused by policy after payment goes to exact manual approval; before payment the refusal stands',async()=>{
  const calls=[],request=(artifactKind)=>({method:'sendTransaction',content:{artifactKind}});
  const compose=(mode,policyAnswer,manualAnswer)=>composeSellerApproval({mode,policy:async(r)=>{calls.push(['policy',r.content.artifactKind]);return policyAnswer;},manual:async(r)=>{calls.push(['manual',r.content.artifactKind]);return manualAnswer;}});
  for(const kind of ['SettlementEvidence','Deliverable']){
    calls.length=0;assert.equal(await compose('policy',false,true)(request(kind)),true,kind);
    assert.deepEqual(calls,[['policy',kind],['manual',kind]]);
    calls.length=0;assert.equal(await compose('policy',false,false)(request(kind)),false,'the operator can still decline');
  }
  for(const kind of ['CompositeVerificationRecord','FinalityCommitmentRecord','unknown']){
    calls.length=0;assert.equal(await compose('policy',false,true)(request(kind)),false,kind);
    assert.deepEqual(calls,[['policy',kind]],'a pre-payment refusal never prompts');
  }
  calls.length=0;assert.equal(await compose('policy',true,false)(request('Deliverable')),true);assert.deepEqual(calls,[['policy','Deliverable']]);
  calls.length=0;assert.equal(await compose('policy','yes',true)(request('CompositeVerificationRecord')),false,'only an exact true approves');
  calls.length=0;assert.equal(await compose('policy',true,true)(request('Listing')),true);assert.deepEqual(calls,[['manual','Listing']],'Listing writes are always manual');
  calls.length=0;assert.equal(await compose('manual',true,false)(request('Deliverable')),false);assert.deepEqual(calls,[['manual','Deliverable']]);
});

test('seller policy limit configuration is validated; manual stays exactly {mode}',()=>{
  assert.deepEqual(sellerApprovalSettings(undefined),{mode:'manual'});assert.deepEqual(sellerApprovalSettings({mode:'manual'}),{mode:'manual'});
  assert.deepEqual(sellerApprovalSettings({mode:'policy'}),{mode:'policy',...SELLER_POLICY_DEFAULTS});
  assert.deepEqual(sellerApprovalSettings({mode:'policy',maxWriteTotalOs:'5000000000',maxWritesPerHour:6,maxTotalOsPerHour:'5000000000'}),{mode:'policy',maxWriteTotalOs:'5000000000',maxWritesPerHour:6,maxTotalOsPerHour:'5000000000'});
  for(const bad of[{mode:'manual',maxWritesPerHour:1},{mode:'policy',other:1},{mode:'policy',maxWriteTotalOs:'0'},{mode:'policy',maxWriteTotalOs:'04'},{mode:'policy',maxWriteTotalOs:4},
    {mode:'policy',maxWritesPerHour:0},{mode:'policy',maxWritesPerHour:1001},{mode:'policy',maxWritesPerHour:'2'},{mode:'policy',maxTotalOsPerHour:'3999999999'},{mode:'policy',maxTotalOsPerHour:48000000000},null,[]])assert.throws(()=>sellerApprovalSettings(bad),TypeError,JSON.stringify(bad));
});

test('seller policy budget across jobs: writes and DEM per rolling hour, surviving recreation and ignoring manual decisions',async t=>{
  // Unpaid jobs: the commitment is a write the seller funds before payment.
  const commitment=(job)=>requestFor({artifactKind:'FinalityCommitmentRecord',job});
  const clock={now:1_000_000},h=await approval(t,{resolvePurchase:byJob(false),clock,limits:{maxWritesPerHour:2}});
  // A manual approval in the window is not a policy write.
  await writeFile(h.evidencePath,`${manualLine(commitment(JOBS[3]))}\n`);
  for(const job of [JOBS[0],JOBS[1]]){const r=commitment(job);assert.equal(await h.approve(r),true);await h.approve.settle(r,'spent');}
  let out=await decideOnce(h,commitment(JOBS[2]));assert.equal(out.decision,false);assert.equal(out.row.policyReason,'hourly-write-limit');
  const again=createExactOperatorApproval(h.options);
  clock.now+=SELLER_POLICY_WINDOW_MS-1;assert.equal(await again(commitment(JOBS[2])),false);
  clock.now+=1;assert.equal(await again(commitment(JOBS[2])),true);
  const dem=await approval(t,{resolvePurchase:byJob(false),clock,limits:{maxTotalOsPerHour:'8000000000'}});
  for(const job of [JOBS[0],JOBS[1]]){const r=commitment(job);assert.equal(await dem.approve(r),true);await dem.approve.settle(r,'spent');}
  out=await decideOnce(dem,commitment(JOBS[2]));assert.equal(out.decision,false);assert.equal(out.row.policyReason,'hourly-dem-limit');
  clock.now+=SELLER_POLICY_WINDOW_MS;assert.equal(await dem.approve(commitment(JOBS[2])),true);
});

test('seller policy hourly budget refuses further paid and unpaid writes once a paid write fills it',async t=>{
  // Paid policy writes use the same budget; composeSellerApproval supplies
  // exact manual approval when a paid request no longer fits.
  const resolvePurchase=(job)=>({...purchase,jobId:job,paymentObserved:job===JOBS[0],prePaymentOpen:job!==JOBS[0]});
  for(const limits of[{maxWritesPerHour:1},{maxTotalOsPerHour:'4000000000'}]){
    const h=await approval(t,{resolvePurchase,limits});
    assert.equal(await h.approve(requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem',job:JOBS[0]})),true);
    for(const r of [requestFor({job:JOBS[0]}),requestFor({artifactKind:'SettlementEvidence',job:JOBS[0]})]){
      const{decision,row}=await decideOnce(h,r);assert.equal(decision,false);assert.equal(row.policyReason,limits.maxWritesPerHour?'hourly-write-limit':'hourly-dem-limit');
    }
    const{decision,row}=await decideOnce(h,requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]}));
    assert.equal(decision,false);assert.equal(row.policyReason,limits.maxWritesPerHour?'hourly-write-limit':'hourly-dem-limit');
  }
});

test('seller policy writes the same evidence line for every refusal as for an approval, with the exact request bytes, hash and reason',async t=>{
  const clock={now:7};
  const approved=await decideOnce(await approval(t),request());assert.equal(approved.decision,true);assert.equal(approved.row.policyReason,null);
  const keys=Object.keys(approved.row).sort();
  assert.deepEqual(keys,['address','approvalHash','approvalMode','decision','format','method','policyReason','recordedAt','requestBytes','reservationId','totalOs']);
  // The primed write is JOBS[0]'s Deliverable (paid); JOBS[1] is still unpaid.
  const unpaid=byJob(false),primedPaid=(job)=>({...purchase,jobId:job,paymentObserved:job===JOBS[0],prePaymentOpen:job!==JOBS[0]});
  const cases=[
    ['operator-fee-budget',{maxTotalOs:'3999999999'},()=>request()],
    ['request-shape',{},()=>{const r=request();r.content.extra=true;return r;}],
    ['debit',{},()=>{const r=request();r.content.debit.sdkGasDem='0';return r;}],
    ['write-fee-cap',{},()=>requestFor({rpcFeeDem:'1.000000001'})],
    ['create-bytes',{},()=>{const r=request();r.content.exactStorageBytes='{}';return r;}],
    ['purchase',{resolvePurchase:()=>null},()=>request()],
    ['purchase',{resolvePurchase:()=>({...purchase,buyer:'0xnot-a-claim'})},()=>request()],
    ['payment-not-observed',{resolvePurchase:unpaid},()=>request()],
    ['payment-already-observed',{},()=>requestFor({artifactKind:'FinalityCommitmentRecord'})],
    ['evaluated-party',{resolvePurchase:unpaid},()=>requestFor({artifactKind:'CompositeVerificationRecord',party:`did:demos:agent:${'9'.repeat(64)}`})],
    ['logical-address',{},()=>requestFor({logicalAddress:`dacs4:deliverable:${JOBS[0]}`})],
    ['listing',{},()=>requestFor({artifact:{listing:{...pin,version:2}}})],
    ['agreement',{},()=>requestFor({artifact:{agreementHash:'f'.repeat(64)}})],
    ['delivery-binding',{},()=>{const r=request();r.content.deliveryBinding={...r.content.deliveryBinding,fulfilmentId:'TEST-other'};return r;}],
    ['purchase-closed',{resolvePurchase:(job)=>({...unpaid(job),prePaymentOpen:false})},()=>requestFor({artifactKind:'FinalityCommitmentRecord'})],
    // Open when the policy reads it, cancelled or expired by the final check after the ledger read.
    ['purchase-closed',{resolvePurchase:(()=>{let reads=0;return(job)=>({...unpaid(job),prePaymentOpen:reads++===0});})()},()=>requestFor({artifactKind:'FinalityCommitmentRecord'})],
    // The final check must be synchronous; a resolver that answers later fails closed.
    ['policy-check-failed',{resolvePurchase:(()=>{let reads=0;return(job)=>reads++===0?unpaid(job):Promise.resolve(unpaid(job));})()},()=>requestFor({artifactKind:'FinalityCommitmentRecord'})],
    ['payment-amount',{},()=>requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem',artifact:{paymentAmount:{amount:'2',currency:'DEM'}}})],
    ['job-write-limit',{seed:async(path)=>writeFile(path,`${Array.from({length:SELLER_POLICY_MAX_WRITES},()=>manualLine(request())).join('\n')}\n`)},()=>request()],
    ['hourly-write-limit',{limits:{maxWritesPerHour:1},prime:true,resolvePurchase:primedPaid},()=>requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]})],
    ['hourly-dem-limit',{limits:{maxTotalOsPerHour:'4000000000'},prime:true,resolvePurchase:primedPaid},()=>requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[1]})],
    ['evidence-unreadable',{seed:async(path)=>writeFile(path,'not-json\n')},()=>request()],
    ['policy-check-failed',{resolvePurchase:()=>{throw new Error('TEST purchase store unavailable');}},()=>request()]];
  for(const[reason,{seed,prime,resolvePurchase=byJob(),...options},make]of cases){
    const h=await approval(t,{resolvePurchase,clock,...options});
    if(seed)await seed(h.evidencePath);
    if(prime)assert.equal(await h.approve(requestFor({job:JOBS[0]})),true);
    const r=make(),{decision,row}=await decideOnce(h,r);
    assert.equal(decision,false,reason);assert.equal(row.decision,'rejected',reason);assert.equal(row.policyReason,reason);
    assert.deepEqual(Object.keys(row).sort(),keys,reason);assert.equal(row.format,'dacs-node2-operator-approval-evidence/v1');assert.equal(row.approvalMode,'policy');
    assert.equal(row.requestBytes,JSON.stringify(r),reason);assert.equal(row.approvalHash,sha(row.requestBytes),reason);assert.equal(row.recordedAt,7);
    assert.equal(row.totalOs,r.content.debit.totalOs,reason);assert.equal(row.method,'sendTransaction');assert.equal(row.address,address);
  }
});

test('seller approval evidence readers accept older lines without request bytes; malformed lines still fail closed',async t=>{
  // Older manual lines cannot be attributed to a job and are never policy
  // writes, so they count towards neither limit. The request is a pre-payment
  // commitment, which the hourly limit applies to.
  const h=await approval(t,{resolvePurchase:byJob(false),limits:{maxWritesPerHour:1}});
  await writeFile(h.evidencePath,`${Array.from({length:SELLER_POLICY_MAX_WRITES+1},()=>legacyLine()).join('\n')}\n${legacyLine('rejected')}\n`);
  let out=await decideOnce(h,requestFor({artifactKind:'FinalityCommitmentRecord'}));assert.equal(out.decision,true);assert.equal(out.row.policyReason,null);
  const rows=await evidenceRows(h.evidencePath);assert.equal(rows.length,SELLER_POLICY_MAX_WRITES+3);assert.equal(rows.filter(row=>!Object.hasOwn(row,'requestBytes')).length,SELLER_POLICY_MAX_WRITES+2);
  // Manual lines with request bytes still count for their job.
  const job=await approval(t);
  await writeFile(job.evidencePath,`${legacyLine()}\n${Array.from({length:SELLER_POLICY_MAX_WRITES},()=>manualLine(request())).join('\n')}\n`);
  out=await decideOnce(job,request());assert.equal(out.decision,false);assert.equal(out.row.policyReason,'job-write-limit');
  for(const bad of[
    JSON.stringify({...JSON.parse(legacyLine()),approvalMode:'policy'}),
    JSON.stringify({...JSON.parse(legacyLine()),format:'dacs-node2-operator-approval-evidence/v0'}),
    JSON.stringify({...JSON.parse(legacyLine()),approvalHash:'not-a-hash'}),
    JSON.stringify({...JSON.parse(legacyLine()),decision:'maybe'}),
    JSON.stringify({...JSON.parse(manualLine(request())),approvalHash:'0'.repeat(64)}),
    JSON.stringify({...JSON.parse(manualLine(request())),approvalMode:'manual'}),
    JSON.stringify({...JSON.parse(manualLine(request())),approvalMode:'policy',totalOs:null}),'[]']){
    const malformed=await approval(t);await writeFile(malformed.evidencePath,`${legacyLine()}\n${bad}\n`);
    out=await decideOnce(malformed,request());assert.equal(out.decision,false,bad);assert.equal(out.row.policyReason,'evidence-unreadable',bad);
  }
});

test('seller policy replays 20000 historical decisions and completions within five seconds',async t=>{
  const h=await approval(t,{clock:{now:SELLER_POLICY_WINDOW_MS+8}}),lines=[];
  const requestBytes=JSON.stringify({content:{jobId:JOBS[0],debit:{totalOs:'4000000000'}}}),approvalHash=sha(requestBytes);
  for(let i=0;i<20000;i++){
    const reservationId=`historical-${i}`;
    lines.push(JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',requestBytes,approvalHash,reservationId,approvalMode:'policy',policyReason:null,decision:'approved',totalOs:'4000000000',recordedAt:7}));
    lines.push(JSON.stringify({format:'dacs-node2-seller-policy-attempt/v1',reservationId,approvalHash,outcome:'spent',recordedAt:7}));
  }
  await writeFile(h.evidencePath,`${lines.join('\n')}\n`);
  const r=request(),started=performance.now();
  assert.equal(await h.approve(r),true,'completed historical attempts no longer consume the hourly budget');
  await h.approve.settle(r,'released');
  const elapsed=performance.now()-started;t.diagnostic(`two ledger replays: ${Math.round(elapsed)} ms`);
  assert.ok(elapsed<5000,`large ledger replay took ${Math.round(elapsed)} ms`);
});

test('seller policy duplicate reservations and invalid completions throw the original malformed evidence error',async t=>{
  for(const [label,mutate] of [
    ['duplicate reservation',(d,c)=>[d,d]],
    ['double completion',(d,c)=>[d,c,c]],
    ['out-of-order completion',(d,c)=>[c,d]],
    ['rejected decision',(d,c)=>[{...d,decision:'rejected'},c]],
    ['non-policy decision',(d,c)=>{const {approvalMode,policyReason,reservationId,...manual}=d;return[manual,c];}],
    ['non-policy reservation',(d,c)=>{const {approvalMode,policyReason,...manual}=d;return[manual,c];}],
    ['earlier completion',(d,c)=>[d,{...c,recordedAt:6}]],
    ['mismatched approval',(d,c)=>[d,{...c,approvalHash:'f'.repeat(64)}]],
    ['malformed completion',(d,c)=>[d,{...c,extra:true}]],
  ]){
    const h=await approval(t),r=request();assert.equal(await h.approve(r),true);
    const [decision]=await evidenceRows(h.evidencePath),completion={format:'dacs-node2-seller-policy-attempt/v1',reservationId:decision.reservationId,approvalHash:decision.approvalHash,outcome:'spent',recordedAt:7};
    await writeFile(h.evidencePath,`${mutate(decision,completion).map(JSON.stringify).join('\n')}\n`);
    await assert.rejects(h.approve.settle(r,'spent'),{message:'seller approval evidence is malformed'},label);
  }
  // Rejected decisions have no held reservation; reusing their recorded ID
  // before an approved decision retains the reader's existing acceptance.
  const h=await approval(t),r=request();assert.equal(await h.approve(r),true);
  const [decision]=await evidenceRows(h.evidencePath),rejected={...decision,decision:'rejected'};
  await writeFile(h.evidencePath,`${[rejected,rejected,decision].map(JSON.stringify).join('\n')}\n`);
  await h.approve.settle(r,'spent');
  assert.equal((await evidenceRows(h.evidencePath)).at(-1).outcome,'spent');
});

test('seller manual approval evidence lines keep their shape: no policy mode or reason, recorded when decided',async t=>{
  const clock={now:7},h=await approval(t,{mode:'manual',clock,authorize:()=>{clock.now=99;return true;}});
  const{decision,row}=await decideOnce(h,request());assert.equal(decision,true);
  assert.deepEqual(Object.keys(row).sort(),['address','approvalHash','decision','format','method','recordedAt','requestBytes','totalOs']);assert.equal(row.recordedAt,99);
});

// Documented in docs/SELLER-POLICY-AND-DELIVERY-EVIDENCE.md. The operator
// passes the delivery-evidence switch and policy completion callback to the
// source transport; the policy callback does not change its binding.
test('the delivery evidence switch changes the source transportBinding: only the declared demo artifact kinds differ and bindingId stays',async t=>{
  const admission=await layoutAdmission(),stub=node2Stub(layoutChain());
  const source=(deliveryEvidenceEnabled)=>{
    const transportOwner=createNode2TransportOwner({admission,fetchImpl:stub.fetchImpl});
    const capability=createAdmittedNode2DemoTransport({admission,transportOwner,journal:memoryJournal(),fetchImpl:transportOwner.fetchImpl,now:()=>1_900_000_000_000,deliveryEvidenceEnabled});
    t.after(()=>capability.close());return capability;
  };
  const off=source(false),on=source(true);
  assert.equal(canonicalize(source(false).transportBinding),canonicalize(off.transportBinding));
  assert.notEqual(canonicalize(on.transportBinding),canonicalize(off.transportBinding));
  assert.equal(on.transportBinding.bindingId,off.transportBinding.bindingId);
  const{demoArtifactPublication:offDemo,...offRest}=off.transportBinding,{demoArtifactPublication:onDemo,...onRest}=on.transportBinding;
  assert.equal(canonicalize(onRest),canonicalize(offRest));
  assert.ok(!offDemo.artifactKinds.includes('SettlementEvidence'));
  assert.deepEqual(onDemo.artifactKinds,[...offDemo.artifactKinds,'SettlementEvidence']);
  assert.equal(canonicalize({...onDemo,artifactKinds:null}),canonicalize({...offDemo,artifactKinds:null}));
  assert.equal(canonicalize(on.profile('http://127.0.0.1:1').transportBinding),canonicalize(on.transportBinding));
  assert.deepEqual(stub.calls,[]);
});

test('Node2 profile opts into seller policy and delivery evidence, reaches delivered with fresh native evidence readback and leaves DACS-5 held',{timeout:540000},async t=>{
  let manual=0;
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy'},sellerDeliveryEvidence:{enabled:true},authorizeSellerApproval:({request})=>{assert.equal(request.content.artifactKind,'Listing');manual++;return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'l4-policy-delivery'});
  assert.equal(result.status,'delivered');assert.equal(manual,1);
  const read=await h.composition.anchor.readRetained({logicalAddress:`dacs4:evidence:${result.jobId}`,artifactKind:'SettlementEvidence'});
  assert.equal(read.status,'present');assert.equal(read.artifact.deliverableContentHash,result.reportHash);
  const lines=(await readFile(join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const rows=lines.filter(row=>row.format==='dacs-node2-operator-approval-evidence/v1'),attempts=lines.filter(row=>row.format==='dacs-node2-seller-policy-attempt/v1');
  assert.equal(rows.length+attempts.length,lines.length);
  assert.equal(rows.length,7);assert.ok(rows.every(row=>row.decision==='approved'&&sha(row.requestBytes)===row.approvalHash));
  const policyRows=rows.filter(row=>row.approvalMode==='policy');
  assert.equal(policyRows.length,6);assert.ok(policyRows.every(row=>row.policyReason===null));
  // Every policy write reached the node and was included, so each reservation settles as spent exactly once.
  assert.equal(attempts.length,6);assert.ok(attempts.every(row=>row.outcome==='spent'));
  assert.deepEqual(attempts.map(row=>row.reservationId).sort(),policyRows.map(row=>row.reservationId).sort());
  assert.deepEqual(rows.filter(row=>row.format==='dacs-node2-operator-approval-evidence/v1'&&!Object.hasOwn(row,'approvalMode')).map(row=>JSON.parse(row.requestBytes).content.artifactKind),['Listing']);
  assert.equal(h.node2.chain.wire.record.accepted.length,8);assert.equal(h.node2.chain.record.accepted.length,1);
  const terminal=JSON.parse(h.application.db.prepare('SELECT state FROM operations WHERE id = ?').get(result.operationId).state).protocol;
  assert.equal(terminal.stage,'delivered');assert.equal(terminal.delivery.evidencePublication,'native-read-back');assert.ok(terminal.delivery.evidenceReceipt);
  assert.equal(terminal.bundle??null,null);
});

test('Node2 delivery evidence lost response is recovered read-only without another CREATE, wallet approval or payment',{timeout:540000},async t=>{
  const approvals=[];
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerDeliveryEvidence:{enabled:true},authorizeSellerApproval:({request})=>{approvals.push(request);return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  let dropped=0;
  Object.defineProperty(h.node2.chain.wire.faults,'dropAfterApply',{configurable:true,get:()=>{const tx=h.node2.chain.wire.record.accepted.at(-1);if(!dropped&&tx?.content?.data?.[1]?.metadata?.logicalAddress?.startsWith('dacs4:evidence:')){dropped++;return true;}return false;}});
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'l4-evidence-response-lost'});
  assert.equal(dropped,1);assert.equal(result.status,'delivered');
  const before={attempts:h.node2.chain.wire.record.broadcastAttempts.length,approvals:approvals.length,payments:h.node2.chain.record.broadcasts.length};
  for(let i=0;i<2;i++){
    const response=await h.composition.sellerAgent.resume({jobId:result.jobId});assert.equal(response.delivery.status,'delivered');
    assert.deepEqual({attempts:h.node2.chain.wire.record.broadcastAttempts.length,approvals:approvals.length,payments:h.node2.chain.record.broadcasts.length},before);
  }
  const evidence=h.node2.chain.wire.record.accepted.filter(tx=>tx.content.data[1].metadata.logicalAddress===`dacs4:evidence:${result.jobId}`);
  assert.equal(evidence.length,1);assert.equal(approvals.filter(r=>r.content.logicalAddress===`dacs4:evidence:${result.jobId}`).length,1);
  h.node2.chain.faults.native=(value)=>value.programName===`dacs4:evidence:${result.jobId}`.replace(/:/g,'%3A')?{...value,data:{}}:value;
  const held=await h.composition.sellerAgent.resume({jobId:result.jobId});assert.equal(held.delivery.evidencePublication,'held-readback-only');
  assert.deepEqual({attempts:h.node2.chain.wire.record.broadcastAttempts.length,approvals:approvals.length,payments:h.node2.chain.record.broadcasts.length},before);
  h.node2.chain.faults.native=null;assert.equal((await h.composition.sellerAgent.resume({jobId:result.jobId})).delivery.status,'delivered');
  const options=h.prepared.composition;
  const restarted=await createSellerAgent({signer:options.sellerSigner,listing:h.composition.listing,anchors:{read:async()=>{throw new Error('fixture fallback forbidden');}},observeDemosTransfer:options.observeDemosTransfer,
    durableDirectory:options.durableDirectory,agreementAnchor:options.agreementAnchor,nativePaymentEvidence:options.nativePaymentEvidence,demDeliveryContext:h.composition.dacsProtocol.demDeliveryContext,
    nativeDemDelivery:h.composition.nativeDemDelivery,nativeArtifactAnchor:h.composition.anchor,deliverableProducer:h.composition.deliverableProducer,deliveryEvidenceEnabled:true,buyerAccess:options.buyerAccess});
  try{assert.equal((await restarted.resume({jobId:result.jobId})).delivery.status,'delivered');assert.deepEqual({attempts:h.node2.chain.wire.record.broadcastAttempts.length,approvals:approvals.length,payments:h.node2.chain.record.broadcasts.length},before);}finally{restarted.close();}
});


test('Node2 policy approves no seller write for a purchase the buyer cancelled during Agreement planning',{timeout:540000},async t=>{
  let h=null,cancelled=null;
  // Cancels the purchase when the seller wallet first asks Node2 for its nonce, which is before its first vet record.
  const rpcFault=async({body})=>{
    const call=body?.params?.[0];
    if(h&&!cancelled&&call?.message==='getAddressNonce'&&call.data?.address===h.prepared.operatorEvidence.seller.replace('did:demos:agent:','0x')){
      const rows=h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind = 'purchase' AND status = 'agreement_pending'").all();
      if(rows.length===1)cancelled=await h.application.services.purchases.cancel({accountId:rows[0].account_id,operationId:rows[0].id});
    }
    return null;
  };
  h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerApproval:{mode:'policy'},rpcFault,authorizeSellerApproval:({request})=>{assert.equal(request.content.artifactKind,'Listing');return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'l4-policy-cancelled'}).catch(()=>null);
  assert.equal(cancelled?.operation?.status,'cancelled');
  const jobId=cancelled.operation.terms.protocol.jobId;
  const rows=(await readFile(join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(row=>row.approvalMode==='policy');
  // The cancel lands during the anchor's nonce read for the buyer CVR. The
  // provider's purchase check, run again under the anchor's lock right before
  // the CREATE intent (PR the source change), refuses it there: the wallet is asked nothing.
  // A request that still reached the policy would be rejected as closed.
  assert.deepEqual(rows,[],'the seller wallet was asked for no write after the cancel');
  assert.deepEqual(rows.map(row=>[row.decision,row.policyReason]),rows.map(()=>['rejected','purchase-closed']));
  assert.deepEqual(h.node2.chain.wire.record.accepted.filter(tx=>tx.content.data[1].data?.jobId===jobId),[],'no seller CREATE for the cancelled job');
});

test('Node2 default seller configuration retains manual approvals and delivery-ready without delivery evidence',{timeout:540000},async t=>{
  const approvals=[];
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),authorizeSellerApproval:({request})=>{approvals.push(request);return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'l4-default-manual'});
  assert.equal(result.status,'delivery-ready');assert.equal(approvals.length,6);
  assert.equal(h.node2.chain.wire.record.accepted.filter(tx=>tx.content.data[1].metadata.logicalAddress===`dacs4:evidence:${result.jobId}`).length,0);
  assert.equal(h.node2.chain.wire.record.accepted.length,7);
});

test('Node2 delivery evidence pre-send failure: the buyer keeps the verified report at delivery-ready with a pending reason, and a later pass publishes the evidence exactly once',{timeout:540000},async t=>{
  const approvals=[],fault=failEvidenceIntentOnce(),timer=manualTimer();
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerDeliveryEvidence:{enabled:true},wrapPublicJournal:fault.wrap,evidenceResumeTimer:timer,authorizeSellerApproval:({request})=>{approvals.push(request);return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'l4-evidence-pending'});
  assert.equal(fault.fired,1);
  assert.equal(result.status,'delivery-ready');assert.equal(result.repeatReadOnlyStatus,'delivery-ready');
  assert.equal(evidenceCreates(h,result.jobId).length,0);assert.equal(approvals.filter(r=>r.content.logicalAddress===evidenceAddress(result.jobId)).length,0);
  const view=statusOf(h,result.operationId);
  assert.equal(view.stage,'delivery-ready');assert.deepEqual(view.delivery.report,result.report);assert.equal(view.delivery.payloadHash,result.reportHash);
  assert.equal(view.layers.service,'test-report-delivered-and-verified');
  assert.equal(view.delivery.evidencePublication,'pending-readback');
  assert.deepEqual(Object.keys(view.delivery.evidenceHold).sort(),['logicalAddress','reason','status']);
  assert.equal(view.delivery.evidenceHold.status,'pending');assert.equal(view.delivery.evidenceHold.logicalAddress,evidenceAddress(result.jobId));
  // The seller journal's own reason off; with DACS_BUYER_CHAIN_READBACK=on the buyer reads the chain only and sees no signed evidence CREATE.
  assert.match(view.delivery.evidenceHold.reason,h.prepared.config.buyerChainReadback==='on'?/original signed SettlementEvidence CREATE is not available yet/:/no seller-owned demo CREATE intent/);
  assert.match(view.next,/delivery evidence has not read back yet/);assert.equal(view.delivery.evidenceReceipt,undefined);
  // The buyer's repeat verify_deal is answered from the seller transport's
  // completed-effect cache, so it adds no seller write.
  const counts=()=>({attempts:h.node2.chain.wire.record.broadcastAttempts.length,approvals:approvals.length,payments:h.node2.chain.record.broadcasts.length});
  const before=counts(),accountId=accountOf(h,result.operationId);
  await h.application.services.purchases.verifyDeal({accountId,operationId:result.operationId});
  assert.deepEqual(counts(),before);assert.equal(statusOf(h,result.operationId).delivery.evidenceHold.status,'pending');
  // The operator's periodic seller resume pass finds no journaled intent
  // ('absent'): nothing was ever sent, so it publishes the evidence: one
  // CREATE, one approval, no payment.
  await timer.tick();
  assert.equal(fault.fired,1);assert.equal(evidenceCreates(h,result.jobId).length,1);
  assert.equal(approvals.filter(r=>r.content.logicalAddress===evidenceAddress(result.jobId)).length,1);
  assert.deepEqual(counts(),{attempts:before.attempts+1,approvals:before.approvals+1,payments:before.payments});
  // The buyer's next pass reads the evidence back on its own and moves to delivered.
  await h.application.services.purchases.verifyDeal({accountId,operationId:result.operationId});
  const delivered=statusOf(h,result.operationId);
  assert.equal(delivered.stage,'delivered');assert.deepEqual(delivered.delivery.report,result.report);
  assert.equal(delivered.delivery.evidencePublication,'native-read-back');assert.equal(delivered.delivery.evidenceHold,undefined);assert.ok(delivered.delivery.evidenceReceipt);
  // Once published, later passes only read back.
  const after=counts();
  await h.application.services.purchases.verifyDeal({accountId,operationId:result.operationId});
  assert.equal((await h.composition.sellerAgent.resume({jobId:result.jobId})).delivery.status,'delivered');
  assert.deepEqual(await h.operator.resumeHeldDeliveryEvidence(),[],'a delivered purchase is not resumed again');
  await timer.tick();
  assert.deepEqual(counts(),after);assert.equal(evidenceCreates(h,result.jobId).length,1);
});
test('Node2 delivery evidence held when the operator stops is published once by the startup pass after a restart',{timeout:540000},async t=>{
  const approvals=[],fault=failEvidenceIntentOnce(),timer=manualTimer();let gate=null,gated=0;
  // While armed, the delivery evidence broadcast waits for the gate.
  const rpcFault=async({body})=>{
    const call=body?.params?.[0],metadata=call?.extra==='broadcastTx'?call.data?.response?.data?.transaction?.content?.data?.[1]?.metadata:null;
    if(gate&&metadata?.artifactKind==='SettlementEvidence'&&String(metadata.logicalAddress).startsWith('dacs4:evidence:')){gated++;await gate.promise;}
    return null;
  };
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerDeliveryEvidence:{enabled:true},wrapPublicJournal:fault.wrap,rpcFault,evidenceResumeTimer:timer,authorizeSellerApproval:({request})=>{approvals.push(request);return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'l4-evidence-restart'});
  assert.equal(fault.fired,1);assert.equal(result.status,'delivery-ready');assert.equal(evidenceCreates(h,result.jobId).length,0);
  const counts=()=>({attempts:h.node2.chain.wire.record.broadcastAttempts.length,approvals:approvals.length,payments:h.node2.chain.record.broadcasts.length}),before=counts();
  let release;gate={promise:new Promise(r=>{release=r;})};
  await h.restart();
  assert.equal(timer.registrations.length,2);assert.equal(timer.registrations[0].cancelled,true,'the stopped operator cancelled its interval');
  // listen() started the pass by itself and did not await it: the evidence
  // broadcast reaches Node2 with no tick and no explicit resume call.
  await until(()=>gated===1,'the startup pass to reach the evidence broadcast');
  gate=null;release();
  // While the pass runs, this returns that same pass. Wait for it before the
  // buyer reads: a buyer read while the seller holds the Node2 connection
  // fence fails closed (a transient downgrade).
  assert.deepEqual(await h.operator.resumeHeldDeliveryEvidence(),[{jobId:result.jobId,status:'delivered'}],'the startup pass published the held evidence');
  assert.equal(evidenceCreates(h,result.jobId).length,1);
  assert.deepEqual(counts(),{attempts:before.attempts+1,approvals:before.approvals+1,payments:before.payments},'one evidence CREATE; nothing else is resent on restart');
  await h.application.services.purchases.verifyDeal({accountId:accountOf(h,result.operationId),operationId:result.operationId});
  const delivered=statusOf(h,result.operationId);
  assert.equal(delivered.stage,'delivered');assert.deepEqual(delivered.delivery.report,result.report);assert.equal(delivered.delivery.evidencePublication,'native-read-back');
  await timer.tick();assert.deepEqual(counts(),{attempts:before.attempts+1,approvals:before.approvals+1,payments:before.payments});
});
test('operator shutdown waits for an evidence pass in flight before anything closes, then refuses new passes',{timeout:540000},async t=>{
  const approvals=[],fault=failEvidenceIntentOnce(),timer=manualTimer();let gate=null,held=0;
  // While armed, every Node2 call waits for the gate.
  const rpcFault=async()=>{if(!gate)return null;held++;await gate.promise;return null;};
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerDeliveryEvidence:{enabled:true},wrapPublicJournal:fault.wrap,rpcFault,evidenceResumeTimer:timer,authorizeSellerApproval:({request})=>{approvals.push(request);return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'l4-evidence-shutdown'});
  assert.equal(fault.fired,1);assert.equal(result.status,'delivery-ready');assert.equal(evidenceCreates(h,result.jobId).length,0);
  let release;gate={promise:new Promise(r=>{release=r;})};
  const pass=timer.tick();
  await until(()=>held>0,'the pass to reach Node2');
  let listenerClosed=false;const closing=h.running.close().then(()=>{listenerClosed=true;});
  await new Promise(r=>setTimeout(r,500));
  assert.equal(listenerClosed,false,'listener close waits for the pass in flight');
  await assert.rejects(h.operator.resumeHeldDeliveryEvidence(),{code:'operator_closing'});
  gate=null;release();
  await closing;await pass;
  assert.equal(evidenceCreates(h,result.jobId).length,1,'the pass in flight finished publishing before shutdown went on');
  await h.close();
});

test('every close waits for the same shutdown: two listener closes and two operator closes all wait for the pass in flight',{timeout:540000},async t=>{
  const fault=failEvidenceIntentOnce(),timer=manualTimer();let gate=null,held=0;
  // While armed, every Node2 call waits for the gate.
  const rpcFault=async()=>{if(!gate)return null;held++;await gate.promise;return null;};
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerDeliveryEvidence:{enabled:true},wrapPublicJournal:fault.wrap,rpcFault,evidenceResumeTimer:timer,authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'l4-evidence-double-close'});
  assert.equal(fault.fired,1);assert.equal(result.status,'delivery-ready');assert.equal(evidenceCreates(h,result.jobId).length,0);
  let release;gate={promise:new Promise(r=>{release=r;})};
  const pass=timer.tick();
  await until(()=>held>0,'the pass to reach Node2');
  // As when SIGINT and SIGTERM both arrive: each API is called twice.
  const listener=[h.running.close(),h.running.close()],operator=[h.operator.close(),h.operator.close()],done=[];
  for(const [name,promise] of [['listener',listener[1]],['operator',operator[1]]])promise.then(()=>done.push(name));
  await new Promise(r=>setTimeout(r,500));
  assert.deepEqual(done,[],'no close returns while the pass is in flight');
  gate=null;release();
  await Promise.all([...listener,...operator,pass]);
  assert.equal(evidenceCreates(h,result.jobId).length,1,'the pass in flight finished publishing before shutdown went on');
});
const accepts=(origin)=>new Promise(resolve=>{const url=new URL(origin),socket=net.connect(Number(url.port),url.hostname);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});
test('a close during listener startup closes what started; that listen fails, and a second listen is refused',{timeout:540000},async t=>{
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),listen:false,authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const origins=[h.config.directoryOrigin,h.config.sellerOrigin],args={application:h.application,composition:h.composition};
  // The seller listener opens at attachment, once its TLS handshake passed;
  // the directory listener opens at listen.
  assert.equal(await accepts(h.config.directoryOrigin),false,`${h.config.directoryOrigin} before listen`);
  assert.equal(await accepts(h.config.sellerOrigin),true,`${h.config.sellerOrigin} after attachment, before listen`);
  // Both listens start before either binds; close starts during that startup.
  const listening=h.operator.listen(args),again=h.operator.listen(args),closing=h.operator.close();
  await assert.rejects(again,{code:'operator_already_listening'});
  await assert.rejects(listening,{code:'operator_closing'});await closing;
  for(const origin of origins)assert.equal(await accepts(origin),false,`${origin} after the operator closed`);
  await assert.rejects(h.operator.listen(args),{code:'operator_closing'});
  for(const origin of origins)assert.equal(await accepts(origin),false,`${origin} after a listen once closed`);
});

test('an operator listens once: a second listen while running is refused, a listen after the owned stop is refused as closing, and neither reopens anything',{timeout:540000},async t=>{
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const origins=[h.running.publicDescription,h.running.directoryOrigin,h.running.sellerOrigin],args={application:h.application,composition:h.composition};
  for(const origin of origins)assert.equal(await accepts(origin),true,origin);
  await assert.rejects(h.operator.listen(args),{code:'operator_already_listening'});
  for(const origin of origins)assert.equal(await accepts(origin),true,`${origin} after a refused listen`);
  await h.running.close();
  for(const origin of origins)assert.equal(await accepts(origin),false,`${origin} after the listeners closed`);
  await assert.rejects(h.operator.listen(args),{code:'operator_closing'});
  for(const origin of origins)assert.equal(await accepts(origin),false,`${origin} after a listen once the listeners closed`);
});

test('Node2 delivery evidence unknown broadcast outcome: the CREATE is never resent, later passes only read back, and the buyer keeps the report at delivery-ready',{timeout:540000},async t=>{
  const approvals=[];let faulted=0;
  // Test-only seam: the delivery evidence broadcast is lost on the wire before
  // the chain sees it. The intent is already journaled, so the outcome is unknown.
  const rpcFault=({body})=>{
    const call=body?.params?.[0],metadata=call?.extra==='broadcastTx'?call.data?.response?.data?.transaction?.content?.data?.[1]?.metadata:null;
    if(metadata?.artifactKind==='SettlementEvidence'&&String(metadata.logicalAddress).startsWith('dacs4:evidence:')){faulted++;throw new TypeError('TEST fetch failed: delivery evidence broadcast lost before the chain saw it');}
    return null;
  };
  const h=await startOperatorPurchaseNode2({tlsFixture:createLoopbackTestTlsMaterial(),sellerDeliveryEvidence:{enabled:true},rpcFault,authorizeSellerApproval:({request})=>{approvals.push(request);return true;},authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'l4-evidence-broadcast-unknown'});
  assert.equal(faulted,1);assert.equal(result.status,'delivery-ready');
  assert.equal(evidenceCreates(h,result.jobId).length,0);assert.equal(approvals.filter(r=>r.content.logicalAddress===evidenceAddress(result.jobId)).length,1);
  const counts=()=>({faulted,attempts:h.node2.chain.wire.record.broadcastAttempts.length,approvals:approvals.length,payments:h.node2.chain.record.broadcasts.length});
  const before=counts(),accountId=accountOf(h,result.operationId);
  for(let i=0;i<2;i++){
    await h.application.services.purchases.verifyDeal({accountId,operationId:result.operationId});
    const response=await h.composition.sellerAgent.resume({jobId:result.jobId});
    assert.equal(response.delivery.status,'delivery-ready');assert.equal(response.delivery.evidencePublication,'held-readback-only');
    assert.deepEqual(counts(),before);
  }
  const retained=await h.composition.anchor.readRetained({logicalAddress:evidenceAddress(result.jobId),artifactKind:'SettlementEvidence'});
  assert.notEqual(retained.status,'present');assert.notEqual(retained.status,'absent');assert.equal(retained.noResend,true);
  const view=statusOf(h,result.operationId);
  assert.equal(view.stage,'delivery-ready');assert.deepEqual(view.delivery.report,result.report);
  assert.equal(view.delivery.evidenceHold.status,'pending');assert.doesNotMatch(view.delivery.evidenceHold.reason,/no seller-owned demo CREATE intent/);
  assert.equal(evidenceCreates(h,result.jobId).length,0);assert.deepEqual(counts(),before);
});
