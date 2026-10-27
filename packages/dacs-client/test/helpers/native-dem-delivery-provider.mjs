// TEST-only source-native delivery provider. Seller submission uses the actual
// packaged wallet bridge; every reconciliation/buyer read creates a fresh
// read-only adapter and authenticates the original public signed projection.
import { contentHash } from '@kynesyslabs/dacs';
import { createDemosSr2Adapter,createInMemoryDemosSr2Journal } from '../../src/dacs/demos-sr2-adapter.mjs';
import { isDevnetDeliveryTransport } from '../../src/wallet/devnet-native-transport.mjs';

const clone=(value)=>structuredClone(value);

export function createSourceNativeDeliveryProvider({bridge,sourceCapability,rpcUrl,writer,readSignedProjection}) {
  const source=()=>typeof sourceCapability==='function'?sourceCapability():sourceCapability;
  if (!isDevnetDeliveryTransport(source()) || typeof readSignedProjection!=='function') throw new TypeError('explicit native delivery transport and public projection reader required');
  const reader=()=>createDemosSr2Adapter({rpcUrl,sourceCapability:source(),journal:{...createInMemoryDemosSr2Journal(),put:async()=>{throw new Error('buyer native delivery observer is read-only');}}});
  const bridgeFor=()=>typeof bridge==='function'?bridge():bridge;
  const options=(input,projection)=>({expectedWriter:writer,expectedArtifactKind:'Deliverable',expectedDeliveryBinding:input.deliveryBinding,...(projection?{signedProjection:projection}:{})});
  async function read(input) {
    const projection=await readSignedProjection({logicalAddress:input.logicalAddress,writer});
    if (!projection) return {status:'absent',reason:'original signed Deliverable CREATE projection is unavailable'};
    try {
      const record=await reader().read(input.logicalAddress,options(input,projection));
      if(record.status!=='present')return{status:'absent',reason:'native Deliverable is absent'};
      if(contentHash(record.artifact)!==input.receiptContentHash)return{status:'rejected',reason:'native Deliverable bytes differ'};
      return{status:'present',artifact:clone(record.artifact),receipt:clone(record.receipt),signedProjection:clone(projection),demosEvidence:clone(record.demosEvidence),finality:'not-established'};
    } catch(error){return{status:['invalid','conflict'].includes(error?.code)?'rejected':'indeterminate',reason:String(error?.message??error).slice(0,240),code:error?.code??'native-read-failed'};}
  }
  return {
    async submit(input) {
      const answer=await bridgeFor().anchor({logicalAddress:input.logicalAddress,artifact:input.report,writer,artifactKind:'Deliverable',jobId:input.jobId,
        receiptContentHash:input.receiptContentHash,deliveryBinding:input.deliveryBinding});
      if(answer.status==='native-read-visible')return{status:'accepted',reconciliationId:answer.receipt.transactionRef.value};
      return{status:answer.status==='rejected'?'rejected':'indeterminate',reason:answer.code??'native Deliverable CREATE is not yet readable',...(answer.plan?.transactionHash?{reconciliationId:answer.plan.transactionHash}:{})};
    },
    async reconcile(input) {
      const record=await read(input);
      if(record.status==='present'){
        const observedAt=Number(record.signedProjection.content.timestamp);
        if(!Number.isSafeInteger(observedAt)||observedAt<0)return{status:'indeterminate',reason:'signed Deliverable CREATE timestamp is unavailable'};
        return{status:'complete',reconciliationId:record.receipt.transactionRef.value,observedAt};
      }
      if(record.status==='absent')return{status:'absent',reason:record.reason};
      return{status:record.status==='rejected'?'failed':'indeterminate',reason:record.reason,...(input.reconciliationId?{reconciliationId:input.reconciliationId}:{})};
    },
    read,
    async verifyReceipt(input) {
      const projection=await readSignedProjection({logicalAddress:input.logicalAddress,writer});
      if(!projection)return'indeterminate';
      return reader().verifyReceipt({receipt:input.receipt,logicalAddress:input.logicalAddress,artifact:input.report,expectedWriter:writer,artifactKind:'Deliverable',
        deliveryBinding:input.deliveryBinding,receiptContentHash:input.receiptContentHash,signedProjection:projection});
    },
  };
}
