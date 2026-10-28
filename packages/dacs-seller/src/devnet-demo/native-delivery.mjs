import { canonicalize, contentHash, isCanonicalJobId } from '@kynesyslabs/dacs';
import { createNativeDemDeliveryCapability } from '../dacs/native-dem-delivery-consumer.mjs';
import { isDevnetPurchasedReport } from './deliverable.mjs';

const purchasedReaders=new WeakMap(),evidenceReaders=new WeakMap();
const requireJobId=jobId=>{if(!isCanonicalJobId(jobId))throw new TypeError('jobId must be a canonical uppercase ULID');};
/** True when this capability was built with a delivery-evidence reader. */
export const hasDevnetDeliveryEvidenceReader=(capability)=>evidenceReaders.has(capability);
// Returns the retained SettlementEvidence for jobId; rejects a malformed job
// and refuses a seller other than the anchor writer.
export async function readDevnetDeliveryEvidence(capability,{jobId,seller}){
  requireJobId(jobId);
  const reader=evidenceReaders.get(capability);if(!reader)throw new TypeError('native delivery evidence reader is unavailable');
  return reader({jobId,seller});
}

/** True when this capability has an explicit purchased-report reader. */
export function hasDevnetPurchasedReportReader(capability){return purchasedReaders.has(capability);}
// Returns the retained deliverable only when its fulfilment binding, seller,
// Listing, settlement and content hash all match the supplied scope; rejects a
// malformed job and answers rejected/absent status otherwise.
export async function readDevnetPurchasedReport(capability,input){
  requireJobId(input?.jobId);
  const reader=purchasedReaders.get(capability);
  if(!reader)throw new TypeError('the explicit native purchased-report reader is unavailable');
  return reader(structuredClone(input));
}

// Public contract: requires the seller's exact native artifact anchor (same
// authority; publish/read/readRetained/verifyReceipt), so no copied descriptor
// grants a write. Every callback first re-checks the job, seller, Listing and
// receipt hash against the report; failures return rejected/indeterminate, never
// throw. deliveryEvidenceEnabled adds the optional evidence reader.
export function createDevnetDemoDeliveryCapability({authority,anchor,deliveryEvidenceEnabled=false}) {
  if(anchor?.authority!==authority || typeof anchor.publish!=='function' || typeof anchor.read!=='function' || typeof anchor.readRetained!=='function' || typeof anchor.verifyReceipt!=='function') throw new TypeError('the exact seller native artifact anchor is required');
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
  purchasedReaders.set(capability,async(input)=>{
    if(!isCanonicalJobId(input?.jobId) || input.jobId!==input?.deliveryBinding?.jobId || input.logicalAddress!==`dacs4:deliverable:${input.jobId}` ||
        input.receiptContentHash!==input.deliveryBinding?.payloadHash || input.deliveryBinding?.agreementHash!==input.agreementHash ||
        canonicalize(input.deliveryBinding?.listing)!==canonicalize(input.listing) || input.deliveryBinding?.fulfilmentId!==input.fulfilmentId ||
        input.seller!==anchor.writer) return {status:'rejected',reason:'native purchased-report reader scope differs'};
    const value=await anchor.readRetained({logicalAddress:input.logicalAddress,artifactKind:'Deliverable'});
    if(value.status!=='present')return value;
    const retainedBinding=value.deliveryBinding??value.artifact?.deliveryBinding??value.signedProjection?.content?.data?.[1]?.metadata?.deliveryBinding;
    if(!retainedBinding || canonicalize(retainedBinding)!==canonicalize(input.deliveryBinding)) return {status:'rejected',reason:'native purchased-report fulfilment binding differs'};
    if(!isDevnetPurchasedReport(value.artifact,{jobId:input.jobId,agreementHash:input.agreementHash,producer:input.seller}) ||
        canonicalize(value.artifact.listing)!==canonicalize(input.listing) || value.artifact.settlementId!==input.settlementId ||
        contentHash(value.artifact)!==input.receiptContentHash || value.receipt?.writer!==input.seller) return {status:'rejected',reason:'native purchased-report bytes or seller binding differ'};
    return value;
  });
  if(deliveryEvidenceEnabled)evidenceReaders.set(capability,({jobId,seller})=>{
    requireJobId(jobId);
    return seller===anchor.writer?anchor.readRetained({logicalAddress:`dacs4:evidence:${jobId}`,artifactKind:'SettlementEvidence'}):{status:'rejected',reason:'delivery evidence writer differs'};
  });
  return capability;
}
