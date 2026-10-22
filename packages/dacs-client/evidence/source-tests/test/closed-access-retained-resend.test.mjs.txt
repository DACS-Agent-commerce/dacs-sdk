import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, contentHash, finalityCommitmentAddress, generateCanonicalJobId, sha256Hex, signComponentArtifact, FINALITY_COMMITMENT_SEPARATOR } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionTransport } from './helpers/devnet-live-composition-transport.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { createDevnetDemoArtifactAnchor } from '../src/devnet-demo/artifact-anchor.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import * as buyerAccessModule from '../src/devnet-demo/buyer-access.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

const envelope=response=>({result:200,response,require_reply:false,extra:null});
const statusEnvelope=response=>({...envelope(response),extra:''});
const custodyWallet=`0x${'2'.repeat(64)}`,custodyBuyer=`did:demos:agent:${'2'.repeat(64)}`,foreignWallet=`0x${'52'.repeat(32)}`;
const closed=error=>error.code==='buyer_access_closed';

// the source change's lost-once fixture: the first seller CREATE is answered as relayed but
// never applied; later broadcasts reach the owned loopback chain.
async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'closed-resend-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const source=openDurableWalletJournal({path:join(directory,'source.sqlite'),mode:'create'});t.after(()=>source.close());
  const broadcasts=[];let hash;
  const harness=await startDevnetLiveCompositionTransport({sourceJournal:source,transportOptions:{inclusionWaitMs:0},rpcResponse:async(body,headers)=>{
    const call=body.params?.[0];
    const forward=()=>fetch(`${harness.chain.url}/`,{method:'POST',headers:{'content-type':'application/json',identity:headers.identity,signature:headers.signature,timestamp:headers.timestamp},body:JSON.stringify(body)}).then(response=>response.json());
    if(call?.extra==='confirmTx'){const answer=await forward();return {...answer,response:{data:{reference_block:0,message:'[Tx Validation] Transaction signature verified\n',...answer.response.data},signature:{type:'ed25519',data:'0x'+'11'.repeat(64)},rpc_public_key:{type:'ed25519',data:'0x'+'22'.repeat(32)}}};}
    if(call?.extra==='broadcastTx'){const tx=call.data.response.data.transaction;hash=tx.hash;broadcasts.push(JSON.stringify(tx));if(broadcasts.length===1)return {result:200,response:{message:'Transaction relayed to validators'},require_reply:false,extra:{confirmationBlock:2}};}
    const lost=hash&&harness.chain.wire.record.accepted.length===0;
    if(call?.message==='getBlockByNumber'&&call.data.blockNumber===0){const answer=await fetch(`${harness.chain.url}/`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(response=>response.json());answer.extra='';return answer;}
    if(lost&&call?.message==='getTransactionStatus')return statusEnvelope({state:'unknown'});
    if(lost&&call?.message==='getTxByHash')return {result:400,response:'error',require_reply:false,extra:null};
    if(lost&&call?.message==='getAddressNonce')return envelope(0);
  }});t.after(()=>harness.close());
  globalThis.location=new URL(harness.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${harness.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const seller=await createEphemeralPackagedSeller({rpcUrl:`${harness.origin}/portal/api/devnet-native-wallet-rpc`,network:'demos-devnet',transactionTransport:createDevnetAgreementWalletTransport(harness.capability.profile(harness.origin))});t.after(()=>seller.close());
  const journal=openDurableWalletJournal({path:join(directory,'artifacts.sqlite'),mode:'create'});t.after(()=>journal.close());
  const signer={claim:seller.signer.claim,sign:bytes=>seller.signer.signBytes(bytes)};
  const commitment=async(jobId)=>({logicalAddress:finalityCommitmentAddress(jobId),artifactKind:'FinalityCommitmentRecord',artifact:await signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),
    listingRef:{listingId:'closed-resend-report',version:1,contentHash:'c'.repeat(64)},parties:[`did:demos:agent:${'52'.repeat(32)}`,seller.signer.claim],pattern:'fixed-price',createdAt:1770000000200},
    FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:seller.signer.claim,sign:bytes=>seller.signer.signBytes(bytes)})});
  const foreignJob=generateCanonicalJobId(),foreign=await commitment(foreignJob);
  const anchor=(buyerAccess,withSigner=true)=>createDevnetDemoArtifactAnchor({sourceCapability:harness.capability,journal,walletFactory:seller.walletFactory,network:'demos-devnet',buyerAccess,...(withSigner?{signer}:{})});
  // While access is open, the foreign job's CREATE is approved, signed and
  // accepted, then lost. Without the operator signer nothing is resent yet.
  assert.equal((await anchor(createOperatorBuyerAccess({openBuyerAccess:true}),false).publish(foreign)).status,'indeterminate');
  assert.equal(broadcasts.length,1);assert.equal(seller.approvals.length,1);
  const record=()=>source.get(`devnet/native-transfer/${JSON.parse(broadcasts[0]).hash}`);
  assert.equal((await record()).storageWriteSubmission,'accepted');
  // Access closes: only the custody buyer's jobs are admitted from here on.
  const closedAccess=createOperatorBuyerAccess({custodyBuyer,buyerForJob:job=>job===foreignJob?foreignWallet:custodyWallet});
  return {harness,source,journal,seller,broadcasts,foreignJob,foreign,commitment,record,closedAccess,closedAnchor:anchor(closedAccess)};
}

const captureStderr=(t)=>{
  const lines=[],write=process.stderr.write;
  process.stderr.write=function(chunk,...rest){if(String(chunk).startsWith('closed-access-19-resend'))lines.push(String(chunk));return write.call(this,chunk,...rest);};
  t.after(()=>{process.stderr.write=write;});return lines;
};

test('a retained foreign intent is refused before any source read or recovery on publish, read and readRetained',{timeout:300000},async t=>{
  const f=await fixture(t),reads=f.harness.requests.length;
  await assert.rejects(f.closedAnchor.publish(f.foreign),closed);
  await assert.rejects(f.closedAnchor.read({...f.foreign,fresh:true}),closed);
  await assert.rejects(f.closedAnchor.readRetained({logicalAddress:f.foreign.logicalAddress,artifactKind:f.foreign.artifactKind,fresh:true}),closed);
  assert.equal(f.harness.requests.length,reads,'no source read');
  assert.equal(f.broadcasts.length,1,'no resend');assert.equal(f.seller.approvals.length,1);
  assert.equal((await f.record()).storageWriteResends,undefined);
});

// The anchor authorizes a retained row by its own signed transaction's job, never
// by the caller's input: a row filed under a custody job's input whose signed
// bytes are the foreign job's is refused before any read, approval or resend.
test('a retained foreign intent filed under a custody job\'s input is refused by its own signed job',{timeout:300000},async t=>{
  const f=await fixture(t),custody=await f.commitment(generateCanonicalJobId()),claim=f.seller.signer.claim;
  const exactHash=(value)=>sha256Hex(canonicalize(value));
  const keyFor=(logicalAddress)=>`demo/artifact/${exactHash(['demos-devnet',f.harness.capability.pins.chainIdentity,claim,logicalAddress])}`;
  const foreignRow=await f.journal.get(keyFor(f.foreign.logicalAddress));
  assert.equal(foreignRow.transaction.content.data[1].metadata.artifactBinding.jobId,f.foreignJob);
  const input={logicalAddress:custody.logicalAddress,artifact:JSON.parse(canonicalize(custody.artifact)),artifactKind:custody.artifactKind,writer:claim,receiptContentHash:contentHash(custody.artifact)};
  await f.journal.put(keyFor(custody.logicalAddress),{...foreignRow,inputHash:exactHash(input),input});
  const reads=f.harness.requests.length;
  await assert.rejects(f.closedAnchor.publish(custody),closed);
  assert.equal(f.harness.requests.length,reads,'no source read');
  assert.equal(f.broadcasts.length,1,'no resend');assert.equal(f.seller.approvals.length,1);
});

// The code review's probe, pinned as the named closed-access-19-resend exception.
test('closed-access-19-resend: a custody write completes a foreign accepted-but-missing write with exactly one unchanged resend',{timeout:300000},async t=>{
  const lines=captureStderr(t),f=await fixture(t),foreignHash=JSON.parse(f.broadcasts[0]).hash;
  // The operator's wiring (operator.mjs): the source reports each resend and
  // the closed-access log labels it by the resent bytes' own job.
  const notices=[],stopNotices=f.harness.capability.onStorageWriteResend(notice=>notices.push({...notice,locks:f.source.inspectLocks().map(lock=>lock.key)}));
  const stopLog=f.harness.capability.onStorageWriteResend(buyerAccessModule.crossJobResendLog(f.closedAccess));t.after(()=>{stopNotices();stopLog();});
  const custody=await f.commitment(generateCanonicalJobId());
  assert.equal((await f.closedAnchor.publish(custody)).status,'present');
  assert.equal(f.broadcasts.length,3);assert.equal(f.broadcasts[1],f.broadcasts[0],'the foreign bytes are resent unchanged');
  assert.notEqual(JSON.parse(f.broadcasts[2]).hash,foreignHash);
  assert.equal(f.seller.approvals.length,2,'one approval before closure (foreign) and one after (custody); none new for the foreign job');
  assert.deepEqual(f.harness.chain.wire.record.accepted.map(tx=>tx.content.data[1].data.jobId),[f.foreignJob,custody.artifact.jobId]);
  assert.equal((await f.record()).storageWriteResends,1);
  assert.equal(lines.length,1);
  assert.match(lines[0],new RegExp(`^closed-access-19-resend: job ${f.foreignJob} tx ${foreignHash}: [^\\n]*outside closed access; no new transaction signature, approval or nonce\\n$`));
  // Reported once, with the resent bytes' own job, while the seller lane's lock is held.
  assert.deepEqual(notices.map(({hash,jobId,artifactKind})=>({hash,jobId,artifactKind})),[{hash:foreignHash,jobId:f.foreignJob,artifactKind:'FinalityCommitmentRecord'}]);
  assert.ok(notices[0].locks.some(key=>key.startsWith('devnet/native-wallet/')&&key.includes(f.seller.signer.address)),JSON.stringify(notices[0].locks));
  // At most once: a later custody write neither resends nor logs again.
  assert.equal((await f.closedAnchor.publish(await f.commitment(generateCanonicalJobId()))).status,'present');
  assert.equal(f.broadcasts.length,4);assert.equal(f.broadcasts.filter(tx=>tx===f.broadcasts[0]).length,2);
  assert.equal(f.seller.approvals.length,3);assert.equal(lines.length,1);assert.equal(notices.length,1);
});
