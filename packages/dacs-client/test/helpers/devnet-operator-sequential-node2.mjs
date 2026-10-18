import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOperatorRecoveryNode2 } from './devnet-operator-recovery-node2.mjs';

const HASH=/^[0-9a-f]{64}$/;
const CLAIM=/^did:demos:agent:[0-9a-f]{64}$/;

export function exactSequentialApprovals(){
  const seller=[],buyer=[];
  return{
    seller,buyer,
    authorizeSellerApproval:({approvalHash,request})=>{
      assert.match(approvalHash,HASH);assert.equal(request.method,'sendTransaction');assert.equal(request.content.action,'immutable DACS storage anchor CREATE');
      assert.ok(['Listing','CompositeVerificationRecord','FinalityCommitmentRecord','SettlementEvidence','Deliverable'].includes(request.content.artifactKind));
      assert.ok(BigInt(request.content.debit.totalOs)<=10000000000n);seller.push(structuredClone(request));
      return request.address===request.content.wallet&&request.content.network==='demos-devnet';
    },
    authorizeBuyerApproval:({approvalHash,requestHash,request,scope})=>{
      assert.match(approvalHash,HASH);assert.match(requestHash,HASH);assert.match(scope.buyer,CLAIM);assert.match(scope.seller,CLAIM);
      assert.equal(scope.listingId,'operator-recovery-report');assert.equal(scope.listingVersion,1);assert.match(scope.listingContentHash,HASH);assert.equal(scope.purpose,scope.kind);
      if(scope.kind!=='oauth-wallet-login'){assert.ok(scope.jobId);if(['broker-authentication','agreement-signature','payment-terms','agreement-create','native-payment'].includes(scope.kind))assert.match(scope.agreementHash,HASH);}
      if(request.method==='sendTransaction'){
        assert.ok(BigInt(request.content.debit.totalOs)<=12000000000n);assert.equal(scope.displayPurpose,request.purpose);assert.equal(request.content.network,'demos-devnet');assert.match(request.content.networkBinding.chainIdentity,HASH);
        if(scope.kind==='native-payment'){assert.equal(request.content.action,'native DEM transfer');assert.equal(scope.amountOs,'1000000000');assert.equal(request.content.amountOs,scope.amountOs);assert.equal(request.content.to,scope.payee);}
        else{assert.equal(scope.kind,'agreement-create');assert.equal(request.content.artifactKind,'Agreement');assert.equal(request.content.jobId,scope.jobId);assert.equal(request.content.contentHash,scope.agreementHash);}
      }else{assert.equal(request.method,'sign');assert.ok(request.message);}
      buyer.push({request:structuredClone(request),scope:structuredClone(scope)});return true;
    },
  };
}

export async function createSequentialOperatorNode2(approvals){
  const harness=await createOperatorRecoveryNode2(approvals),sourceFetch=harness.node2.fetchImpl;
  let armed=false,unavailable=false;
  harness.node2.fetchImpl=async(url,options)=>{
    const body=typeof options?.body==='string'?options.body:'';
    let call=null;try{call=JSON.parse(body)?.params?.[0]??null;}catch{}
    if(unavailable&&['getTransactionStatus','getTxByHash','getStorageProgram','getBlockByNumber'].includes(call?.message))throw new Error('TEST exact seller source readback unavailable');
    const response=await sourceFetch(url,options);
    const broadcastKind=call?.extra==='broadcastTx'?call.data?.response?.data?.transaction?.content?.data?.[1]?.metadata?.artifactKind:null;
    if(armed&&broadcastKind==='SettlementEvidence'){armed=false;unavailable=true;}
    return response;
  };
  return Object.freeze({
    root:harness.root,node2:harness.node2,config:harness.config,configPath:harness.configPath,fetchImpl:harness.fetchImpl,
    start:()=>harness.start(),stop:()=>harness.stop(),restart:()=>harness.restart(),close:()=>harness.close(),
    loseNextAppliedReportResponse:()=>harness.loseNextAppliedReportResponse(),
    async readBuyerReceipt(idempotencyKey){
      const runKey=createHash('sha256').update(`dacs-node2-operator-buyer-run\0${idempotencyKey}`).digest('hex');
      return JSON.parse(await readFile(join(harness.root,'state','buyer-runs',`${runKey}.receipt.json`),'utf8'));
    },
    makeNextSettlementReadbackUnavailable(){armed=true;unavailable=false;},
    restoreSourceReadback(){armed=false;unavailable=false;},
    get sourceReadbackUnavailable(){return unavailable;},get settlementReadbackArmed(){return armed;},get droppedReports(){return harness.droppedReports;},get operator(){return harness.operator;},
    get composition(){return harness.composition;},get application(){return harness.application;},get prepared(){return harness.prepared;},
  });
}
export const effectCounts=(h)=>({creates:h.node2.chain.wire.record.accepted.length,payments:h.node2.chain.record.accepted.length});
export const transactionApprovalCount=(entries)=>entries.filter((entry)=>entry.request.method==='sendTransaction').length;
