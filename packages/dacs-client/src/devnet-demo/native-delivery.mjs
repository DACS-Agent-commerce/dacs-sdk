import { canonicalize, contentHash } from '@kynesyslabs/dacs';
import { createNativeDemDeliveryCapability } from '../dacs/native-dem-delivery-consumer.mjs';
import { isDevnetPurchasedReport } from './deliverable.mjs';

export function createDevnetDemoDeliveryCapability({authority,anchor,deliveryEvidenceEnabled=false}) {
  if(anchor?.authority!==authority || typeof anchor.publish!=='function' || typeof anchor.read!=='function' || typeof anchor.verifyReceipt!=='function') throw new TypeError('the exact seller native artifact anchor is required');
  const expected=(input)=>isDevnetPurchasedReport(input.report,{jobId:input.jobId ?? input.report?.jobId,agreementHash:input.deliveryBinding?.agreementHash,producer:anchor.writer})
    && input.logicalAddress===`dacs4:deliverable:${input.report.jobId}` && input.receiptContentHash===contentHash(input.report);
  const read=async(input)=>{
    if(!expected(input)) return {status:'rejected',reason:'native purchased report scope differs'};
    const value=await anchor.read({logicalAddress:input.logicalAddress,artifact:input.report,artifactKind:'Deliverable',deliveryBinding:input.deliveryBinding});
    return value.status==='present' ? {...value,status:'present'} : value;
  };
  const capability=createNativeDemDeliveryCapability({authority,
    submit:async(input)=>{
      if(!expected(input)) return {status:'rejected',reason:'native purchased report scope differs'};
      const value=await anchor.publish({logicalAddress:input.logicalAddress,artifact:input.report,artifactKind:'Deliverable',deliveryBinding:input.deliveryBinding});
      return value.status==='present' ? {status:'accepted',reconciliationId:value.receipt.transactionRef.value} : {status:value.status==='rejected'?'rejected':'indeterminate',reason:value.reason};
    },
    reconcile:async(input)=>{
      const value=await read(input);
      return value.status==='present' ? {status:'complete',reconciliationId:value.receipt.transactionRef.value,observedAt:value.receipt.blockRef.timestamp} : {status:value.status==='absent'?'absent':'indeterminate',reason:value.reason};
    },
    read,
    verifyReceipt:async(input)=>{
      if(!expected(input)) return 'invalid';
      return anchor.verifyReceipt({logicalAddress:input.logicalAddress,artifact:input.report,artifactKind:'Deliverable',receipt:input.receipt,signedProjection:input.signedProjection,deliveryBinding:input.deliveryBinding});
    },
  });
  return capability;
}
