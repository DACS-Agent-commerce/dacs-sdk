import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, compositeVerificationAddress, contentHash, finalityCommitmentAddress, generateCanonicalJobId, paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { composeSellerApproval, createExactOperatorApproval, heldPolicyBudget, parsePolicyLedger, SELLER_POLICY_MAX_WRITES, SELLER_POLICY_WINDOW_MS, sellerApprovalSettings, sellerPurchaseSource } from '../src/devnet-demo/operator-approval.mjs';
import { appHeldEvidenceJobs, appPurchaseResolver, SELLER_PURCHASE_OPEN_WINDOW_MS, sellerHeldEvidenceJobs, sellerHoldNotice, sellerRecordsPurchaseResolver } from '../src/devnet-demo/seller-purchase-source.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { createDevnetDemoOperator } from '../src/devnet-demo/operator.mjs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';

// Fixture purchases are kept twice: as the buyer application's purchase row and
// as the seller agent's authenticated durable session. The same policy decides
// each request once per purchase source.
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const address=`0x${'a'.repeat(64)}`,seller=`did:demos:agent:${'a'.repeat(64)}`,buyer=`did:demos:agent:${'1'.repeat(64)}`,buyerWallet=`0x${'1'.repeat(64)}`;
const outsider=`did:demos:agent:${'2'.repeat(64)}`;
const pin={listingId:'policy-listing',version:1,contentHash:'b'.repeat(64)},agreementHash='e'.repeat(64);
const sourceBinding={source:'devnet-agreement-transport/v1',bindingVersion:'dacs-demos-network-binding/v1',bindingId:'c'.repeat(64),network:'demos-devnet',chainIdentity:'d'.repeat(64),endpoint:'https://node2.test.invalid/',pinVersion:'TEST-pin',transportAuthority:'TEST-owner'};
const T0=1_800_000_000_000,DAY=86_400_000,OTHER_JOB='01ARZ3NDEKTSV4RRFFQ69G5FB2';
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX','01ARZ3NDEKTSV4RRFFQ69G5FAY','01ARZ3NDEKTSV4RRFFQ69G5FAZ','01ARZ3NDEKTSV4RRFFQ69G5FB0','01ARZ3NDEKTSV4RRFFQ69G5FB1'];
const demString=(os)=>{const whole=os/1_000_000_000n,fraction=(os%1_000_000_000n).toString().padStart(9,'0').replace(/0+$/,'');return fraction?`${whole}.${fraction}`:`${whole}`;};

// One exact seller CREATE request as the embedded wallet shows it (same shape
// as test/seller-policy-delivery-evidence.test.mjs).
function requestFor({artifactKind='Deliverable',job=JOBS[0],party=buyer,phase='deliver-storage-program',artifact:override={},logicalAddress:addressOverride,rpcFeeDem='1'}={}){
  const settlementKind=artifactKind==='SettlementEvidence'&&phase==='pay-dem';
  const artifact={...(artifactKind==='Deliverable'?{reportVersion:'1',kind:'dacs-chatgpt-plugin/devnet-purchased-report',jobId:job,agreementHash,listing:pin,title:'Policy report',settlementId:'demos:TEST',producer:seller,content:{mediaType:'text/plain; charset=utf-8',text:'Purchased bytes'}}
    :artifactKind==='CompositeVerificationRecord'?{recordVersion:'1',jobId:job,evaluatedParty:party,verifier:seller}
    :artifactKind==='FinalityCommitmentRecord'?{finalityCommitmentVersion:'1',jobId:job,pattern:'fixed-price',agreementHash}
    :{evidenceVersion:'1',jobId:job,phase,outcome:'success',...(settlementKind?{paymentAmount:{amount:'1',currency:'DEM'}}:{})}),...override};
  const logicalAddress=addressOverride??(artifactKind==='Deliverable'?`dacs4:deliverable:${job}`:artifactKind==='CompositeVerificationRecord'?compositeVerificationAddress(job,party)
    :artifactKind==='FinalityCommitmentRecord'?finalityCommitmentAddress(job):settlementKind?paymentEvidenceAddress(job,'demos-native:DEM',2):`dacs4:evidence:${job}`);
  const programName=logicalAddress.replace(/:/g,'%3A'),storageAddress=deriveStorageAddress(address,programName,1);
  const tx=buildStorageProgramCreatePayload({from:address,storageAddress,programName,logicalAddress,signedListing:artifact,nonce:1,timestamp:7});
  const deliveryBinding=artifactKind==='Deliverable'?{version:'1',profile:'dacs-native-delivery-publication/v1',jobId:job,phase:'deliver-storage-program',phaseIndex:3,listing:pin,agreementHash,fulfilmentId:'TEST-fulfilment',purchaseAmount:{amount:'1',currency:'DEM'},payloadHash:contentHash(artifact)}:null;
  if(deliveryBinding)tx.content.data[1].metadata.deliveryBinding=deliveryBinding;
  Object.assign(tx.content.data[1].metadata,{contentHash:contentHash(artifact),envelopeHash:sha(canonicalize(artifact)),artifactKind,networkBinding:sourceBinding});
  const fees=['1','1','1',rpcFeeDem],totalOs=fees.reduce((sum,dem)=>sum+BigInt(dem.split('.')[0])*1_000_000_000n+BigInt((dem.split('.')[1]??'').padEnd(9,'0')),0n);
  return{method:'sendTransaction',address,purpose:`Create immutable ${artifactKind} for this exact job`,content:{kind:settlementKind?'devnet-settlement-evidence-storage-create':'devnet-demo-artifact-storage-create',action:'immutable DACS storage anchor CREATE',artifactKind,jobId:job,owner:seller,wallet:address,logicalAddress,storageAddress,programName,contentHash:contentHash(artifact),contentHashProfile:'SDK CF-1 signed scope (top-level signature/signatures omitted)',envelopeHash:sha(canonicalize(artifact)),...(deliveryBinding?{deliveryBinding}:{}),storageBytes:Buffer.byteLength(JSON.stringify(artifact)),exactStorageBytes:JSON.stringify(artifact),exactCreate:JSON.stringify(tx.content.data[1]),nonce:1,timestamp:7,debit:{storageFeeDem:'1',sellerAmountDem:'0',sdkGasDem:'1',networkFeeDem:'1',rpcFeeDem,additionalFeeDem:'0',totalDem:demString(totalOs),totalOs:totalOs.toString(),note:'Complete debit'},network:sourceBinding.network,chainIdentity:sourceBinding.chainIdentity,networkBinding:sourceBinding,evidence:'TEST source',sending:'Send once'}};
}
function confirmationFor(r){
  return{result:200,response:{data:{valid:true,gas_operation:null,transaction:{content:{type:'storageProgram',amount:'0',from:r.address,nonce:r.content.nonce,timestamp:r.content.timestamp,data:['storageProgram',JSON.parse(r.content.exactCreate)],
    transaction_fee:{network_fee:'1000000000',rpc_fee:'1000000000',additional_fee:'0'},
    gcr_edits:[{type:'balance',operation:'remove',account:r.address,amount:'1000000000'},{type:'balance',operation:'remove',account:r.address,amount:'1000000000'}]}}}}};
}

// A purchase story, told to both sources. The seller never hears of a
// buyer-side cancel, so 'cancelled' leaves its record as it was while open.
// 'before-proposal' is a job the app holds but the seller has no session for
// yet (the vet records come first). Bindings may differ per source.
const STORIES={
  open:{status:'agreement_pending'},
  paid:{status:'settled_verified',paid:true},
  'delivery-ready':{status:'settled_verified',paid:true,deliveryReady:true},
  delivered:{status:'settled_verified',paid:true,deliveryReady:true,stage:'delivered',appStage:'delivered'},
  expired:{status:'agreement_pending',expiresAt:T0-1,admittedAt:T0-SELLER_PURCHASE_OPEN_WINDOW_MS},
  'past-deadline':{status:'expired',deadline:T0},
  committed:{status:'approved',committed:true},
  cancelled:{status:'cancelled'},
  'before-proposal':{status:'agreement_pending',noSession:true},
  missing:{noRow:true,noSession:true},
  outside:{status:'settled_verified',paid:true,buyerClaim:outsider},
  'outside-open':{status:'agreement_pending',buyerClaim:outsider},
  'other-chain':{status:'settled_verified',paid:true,binding:{...sourceBinding,chainIdentity:'f'.repeat(64)}},
  'other-network':{status:'settled_verified',paid:true,binding:{...sourceBinding,network:'demos-testnet'}},
  'other-endpoint':{status:'settled_verified',paid:true,binding:{...sourceBinding,endpoint:'https://seller-own-rpc.test.invalid/'}},
  'other-listing':{status:'settled_verified',paid:true,listing:{...pin,version:2}},
};
function appRow(job,story){
  const wallet=story.buyerClaim?`0x${story.buyerClaim.slice(16)}`:buyerWallet;
  const terms={protocol:{jobId:job,transportBinding:story.binding??sourceBinding},seller:{claim:seller},buyer:{wallet},listing:{...(story.listing??pin)},price:{amount:'1',amountOs:'1000000000'}};
  const state={protocol:{agreement:{hash:agreementHash},...(story.deliveryReady?{stage:story.appStage??'delivery-ready',delivery:story.appStage==='delivered'?{}:{evidenceHold:{status:'pending'}}}:{})}};
  return{kind:'purchase',terms:JSON.stringify(terms),state:JSON.stringify(state),status:story.status,expires_at:new Date(story.expiresAt??T0+60_000).toISOString()};
}
function sellerSession(job,story){
  const buyerClaim=story.buyerClaim??buyer,binding=story.binding??sourceBinding,admittedAt=story.admittedAt??T0-60_000,committed=story.committed||story.paid;
  const draft={payeeBoundAgreementVersion:'1',jobId:job,listingRef:{...(story.listing??pin)},parties:[{role:'buyer',primaryClaim:buyerClaim},{role:'seller',primaryClaim:seller}],derivedFromPattern:'fixed-price',generatedAt:admittedAt,
    terms:{price:{amount:'1',currency:'DEM'},deadline:story.deadline??T0+DAY}};
  return{jobId:job,buyerBundle:{presentedBy:buyerClaim},proposal:{plan:{draft,agreementHash}},stage:story.stage??(story.deliveryReady?'delivery-ready':story.paid?'native-payment-evidence-held':committed?'committed':'proposed'),
    proposalAdmission:{proposalHash:'f'.repeat(64),observedAt:admittedAt},agreementHash,
    agreementSignedProjection:{content:{type:'storageProgram',network:binding.network,chainIdentity:binding.chainIdentity,data:['storageProgram',{metadata:{artifactKind:'Agreement',networkBinding:binding}}]}},
    ...(committed?{agreement:draft,commitment:{logicalAddress:finalityCommitmentAddress(job),agreementHash}}:{}),
    ...(story.paid?{nativeEvidenceWork:{txHash:'9'.repeat(64),intake:{disposition:'verified',fulfilment:'claim',jobId:job}}}:{}),
    ...(story.deliveryReady?{deliveryReady:{fulfilmentId:'TEST-fulfilment'}}:{})};
}

// Builds both stores for the stories (one per job), plus one policy approval
// per source. reopen() closes and reopens the seller's durable state, as a
// restart does, and builds fresh approvals on the same evidence ledgers.
async function world(t,stories,{clock={now:T0},limits={},openBuyerAccess=false,sellerSessions=null}={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'seller-purchase-source-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE operations (kind TEXT, terms TEXT, state TEXT, status TEXT, expires_at TEXT)');
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),raw=publicKey.export({format:'der',type:'spki'}).subarray(12).toString('hex');
  const signer={claim:`did:demos:agent:${raw}`,sign:(bytes)=>signBytes(null,Buffer.from(bytes),privateKey)};
  const dir=join(root,'seller-state');
  let durable=await createSellerDurableState({dir,signer,listingPin:pin});durable.retainContext({admittedAt:T0,validation:{disposition:'verified'}});
  for(const[job,name]of Object.entries(stories)){
    const story=STORIES[name];
    if(!story.noRow){const row=appRow(job,story);db.prepare('INSERT INTO operations VALUES (?,?,?,?,?)').run(row.kind,row.terms,row.state,row.status,row.expires_at);}
    if(!story.noSession)await durable.withJob(job,async()=>durable.saveSession(sellerSession(job,story)));
  }
  if(sellerSessions)for(const session of sellerSessions)await durable.withJob(session.jobId,async()=>durable.saveSession(session));
  t.after(()=>durable.close());
  const buyerAccess=createOperatorBuyerAccess({openBuyerAccess,custodyBuyer:openBuyerAccess?undefined:buyer});
  const resolvers={app:appPurchaseResolver({application:()=>({db}),buyerAccess:()=>buyerAccess,now:()=>clock.now}),
    seller:sellerRecordsPurchaseResolver({sessionOf:(job)=>durable.loadSession(job),buyerAccess:()=>buyerAccess,now:()=>clock.now})};
  const optionsFor=(source)=>({maxTotalOs:'10000000000',evidencePath:join(root,`${source}-approvals.jsonl`),now:()=>clock.now,authorize:()=>{throw new Error('policy invoked human authority');},sellerApproval:{mode:'policy',...limits},
    policy:{address,seller,sourceBinding,listingPin:()=>pin,...(source==='default'?{}:{purchaseSource:source==='seller'?'seller':'app'}),resolvePurchase:source==='seller'?(job)=>resolvers.seller(job):(job)=>resolvers.app(job)}});
  const w={root,db,clock,resolvers,optionsFor,durable:()=>durable,approvals:{app:createExactOperatorApproval(optionsFor('app')),seller:createExactOperatorApproval(optionsFor('seller'))},
    async reopen(){durable.close();durable=await createSellerDurableState({dir,signer,listingPin:pin});w.approvals={app:createExactOperatorApproval(optionsFor('app')),seller:createExactOperatorApproval(optionsFor('seller'))};}};
  return w;
}
const lines=async(path)=>{try{return(await readFile(path,'utf8')).split('\n').filter(Boolean);}catch(error){if(error.code==='ENOENT')return[];throw error;}};
async function decide(w,source,r){
  const path=w.optionsFor(source).evidencePath,before=(await lines(path)).length,decision=await w.approvals[source](r),after=await lines(path);
  assert.equal(after.length,before+1);const row=JSON.parse(after.at(-1));
  assert.equal(row.requestBytes,JSON.stringify(r));assert.equal(row.approvalHash,sha(row.requestBytes));
  return{decision,reason:row.policyReason,held:w.approvals[source].heldForManual(r)};
}
const manualLine=(r)=>{const requestBytes=JSON.stringify(r);return JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',approvalHash:sha(requestBytes),requestBytes,method:'sendTransaction',address,totalOs:r.content.debit.totalOs,decision:'approved',recordedAt:7});};

// [policyReason, story, request, app verdict, seller verdict]. A verdict is the
// recorded reason (null: approved). Only the rows marked SAFER differ, each to
// a hold for exact manual approval; 'other-endpoint' is the deliberate binding
// change (K5): same network and chain identity, another RPC endpoint.
const MATRIX=[
  ['approved','paid',(job)=>requestFor({job}),null,null],
  ['approved','paid',(job)=>requestFor({job,artifactKind:'SettlementEvidence',phase:'pay-dem'}),null,null],
  ['approved','paid',(job)=>requestFor({job,artifactKind:'SettlementEvidence'}),null,null],
  ['approved SAFER: no cancellation channel','open',(job)=>requestFor({job,artifactKind:'FinalityCommitmentRecord'}),null,'cancellation-unknown'],
  ['approved SAFER: no seller record before the proposal','before-proposal',(job)=>requestFor({job,artifactKind:'CompositeVerificationRecord'}),null,'seller-record-missing'],
  ['approved SAFER: no seller record before the proposal (seller vet)','before-proposal',(job)=>requestFor({job,artifactKind:'CompositeVerificationRecord',party:seller}),null,'seller-record-missing'],
  ['operator-fee-budget','paid',(job)=>requestFor({job,rpcFeeDem:'8'}),'operator-fee-budget','operator-fee-budget'],
  ['request-shape','paid',(job)=>{const r=requestFor({job});r.content.extra=true;return r;},'request-shape','request-shape'],
  ['request-shape: another chain in the request','paid',(job)=>{const r=requestFor({job});r.content.chainIdentity='f'.repeat(64);return r;},'request-shape','request-shape'],
  ['debit','paid',(job)=>{const r=requestFor({job});r.content.debit.sdkGasDem='0';return r;},'debit','debit'],
  ['write-fee-cap','paid',(job)=>requestFor({job,rpcFeeDem:'1.000000001'}),'write-fee-cap','write-fee-cap'],
  ['create-bytes','paid',(job)=>{const r=requestFor({job});r.content.exactStorageBytes='{}';return r;},'create-bytes','create-bytes'],
  ['purchase: no record','missing',(job)=>requestFor({job}),'purchase','purchase'],
  ['purchase: buyer outside closed access','outside',(job)=>requestFor({job}),'purchase','purchase'],
  ['purchase: buyer outside closed access before payment','outside-open',(job)=>requestFor({job,artifactKind:'FinalityCommitmentRecord'}),'purchase','purchase'],
  ['purchase: another chain identity','other-chain',(job)=>requestFor({job}),'purchase','purchase'],
  ['purchase: another network','other-network',(job)=>requestFor({job}),'purchase','purchase'],
  ['purchase: another chain identity before payment','other-chain',(job)=>requestFor({job,artifactKind:'FinalityCommitmentRecord'}),'purchase','purchase'],
  ['purchase: another Listing pin','other-listing',(job)=>requestFor({job}),'purchase','purchase'],
  ['K5: another RPC endpoint on the same chain','other-endpoint',(job)=>requestFor({job}),'purchase',null],
  ['payment-not-observed','open',(job)=>requestFor({job}),'payment-not-observed','payment-not-observed'],
  ['payment-not-observed (pay-dem)','open',(job)=>requestFor({job,artifactKind:'SettlementEvidence',phase:'pay-dem'}),'payment-not-observed','payment-not-observed'],
  ['payment-already-observed','paid',(job)=>requestFor({job,artifactKind:'FinalityCommitmentRecord'}),'payment-already-observed','payment-already-observed'],
  ['payment-already-observed (vet)','paid',(job)=>requestFor({job,artifactKind:'CompositeVerificationRecord'}),'payment-already-observed','payment-already-observed'],
  ['purchase-closed: expired','expired',(job)=>requestFor({job,artifactKind:'FinalityCommitmentRecord'}),'purchase-closed','purchase-closed'],
  ['purchase-closed: past the Agreement deadline','past-deadline',(job)=>requestFor({job,artifactKind:'FinalityCommitmentRecord'}),'purchase-closed','purchase-closed'],
  ['purchase-closed: already committed, before payment','committed',(job)=>requestFor({job,artifactKind:'CompositeVerificationRecord'}),'purchase-closed','purchase-closed'],
  ['purchase-closed SAFER: cancelled by the buyer','cancelled',(job)=>requestFor({job,artifactKind:'FinalityCommitmentRecord'}),'purchase-closed','cancellation-unknown'],
  ['payment-amount','paid',(job)=>requestFor({job,artifactKind:'SettlementEvidence',phase:'pay-dem',artifact:{paymentAmount:{amount:'2',currency:'DEM'}}}),'payment-amount','payment-amount'],
  ['evaluated-party','open',(job)=>requestFor({job,artifactKind:'CompositeVerificationRecord',party:outsider}),'evaluated-party','evaluated-party'],
  ['logical-address','paid',(job)=>requestFor({job,logicalAddress:`dacs4:deliverable:${OTHER_JOB}`}),'logical-address','logical-address'],
  ['listing','paid',(job)=>requestFor({job,artifact:{listing:{...pin,version:2}}}),'listing','listing'],
  ['agreement','paid',(job)=>requestFor({job,artifact:{agreementHash:'f'.repeat(64)}}),'agreement','agreement'],
  ['delivery-binding','paid',(job)=>{const r=requestFor({job});r.content.deliveryBinding={...r.content.deliveryBinding,fulfilmentId:'TEST-other'};return r;},'delivery-binding','delivery-binding'],
];
// One job per row, all in one world: the seller's durable state syncs every write.
const MATRIX_JOBS=MATRIX.map((_,index)=>generateCanonicalJobId({timestamp:T0,entropy:Buffer.alloc(10,index+1)}));
const matrixWorld=(t)=>world(t,Object.fromEntries(MATRIX.map(([,story],index)=>[MATRIX_JOBS[index],story])));

test('every policyReason gives the same verdict from app and seller records, except the documented holds',async t=>{
  const w=await matrixWorld(t);
  for(const[index,[name,,make,app,sellerVerdict]]of MATRIX.entries()){
    const r=make(MATRIX_JOBS[index]);
    const fromApp=await decide(w,'app',r),fromSeller=await decide(w,'seller',r);
    assert.equal(fromApp.reason,app,`${name}: app`);assert.equal(fromApp.decision,app===null,`${name}: app`);assert.equal(fromApp.held,false,`${name}: app never holds`);
    assert.equal(fromSeller.reason,sellerVerdict,`${name}: seller`);assert.equal(fromSeller.decision,sellerVerdict===null,`${name}: seller`);
    assert.equal(fromSeller.held,['cancellation-unknown','seller-record-missing'].includes(sellerVerdict),`${name}: seller hold`);
    if(app!==sellerVerdict)assert.ok(/SAFER|K5/.test(name),`${name}: only documented cases differ`);
  }
});

test('budget and ledger reasons are the same from both sources, and a held write still meets them',async t=>{
  const seeded=async(w,path)=>writeFile(path,`${Array.from({length:SELLER_POLICY_MAX_WRITES},()=>manualLine(requestFor({artifactKind:'FinalityCommitmentRecord'}))).join('\n')}\n`);
  let w=await world(t,{[JOBS[0]]:'open'});
  for(const source of ['app','seller'])await seeded(w,w.optionsFor(source).evidencePath);
  for(const source of ['app','seller']){const out=await decide(w,source,requestFor({artifactKind:'FinalityCommitmentRecord'}));assert.equal(out.reason,'job-write-limit',source);assert.equal(out.held,false);}
  for(const[limits,reason]of[[{maxWritesPerHour:1},'hourly-write-limit'],[{maxTotalOsPerHour:'4000000000'},'hourly-dem-limit']]){
    w=await world(t,{[JOBS[0]]:'paid',[JOBS[1]]:'open',[JOBS[2]]:'before-proposal'},{limits});
    for(const source of ['app','seller']){
      assert.equal((await decide(w,source,requestFor({job:JOBS[0]}))).reason,null,source);
      for(const r of [requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]}),requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[2]})]){
        const out=await decide(w,source,r);assert.equal(out.reason,reason,`${source} ${r.content.artifactKind}`);assert.equal(out.held,false,'a budget refusal is not held');
      }
    }
  }
  w=await world(t,{[JOBS[0]]:'paid'});
  for(const source of ['app','seller']){await writeFile(w.optionsFor(source).evidencePath,'not-json\n');assert.equal((await decide(w,source,requestFor())).reason,'evidence-unreadable',source);}
});

test('a resolver failure fails closed from both sources',async t=>{
  const w=await world(t,{[JOBS[0]]:'paid'});
  w.resolvers.app=()=>{throw new Error('TEST app store unavailable');};
  w.durable().loadSession=()=>{throw Object.assign(new Error('seller_state_corrupt'),{code:'seller_state_corrupt'});};
  for(const source of ['app','seller'])assert.equal((await decide(w,source,requestFor())).reason,'policy-check-failed',source);
});

test('a cancelled or expired job gets no pre-payment write from policy; seller records hold an unknown cancellation for exact manual approval',async t=>{
  for(const kind of ['CompositeVerificationRecord','FinalityCommitmentRecord']){
    const w=await world(t,{[JOBS[0]]:'cancelled',[JOBS[1]]:'expired',[JOBS[2]]:'past-deadline'});
    for(const source of ['app','seller']){
      for(const job of JOBS.slice(0,3)){
        const asked=[],composed=composeSellerApproval({mode:'policy',policy:w.approvals[source],manual:async(request)=>{asked.push(request);return false;}});
        assert.equal(await composed(requestFor({artifactKind:kind,job})),false,`${source} ${kind} ${job}`);
        // Only the seller's unknown cancellation reaches a human; the human declined, so nothing is signed.
        assert.equal(asked.length,source==='seller'&&job===JOBS[0]?1:0,`${source} ${kind} ${job}`);
      }
    }
  }
});

test('seller-record holds go to exact manual approval; confirmation still refuses a job its records show closed',async t=>{
  const w=await world(t,{[JOBS[0]]:'before-proposal',[JOBS[1]]:'open'});
  const asked=[],composed=composeSellerApproval({mode:'policy',policy:w.approvals.seller,manual:async(request)=>{asked.push(request.content.artifactKind);return true;}});
  // A vet record with no seller session yet: held, approved by hand, confirmed.
  const vet=requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[0]});
  assert.equal(await composed(vet),true);assert.deepEqual(asked,['CompositeVerificationRecord']);
  assert.equal(await composed.confirm(confirmationFor(vet)),true,'a manually approved hold with no seller record yet confirms');
  // A commitment held for the unknown cancellation, approved by hand; the job then expires before confirmation.
  const commitment=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]});
  assert.equal(await composed(commitment),true);assert.deepEqual(asked,['CompositeVerificationRecord','FinalityCommitmentRecord']);
  w.clock.now+=SELLER_PURCHASE_OPEN_WINDOW_MS;
  assert.equal(await composed.confirm(confirmationFor(commitment)),false,'records that show the job expired refuse the confirmation');
  const[last,end]=(await lines(w.optionsFor('seller').evidencePath)).slice(-2).map(JSON.parse);assert.equal(last.decision,'rejected');assert.equal(last.policyReason,'purchase-closed');assert.equal(last.policyHold,'cancellation-unknown');
  // The refused confirmation ends its attempt: released before issuance.
  assert.deepEqual([end.format,end.attemptId,end.outcome,end.reason],['dacs-node2-seller-policy-attempt/v1',last.attemptId,'released','confirmation-refused']);
  // The app source never holds a pre-payment write, so nothing reaches a human.
  const app=await world(t,{[JOBS[0]]:'open'}),appAsked=[];
  const appComposed=composeSellerApproval({mode:'policy',policy:app.approvals.app,manual:async(request)=>{appAsked.push(request);return true;}});
  assert.equal(await appComposed(requestFor({artifactKind:'FinalityCommitmentRecord'})),true);assert.deepEqual(appAsked,[]);
});

test('a later decision on the same request replaces its hold',async t=>{
  const w=await world(t,{[JOBS[0]]:'open'}),r=requestFor({artifactKind:'FinalityCommitmentRecord'});
  assert.deepEqual(await decide(w,'seller',r),{decision:false,reason:'cancellation-unknown',held:true});
  w.clock.now+=SELLER_PURCHASE_OPEN_WINDOW_MS;
  assert.deepEqual(await decide(w,'seller',r),{decision:false,reason:'purchase-closed',held:false});
});

test('a post-payment refusal goes to exact manual approval from both sources',async t=>{
  for(const source of ['app','seller']){
    const w=await world(t,{[JOBS[0]]:'paid',[JOBS[1]]:'open'});
    for(const r of [requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem',artifact:{paymentAmount:{amount:'2',currency:'DEM'}}}),requestFor({job:JOBS[1]})]){
      const asked=[],composed=composeSellerApproval({mode:'policy',policy:w.approvals[source],manual:async(request)=>{asked.push(request);return true;}});
      assert.equal(await composed(r),true,source);assert.equal(asked.length,1,`${source}: ${r.content.artifactKind} reached manual approval`);
      assert.equal(await composed.confirm(confirmationFor(r)),true,source);
    }
  }
});

test('a restart keeps the verdicts: reopened seller records and a new approval decide the same',async t=>{
  const stories={[JOBS[0]]:'paid',[JOBS[1]]:'open',[JOBS[2]]:'expired',[JOBS[3]]:'other-chain',[JOBS[4]]:'before-proposal'};
  const requests=()=>[requestFor({job:JOBS[0]}),requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]}),requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]}),
    requestFor({job:JOBS[1]}),requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[2]}),requestFor({job:JOBS[3]}),requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[4]})];
  const w=await world(t,stories),before=[],after=[];
  for(const r of requests())before.push(await decide(w,'seller',r));
  await w.reopen();
  for(const r of requests())after.push(await decide(w,'seller',r));
  assert.deepEqual(after,before);
  assert.deepEqual(before.map(v=>v.reason),[null,'payment-already-observed','cancellation-unknown','payment-not-observed','purchase-closed','purchase','seller-record-missing']);
});

test('a purchase on another network or chain identity is refused in both modes; only seller records accept another endpoint',async t=>{
  for(const kind of ['Deliverable','FinalityCommitmentRecord']){
    const w=await world(t,{[JOBS[0]]:'other-chain',[JOBS[1]]:'other-network',[JOBS[2]]:'other-endpoint'});
    for(const source of ['app','seller'])for(const job of JOBS.slice(0,2))assert.equal((await decide(w,source,requestFor({artifactKind:kind,job}))).reason,'purchase',`${source} ${kind} ${job}`);
    assert.equal((await decide(w,'app',requestFor({artifactKind:kind,job:JOBS[2]}))).reason,'purchase');
  }
  // The seller's record of the binding must agree with the signed Agreement's network fields.
  const session=sellerSession(JOBS[0],STORIES.paid);session.agreementSignedProjection.content.chainIdentity='f'.repeat(64);
  const w=await world(t,{},{sellerSessions:[session]});assert.equal((await decide(w,'seller',requestFor())).reason,'purchase');
  const none=sellerSession(JOBS[1],STORIES.paid);delete none.agreementSignedProjection;
  const missing=await world(t,{},{sellerSessions:[none]});assert.equal((await decide(missing,'seller',requestFor({job:JOBS[1]}))).reason,'purchase','no retained Agreement readback: network unknown');
});

test('seller records: payment is observed only from the seller\'s own verified intake',async t=>{
  const variants=[
    ['native evidence checkpoint',(s)=>s,null],
    ['fixture payment checkpoint',(s)=>{s.paymentWork=s.nativeEvidenceWork;delete s.nativeEvidenceWork;return s;},null],
    ['recorded payment',(s)=>{delete s.nativeEvidenceWork;s.payment={settlementId:'demos:TEST'};return s;},null],
    ['unverified intake',(s)=>{s.nativeEvidenceWork.intake.disposition='indeterminate';return s;},'payment-not-observed'],
    ['intake for another job',(s)=>{s.nativeEvidenceWork.intake.jobId=JOBS[1];return s;},'payment-not-observed'],
    ['unclaimed intake',(s)=>{s.nativeEvidenceWork.intake.fulfilment='rejected';return s;},'payment-not-observed'],
  ];
  for(const[name,mutate,reason]of variants){
    const w=await world(t,{},{sellerSessions:[mutate(sellerSession(JOBS[0],STORIES.paid))]});
    assert.equal((await decide(w,'seller',requestFor())).reason,reason,name);
  }
});

test('seller records: the open window, the Agreement deadline and parties come from the seller\'s own session',async t=>{
  const at=(story,overrides)=>Object.assign(sellerSession(JOBS[0],story),overrides);
  const cases=[
    ['admitted just inside the window',at({...STORIES.open,admittedAt:T0-SELLER_PURCHASE_OPEN_WINDOW_MS+1}),'cancellation-unknown'],
    ['admitted a full window ago',at({...STORIES.open,admittedAt:T0-SELLER_PURCHASE_OPEN_WINDOW_MS}),'purchase-closed'],
    ['generated earlier than admitted counts from generation',(()=>{const s=sellerSession(JOBS[0],STORIES.open);s.proposal.plan.draft.generatedAt=T0-SELLER_PURCHASE_OPEN_WINDOW_MS;return s;})(),'purchase-closed'],
    ['no admission time',(()=>{const s=sellerSession(JOBS[0],STORIES.open);delete s.proposalAdmission;return s;})(),'purchase-closed'],
    ['deadline one millisecond ahead',at({...STORIES.open,deadline:T0+1}),'cancellation-unknown'],
    ['session buyer differs from the Agreement buyer',(()=>{const s=sellerSession(JOBS[0],STORIES.open);s.buyerBundle.presentedBy=outsider;return s;})(),'purchase'],
    ['Agreement buyer differs from the session buyer',(()=>{const s=sellerSession(JOBS[0],STORIES.open);s.proposal.plan.draft.parties[0].primaryClaim=outsider;return s;})(),'purchase'],
    ['Agreement names another seller',(()=>{const s=sellerSession(JOBS[0],STORIES.open);s.proposal.plan.draft.parties[1].primaryClaim=outsider;return s;})(),'purchase'],
    ['price in another currency',(()=>{const s=sellerSession(JOBS[0],STORIES.open);s.proposal.plan.draft.terms.price.currency='USD';return s;})(),'purchase'],
  ];
  for(const[name,session,reason]of cases){
    const w=await world(t,{},{sellerSessions:[session]});
    assert.equal((await decide(w,'seller',requestFor({artifactKind:'FinalityCommitmentRecord'}))).reason,reason,name);
  }
  // Open buyer access accepts the session's buyer whoever it is.
  const open=await world(t,{[JOBS[0]]:'outside'},{openBuyerAccess:true});
  for(const source of ['app','seller'])assert.equal((await decide(open,source,requestFor())).reason,null,source);
});

test('the resume pass finds the same held delivery evidence jobs from seller records as from the app',async t=>{
  const stories={[JOBS[0]]:'delivery-ready',[JOBS[1]]:'delivered',[JOBS[2]]:'paid',[JOBS[3]]:'open',[JOBS[4]]:'delivery-ready'};
  const w=await world(t,stories);
  const fromApp=appHeldEvidenceJobs(w.db).all(seller).map(row=>({...row})),fromSeller=sellerHeldEvidenceJobs(w.durable().sessions());
  assert.deepEqual(fromSeller,[{jobId:JOBS[0]},{jobId:JOBS[4]}]);assert.deepEqual(fromApp,fromSeller);
  assert.deepEqual(appHeldEvidenceJobs(w.db).all(outsider),[],'the app query is bound to this seller');
  await w.reopen();assert.deepEqual(sellerHeldEvidenceJobs(w.durable().sessions()),fromSeller,'and after a restart');
  const noWork=sellerSession(JOBS[5],STORIES['delivery-ready']);delete noWork.nativeEvidenceWork;
  assert.deepEqual(sellerHeldEvidenceJobs([noWork,{...sellerSession(JOBS[5],STORIES['delivery-ready']),deliveryReady:undefined}]),[]);
});

test('the purchase source switch: "app" by default, "seller" by name, nothing else',()=>{
  assert.equal(sellerPurchaseSource(undefined),'app');assert.equal(sellerPurchaseSource('app'),'app');assert.equal(sellerPurchaseSource('seller'),'seller');
  for(const bad of [null,'',  'App','buyer',true,1,{}])assert.throws(()=>sellerPurchaseSource(bad),{name:'TypeError',message:'sellerApproval.purchaseSource must be "app" or "seller"'},String(bad));
  // The source is not a limit: settings stay exactly as before for every mode.
  assert.deepEqual(sellerApprovalSettings({mode:'manual',purchaseSource:'seller'}),{mode:'manual'});
  assert.deepEqual(sellerApprovalSettings({mode:'policy',purchaseSource:'app'}),sellerApprovalSettings({mode:'policy'}));
  assert.deepEqual(sellerApprovalSettings({mode:'policy',maxWritesPerHour:2,purchaseSource:'seller'}),sellerApprovalSettings({mode:'policy',maxWritesPerHour:2}));
  for(const bad of [{mode:'policy',purchaseSource:'buyer'},{mode:'manual',purchaseSource:null},{purchaseSource:'seller'}])assert.throws(()=>sellerApprovalSettings(bad),TypeError,JSON.stringify(bad));
  assert.throws(()=>createExactOperatorApproval({maxTotalOs:'1',evidencePath:'/nonexistent/x',sellerApproval:{mode:'policy'},policy:{address,seller,sourceBinding,listingPin:()=>pin,resolvePurchase:()=>null,purchaseSource:'buyer'}}),TypeError);
  assert.match(sellerHoldNotice(requestFor({artifactKind:'FinalityCommitmentRecord'})),/cannot show a buyer-side cancellation/);
  assert.equal(sellerHoldNotice(requestFor()),null,'post-payment writes carry no hold notice');
});

// Switch off: the default (no purchaseSource) and an explicit "app" write the
// same evidence bytes as each other for every reason in the matrix; the
// reasons are the ones main's own test pins (test/seller-policy-delivery-evidence).
test('switch off: default and explicit "app" decide and record byte-identically, and never hold',async t=>{
  const w=await matrixWorld(t);w.approvals.default=createExactOperatorApproval(w.optionsFor('default'));
  for(const[index,[name,,make,app]]of MATRIX.entries()){
    const r=make(MATRIX_JOBS[index]),outs=[];
    for(const source of ['default','app']){
      const path=w.optionsFor(source).evidencePath,decision=await w.approvals[source](r),line=(await lines(path)).at(-1);
      outs.push({decision,line:line.replace(/"reservationId":"[0-9a-f-]{36}"/,'"reservationId":"<uuid>"'),held:w.approvals[source].heldForManual(r)});
    }
    assert.deepEqual(outs[0],outs[1],name);assert.equal(JSON.parse(outs[0].line).policyReason,app,name);assert.equal(outs[0].held,false,name);
  }
});

// A policy-mode composer as the operator builds it; the human's answer may be a
// function of the request. asked lists every request that reached the human.
function composedFor(w,answer=true,{source='seller',approval=w.approvals[source]}={}){
  const asked=[];
  const composed=composeSellerApproval({mode:'policy',policy:approval,manual:async(request)=>{asked.push(request);return typeof answer==='function'?answer(request,composed):answer;}});
  return{composed,asked};
}
const policyLines=async(w,source='seller')=>(await lines(w.optionsFor(source).evidencePath)).map(JSON.parse).filter(row=>row.approvalMode==='policy');

test('with no seller record yet, a pre-payment write at another job\'s address, for another Listing or for no valid party is refused as with the app, with no prompt',async t=>{
  const w=await world(t,{[JOBS[0]]:'before-proposal'});
  const vet=(options)=>requestFor({artifactKind:'CompositeVerificationRecord',...options});
  const cases=[
    ['a vet record at another job\'s address',vet({logicalAddress:compositeVerificationAddress(OTHER_JOB,buyer)}),'logical-address'],
    ['a commitment at another job\'s address',requestFor({artifactKind:'FinalityCommitmentRecord',logicalAddress:finalityCommitmentAddress(OTHER_JOB)}),'logical-address'],
    ['a vet record pinning another Listing',vet({artifact:{listingPin:{...pin,version:2}}}),'listing'],
    ['a vet record naming another Listing',vet({artifact:{listing:{...pin,version:2}}}),'listing'],
    ['a vet record referencing another Listing',vet({artifact:{listingRef:{...pin,contentHash:'f'.repeat(64)}}}),'listing'],
    ['a vet record for no valid party',vet({artifact:{evaluatedParty:'did:demos:agent:TEST'},logicalAddress:compositeVerificationAddress(JOBS[0],buyer)}),'evaluated-party'],
  ];
  for(const[name,r,reason]of cases){
    assert.equal((await decide(w,'app',r)).reason,reason,`${name}: app`);
    assert.deepEqual(await decide(w,'seller',r),{decision:false,reason,held:false},`${name}: seller`);
    const{composed,asked}=composedFor(w);
    assert.equal(await composed(r),false,name);assert.equal(asked.length,0,`${name}: no prompt`);
  }
  // The same vet record at its own address, for this Listing and party, is held.
  assert.deepEqual(await decide(w,'seller',vet({artifact:{listingPin:pin}})),{decision:false,reason:'seller-record-missing',held:true});
});

test('a held write the operator approved is checked again at confirmation: another Listing pin by then refuses it and releases its reservation',async t=>{
  const w=await world(t,{[JOBS[0]]:'before-proposal',[JOBS[1]]:'paid'},{limits:{maxWritesPerHour:1}});
  let current=pin;
  const options=w.optionsFor('seller'),approval=createExactOperatorApproval({...options,policy:{...options.policy,listingPin:()=>current}});
  const{composed,asked}=composedFor(w,true,{approval});
  const vet=requestFor({artifactKind:'CompositeVerificationRecord',artifact:{listingPin:pin}});
  assert.equal(await composed(vet),true);assert.equal(asked.length,1);
  current={...pin,version:2};
  assert.equal(await composed.confirm(confirmationFor(vet)),false,'the human\'s yes does not skip the Listing check');
  const last=(await policyLines(w)).at(-1);
  assert.deepEqual([last.decision,last.policyReason,last.policyHold],['rejected','listing','seller-record-missing']);
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[1]}))).reason,null,'the refused confirmation released the only hourly write');
});

test('a seller session with neither a proposal draft nor an Agreement is no record: its pre-payment writes are held, not refused',async t=>{
  const partial={jobId:JOBS[0],buyerBundle:{presentedBy:buyer},proposal:null,stage:'proposed'};
  const w=await world(t,{},{sellerSessions:[partial]});
  assert.equal(w.resolvers.seller(JOBS[0]),null);
  for(const kind of ['CompositeVerificationRecord','FinalityCommitmentRecord']){
    const{composed,asked}=composedFor(w,false);
    assert.equal(await composed(requestFor({artifactKind:kind})),false,kind);assert.equal(asked.length,1,kind);
    assert.equal((await policyLines(w)).at(-1).policyReason,'seller-record-missing',kind);
  }
  assert.equal((await decide(w,'seller',requestFor())).reason,'purchase','after payment, no record is still refused');
});

test('a held write approved by hand and confirmed uses the hourly write budget (Daybreak reproduction)',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'paid'},{limits:{maxWritesPerHour:1}});
  const{composed}=composedFor(w);
  const held=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]});
  assert.equal(await composed(held),true);
  assert.equal(await composed.confirm(confirmationFor(held)),true);
  assert.deepEqual(await decide(w,'seller',requestFor({job:JOBS[1]})),{decision:false,reason:'hourly-write-limit',held:false});
});

test('held writes approved by hand use the hourly budget as the app\'s policy approvals do: three commitments, one write an hour',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'open',[JOBS[2]]:'open'},{limits:{maxWritesPerHour:1}});
  const out={};
  for(const source of ['app','seller']){
    const{composed,asked}=composedFor(w,true,{source});out[source]=[];
    for(const job of JOBS.slice(0,3)){
      const r=requestFor({artifactKind:'FinalityCommitmentRecord',job});
      const prepared=await composed(r),confirmed=prepared?await composed.confirm(confirmationFor(r)):null;
      if(prepared)await composed.settle(r,'spent');
      out[source].push([prepared,confirmed]);
    }
    assert.equal(asked.length,source==='seller'?1:0,source);
  }
  assert.deepEqual(out.app,[[true,true],[false,null],[false,null]]);assert.deepEqual(out.seller,out.app);
  assert.deepEqual((await policyLines(w)).map(row=>[row.decision,row.policyReason,row.policyHold??null]),
    [['rejected','cancellation-unknown',null],['approved',null,'cancellation-unknown'],['rejected','hourly-write-limit',null],['rejected','hourly-write-limit',null]]);
  const attempts=(await lines(w.optionsFor('seller').evidencePath)).map(JSON.parse).filter(row=>row.format==='dacs-node2-seller-policy-attempt/v1');
  assert.deepEqual(attempts.map(row=>row.outcome),['spent'],'recorded as spent once');
});

test('a confirmed held write counts once: one hourly write and one job write, never a second for its manual line',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'paid',[JOBS[2]]:'paid'},{limits:{maxWritesPerHour:2}});
  const path=w.optionsFor('seller').evidencePath,earlier=(i)=>{const r=requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[0]});r.purpose=`TEST earlier ${i}`;return manualLine(r);};
  // Four earlier manual approvals for the job; the held commitment makes five.
  await writeFile(path,`${[0,1,2,3].map(earlier).join('\n')}\n`);
  // As in the operator, the human answers through exact manual approval, which writes its own line.
  const manual=createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath:path,authorize:()=>true,now:()=>w.clock.now});
  const composed=composeSellerApproval({mode:'policy',policy:w.approvals.seller,manual}),held=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[0]});
  assert.equal(await composed(held),true);assert.equal(await composed.confirm(confirmationFor(held)),true);await composed.settle(held,'spent');
  const rows=(await lines(path)).map(JSON.parse).filter(row=>row.approvalHash===sha(JSON.stringify(held))&&row.decision==='approved');
  assert.deepEqual(rows.map(row=>[row.approvalMode??'manual',row.policyHold??null]),[['manual',null],['policy','cancellation-unknown']],'the manual line and the confirmed reservation');
  const sellerVet=()=>requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[0],party:seller}),vet=sellerVet();
  assert.equal((await decide(w,'seller',vet)).reason,'cancellation-unknown','five job writes: a sixth may still be held');
  // Round 7: held and unanswered, the vet record is an open attempt, counted
  // until it ends (here beside the spent confirmed one). The operator declines it.
  assert.equal(heldPolicyBudget(parsePolicyLedger(await readFile(path,'utf8')).rows,w.clock.now).writes,2);
  await w.approvals.seller.settle(vet,'released','manual-declined');
  await appendFile(path,`${earlier(4)}\n`);
  assert.equal((await decide(w,'seller',sellerVet())).reason,'job-write-limit','six job writes');
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[1]}))).reason,null,'one of two hourly writes used');
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[2]}))).reason,'hourly-write-limit');
});

test('a held write\'s budget reservation lasts through the manual gate; a decline or a failed prompt releases it',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'paid'},{limits:{maxWritesPerHour:1}});
  const held=requestFor({artifactKind:'FinalityCommitmentRecord'}),paid=()=>decide(w,'seller',requestFor({job:JOBS[1]})),during=[];
  const{composed}=composedFor(w,async()=>{during.push((await paid()).reason);return false;});
  assert.equal(await composed(held),false);assert.deepEqual(during,['hourly-write-limit'],'the hold reserved the only hourly write');
  const{composed:failing,asked}=composedFor(w,()=>{throw new Error('TEST exact seller approval requires an interactive TTY');});
  await assert.rejects(failing(held),/interactive TTY/);assert.equal(asked.length,1,'the decline released its reservation, so this write was held again');
  assert.equal((await paid()).reason,null,'the failed prompt released its reservation too');
});

test('round 7: a held write at the manual gate takes exactly one hourly write: its hold line on the ledger and its in-memory preparation hold are one write',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'paid',[JOBS[2]]:'paid'},{limits:{maxWritesPerHour:2}});
  const during=[];
  const{composed}=composedFor(w,async()=>{for(const job of [JOBS[1],JOBS[2]])during.push((await decide(w,'seller',requestFor({job}))).reason);return false;});
  assert.equal(await composed(requestFor({artifactKind:'FinalityCommitmentRecord'})),false);
  assert.deepEqual(during,[null,'hourly-write-limit'],'the held write and one paid write fill the two hourly writes');
});

test('a held write approved by hand releases its reservation when its confirmation fails, the wallet releases it, the next approval replaces it or its job closes first',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'paid',[JOBS[2]]:'open'},{limits:{maxWritesPerHour:1}});
  const held=requestFor({artifactKind:'FinalityCommitmentRecord'}),other=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[2]});
  const paid=()=>decide(w,'seller',requestFor({job:JOBS[1]}));
  const{composed,asked}=composedFor(w);
  // Each step holds again only if the previous step released the one hourly write.
  assert.equal(await composed(held),true);assert.equal((await paid()).reason,'hourly-write-limit');
  const wrong=confirmationFor(held);wrong.response.data.transaction.content.nonce=2;
  assert.equal(await composed.confirm(wrong),false,'a confirmation of other bytes fails');
  assert.equal(await composed(held),true,'released by the failed confirmation');
  await composed.settle(held,'released');
  assert.equal(await composed(other),true,'released by the wallet');
  assert.equal(await composed(held),true,'released when the next approval replaced it');
  w.clock.now+=SELLER_PURCHASE_OPEN_WINDOW_MS;
  assert.equal(await composed.confirm(confirmationFor(held)),false,'the job closed while held');
  assert.equal(asked.length,4);
  assert.equal((await paid()).reason,null,'released by the refused confirmation');
});

test('a held write approved by hand stays reserved across a restart (it was sign-authorized, so it may have been signed), and a confirmed held write is counted once after it',async t=>{
  // A fresh module instance stands for the new process: its in-memory holds start empty.
  const restarted=async(w,tag)=>{w.approvals.seller=(await import(`../src/devnet-demo/operator-approval.mjs?restart=${tag}`)).createExactOperatorApproval(w.optionsFor('seller'));};
  const held=requestFor({artifactKind:'FinalityCommitmentRecord'});
  // Approved by hand, then the process ends before confirmation.
  let w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'paid'},{limits:{maxWritesPerHour:1}});
  assert.equal(await composedFor(w).composed(held),true);
  await restarted(w,'held');
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[1]}))).reason,'hourly-write-limit','the sign-authorized hold is still the one hourly write');
  assert.deepEqual((await w.approvals.seller.reconcile()).released,[],'restart never releases a sign-authorized write');
  // Confirmed and spent, then the process ends.
  w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'paid',[JOBS[2]]:'paid'},{limits:{maxWritesPerHour:2}});
  const{composed}=composedFor(w);
  assert.equal(await composed(held),true);assert.equal(await composed.confirm(confirmationFor(held)),true);await composed.settle(held,'spent');
  await restarted(w,'confirmed');
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[1]}))).reason,null,'the confirmed hold is one of two hourly writes');
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[2]}))).reason,'hourly-write-limit');
});

test('a held write is refused at the final check when its record closes, or names an outside buyer, while confirmation reads the ledger',async t=>{
  const w=await world(t,{[JOBS[0]]:'open'}),read=w.resolvers.seller;
  const raced=async(r,second)=>{
    const{composed}=composedFor(w);assert.equal(await composed(r),true);
    let calls=0;w.resolvers.seller=(job)=>++calls===2?second(job):read(job);
    try{assert.equal(await composed.confirm(confirmationFor(r)),false);assert.equal(calls,2);}finally{w.resolvers.seller=read;}
    return(await policyLines(w)).at(-1);
  };
  // A commitment whose job expires in between.
  let last=await raced(requestFor({artifactKind:'FinalityCommitmentRecord'}),(job)=>{w.clock.now+=SELLER_PURCHASE_OPEN_WINDOW_MS;return read(job);});
  assert.deepEqual([last.decision,last.policyReason,last.policyHold],['rejected','purchase-closed','cancellation-unknown']);
  w.clock.now=T0;
  // A vet record with no record at the hold whose record then names a buyer outside closed access.
  last=await raced(requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[1]}),()=>false);
  assert.deepEqual([last.decision,last.policyReason,last.policyHold],['rejected','purchase-closed','seller-record-missing']);
});

// Sets each standard descriptor's isTTY for this test only.
function tty(t,values){
  for(const[name,value]of Object.entries(values)){
    const stream=process[name],own=Object.getOwnPropertyDescriptor(stream,'isTTY');Object.defineProperty(stream,'isTTY',{value,configurable:true});
    t.after(()=>{if(own)Object.defineProperty(stream,'isTTY',own);else delete stream.isTTY;});
  }
}
// An operator config whose admission file is missing: construction stops
// there, after the unattended-start check.
async function startupOperator(t){
  const root=await realpath(await mkdtemp(join(tmpdir(),'seller-records-startup-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=join(root,'operator.json'),stateDirectory=join(root,'state');
  const start=async(sellerApproval,authorizeSellerApproval)=>{
    await writeFile(configPath,`${JSON.stringify({format:'dacs-node2-demo-operator/v1',authority:'TEST-RUN-config',publicOrigin:'http://127.0.0.1:41001',sellerOrigin:'https://127.0.0.1:41002',sellerTls:{keyPath:join(root,'k'),certificatePath:join(root,'c')},directoryOrigin:'http://127.0.0.1:41003',
      stateDirectory,custodyDirectory:join(root,'custody'),networkAdmissionPath:join(root,'missing-admission.json'),
      listing:{listingId:'operator-native-report',listingVersion:1,displayName:'Operator Seller',title:'t',description:'d',category:'services.market-report',tags:[],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:3600},
      sellerFeeBudget:{maxTotalOs:'10000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'x'},sellerApproval})}\n`,{mode:0o600});
    return createDevnetDemoOperator({configPath,...(authorizeSellerApproval?{authorizeSellerApproval}:{})});
  };
  return{start,stateDirectory};
}
const UNATTENDED='sellerApproval policy mode with purchaseSource "seller" holds every vet record and commitment for exact manual approval; start it with an authorize callback or an interactive TTY';

test('policy mode with seller records refuses to start with neither an authorize callback nor a TTY',async t=>{
  tty(t,{stdin:false});
  const{start,stateDirectory}=await startupOperator(t);
  await assert.rejects(start({mode:'policy',purchaseSource:'seller'}),{message:UNATTENDED});
  assert.equal(existsSync(stateDirectory),false,'refused before anything opened');
  // Any other combination goes on (and here stops at the missing admission file).
  for(const[sellerApproval,authorize]of[[{mode:'policy',purchaseSource:'seller'},()=>true],[{mode:'policy'},null],[{mode:'policy',purchaseSource:'app'},null],[{mode:'manual',purchaseSource:'seller'},null]]){
    await assert.rejects(start(sellerApproval,authorize),(error)=>!/holds every vet record/.test(error.message),JSON.stringify(sellerApproval));
  }
});

test('the composer marks a request as held only while it waits at manual approval because the policy held it',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'paid'}),seen=[];
  const{composed}=composedFor(w,(request,self)=>{seen.push([request.content.artifactKind,self.heldForManual(request)]);return false;});
  const held=requestFor({artifactKind:'FinalityCommitmentRecord'}),afterPayment=requestFor({job:JOBS[1],artifactKind:'SettlementEvidence',phase:'pay-dem',artifact:{paymentAmount:{amount:'2',currency:'DEM'}}});
  await composed(held);await composed(afterPayment);
  assert.deepEqual(seen,[['FinalityCommitmentRecord',true],['SettlementEvidence',false]]);
  assert.equal(composed.heldForManual(held),false,'and not once the prompt is answered');
});

// Code review R3, R5, R6, R8: each pins a check a mutant could drop unnoticed.
test('R3: an unverified fixture payment checkpoint is not a payment',async t=>{
  const s=sellerSession(JOBS[0],STORIES.paid);s.paymentWork=s.nativeEvidenceWork;delete s.nativeEvidenceWork;s.paymentWork.intake.disposition='indeterminate';
  const w=await world(t,{},{sellerSessions:[s]});
  assert.equal((await decide(w,'seller',requestFor())).reason,'payment-not-observed');
});

test('R5: a held vet record approved by hand is refused at confirmation once a record naming an outside buyer exists',async t=>{
  const w=await world(t,{});
  const{composed}=composedFor(w),r=requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[0]});
  assert.equal(await composed(r),true);
  await w.durable().withJob(JOBS[0],async()=>w.durable().saveSession(sellerSession(JOBS[0],STORIES['outside-open'])));
  assert.equal(await composed.confirm(confirmationFor(r)),false);
});

test('R6: the seller window is the app\'s 30-minute approval window',()=>{
  assert.equal(SELLER_PURCHASE_OPEN_WINDOW_MS,30*60*1000);
});

test('R8: the retained binding must agree with the signed content\'s network too',async t=>{
  const s=sellerSession(JOBS[0],STORIES.paid);s.agreementSignedProjection.content.network='demos-testnet';
  const w=await world(t,{},{sellerSessions:[s]});
  assert.equal((await decide(w,'seller',requestFor())).reason,'purchase');
});

// Code review R2-I (mutant M10).
test('a confirmation marked held for a request this policy never held is decided afresh, and holds again',async t=>{
  const w=await world(t,{[JOBS[0]]:'open'});
  const r=requestFor({artifactKind:'FinalityCommitmentRecord'});
  assert.equal(await w.approvals.seller(r,confirmationFor(r),{held:true}),false);
  const last=JSON.parse((await lines(w.optionsFor('seller').evidencePath)).at(-1));
  assert.deepEqual([last.decision,last.policyReason,last.policyHold??null],['rejected','cancellation-unknown',null]);
});

// Code review M14, and the attempt rows: a ledger the reader cannot account for fails closed.
test('a malformed held line or attempt row makes the ledger unreadable',async t=>{
  const r=requestFor({artifactKind:'FinalityCommitmentRecord'}),requestBytes=JSON.stringify(r),approvalHash=sha(requestBytes),attemptId='00000000-0000-4000-8000-000000000001';
  const line=(fields)=>JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',approvalHash,requestBytes,method:'sendTransaction',address,totalOs:'4000000000',decision:'approved',...fields,recordedAt:T0});
  const confirmed={approvalMode:'policy',policyReason:null,reservationId:'TEST-reservation',confirmation:confirmationFor(r)};
  const opened=line({decision:'rejected',attemptId,approvalMode:'policy',policyReason:'cancellation-unknown',reservationId:'TEST-hold'});
  const attemptRow=(fields)=>JSON.stringify({format:'dacs-node2-seller-policy-attempt/v1',approvalHash,outcome:'released',...fields,recordedAt:T0});
  const signed='00000000-0000-4000-8000-000000000002';
  const signLine=(fields)=>JSON.stringify({format:'dacs-node2-seller-policy-sign-authorization/v1',reservationId:signed,approvalHash,requestBytes,totalOs:r.content.debit.totalOs,recordedAt:T0,...fields});
  const cases=[
    ['policyHold on a manual line',[line({policyHold:'cancellation-unknown',confirmation:confirmationFor(r)})]],
    ['an unknown hold reason',[line({...confirmed,policyHold:'TEST-reason'})]],
    ['a policyHold without its confirmation',[line({...confirmed,confirmation:undefined,policyHold:'cancellation-unknown'})]],
    ['a manual line for an attempt no hold opened',[line({attemptId})]],
    ['an attempt opened twice',[opened,opened]],
    ['a release of an unknown attempt',[attemptRow({attemptId,reason:'wallet-released'})]],
    ['a release with an unknown reason',[opened,attemptRow({attemptId,reason:'TEST-reason'})]],
    ['an attempt ended twice',[opened,attemptRow({attemptId,reason:'wallet-released'}),attemptRow({attemptId,reason:'replaced'})]],
    ['an attempt release with no reason',[opened,attemptRow({attemptId})]],
    ['an attempt-only release after confirmation',[opened,line({attemptId}),line({...confirmed,attemptId,policyHold:'cancellation-unknown'}),attemptRow({attemptId,reason:'wallet-released'})]],
    ['a confirmation after its attempt ended',[opened,attemptRow({attemptId,reason:'manual-declined'}),line({...confirmed,attemptId,policyHold:'cancellation-unknown'})]],
    // Sign-authorized lines (round 6).
    ['one reservation sign-authorized twice',[signLine({}),signLine({})]],
    ['a sign-authorized line whose hash is not of its bytes',[signLine({approvalHash:'0'.repeat(64)})]],
    ['a sign-authorized line whose total is not its declared debit',[signLine({totalOs:'1'})]],
    ['a sign-authorized line with an unknown field',[signLine({TEST:true})]],
    ['a sign-authorized line for an attempt no hold opened',[signLine({attemptId})]],
    ['an attempt sign-authorized twice',[opened,line({attemptId}),signLine({attemptId}),signLine({attemptId,reservationId:'00000000-0000-4000-8000-000000000003'})]],
    ['a confirmation of a held write\'s sign-authorized reservation without its attemptId',[opened,line({attemptId}),signLine({attemptId}),line({...confirmed,reservationId:signed})]],
    ['a second confirmation of one sign-authorized reservation',[signLine({}),line({...confirmed,reservationId:signed}),line({...confirmed,reservationId:signed})]],
    ['an attempt-only release of a sign-authorized attempt',[opened,line({attemptId}),signLine({attemptId}),attemptRow({attemptId,reason:'wallet-released'})]],
    // Code review r6 P3-4 (its mutant R5): only a confirmation links to a sign-authorized reservation.
    ['a policy line that is not a confirmation, reusing a sign-authorized reservationId',[signLine({}),line({approvalMode:'policy',policyReason:null,reservationId:signed})]],
    ['a refused policy line that is not a confirmation, reusing a sign-authorized reservationId',[signLine({}),line({decision:'rejected',approvalMode:'policy',policyReason:'sign-authorization-unavailable',reservationId:signed})]],
    // Code review r6 mutant R6: an attempt that ended is never sign-authorized afterwards.
    ['a sign-authorized line for an attempt that already ended',[opened,attemptRow({attemptId,reason:'manual-declined'}),signLine({attemptId})]],
    // Daybreak r6's surviving mutant: a completion may not precede its reservation.
    ['a completion recorded before its reservation',[signLine({recordedAt:T0+1}),attemptRow({reservationId:signed})]],
  ];
  for(const[name,rows]of cases){
    const w=await world(t,{[JOBS[0]]:'paid'});
    await writeFile(w.optionsFor('seller').evidencePath,`${rows.join('\n')}\n`);
    assert.equal((await decide(w,'seller',requestFor())).reason,'evidence-unreadable',name);
  }
  // The well-formed attempt reads.
  const w=await world(t,{[JOBS[0]]:'paid'});
  await writeFile(w.optionsFor('seller').evidencePath,`${[opened,line({attemptId}),line({...confirmed,attemptId,policyHold:'cancellation-unknown'}),attemptRow({reservationId:'TEST-reservation',attemptId,outcome:'spent'})].join('\n')}\n`);
  assert.equal((await decide(w,'seller',requestFor())).reason,null);
  // And with its sign-authorized line, as this round writes it.
  const v=await world(t,{[JOBS[0]]:'paid'});
  await writeFile(v.optionsFor('seller').evidencePath,`${[opened,line({attemptId}),signLine({attemptId}),line({...confirmed,reservationId:signed,attemptId,policyHold:'cancellation-unknown'}),attemptRow({reservationId:signed,attemptId,outcome:'spent'})].join('\n')}\n`);
  assert.equal((await decide(v,'seller',requestFor())).reason,null);
});

// The operator's wiring: exact manual approval on the same ledger answers
// through authorize and writes its own line.
function operatorManual(w,answer=()=>true,approval=w.approvals.seller){
  const path=w.optionsFor('seller').evidencePath,asked=[];
  const manual=createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath:path,authorize:async({request})=>{asked.push(request);return answer(request);},now:()=>w.clock.now});
  return{composed:composeSellerApproval({mode:'policy',policy:approval,manual}),asked,path};
}
const ledgerRows=async(path)=>(await lines(path)).map(JSON.parse);
const attemptRows=async(path)=>(await ledgerRows(path)).filter(row=>row.format==='dacs-node2-seller-policy-attempt/v1');

test('held writes approved by hand and released before issuance use neither quota: six released attempts leave the seventh to manual approval (Daybreak reproduction)',async t=>{
  const w=await world(t,{[JOBS[0]]:'open'});
  const{composed,asked,path}=operatorManual(w),held=requestFor({artifactKind:'FinalityCommitmentRecord'});
  for(let i=0;i<SELLER_POLICY_MAX_WRITES;i++){assert.equal(await composed(held),true,`attempt ${i+1}`);await composed.settle(held,'released');}
  assert.equal(await composed(held),true,'the seventh attempt still reaches manual approval');assert.equal(asked.length,SELLER_POLICY_MAX_WRITES+1);
  // Each attempt: its hold, then its manual line, then its release, under one attemptId.
  // Each attempt is sign-authorized after its manual line, before the wallet could sign.
  const rows=await ledgerRows(path),kinds=rows.map(row=>row.format.endsWith('attempt/v1')?`release:${row.reason}`:row.format.endsWith('sign-authorization/v1')?'sign':row.approvalMode?`hold:${row.policyReason}`:`manual:${row.decision}`);
  assert.deepEqual(kinds,[...Array.from({length:SELLER_POLICY_MAX_WRITES},()=>['hold:cancellation-unknown','manual:approved','sign','release:wallet-released']).flat(),'hold:cancellation-unknown','manual:approved','sign']);
  for(let i=0;i<rows.length;i+=4)assert.ok(rows[i].attemptId&&rows.slice(i,i+4).every(row=>row.attemptId===rows[i].attemptId),`attempt ${i/4+1} has one id`);
  for(let i=2;i<rows.length;i+=4)assert.equal(rows.slice(i,i+2).filter(row=>row.reservationId===rows[i].reservationId).length,i+1<rows.length?2:1,'the release ends that sign-authorized reservation');
  assert.equal(new Set(rows.map(row=>row.attemptId)).size,SELLER_POLICY_MAX_WRITES+1);
});

test('every release before issuance ends its attempt with its reason and counts zero; a confirmed attempt counts exactly one job write',async t=>{
  const w=await world(t,{[JOBS[0]]:'open'});
  const path=w.optionsFor('seller').evidencePath,earlier=(i)=>{const r=requestFor({artifactKind:'CompositeVerificationRecord'});r.purpose=`TEST earlier ${i}`;return manualLine(r);};
  // Five earlier (older-format) manual approvals for the job: one write left.
  await writeFile(path,`${[0,1,2,3,4].map(earlier).join('\n')}\n`);
  const answers=[false],{composed}=operatorManual(w,()=>answers.shift()??true);
  const commit=(i)=>{const r=requestFor({artifactKind:'FinalityCommitmentRecord'});r.purpose=`TEST commitment ${i}`;return r;};
  // Declined by hand.
  assert.equal(await composed(commit(1)),false);
  // A confirmation of other bytes.
  let r=commit(2);assert.equal(await composed(r),true);const wrong=confirmationFor(r);wrong.response.data.transaction.content.nonce=2;assert.equal(await composed.confirm(wrong),false);
  // Released by the wallet before confirmation.
  r=commit(3);assert.equal(await composed(r),true);await composed.settle(r,'released');
  // Refused at confirmation (a debit above the declaration): no wallet release needed.
  r=commit(4);assert.equal(await composed(r),true);const over=confirmationFor(r);over.response.data.transaction.content.gcr_edits[1].amount='9000000000';assert.equal(await composed.confirm(over),false);
  // Replaced by the next approval, which the wallet then releases.
  r=commit(5);assert.equal(await composed(r),true);r=commit(6);assert.equal(await composed(r),true);await composed.settle(r,'released');
  assert.deepEqual((await attemptRows(path)).map(row=>[row.outcome,row.reason]),[['released','manual-declined'],['released','confirmation-mismatch'],['released','wallet-released'],['released','confirmation-refused'],['released','replaced'],['released','wallet-released']]);
  const seventh=commit(7);
  assert.equal((await decide(w,'seller',seventh)).reason,'cancellation-unknown','six released attempts left the last job write free');
  // Round 7: held and unanswered, it is an open attempt and takes that job
  // write until it ends. The operator declines it.
  assert.equal((await decide(w,'seller',commit(10))).reason,'job-write-limit','the open attempt holds the last job write');
  await w.approvals.seller.settle(seventh,'released','manual-declined');
  // Confirmed and spent: its manual line, reservation and completion are one write.
  r=commit(8);assert.equal(await composed(r),true);assert.equal(await composed.confirm(confirmationFor(r)),true);await composed.settle(r,'spent');
  const mine=(await ledgerRows(path)).filter(row=>row.approvalHash===sha(JSON.stringify(r)));
  assert.deepEqual(mine.map(row=>row.format.endsWith('attempt/v1')?`end:${row.outcome}`:row.format.endsWith('sign-authorization/v1')?'sign':row.approvalMode?`${row.decision}:${row.policyHold??'hold'}`:`manual:${row.decision}`),['rejected:hold','manual:approved','sign','approved:cancellation-unknown','end:spent']);
  assert.equal(new Set(mine.map(row=>row.attemptId)).size,1);assert.ok(mine[0].attemptId);
  assert.equal((await decide(w,'seller',commit(9))).reason,'job-write-limit','five earlier writes and the confirmed attempt');
});

test('older lines without an attemptId keep their counting: a held reservation and its manual line for the same bytes are one job write',async t=>{
  const w=await world(t,{[JOBS[0]]:'open'});
  const path=w.optionsFor('seller').evidencePath,vet=(i)=>{const r=requestFor({artifactKind:'CompositeVerificationRecord'});r.purpose=`TEST earlier ${i}`;return r;};
  const held=vet('held'),requestBytes=JSON.stringify(held);
  const reservation=JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',approvalHash:sha(requestBytes),requestBytes,method:'sendTransaction',address,totalOs:'4000000000',decision:'approved',
    approvalMode:'policy',policyReason:null,reservationId:'TEST-older',policyHold:'seller-record-missing',confirmation:confirmationFor(held),recordedAt:T0});
  await writeFile(path,`${[...[0,1,2,3].map(i=>manualLine(vet(i))),manualLine(held),reservation].join('\n')}\n`);
  assert.equal((await decide(w,'seller',requestFor({artifactKind:'FinalityCommitmentRecord'}))).reason,'cancellation-unknown','five job writes');
  await appendFile(path,`${manualLine(vet(4))}\n`);
  assert.equal((await decide(w,'seller',requestFor({artifactKind:'FinalityCommitmentRecord'}))).reason,'job-write-limit','six job writes');
});

// Round 7 (Daybreak r6 P1): this row changed. The attempt held and never
// answered by hand was released at restart ('unconfirmed-at-restart'); now
// it stays held and counted, since an older copy of the ledger can lack its
// manual approval and sign-authorized line.
test('restart reconciliation releases nothing: an attempt still at the manual gate and every sign-authorized write stay held and counted, whatever the journal shows (Daybreak r6 P1, r7 P1)',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'open',[JOBS[2]]:'open',[JOBS[3]]:'open',[JOBS[4]]:'paid',[JOBS[5]]:'open'});
  const commit=(job)=>requestFor({artifactKind:'FinalityCommitmentRecord',job});
  // Held and never answered by hand; approved by hand and never confirmed; then
  // three confirmed and never completed. The process then ends.
  assert.equal((await decide(w,'seller',commit(JOBS[5]))).held,true);
  assert.equal(await operatorManual(w).composed(commit(JOBS[0])),true);
  for(const job of JOBS.slice(1,4)){const{composed}=operatorManual(w),r=commit(job);assert.equal(await composed(r),true);assert.equal(await composed.confirm(confirmationFor(r)),true);}
  // The new process: what its wallet journal shows for each write. 'none' is no release proof.
  const shown={[JOBS[0]]:'none',[JOBS[1]]:'none',[JOBS[2]]:'issued',[JOBS[3]]:'unknown'},asked=[];
  const options=w.optionsFor('seller'),{createExactOperatorApproval:fresh}=await import('../src/devnet-demo/operator-approval.mjs?restart=reconcile');
  const restarted=fresh({...options,sellerApproval:{mode:'policy',maxWritesPerHour:5},policy:{...options.policy,issuance:async(request)=>{asked.push(request.content.jobId);return shown[request.content.jobId];}}});
  w.approvals.seller=restarted;
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[4]}))).reason,'hourly-write-limit','four sign-authorized reservations and the open attempt are outstanding');
  const path=options.evidencePath,before=await lines(path);
  const result=await restarted.reconcile();
  assert.deepEqual(asked,JOBS.slice(0,4),'every sign-authorized reservation is labelled from the journal');
  assert.deepEqual(result.released,[],'restart releases nothing');
  assert.deepEqual(result.held.map(item=>[item.jobId,item.artifactKind,item.state,Boolean(item.attemptId),Boolean(item.reservationId)]),
    [[JOBS[5],'FinalityCommitmentRecord','approval-unknown',true,false],[JOBS[0],'FinalityCommitmentRecord','issuance-unknown',true,true],[JOBS[1],'FinalityCommitmentRecord','issuance-unknown',true,true],[JOBS[2],'FinalityCommitmentRecord','issued-outcome-unknown',true,true],[JOBS[3],'FinalityCommitmentRecord','issuance-unknown',true,true]]);
  assert.deepEqual(await lines(path),before,'reconciliation wrote nothing');
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[4]}))).reason,'hourly-write-limit','the open attempt still holds an hourly write');
  // Held ones never age out, and a second pass writes nothing new.
  w.clock.now+=SELLER_POLICY_WINDOW_MS+1;
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[4],artifactKind:'SettlementEvidence'}))).reason,'hourly-write-limit');
  const after=await lines(path);
  assert.deepEqual((await restarted.reconcile()).held.map(item=>item.jobId),[JOBS[5],...JOBS.slice(0,4)]);assert.deepEqual(await lines(path),after);
});

test('reconciliation never touches an attempt or reservation the running process still owns, and with no journal reader keeps every sign-authorized reservation',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'open'});
  const options=w.optionsFor('seller'),path=options.evidencePath;
  // Worst case for the resume pass: the journal shows no marker yet for a write about to be issued.
  const running=createExactOperatorApproval({...options,policy:{...options.policy,issuance:()=>'none'}});
  const a=requestFor({artifactKind:'FinalityCommitmentRecord'}),b=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]});
  const first=operatorManual(w,()=>true,running).composed;assert.equal(await first(a),true);assert.equal(await first.confirm(confirmationFor(a)),true);
  assert.equal(await operatorManual(w,()=>true,running).composed(b),true);
  const before=(await lines(path)).length;
  assert.deepEqual(await running.reconcile(),{released:[],held:[]});assert.equal((await lines(path)).length,before);
  // After a restart with no journal reader: both were sign-authorized, so both stay held.
  const result=await createExactOperatorApproval(options).reconcile();
  assert.deepEqual(result.released,[]);
  assert.deepEqual(result.held.map(item=>[item.jobId,item.state]),[[JOBS[0],'issuance-unknown'],[JOBS[1],'issuance-unknown']]);
});

test('a held vet record confirmed once a proposal draft without the buyer\'s signed Agreement CREATE has landed: the missing binding is not compared, the rest of the draft is (code review R2-H)',async t=>{
  const w=await world(t,{});
  const{composed}=composedFor(w),vet=requestFor({artifactKind:'CompositeVerificationRecord'});
  const draftOnly=(story)=>{const s=sellerSession(JOBS[0],story);delete s.agreementSignedProjection;return s;};
  assert.equal(await composed(vet),true);
  await w.durable().withJob(JOBS[0],async()=>w.durable().saveSession(draftOnly(STORIES.open)));
  assert.equal(await composed.confirm(confirmationFor(vet)),true,'as the app and the earlier manual confirmation do');
  // Not held: the same draft-only record is still refused, as before.
  assert.equal((await decide(w,'seller',requestFor({artifactKind:'CompositeVerificationRecord',party:seller}))).reason,'purchase');
  // The draft-only exception is limited to Vet and to an absent binding (K13/K14).
  const commit=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[2]});
  assert.equal(await composed(commit),true);
  const unboundCommit=sellerSession(JOBS[2],STORIES.open);delete unboundCommit.agreementSignedProjection;
  await w.durable().withJob(JOBS[2],async()=>w.durable().saveSession(unboundCommit));
  assert.equal(await composed.confirm(confirmationFor(commit)),false,'a commitment cannot skip its missing binding');
  const wrongBinding=requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[3]});
  assert.equal(await composed(wrongBinding),true);
  await w.durable().withJob(JOBS[3],async()=>w.durable().saveSession(sellerSession(JOBS[3],{...STORIES.open,binding:{...sourceBinding,chainIdentity:'f'.repeat(64)}})));
  assert.equal(await composed.confirm(confirmationFor(wrongBinding)),false,'a retained conflicting binding cannot be skipped');
  // A draft whose price is not in DEM still refuses the held confirmation.
  const other=requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[1]});
  assert.equal(await composed(other),true);
  const unpriced=sellerSession(JOBS[1],STORIES.open);delete unpriced.agreementSignedProjection;unpriced.proposal.plan.draft.terms.price={amount:'1',currency:'TEST'};
  await w.durable().withJob(JOBS[1],async()=>w.durable().saveSession(unpriced));
  assert.equal(await composed.confirm(confirmationFor(other)),false);
  assert.equal(JSON.parse((await lines(w.optionsFor('seller').evidencePath)).filter(line=>JSON.parse(line).approvalMode).at(-1)).policyReason,'purchase');
});

test('the unattended-start check reads stdin and stderr, where the prompt is written: either one not a TTY refuses, stdout does not matter',async t=>{
  const{start}=await startupOperator(t),seller={mode:'policy',purchaseSource:'seller'};
  for(const[descriptors,refused]of[[{stdin:false,stdout:true,stderr:true},true],[{stdin:true,stdout:true,stderr:false},true],[{stdin:true,stdout:false,stderr:true},false]]){
    await t.test(JSON.stringify(descriptors),async st=>{
      tty(st,descriptors);
      await assert.rejects(start(seller),(error)=>/holds every vet record/.test(error.message)===refused);
    });
  }
});

test('the exact manual prompt reads stdin and stderr: either one not a TTY refuses before the prompt, stdout does not matter',async t=>{
  const w=await world(t,{});
  const manual=createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath:join(w.root,'manual-approvals.jsonl'),now:()=>T0});
  for(const[descriptors,refused]of[[{stdin:false,stdout:true,stderr:true},true],[{stdin:true,stdout:true,stderr:false},true],[{stdin:true,stdout:false,stderr:true},false]]){
    await t.test(JSON.stringify(descriptors),async st=>{
      tty(st,descriptors);
      // The prompt's first write stands in for the human: reaching it passes the check.
      st.mock.method(process.stderr,'write',()=>{throw new Error('TEST prompt reached');});
      try{await assert.rejects(manual(requestFor()),{message:refused?'exact seller approval requires an interactive TTY':'TEST prompt reached'});}
      finally{st.mock.restoreAll();}
    });
  }
});


test('restart reconciliation: a thrown issuance read keeps a confirmed reservation held beyond the hour (K7)',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'paid'},{limits:{maxWritesPerHour:1}});
  const r=requestFor({artifactKind:'FinalityCommitmentRecord'}),{composed}=operatorManual(w);
  assert.equal(await composed(r),true);assert.equal(await composed.confirm(confirmationFor(r)),true);
  const options=w.optionsFor('seller'),before=await lines(options.evidencePath);
  w.clock.now+=SELLER_POLICY_WINDOW_MS+1;
  const restarted=createExactOperatorApproval({...options,policy:{...options.policy,issuance:()=>{throw new Error('TEST journal lost');}}});
  const result=await restarted.reconcile();
  assert.deepEqual(result.released,[]);assert.deepEqual(result.held.map(row=>row.state),['issuance-unknown']);
  assert.deepEqual(await lines(options.evidencePath),before,'no release proof was written');
  w.approvals.seller=restarted;
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[1]}))).reason,'hourly-write-limit');
});

test('restart reconciliation: with a clock behind the confirmed reservation it writes nothing and the ledger stays readable (K15)',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'paid'},{limits:{maxWritesPerHour:1}});
  const r=requestFor({artifactKind:'FinalityCommitmentRecord'}),{composed}=operatorManual(w);
  assert.equal(await composed(r),true);assert.equal(await composed.confirm(confirmationFor(r)),true);
  const options=w.optionsFor('seller'),before=await lines(options.evidencePath);w.clock.now-=60_000;
  const restarted=createExactOperatorApproval({...options,policy:{...options.policy,issuance:()=>'none'}});
  assert.deepEqual((await restarted.reconcile()).released,[]);
  assert.deepEqual(await lines(options.evidencePath),before);
  w.approvals.seller=restarted;
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[1]}))).reason,'hourly-write-limit','the ledger reads, and the reservation still holds the budget');
});

// Round 6 (Daybreak r6 P1): a reservation is durable before anything can sign.
test('preparation retains a synced sign-authorized line before it lets the wallet sign; the confirmation carries its reservationId; a held write is sign-authorized after its manual line; manual mode writes none',async t=>{
  const w=await world(t,{[JOBS[0]]:'paid',[JOBS[1]]:'open'});
  const{composed,path}=operatorManual(w);
  const paid=requestFor({job:JOBS[0]});
  assert.equal(await composed(paid),true);
  const signed=(await ledgerRows(path)).at(-1);
  assert.deepEqual(Object.keys(signed).sort(),['approvalHash','format','recordedAt','requestBytes','reservationId','totalOs']);
  assert.deepEqual([signed.format,signed.requestBytes,signed.approvalHash,signed.totalOs],['dacs-node2-seller-policy-sign-authorization/v1',JSON.stringify(paid),sha(JSON.stringify(paid)),paid.content.debit.totalOs]);
  assert.equal(await composed.confirm(confirmationFor(paid)),true);
  const approved=(await ledgerRows(path)).at(-1);
  assert.deepEqual([approved.decision,approved.approvalMode,approved.reservationId,approved.approvalHash],['approved','policy',signed.reservationId,signed.approvalHash]);
  await composed.settle(paid,'spent');
  assert.equal((await attemptRows(path)).at(-1).reservationId,signed.reservationId);
  // A held commitment: hold, manual line, then its sign-authorized line with the attemptId, all before the answer.
  const held=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]});
  assert.equal(await composed(held),true);
  const [hold,manualRow,heldSigned]=(await ledgerRows(path)).slice(-3);
  assert.equal(hold.policyReason,'cancellation-unknown');assert.equal(manualRow.decision,'approved');
  assert.deepEqual([heldSigned.format,heldSigned.attemptId,heldSigned.approvalHash],['dacs-node2-seller-policy-sign-authorization/v1',hold.attemptId,hold.approvalHash]);
  assert.equal(await composed.confirm(confirmationFor(held)),true);
  const confirmed=(await ledgerRows(path)).at(-1);
  assert.deepEqual([confirmed.policyHold,confirmed.reservationId,confirmed.attemptId],['cancellation-unknown',heldSigned.reservationId,hold.attemptId]);
  // An exact manual approval (manual mode) reserves nothing and is never sign-authorized.
  const count=(await lines(path)).length,manualOnly=createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath:path,authorize:async()=>true,now:()=>w.clock.now});
  const plain=composeSellerApproval({mode:'manual',policy:w.approvals.seller,manual:manualOnly});
  assert.equal(await plain(requestFor({job:JOBS[0],artifactKind:'SettlementEvidence'})),true);
  assert.equal((await ledgerRows(path)).slice(count).filter(row=>row.format.endsWith('sign-authorization/v1')).length,0);
});

// Final review fe58 finding 2: before payment a refusal is final for the
// artifact, so a held write whose sign authorization fails is not refused.
test('a sign-authorized line that cannot be retained: preparation never answers true, and a held write approved by hand is not signed then, nor refused: its attempt ends released and it is decided again, as a new hold for a new exact manual approval',async t=>{
  const w=await world(t,{[JOBS[0]]:'paid',[JOBS[1]]:'open'});
  const{composed,path}=operatorManual(w),paid=requestFor({job:JOBS[0]});
  await writeFile(path,'');chmodSync(path,0o400);
  try{await assert.rejects(composed(paid),{code:'EACCES'},'nothing to sign: the refusal itself cannot be written either');}
  finally{chmodSync(path,0o600);}assert.equal(await readFile(path,'utf8'),'');
  // The first sign authorization fails; the composer pauses, then decides the write again.
  const held=requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]});
  let failures=1,pauses=0;const asked=[];
  const policy=Object.assign((...args)=>w.approvals.seller(...args),{...Object.fromEntries(['prepare','settle','heldForManual','heldAttempt'].map(name=>[name,(...args)=>w.approvals.seller[name](...args)])),
    authorizeSign:async(request)=>failures-->0?false:w.approvals.seller.authorizeSign(request),pause:async()=>{pauses++;}});
  const manual=createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath:path,authorize:async({request})=>{asked.push(request);return true;},now:()=>w.clock.now});
  assert.equal(await composeSellerApproval({mode:'policy',policy,manual})(held),true,'not refused');
  assert.equal(asked.length,2,'the operator is asked again');assert.equal(pauses,1);
  const rows=await ledgerRows(path),[first,second]=[...new Set(rows.map(row=>row.attemptId))];
  const kinds=(id)=>rows.filter(row=>row.attemptId===id).map(row=>row.format.endsWith('attempt/v1')?`end:${row.outcome}:${row.reason}`:row.format.endsWith('sign-authorization/v1')?'sign':row.approvalMode?`hold:${row.policyReason}`:'manual');
  assert.deepEqual(kinds(first),['hold:cancellation-unknown','manual','end:released:sign-authorization-failed'],'nothing of the first attempt may be signed');
  assert.deepEqual(kinds(second),['hold:cancellation-unknown','manual','sign']);
  assert.equal(rows.length,6);
  // The approval itself refuses a request it never held.
  assert.equal(await w.approvals.seller.authorizeSign(requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]})),false);
});

// Round 7 (Daybreak r6 P1, code r6 P3-3): this row changed. The attempt that
// never got an answer was released at restart; now it is held. Both are
// counted against both hourly limits, the approved one included (it was
// listed but not counted).
test('restart holds a held attempt approved by hand that has no sign-authorized line (an earlier build let the wallet sign right after that approval), and one never answered: approved-sign-unknown and approval-unknown, both counted, never released',async t=>{
  const w=await world(t,{[JOBS[0]]:'open',[JOBS[1]]:'open',[JOBS[2]]:'paid'},{limits:{maxWritesPerHour:2}});
  const options=w.optionsFor('seller'),path=options.evidencePath,commit=requestFor({artifactKind:'FinalityCommitmentRecord'});
  // The hold line and the operator's approval, as an earlier build wrote them before signing.
  assert.equal((await decide(w,'seller',commit)).held,true);
  const hold=(await ledgerRows(path)).at(-1),manual=createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath:path,authorize:async()=>true,now:()=>w.clock.now});
  assert.equal(await manual(commit,undefined,{attemptId:hold.attemptId}),true);
  // One more held attempt that never got an answer.
  assert.equal((await decide(w,'seller',requestFor({artifactKind:'FinalityCommitmentRecord',job:JOBS[1]}))).held,true);
  const unanswered=(await ledgerRows(path)).at(-1),before=await lines(path);
  const restarted=createExactOperatorApproval({...options,policy:{...options.policy,issuance:()=>'none'}}),result=await restarted.reconcile();
  assert.deepEqual(result.released,[]);
  assert.deepEqual(result.held.map(item=>[item.jobId,item.attemptId,item.reservationId,item.state]),[[JOBS[0],hold.attemptId,null,'approved-sign-unknown'],[JOBS[1],unanswered.attemptId,null,'approval-unknown']]);
  assert.deepEqual(await lines(path),before,'nothing was written');
  // Each holds its declared debit and one hourly write: the two take the whole budget.
  assert.deepEqual(heldPolicyBudget(parsePolicyLedger(await readFile(path,'utf8')).rows,w.clock.now),{writes:2,totalOs:8_000_000_000n});
  w.approvals.seller=restarted;
  assert.equal((await decide(w,'seller',requestFor({job:JOBS[2]}))).reason,'hourly-write-limit');
});

test('a confirmation with no sign-authorized line of this process for its bytes is refused (sign-authorization-missing), even for a held write the operator approved',async t=>{
  const w=await world(t,{[JOBS[0]]:'open'});
  // A composer whose policy cannot sign-authorize (no authorizeSign): it lets the wallet sign, but confirmation refuses.
  const policy=Object.assign((...args)=>w.approvals.seller(...args),Object.fromEntries(['prepare','settle','heldForManual','heldAttempt'].map(name=>[name,(...args)=>w.approvals.seller[name](...args)])));
  const manual=createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath:w.optionsFor('seller').evidencePath,authorize:async()=>true,now:()=>w.clock.now});
  const composed=composeSellerApproval({mode:'policy',policy,manual}),held=requestFor({artifactKind:'FinalityCommitmentRecord'});
  assert.equal(await composed(held),true);
  assert.equal(await composed.confirm(confirmationFor(held)),false);
  const last=(await ledgerRows(w.optionsFor('seller').evidencePath)).filter(row=>row.approvalMode==='policy').at(-1);
  assert.deepEqual([last.decision,last.policyReason,last.policyHold],['rejected','sign-authorization-missing','cancellation-unknown']);
});
