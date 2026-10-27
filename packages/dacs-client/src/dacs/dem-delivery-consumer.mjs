// Buyer-side readback for the SDK delivery-ready boundary.  The authenticated
// seller HTTP response is only a pointer: the report is read independently
// from its canonical SR-2 address and its seller-written receipt is verified.
import { canonicalize, contentHash, sha256Hex, verifySettlementEvidence } from '@kynesyslabs/dacs';
import { agreementTerms, deliveryEvidenceAddress, ed25519Deps, deliverableAddress, listingPin, protocolSupport } from './purchase-protocol.mjs';
import { nativeDemDeliveryConfig, readNativeDemDelivery } from './native-dem-delivery-consumer.mjs';
import { isDevnetPurchasedReport } from '../devnet-demo/deliverable.mjs';
import { isDemosSr2Contradiction } from './demos-sr2-adapter.mjs';
import { signedCreateFor } from './buyer-chain-readback.mjs';
import { deliverableAccessModel } from './listing.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => { try { return canonicalize(left) === canonicalize(right); } catch { return false; } };
const sameNativeReceipt = (left, right) => object(left) && object(right) &&
  ['receiptVersion','substrate','finalityProfile','logicalAddress','nativeAddress','contentHash','writer','nonce','state','observationDisposition']
    .every((key)=>same(left[key],right[key])) && same(left.transactionRef,right.transactionRef) && same(left.blockRef,right.blockRef);

// chainReadback (chain readback) replaces the seller-journal
// readers of the devnet purchased report and its evidence with chain reads.
export async function readDemDeliveryReady({ anchors, nativeDemDelivery = null, agreement, listing, seller, answer, chainReadback = null, retainedSignedCreates = null }) {
  const delivery = answer?.delivery;
  const address = deliverableAddress(agreement.jobId);
  if (!object(delivery) || !['delivery-ready','delivered'].includes(delivery.status) || delivery.logicalAddress !== address
      || !/^[0-9a-f]{64}$/.test(delivery.contentHash ?? '') || !/^[0-9a-f]{64}$/.test(delivery.evidenceHash ?? '')
      || typeof delivery.fulfilmentId !== 'string' || !delivery.fulfilmentId) {
    return { disposition: 'indeterminate', reason: 'seller returned no exact SDK delivery-ready pointer' };
  }
  const native=nativeDemDeliveryConfig(nativeDemDelivery);
  if (!native || !chainReadback) throw new TypeError('buyer delivery requires chain readback');
  const chain=chainReadback,signedCreate=(at)=>signedCreateFor(at,{retained:retainedSignedCreates,answer});
  let record;
  try {
    if(native){
      const price=agreementTerms(agreement).price;
      const deliveryBinding={version:'1',profile:'dacs-native-delivery-publication/v1',jobId:agreement.jobId,phase:'deliver-storage-program',
        phaseIndex:protocolSupport(listing).phases.delivery,listing:listingPin(listing),agreementHash:contentHash(agreement),fulfilmentId:delivery.fulfilmentId,
        purchaseAmount:{amount:price.amount,currency:price.currency},payloadHash:delivery.contentHash};
      record=await chain.readDeliverable({jobId:agreement.jobId,agreementHash:contentHash(agreement),listing,seller,deliveryBinding,receiptContentHash:delivery.contentHash,settlementId:answer.settlementId,signedProjection:signedCreate(address)});
    }
  }
  catch (error) { return { disposition: 'indeterminate', reason: `deliverable read failed: ${error?.message ?? error}` };
  }
  // pointer: chain readback had no signed CREATE bytes to authenticate.
  // authenticated (chain readback only): the bytes authenticated on chain and
  // what read back differs; every check below a present chain record is of
  // that kind. code (chain readback only): an indeterminate read's adapter
  // `invalid`, offered bytes or node data that did not authenticate (the source change).
  if (record.status !== 'present') return { disposition: record.status==='rejected'&&record.authenticated===true?'rejected':'indeterminate', reason: record.reason ?? 'canonical deliverable is not present', ...(chain&&record.pointer?{pointer:record.pointer}:{}), ...(chain&&record.authenticated?{authenticated:true}:{}), ...(chain&&record.code?{code:record.code}:{}) };
  const report = record.artifact;
  const reportShape=isDevnetPurchasedReport(report,{jobId:agreement.jobId,agreementHash:contentHash(agreement),producer:seller}) && record.receipt?.writer===seller
    && report.settlementId===answer.settlementId && same(report.listing,listingPin(listing));
  if (contentHash(report) !== delivery.contentHash || !(native?sameNativeReceipt(record.receipt,delivery.anchorReceipt):same(record.receipt, delivery.anchorReceipt)) || !reportShape) {
    return { disposition: 'rejected', reason: 'canonical deliverable bytes differ from the bound SDK delivery-ready result', ...(chain?{authenticated:true}:{}) };
  }
  // DACS-4 §9.6.1 DV-2: this readback resolves the Deliverable as public. A
  // Listing that declares any other access model (or an unknown one) is a
  // confidentiality downgrade: indeterminate, never delivery-ready or delivered.
  const declaredAccess = deliverableAccessModel(listing);
  if (declaredAccess !== 'public') {
    return { disposition: 'indeterminate', flag: 'confidentiality-downgrade',
      reason: `declared ${typeof declaredAccess === 'string' ? declaredAccess.slice(0, 64) : 'non-public'} deliverable resolved as public (DACS-4 §9.6.1 DV-2 confidentiality downgrade)` };
  }
  // The Deliverable above is verified on its own fresh readback. Delivery
  // evidence is a separate, later seller write: until it reads back and
  // verifies, the buyer keeps the verified report at delivery-ready and sees
  // why evidence is pending or held. Only verified evidence reaches delivered.
  let evidenceRead=null,evidenceHold=null,evidencePointer=null,evidenceAuthenticated=false,evidenceCode=null;
  if(native){
    const evidenceAddress=deliveryEvidenceAddress(agreement.jobId);
    let read;
    try{read=await chain.readDeliveryEvidence({agreement,listing,seller,signedProjection:signedCreate(evidenceAddress)});}catch(error){read={status:isDemosSr2Contradiction(error)?'rejected':'indeterminate',...(isDemosSr2Contradiction(error)?{authenticated:true}:{}),...(error?.code?{code:error.code}:{}),reason:`delivery evidence read failed: ${error?.message??error}`};}
    if(read?.status!=='present'){evidenceHold={status:read?.status==='rejected'&&read.authenticated===true?'rejected':'pending',logicalAddress:evidenceAddress,reason:String(read?.reason??'delivery evidence readback is unavailable').slice(0,240)};if(chain&&read?.pointer)evidencePointer=read.pointer;evidenceAuthenticated=Boolean(chain&&read?.authenticated);if(chain&&read?.code)evidenceCode=read.code;}
    else{
      const evidence=read.artifact,ref={anchor:{kind:'storage-program',locator:evidenceAddress},contentHash:contentHash(evidence)},price=agreementTerms(agreement).price;
      const check=await verifySettlementEvidence(evidence,{orchestrator:seller,agreement:{amount:price.amount,currency:price.currency},attestationRef:ref,result:{ok:true},expectedAnchorLocator:address},ed25519Deps);
      if(check.decision!=='pass'||read.receipt?.writer!==seller||evidence.jobId!==agreement.jobId||evidence.outcome!=='success'||evidence.phase!=='deliver-storage-program'
        ||contentHash(evidence)!==delivery.evidenceHash||evidence.deliverableContentHash!==sha256Hex(canonicalize(report))){evidenceHold={status:'rejected',logicalAddress:evidenceAddress,reason:'delivery evidence differs from the verified Deliverable'};evidenceAuthenticated=Boolean(chain);}
      else evidenceRead=read;
    }
  }
  return {
    disposition: 'present',
    delivery: {
      status: evidenceRead?'delivered':'delivery-ready',
      fulfilmentId: delivery.fulfilmentId,
      deliverableRef: { anchor: { kind: 'storage-program', locator: address }, contentHash: delivery.contentHash },
      anchorReceipt: structuredClone(record.receipt),
      payloadHash: delivery.contentHash,
      evidenceHash: delivery.evidenceHash,
      evidencePublication: evidenceRead?'native-read-back':evidenceHold?(evidenceHold.status==='rejected'?'held-evidence-rejected':'pending-readback'):'deferred-to-explicit-sdk-finaliser',
      ...(evidenceRead?{evidenceRef:{anchor:{kind:'storage-program',locator:deliveryEvidenceAddress(agreement.jobId)},contentHash:delivery.evidenceHash},evidenceReceipt:structuredClone(evidenceRead.receipt)}:{}),
      ...(evidenceHold?{evidenceHold}:{}),
      deliveredAt: record.receipt.blockRef.timestamp,
      substrate: native?'source-native-one-node-delivery':'loopback-sr2-fixture',
      report: structuredClone(report),
    },
    ...(chain ? { chainSignedCreates: { [address]: record.signedProjection, ...(evidenceRead ? { [deliveryEvidenceAddress(agreement.jobId)]: evidenceRead.signedProjection } : {}) } } : {}),
    ...(evidencePointer ? { evidencePointer } : {}),
    // Not part of the delivery record: a rejected evidence read whose bytes
    // authenticated on chain, or an indeterminate one's code (chain readback only).
    ...(evidenceAuthenticated ? { evidenceAuthenticated } : {}),
    ...(evidenceCode ? { evidenceCode } : {}),
  };
}
