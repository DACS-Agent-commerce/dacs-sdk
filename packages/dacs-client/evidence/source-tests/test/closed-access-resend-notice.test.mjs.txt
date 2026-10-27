// The closed-access-19-resend notice: reported under the seller lane's lock,
// and no listener (sync or async) can interrupt or change the one resend.
// Offline: injected Node2 stub whose dispatch answers without I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalityCommitmentAddress, generateCanonicalJobId, signComponentArtifact, FINALITY_COMMITMENT_SEPARATOR, logicalToStorageProgramName, contentHash } from '@kynesyslabs/dacs';
import { admittedTransport, blockZeroAdmission, zeroBlock, NOW, json, memoryJournal, sha } from './helpers/review-node2-current-coverage-fixture.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { STORAGE_WRITE_SUBMISSION_PROFILE } from '../src/devnet-demo/storage-write-recovery.mjs';
import { DEVNET_DEMO_ARTIFACT_POLICY } from '../src/wallet/devnet-native-transport.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';

// One retained accepted-but-missing operator CREATE, ready for the source change's resend.
async function retainedLostWrite(){
  const w=createEphemeralWallet(),buyer=createEphemeralWallet(),jobId=generateCanonicalJobId(),logicalAddress=finalityCommitmentAddress(jobId);
  const artifact=await signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:'notice-review',version:1,contentHash:'b'.repeat(64)},parties:[buyer.claim,w.claim],pattern:'fixed-price',createdAt:NOW},FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:w.claim,sign:(bytes)=>w.signBytes(bytes)});
  const journal=memoryJournal(),lock=journal.withWalletLock,state={underLock:false,broadcasts:0,tx:null};
  journal.withWalletLock=async(key,work)=>lock(key,async()=>{state.underLock=true;try{return await work();}finally{state.underLock=false;}});
  const run=admittedTransport(await blockZeroAdmission(),{
    0:{...zeroBlock(),require_reply:false,extra:''},
    getAddressNonce:{result:200,response:0,require_reply:false,extra:null},
    getTransactionStatus:{result:200,response:{state:'unknown'},require_reply:false,extra:''},
    getTxByHash:{result:400,response:'error',require_reply:false,extra:null},
    'GET /':(entry)=>{
      if(entry.message==='broadcastTx'){state.broadcasts++;return json({result:200,response:{hash:state.tx.hash},require_reply:false,extra:null});}
      return json({result:200,response:{data:{valid:true,reference_block:0,message:'[Tx Validation] Transaction signature verified\n',gas_operation:null,transaction:state.tx},signature:{type:'ed25519',data:'0x'+'11'.repeat(64)},rpc_public_key:{type:'ed25519',data:'0x'+'22'.repeat(32)}},require_reply:false,extra:null});
    },
  },{journal});
  const {binding}=await run.capability.binding({phase:'bind',address:w.address});
  const programName=logicalToStorageProgramName(logicalAddress),storageAddress=deriveStorageAddress(w.address,programName,1,'');
  const tx=buildStorageProgramCreatePayload({from:w.address,storageAddress,programName,logicalAddress,signedListing:artifact,nonce:1,timestamp:NOW});
  tx.content.network=run.capability.pins.network;tx.content.chainIdentity=run.capability.pins.chainIdentity;
  Object.assign(tx.content.data[1].metadata,{artifactKind:'FinalityCommitmentRecord',contentHash:contentHash(artifact),networkBinding:structuredClone(run.capability.transportBinding),
    artifactBinding:{version:'1',policy:DEVNET_DEMO_ARTIFACT_POLICY,authority:run.capability.demoArtifactPublication.authority,artifactKind:'FinalityCommitmentRecord',jobId,logicalAddress,writer:w.claim}});
  tx.hash=sha(JSON.stringify(tx.content));tx.signature={type:'ed25519',data:w.signHex(tx.hash)};state.tx=tx;
  const row={hash:tx.hash,nonce:1,stage:'broadcast-accepted',signedTransaction:structuredClone(tx),networkBinding:binding,storageWriteSubmission:'accepted',storageWriteSubmissionProfile:STORAGE_WRITE_SUBMISSION_PROFILE,storageWriteGas:null};
  const lane=`devnet/native-wallet/${JSON.stringify([binding.network,binding.chainIdentity,w.address])}`;
  journal.seed(lane,row);journal.seed(`devnet/native-transfer/${tx.hash}`,row);
  return {run,journal,lane,state,jobId,recover:()=>run.capability.recoverStorageWrite({signedTransaction:tx,signRpc:(message)=>w.signHex(message)})};
}

// The code review's notice probe (an earlier review): the dispatch resolves without I/O,
// so a notice deferred past the lock would be seen outside it.
test('a resend notice stays under the lane lock even when dispatch resolves without I/O',async()=>{
  const f=await retainedLostWrite(),notices=[];
  f.run.capability.onStorageWriteResend((notice)=>notices.push({...notice,underLock:f.state.underLock}));
  f.run.capability.onStorageWriteResend(()=>{throw new Error('telemetry failed');});
  await f.recover();
  await new Promise((resolve)=>setImmediate(resolve));
  const state=await f.journal.get(f.lane);await f.run.capability.close();
  assert.equal(f.state.broadcasts,1,'the exact recovery reached dispatch');assert.equal(state.storageWriteResends,1);
  assert.deepEqual(notices.map(({jobId,underLock})=>({jobId,underLock})),[{jobId:f.jobId,underLock:true}]);
});

test('an async listener that rejects neither interrupts the resend nor leaves an unhandled rejection',async t=>{
  const unhandled=[],onUnhandled=(reason)=>{unhandled.push(String(reason?.message??reason));};
  process.on('unhandledRejection',onUnhandled);t.after(()=>process.off('unhandledRejection',onUnhandled));
  const f=await retainedLostWrite(),notices=[];
  f.run.capability.onStorageWriteResend(async()=>{throw new Error('async telemetry failed');});
  f.run.capability.onStorageWriteResend((notice)=>notices.push(notice.jobId));
  await f.recover();
  for(let i=0;i<3;i++)await new Promise((resolve)=>setTimeout(resolve,10));
  const state=await f.journal.get(f.lane);await f.run.capability.close();
  assert.equal(f.state.broadcasts,1);assert.equal(state.storageWriteResends,1);assert.equal(state.storageWriteSubmission,'accepted');
  assert.deepEqual(notices,[f.jobId],'the next listener still ran');
  assert.deepEqual(unhandled,[]);
});
