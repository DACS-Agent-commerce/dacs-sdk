import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACT_SEPARATORS, finalityCommitmentAddress, generateCanonicalJobId, listingAddress, paymentEvidenceAddress, signComponentArtifact, FINALITY_COMMITMENT_SEPARATOR } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionTransport } from './helpers/devnet-live-composition-transport.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { createDevnetDemoArtifactAnchor } from '../src/devnet-demo/artifact-anchor.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { classifyStorageWriteSubmission, storageWriteAbsent, storageWriteConfirmationMatches } from '../src/devnet-demo/storage-write-recovery.mjs';
import { createDemosSr2WalletBridge } from '../src/dacs/demos-sr2-wallet-bridge.mjs';
import { fixtureListing } from './fixtures/listings.mjs';

const envelope=response=>({result:200,response,require_reply:false,extra:null});
const statusEnvelope=response=>({...envelope(response),extra:''});
const missingTransaction=()=>({result:400,response:'error',require_reply:false,extra:null});
// Public TEST shape only, not a cryptographically verified node signature.
const validityData=data=>({data:{reference_block:0,message:'[Tx Validation] Transaction signature verified\n',...data},signature:{type:'ed25519',data:'0x'+'11'.repeat(64)},rpc_public_key:{type:'ed25519',data:'0x'+'22'.repeat(32)}});
const confirmationDataFaults={
  ...Object.fromEntries(['valid','reference_block','message','gas_operation','transaction'].map(field=>[`missing-${field}`,data=>{delete data[field];}])),
  'valid-type':data=>{data.valid='true';},
  'reference_block-type':data=>{data.reference_block='0';},
  'message-type':data=>{data.message=42;},
  'gas_operation-type':data=>{data.gas_operation=false;},
  'transaction-type':data=>{data.transaction=[];},
  reduced:data=>{delete data.reference_block;delete data.message;delete data.gas_operation;},
  'reference_block-negative':data=>{data.reference_block=-1;},
  'reference_block-fractional':data=>{data.reference_block=0.5;},
  'reference_block-unsafe':data=>{data.reference_block=Number.MAX_SAFE_INTEGER+1;},
  'custom_charges-null':data=>{data.custom_charges=null;},
};

async function fixture(t,{mode='lost-once',signer=true,kind='FinalityCommitmentRecord',nonceFaultAt=1}={}) {
  const directory=mkdtempSync(join(tmpdir(),'storage-recovery-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'source.sqlite');
  let source=openDurableWalletJournal({path,mode:'create'});t.after(()=>source.close());
  const broadcasts=[],confirms=[];let hash,nonceReads=0,recoveryConfirmation;
  const submissions={'null-submission':null,'empty-submission':{},'missing-hash':{message:'unexpected success'}};
  const harness=await startDevnetLiveCompositionTransport({sourceJournal:source,deliveryEvidenceEnabled:kind==='SettlementEvidence',transportOptions:{inclusionWaitMs:0},rpcResponse:async(body,headers)=>{
    const call=body.params?.[0];
    if(call?.extra==='confirmTx') {
      confirms.push(JSON.stringify(call.data));
      if(confirms.length>1 && mode.startsWith('confirm-data-')){
        recoveryConfirmation=validityData({valid:true,transaction:call.data,gas_operation:null});
        confirmationDataFaults[mode.slice('confirm-data-'.length)](recoveryConfirmation.data);
        return envelope(recoveryConfirmation);
      }
      if(confirms.length>1 && mode.startsWith('confirm-envelope-')){
        const answer=envelope(validityData({valid:true,transaction:call.data,gas_operation:null}));
        if(mode==='confirm-envelope-error')answer.error='rejected';
        if(mode==='confirm-envelope-success-false')answer.success=false;
        if(mode==='confirm-envelope-missing-key')delete answer.require_reply;
        if(mode==='confirm-envelope-extra-key')answer.unexpected=true;
        if(mode==='confirm-envelope-require-reply')answer.require_reply=true;
        if(mode==='confirm-envelope-extra-value')answer.extra='';
        return answer;
      }
      if(confirms.length>1 && mode.startsWith('confirm-response-')){
        const response=validityData({valid:true,transaction:call.data,gas_operation:null});
        if(mode==='confirm-response-error')response.error='rejected';
        if(mode==='confirm-response-success-false')response.success=false;
        if(mode==='confirm-response-extra-key')response.unexpected=true;
        if(mode==='confirm-response-signature-missing')delete response.signature;
        if(mode==='confirm-response-signature-malformed')response.signature.data='0xab';
        if(mode==='confirm-response-signature-null')response.signature=null;
        if(mode==='confirm-response-rpc-key-missing')delete response.rpc_public_key;
        if(mode==='confirm-response-rpc-key-malformed')response.rpc_public_key={type:'unexpected',data:'0x'+'22'.repeat(32)};
        if(mode==='confirm-response-rpc-key-null')response.rpc_public_key=null;
        return envelope(response);
      }
      if(mode==='omitted-gas') return envelope(validityData({valid:true,transaction:call.data,...(confirms.length>1?{gas_operation:null}:{})}));
      if(confirms.length>1 && mode==='confirmation-field') return envelope(validityData({valid:true,transaction:call.data,gas_operation:null,unexpected:true}));
      if(confirms.length>1 && mode==='custom-charges') return envelope(validityData({valid:true,transaction:call.data,gas_operation:null,custom_charges:[{amount:'1'}]}));
      if(confirms.length>1 && mode==='changed-fee') return envelope(validityData({valid:true,transaction:call.data,gas_operation:{fees:{network_fee:'9999999999'}}}));
      const answer=await fetch(`${harness.chain.url}/`,{method:'POST',headers:{'content-type':'application/json',identity:headers.identity,signature:headers.signature,timestamp:headers.timestamp},body:JSON.stringify(body)}).then(response=>response.json());
      return {...answer,response:validityData(answer.response.data)};
    }
    if(call?.extra==='broadcastTx') {
      const tx=call.data.response.data.transaction;hash=tx.hash;broadcasts.push(JSON.stringify(tx));
      if(mode==='found'){
        const reply=await fetch(`${harness.chain.url}/`,{method:'POST',headers:{'content-type':'application/json',identity:headers.identity,signature:headers.signature,timestamp:headers.timestamp},body:JSON.stringify(body)}).then(response=>response.json());
        return reply.result===200?envelope({txHash:hash}):reply;
      }
      if(mode!=='found' && (broadcasts.length===1 || mode==='always-lost')) return Object.hasOwn(submissions,mode)?envelope(submissions[mode]):mode==='unclassified'?envelope({success:false}):{result:200,response:{message:'Transaction relayed to validators'},require_reply:false,extra:{confirmationBlock:2}};
    }
    const lost=hash && harness.chain.wire.record.accepted.length===0;
    if(call?.message==='getBlockByNumber' && call.data.blockNumber===0){
      const answer=await fetch(`${harness.chain.url}/`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(response=>response.json());
      answer.extra='';
      if(lost){
        if(mode==='identity-response-error')answer.response.error='backend failure';
        if(mode==='identity-response-success-false')answer.response.success=false;
        if(mode==='identity-response-extra-key')answer.response.unexpected=true;
        if(mode==='block-envelope-error')answer.error='backend failure';
        if(mode==='block-envelope-success-false')answer.success=false;
        if(mode==='block-envelope-missing-key')delete answer.require_reply;
        if(mode==='block-envelope-extra-key')answer.unexpected=true;
        if(mode==='block-envelope-require-reply')answer.require_reply=true;
        if(mode==='block-envelope-extra-value')answer.extra=null;
      }
      return answer;
    }
    if(lost && call?.message==='getTransactionStatus') return statusEnvelope(mode==='ambiguous-status'?{state:'pending'}:{state:'unknown'});
    if(lost && call?.message==='getTxByHash') return mode==='ambiguous-hash'?{result:500,response:'error'}:mode==='null-hash'?envelope(null):missingTransaction();
    if(lost && call?.message==='getAddressNonce') {
      const answer=envelope(mode==='consumed'?1:mode==='ambiguous-nonce'?{}:mode==='nonce-changed'&&confirms.length>1?1:0);
      if(++nonceReads===nonceFaultAt){
        if(mode==='nonce-success-false')answer.success=false;
        if(mode==='nonce-error')return {result:200,response:answer.response,error:'backend failure'};
        if(mode==='nonce-missing-key')delete answer.require_reply;
        if(mode==='nonce-extra-key')answer.unexpected=true;
      }
      return answer;
    }
  }});t.after(()=>harness.close());
  globalThis.location=new URL(harness.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${harness.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const walletTransport=createDevnetAgreementWalletTransport(harness.capability.profile(harness.origin));
  const seller=await createEphemeralPackagedSeller({rpcUrl:`${harness.origin}/portal/api/devnet-native-wallet-rpc`,network:'demos-devnet',transactionTransport:walletTransport});t.after(()=>seller.close());
  const journal=openDurableWalletJournal({path:join(directory,'artifacts.sqlite'),mode:'create'});t.after(()=>journal.close());
  const operatorSigner={claim:seller.signer.claim,sign:bytes=>seller.signer.signBytes(bytes)};
  const makeAnchor=(withSigner)=>createDevnetDemoArtifactAnchor({sourceCapability:harness.capability,journal,walletFactory:seller.walletFactory,network:'demos-devnet',buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true}),...(withSigner?{signer:operatorSigner}:{})});
  let anchor=makeAnchor(signer);
  const jobId=generateCanonicalJobId();
  let artifact=await signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:'retained-report',version:1,contentHash:'c'.repeat(64)},parties:[`did:demos:agent:${'52'.repeat(32)}`,seller.signer.claim],pattern:'fixed-price',createdAt:1770000000200},
    FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:seller.signer.claim,sign:bytes=>seller.signer.signBytes(bytes)});
  let logicalAddress=finalityCommitmentAddress(jobId);
  if(kind==='Listing'){artifact=fixtureListing(seller.signer);logicalAddress=listingAddress(seller.signer.claim,artifact.listingId,artifact.listingVersion);}
  if(kind==='SettlementEvidence' || kind==='payment-evidence') {
    const unsigned=kind==='SettlementEvidence'?{evidenceVersion:'1',jobId,phase:'deliver-storage-program',outcome:'success',dacsSdkAuditSourceHash:'d'.repeat(64),deliverableContentHash:'e'.repeat(64),deliverableAnchor:{kind:'storage-program',locator:`dacs4:deliverable:${jobId}`},observedAt:Date.now()}
      :{evidenceVersion:'1',jobId,phase:'pay-dem',outcome:'success',paymentTxRefs:[{kind:'demos',txHash:'f'.repeat(64),blockNumber:1}],paymentAmount:{amount:'1',currency:'DEM'},settlementFinality:{model:'bft-final',finalityObservedAt:1770000000200},observedAt:1770000000200};
    artifact=await signComponentArtifact(unsigned,ARTIFACT_SEPARATORS.SettlementEvidence,{algorithm:'ed25519',signer:seller.signer.claim,sign:bytes=>seller.signer.signBytes(bytes)});
    logicalAddress=kind==='SettlementEvidence'?`dacs4:evidence:${jobId}`:paymentEvidenceAddress(jobId,'demos-native:DEM',2);
  }
  const input={logicalAddress,artifact,writer:seller.signer.claim,artifactKind:kind==='payment-evidence'?'SettlementEvidence':kind};
  const bridge=kind==='payment-evidence'?createDemosSr2WalletBridge({rpcUrl:harness.capability.pins.endpoint,network:'demos-devnet',journal,walletFactory:seller.walletFactory,sourceCapability:harness.capability,signer:operatorSigner}):null;
  return {harness,seller,broadcasts,confirms,input,publish:()=>bridge?bridge.anchor(input):anchor.publish(input),read:()=>bridge?bridge.resume(input):anchor.read({...input,fresh:true}),
    record:()=>source.get(`devnet/native-transfer/${hash}`),confirmation:()=>recoveryConfirmation,
    async clearSubmissionProfile(profile){for(const [key,row] of await source.entries()){if(row.hash===hash){if(profile)row.storageWriteSubmissionProfile=profile;else delete row.storageWriteSubmissionProfile;await source.put(key,row);}}},
    async restart(){await harness.capability.close();source.close();source=openDurableWalletJournal({path,mode:'open'});await harness.restartSource(source);anchor=makeAnchor(true);}};
}

test('accepted then absent with an unused nonce resends identical bytes once, never signs another CREATE',async t=>{
  const f=await fixture(t);const result=await f.publish();
  assert.equal(result.status,'present',JSON.stringify(result));
  assert.equal(f.broadcasts.length,2);assert.equal(f.broadcasts[0],f.broadcasts[1]);
  assert.deepEqual(f.confirms,[f.broadcasts[0],f.broadcasts[0]],'fresh confirmation retains every signed byte');
  assert.equal(f.seller.approvals.length,1,'one wallet approval/signing request');
  assert.equal((await f.record()).storageWriteResends,1);
  assert.equal(result.receipt.transactionRef.value,JSON.parse(f.broadcasts[0]).hash);
  assert.equal((await f.read()).status,'present');assert.equal(f.broadcasts.length,2);
});

for(const mode of ['consumed','found','ambiguous-status','ambiguous-hash','ambiguous-nonce','changed-fee','nonce-changed','unclassified','null-submission','empty-submission','missing-hash','custom-charges','confirmation-field']) {
  test(`${mode}: retained accepted CREATE is never replaced or resent`,async t=>{
    const f=await fixture(t,{mode});const result=await f.publish();
    assert.equal(result.status,mode==='found'?'present':'indeterminate',JSON.stringify(result));
    assert.equal(f.broadcasts.length,1);assert.equal(f.seller.approvals.length,1);
    assert.ok(f.confirms.every(tx=>tx===f.broadcasts[0]),'only the original signed bytes can be confirmed');
    assert.equal((await f.record()).storageWriteSubmission,['unclassified','null-submission','empty-submission','missing-hash'].includes(mode)?'unknown':'accepted');
    assert.equal((await f.record()).storageWriteResends,undefined);
  });
}

for(const kind of ['Listing','SettlementEvidence','payment-evidence']) {
  test(`accepted absent ${kind} recovers through its operator path with one identical resend`,async t=>{
    const f=await fixture(t,{kind});const result=await f.publish();
    assert.equal(result.status,kind==='payment-evidence'?'native-read-visible':'present',JSON.stringify(result));
    assert.equal(f.broadcasts.length,2);assert.equal(f.broadcasts[0],f.broadcasts[1]);
    assert.equal(f.seller.approvals.length,1);assert.equal((await f.record()).storageWriteResends,1);
  });
}

test('signed bytes and the sole resend allowance survive a source restart',async t=>{
  const f=await fixture(t,{mode:'always-lost',signer:false});
  assert.equal((await f.publish()).status,'indeterminate');assert.equal(f.broadcasts.length,1);
  const retained=JSON.stringify((await f.record()).signedTransaction);
  await f.restart();assert.equal((await f.read()).status,'indeterminate');
  assert.deepEqual(f.broadcasts,[retained,retained]);assert.equal(f.seller.approvals.length,1);
  await f.restart();assert.equal((await f.read()).status,'indeterminate');assert.equal(f.broadcasts.length,2);
  assert.equal((await f.record()).storageWriteResends,1);
});

test('storage submission classification and absence fail closed on conflicting or ambiguous RPC replies',()=>{
  const hash='a'.repeat(64);
  assert.equal(classifyStorageWriteSubmission(envelope({hash}),hash),'accepted');
  for(const answer of [envelope({hash:'b'.repeat(64)}),envelope({txHash:'b'.repeat(64)}),envelope({success:false}),envelope({error:'failed'}),{result:500},{}]) {
    assert.equal(classifyStorageWriteSubmission(answer,hash),'unknown');
  }
  assert.equal(storageWriteAbsent(statusEnvelope({state:'unknown'}),missingTransaction()),true);
  for(const [status,tx] of [[statusEnvelope({state:'failed'}),missingTransaction()],[statusEnvelope({state:'unknown'}),envelope({hash})],[statusEnvelope({state:'unknown'}),{result:400,response:'error',require_reply:false,extra:{message:'database error'}}],[{result:500},missingTransaction()]]) {
    assert.equal(storageWriteAbsent(status,tx),false);
  }
});

// Node 61b8e75 endpointExecution.ts:379 and manageExecution.ts:102.
test('storage acceptance requires an echoed hash or the exact successful validator relay envelope',()=>{
  const hash='a'.repeat(64);
  const relayed={result:200,response:{message:'Transaction relayed to validators'},require_reply:false,extra:{confirmationBlock:2}};
  assert.equal(classifyStorageWriteSubmission(relayed,hash),'accepted');
  for(const response of [null,{}, {message:'unexpected success'}, {hash:'b'.repeat(64)}, {hash,txHash:'b'.repeat(64)}]) {
    assert.equal(classifyStorageWriteSubmission(envelope(response),hash),'unknown');
  }
  for(const answer of [{...relayed,response:null},{...relayed,extra:null},{...relayed,extra:{confirmationBlock:2,error:'failed'}},{...relayed,extra:{confirmationBlock:'2'}},{...relayed,require_reply:true},{...relayed,response:{message:'Transaction held for relay to the next shard'}}]) {
    assert.equal(classifyStorageWriteSubmission(answer,hash),'unknown');
  }
  assert.equal(classifyStorageWriteSubmission(envelope({hash}),hash),'accepted');
  assert.equal(classifyStorageWriteSubmission(envelope({txHash:hash}),hash),'accepted');
});

test('legacy accepted records without strict submission classification stay held after restart',async t=>{
  const f=await fixture(t,{mode:'always-lost',signer:false});
  assert.equal((await f.publish()).status,'indeterminate');
  await f.clearSubmissionProfile();await f.restart();
  assert.equal((await f.read()).status,'indeterminate');
  assert.equal(f.broadcasts.length,1,'legacy acceptance cannot authorize recovery');
  assert.equal(f.seller.approvals.length,1);
  assert.equal((await f.record()).storageWriteResends,undefined);
});

for(const kind of ['relay','hash']) {
  test(`${kind} broadcast rejects contradictory or unexpected RPC envelope fields`,()=>{
    const hash='a'.repeat(64);
    const reply=kind==='hash'?envelope({hash}):{result:200,response:{message:'Transaction relayed to validators'},require_reply:false,extra:{confirmationBlock:2}};
    assert.equal(classifyStorageWriteSubmission(reply,hash),'accepted');
    for(const change of [{error:'rejected'},{success:false},{unexpected:true},{require_reply:true},{require_reply:null},{extra:'diagnostic'},{extra:{}},{result:400}]) {
      assert.equal(classifyStorageWriteSubmission({...reply,...change},hash),'unknown',JSON.stringify(change));
    }
    for(const key of Object.keys(reply)){const missing={...reply};delete missing[key];assert.equal(classifyStorageWriteSubmission(missing,hash),'unknown',key);}
  });
}

for(const kind of ['status','transaction']) {
  test(`${kind} absence read rejects contradictory or unexpected RPC envelope fields`,()=>{
    const status=statusEnvelope({state:'unknown'}),transaction=missingTransaction();
    assert.equal(storageWriteAbsent(status,transaction),true);
    for(const change of [{error:'backend failure'},{success:false},{unexpected:true},{require_reply:true},{require_reply:null},{extra:'diagnostic'},{extra:{}},{result:500}]) {
      assert.equal(storageWriteAbsent(kind==='status'?{...status,...change}:status,kind==='transaction'?{...transaction,...change}:transaction),false,JSON.stringify(change));
    }
    for(const key of Object.keys(status)){const missing={...(kind==='status'?status:transaction)};delete missing[key];assert.equal(storageWriteAbsent(kind==='status'?missing:status,kind==='transaction'?missing:transaction),false,key);}
  });
}

test('contradictory success flags and backend errors cannot prove storage absence',()=>{
  assert.equal(storageWriteAbsent({...statusEnvelope({state:'unknown'}),success:false},{...missingTransaction(),error:'backend failure'}),false);
});

test('accepted v1 submission profiles cannot authorize recovery after restart',async t=>{
  const f=await fixture(t,{mode:'always-lost',signer:false});
  assert.equal((await f.publish()).status,'indeterminate');
  await f.clearSubmissionProfile('hash-or-validator-relay/v1');await f.restart();
  assert.equal((await f.read()).status,'indeterminate');
  assert.equal(f.broadcasts.length,1);assert.equal(f.seller.approvals.length,1);
  assert.equal((await f.record()).storageWriteResends,undefined);
});

test('omitted initial confirmation gas survives retention and a full recovery confirmation reaches broadcast',async t=>{
  const f=await fixture(t,{mode:'omitted-gas'});
  assert.equal((await f.publish()).status,'present');
  assert.equal(f.broadcasts.length,2);assert.equal(f.broadcasts[0],f.broadcasts[1]);
  assert.equal((await f.record()).storageWriteGas,null);
  assert.equal(f.seller.approvals.length,1);
});

for(const change of [{accepted:false},{status:'rejected'},{unexpected:true}]){
  test(`hash-echo payload rejects ${Object.keys(change)[0]}`,()=>{
    const hash='a'.repeat(64);
    assert.equal(classifyStorageWriteSubmission(envelope({hash,...change}),hash),'unknown');
    for(const response of [{hash},{txHash:hash},{hash,txHash:hash}])assert.equal(classifyStorageWriteSubmission(envelope(response),hash),'accepted');
  });
}

for(const mode of ['nonce-success-false','nonce-error','nonce-missing-key','nonce-extra-key']){
  for(const nonceFaultAt of [1,2,3]){
    test(`${mode} at recovery nonce check ${nonceFaultAt} cannot authorize broadcast`,async t=>{
      const f=await fixture(t,{mode,nonceFaultAt});
      assert.equal((await f.publish()).status,'indeterminate');
      assert.equal(f.broadcasts.length,1);assert.equal(f.seller.approvals.length,1);
      assert.ok(f.confirms.every(tx=>tx===f.broadcasts[0]));
      assert.equal((await f.record()).storageWriteResends,nonceFaultAt===3?1:undefined);
    });
  }
}

test('accepted v2 submission profiles cannot authorize recovery after restart',async t=>{
  const f=await fixture(t,{mode:'always-lost',signer:false});
  assert.equal((await f.publish()).status,'indeterminate');
  await f.clearSubmissionProfile('hash-or-validator-relay/v2');await f.restart();
  assert.equal((await f.read()).status,'indeterminate');
  assert.equal(f.broadcasts.length,1);assert.equal(f.seller.approvals.length,1);
  assert.equal((await f.record()).storageWriteResends,undefined);
});

for(const kind of ['confirm','block']){
  for(const fault of ['error','success-false','missing-key','extra-key','require-reply','extra-value']){
    test(`${kind} recovery envelope rejects ${fault} before reserving or broadcasting`,async t=>{
      const f=await fixture(t,{mode:`${kind}-envelope-${fault}`});
      assert.equal((await f.publish()).status,'indeterminate');
      assert.equal(f.broadcasts.length,1);assert.equal(f.seller.approvals.length,1);
      assert.ok(f.confirms.every(tx=>tx===f.broadcasts[0]));
      assert.equal((await f.record()).storageWriteResends,undefined);
    });
  }
}

for(const fault of ['error','success-false','extra-key','signature-missing','signature-malformed','signature-null','rpc-key-missing','rpc-key-malformed','rpc-key-null']){
  test(`confirmation response rejects ${fault} before reserving or broadcasting`,async t=>{
    const f=await fixture(t,{mode:`confirm-response-${fault}`});
    assert.equal((await f.publish()).status,'indeterminate');
    assert.equal(f.broadcasts.length,1);assert.equal(f.seller.approvals.length,1);
    assert.ok(f.confirms.every(tx=>tx===f.broadcasts[0]));
    assert.equal((await f.record()).storageWriteResends,undefined);
  });
}

for(const fault of ['error','success-false','extra-key']){
  test(`identity response rejects ${fault} before reserving or broadcasting`,async t=>{
    const f=await fixture(t,{mode:`identity-response-${fault}`});
    assert.equal((await f.publish()).status,'indeterminate');
    assert.equal(f.broadcasts.length,1);assert.equal(f.seller.approvals.length,1);
    assert.ok(f.confirms.every(tx=>tx===f.broadcasts[0]));
    assert.equal((await f.record()).storageWriteResends,undefined);
  });
}

for(const fault of Object.keys(confirmationDataFaults)){
  test(`confirmation data rejects ${fault} before reserving or broadcasting`,async t=>{
    const f=await fixture(t,{mode:`confirm-data-${fault}`});
    assert.equal((await f.publish()).status,'indeterminate');
    assert.equal(f.broadcasts.length,1);assert.equal(f.seller.approvals.length,1);
    assert.ok(f.confirms.every(tx=>tx===f.broadcasts[0]));
    const record=await f.record();
    assert.equal(record.storageWriteGas,null);
    assert.equal(record.storageWriteResends,undefined);
    assert.equal(storageWriteConfirmationMatches(f.confirmation()),false);
  });
}

test('successful null hash lookup cannot prove storage absence',()=>{
  const status=statusEnvelope({state:'unknown'});
  assert.equal(storageWriteAbsent(status,missingTransaction()),true);
  assert.equal(storageWriteAbsent(status,envelope(null)),false);
});

test('successful null hash lookup cannot authorize a storage resend',async t=>{
  const f=await fixture(t,{mode:'null-hash'});
  assert.equal((await f.publish()).status,'indeterminate');
  assert.equal(f.broadcasts.length,1);assert.equal(f.seller.approvals.length,1);
  assert.equal(f.confirms.length,1);
  assert.equal((await f.record()).storageWriteResends,undefined);
});
